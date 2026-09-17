import { renderInstallation } from "./installation.mjs";
import { experience } from "../src/experience.mjs";
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  arrow: "M4 12h15m-6-6 6 6-6 6",
  event:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m14-14a4 4 0 1 1-8 0 4 4 0 0 1 8 0m2 8h4m-2-2v4",
  wait: "M12 8v4l3 2m7-2a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  message: "m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13",
  play: "m8 5 11 7-11 7V5Z",
  check: "m5 12 4 4L19 6",
};
export const icon = (name, cls = "") =>
  `<svg class="${cls}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]}"/></svg>`;
const repo = "https://github.com/NudgeOn/nudgeon-platform";
const docs = "https://developer.nudgeon.io/";
function language(lang) {
  return `<nav class="languages" aria-label="${lang === "ko" ? "언어" : "Language"}"><a href="/" lang="en" ${lang === "en" ? 'aria-current="page"' : ""}>EN</a><span>/</span><a href="/ko/" lang="ko" ${lang === "ko" ? 'aria-current="page"' : ""}>KO</a></nav>`;
}
export function renderLanding(lang) {
  const t = experience[lang],
    s = t.scenarios[0],
    guide = lang === "ko" ? "/ko/guide/" : "/guide/";
  const brand = `<a class="brand" href="${lang === "ko" ? "/ko/" : "/"}"><img src="/assets/nudgeon-mark.svg" alt="" width="30" height="30"><span>NudgeOn</span></a>`;
  return `<header class="site-header"><div class="shell header-inner">${brand}
    <nav class="main-nav" aria-label="${lang === "ko" ? "메인 메뉴" : "Main navigation"}"><a href="#product">${t.product}</a><a href="#journeys">${t.journeys}</a><a href="${guide}">${t.guide}</a><a href="${docs}">${t.developers}</a></nav>
    <div class="header-actions">${language(lang)}<a class="button compact dark" href="#installation">${t.start}</a></div></div></header>
  <main id="main">
    <section class="hero shell" aria-labelledby="hero-title">
      <div><h1 id="hero-title">${esc(t.headline[0])}<br><span>${esc(t.headline[1])}</span></h1><div class="hero-actions"><a class="button primary" href="#journeys">${t.explore}${icon("arrow")}</a><a class="button secondary" href="#installation">${t.install}</a></div></div>
      <div class="hero-description"><p>${t.intro}</p><a class="text-link" href="${repo}"><img src="/assets/github-mark.svg" alt="" width="22" height="22">${t.source}${icon("arrow")}</a></div>
    </section>
    <section class="journeys shell" id="journeys" aria-label="${t.interactive}" data-demo data-scenarios="${esc(JSON.stringify(t.scenarios))}" data-steps="${esc(JSON.stringify(t.steps))}" data-complete="${esc(t.complete)}" data-result="${esc(t.result)}" data-replaying="${esc(t.replaying)}">
      <div class="demo-frame"><div class="demo-toolbar"><div class="scenario-tabs" role="tablist" aria-label="${t.journeys}">${t.scenarios.map((item, i) => `<button type="button" role="tab" id="tab-${item.id}" aria-selected="${i === 0}" aria-controls="journey-panel" tabindex="${i === 0 ? 0 : -1}" data-scenario="${i}">${esc(item.name)}</button>`).join("")}</div><span class="interactive-label"><i></i>${t.interactive}</span></div>
      <div class="demo-body" id="journey-panel" role="tabpanel" aria-labelledby="tab-welcome">
        <aside class="demo-context"><h2 data-scenario-name>${s.name}</h2><p data-scenario-description>${s.description}</p><div class="step-navigation" aria-label="${t.stepHint}">${t.steps.map((step, i) => `<button type="button" data-step="${i}" aria-pressed="${i === 2}" class="step-button${i === 2 ? " selected" : ""}"><span>0${i + 1}</span>${step}</button>`).join("")}</div><p class="step-hint" data-step-hint>${s.hints[2]}</p><a class="context-guide" href="${guide}#message">${t.guide}${icon("arrow")}</a></aside>
        <div class="flow-canvas" aria-label="${t.journeys}">
          <div class="flow-path"><button type="button" class="flow-node" data-node="0" aria-pressed="false"><span class="node-icon">${icon("event")}</span><span><strong data-event-label>${s.eventLabel}</strong><code data-event>${s.event}</code></span><span class="node-check">${icon("check")}</span></button>
          <div class="connector" data-wait-connector><span></span></div><button type="button" class="flow-node" data-node="1" aria-pressed="false"><span class="node-icon amber">${icon("wait")}</span><strong data-wait>${s.wait}</strong><span class="node-check">${icon("check")}</span></button>
          <div class="connector"><span></span></div><button type="button" class="flow-node selected" data-node="2" aria-pressed="true"><span class="node-icon teal">${icon("message")}</span><strong data-message>${s.message}</strong><span class="node-check">${icon("check")}</span></button>
          <div class="connector last"><span></span></div><span class="flow-end">${t.complete}</span></div>
          <span class="canvas-caption">EVENT → JOURNEY → MESSAGE</span>
        </div>
        <aside class="message-inspector"><h3>${t.preview}</h3><label for="preview-title">${t.title}</label><input id="preview-title" data-title value="${esc(s.title)}" maxlength="80"><label for="preview-body">${t.body}</label><textarea id="preview-body" data-body maxlength="180" rows="3">${esc(s.body)}</textarea>
          <div class="phone-stage"><div class="phone"><div class="phone-island"></div><div class="phone-time">9:41</div><div class="phone-date">${lang === "ko" ? "9월 16일 수요일" : "Wednesday, September 16"}</div><div class="notification"><div class="notification-meta"><img src="/assets/nudgeon-mark.svg" alt="" width="20" height="20"><span>NudgeOn</span><time>${t.now}</time></div><strong data-notification-title>${s.title}</strong><p data-notification-body>${s.body}</p></div></div></div>
          <button class="button replay" type="button" data-replay>${icon("play")}<span>${t.replay}</span></button>
        </aside>
      </div></div><p class="demo-note" data-result-line role="status" aria-live="polite">${t.note}</p><noscript><p class="demo-note">${lang === "ko" ? "단계 선택과 문구 편집에는 JavaScript가 필요합니다." : "Enable JavaScript to switch journeys and edit the preview."}</p></noscript>
    </section>
    <section class="features shell" id="product" aria-labelledby="features-title"><div class="section-heading"><h2 id="features-title">${t.featureTitle}</h2><p>${t.featureIntro}</p></div>
      <div class="feature-columns">${t.features.map(([title, body], i) => `<article><span class="feature-number">0${i + 1}</span><h3>${title}</h3><p>${body}</p>${i === 0 ? `<div class="event-list" aria-label="${t.sample}">${["sign_up", "playlist_updated", "purchase_completed"].map((e, j) => `<div><span class="event-dot"></span><code>${e}</code><time>09:4${j + 1}</time></div>`).join("")}</div>` : i === 1 ? `<div class="mini-flow" aria-label="${t.sample}">${["event", "wait", "message"].map((n, j) => `<div>${icon(n)}<span>${t.steps[j]}</span></div>${j < 2 ? icon("arrow", "mini-arrow") : ""}`).join("")}</div>` : `<div class="event-list log-list" aria-label="${t.sample}">${t.logNames.map((n, j) => `<div><span>${n}</span><span class="log-status status-${j}">${t.status[j]}</span></div>`).join("")}</div>`}</article>`).join("")}</div><p class="sample-note">${t.sample}</p>
      <div class="moments"><h3>${t.moments}</h3><div>${t.momentLinks.map((name, i) => `<a href="#journeys" data-select-scenario="${i}">${name}${icon("arrow")}</a>`).join("")}</div></div>
    </section>
    ${renderInstallation(lang)}
    <section class="deployment shell" id="deployment" aria-labelledby="deployment-title"><div class="deployment-grid"><div><h2 id="deployment-title">${t.deployTitle.map(esc).join("<br>")}</h2><p>${t.deployIntro}</p><div class="deployment-actions"><a class="button primary" href="${docs}#self-hosting">${t.setup}${icon("arrow")}</a><a class="text-link" href="${repo}">${t.viewSource}${icon("arrow")}</a></div></div><div class="terminal"><div class="terminal-header"><span class="terminal-dots"><i></i><i></i><i></i></span><span>Self-hosted NudgeOn</span></div><code><span>$</span> ./nudgeon up</code><p>PostgreSQL · ClickHouse · Redis</p><p>${t.terminal}</p><span class="terminal-license">Apache-2.0</span></div></div>
      <div class="release-strip"><strong>${t.beta}</strong><p>${t.betaBody}</p><a class="text-link" href="${repo}/blob/main/docs-public/RELEASE-CHECKLIST.md">${t.checklist}${icon("arrow")}</a></div>
    </section>
    <section class="final-cta"><div class="shell"><h2>${t.finalTitle}</h2><a class="button lime" href="${guide}#message">${t.finalCta}${icon("arrow")}</a></div></section>
  </main>
  <footer class="footer shell"><div>${brand}<p>${t.footer}</p></div><nav aria-label="${lang === "ko" ? "관련 링크" : "Resources"}"><a href="${guide}">${t.guide}</a><a href="${docs}">${t.developers}</a><a href="${repo}">GitHub</a><a href="mailto:hello@nudgeon.io">${t.contact}</a></nav>${language(lang)}</footer>`;
}
