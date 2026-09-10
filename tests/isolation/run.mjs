// 교차 테넌트 격리 자동 스위트 (M-6 / T-8).
// 두 테넌트를 가입시키고, A 세션으로 B의 리소스에 접근 → 403/404 기대.
//
// 대입 경로는 손으로 적은 목록이 아니라 컨트롤러 소스에서 뽑는다(routes.mjs) — 신규 엔드포인트가 생기면
// 자동으로 포함된다. 경로 파라미터는 B가 실제로 가진 리소스 id로 채운다(존재하는 리소스여야 "404가 격리라서
// 나온 것"인지 "원래 없어서 나온 것"인지가 구분된다). 2xx는 물론 400도 위반으로 본다 — NestJS는 가드가
// 파이프(검증)보다 먼저 돌므로 400은 "가드가 없거나 뒤에 있다"는 뜻이다. 401은 세션이 있는데 나오면 위반.
//
// 사용: node tests/isolation/run.mjs   (API_URL 기본 http://localhost:8080, MODE=multi_tenant 필요)
import { randomUUID } from "node:crypto";
import { extractRoutes } from "./routes.mjs";

const BASE = process.env.API_URL ?? "http://localhost:8080";
const SRC = process.env.API_SRC ?? "apps/api/src";

async function req(method, path, { cookie, bearer, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}
const cookieFrom = (setCookie) => (setCookie ? setCookie.split(";")[0] : "");

async function signup(suffix) {
  const email = `iso-${suffix}-${Date.now()}@example.com`;
  const r = await req("POST", "/v1/auth/signup", { body: { email, password: "password123", name: `iso-${suffix}`, tenant_name: `iso-${suffix}` } });
  if (r.status !== 201 && r.status !== 200) throw new Error(`signup 실패(${suffix}): ${r.status} ${JSON.stringify(r.json)}`);
  return { cookie: cookieFrom(r.setCookie), appId: r.json.app_id, tenantId: r.json.tenant_id, sdkKey: r.json.sdk_key, serverKey: r.json.server_key };
}

// B에 실제 리소스를 만든다 — 경로 파라미터를 채울 재료.
async function seedB(b) {
  const ids = {};
  const seg = await req("POST", `/v1/apps/${b.appId}/segments`, { cookie: b.cookie, body: { name: "b-seg", definition: {
    version: 1, operator: "AND", groups: [{ operator: "AND", conditions: [{ type: "attribute", key: "country", op: "eq", value: "KR" }] }] } } });
  ids.segment = seg.json?.id;
  const j = await req("POST", `/v1/apps/${b.appId}/journeys`, { cookie: b.cookie, body: { name: "b-journey", definition: {
    entry: { type: "blast", segment_id: ids.segment }, nodes: [{ type: "message", push: { title: "t", body: "b" } }], exit: {}, settings: { category: "marketing", reentry: "never" } } } });
  ids.journey = j.json?.id;
  const tpl = await req("POST", `/v1/apps/${b.appId}/email-templates`, { cookie: b.cookie, body: { name: "b-tpl", subject: "s", html: "<p>h</p>" } });
  ids.emailTemplate = tpl.json?.id;
  const sender = await req("POST", `/v1/apps/${b.appId}/alimtalk/senders`, { cookie: b.cookie, body: { sender_key: "b".repeat(40), channel_name: "@b", is_default: true } });
  ids.sender = sender.json?.id;
  const keys = await req("GET", `/v1/apps/${b.appId}/keys`, { cookie: b.cookie });
  ids.key = (keys.json?.keys ?? [])[0]?.id;
  await req("PUT", `/v1/apps/${b.appId}/credentials`, { cookie: b.cookie, body: { kind: "email_smtp", host: "smtp.example.com", port: 587, from_email: "b@example.com" } });
  // B의 유저 하나 (SDK 키로 identify) — users/:id 대입용
  const ext = "b-user-" + randomUUID().slice(0, 8);
  await req("POST", "/v1/identify", { bearer: b.sdkKey, body: { external_id: ext, anon_id: randomUUID(), attributes: {} } });
  for (let i = 0; i < 20; i++) {
    const u = await req("GET", `/v1/apps/${b.appId}/users?q=${ext}`, { cookie: b.cookie });
    const hit = (u.json?.users ?? u.json?.items ?? []).find((x) => x.external_id === ext);
    if (hit) { ids.user = hit.id; ids.userExternal = ext; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  const members = await req("GET", "/v1/members", { cookie: b.cookie });
  ids.member = (members.json?.members ?? members.json ?? [])[0]?.id;
  return ids;
}

// 경로 파라미터 → B의 실제 id. 없으면 무작위 UUID(그 경우 404가 격리 때문인지 알 수 없어 표시한다).
function fill(path, b, ids) {
  const miss = [];
  const pick = (name, v) => { if (!v) { miss.push(name); return randomUUID(); } return v; };
  let p = path.replace(":appId", b.appId);
  if (p.includes("/segments/:id")) p = p.replace(":id", pick("segment", ids.segment));
  else if (p.includes("/journeys/:id")) p = p.replace(":id", pick("journey", ids.journey));
  else if (p.includes("/email-templates/:id")) p = p.replace(":id", pick("emailTemplate", ids.emailTemplate));
  else if (p.includes("/alimtalk/senders/:id")) p = p.replace(":id", pick("sender", ids.sender));
  else if (p.includes("/users/:id")) p = p.replace(":id", pick("user", ids.user));
  p = p.replace(":keyId", pick("key", ids.key)).replace(":memberId", pick("member", ids.member))
    .replace(":kind", "email_smtp").replace(":channel", "kakao_alimtalk").replace(":key", "country").replace(":externalId", ids.userExternal ?? "b-user");
  return { path: p, miss };
}

async function main() {
  console.log("== 격리 스위트 시작 ==");
  const a = await signup("a");
  const b = await signup("b");
  console.log(`테넌트 A app=${a.appId}, B app=${b.appId}`);
  const ids = await seedB(b);
  console.log("B 리소스:", Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v ? "ok" : "MISSING"])));

  const routes = extractRoutes(SRC);
  // 1) A 세션 → B의 앱 범위 전 경로
  const appRoutes = routes.filter((r) => r.path.includes(":appId") && !r.path.startsWith("/v1/webhooks"));
  // 2) A 세션 → B의 멤버 (테넌트 범위 리소스에 타 테넌트 id 대입)
  const memberRoutes = routes.filter((r) => r.path.includes(":memberId"));
  const probes = [...appRoutes, ...memberRoutes].map((r) => {
    const { path, miss } = fill(r.path, b, ids);
    const body = ["POST", "PUT", "PATCH"].includes(r.method) ? {} : undefined;
    return { method: r.method, path, body, miss, source: r.file, auth: { cookie: a.cookie } };
  });
  // 3) 서명 없는 웹훅 경로에 B의 appId → 401
  probes.push({ method: "POST", path: `/v1/webhooks/resend/${b.appId}`, body: {}, miss: [], source: "email/resend-webhook.controller.ts (unsigned)", auth: {} });

  let violations = 0, unverifiable = 0;
  for (const p of probes) {
    const r = await req(p.method, p.path, { ...p.auth, body: p.body });
    const shown = p.path.replace(b.appId, "B_APP");
    const isolated = r.status === 403 || r.status === 404 || r.status === 401 && !p.auth.cookie && !p.auth.bearer;
    if (!isolated) {
      violations++;
      console.error(`✗ 격리 위반: ${p.method} ${shown} → ${r.status} ${JSON.stringify(r.json).slice(0, 120)}  [${p.source}]`);
    } else if (p.miss.length) {
      unverifiable++;
      console.log(`? ${p.method} ${shown} → ${r.status} (B 리소스 없음: ${p.miss.join(",")} — 404가 격리 때문인지 미확정)`);
    } else {
      console.log(`✓ ${p.method} ${shown} → ${r.status}`);
    }
  }
  // 4) A의 서버 키로 B의 external_id 삭제 — 키는 자기 앱에만 묶이므로 202(비동기 접수)가 오더라도 B의 유저는 남아야 한다.
  if (ids.userExternal) {
    await req("DELETE", `/v1/users/${ids.userExternal}`, { bearer: a.serverKey });
    await new Promise((r) => setTimeout(r, 2000));
    const still = await req("GET", `/v1/apps/${b.appId}/users?q=${ids.userExternal}`, { cookie: b.cookie });
    const alive = (still.json?.users ?? still.json?.items ?? []).some((x) => x.external_id === ids.userExternal);
    if (!alive) { violations++; console.error(`✗ 격리 위반: A 서버 키의 DELETE /v1/users/:externalId 가 B의 유저를 지웠다`); }
    else console.log(`✓ DELETE /v1/users/:externalId (A 서버 키) → B의 유저 유지`);
  } else { unverifiable++; console.log("? A 서버 키 유저 삭제 — B 유저를 만들지 못해 미확정"); }
  // 대조군: B 자신은 자기 리소스에 접근된다(스위트가 "전부 404"로 통과하는 것을 막는다)
  const self = await req("GET", `/v1/apps/${b.appId}/journeys/${ids.journey}`, { cookie: b.cookie });
  if (self.status !== 200) { violations++; console.error(`✗ 대조군 실패: B 자신의 저니 조회 → ${self.status}`); }
  else console.log("✓ 대조군: B 자신의 저니 조회 → 200");

  console.log(`\n== 결과: 경로 ${probes.length}개 (컨트롤러 ${routes.length}개 라우트 중 앱/멤버 범위 ${appRoutes.length + memberRoutes.length} + 웹훅 1, 서버키 삭제 별도), 위반 ${violations}, 미확정 ${unverifiable} ==`);
  process.exit(violations === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
