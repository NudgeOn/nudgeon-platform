const componentNames = Object.freeze({
  postgres: "PostgreSQL",
  redis: "Redis",
  clickhouse: "ClickHouse",
  api: "API",
  worker: "Worker",
  console: "Console",
});

const knownComponents = new Set(Object.keys(componentNames));
const knownStates = new Set(["starting", "ready", "waiting", "blocked"]);
const knownCodes = new Set([
  "UNKNOWN",
  "TCP_OK",
  "TCP_TIMEOUT",
  "TCP_ERROR",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ABORTERROR",
  "TIMEOUTERROR",
  "TYPEERROR",
  "HTTP_ERROR",
]);

const defaultWaitingHelp = Object.freeze({
  postgres: "앱의 기본 데이터를 보관하는 PostgreSQL이 시작되는 중이에요.",
  redis: "빠른 처리를 돕는 Redis가 시작되는 중이에요.",
  clickhouse: "분석 데이터를 보관하는 ClickHouse가 시작되는 중이에요.",
  api: "NudgeOn의 핵심 기능인 API가 시작되는 중이에요.",
  worker: "백그라운드 작업을 처리하는 Worker가 시작되는 중이에요.",
  console: "설정을 관리할 Console 화면이 시작되는 중이에요.",
});

const readyHelp = Object.freeze({
  postgres: "앱의 기본 데이터 저장소가 정상적으로 연결됐어요.",
  redis: "빠른 처리용 저장소가 정상적으로 연결됐어요.",
  clickhouse: "분석 데이터 저장소가 정상적으로 연결됐어요.",
  api: "NudgeOn의 핵심 기능이 요청을 받을 준비가 됐어요.",
  worker: "백그라운드 작업을 처리할 준비가 됐어요.",
  console: "설정을 관리할 화면이 준비됐어요.",
});

function normalizedComponentName(value) {
  const name = String(value ?? "").toLowerCase();
  return knownComponents.has(name) ? name : "unknown";
}

function normalizedState(value) {
  const state = String(value ?? "").toLowerCase();
  return knownStates.has(state) ? state : "waiting";
}

function normalizedCode(value) {
  const code = String(value ?? "").toUpperCase();
  if (knownCodes.has(code) || /^HTTP_[1-5][0-9]{2}$/.test(code)) return code;
  return "UNKNOWN";
}

function normalizedSchemaVersion(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 999 ? number : 1;
}

function normalizedVersion(value) {
  const version = String(value ?? "");
  if (version === "development") return version;
  return /^v?[0-9]+(?:\.[0-9]+){1,3}(?:-[a-z0-9][a-z0-9.-]{0,31})?$/i.test(version)
    ? version
    : "unknown";
}

function normalizedCheckedAt(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizedLatency(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 300_000
    ? Math.round(number)
    : null;
}

/**
 * Returns beginner-friendly help without echoing untrusted component values.
 */
export function componentHelp(component = {}) {
  const name = normalizedComponentName(component.name);
  const state = normalizedState(component.state);
  const code = normalizedCode(component.code);
  const displayName = componentNames[name] ?? "이 서비스";

  if (state === "ready") {
    return readyHelp[name] ?? "이 서비스는 정상적으로 준비됐어요.";
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `${displayName}의 위치를 아직 찾지 못했어요. Docker가 서비스를 연결하는 중일 수 있어요.`;
  }
  if (code === "ECONNREFUSED") {
    return `${displayName} 서비스가 아직 연결을 받을 준비가 되지 않았어요.`;
  }
  if (code === "TCP_TIMEOUT" || code === "ETIMEDOUT" || code === "TIMEOUTERROR") {
    return `${displayName}의 응답이 평소보다 늦어지고 있어요.`;
  }
  if (code === "HTTP_503") {
    return `${displayName} 서비스는 켜졌지만 내부 준비 확인을 아직 통과하지 못했어요.`;
  }
  if (code === "HTTP_502") {
    return `${displayName} 서비스가 아직 정상 응답을 보내지 못하고 있어요.`;
  }
  if (state === "blocked") {
    return `${displayName} 서비스는 켜졌지만 준비를 마치지 못했어요.`;
  }

  return defaultWaitingHelp[name] ?? "이 서비스가 시작되는 중이에요.";
}

/**
 * Builds a small set of safe, reversible recovery steps for the current state.
 */
export function recoveryActions(status = {}, { connectionFailed = false } = {}) {
  if (connectionFailed) {
    return [
      "10초 뒤 ‘다시 확인’을 눌러 주세요.",
      "계속 같다면 NudgeOn 폴더의 터미널에서 `./nudgeon status`를 실행해 주세요.",
      "Docker 설정 확인은 `./nudgeon doctor`로 할 수 있어요.",
      "설치 화면 기록은 `./nudgeon logs setup-status`로 확인할 수 있어요.",
    ];
  }

  const diagnostic = safeDiagnostic(status);
  if (diagnostic.state === "ready") {
    return ["서버 실행 준비가 끝났어요. 관리자 계정과 실제 발송은 다음 설치 단계에서 이어집니다."];
  }

  const firstProblem = diagnostic.components.find((component) => component.state === "blocked")
    ?? diagnostic.components.find((component) => component.state !== "ready");
  const logAction = firstProblem
    ? `원인이 된 서비스의 최근 기록은 \`./nudgeon logs ${firstProblem.name}\`로 확인할 수 있어요.`
    : "전체 서비스의 최근 기록은 `./nudgeon logs`로 확인할 수 있어요.";

  if (diagnostic.state === "blocked") {
    return [
      "NudgeOn 폴더의 터미널에서 `./nudgeon status`를 실행해 준비되지 않은 서비스를 확인해 주세요.",
      logAction,
      "비밀번호를 바꾸거나 Docker 볼륨을 삭제하지 마세요. 먼저 상태와 기록만 확인해 주세요.",
    ];
  }

  return [
    "30초 정도 기다린 뒤 ‘다시 확인’을 눌러 주세요.",
    "계속 같다면 NudgeOn 폴더의 터미널에서 `./nudgeon status`를 실행해 주세요.",
    logAction,
  ];
}

/**
 * Copies only the explicitly allowed setup fields. It never spreads source data.
 */
export function safeDiagnostic(status = {}) {
  const inputComponents = Array.isArray(status.components) ? status.components : [];
  const seenComponents = new Set();
  const components = inputComponents
    .filter((component) => {
      const name = normalizedComponentName(component?.name);
      if (!knownComponents.has(name) || seenComponents.has(name)) return false;
      seenComponents.add(name);
      return true;
    })
    .slice(0, knownComponents.size)
    .map((component) => ({
      name: normalizedComponentName(component.name),
      state: normalizedState(component.state),
      code: normalizedCode(component.code),
      latency_ms: normalizedLatency(component.latency_ms),
    }));

  const requestedState = normalizedState(status.state);
  const allReady = components.length === knownComponents.size
    && components.every((component) => component.state === "ready");
  const hasBlocked = components.some((component) => component.state === "blocked");
  const state = allReady
    ? "ready"
    : hasBlocked
      ? "blocked"
      : requestedState === "starting"
        ? "starting"
        : "waiting";

  return {
    schema_version: normalizedSchemaVersion(status.schema_version),
    version: normalizedVersion(status.version),
    state,
    checked_at: normalizedCheckedAt(status.checked_at),
    components,
  };
}

/**
 * Produces a paste-ready request. No data is transmitted by this function.
 */
export function buildAiPrompt(status = {}) {
  const diagnostic = safeDiagnostic(status);
  const suggestedChecks = recoveryActions(diagnostic)
    .map((action, index) => `${index + 1}. ${action}`)
    .join("\n");

  return `NudgeOn Safe Boot 설치 문제를 해결해 주세요.
저는 Docker 초보자일 수 있으니 쉬운 한국어로 한 번에 한 단계씩 안내해 주세요.

이 내용은 자동으로 전송되지 않았고, 제가 직접 복사해 붙여넣었습니다.
아래 상태에는 비밀번호, API 키, 설치용 토큰 같은 비밀값이 포함되지 않았습니다.

현재 상태(비밀값 제거됨):
${JSON.stringify(diagnostic, null, 2)}

화면에서 먼저 제안한 안전한 확인 순서:
${suggestedChecks}

답변은 다음 순서로 주세요:
1. 가장 먼저 확인할 한 가지
2. 그 명령이나 확인이 하는 일과 정상이라면 보이는 결과
3. 실패했을 때 이어서 할 안전한 확인 한 가지

주의:
- 한 번에 한 단계만 안내해 주세요.
- 데이터나 Docker 볼륨을 삭제하는 명령은 제안하지 마세요.
- .nudgeon 폴더나 비밀값을 다시 만들지 마세요.
- docker compose down -v, docker volume rm, docker system prune, rm -rf 명령은 제안하지 마세요.
- 비밀번호, API 키, 설치용 토큰, 마스터 키 등 비밀값을 요청하지 마세요.
- 전체 .env나 전체 로그를 요청하지 마세요.
- 정보가 부족하면 추측하지 말고 읽기 전용 확인부터 제안해 주세요.`;
}
