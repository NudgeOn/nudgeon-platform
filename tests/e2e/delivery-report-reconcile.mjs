// IT-8 지표 왕복 대사: 발송(message_log) → SDK $push_* 이벤트가 실제 /v1/track → 워커 → ClickHouse를
// 거쳐 → 저니 리포트 /journeys/:id/delivery 수치 == 원본을 독립 SQL로 다시 센 값 == 시나리오 기대값.
// 전제: docker compose --profile full --profile app 기동(워커 포함), API_URL/CH 접근 가능.
// 사용: node tests/e2e/delivery-report-reconcile.mjs
import { randomUUID } from "node:crypto";

const BASE = process.env.API_URL ?? "http://localhost:8080";
const CH = process.env.CLICKHOUSE_HTTP ?? "http://localhost:8123";
const CH_AUTH = process.env.CLICKHOUSE_AUTH ?? "nudgeon:nudgeon";

async function req(method, path, { cookie, bearer, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

async function ch(sql) {
  const res = await fetch(`${CH}/?database=nudgeon`, {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(CH_AUTH).toString("base64") },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CH ${res.status}: ${text}`);
  return text.trim();
}

function assert(cond, msg) {
  if (!cond) { console.error("✗", msg); process.exitCode = 1; throw new Error(msg); }
  console.log("✓", msg);
}

async function until(fn, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout: ${label}`);
}

const main = async () => {
  // 1. 격리 테넌트·앱 (SDK 키로 track)
  const email = `delivery-reconcile-${Date.now()}@example.com`;
  const s = await req("POST", "/v1/auth/signup", {
    body: { email, password: "password123", name: "delivery-reconcile", tenant_name: "delivery-reconcile" },
  });
  assert(s.status === 201 || s.status === 200, `signup ${s.status}`);
  const cookie = s.setCookie.split(";")[0];
  const { app_id: appId, tenant_id: tenantId, sdk_key: sdkKey } = s.json;
  assert(typeof sdkKey === "string" && sdkKey.length > 0, "signup이 sdk_key를 돌려준다");

  // 2. 발송 원장: 저니 J에 sent 5건(android 3·ios 2) + failed 1건 + duplicate 재기록 1건(같은 message_id).
  //    저니 K(다른 저니)에 sent 1건 — 리포트 범위 밖.
  const J = randomUUID(), K = randomUUID();
  const zero = "00000000-0000-0000-0000-000000000000";
  const mids = { a1: randomUUID(), a2: randomUUID(), a3: randomUUID(), i1: randomUUID(), i2: randomUUID(), failed: randomUUID(), other: randomUUID() };
  const row = (mid, journey, channel, status, detail = "") =>
    `('${tenantId}','${appId}','${mid}','e2e:${mid}:${status}','${journey}',1,0,'','${zero}','${randomUUID()}','${channel}','${status}','','${detail}',now64(3),'${status === "sent" ? "prov_" + mid.slice(0, 8) : ""}')`;
  const rows = [
    row(mids.a1, J, "push_fcm", "sent"), row(mids.a2, J, "push_fcm", "sent"), row(mids.a3, J, "push_fcm", "sent"),
    row(mids.i1, J, "push_apns", "sent"), row(mids.i2, J, "push_apns", "sent"),
    row(mids.a1, J, "push_fcm", "sent", "provider_id=prov_dup"), // 재전달 시 sent 재기록 — 분모에서 1건으로
    row(mids.failed, J, "push_fcm", "failed"),
    row(mids.other, K, "push_fcm", "sent"),
  ];
  await ch(`INSERT INTO message_log (tenant_id, app_id, message_id, idempotency_key, journey_id, journey_version, node_index, campaign_ref, user_id, device_id, channel, status, failure_class, failure_detail, sent_at, provider_message_id) VALUES ${rows.join(",")}`);

  // 3. SDK 이벤트를 실제 수집 경로(/v1/track, SDK 키)로 보낸다.
  //    a1: received + opened(중복 2회)  a2: received(중복 2회)  a3: 없음
  //    i1: opened만(NSE 없는 iOS)        i2: delivered(NSE)만
  //    failed: opened (sent 아님 → 제외)  other: received (다른 저니 → 제외)
  const anon = randomUUID();
  const ev = (name, mid) => ({ insert_id: randomUUID(), anon_id: anon, event: name, properties: { message_id: mid }, client_ts: new Date().toISOString() });
  const batch = [
    ev("$push_received", mids.a1), ev("$push_opened", mids.a1), ev("$push_opened", mids.a1),
    ev("$push_received", mids.a2), ev("$push_received", mids.a2),
    ev("$push_opened", mids.i1),
    ev("$push_delivered", mids.i2),
    ev("$push_opened", mids.failed),
    ev("$push_received", mids.other),
    ev("purchase", mids.a3), // 푸시 아닌 이벤트에 message_id가 있어도 세지 않는다
  ];
  const t = await req("POST", "/v1/track", { bearer: sdkKey, body: { batch, device: { device_id: randomUUID(), platform: "android" } } });
  assert(t.status === 202 || t.status === 200, `track 접수 ${t.status} ${JSON.stringify(t.json)}`);

  // 4. 워커가 CH events에 적재할 때까지 대기
  await until(async () => {
    const n = await ch(`SELECT count() FROM events WHERE tenant_id='${tenantId}' AND app_id='${appId}' AND event_name LIKE '$push%'`);
    return Number(n) >= 9 ? n : null;
  }, "events(push) >= 9");

  // 5. 기대값(시나리오에서 손으로 센 값)
  const expected = { sent: 5, delivered: 4 /* a1 a2 i1 i2 */, opened: 2 /* a1 i1 */ };

  // 6. 원본을 독립 SQL로 다시 센다 — 리포트 쿼리와 다른 형태(개별 message_id 집합의 교집합)
  const sentIds = (await ch(`SELECT DISTINCT toString(message_id) FROM message_log WHERE tenant_id='${tenantId}' AND app_id='${appId}' AND journey_id='${J}' AND status='sent' FORMAT TSV`)).split("\n").filter(Boolean);
  const evIds = async (names) => (await ch(`SELECT DISTINCT JSONExtractString(properties,'message_id') FROM events WHERE tenant_id='${tenantId}' AND app_id='${appId}' AND event_name IN (${names.map((n) => `'${n}'`).join(",")}) FORMAT TSV`)).split("\n").filter(Boolean);
  const sentSet = new Set(sentIds);
  const raw = {
    sent: sentSet.size,
    delivered: (await evIds(["$push_delivered", "$push_received", "$push_opened"])).filter((m) => sentSet.has(m)).length,
    opened: (await evIds(["$push_opened"])).filter((m) => sentSet.has(m)).length,
  };
  console.log("  expected:", JSON.stringify(expected));
  console.log("  raw     :", JSON.stringify(raw));
  assert(raw.sent === expected.sent && raw.delivered === expected.delivered && raw.opened === expected.opened, "원본 재집계 == 시나리오 기대값");

  // 7. 리포트 API
  const rep = await req("GET", `/v1/apps/${appId}/journeys/${J}/delivery`, { cookie });
  console.log("  report  :", JSON.stringify(rep.json));
  assert(rep.status === 200, `report ${rep.status}`);
  assert(rep.json.sent === raw.sent, `sent: report ${rep.json.sent} == raw ${raw.sent}`);
  assert(rep.json.delivered === raw.delivered, `delivered: report ${rep.json.delivered} == raw ${raw.delivered}`);
  assert(rep.json.opened === raw.opened, `opened: report ${rep.json.opened} == raw ${raw.opened}`);
  assert(rep.json.delivery_rate === 0.8 && rep.json.open_rate === 0.5, `rates 0.8 / 0.5 (got ${rep.json.delivery_rate} / ${rep.json.open_rate})`);
  assert(rep.json.opened <= rep.json.delivered, "opened <= delivered (open_rate가 100%를 넘지 않는다)");

  // 8. 다른 저니 K는 자기 발송만 (sent 1, 도달 1)
  const repK = await req("GET", `/v1/apps/${appId}/journeys/${K}/delivery`, { cookie });
  assert(repK.json.sent === 1 && repK.json.delivered === 1 && repK.json.opened === 0, `저니 K 격리: ${JSON.stringify(repK.json)}`);

  console.log("\nDELIVERY REPORT RECONCILE (IT-8): PASS");
};

main().catch((e) => { console.error(e.message); process.exit(1); });
