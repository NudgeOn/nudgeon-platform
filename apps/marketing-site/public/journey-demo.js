// A browser-only preview: never contacts an API or sends a message.
const demo = document.querySelector("[data-demo]");
if (demo) {
  const scenarios = JSON.parse(demo.dataset.scenarios);
  const tabs = [...demo.querySelectorAll("[data-scenario]")];
  const stepButtons = [...demo.querySelectorAll("[data-step]")];
  const nodes = [...demo.querySelectorAll("[data-node]")];
  const title = demo.querySelector("[data-title]");
  const body = demo.querySelector("[data-body]");
  const replay = demo.querySelector("[data-replay]");
  const replayLabel = replay.querySelector("span");
  const normalReplay = replayLabel.textContent;
  const result = demo.querySelector("[data-result-line]");
  const normalNote = result.textContent;
  const edits = scenarios.map((s) => ({ title: s.title, body: s.body }));
  let index = 0,
    timers = [];
  const text = (selector, value) => {
    demo.querySelector(selector).textContent = value;
  };
  function resetPlayback() {
    timers.forEach(clearTimeout);
    timers = [];
    nodes.forEach((node) => node.classList.remove("playing", "visited"));
    replay.disabled = false;
    replayLabel.textContent = normalReplay;
    result.textContent = normalNote;
  }
  function selectStep(step) {
    if (step === 1 && !scenarios[index].wait) return;
    [...stepButtons, ...nodes].forEach((el) => {
      const selected = Number(el.dataset.step ?? el.dataset.node) === step;
      el.classList.toggle("selected", selected);
      el.setAttribute("aria-pressed", String(selected));
    });
    text("[data-step-hint]", scenarios[index].hints[step]);
  }
  function renderPreview() {
    edits[index] = { title: title.value, body: body.value };
    text("[data-notification-title]", title.value);
    text("[data-notification-body]", body.value);
  }
  function selectScenario(next) {
    resetPlayback();
    index = next;
    const s = scenarios[index];
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    demo
      .querySelector('[role="tabpanel"]')
      .setAttribute("aria-labelledby", tabs[index].id);
    text("[data-scenario-name]", s.name);
    text("[data-scenario-description]", s.description);
    text("[data-event-label]", s.eventLabel);
    text("[data-event]", s.event);
    text("[data-wait]", s.wait ?? "");
    text("[data-message]", s.message);
    nodes[1].hidden = !s.wait;
    stepButtons[1].hidden = !s.wait;
    demo.querySelector("[data-wait-connector]").hidden = !s.wait;
    stepButtons[2].querySelector("span").textContent = s.wait ? "03" : "02";
    title.value = edits[index].title;
    body.value = edits[index].body;
    renderPreview();
    selectStep(2);
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectScenario(i));
    tab.addEventListener("keydown", (event) => {
      const key = event.key;
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
      event.preventDefault();
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? tabs.length - 1
            : (i + (key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectScenario(next);
      tabs[next].focus();
    });
  });
  [...stepButtons, ...nodes].forEach((el) =>
    el.addEventListener("click", () =>
      selectStep(Number(el.dataset.step ?? el.dataset.node)),
    ),
  );
  [title, body].forEach((input) =>
    input.addEventListener("input", () => {
      resetPlayback();
      renderPreview();
    }),
  );
  document.querySelectorAll("[data-select-scenario]").forEach((link) =>
    link.addEventListener("click", () => {
      selectScenario(Number(link.dataset.selectScenario));
      tabs[index].focus({ preventScroll: true });
    }),
  );
  replay.addEventListener("click", () => {
    resetPlayback();
    replay.disabled = true;
    replayLabel.textContent = demo.dataset.replaying;
    const flow = scenarios[index].wait ? [0, 1, 2] : [0, 2];
    const interval = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : 750;
    flow.forEach((step, i) =>
      timers.push(
        setTimeout(() => {
          nodes.forEach((node) => node.classList.remove("playing"));
          nodes[step].classList.add("playing", "visited");
          selectStep(step);
        }, interval * i),
      ),
    );
    timers.push(
      setTimeout(() => {
        nodes.forEach((node) => node.classList.remove("playing"));
        replay.disabled = false;
        replayLabel.textContent = normalReplay;
        result.textContent = `${demo.dataset.result} ${normalNote}`;
      }, interval * flow.length),
    );
  });
}
