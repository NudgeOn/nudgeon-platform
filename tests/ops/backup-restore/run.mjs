// I-6 백업·복구 리허설: 실행 중 스택을 scripts/backup.sh로 백업 → 포트만 바꾼 별도 compose 프로젝트(빈 볼륨)에
// 마이그레이션 → scripts/restore.sh → 원본과 대조(PG 테이블별 행 수, CH 테이블별 행 수·MV 합계, Redis 키 수,
// 원본에서 만든 세션 쿠키로 복원 API 호출, 복원 워커가 같은 마스터키로 크리덴셜을 복호화·재검증).
//
// 전제: 원본 스택 docker compose --profile full --profile app 기동, deploy/.env의 NUDGEON_MASTER_KEY.
// 사용: node tests/ops/backup-restore/run.mjs   (KEEP=1이면 복원 스택을 남긴다)
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SRC = { api: "http://127.0.0.1:8080", pg: "postgres://nudgeon:nudgeon@127.0.0.1:5433/nudgeon", ch: "http://127.0.0.1:8123", redis: "nudgeon-redis-1",
  containers: { PG_CONTAINER: "nudgeon-postgres-1", CH_CONTAINER: "nudgeon-clickhouse-1", REDIS_CONTAINER: "nudgeon-redis-1" } };
const DST = { project: "nudgeon-restore", api: "http://127.0.0.1:28080", pg: "postgres://nudgeon:nudgeon@127.0.0.1:25433/nudgeon", ch: "http://127.0.0.1:28123", redis: "nudgeon-restore-redis-1",
  containers: { PG_CONTAINER: "nudgeon-restore-postgres-1", CH_CONTAINER: "nudgeon-restore-clickhouse-1", REDIS_CONTAINER: "nudgeon-restore-redis-1" } };
const COMPOSE = ["compose", "-p", DST.project, "-f", "deploy/compose.yaml", "-f", "tests/ops/backup-restore/compose.ports.yaml", "--env-file", "deploy/.env", "--profile", "full", "--profile", "app"];
const CH_AUTH = "Basic " + Buffer.from("nudgeon:nudgeon").toString("base64");

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const psql = (url, sql) => sh("psql", [url, "-Atc", sql]);
async function ch(base, sql) {
  const r = await fetch(`${base}/?database=nudgeon`, { method: "POST", headers: { authorization: CH_AUTH }, body: sql });
  const t = await r.text();
  if (!r.ok) throw new Error(`CH ${r.status}: ${t}`);
  return t.trim();
}
async function req(base, method, p, { cookie, body } = {}) {
  const r = await fetch(`${base}${p}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let json; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json, setCookie: r.headers.get("set-cookie") };
}
function ok(cond, msg) { if (!cond) { console.error("✗", msg); process.exitCode = 1; throw new Error(msg); } console.log("✓", msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, tries = 120, every = 1000) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error(`timeout: ${label}`);
}
const lap = (t0) => Math.round((Date.now() - t0) / 1000);

const main = async () => {
  const result = { startedAt: new Date().toISOString() };
  // ── 0. 원본에 "복원 뒤에도 살아 있어야 할" 표식: 세션 쿠키 + 저니 하나
  const s = await req(SRC.api, "POST", "/v1/auth/signup", { body: { email: `restore-${Date.now()}@example.com`, password: "password123", name: "restore", tenant_name: "restore-rehearsal" } });
  ok(s.status === 201 || s.status === 200, `원본 signup ${s.status}`);
  const cookie = s.setCookie.split(";")[0];
  const { app_id: appId, tenant_id: tenantId } = s.json;
  const j = await req(SRC.api, "POST", `/v1/apps/${appId}/journeys`, { cookie, body: { name: "restore marker", definition: {
    entry: { type: "trigger", trigger_event: "x" }, nodes: [{ type: "message", push: { title: "t", body: "b" } }], exit: {}, settings: { category: "transactional", reentry: "always" } } } });
  ok(j.status === 201, `원본 저니 생성 ${j.status}`);
  await sleep(1500); // CH 비동기 적재 여유

  // ── 1. 원본 인벤토리
  const pgTables = psql(SRC.pg, `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`).split("\n").filter(Boolean);
  const pgCount = (url) => Object.fromEntries(pgTables.map((t) => [t, Number(psql(url, `SELECT count(*) FROM "${t}"`))]));
  // 행 수 대조는 원본 테이블만. MV 대상(usage_*)은 복원 시 MV가 다시 채우고 파트 병합 상태에 따라 행 수가 달라
  // 집계값(FINAL 행 수·합계)으로 대조한다.
  const mvTargets = (await ch(SRC.ch, `SELECT extract(create_table_query, 'TO [a-z_]+\\.([a-z_]+)') FROM system.tables WHERE database='nudgeon' AND engine='MaterializedView' FORMAT TSVRaw`)).split("\n").filter(Boolean);
  const chTables = (await ch(SRC.ch, `SELECT name FROM system.tables WHERE database='nudgeon' AND engine NOT LIKE '%MaterializedView%' ORDER BY name FORMAT TSVRaw`)).split("\n").filter((t) => t && !mvTargets.includes(t));
  const chCount = async (base) => { const o = {}; for (const t of chTables) o[t] = Number(await ch(base, `SELECT count() FROM ${t}`)); return o; };
  // MV 대상은 "원본 테이블에서 다시 계산한 값"과 같은지 본다. 복원은 MV를 다시 태우므로 복원 쪽은 항상 일치해야
  // 하고, 원본 쪽 불일치는 원본에서 message_log가 지워진 뒤 MV가 남은 드리프트다(정보로 기록).
  const mvConsistency = async (base) => {
    const fromLog = await ch(base, `SELECT toDate(sent_at) d, channel, status, count() n FROM message_log GROUP BY d, channel, status ORDER BY d, channel, status FORMAT TSV`);
    const fromMv = await ch(base, `SELECT day, channel, status, sum(sends) n FROM usage_sends_daily GROUP BY day, channel, status ORDER BY day, channel, status FORMAT TSV`);
    const a = new Set(fromLog.split("\n")), b = new Set(fromMv.split("\n"));
    const onlyMv = [...b].filter((x) => x && !a.has(x)), onlyLog = [...a].filter((x) => x && !b.has(x));
    return { consistent: onlyMv.length === 0 && onlyLog.length === 0, mv_rows_without_log: onlyMv, log_rows_without_mv: onlyLog, sends_sum: Number(await ch(base, `SELECT sum(sends) FROM usage_sends_daily`)) };
  };
  const chSums = mvConsistency;
  const srcPg = pgCount(SRC.pg), srcCh = await chCount(SRC.ch), srcSums = await chSums(SRC.ch);
  const srcRedis = Number(sh("docker", ["exec", SRC.redis, "redis-cli", "DBSIZE"]));
  const srcCreds = Number(psql(SRC.pg, `SELECT count(*) FROM credentials WHERE status='verified'`));

  // ── 2. 백업
  const dir = mkdtempSync(path.join(tmpdir(), "nudgeon-backup-"));
  let t0 = Date.now();
  sh("bash", ["scripts/backup.sh", dir], { env: { ...process.env, ...SRC.containers } });
  result.backup_seconds = lap(t0);
  result.backup = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  console.log(`  backup ${result.backup_seconds}s → ${dir}`);

  // ── 3. 빈 복원 스택 (새 프로젝트·새 볼륨·다른 포트) — 마이그레이션까지
  t0 = Date.now();
  try { sh("docker", [...COMPOSE, "down", "-v", "--remove-orphans"]); } catch {}
  sh("docker", [...COMPOSE, "up", "-d", "--no-build", "postgres", "clickhouse", "redis", "migrator"]);
  await until(async () => { try { return psql(DST.pg, "SELECT count(*) FROM schema_migrations") !== "" ? true : null; } catch { return null; } }, "복원 스택 migrator");
  // migrator는 service_completed_successfully — 종료 코드 확인
  await until(() => { const st = sh("docker", ["inspect", `${DST.project}-migrator-1`, "--format", "{{.State.Status}}/{{.State.ExitCode}}"]); return st === "exited/0" ? st : null; }, "migrator exit 0");
  result.empty_stack_seconds = lap(t0);
  // 개발 compose는 빈 볼륨 첫 기동 때 seed.dev.sql(Dev Tenant 1개)을 넣는다. 복원은 DROP SCHEMA로 시작하므로 무관하다.
  const preTenants = psql(DST.pg, "SELECT string_agg(name, ',') FROM tenants");
  ok(!preTenants || preTenants === "Dev Tenant", `복원 스택 PG는 dev seed만 있다 (${preTenants || "없음"})`);
  ok(Number(await ch(DST.ch, "SELECT count() FROM message_log")) === 0, "복원 스택 CH가 비어 있다");

  // ── 4. 복원
  t0 = Date.now();
  sh("bash", ["scripts/restore.sh", dir], { env: { ...process.env, ...DST.containers } });
  result.restore_seconds = lap(t0);
  console.log(`  restore ${result.restore_seconds}s`);

  // ── 5. api·worker 기동 (같은 deploy/.env → 같은 NUDGEON_MASTER_KEY)
  t0 = Date.now();
  sh("docker", [...COMPOSE, "up", "-d", "--no-build", "api", "worker"]);
  await until(async () => { try { const r = await fetch(`${DST.api}/healthz`); return r.ok ? true : null; } catch { return null; } }, "복원 api healthz");
  result.rto_seconds_total = result.empty_stack_seconds + result.restore_seconds + lap(t0);

  // ── 6. 대조
  const dstPg = pgCount(DST.pg), dstCh = await chCount(DST.ch), dstSums = await chSums(DST.ch);
  const dstRedis = Number(sh("docker", ["exec", DST.redis, "redis-cli", "DBSIZE"]));
  const pgDiff = pgTables.filter((t) => srcPg[t] !== dstPg[t]).map((t) => `${t}: ${srcPg[t]}→${dstPg[t]}`);
  const chDiff = chTables.filter((t) => srcCh[t] !== dstCh[t]).map((t) => `${t}: ${srcCh[t]}→${dstCh[t]}`);
  result.pg_tables = pgTables.length; result.pg_rows = Object.values(srcPg).reduce((a, b) => a + b, 0);
  result.ch_tables = chTables.length; result.ch_rows = Object.values(srcCh).reduce((a, b) => a + b, 0);
  result.redis_keys = { source: srcRedis, restored: dstRedis };
  result.mv = { source: srcSums, restored: dstSums };
  ok(pgDiff.length === 0, `PG ${pgTables.length}개 테이블 행 수 일치 (${result.pg_rows}행)${pgDiff.length ? " — " + pgDiff.join(", ") : ""}`);
  ok(chDiff.length === 0, `CH ${chTables.length}개 테이블 행 수 일치 (${result.ch_rows}행)${chDiff.length ? " — " + chDiff.join(", ") : ""}`);
  ok(dstSums.consistent, `복원 계측 MV(${mvTargets.join(", ")})가 복원 message_log와 정확히 일치 (sum ${dstSums.sends_sum}; 덤프가 아니라 MV가 다시 채웠다)`);
  if (!srcSums.consistent) console.log(`⚠ 원본 MV 드리프트(원본에서 message_log가 지워진 뒤 남은 집계): ${JSON.stringify(srcSums.mv_rows_without_log)} — 복원본이 더 정확하다`);
  ok(dstRedis === srcRedis, `Redis 키 ${dstRedis} == ${srcRedis}`);

  // 원본에서 만든 세션 쿠키가 복원 API에서 그대로 통한다 — sessions·members·tenants가 함께 왔다는 증거
  const me = await req(DST.api, "GET", `/v1/apps/${appId}/journeys`, { cookie });
  ok(me.status === 200 && JSON.stringify(me.json).includes("restore marker"), `원본 세션 쿠키로 복원 API 호출 → ${me.status}, 저니 보임`);
  // 크리덴셜: 같은 마스터키로 복호화·재검증 — 복원 워커의 verifier가 status를 유지/갱신한다
  const creds = await until(async () => {
    const n = Number(psql(DST.pg, `SELECT count(*) FROM credentials WHERE status='verified'`));
    return n >= srcCreds ? n : null;
  }, "복원 크리덴셜 verified 유지", 60);
  ok(creds >= srcCreds, `verified 크리덴셜 ${creds} >= 원본 ${srcCreds} (마스터키 복호화 OK)`);
  const bad = sh("docker", ["logs", `${DST.project}-worker-1`], { stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter((l) => l.includes("복호") && l.includes("ERROR")).length;
  ok(bad === 0, `복원 워커 로그에 복호화 오류 ${bad}건`);

  result.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(path.join(dir, "rehearsal-result.json"), JSON.stringify(result, null, 2));
  console.log("\nBACKUP/RESTORE REHEARSAL (I-6): PASS");
  if (process.env.KEEP !== "1") { sh("docker", [...COMPOSE, "down", "-v", "--remove-orphans"]); execSync(`rm -rf "${dir}"`); }
  else console.log(`  kept: stack ${DST.project}, backup ${dir}`);
};
main().catch((e) => { console.error(e.message); process.exit(1); });
