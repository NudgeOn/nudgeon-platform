// Progressive enhancement: links also open readable panels through :target without JavaScript.
const panels = new Map();
document.querySelectorAll('.detail-panel').forEach(section => {
  const dialog = document.createElement('dialog');
  dialog.id = section.id;
  dialog.className = section.className;
  dialog.setAttribute('aria-labelledby', section.getAttribute('aria-labelledby'));
  while (section.firstChild) dialog.append(section.firstChild);
  section.replaceWith(dialog);
  panels.set(dialog.id, dialog);
  dialog.querySelector('[data-close]').addEventListener('click', event => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));
});
function openPanel(id) {
  const dialog = panels.get(id);
  if (dialog && !dialog.open) { dialog.showModal(); document.body.classList.add('dialog-open'); }
}
document.querySelectorAll('[data-open]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault(); openPanel(link.dataset.open);
}));
if (panels.has(location.hash.slice(1))) openPanel(location.hash.slice(1));
