// Resend 웹훅 → message.lifecycle 스트림 → ClickHouse message_lifecycle → 도달/오픈 리포트 E2E.
// 전제: docker compose --profile full --profile app 기동(MODE=multi_tenant), API_URL/CH 접근 가능.
// 사용: node tests/e2e/resend-webhook.mjs
import { createHmac, randomUUID } from "node:crypto";

const BASE = process.env.API_URL ?? "http://localhost:8080";
const CH = process.env.CLICKHOUSE_HTTP ?? "http://localhost:8123";
const CH_AUTH = process.env.CLICKHOUSE_AUTH ?? "onda:onda";
const SECRET_RAW = Buffer.from("onda-e2e-webhook-secret-0123456789ab");
const WEBHOOK_SECRET = "whsec_" + SECRET_RAW.toString("base64");

async function req(method, path, { cookie, body, headers = {}, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body || raw ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

async function ch(sql) {
  const res = await fetch(`${CH}/?database=onda`, {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(CH_AUTH).toString("base64") },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CH ${res.status}: ${text}`);
  return text.trim();
}

function sign(id, ts, body) {
  const sig = createHmac("sha256", SECRET_RAW).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}

async function webhook(appId, event, { badSecret = false, staleTs = false } = {}) {
  const body = JSON.stringify(event);
  const id = "msg_" + randomUUID().replace(/-/g, "").slice(0, 20);
  const ts = String(Math.floor(Date.now() / 1000) - (staleTs ? 3600 : 0));
  let sig = sign(id, ts, body);
  if (badSecret) sig = "v1," + createHmac("sha256", Buffer.from("wrong")).update(`${id}.${ts}.${body}`).digest("base64");
  return req("POST", `/v1/webhooks/resend/${appId}`, {
    raw: body,
    headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig },
  });
}

function assert(cond, msg) {
  if (!cond) { console.error("✗", msg); process.exitCode = 1; throw new Error(msg); }
  console.log("✓", msg);
}

async function until(fn, label, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout: ${label}`);
}

const main = async () => {
  // 1. 테넌트·앱
  const email = `resend-e2e-${Date.now()}@example.com`;
  const s = await req("POST", "/v1/auth/signup", {
    body: { email, password: "password123", name: "resend-e2e", tenant_name: "resend-e2e" },
  });
  assert(s.status === 201 || s.status === 200, `signup ${s.status}`);
  const cookie = s.setCookie.split(";")[0];
  const appId = s.json.app_id;
  const tenantId = s.json.tenant_id;

  // 2. email_resend 크리덴셜 (webhook_secret 포함). 검증은 워커가 비동기로 하며 실패해도 웹훅 수신엔 무관.
  const c = await req("PUT", `/v1/apps/${appId}/credentials`, {
    cookie,
    body: { kind: "email_resend", api_key: "re_e2e_dummy", from_email: "noreply@example.com", webhook_secret: WEBHOOK_SECRET, base_url: "http://127.0.0.1:9" },
  });
  assert(c.status === 200 || c.status === 201, `credential upsert ${c.status} ${JSON.stringify(c.json)}`);

  // 3. 발송 원장에 sent 행 2개 심기 (저니 1개) — 리포트 분모와 provider_message_id 폴백용
  const journeyId = randomUUID();
  const m1 = randomUUID(); // 태그로 조인
  const m2 = randomUUID(); // provider_message_id로 조인
  const em2 = "em_" + m2.slice(0, 8);
  for (const [mid, pid] of [[m1, "em_" + m1.slice(0, 8)], [m2, em2]]) {
    await ch(`INSERT INTO message_log (tenant_id, app_id, message_id, idempotency_key, journey_id, journey_version, node_index, campaign_ref, user_id, device_id, channel, status, failure_class, failure_detail, sent_at, provider_message_id)
      VALUES ('${tenantId}','${appId}','${mid}','e2e:${mid}','${journeyId}',1,0,'','00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','email','sent','','',now64(3),'${pid}')`);
  }

  // 4. 서명 실패·만료 → 401
  const base = (type, data) => ({ type, created_at: new Date().toISOString(), data: { created_at: new Date().toISOString(), from: "noreply@example.com", to: ["u@example.com"], subject: "e2e", ...data } });
  const bad = await webhook(appId, base("email.delivered", { email_id: "em_x", tags: { onda_message_id: m1 } }), { badSecret: true });
  assert(bad.status === 401, `잘못된 서명 → 401 (got ${bad.status})`);
  const stale = await webhook(appId, base("email.delivered", { email_id: "em_x", tags: { onda_message_id: m1 } }), { staleTs: true });
  assert(stale.status === 401, `만료된 타임스탬프 → 401 (got ${stale.status})`);

  // 5. 정상 이벤트: m1은 태그(object) delivered+opened, m2는 태그 없이 email_id 폴백 delivered + clicked(array 태그)
  const ok1 = await webhook(appId, base("email.delivered", { email_id: "em_" + m1.slice(0, 8), tags: { onda_message_id: m1 } }));
  assert(ok1.status === 200 && ok1.json?.accepted === true, `delivered(tag object) 수락 ${ok1.status} ${JSON.stringify(ok1.json)}`);
  const ok2 = await webhook(appId, base("email.opened", { email_id: "em_" + m1.slice(0, 8), tags: { onda_message_id: m1 } }));
  assert(ok2.status === 200 && ok2.json?.accepted === true, `opened 수락`);
  const ok3 = await webhook(appId, base("email.delivered", { email_id: em2 }));
  assert(ok3.status === 200 && ok3.json?.accepted === true, `delivered(provider_message_id 폴백) 수락 ${JSON.stringify(ok3.json)}`);
  const ok4 = await webhook(appId, base("email.clicked", { email_id: em2, tags: [{ name: "onda_message_id", value: m2 }], click: { link: "https://example.com/x" } }));
  assert(ok4.status === 200 && ok4.json?.accepted === true, `clicked(tag array) 수락`);
  const ign = await webhook(appId, base("email.delivery_delayed", { email_id: em2 }));
  assert(ign.status === 200 && ign.json?.accepted === false, `delivery_delayed 무시`);
  // 재전송(동일 이벤트) → 중복 제거 확인용
  await webhook(appId, base("email.delivered", { email_id: "em_" + m1.slice(0, 8), tags: { onda_message_id: m1 } }));

  // 6. 워커 lifecycle 소비 → CH
  const rows = await until(async () => {
    const n = await ch(`SELECT count() FROM message_lifecycle FINAL WHERE tenant_id='${tenantId}' AND app_id='${appId}'`);
    return Number(n) >= 4 ? n : null;
  }, "message_lifecycle rows >= 4");
  console.log("  message_lifecycle rows:", rows);
  const detail = await ch(`SELECT message_id, status, connector_id, provider_message_id, click_ref FROM message_lifecycle FINAL WHERE tenant_id='${tenantId}' AND app_id='${appId}' ORDER BY status FORMAT TSV`);
  console.log(detail.split("\n").map((l) => "  " + l).join("\n"));
  assert(detail.includes(m1) && detail.includes(m2), "두 message_id 모두 lifecycle에 기록");
  assert(detail.includes("https://example.com/x"), "click_ref 기록");

  // 7. 리포트: sent 2, delivered 2, opened 1, clicked 1
  const rep = await req("GET", `/v1/apps/${appId}/journeys/${journeyId}/delivery`, { cookie });
  console.log("  report:", JSON.stringify(rep.json));
  assert(rep.status === 200, `report ${rep.status}`);
  assert(rep.json.sent === 2, `sent=2 (got ${rep.json.sent})`);
  assert(rep.json.delivered === 2, `delivered=2 (got ${rep.json.delivered})`);
  assert(rep.json.opened === 1, `opened=1 (got ${rep.json.opened})`);
  assert(rep.json.clicked === 1, `clicked=1 (got ${rep.json.clicked})`);

  // 8. 다른 앱의 webhook URL로 같은 서명 → 크리덴셜 없음 401 (테넌트 격리)
  const other = await webhook(randomUUID(), base("email.delivered", { email_id: "x", tags: { onda_message_id: m1 } }));
  assert(other.status === 401 || other.status === 404, `미등록 앱 → 401/404 (got ${other.status})`);

  console.log("\nRESEND WEBHOOK E2E: PASS");
};

main().catch((e) => { console.error(e.message); process.exit(1); });
