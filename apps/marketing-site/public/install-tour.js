const tour = document.querySelector('[data-install-tour]');
if (tour) {
  const buttons = [...tour.querySelectorAll('[data-install-step]')];
  buttons.forEach((button, index) => button.addEventListener('click', () => {
    buttons.forEach((item, i) => item.setAttribute('aria-pressed', String(i === index)));
    tour.querySelectorAll('.install-panel').forEach((panel, i) => { panel.hidden = i !== index; });
  }));
}
const copy = document.querySelector('[data-copy-install]');
copy?.addEventListener('click', async () => {
  const status = document.querySelector('[data-copy-install-status]');
  try {
    await navigator.clipboard.writeText(document.querySelector('[data-install-command]').textContent);
    status.textContent = copy.dataset.copied;
  } catch { status.textContent = copy.dataset.failed; }
});
