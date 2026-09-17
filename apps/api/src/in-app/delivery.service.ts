import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { InAppCampaigns } from "./campaign.service";
import { parseInput } from "./workbench.service";
import { hash } from "./bundle";
import {
  decisionSchema,
  cancellationReasons,
  type Installation,
  type CampaignConfig,
} from "./campaign-contract";
@Injectable()
export class InAppDelivery {
  constructor(readonly campaigns: InAppCampaigns) {}
  get pg() {
    return this.campaigns.workbench.pg;
  }
  async register(tenant: string, app: string, input: unknown) {
    this.campaigns.requireLive();
    const b = parseInput(
      z.object({ platform: z.enum(["ios", "android"]) }).strict(),
      input,
    );
    const id = randomUUID(),
      secret = randomBytes(32).toString("base64url"),
      db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `in-app-install:${tenant}:${app}`,
      ]);
      const count = await db.query(
        "SELECT count(*)::int AS n FROM in_app_installations WHERE tenant_id=$1 AND app_id=$2 AND created_at>now()-interval '1 day'",
        [tenant, app],
      );
      if (count.rows[0].n >= 10000)
        throw new ConflictException("INSTALLATION_DAILY_LIMIT");
      await db.query(
        "INSERT INTO in_app_installations(id,tenant_id,app_id,credential_hash,platform) VALUES($1,$2,$3,$4,$5)",
        [id, tenant, app, hash(secret), b.platform],
      );
      await db.query("COMMIT");
      return { id, credential: `${id}.${secret}` };
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async auth(
    tenant: string,
    app: string,
    token: string,
  ): Promise<Installation> {
    this.campaigns.requireLive();
    const [id, secret] = token.split(".");
    if (
      !z.string().uuid().safeParse(id).success ||
      !secret ||
      token.length > 100 ||
      token.split(".").length !== 2
    )
      throw new UnauthorizedException();
    const d = (
      await this.pg.query(
        "SELECT id,platform FROM in_app_installations WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND credential_hash=$4 AND revoked=false",
        [tenant, app, id, hash(secret)],
      )
    ).rows[0];
    if (!d) throw new UnauthorizedException();
    return { id: d.id, tenant, app, platform: d.platform };
  }
  async decide(i: Installation, input: unknown, supportsTimeZone = false) {
    const b = parseInput(decisionSchema, input),
      db = await this.pg.connect();
    let delivery: any;
    try {
      await db.query("BEGIN");
      const active = await db.query(
        "SELECT id FROM in_app_installations WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND revoked=false FOR UPDATE",
        [i.tenant, i.app, i.id],
      );
      if (!active.rowCount) throw new UnauthorizedException();
      await db.query(
        "UPDATE in_app_installations SET last_seen_at=now() WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
        [i.tenant, i.app, i.id],
      );
      await db.query(
        "UPDATE in_app_deliveries SET state='expired' WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND state IN ('reserved','authorized','presented') AND expires_at<=now()",
        [i.tenant, i.app, i.id],
      );
      const old = (
        await db.query(
          "SELECT * FROM in_app_deliveries WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND request_key=$4",
          [i.tenant, i.app, i.id, b.request_key],
        )
      ).rows[0];
      if (old) {
        if (
          old.session_id !== b.session_id ||
          old.trigger.type !== b.trigger.type ||
          old.trigger.name !==
            ("name" in b.trigger ? b.trigger.name : undefined)
        )
          throw new ConflictException("REQUEST_KEY_REUSED");
        await db.query("COMMIT");
        const publication = (await db.query("SELECT config FROM in_app_publications WHERE tenant_id=$1 AND app_id=$2 AND campaign_id=$3 AND version=$4", [i.tenant, i.app, old.campaign_id, old.version])).rows[0];
        return old.state === "reserved" && (supportsTimeZone || (publication?.config.time_zone ?? "UTC") === "UTC")
          ? this.artifact(i, old)
          : { delivery: null };
      }
      if (
        (
          await db.query(
            "SELECT id FROM in_app_deliveries WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND state IN ('reserved','authorized','presented')",
            [i.tenant, i.app, i.id],
          )
        ).rowCount
      ) {
        await db.query("COMMIT");
        return { delivery: null };
      }
      const candidates = (
        await db.query(
          "SELECT * FROM in_app_campaigns WHERE tenant_id=$1 AND app_id=$2 AND state='published' ORDER BY (config->>'priority')::int DESC,created_at,id LIMIT 100",
          [i.tenant, i.app],
        )
      ).rows;
      for (const c of candidates) {
        const cfg = c.config as CampaignConfig,
          now = Date.now();
        if (
          !cfg.platforms.includes(i.platform) ||
          (!supportsTimeZone && (cfg.time_zone ?? "UTC") !== "UTC") ||
          Date.parse(cfg.starts_at) > now ||
          Date.parse(cfg.ends_at) <= now ||
          cfg.trigger.type !== b.trigger.type ||
          ("name" in cfg.trigger &&
            (!("name" in b.trigger) || cfg.trigger.name !== b.trigger.name))
        )
          continue;
        if (
          (
            await db.query(
              "SELECT 1 FROM in_app_suppressions WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND campaign_id=$4 AND until_at>now()",
              [i.tenant, i.app, i.id, c.id],
            )
          ).rowCount
        )
          continue;
        const f = (
          await db.query(
            "SELECT count(*)::int AS total,count(*) FILTER(WHERE authorized_at>=(date_trunc('day',now() AT TIME ZONE $6) AT TIME ZONE $6))::int AS today,count(*) FILTER(WHERE session_id=$5)::int AS session,max(authorized_at) AS last FROM in_app_deliveries WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND campaign_id=$4 AND authorized_at IS NOT NULL",
            [i.tenant, i.app, i.id, c.id, b.session_id, cfg.time_zone ?? "UTC"],
          )
        ).rows[0];
        if (
          f.total >= cfg.max_total ||
          f.today >= cfg.max_per_day ||
          f.session > 0 ||
          (f.last &&
            new Date(f.last).getTime() + cfg.cooldown_seconds * 1000 > now)
        )
          continue;
        const recent = (
          await db.query(
            "SELECT id FROM in_app_deliveries WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND authorized_at>now()-interval '30 seconds' LIMIT 1",
            [i.tenant, i.app, i.id],
          )
        ).rowCount;
        if (recent) break;
        delivery = (
          await db.query(
            "INSERT INTO in_app_deliveries(id,tenant_id,app_id,installation_id,campaign_id,version,revision_id,request_key,session_id,trigger) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
            [
              randomUUID(),
              i.tenant,
              i.app,
              i.id,
              c.id,
              c.version,
              c.revision_id,
              b.request_key,
              b.session_id,
              b.trigger,
            ],
          )
        ).rows[0];
        break;
      }
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    return delivery ? this.artifact(i, delivery) : { delivery: null };
  }
  private async artifact(i: Installation, d: any) {
    const a = await this.campaigns.workbench.assets.read(
      i.tenant,
      i.app,
      d.revision_id,
    );
    const publication = (await this.pg.query("SELECT config FROM in_app_publications WHERE tenant_id=$1 AND app_id=$2 AND campaign_id=$3 AND version=$4", [i.tenant, i.app, d.campaign_id, d.version])).rows[0];
    return {
      delivery: {
        time_zone: publication?.config.time_zone ?? "UTC",
        lifecycle_events: true,
        id: d.id,
        revision_id: d.revision_id,
        campaign_id: d.campaign_id,
        expires_at: d.expires_at,
        html: a.html,
        manifest: a.manifest,
        artifact_sha256: a.artifact_sha256,
      },
    };
  }
  async authorize(i: Installation, id: string) {
    const db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      if (
        !(
          await db.query(
            "SELECT id FROM in_app_installations WHERE tenant_id=$1 AND app_id=$2 AND id=$3 AND revoked=false FOR SHARE",
            [i.tenant, i.app, i.id],
          )
        ).rowCount
      )
        throw new UnauthorizedException();
      const seed = (
        await db.query(
          "SELECT campaign_id FROM in_app_deliveries WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND id=$4",
          [i.tenant, i.app, i.id, id],
        )
      ).rows[0];
      if (!seed) throw new NotFoundException();
      const c = (
        await db.query(
          "SELECT * FROM in_app_campaigns WHERE tenant_id=$1 AND app_id=$2 AND id=$3 FOR SHARE",
          [i.tenant, i.app, seed.campaign_id],
        )
      ).rows[0];
      const d = (
        await db.query(
          "SELECT * FROM in_app_deliveries WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND id=$4 FOR UPDATE",
          [i.tenant, i.app, i.id, id],
        )
      ).rows[0];
      if (
        c.state !== "published" ||
        c.version !== d.version ||
        Date.parse(c.config.starts_at) > Date.now() ||
        Date.parse(c.config.ends_at) <= Date.now() ||
        new Date(d.expires_at).getTime() <= Date.now() ||
        !["reserved", "authorized"].includes(d.state)
      )
        throw new ConflictException("DELIVERY_NOT_ELIGIBLE");
      const result =
        d.state === "authorized"
          ? d
          : (
              await db.query(
                "UPDATE in_app_deliveries SET state='authorized',authorized_at=now(),expires_at=LEAST(now()+interval '5 minutes',$5::timestamptz) WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND id=$4 RETURNING *",
                [i.tenant, i.app, i.id, id, c.config.ends_at],
              )
            ).rows[0];
      await db.query("COMMIT");
      return { ok: true, expires_at: result.expires_at };
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async status(i: Installation, id: string) {
    const d = (
      await this.pg.query(
        "SELECT d.state,d.expires_at,c.state AS campaign_state,c.version AS current_version,d.version,c.config FROM in_app_deliveries d JOIN in_app_campaigns c ON c.tenant_id=d.tenant_id AND c.app_id=d.app_id AND c.id=d.campaign_id WHERE d.tenant_id=$1 AND d.app_id=$2 AND d.installation_id=$3 AND d.id=$4",
        [i.tenant, i.app, i.id, id],
      )
    ).rows[0];
    if (!d) throw new NotFoundException();
    const reason = d.campaign_state !== "published" ? "campaign_paused"
      : d.version !== d.current_version ? "campaign_updated"
      : Date.parse(d.config.ends_at) <= Date.now() ? "campaign_expired"
      : new Date(d.expires_at).getTime() <= Date.now() ? "display_timeout"
      : !["authorized", "presented"].includes(d.state) ? "delivery_inactive" : null;
    return {
      reason,
      active:
        ["authorized", "presented"].includes(d.state) &&
        d.campaign_state === "published" &&
        d.version === d.current_version &&
        new Date(d.expires_at).getTime() > Date.now() &&
        Date.parse(d.config.ends_at) > Date.now(),
    };
  }
  async event(i: Installation, id: string, input: unknown) {
    const b = parseInput(
        z
          .object({
            event_id: z.string().uuid(),
            kind: z.enum([
              "bridge_ready",
              "content_ready",
              "presented",
              "impression",
              "action",
              "dismiss",
              "failed",
              "log",
              "hide_today",
              "cancelled",
            ]),
            detail: z.string().max(200).default(""),
            occurred_at: z.string().datetime({ offset: true }).optional(),
          })
          .strict(),
        input,
      ),
      db = await this.pg.connect();
    try {
      await db.query("BEGIN");
      const d = (
        await db.query(
          "SELECT * FROM in_app_deliveries WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND id=$4 FOR UPDATE",
          [i.tenant, i.app, i.id, id],
        )
      ).rows[0];
      if (!d) throw new NotFoundException();
      const old = (
        await db.query(
          "SELECT kind,detail,occurred_at FROM in_app_delivery_events WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3 AND event_id=$4",
          [i.tenant, i.app, id, b.event_id],
        )
      ).rows[0];
      if (old) {
        if (old.kind !== b.kind || old.detail !== b.detail || (b.occurred_at && old.occurred_at && new Date(old.occurred_at).getTime() !== Date.parse(b.occurred_at)))
          throw new ConflictException("EVENT_ID_REUSED");
        await db.query("COMMIT");
        return { ok: true };
      }
      if (b.kind === "cancelled" && !(cancellationReasons as readonly string[]).includes(b.detail ?? "")) throw new ConflictException("INVALID_CANCELLATION_REASON");
      const now = Date.now();
      const occurred = b.occurred_at ? Date.parse(b.occurred_at) : now;
      const closed = !["reserved", "authorized", "presented"].includes(d.state) || new Date(d.expires_at).getTime() <= now;
      // Historical telemetry is evidence only. It can never grant display authorization.
      if (b.occurred_at && (occurred < now - 7 * 86400000 || occurred > now + 120000 ||
          occurred < new Date(d.created_at).getTime() - 120000 || occurred > new Date(d.expires_at).getTime() + 120000))
        throw new ConflictException("EVENT_TIME_INVALID");
      if (closed && !b.occurred_at) throw new ConflictException("DELIVERY_CLOSED");
      if (b.kind === "presented" && !d.authorized_at) throw new ConflictException("NOT_AUTHORIZED");
      if (["impression", "action", "hide_today", "dismiss"].includes(b.kind)) {
        const presented = await db.query(
          "SELECT 1 FROM in_app_delivery_events WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3 AND kind='presented'",
          [i.tenant, i.app, id],
        );
        if (!d.authorized_at || !presented.rowCount) throw new ConflictException("NOT_PRESENTED");
      }
      const count = (
        await db.query(
          "SELECT count(*)::int AS n FROM in_app_delivery_events WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3",
          [i.tenant, i.app, id],
        )
      ).rows[0].n;
      if (count >= 200) throw new ConflictException("EVENT_LIMIT");
      if (b.kind === "action") {
        const revision = (
          await db.query(
            "SELECT manifest FROM in_app_revisions WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
            [i.tenant, i.app, d.revision_id],
          )
        ).rows[0];
        if (!Object.hasOwn(revision.manifest.actions, b.detail ?? ""))
          throw new ConflictException("UNKNOWN_ACTION");
      }
      await db.query(
        "INSERT INTO in_app_delivery_events(tenant_id,app_id,delivery_id,event_id,kind,detail,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        [i.tenant, i.app, id, b.event_id, b.kind, b.detail, b.occurred_at ?? null],
      );
      if (b.kind === "hide_today") {
        // Use the immutable publication that actually produced this delivery, including replay.
        // Calendar arithmetic occurs in the campaign zone before conversion to an instant (DST-safe).
        const publication = (await db.query(
          "SELECT ((date_trunc('day', $5::timestamptz AT TIME ZONE COALESCE(config->>'time_zone','UTC')) + interval '1 day') AT TIME ZONE COALESCE(config->>'time_zone','UTC')) AS until_at FROM in_app_publications WHERE tenant_id=$1 AND app_id=$2 AND campaign_id=$3 AND version=$4",
          [i.tenant, i.app, d.campaign_id, d.version, new Date(occurred).toISOString()],
        )).rows[0];
        if (publication && new Date(publication.until_at).getTime() > now) await db.query(
          "INSERT INTO in_app_suppressions(tenant_id,app_id,installation_id,campaign_id,until_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,app_id,installation_id,campaign_id) DO UPDATE SET until_at=GREATEST(in_app_suppressions.until_at,EXCLUDED.until_at)",
          [i.tenant, i.app, i.id, d.campaign_id, publication.until_at],
        );
      }
      const state = closed ? (new Date(d.expires_at).getTime() <= now && ["reserved", "authorized", "presented"].includes(d.state) ? "expired" : d.state) :
        b.kind === "presented"
          ? "presented"
          : b.kind === "dismiss"
            ? "completed"
            : b.kind === "cancelled"
              ? "cancelled"
            : b.kind === "failed"
              ? "failed"
              : d.state;
      await db.query(
        "UPDATE in_app_deliveries SET state=$5 WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND id=$4",
        [i.tenant, i.app, i.id, id, state],
      );
      await db.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async revoke(i: Installation) {
    await this.pg.query(
      "UPDATE in_app_installations SET revoked=true WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [i.tenant, i.app, i.id],
    );
    await this.pg.query(
      "UPDATE in_app_deliveries SET state='cancelled' WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND state IN ('reserved','authorized','presented')",
      [i.tenant, i.app, i.id],
    );
    return { ok: true };
  }
}
