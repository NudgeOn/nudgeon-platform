import {
  buildAiPrompt,
  componentHelp,
  recoveryActions,
  safeDiagnostic,
} from "/setup-diagnostics.mjs";

const names = {
  postgres: "PostgreSQL",
  redis: "Redis",
  clickhouse: "ClickHouse",
  api: "API",
  worker: "Worker",
  console: "Console",
};

const labels = {
  starting: "시작 중",
  ready: "준비됨",
  waiting: "시작 중",
  blocked: "도움 필요",
};

const elements = {
  aiCopyResult: document.querySelector("#ai-copy-result"),
  aiPromptPreview: document.querySelector("#ai-prompt-preview"),
  components: document.querySelector("#components"),
  copyResult: document.querySelector("#copy-result"),
  helpActions: document.querySelector("#help-actions"),
  helpSummary: document.querySelector("#help-summary"),
  nextStep: document.querySelector("#next-step"),
  progressBar: document.querySelector("#progress-bar"),
  progressLabel: document.querySelector("#progress-label"),
  summary: document.querySelector("#summary"),
  troubleshooting: document.querySelector("#troubleshooting"),
  troubleshootingTitle: document.querySelector("#troubleshooting-title"),
};

let lastStatus = null;
let aiPrompt = "";
let timer = null;

function componentItem(component) {
  const item = document.createElement("li");
  item.className = `component ${component.state}`;

  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.setAttribute("aria-hidden", "true");

  const main = document.createElement("span");
  main.className = "component-main";

  const name = document.createElement("span");
  name.className = "component-name";
  name.textContent = names[component.name] ?? component.name;

  const explanation = document.createElement("span");
  explanation.className = "component-explanation";
  explanation.textContent = componentHelp(component);
  main.append(name, explanation);

  const code = document.createElement("span");
  code.className = "component-code";
  code.title = "기술 상태 코드";
  code.textContent = component.code;

  const state = document.createElement("strong");
  state.textContent = labels[component.state] ?? component.state;

  item.append(dot, main, code, state);
  return item;
}

function renderActions(actions) {
  elements.helpActions.replaceChildren(
    ...actions.map((action) => {
      const item = document.createElement("li");
      for (const part of action.split(/(`[^`]+`)/g).filter(Boolean)) {
        if (part.startsWith("`") && part.endsWith("`")) {
          const code = document.createElement("code");
          code.textContent = part.slice(1, -1);
          item.append(code);
        } else {
          item.append(document.createTextNode(part));
        }
      }
      return item;
    }),
  );
}

function renderHelp(status, { connectionFailed = false } = {}) {
  const ready = status?.state === "ready" && !connectionFailed;
  elements.troubleshooting.hidden = ready;
  if (ready) return;

  if (connectionFailed) {
    elements.troubleshootingTitle.textContent = "화면 연결부터 다시 확인할게요";
    elements.helpSummary.textContent =
      "설치 데이터가 사라진 것은 아닙니다. 상태를 보여주는 작은 서비스와 잠시 연결되지 않은 상태예요.";
  } else if (status.state === "blocked") {
    elements.troubleshootingTitle.textContent = "멈춘 서비스부터 하나씩 볼게요";
    elements.helpSummary.textContent =
      "데이터를 지울 필요가 없습니다. 아래 첫 번째 방법부터 순서대로 한 번씩만 해보세요.";
  } else {
    elements.troubleshootingTitle.textContent = "조금만 기다린 뒤 다시 볼게요";
    elements.helpSummary.textContent =
      "처음 실행할 때는 Docker가 서비스들을 차례로 켭니다. 대부분 잠시 기다리면 자동으로 완료돼요.";
  }

  renderActions(recoveryActions(status, { connectionFailed }));
}

function render(status) {
  const safeStatus = safeDiagnostic(status);
  lastStatus = safeStatus;
  aiPrompt = buildAiPrompt(safeStatus);
  elements.aiPromptPreview.textContent = aiPrompt;
  elements.aiCopyResult.textContent = "";
  elements.copyResult.textContent = "";
  elements.components.replaceChildren(...safeStatus.components.map(componentItem));
  elements.components.setAttribute("aria-busy", "false");

  const readyCount = safeStatus.components.filter((component) => component.state === "ready").length;
  const percent = safeStatus.components.length === 0
    ? 0
    : Math.round((readyCount / safeStatus.components.length) * 100);
  elements.progressBar.style.width = `${percent}%`;
  elements.progressLabel.textContent = `${safeStatus.components.length}개 중 ${readyCount}개 준비됨`;
  elements.nextStep.hidden = safeStatus.state !== "ready";
  renderHelp(safeStatus);

  if (safeStatus.state === "ready") {
    elements.summary.textContent = "모든 서비스가 준비됐어요. 관리자 계정 만들기는 다음 설치 단계에서 이어집니다.";
  } else if (safeStatus.state === "blocked") {
    elements.summary.textContent = "준비 확인에서 멈춘 서비스가 있어요. 아래 쉬운 방법부터 따라 해보세요.";
  } else {
    elements.summary.textContent = "서비스를 차례로 켜고 있어요. 이 화면은 자동으로 다시 확인합니다.";
  }
}

function renderConnectionFailure() {
  const emptyStatus = {
    schema_version: 1,
    version: "unknown",
    state: "waiting",
    checked_at: new Date().toISOString(),
    components: [],
  };
  lastStatus = null;
  aiPrompt = [
    "NudgeOn 설치 화면이 상태 확인 서비스에 연결하지 못하고 있습니다.",
    "",
    buildAiPrompt(emptyStatus),
  ].join("\n");
  elements.aiPromptPreview.textContent = aiPrompt;
  elements.components.replaceChildren();
  elements.components.setAttribute("aria-busy", "false");
  elements.progressBar.style.width = "0%";
  elements.progressLabel.textContent = "상태를 확인할 수 없음";
  elements.summary.textContent = "상태 화면 연결이 잠시 끊겼어요. 설치 데이터는 그대로이며 자동으로 다시 확인합니다.";
  elements.nextStep.hidden = true;
  elements.aiCopyResult.textContent = "";
  elements.copyResult.textContent = "";
  renderHelp(emptyStatus, { connectionFailed: true });
}

async function refresh() {
  clearTimeout(timer);
  try {
    const response = await fetch("/setup-status/v1/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    render(await response.json());
  } catch {
    renderConnectionFailure();
  }
  timer = setTimeout(refresh, lastStatus?.state === "ready" ? 30000 : 5000);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("COPY_NOT_ALLOWED");
}

document.querySelector("#retry").addEventListener("click", refresh);
document.querySelector("#copy-ai-prompt").addEventListener("click", async () => {
  if (!aiPrompt) return;
  try {
    await copyText(aiPrompt);
    elements.aiCopyResult.textContent = "복사했어요. 사용하는 AI 대화창에 붙여 넣으세요.";
  } catch {
    elements.aiCopyResult.textContent = "복사가 막혔어요. 브라우저의 클립보드 권한을 확인해 주세요.";
  }
});

document.querySelector("#copy-diagnostics").addEventListener("click", async () => {
  if (!lastStatus) {
    elements.copyResult.textContent = "아직 복사할 상태 정보가 없어요";
    return;
  }
  try {
    await copyText(JSON.stringify(safeDiagnostic(lastStatus), null, 2));
    elements.copyResult.textContent = "비밀값을 제외하고 복사했어요";
  } catch {
    elements.copyResult.textContent = "브라우저가 복사를 허용하지 않았어요";
  }
});

refresh();
