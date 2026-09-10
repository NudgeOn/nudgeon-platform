// Slice B — 설치 claim → 첫 Owner 원자 생성 → 영구 잠금 E2E. Safe Boot 인스턴스(./nudgeon up, single_tenant)를 대상으로
// 게이트웨이를 통해 부른다(브라우저와 같은 경로: loopback → X-Forwarded-For 127.0.0.1).
//   BASE=http://localhost:18080 TOKEN_FILE=<clone>/.nudgeon/secrets/setup_token node tests/e2e/bootstrap-claim.mjs
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:8080";
const TOKEN = (process.env.TOKEN ?? readFileSync(process.env.TOKEN_FILE, "utf8")).trim();
const ROTATE = process.env.ROTATE_CMD; // 예: "cd <clone> && ./nudgeon setup-token rotate" — 있으면 rotate 시나리오도 돈다

async function req(method, path, { cookie, body, headers } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, redirect: "manual",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(headers ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  const cookies = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, json, headers: res.headers, cookies };
}
const cookieOf = (r, name) => r.cookies.find((c) => c.startsWith(name + "="))?.split(";")[0];
function ok(c, m) { if (!c) { console.error("✗", m); process.exitCode = 1; throw new Error(m); } console.log("✓", m); }

const main = async () => {
  const st = await req("GET", "/v1/bootstrap/status");
  ok(st.status === 200 && st.json.mode === "single_tenant", `status ${st.status} mode=${st.json?.mode}`);
  ok(st.json.state === "unclaimed" && st.json.setup_token_configured === true, `state=${st.json.state}, token configured`);
  ok((st.headers.get("cache-control") ?? "").includes("no-store") && (st.headers.get("referrer-policy") ?? "").includes("no-referrer") && (st.headers.get("content-security-policy") ?? "").includes("frame-ancestors"), "bootstrap 응답 보안 헤더(no-store, no-referrer, frame-ancestors)");

  // single_tenant: 가입은 설치 전후 모두 없다
  const su = await req("POST", "/v1/auth/signup", { body: { email: "x@example.com", password: "password123", name: "x", tenant_name: "x" } });
  ok(su.status === 404, `signup → ${su.status} (설치 전 404)`);

  // 잘못된 코드 → 401, 형식 불량 → 400
  ok((await req("POST", "/v1/bootstrap/claim", { body: { token: "f".repeat(64) } })).status === 401, "잘못된 설치 코드 → 401");
  ok((await req("POST", "/v1/bootstrap/claim", { body: { token: "short" } })).status === 400, "형식 불량 → 400");

  // 동시 claim: 하나만 lease
  const [c1, c2] = await Promise.all([req("POST", "/v1/bootstrap/claim", { body: { token: TOKEN } }), req("POST", "/v1/bootstrap/claim", { body: { token: TOKEN } })]);
  const winners = [c1, c2].filter((r) => r.status === 204);
  ok(winners.length === 1 && [c1, c2].some((r) => r.status === 409), `동시 claim 2건 → 204 하나, 409 하나 (${c1.status}/${c2.status})`);
  const bootstrapCookie = cookieOf(winners[0], "nudgeon_bootstrap");
  ok(!!bootstrapCookie && /HttpOnly/i.test(winners[0].cookies.find((c) => c.startsWith("nudgeon_bootstrap="))), "Bootstrap cookie HttpOnly 발급");
  ok((await req("GET", "/v1/bootstrap/status")).json.state === "claimed", "state=claimed");
  ok((await req("POST", "/v1/bootstrap/claim", { body: { token: TOKEN } })).status === 409, "활성 lease 중 재claim → 409");

  if (ROTATE) {
    // 코드 분실 시 host-local rotate: 이전 코드·lease 폐기
    const { execSync } = await import("node:child_process");
    execSync(ROTATE, { stdio: "pipe" });
    for (let i = 0; i < 60; i++) { try { const r = await req("GET", "/v1/bootstrap/status"); if (r.status === 200 && r.json.state === "unclaimed") break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
    ok((await req("GET", "/v1/bootstrap/status")).json.state === "unclaimed", "rotate 뒤 state=unclaimed (lease 폐기)");
    ok((await req("POST", "/v1/bootstrap/claim", { body: { token: TOKEN } })).status === 401, "rotate 뒤 이전 코드 → 401");
    const setupOld = await req("POST", "/v1/bootstrap/setup", { cookie: bootstrapCookie, headers: { "Idempotency-Key": randomUUID() }, body: { workspace_name: "w", app_name: "a", owner: { name: "o", email: "old@example.com", password: "password123" } } });
    ok(setupOld.status === 401, `rotate 뒤 이전 Bootstrap cookie로 setup → ${setupOld.status}`);
    process.env.TOKEN_NEW = readFileSync(process.env.TOKEN_FILE, "utf8").trim();
  }
  const token = process.env.TOKEN_NEW ?? TOKEN;
  const claim = ROTATE ? await req("POST", "/v1/bootstrap/claim", { body: { token } }) : winners[0];
  const cookie = cookieOf(claim, "nudgeon_bootstrap");
  ok(!!cookie, "claim OK");

  // 세션 연장: holder만, 만료 전만
  const ext = await req("POST", "/v1/bootstrap/extend", { cookie });
  ok(ext.status === 204 && !!ext.headers.get("x-bootstrap-expires-at"), `extend → ${ext.status}, 새 만료 시각`);
  ok((await req("POST", "/v1/bootstrap/extend")).status === 401, "cookie 없는 extend → 401");
  ok(typeof (await req("GET", "/v1/bootstrap/status")).json.master_key_fingerprint === "string", "status에 마스터키 fingerprint");

  // setup: cookie 없음 → 401, key 없음 → 400
  const body = { workspace_name: "설치 리허설", app_name: "First App", timezone: "Asia/Seoul", owner: { name: "Owner", email: `owner-${Date.now()}@example.com`, password: "password123" } };
  ok((await req("POST", "/v1/bootstrap/setup", { headers: { "Idempotency-Key": randomUUID() }, body })).status === 401, "cookie 없는 setup → 401");
  ok((await req("POST", "/v1/bootstrap/setup", { cookie, body })).status === 400, "Idempotency-Key 없는 setup → 400");
  const idem = randomUUID();
  // 동시 setup 2건(같은 key): 하나는 생성(201), 하나는 replay(200) 또는 순차라도 결과 동일 — Owner는 1명
  const [s1, s2] = await Promise.all([
    req("POST", "/v1/bootstrap/setup", { cookie, headers: { "Idempotency-Key": idem }, body }),
    req("POST", "/v1/bootstrap/setup", { cookie, headers: { "Idempotency-Key": idem }, body }),
  ]);
  const created = [s1, s2].find((r) => r.status === 201), replayed = [s1, s2].find((r) => r.status === 200);
  ok(!!created && !!replayed, `동시 setup(같은 key) → 201 하나 + 200 replay 하나 (${s1.status}/${s2.status})`);
  ok(created.json.sdk_key?.startsWith("pk_") && created.json.server_key && !replayed.json.sdk_key, "키 원문은 201에만, replay에는 없음");
  ok(created.json.tenant_id === replayed.json.tenant_id && created.json.app_id === replayed.json.app_id, "replay 결과 = 원본 결과");
  const session = cookieOf(created, "nudgeon_session");
  ok(!!session, "일반 세션 발급");
  const me = await req("GET", "/v1/auth/me", { cookie: session });
  ok(me.status === 200 && me.json.role === "owner", `세션으로 /auth/me → ${me.status} role=${me.json?.role}`);
  ok((await req("GET", "/v1/bootstrap/status")).json.state === "secured", "state=secured");

  // 잠금: 새 mutation은 410, 다른 key setup 410, 가입 404, 결과 재조회는 같은 cookie+key로만
  ok((await req("POST", "/v1/bootstrap/claim", { body: { token } })).status === 410, "secured 뒤 claim → 410");
  ok((await req("POST", "/v1/bootstrap/setup", { cookie, headers: { "Idempotency-Key": randomUUID() }, body })).status === 410, "secured 뒤 다른 key setup → 410");
  const diff = await req("POST", "/v1/bootstrap/setup", { cookie, headers: { "Idempotency-Key": idem }, body: { ...body, workspace_name: "다른 요청" } });
  ok(diff.status === 409, `같은 key 다른 본문 → ${diff.status}`);
  ok((await req("GET", "/v1/bootstrap/setup-result", { cookie, headers: { "Idempotency-Key": idem } })).status === 200, "setup-result 재조회 → 200");
  ok((await req("GET", "/v1/bootstrap/setup-result", { cookie, headers: { "Idempotency-Key": randomUUID() } })).status === 401, "다른 key로 setup-result → 401");
  ok((await req("POST", "/v1/auth/signup", { body: { email: "y@example.com", password: "password123", name: "y", tenant_name: "y" } })).status === 404, "설치 뒤 signup → 404");

  ok((await req("POST", "/v1/bootstrap/extend", { cookie })).status === 401, "secured 뒤 extend → 401");
  console.log("\nBOOTSTRAP CLAIM/SETUP E2E (Slice B): PASS");
};
main().catch((e) => { console.error(e.message); process.exit(1); });
