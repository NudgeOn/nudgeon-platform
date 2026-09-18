for (const demo of document.querySelectorAll('[data-launch-demo]')) {
  const labels = JSON.parse(demo.dataset.labels);
  const button = demo.querySelector('[data-launch-replay]');
  let timer;
  function show(index) {
    for (const screen of demo.querySelectorAll('[data-launch-screen]')) screen.hidden = Number(screen.dataset.launchScreen) !== index;
    for (const step of demo.querySelectorAll('[data-launch-step]')) {
      if (Number(step.dataset.launchStep) === index) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    }
    demo.querySelector('[data-launch-status]').textContent = labels[index];
  }
  function finish() { clearTimeout(timer); show(2); button.disabled = false; }
  button.addEventListener('click', () => {
    clearTimeout(timer); button.disabled = true; show(0);
    timer = setTimeout(() => { show(1); timer = setTimeout(finish, 4000); }, 700);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && button.disabled) finish(); });
  window.addEventListener('pagehide', () => { clearTimeout(timer); button.disabled = false; });
}
