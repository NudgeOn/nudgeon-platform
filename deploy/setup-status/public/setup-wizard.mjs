// Slice B — 설치 claim(S1)과 첫 Owner 생성(S2). 서버 상태(/api/v1/bootstrap/status)가 권위다.
//  - 설치 코드는 URL fragment(#token=)로만 오고, 읽자마자 history에서 지운다. 요청 body로만 보낸다.
//  - claim 성공 = HttpOnly Bootstrap cookie(15분). 만료 2분 전에 안내한다.
//  - setup은 Idempotency-Key를 sessionStorage에 두어, 응답이 유실돼도 같은 key로 결과를 다시 받는다.
const $ = (sel) => document.querySelector(sel);
const IDEM_KEY = "nudgeon.setup.idempotency_key";
const DRAFT_KEY = "nudgeon.setup.draft"; // 비밀번호는 저장하지 않는다

const api = async (method, path, { body, headers } = {}) => {
  const res = await fetch(`/api/v1/bootstrap/${path}`, {
    method, cache: "no-store", credentials: "same-origin",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(headers ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 등 */ }
  return { ok: res.ok, status: res.status, json, headers: res.headers };
};
const message = (json, fallback) => (json && (json.message ?? json.error)) ? (Array.isArray(json.message) ? json.message.join(", ") : String(json.message ?? json.error)) : fallback;

let statusCache = null;
let leaseTimer = null;
let leaseExpiresAt = null;
async function extendLease() {
  const r = await api("POST", "extend");
  if (!r.ok) { $("#lease-note").textContent = "연장에 실패했어요. 만료되면 설치 코드를 다시 확인해 주세요(입력한 내용은 비밀번호 빼고 유지)."; return; }
  watchLease(r.headers.get("x-bootstrap-expires-at") ?? new Date(Date.now() + 15 * 60_000).toISOString());
}
function watchLease(expiresAtIso) {
  clearInterval(leaseTimer);
  leaseExpiresAt = expiresAtIso;
  const note = $("#lease-note");
  const tick = () => {
    const left = Math.round((new Date(leaseExpiresAt).getTime() - Date.now()) / 1000);
    if (left <= 0) { note.textContent = "Bootstrap 세션이 만료됐어요. 설치 코드를 다시 확인해 주세요."; clearInterval(leaseTimer); show("claim"); return; }
    if (left <= 120) {
      note.textContent = `⚠ 이 세션은 ${left}초 뒤 만료됩니다. `;
      const b = document.createElement("button"); b.type = "button"; b.className = "text-button"; b.id = "extend-lease"; b.textContent = "15분 연장";
      b.addEventListener("click", extendLease); note.append(b);
    } else {
      note.textContent = `이 브라우저가 설치 lease를 갖고 있어요 (${Math.floor(left / 60)}분 남음).`;
    }
  };
  tick(); leaseTimer = setInterval(tick, 1000);
}

function show(step) {
  for (const id of ["claim", "owner", "secured"]) $(`#${id}`).hidden = id !== step;
}

function saveDraft(form) {
  const d = {}; for (const [k, v] of new FormData(form)) if (k !== "owner_password") d[k] = v;
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
}
function restoreDraft(form) {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "{}");
    for (const [k, v] of Object.entries(d)) if (form.elements[k]) form.elements[k].value = v;
  } catch { /* 초안 없음 */ }
  if (!form.elements.timezone.value) form.elements.timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

async function claim(token) {
  const out = $("#claim-result"); out.className = ""; out.textContent = "확인 중…";
  const r = await api("POST", "claim", { body: { token } });
  if (!r.ok) {
    out.textContent = r.status === 409 ? "다른 브라우저가 설치를 진행 중이에요. 15분 lease가 끝난 뒤 다시 시도하세요."
      : r.status === 410 ? "설치가 이미 완료됐어요. 로그인으로 진행하세요."
      : r.status === 403 ? message(r.json, "localhost에서만 설치할 수 있어요.")
      : r.status === 429 ? "시도가 너무 많아요. 잠시 후 다시."
      : message(r.json, "설치 코드가 올바르지 않아요.");
    return false;
  }
  out.className = "ok"; out.textContent = "확인됐어요.";
  watchLease(r.headers.get("x-bootstrap-expires-at") ?? new Date(Date.now() + 15 * 60_000).toISOString());
  show("owner"); restoreDraft($("#owner-form")); $("#owner-form").elements.workspace_name.focus();
  return true;
}

function renderSecured(json) {
  const dl = $("#secured-keys"); dl.innerHTML = "";
  const rows = [["Workspace", json.tenant_id], ["App ID", json.app_id]];
  if (json.sdk_key) rows.push(["SDK Key (앱에 내장)", json.sdk_key]);
  if (json.server_key) rows.push(["Server Key (백엔드 전용 — 비밀)", json.server_key]);
  if (!json.sdk_key) rows.push(["키", "이전 응답에서 이미 표시됐어요. 콘솔 → 앱 설정 → 키 회전으로 새로 받을 수 있어요."]);
  if (statusCache?.master_key_fingerprint) rows.push(["마스터키 fingerprint", statusCache.master_key_fingerprint]);
  for (const [k, v] of rows) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); }
  sessionStorage.removeItem(DRAFT_KEY);
  show("secured");
}

async function setup(form) {
  const out = $("#owner-result"); out.className = ""; out.textContent = "만드는 중…";
  let idem = sessionStorage.getItem(IDEM_KEY);
  if (!idem) { idem = crypto.randomUUID(); sessionStorage.setItem(IDEM_KEY, idem); }
  const f = form.elements;
  const body = { workspace_name: f.workspace_name.value.trim(), app_name: f.app_name.value.trim(), timezone: f.timezone.value.trim(),
    owner: { name: f.owner_name.value.trim(), email: f.owner_email.value.trim(), password: f.owner_password.value } };
  saveDraft(form);
  let r;
  try { r = await api("POST", "setup", { body, headers: { "Idempotency-Key": idem } }); }
  catch {
    // 응답 유실 — 같은 cookie + key로 결과를 다시 읽는다 (S2 수용 기준)
    r = await api("GET", "setup-result", { headers: { "Idempotency-Key": idem } });
  }
  if (!r.ok) {
    out.textContent = r.status === 410 ? "설치가 이미 완료됐어요. 로그인으로 진행하세요."
      : r.status === 401 ? "Bootstrap 세션이 없거나 만료됐어요. 설치 코드를 다시 확인해 주세요."
      : message(r.json, `실패 (${r.status})`);
    if (r.status === 401) show("claim");
    return;
  }
  clearInterval(leaseTimer);
  renderSecured(r.json);
}

export async function initWizard() {
  // fragment의 설치 코드 → 즉시 history에서 제거
  const m = /(?:^|[#&])token=([A-Za-z0-9._~-]+)/.exec(location.hash);
  if (m) history.replaceState(null, "", location.pathname + location.search);
  const status = await api("GET", "status");
  const st = status.json ?? {};
  statusCache = st;
  const note = $("#install-state-note");
  if (st.mode !== "single_tenant") { note.textContent = "멀티테넌트 모드 — 콘솔 가입으로 시작하세요."; $("#next-step").querySelector("div").insertAdjacentHTML("beforeend", '<p><a class="next-link" href="/signup">콘솔에서 시작하기 →</a></p>'); return; }
  if (st.state === "secured") { note.textContent = "설치가 이미 완료됐어요."; $("#next-step").querySelector("div").insertAdjacentHTML("beforeend", '<p><a class="next-link" href="/login">콘솔 로그인 →</a></p>'); return; }
  if (!st.setup_token_configured) { note.textContent = "setup 토큰이 설정되지 않아 claim할 수 없어요. ./nudgeon setup-token rotate (또는 NUDGEON_SETUP_TOKEN_FILE) 뒤 API를 다시 띄우세요."; return; }
  note.textContent = st.state === "claimed" ? "다른 브라우저가 lease를 갖고 있을 수 있어요. 만료되면 다시 claim할 수 있습니다." : "";
  show("claim");
  $("#claim-form").addEventListener("submit", async (e) => { e.preventDefault(); await claim($("#claim-token").value.trim()); $("#claim-token").value = ""; });
  $("#owner-form").addEventListener("submit", async (e) => { e.preventDefault(); await setup(e.currentTarget); });
  $("#owner-form").addEventListener("input", (e) => saveDraft(e.currentTarget));
  if (m) await claim(m[1]);
}
