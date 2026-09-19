import { productInfo } from '../src/product-info.mjs';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderProductInfo(lang) {
  const t = productInfo[lang];
  return `<section class="product-info shell" id="questions" aria-labelledby="questions-title">
    <div class="section-heading"><h2 id="questions-title">${escape(t.title)}</h2><p>${escape(t.intro)}</p></div>
    <div class="product-questions">${t.questions.map(([question, answer], index) => `<details${index === 0 ? ' open' : ''}><summary>${escape(question)}</summary><p>${escape(answer)}</p></details>`).join('')}</div>
    <h3 class="resource-title">${escape(t.resourcesTitle)}</h3>
    <div class="product-resources">${t.resources.map(([title, description, href]) => `<a href="${escape(href)}"><strong>${escape(title)} <span aria-hidden="true">↗</span></strong><span>${escape(description)}</span></a>`).join('')}</div>
  </section>`;
}
