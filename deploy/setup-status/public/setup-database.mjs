import { getSetupToken, setSetupToken } from "/setup-wizard.mjs";

const $ = (selector) => document.querySelector(selector);
let pending = false;
export const databaseSetupPending = () => pending;

export function initDatabaseSetup() {
  const section = $("#database-setup"), form = $("#database-form"), password = $("#database-password");
  const result = $("#database-result"), download = $("#download-database-password"), submit = $("#save-database-password");
  const inApp = () => ({ enabled: !!$("#in-app-enabled").checked, campaigns: !!$("#in-app-campaigns").checked,
    origin: $("#content-origin").value.trim(), port: Number($("#content-port").value) });
  for (const id of ["in-app-enabled", "in-app-campaigns", "content-origin", "content-port"]) {
    $("#" + id).addEventListener("input", () => { request = null; $("#in-app-options").hidden = !$("#in-app-enabled").checked; });
  }
  const freezeInApp = (disabled) => { for (const id of ["in-app-enabled", "in-app-campaigns", "content-origin", "content-port"]) $("#"+id).disabled = disabled; };
  let submitted = false, request = null, initialized = false;
  const valid = () => [...password.value].length >= 12 && [...password.value].length <= 128 && !/[\x00-\x1f\x7f]/.test(password.value);
  const update = () => { download.disabled = !valid(); submit.disabled = !valid() || submitted; };
  const generate = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    password.value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    request = null; update();
    result.textContent = "추천 비밀번호를 생성했어요. 파일로 저장하거나 비밀번호 관리자에 보관하세요.";
  };
  $("#generate-database-password").addEventListener("click", generate);
  password.addEventListener("input", () => { request = null; result.textContent = ""; update(); });
  $("#show-database-password").addEventListener("click", (event) => {
    const show = password.type === "password"; password.type = show ? "text" : "password";
    event.currentTarget.textContent = show ? "비밀번호 숨기기" : "비밀번호 보기";
    event.currentTarget.setAttribute("aria-pressed", String(show));
  });
  download.addEventListener("click", () => {
    if (!valid()) return;
    const content = JSON.stringify({ service: "NudgeOn PostgreSQL", username: "nudgeon", database: "nudgeon", password: password.value }, null, 2) + "\n";
    const url = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "nudgeon-postgres-credentials.json";
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    result.textContent = "비밀번호 파일 다운로드를 요청했어요. 파일에는 비밀번호가 포함되니 안전한 곳에 보관하세요.";
  });
  function freeze() {
    submitted = true; freezeInApp(true);
    password.disabled = true;
    $("#database-token").disabled = true;
    $("#generate-database-password").disabled = true;
    submit.disabled = true;
    result.textContent = "비밀번호 설정이 저장됐어요. 설치 명령이 데이터베이스와 서비스를 시작하고 있습니다. 창을 닫았다면 ./nudgeon up을 다시 실행하세요.";
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (!valid() || submitted || submit.disabled) return;
    const token = $("#database-token").value.trim() || getSetupToken();
    if (!token) { result.textContent = "터미널의 설치 코드를 입력해 주세요."; $("#database-token").focus(); return; }
    request ??= { request_id: crypto.randomUUID(), password: password.value, in_app: inApp() };
    submit.disabled = true; password.disabled = true; freezeInApp(true); $("#generate-database-password").disabled = true;
    try {
      const response = await fetch("/setup-status/v1/database", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, token }) });
      if (!response.ok) {
        const json = await response.json();
        result.textContent = json.error === "invalid_in_app" ? "콘솔과 다른 콘텐츠 호스트(HTTPS 또는 로컬 주소)와 1024~65535 포트를 확인해 주세요."
          : json.error === "invalid_token" ? "설치 코드가 올바르지 않습니다. 터미널에서 코드를 확인해 주세요."
          : json.error === "already_submitted" || json.error === "setup_closed" ? "이미 설정이 저장됐거나 설치가 시작됐습니다. 화면을 새로고침해 주세요."
          : json.error === "invalid_password" ? "비밀번호는 12~128자이며 줄바꿈과 제어 문자를 사용할 수 없습니다."
          : json.error === "invalid_origin" ? "터미널에 표시된 localhost 설치 링크로 다시 접속해 주세요."
          : "설정 저장 서비스가 준비되지 않았어요. 터미널에서 ./nudgeon up의 상태를 확인한 뒤 다시 시도해 주세요.";
        if (json.error === "invalid_token") $("#database-token-label").hidden = false;
        return;
      }
      setSetupToken(token); $("#database-token").value = ""; freeze();
    } catch { result.textContent = "연결이 끊겨 저장 결과를 확인하지 못했어요. 같은 버튼을 다시 누르면 같은 요청으로 확인합니다."; }
    finally { if (!submitted) { freezeInApp(false); password.disabled = false; $("#generate-database-password").disabled = false; update(); } }
  });
  async function refresh() {
    try {
      const response = await fetch("/setup-status/v1/database", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const state = await response.json(); pending = state.required; section.hidden = !pending;
      if (!pending) { password.value = ""; $("#database-token").value = ""; request = null; return; }
      if (!initialized) {
        initialized = true; $("#database-token-label").hidden = !!getSetupToken();
        if (state.submitted) { password.value = ""; freeze(); update(); }
        else generate();
      }
      if (state.submitted && !submitted) freeze();
    } catch { /* The setup container is briefly replaced when the runtime starts. */ }
    setTimeout(refresh, 2000);
  }
  void refresh();
}
