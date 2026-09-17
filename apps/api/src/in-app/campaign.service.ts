import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InAppWorkbench, parseInput } from "./workbench.service";
import { campaignSchema, type CampaignConfig } from "./campaign-contract";
@Injectable()
export class InAppCampaigns {
  constructor(readonly workbench: InAppWorkbench) {}
  requireLive() {
    this.workbench.assets.requireEnabled();
    if (process.env.IN_APP_CAMPAIGNS_ENABLED !== "true")
      throw new ServiceUnavailableException("IN_APP_CAMPAIGNS_DISABLED");
  }
  async list(tenant: string, app: string) {
    await this.workbench.app(tenant, app);
    return {
      campaigns: (
        await this.workbench.pg.query(
          "SELECT * FROM in_app_campaigns WHERE tenant_id=$1 AND app_id=$2 ORDER BY updated_at DESC LIMIT 100",
          [tenant, app],
        )
      ).rows,
    };
  }
  async save(tenant: string, app: string, input: unknown, id?: string) {
    await this.workbench.app(tenant, app);
    const value = parseInput(
      id
        ? campaignSchema.extend({
            expected_version: z.number().int().positive(),
          })
        : campaignSchema,
      input,
    );
    await this.workbench.assets.read(tenant, app, value.revision_id);
    if (id) {
      const version = (value as typeof value & { expected_version: number })
        .expected_version;
      const r = await this.workbench.pg.query(
        "UPDATE in_app_campaigns SET name=$4,revision_id=$5,config=$6,version=version+1,updated_at=now() WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND version=$7 AND state<>'published' RETURNING *",
        [tenant, app, id, value.name, value.revision_id, value.config, version],
      );
      if (!r.rowCount)
        throw new ConflictException("CAMPAIGN_CHANGED_OR_PUBLISHED");
      return r.rows[0];
    }
    const db = await this.workbench.pg.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `in-app-campaign-count:${tenant}:${app}`,
      ]);
      const count = await db.query(
        "SELECT count(*)::int AS n FROM in_app_campaigns WHERE tenant_id=$1 AND app_id=$2",
        [tenant, app],
      );
      if (count.rows[0].n >= 100)
        throw new ConflictException("CAMPAIGN_LIMIT_100");
      const created = await db.query(
        "INSERT INTO in_app_campaigns(id,tenant_id,app_id,name,revision_id,config) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          randomUUID(),
          tenant,
          app,
          value.name,
          value.revision_id,
          value.config,
        ],
      );
      await db.query("COMMIT");
      return created.rows[0];
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async reviews(tenant: string, app: string) {
    await this.workbench.app(tenant, app);
    return {
      reviews: (
        await this.workbench.pg.query(
          "SELECT * FROM in_app_reviews WHERE tenant_id=$1 AND app_id=$2 ORDER BY reviewed_at DESC LIMIT 200",
          [tenant, app],
        )
      ).rows,
    };
  }
  async review(tenant: string, app: string, member: string, input: unknown) {
    await this.workbench.app(tenant, app);
    const b = parseInput(
      z
        .object({
          run_id: z.string().uuid(),
          passed: z.boolean(),
          layout_checked: z.boolean(),
          close_checked: z.boolean(),
          actions_checked: z.boolean(),
        })
        .strict(),
      input,
    );
    const run = (
      await this.workbench.pg.query(
        "SELECT r.*,d.platform FROM in_app_test_runs r JOIN in_app_test_devices d ON d.tenant_id=r.tenant_id AND d.app_id=r.app_id AND d.id=r.device_id WHERE r.tenant_id=$1 AND r.app_id=$2 AND r.id=$3",
        [tenant, app, b.run_id],
      )
    ).rows[0];
    if (!run) throw new NotFoundException();
    if (b.passed) {
      const { events } = await this.workbench.events(tenant, app, b.run_id);
      if (
        run.state !== "completed" ||
        !b.layout_checked ||
        !b.close_checked ||
        !b.actions_checked ||
        !events.some((e) => e.kind === "impression") ||
        !events.some((e) => e.kind === "dismiss" && e.detail === "close_button")
      )
        throw new BadRequestException(
          "REVIEW_REQUIRES_COMPLETED_NATIVE_CLOSE_AND_CHECKLIST",
        );
    }
    await this.workbench.pg.query(
      "INSERT INTO in_app_reviews(tenant_id,app_id,revision_id,platform,run_id,passed,reviewed_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,app_id,revision_id,platform) DO UPDATE SET run_id=$5,passed=$6,reviewed_by=$7,reviewed_at=now()",
      [tenant, app, run.revision_id, run.platform, run.id, b.passed, member],
    );
    return { ok: true };
  }
  async transition(
    tenant: string,
    app: string,
    id: string,
    member: string,
    input: unknown,
    publish: boolean,
  ) {
    await this.workbench.app(tenant, app);
    if (publish) this.requireLive();
    const b = parseInput(
        z.object({ expected_version: z.number().int().positive() }).strict(),
        input,
      ),
      db = await this.workbench.pg.connect();
    try {
      await db.query("BEGIN");
      const c = (
        await db.query(
          "SELECT * FROM in_app_campaigns WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR UPDATE",
          [tenant, app, id],
        )
      ).rows[0];
      if (!c) throw new NotFoundException();
      if (c.version !== b.expected_version)
        throw new ConflictException("CAMPAIGN_CHANGED");
      if (publish) {
        if (c.state === "published") {
          await db.query("COMMIT");
          return c;
        }
        const config = c.config as CampaignConfig;
        if (Date.parse(config.ends_at) <= Date.now())
          throw new BadRequestException("CAMPAIGN_ENDED");
        const reviews = (
          await db.query(
            "SELECT platform FROM in_app_reviews WHERE tenant_id=$1 AND app_id=$2 AND revision_id=$3 AND passed=true",
            [tenant, app, c.revision_id],
          )
        ).rows;
        if (
          !config.platforms.every((p) => reviews.some((r) => r.platform === p))
        )
          throw new BadRequestException("PLATFORM_REVIEW_REQUIRED");
        await this.workbench.assets.read(tenant, app, c.revision_id);
        await db.query(
          "INSERT INTO in_app_publications(tenant_id,app_id,campaign_id,version,revision_id,config,published_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [tenant, app, id, c.version, c.revision_id, config, member],
        );
      }
      const result = await db.query(
        "UPDATE in_app_campaigns SET state=$4,version=version+$5,updated_at=now() WHERE tenant_id=$1 AND app_id=$2 AND id=$3 RETURNING *",
        [tenant, app, id, publish ? "published" : "paused", publish ? 0 : 1],
      );
      if (!publish)
        await db.query(
          "UPDATE in_app_deliveries SET state='cancelled' WHERE tenant_id=$1 AND app_id=$2 AND campaign_id=$3 AND state IN ('reserved','authorized','presented')",
          [tenant, app, id],
        );
      await db.query("COMMIT");
      return result.rows[0];
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async report(tenant: string, app: string, id: string) {
    await this.workbench.app(tenant, app);
    if (
      !(
        await this.workbench.pg.query(
          "SELECT id FROM in_app_campaigns WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
          [tenant, app, id],
        )
      ).rowCount
    )
      throw new NotFoundException();
    const deliveries = await this.workbench.pg.query(
      "SELECT CASE WHEN state IN ('reserved','authorized','presented') AND expires_at<=now() THEN 'expired' ELSE state END AS state,count(*)::int AS count FROM in_app_deliveries WHERE tenant_id=$1 AND app_id=$2 AND campaign_id=$3 GROUP BY 1",
      [tenant, app, id],
    );
    const events = await this.workbench.pg.query(
      "SELECT e.kind,count(DISTINCT e.delivery_id)::int AS count FROM in_app_delivery_events e JOIN in_app_deliveries d ON d.tenant_id=e.tenant_id AND d.app_id=e.app_id AND d.id=e.delivery_id WHERE e.tenant_id=$1 AND e.app_id=$2 AND d.campaign_id=$3 GROUP BY e.kind",
      [tenant, app, id],
    );
    const failures = await this.workbench.pg.query(
      "SELECT d.id,d.created_at,e.detail FROM in_app_deliveries d JOIN in_app_delivery_events e ON e.tenant_id=d.tenant_id AND e.app_id=d.app_id AND e.delivery_id=d.id WHERE d.tenant_id=$1 AND d.app_id=$2 AND d.campaign_id=$3 AND e.kind='failed' ORDER BY e.created_at DESC LIMIT 20",
      [tenant, app, id],
    );
    return {
      deliveries: deliveries.rows,
      events: events.rows,
      failures: failures.rows,
    };
  }
}
