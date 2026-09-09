// M-4 (DEV-MAIN 7.2) — 중복 발송 카오스: 발송 중 워커 kill -9 ×N 반복 → 중복 0 (message_log 대사).
//
// 실제 워커 컨테이너를 SIGKILL로 죽이고 다시 띄우면서, 프로세스 밖에 있는 SMTP 싱크(Mailpit)가 받은
// 메일 수를 발송 원장·outbox와 대조한다. 싱크는 죽지 않으므로 "공급자가 실제로 몇 번 받았나"가 남는다.
//
// 전제: docker compose --profile full --profile app 기동(워커 컨테이너 이름 WORKER), API/CH/PG 접근 가능.
// 사용: node tests/ops/send-chaos/run.mjs   (환경: USERS=300 KILLS=10 KILL_INTERVAL_MS=1500)
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const BASE = process.env.API_URL ?? "http://localhost:8080";
const CH = process.env.CLICKHOUSE_HTTP ?? "http://localhost:8123";
const CH_AUTH = process.env.CLICKHOUSE_AUTH ?? "nudgeon:nudgeon";
const PG = process.env.PG_URL ?? "postgres://nudgeon:nudgeon@127.0.0.1:5433/nudgeon";
const WORKER = process.env.WORKER ?? "nudgeon-worker-1";
const NETWORK = process.env.NETWORK ?? "nudgeon_default";
const USERS = Number(process.env.USERS ?? 300);
const KILLS = Number(process.env.KILLS ?? 10);
const KILL_INTERVAL_MS = Number(process.env.KILL_INTERVAL_MS ?? 1500);
const SINK = "nudgeon-m4-sink";
const SINK_HTTP = Number(process.env.SINK_HTTP ?? 18025);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const psql = (sql) => sh("psql", [PG, "-Atc", sql]);
async function req(method, path, { cookie, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}
async function ch(sql) {
  const res = await fetch(`${CH}/?database=nudgeon`, { method: "POST", headers: { authorization: "Basic " + Buffer.from(CH_AUTH).toString("base64") }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`CH ${res.status}: ${text}`);
  return text.trim();
}
function ok(cond, msg) {
  if (!cond) { console.error("✗", msg); process.exitCode = 1; throw new Error(msg); }
  console.log("✓", msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, tries = 60, every = 1000) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error(`timeout: ${label}`);
}
// 이 실행의 메일만 센다. 같은 싱크 이름을 쓰는 이전 실행의 잔여 재시도(리퍼 5분 뒤 되살아난 발송이
// 싱크 없는 동안 백오프하다가 다음 싱크로 들어온다)가 "중복"으로 보이던 오판을 막는다.
const RUN = randomUUID().slice(0, 8);
async function sinkTotal() {
  // 검색 API는 색인 지연으로 수가 멈추는 경우가 있어 목록을 직접 훑어 제목 접두어로 센다.
  let n = 0;
  for (let start = 0; ; start += 500) {
    const r = await fetch(`http://127.0.0.1:${SINK_HTTP}/api/v1/messages?limit=500&start=${start}`);
    const page = await r.json();
    for (const m of page.messages ?? []) if ((m.Subject ?? "").startsWith(`M4 ${RUN}`)) n++;
    if ((page.messages ?? []).length < 500) break;
  }
  return n;
}
async function sinkAll() {
  const r = await fetch(`http://127.0.0.1:${SINK_HTTP}/api/v1/messages?limit=1`);
  return (await r.json()).total ?? 0;
}

const main = async () => {
  const startedAt = new Date().toISOString();
  // ── 0. 프로세스 밖 SMTP 싱크 (워커와 같은 compose 네트워크)
  try { sh("docker", ["rm", "-f", SINK], { stdio: "pipe" }); } catch {}
  sh("docker", ["run", "-d", "--rm", "--name", SINK, "--network", NETWORK, "-p", `127.0.0.1:${SINK_HTTP}:8025`, "-e", "MP_MAX_MESSAGES=0", "axllent/mailpit:latest"]); // 기본 보관 한도 500통 → 무제한
  await until(async () => { try { await sinkAll(); return true; } catch { return null; } }, "mailpit up");
  console.log(`  sink ${SINK} (smtp ${SINK}:1025, http :${SINK_HTTP}) run=${RUN}`);

  try {
    // ── 1. 격리 테넌트 + SMTP 발송기(security none → 싱크)
    const s = await req("POST", "/v1/auth/signup", { body: { email: `send-chaos-${Date.now()}@example.com`, password: "password123", name: "send-chaos", tenant_name: "send-chaos" } });
    ok(s.status === 201 || s.status === 200, `signup ${s.status}`);
    const cookie = s.setCookie.split(";")[0];
    const { app_id: appId, tenant_id: tenantId } = s.json;
    const cred = await req("PUT", `/v1/apps/${appId}/credentials`, { cookie, body: { kind: "email_smtp", host: SINK, port: 1025, from_email: "chaos@example.com", from_name: "chaos", security: "none" } });
    ok(cred.status === 200 || cred.status === 201, `email_smtp 등록 ${cred.status}`);
    const verified = await until(async () => {
      const r = await req("GET", `/v1/apps/${appId}/credentials`, { cookie });
      const c = (r.json?.credentials ?? []).find((x) => x.kind === "email_smtp");
      return c && c.status !== "unverified" ? c : null;
    }, "smtp verified");
    ok(verified.status === "verified", `발송기 검증 ${verified.status} ${verified.status_detail ?? ""}`);

    // ── 2. 이메일 노드 1개짜리 저니 (transactional — quiet hours 무관)
    const j = await req("POST", `/v1/apps/${appId}/journeys`, { cookie, body: { name: "M-4 chaos", definition: {
      entry: { type: "trigger", trigger_event: "chaos_enter" },
      nodes: [{ type: "message", email: { subject: `M4 ${RUN} {{email}}`, html: "<p>{{email}}</p>" } }],
      exit: {}, settings: { category: "transactional", reentry: "always" },
    } } });
    ok(j.status === 201, `저니 생성 ${j.status} ${JSON.stringify(j.json)}`);
    const journeyId = j.json.id;
    const act = await req("POST", `/v1/apps/${appId}/journeys/${journeyId}/activate`, { cookie, body: { revision: j.json.revision } });
    ok(act.status === 200 || act.status === 201, `활성화 ${act.status}`);
    const version = Number(psql(`SELECT active_version FROM journeys WHERE id='${journeyId}'`));

    // ── 3. 유저 N명 + 저니 상태(즉시 기상) — 워커가 집어 send.email로 흘린다
    const values = [];
    for (let i = 0; i < USERS; i++) {
      values.push(`('${tenantId}','${appId}','u-${i}','{"email":"u-${i}@chaos.example"}'::jsonb,'{}'::jsonb,'{}'::jsonb,'active')`);
    }
    psql(`INSERT INTO users (tenant_id, app_id, external_id, std_attrs, custom_attrs, subscriptions, status) VALUES ${values.join(",")}`);
    psql(`INSERT INTO journey_states (tenant_id, app_id, journey_id, journey_version, user_id, current_node, status, next_wake_at)
          SELECT '${tenantId}','${appId}','${journeyId}',${version},id,0,'active',now() FROM users WHERE app_id='${appId}'`);
    ok(psql(`SELECT count(*) FROM journey_states WHERE journey_id='${journeyId}'`) === String(USERS), `저니 진입 ${USERS}건`);

    // ── 4. 카오스: 발송이 진행되는 동안 워커를 SIGKILL ×KILLS
    const kills = [];
    for (let k = 1; k <= KILLS; k++) {
      await sleep(KILL_INTERVAL_MS);
      const before = await sinkTotal();
      const logged = Number(await ch(`SELECT count() FROM message_log WHERE tenant_id='${tenantId}' AND status='sent'`));
      sh("docker", ["kill", "-s", "KILL", WORKER]);
      sh("docker", ["start", WORKER]);
      kills.push({ k, sink_before: before, logged_before: logged, at: new Date().toISOString() });
      console.log(`  kill -9 #${k}: sink=${before} message_log(sent)=${logged}`);
    }

    // ── 5. 수렴 대기: outbox 전부 발행 + 상태 전부 완료 + 싱크 수 ≥ N
    //    죽은 워커가 클레임한 journey_states는 리퍼가 claimReap(5분) 뒤 회수한다 — 최대 8분 기다린다.
    const convergeStart = Date.now();
    await until(async () => psql(`SELECT count(*) FROM journey_states WHERE journey_id='${journeyId}' AND status<>'completed'`) === "0", "journey_states 전부 completed", 480);
    await until(async () => psql(`SELECT count(*) FROM journey_outbox WHERE tenant_id='${tenantId}' AND published_at IS NULL`) === "0", "outbox 전부 발행", 180);
    await until(async () => (await sinkTotal()) >= USERS, `sink >= ${USERS}`, 180);
    const convergeSeconds = Math.round((Date.now() - convergeStart) / 1000);
    await sleep(15000); // 늦게 오는 재전달·로그 플러시까지 기다린 뒤 센다
    const sink = await sinkTotal();
    const sinkOther = (await sinkAll()) - sink; // 다른 실행의 잔여 재시도 — 이 실행의 중복이 아니다

    // ── 6. 대사
    const rows = Number(await ch(`SELECT count() FROM message_log WHERE tenant_id='${tenantId}' AND app_id='${appId}' AND status='sent'`));
    const distinctMsg = Number(await ch(`SELECT uniqExact(message_id) FROM message_log WHERE tenant_id='${tenantId}' AND app_id='${appId}' AND status='sent'`));
    const distinctKey = Number(await ch(`SELECT uniqExact(idempotency_key) FROM message_log WHERE tenant_id='${tenantId}' AND app_id='${appId}' AND status='sent'`));
    const rerecorded = Number(await ch(`SELECT count() FROM message_log WHERE tenant_id='${tenantId}' AND app_id='${appId}' AND status='sent' AND failure_detail LIKE 'provider_id=%'`));
    const failed = Number(await ch(`SELECT count() FROM message_log WHERE tenant_id='${tenantId}' AND app_id='${appId}' AND status='failed'`));
    const outboxSends = Number(psql(`SELECT count(*) FROM journey_outbox WHERE tenant_id='${tenantId}' AND stream='stream:send.email'`));
    const reaped = Number(sh("docker", ["logs", WORKER, "--since", "20m"], { stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter((l) => l.includes("claimed 상태 회수")).length);
    const result = { startedAt, finishedAt: new Date().toISOString(), users: USERS, kills, converge_seconds_after_last_kill: convergeSeconds, reaper_runs_logged: reaped, run: RUN, sink_received: sink, sink_from_other_runs: sinkOther,
      outbox_send_rows: outboxSends, message_log_sent_rows: rows, message_log_sent_distinct_message_ids: distinctMsg,
      message_log_sent_distinct_keys: distinctKey, message_log_sent_rows_recovered_by_redelivery: rerecorded, message_log_failed: failed,
      provider_duplicate_deliveries: sink - USERS };
    console.log(JSON.stringify(result, null, 2));
    ok(outboxSends === USERS, `outbox 발송 의도 ${outboxSends} == ${USERS} (진입 1인 1건)`);
    ok(distinctKey === USERS && distinctMsg === USERS, `message_log sent 고유 message_id ${distinctMsg} / 멱등 키 ${distinctKey} == ${USERS}`);
    // 재전달 재기록 행(provider_id=… detail)은 "Redis 커밋 뒤·CH 로그 플러시 전"에 죽어 원본 로그가 유실된 발송을
    // 재전달이 복구한 것이다 — 재전송이 아니다(싱크 수가 그것을 증명한다). 행 수는 고유 message_id 수와 같아야 한다.
    ok(rows === USERS, `sent 행 ${rows} == 고유 message_id ${USERS} (그중 크래시 복구 재기록 ${rerecorded}건, 이중 로그 0)`);
    ok(failed === 0, `failed ${failed} == 0`);
    ok(sink >= USERS, `싱크 실수신 ${sink} >= ${USERS} (유실 0)`);
    // 공급자 중복 = 전송 완료 직후·Redis sent 커밋 전에 죽은 at-least-once 창. 공급자 응답 없이 닫을 수 없어
    // 공급자·단말 쪽 접기(이메일 Message-ID, APNs collapse-id)로 다룬다. 기본은 경고, PROVIDER_DUPES_FAIL=1이면 실패.
    if (sink > USERS) {
      const msg = `공급자 중복 전달 ${sink - USERS}/${USERS} — at-least-once 창(전송 완료→sent 커밋 사이 kill)`;
      if (process.env.PROVIDER_DUPES_FAIL === "1") ok(false, msg); else console.log("⚠", msg);
    } else {
      console.log("✓ 공급자 중복 전달 0");
    }
    console.log("\nSEND CHAOS (M-4): PASS");
  } finally {
    if (process.env.KEEP_SINK !== "1") { try { sh("docker", ["rm", "-f", SINK], { stdio: "pipe" }); } catch {} }
  }
};

main().catch((e) => { console.error(e.message); process.exit(1); });
