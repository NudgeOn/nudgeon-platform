// 교차 테넌트 격리 자동 스위트 (M-6 / T-8).
// 두 테넌트를 가입시키고, A 세션으로 B의 리소스에 접근 → 403/404 기대.
// 관리 API 리소스 엔드포인트를 자동 대입한다.

const BASE = process.env.API_URL ?? "http://localhost:8080";

async function req(method, path, { cookie, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

function cookieFrom(setCookie) {
  return setCookie ? setCookie.split(";")[0] : "";
}

async function signup(suffix) {
  const email = `iso-${suffix}-${Date.now()}@example.com`;
  const r = await req("POST", "/v1/auth/signup", {
    body: { email, password: "password123", name: `iso-${suffix}`, tenant_name: `iso-${suffix}` },
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`signup 실패(${suffix}): ${r.status} ${JSON.stringify(r.json)}`);
  }
  return { cookie: cookieFrom(r.setCookie), appId: r.json.app_id, tenantId: r.json.tenant_id };
}

async function main() {
  console.log("== 격리 스위트 시작 ==");
  const a = await signup("a");
  const b = await signup("b");
  console.log(`테넌트 A app=${a.appId}, B app=${b.appId}`);

  // B에 리소스 생성 (A가 접근 시도할 대상)
  const seg = await req("POST", `/v1/apps/${b.appId}/segments`, {
    cookie: b.cookie,
    body: {
      name: "b-seg",
      definition: {
        version: 1,
        operator: "AND",
        groups: [{ operator: "AND", conditions: [{ type: "attribute", key: "country", op: "eq", value: "KR" }] }],
      },
    },
  });
  const bSegId = seg.json?.id ?? "00000000-0000-0000-0000-000000000000";
  const journey = await req("POST", `/v1/apps/${b.appId}/journeys`, {
    cookie: b.cookie,
    body: {
      name: "b-journey",
      definition: {
        entry: { type: "blast", segment_id: bSegId },
        nodes: [{ type: "message", push: { title: "t", body: "b" } }],
        exit: {},
        settings: { category: "marketing", reentry: "never" },
      },
    },
  });
  const bJourneyId = journey.json?.id ?? "00000000-0000-0000-0000-000000000000";

  // A 세션으로 B 리소스 접근 → 403/404 기대
  const probes = [
    ["GET", `/v1/apps/${b.appId}/keys`],
    ["GET", `/v1/apps/${b.appId}/segments`],
    ["GET", `/v1/apps/${b.appId}/segments/${bSegId}`],
    ["GET", `/v1/apps/${b.appId}/journeys`],
    ["GET", `/v1/apps/${b.appId}/journeys/${bJourneyId}`],
    ["POST", `/v1/apps/${b.appId}/journeys/${bJourneyId}/activate`],
    ["GET", `/v1/apps/${b.appId}/credentials`],
    ["GET", `/v1/apps/${b.appId}/message-log`],
    ["GET", `/v1/apps/${b.appId}/settings`],
    ["GET", `/v1/apps/${b.appId}/dashboard`],
    ["GET", `/v1/apps/${b.appId}/usage`],
    ["GET", `/v1/apps/${b.appId}/data/attributes`],
    ["GET", `/v1/apps/${b.appId}/data/ingestion-errors`],
    ["GET", `/v1/apps/${b.appId}/users?q=x`],
    ["POST", `/v1/apps/${b.appId}/segments/preview`, {
      definition: { version: 1, operator: "AND", groups: [] },
    }],
  ];

  let violations = 0;
  for (const [method, path, body] of probes) {
    const r = await req(method, path, { cookie: a.cookie, body });
    const isolated = r.status === 403 || r.status === 404;
    if (!isolated) {
      violations++;
      console.error(`✗ 격리 위반: ${method} ${path} → ${r.status} (403/404 기대)`);
    } else {
      console.log(`✓ ${method} ${path.replace(b.appId, "B_APP")} → ${r.status}`);
    }
  }

  console.log(`\n== 결과: ${probes.length - violations}/${probes.length} 격리, 위반 ${violations} ==`);
  process.exit(violations === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
