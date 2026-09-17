import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { PG } from "../infra/infra.module";
import { InAppAssets } from "./assets.service";
import { BundleError, hash } from "./bundle";
import { validateBundle } from "./validate";
const sourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  files: z
    .array(
      z.object({
        path: z.string().max(200),
        base64: z.string().max(12_000_000),
      }),
    )
    .max(200)
    .optional(),
  archive_base64: z.string().max(14_000_000).optional(),
  manifest: z.unknown().optional(),
});
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success)
    throw new BadRequestException({
      code: "INVALID_INPUT",
      message: r.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    });
  return r.data;
}
@Injectable()
export class InAppWorkbench {
  constructor(
    @Inject(PG) readonly pg: Pool,
    readonly assets: InAppAssets,
  ) {}
  async app(tenant: string, app: string) {
    this.assets.requireEnabled();
    if (
      !(
        await this.pg.query("SELECT 1 FROM apps WHERE tenant_id=$1 AND id=$2", [
          tenant,
          app,
        ])
      ).rowCount
    )
      throw new NotFoundException();
  }
  async create(tenant: string, app: string, member: string, input: unknown) {
    await this.app(tenant, app);
    const body = parseInput(sourceSchema, input);
    if (!!body.files === !!body.archive_base64)
      throw new BadRequestException("Supply files or archive_base64");
    let artifact;
    try {
      artifact = await validateBundle(body);
    } catch (e) {
      if (e instanceof BundleError)
        throw new BadRequestException({ code: e.code, message: e.message });
      throw new BadRequestException({
        code: "INVALID_BUNDLE",
        message: "Invalid ZIP or HTML",
      });
    }
    const id = randomUUID(),
      db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `inapp-assets:${tenant}`,
      ]);
      const size = await db.query(
        "SELECT COALESCE(sum(source_bytes),0)::bigint AS bytes FROM in_app_revisions WHERE tenant_id=$1",
        [tenant],
      );
      if (Number(size.rows[0].bytes) + artifact.source_bytes > 1024 ** 3)
        throw new BadRequestException("Tenant asset quota exceeded (1 GiB)");
      await this.assets.store(tenant, app, id, artifact);
      await db.query(
        "INSERT INTO in_app_revisions(id,tenant_id,app_id,name,source_bytes,artifact_sha256,manifest,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          tenant,
          app,
          body.name,
          artifact.source_bytes,
          artifact.artifact_sha256,
          artifact.manifest,
          member,
        ],
      );
      await db.query("COMMIT");
      return {
        id,
        name: body.name,
        artifact_sha256: artifact.artifact_sha256,
        manifest: artifact.manifest,
      };
    } catch (e) {
      await db.query("ROLLBACK");
      await this.assets.remove(tenant, app, id);
      throw e;
    } finally {
      db.release();
    }
  }
  async list(tenant: string, app: string) {
    await this.app(tenant, app);
    return {
      revisions: (
        await this.pg.query(
          "SELECT id,name,artifact_sha256,manifest,source_bytes,created_at FROM in_app_revisions WHERE tenant_id=$1 AND app_id=$2 ORDER BY created_at DESC LIMIT 100",
          [tenant, app],
        )
      ).rows,
    };
  }
  async pairing(tenant: string, app: string, member: string) {
    await this.app(tenant, app);
    const recent = await this.pg.query(
      "SELECT count(*)::int AS n FROM in_app_test_devices WHERE tenant_id=$1 AND app_id=$2 AND created_at>now()-interval '5 minutes'",
      [tenant, app],
    );
    if (recent.rows[0].n >= 20)
      throw new BadRequestException(
        "PAIRING_LIMIT: wait before creating more pairing codes",
      );
    const id = randomUUID(),
      secret = randomBytes(32).toString("base64url"),
      confirmation_code = String(randomInt(100000, 1000000));
    const { rows } = await this.pg.query(
      "INSERT INTO in_app_test_devices(id,tenant_id,app_id,pairing_hash,confirmation_code,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING expires_at",
      [id, tenant, app, hash(secret), confirmation_code, member],
    );
    return {
      id,
      token: `${id}.${secret}`,
      confirmation_code,
      expires_at: rows[0].expires_at,
    };
  }
  async devices(tenant: string, app: string) {
    await this.app(tenant, app);
    return {
      devices: (
        await this.pg.query(
          "SELECT id,label,platform,sdk_version,state,confirmation_code,expires_at,last_seen_at FROM in_app_test_devices WHERE tenant_id=$1 AND app_id=$2 AND expires_at>now() AND state<>'revoked' ORDER BY created_at DESC LIMIT 50",
          [tenant, app],
        )
      ).rows,
    };
  }
  async confirm(tenant: string, app: string, id: string) {
    const result = await this.pg.query(
      "UPDATE in_app_test_devices SET state='active',expires_at=now()+interval '30 minutes' WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND state='claimed' AND expires_at>now() RETURNING id",
      [tenant, app, id],
    );
    if (!result.rowCount)
      throw new ConflictException("Pairing expired or not claimed");
    return { ok: true };
  }
  async revoke(tenant: string, app: string, id: string) {
    await this.pg.query(
      "UPDATE in_app_test_devices SET state='revoked' WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [tenant, app, id],
    );
    await this.pg.query(
      "UPDATE in_app_test_runs SET state='cancelled',updated_at=now() WHERE tenant_id=$1 AND app_id=$2 AND device_id=$3 AND state IN ('queued','preparing','presented')",
      [tenant, app, id],
    );
    return { ok: true };
  }
  async expire(tenant: string, app: string) {
    await this.pg.query(
      "UPDATE in_app_test_runs SET state='expired',error_code='RUN_EXPIRED',updated_at=now() WHERE tenant_id=$1 AND app_id=$2 AND expires_at<=now() AND state IN ('queued','preparing','presented')",
      [tenant, app],
    );
  }
  async run(tenant: string, app: string, input: unknown) {
    await this.app(tenant, app);
    await this.expire(tenant, app);
    const body = parseInput(
      z.object({
        revision_id: z.string().uuid(),
        device_id: z.string().uuid(),
        request_key: z.string().uuid(),
        retry_of: z.string().uuid().optional(),
      }),
      input,
    );
    const old = (
      await this.pg.query(
        "SELECT * FROM in_app_test_runs WHERE tenant_id=$1 AND app_id=$2 AND request_key=$3",
        [tenant, app, body.request_key],
      )
    ).rows[0];
    if (old) {
      if (
        old.device_id !== body.device_id ||
        old.revision_id !== body.revision_id ||
        old.retry_of !== (body.retry_of ?? null)
      )
        throw new ConflictException(
          "Idempotency key reused for different input",
        );
      return old;
    }
    const db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      const device = await db.query(
        "SELECT id FROM in_app_test_devices WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND state='active' AND expires_at>now() FOR UPDATE",
        [tenant, app, body.device_id],
      );
      if (!device.rowCount)
        throw new BadRequestException(
          "DEVICE_OFFLINE: connect and confirm the device",
        );
      if (
        !(
          await db.query(
            "SELECT id FROM in_app_revisions WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
            [tenant, app, body.revision_id],
          )
        ).rowCount
      )
        throw new NotFoundException();
      if (
        body.retry_of &&
        !(
          await db.query(
            "SELECT id FROM in_app_test_runs WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
            [tenant, app, body.retry_of],
          )
        ).rowCount
      )
        throw new NotFoundException();
      const result = await db.query(
        "INSERT INTO in_app_test_runs(id,tenant_id,app_id,revision_id,device_id,request_key,retry_of) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [
          randomUUID(),
          tenant,
          app,
          body.revision_id,
          body.device_id,
          body.request_key,
          body.retry_of ?? null,
        ],
      );
      await db.query("COMMIT");
      return result.rows[0];
    } catch (e) {
      await db.query("ROLLBACK");
      if ((e as { code?: string }).code === "23505") {
        const retry = (
          await this.pg.query(
            "SELECT * FROM in_app_test_runs WHERE tenant_id=$1 AND app_id=$2 AND request_key=$3",
            [tenant, app, body.request_key],
          )
        ).rows[0];
        if (
          retry &&
          retry.device_id === body.device_id &&
          retry.revision_id === body.revision_id &&
          retry.retry_of === (body.retry_of ?? null)
        )
          return retry;
        throw new ConflictException(
          "A test is already active, or the request key has changed input",
        );
      }
      throw e;
    } finally {
      db.release();
    }
  }
  async runs(tenant: string, app: string) {
    await this.app(tenant, app);
    await this.expire(tenant, app);
    return {
      runs: (
        await this.pg.query(
          "SELECT r.*, d.label, d.platform, v.name FROM in_app_test_runs r JOIN in_app_test_devices d ON d.tenant_id=r.tenant_id AND d.app_id=r.app_id AND d.id=r.device_id JOIN in_app_revisions v ON v.tenant_id=r.tenant_id AND v.app_id=r.app_id AND v.id=r.revision_id WHERE r.tenant_id=$1 AND r.app_id=$2 ORDER BY r.created_at DESC LIMIT 50",
          [tenant, app],
        )
      ).rows,
    };
  }
  async events(tenant: string, app: string, id: string) {
    return {
      events: (
        await this.pg.query(
          "SELECT event_id,kind,detail,created_at FROM in_app_test_events WHERE tenant_id=$1 AND app_id=$2 AND run_id=$3 ORDER BY created_at LIMIT 200",
          [tenant, app, id],
        )
      ).rows,
    };
  }
  async cancel(tenant: string, app: string, id: string) {
    await this.pg.query(
      "UPDATE in_app_test_runs SET state='cancelled',updated_at=now() WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND state IN ('queued','preparing','presented')",
      [tenant, app, id],
    );
    return { ok: true };
  }
}
