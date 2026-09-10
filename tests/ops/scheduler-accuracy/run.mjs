// O-3 스케줄러 기상 정확도: delay 만료 시각(next_wake_at)이 같은 상태 N개가 얼마나 늦게 실행되는가.
// 기준(DEV-sub-03): 1분 delay × 1만 상태, 기상 오차 ±5s p99.
//
// 방법: 격리 테넌트에 message 노드 1개 저니 → 유저 N명 → journey_states N건을 next_wake_at = T0+60s로 삽입 →
// 워커 틱이 실행 → 완료 시각(journey_states.updated_at, moveState가 찍는 now) − T0 − 60s = 지연.
// 발송은 크리덴셜이 없어 failed로 끝난다(측정과 무관). 실행 중인 로컬 스택(워커 포함)이 대상이다.
// 사용: STATES=10000 DELAY_S=60 node tests/ops/scheduler-accuracy/run.mjs
import { execFileSync } from "node:child_process";

const BASE = process.env.API_URL ?? "http://localhost:8080";
const PG = process.env.PG_URL ?? "postgres://nudgeon:nudgeon@127.0.0.1:5433/nudgeon";
const N = Number(process.env.STATES ?? 10000);
const DELAY_S = Number(process.env.DELAY_S ?? 60);
const psql = (sql) => execFileSync("psql", [PG, "-Atc", sql], { encoding: "utf8" }).trim();
async function req(method, p, { cookie, body } = {}) {
  const r = await fetch(`${BASE}${p}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let json; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json, setCookie: r.headers.get("set-cookie") };
}
function ok(c, m) { if (!c) { console.error("✗", m); process.exitCode = 1; throw new Error(m); } console.log("✓", m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const s = await req("POST", "/v1/auth/signup", { body: { email: `sched-${Date.now()}@example.com`, password: "password123", name: "sched", tenant_name: "scheduler-accuracy" } });
  ok(s.status === 201 || s.status === 200, `signup ${s.status}`);
  const cookie = s.setCookie.split(";")[0]; const { app_id: appId, tenant_id: tenantId } = s.json;
  const j = await req("POST", `/v1/apps/${appId}/journeys`, { cookie, body: { name: "O-3", definition: {
    entry: { type: "trigger", trigger_event: "x" }, nodes: [{ type: "message", push: { title: "t", body: "b" } }], exit: {}, settings: { category: "transactional", reentry: "always" } } } });
  ok(j.status === 201, `저니 ${j.status}`);
  const journeyId = j.json.id;
  const act = await req("POST", `/v1/apps/${appId}/journeys/${journeyId}/activate`, { cookie, body: { revision: j.json.revision } });
  ok(act.status === 200 || act.status === 201, `활성화 ${act.status}`);
  const version = Number(psql(`SELECT active_version FROM journeys WHERE id='${journeyId}'`));

  // 유저 N명 + 디바이스(발송 fan-out 대상이 있어야 message 노드가 실제 경로를 탄다)
  psql(`INSERT INTO users (tenant_id, app_id, external_id, std_attrs, custom_attrs, subscriptions, status)
        SELECT '${tenantId}','${appId}','u-'||g,'{}'::jsonb,'{}'::jsonb,'{"push":"opted_in"}'::jsonb,'active' FROM generate_series(1,${N}) g`);
  psql(`INSERT INTO devices (tenant_id, app_id, user_id, platform, push_token, os_permission)
        SELECT '${tenantId}','${appId}',id,'android','tok-'||id,'granted' FROM users WHERE app_id='${appId}'`);
  // 모두 같은 기상 시각 T0+DELAY — DB 서버 시계 기준(워커도 같은 호스트 docker 시계)
  const t0 = psql(`SELECT now()`);
  psql(`INSERT INTO journey_states (tenant_id, app_id, journey_id, journey_version, user_id, current_node, status, next_wake_at)
        SELECT '${tenantId}','${appId}','${journeyId}',${version},id,0,'waiting', '${t0}'::timestamptz + interval '${DELAY_S} seconds' FROM users WHERE app_id='${appId}'`);
  ok(Number(psql(`SELECT count(*) FROM journey_states WHERE journey_id='${journeyId}'`)) === N, `상태 ${N}건, 기상 = T0+${DELAY_S}s`);

  const started = Date.now();
  for (;;) {
    const left = Number(psql(`SELECT count(*) FROM journey_states WHERE journey_id='${journeyId}' AND status<>'completed'`));
    if (left === 0) break;
    if (Date.now() - started > (DELAY_S + 600) * 1000) throw new Error(`timeout: ${left} states not completed`);
    await sleep(2000);
  }
  // 지연 = 완료 시각 − 기상 시각
  const stats = psql(`SELECT
      round(percentile_cont(0.5) within group (order by d)::numeric,2),
      round(percentile_cont(0.95) within group (order by d)::numeric,2),
      round(percentile_cont(0.99) within group (order by d)::numeric,2),
      round(max(d)::numeric,2), round(min(d)::numeric,2)
    FROM (SELECT extract(epoch from (updated_at - ('${t0}'::timestamptz + interval '${DELAY_S} seconds'))) d
          FROM journey_states WHERE journey_id='${journeyId}') x`).split("|").map(Number);
  const [p50, p95, p99, max, min] = stats;
  const result = { states: N, delay_s: DELAY_S, wake_lag_seconds: { p50, p95, p99, max, min }, gate_p99_le_5s: p99 <= 5, measured_at: new Date().toISOString() };
  console.log(JSON.stringify(result, null, 2));
  ok(min >= -1, `기상 전에 실행된 상태 없음 (min ${min}s)`);
  if (p99 <= 5) console.log(`✓ O-3: p99 ${p99}s ≤ 5s`); else console.log(`✗ O-3: p99 ${p99}s > 5s (기준 미달)`);
  if (p99 > 5) process.exitCode = 1;
};
main().catch((e) => { console.error(e.message); process.exit(1); });
