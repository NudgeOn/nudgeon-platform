import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { InAppAssets } from "./assets.service";
import { InAppWorkbench } from "./workbench.service";
import { InAppCampaigns } from "./campaign.service";
import { InAppDelivery } from "./delivery.service";
import type { Installation } from "./campaign-contract";
import type { AppConfig } from "../config";
import { can } from "../authz/permissions";
const url = process.env.NUDGEON_IN_APP_TEST_DATABASE_URL;
if (url && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname))
  throw Error("Loopback QA database only");
describe.skipIf(!url)("live in-app campaigns", () => {
  const schema = "in_app_campaign_" + randomUUID().replaceAll("-", ""),
    tenant = randomUUID(),
    app = randomUUID(),
    member = randomUUID();
  let admin: Pool,
    pg: Pool,
    workbench: InAppWorkbench,
    campaigns: InAppCampaigns,
    live: InAppDelivery,
    dir: string,
    revision: string;
  const config = {
    platforms: ["ios"],
    trigger: { type: "foreground" },
    starts_at: new Date(Date.now() - 60000).toISOString(),
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    cooldown_seconds: 60,
    max_per_day: 2,
    max_total: 3,
    priority: 10,
  };
  beforeAll(async () => {
    const connection = new URL(url!);
    connection.searchParams.delete("options");
    dir = await mkdtemp(join(tmpdir(), "nudgeon-live-"));
    process.env.IN_APP_ASSET_DIR = dir;
    process.env.IN_APP_ENABLED = "true";
    process.env.IN_APP_CAMPAIGNS_ENABLED = "true";
    process.env.CONTENT_PUBLIC_ORIGIN = "http://127.0.0.1:18082";
    admin = new Pool({ connectionString: connection.toString() });
    await admin.query("CREATE SCHEMA " + schema);
    pg = new Pool({
      connectionString: connection.toString(),
      options: `-c search_path=${schema}`,
      max: 12,
    });
    await pg.query(
      readFileSync(
        resolve(__dirname, "../../../../db/postgres/schema.sql"),
        "utf8",
      ),
    );
    for (const file of [
      "0010_in_app_workbench.sql",
      "0011_in_app_campaigns.sql",
      "0012_in_app_event_replay.sql",
    ]) {
      const sql = readFileSync(
        resolve(__dirname, "../../../../db/postgres/upgrades", file),
        "utf8",
      );
      await pg.query(sql);
      await pg.query(sql);
    }
    await pg.query("INSERT INTO tenants(id,name) VALUES($1,'Live QA')", [
      tenant,
    ]);
    await pg.query("INSERT INTO apps(id,tenant_id,name) VALUES($1,$2,'QA')", [
      app,
      tenant,
    ]);
    const assets = new InAppAssets(pg, {
      corsOrigin: "http://localhost:3300",
    } as AppConfig);
    workbench = new InAppWorkbench(pg, assets);
    campaigns = new InAppCampaigns(workbench);
    live = new InAppDelivery(campaigns);
    revision = (
      await workbench.create(tenant, app, member, {
        name: "Event",
        files: [
          {
            path: "index.html",
            base64: Buffer.from("<h1>Event</h1>").toString("base64"),
          },
        ],
      })
    ).id;
  }, 30000);
  afterAll(async () => {
    await pg?.end();
    if (admin) {
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  async function installation(platform = "ios") {
    const d = await live.register(tenant, app, { platform });
    return {
      credential: d.credential,
      context: await live.auth(tenant, app, d.credential),
    };
  }
  async function reviewed() {
    const p = await workbench.pairing(tenant, app, member);
    await pg.query(
      "UPDATE in_app_test_devices SET state='active',platform='ios' WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [tenant, app, p.id],
    );
    const r = await workbench.run(tenant, app, {
      revision_id: revision,
      device_id: p.id,
      request_key: randomUUID(),
    });
    await pg.query(
      "UPDATE in_app_test_runs SET state='completed' WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [tenant, app, r.id],
    );
    for (const [kind, detail] of [
      ["impression", ""],
      ["dismiss", "close_button"],
    ])
      await pg.query(
        "INSERT INTO in_app_test_events(tenant_id,app_id,run_id,event_id,kind,detail) VALUES($1,$2,$3,$4,$5,$6)",
        [tenant, app, r.id, randomUUID(), kind, detail],
      );
    return r;
  }
  async function create(extra = {}) {
    return campaigns.save(tenant, app, {
      name: "Campaign",
      revision_id: revision,
      config: { ...config, ...extra },
    });
  }
  async function publish(c: any) {
    return campaigns.transition(
      tenant,
      app,
      c.id,
      member,
      { expected_version: c.version },
      true,
    );
  }
  const input = () => ({
    request_key: randomUUID(),
    session_id: randomUUID(),
    trigger: { type: "foreground" },
  });
  const event = (i: Installation, id: string, kind: string, detail = "") =>
    live.event(i, id, { event_id: randomUUID(), kind, detail });
  it("restricts publishing to admins and requires same-revision platform review", async () => {
    expect(can("editor", "in_app:publish")).toBe(false);
    expect(can("admin", "in_app:publish")).toBe(true);
    const c = await create();
    await expect(publish(c)).rejects.toMatchObject({ status: 400 });
    const r = await reviewed();
    await expect(
      campaigns.review(tenant, app, member, {
        run_id: r.id,
        passed: true,
        layout_checked: false,
        close_checked: true,
        actions_checked: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await campaigns.review(tenant, app, member, {
      run_id: r.id,
      passed: true,
      layout_checked: true,
      close_checked: true,
      actions_checked: true,
    });
    expect((await publish(c)).state).toBe("published");
    const both = await create({ platforms: ["ios", "android"] });
    await expect(publish(both)).rejects.toMatchObject({ status: 400 });
  });
  it("separates credentials by tenant/app and does not reuse test pairing", async () => {
    const { credential } = await installation();
    await expect(
      live.auth(randomUUID(), app, credential),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      live.auth(tenant, randomUUID(), credential),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      live.auth(tenant, app, randomUUID() + ".invalid"),
    ).rejects.toMatchObject({ status: 401 });
    const test = await workbench.pairing(tenant, app, member);
    await expect(live.auth(tenant, app, test.token)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("reserves once under concurrent requests and enforces authorize before display", async () => {
    const { context: i } = await installation(),
      b = input();
    const results = await Promise.all([live.decide(i, b), live.decide(i, b)]);
    const d = results[0].delivery!;
    expect(results[1].delivery?.id).toBe(d.id);
    await expect(
      live.decide(i, { ...b, session_id: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await live.decide(i, input())).delivery).toBeNull();
    await expect(event(i, d.id, "presented")).rejects.toMatchObject({
      status: 409,
    });
    await live.authorize(i, d.id);
    await live.authorize(i, d.id);
    await event(i, d.id, "presented");
    await event(i, d.id, "impression");
    await event(i, d.id, "impression");
    await event(i, d.id, "dismiss", "close_button");
    const report = await campaigns.report(tenant, app, d.campaign_id);
    expect(report.events.find((e) => e.kind === "impression")?.count).toBe(1);
    await expect(event(i, d.id, "presented")).rejects.toMatchObject({
      status: 409,
    });
    expect((await live.decide(i, input())).delivery).toBeNull();
  });
  it("blocks wrong triggers, OS and future schedules", async () => {
    const android = await installation("android");
    expect((await live.decide(android.context, input())).delivery).toBeNull();
    const { context: i } = await installation();
    expect(
      (
        await live.decide(i, {
          ...input(),
          trigger: { type: "screen", name: "home" },
        })
      ).delivery,
    ).toBeNull();
    const future = await create({
      trigger: { type: "event", name: "future" },
      starts_at: new Date(Date.now() + 3600000).toISOString(),
    });
    await publish(future);
    expect(
      (
        await live.decide(i, {
          ...input(),
          trigger: { type: "event", name: "future" },
        })
      ).delivery,
    ).toBeNull();
  });
  it("preserves limits through pause and republish and applies daily suppression", async () => {
    const c = await create({ trigger: { type: "screen", name: "offers" } });
    await publish(c);
    const { context: i } = await installation(),
      b = { ...input(), trigger: { type: "screen", name: "offers" } };
    const d = (await live.decide(i, b)).delivery!;
    await live.authorize(i, d.id);
    await event(i, d.id, "presented");
    await event(i, d.id, "hide_today");
    await event(i, d.id, "dismiss", "hide_today");
    await pg.query(
      "UPDATE in_app_deliveries SET authorized_at=now()-interval '2 minutes' WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [tenant, app, d.id],
    );
    const paused = await campaigns.transition(
      tenant,
      app,
      c.id,
      member,
      { expected_version: c.version },
      false,
    );
    await publish(paused);
    expect(
      (
        await live.decide(i, {
          ...b,
          session_id: randomUUID(),
          request_key: randomUUID(),
        })
      ).delivery,
    ).toBeNull();
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS n FROM in_app_publications WHERE tenant_id=$1 AND app_id=$2 AND campaign_id=$3",
          [tenant, app, c.id],
        )
      ).rows[0].n,
    ).toBe(2);
    const suppression = (await pg.query(
      "SELECT until_at FROM in_app_suppressions WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND campaign_id=$4",
      [tenant, app, i.id, c.id],
    )).rows[0];
    const nextMidnight = new Date(); nextMidnight.setUTCHours(24, 0, 0, 0);
    expect(suppression.until_at.toISOString()).toBe(nextMidnight.toISOString());
    // The opt-out belongs to this installation and campaign, not every device.
    const { context: other } = await installation();
    expect((await live.decide(other, { ...b, ...input(), trigger: b.trigger })).delivery).not.toBeNull();
    // Expire only the suppression; frequency/cooldown still pass through real decision logic.
    await pg.query(
      "UPDATE in_app_suppressions SET until_at=now()-interval '1 second' WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3 AND campaign_id=$4",
      [tenant, app, i.id, c.id],
    );
    expect((await live.decide(i, { ...input(), trigger: b.trigger })).delivery).not.toBeNull();
  });
  it("pause invalidates an outstanding reservation, rejects stale edits and revokes credentials", async () => {
    const c = await create({ trigger: { type: "event", name: "checkout" } });
    await publish(c);
    const { context: i, credential } = await installation();
    const d = (
      await live.decide(i, {
        ...input(),
        trigger: { type: "event", name: "checkout" },
      })
    ).delivery!;
    await expect(
      campaigns.save(
        tenant,
        app,
        {
          name: "Oops",
          revision_id: revision,
          config,
          expected_version: c.version,
        },
        c.id,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await campaigns.transition(
      tenant,
      app,
      c.id,
      member,
      { expected_version: c.version },
      false,
    );
    await expect(live.authorize(i, d.id)).rejects.toMatchObject({
      status: 409,
    });
    expect((await live.status(i, d.id)).active).toBe(false);
    await expect(
      campaigns.transition(
        tenant,
        app,
        c.id,
        member,
        { expected_version: c.version },
        true,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await live.revoke(i);
    await expect(live.auth(tenant, app, credential)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("enforces session, lifetime and expired reservation limits", async () => {
    const c = await create({
      trigger: { type: "event", name: "limit" },
      max_total: 1,
    });
    await publish(c);
    const { context: i } = await installation(),
      b = { ...input(), trigger: { type: "event", name: "limit" } };
    const d = (await live.decide(i, b)).delivery!;
    await live.authorize(i, d.id);
    await event(i, d.id, "presented");
    await event(i, d.id, "dismiss");
    await pg.query(
      "UPDATE in_app_deliveries SET authorized_at=now()-interval '2 days' WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [tenant, app, d.id],
    );
    expect(
      (
        await live.decide(i, {
          ...b,
          session_id: randomUUID(),
          request_key: randomUUID(),
        })
      ).delivery,
    ).toBeNull();
    const other = await installation();
    const reserved = (await live.decide(other.context, b)).delivery!;
    await pg.query(
      "UPDATE in_app_deliveries SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [tenant, app, reserved.id],
    );
    await expect(
      live.authorize(other.context, reserved.id),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("limits repeated sessions and UTC daily authorizations independently", async () => {
    const c = await create({
      trigger: { type: "event", name: "daily" },
      max_per_day: 2,
      max_total: 10,
    });
    await publish(c);
    const { context: i } = await installation(),
      b = { ...input(), trigger: { type: "event", name: "daily" } };
    const first = (await live.decide(i, b)).delivery!;
    await live.authorize(i, first.id);
    await event(i, first.id, "presented");
    await event(i, first.id, "dismiss");
    await pg.query(
      "UPDATE in_app_deliveries SET authorized_at=now()-interval '2 minutes' WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [tenant, app, first.id],
    );
    expect(
      (await live.decide(i, { ...b, request_key: randomUUID() })).delivery,
    ).toBeNull();
    const second = (
      await live.decide(i, {
        ...b,
        request_key: randomUUID(),
        session_id: randomUUID(),
      })
    ).delivery!;
    await live.authorize(i, second.id);
    await event(i, second.id, "presented");
    await event(i, second.id, "dismiss");
    await pg.query(
      "UPDATE in_app_deliveries SET authorized_at=now()-interval '2 minutes' WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [tenant, app, second.id],
    );
    expect(
      (
        await live.decide(i, {
          ...b,
          request_key: randomUUID(),
          session_id: randomUUID(),
        })
      ).delivery,
    ).toBeNull();
    const { context: other } = await installation();
    await expect(live.authorize(other, first.id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("replays offline events once without reopening cancelled deliveries or suppressing a later day", async () => {
    const c = await create({ trigger: { type: "event", name: "offline" } });
    await publish(c);
    const { context: i } = await installation();
    const d = (await live.decide(i, { ...input(), trigger: { type: "event", name: "offline" } })).delivery!;
    await live.authorize(i, d.id);
    await pg.query("UPDATE in_app_deliveries SET state='cancelled',created_at=now()-interval '1 day',expires_at=now()-interval '23 hours' WHERE tenant_id=$1 AND app_id=$2 AND id=$3", [tenant,app,d.id]);
    const occurred_at = new Date(Date.now() - 86400000 + 1000).toISOString();
    const presented = { event_id: randomUUID(), kind: "presented", occurred_at };
    await expect(live.event(i,d.id,{event_id:randomUUID(),kind:"impression",occurred_at})).rejects.toMatchObject({status:409});
    await live.event(i,d.id,presented);
    await live.event(i,d.id,presented);
    for (const kind of ["impression","hide_today","dismiss"])
      await live.event(i,d.id,{event_id:randomUUID(),kind,occurred_at});
    const row = (await pg.query("SELECT state FROM in_app_deliveries WHERE tenant_id=$1 AND app_id=$2 AND id=$3",[tenant,app,d.id])).rows[0];
    expect(row.state).toBe("cancelled");
    expect((await pg.query("SELECT 1 FROM in_app_suppressions WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3",[tenant,app,i.id])).rowCount).toBe(0);
    const report = await campaigns.report(tenant,app,c.id);
    expect(report.events.find(e=>e.kind==='presented')?.count).toBe(1);
    expect(report.events.find(e=>e.kind==='impression')?.count).toBe(1);
    await expect(live.event(i,d.id,{event_id:randomUUID(),kind:"log",occurred_at:new Date(Date.now()-8*86400000).toISOString()})).rejects.toMatchObject({status:409});
    const { context: other } = await installation();
    await expect(live.event(other,d.id,presented)).rejects.toMatchObject({status:404});
  });

  it("validates zones and keeps non-UTC campaigns away from legacy SDKs", async () => {
    await expect(create({ time_zone: "Not/AZone" })).rejects.toMatchObject({ status: 400 });
    const c = await create({ time_zone: "Asia/Seoul", trigger: { type: "event", name: "zone-capability" } });
    await publish(c);
    const { context: i } = await installation();
    const b = { ...input(), trigger: { type: "event", name: "zone-capability" } };
    expect((await live.decide(i,b)).delivery).toBeNull();
    const d = (await live.decide(i,b,true)).delivery!;
    expect(d.time_zone).toBe("Asia/Seoul");
    expect(d.lifecycle_events).toBe(true);
    expect((await live.decide(i,b)).delivery).toBeNull();
    expect((await live.decide(i,b,true)).delivery?.id).toBe(d.id);
  });
  it("resets the daily authorization cap at campaign-local midnight", async () => {
    const name = randomUUID();
    const c = await create({ time_zone: "Asia/Seoul", trigger: { type: "event", name }, max_per_day: 1, max_total: 10 });
    await publish(c);
    const { context: i } = await installation();
    const decide = () => live.decide(i, { ...input(), trigger: { type: "event", name } }, true);
    const d = (await decide()).delivery!;
    await live.authorize(i, d.id);
    await event(i, d.id, "presented");
    await event(i, d.id, "dismiss");
    await pg.query("UPDATE in_app_deliveries SET authorized_at=(date_trunc('day',now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul') WHERE id=$1", [d.id]);
    expect((await decide()).delivery).toBeNull();
    // Same campaign/installation, but an authorization on the previous Korean day.
    await pg.query("UPDATE in_app_deliveries SET authorized_at=authorized_at-interval '2 minutes' WHERE id=$1", [d.id]);
    expect((await decide()).delivery?.campaign_id).toBe(c.id);
  });
  it("uses publication-local midnight including DST and ignores a subsequently edited zone", async () => {
    for (const [zone, when, until] of [
      ["Asia/Seoul", "2026-09-17T14:59:30.000Z", "2026-09-17T15:00:00.000Z"],
      ["Asia/Seoul", "2026-09-17T15:00:00.000Z", "2026-09-18T15:00:00.000Z"],
      ["America/New_York", "2026-03-08T06:30:00.000Z", "2026-03-09T04:00:00.000Z"],
      ["America/New_York", "2026-11-01T05:30:00.000Z", "2026-11-02T05:00:00.000Z"],
      ["Asia/Kathmandu", "2026-09-17T12:00:00.000Z", "2026-09-17T18:15:00.000Z"],
    ] as const) {
      const name = randomUUID();
      const c = await create({ time_zone: zone, trigger: { type: "event", name } }); await publish(c);
      const { context: i } = await installation();
      const d = (await live.decide(i,{...input(), trigger:{type:"event",name}},true)).delivery!;
      await live.authorize(i,d.id);
      await pg.query("UPDATE in_app_deliveries SET created_at=$2::timestamptz-interval '1 minute',authorized_at=$2,expires_at=$2::timestamptz+interval '5 minutes' WHERE id=$1",[d.id,when]);
      // A later campaign edit must not change the immutable publication's suppression semantics.
      await pg.query("UPDATE in_app_campaigns SET config=jsonb_set(config,'{time_zone}','\"UTC\"') WHERE id=$1",[c.id]);
      const clock = vi.spyOn(Date,"now").mockReturnValue(Date.parse(when));
      try {
        await live.event(i,d.id,{event_id:randomUUID(),kind:"presented",occurred_at:when});
        await live.event(i,d.id,{event_id:randomUUID(),kind:"hide_today",occurred_at:when});
        const row = (await pg.query("SELECT until_at FROM in_app_suppressions WHERE installation_id=$1 AND campaign_id=$2",[i.id,c.id])).rows[0];
        expect(new Date(row.until_at).toISOString()).toBe(until);
      } finally { clock.mockRestore(); }
    }
  });
  it("does not extend an offline hide into the next local day", async () => {
    const name = randomUUID(), when = "2026-09-17T14:59:30.000Z";
    const c=await create({time_zone:"Asia/Seoul",trigger:{type:"event",name}});await publish(c);
    const {context:i}=await installation();const d=(await live.decide(i,{...input(),trigger:{type:"event",name}},true)).delivery!;
    await live.authorize(i,d.id);
    await pg.query("UPDATE in_app_deliveries SET created_at=$2::timestamptz-interval '1 minute',expires_at=$2::timestamptz+interval '5 minutes' WHERE id=$1",[d.id,when]);
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.parse("2026-09-17T15:00:30.000Z"));
    try {
      await live.event(i,d.id,{event_id:randomUUID(),kind:"presented",occurred_at:when});
      await live.event(i,d.id,{event_id:randomUUID(),kind:"hide_today",occurred_at:when});
      expect((await pg.query("SELECT 1 FROM in_app_suppressions WHERE installation_id=$1",[i.id])).rowCount).toBe(0);
    } finally { clock.mockRestore(); }
  });
  it("separates normal cancellations and legacy context changes from render failures", async () => {
    const name=randomUUID(),c=await create({trigger:{type:"event",name}});await publish(c);
    for (const [kind,detail] of [["cancelled","background"],["failed","CONTEXT_CHANGED"],["failed","WEBVIEW_ERROR"]] as const) {
      const {context:i}=await installation();const d=(await live.decide(i,{...input(),trigger:{type:"event",name}})).delivery!;
      // Cancellation before presentation is valid and does not claim an impression.
      await event(i,d.id,kind,detail);
    }
    const report=await campaigns.report(tenant,app,c.id);
    expect(report.interruptions.map(e=>e.reason).sort()).toEqual(["background","legacy_context_changed"]);
    expect(report.failures.map(e=>e.detail)).toEqual(["WEBVIEW_ERROR"]);
    expect(report.deliveries.find(e=>e.state==="cancelled")?.count).toBe(1);
    expect(report.events.find(e=>e.kind==="impression")).toBeUndefined();
  });

});
