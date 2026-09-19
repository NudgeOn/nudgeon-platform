import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { render, root, llmsTxt, escape } from './build.mjs';
import { productInfo } from '../src/product-info.mjs';
import { experience } from '../src/experience.mjs';
import { content } from '../src/content.mjs';
import { renderGuide } from './user-guide.mjs';
import path from 'node:path';

for (const language of ['en', 'ko']) {
 for (const renderPage of [render, renderGuide]) {
  const html = renderPage(language);
  assert(html.includes(`<html lang="${language}">`));
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert(!/Braze|한국형|revolutioniz|unlock|seamless/i.test(html));
  assert(!/<form[^>]+action=/.test(html), 'The demo must not submit data');
  assert(!/\bOnda\b|onda-logo|ONDA_MASTER_KEY/.test(html), 'Only current NudgeOn branding and guides');
  for (const match of html.matchAll(/(?:src|href)="((?:https?:|mailto:)[^"]*)"/g)) {
    const url = new URL(match[1]);
    assert(url.protocol === 'mailto:' ? url.pathname === 'hello@nudgeon.io' :
      url.protocol === 'https:' && (['nudgeon.io', 'developer.nudgeon.io', 'github.com'].includes(url.hostname) || url.href === 'https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html'),
      `Unexpected external destination: ${match[1]}`);
  }
  for (const match of html.matchAll(/href="#([^"]+)"/g)) assert(html.includes(`id="${match[1]}"`), `Missing target: ${match[1]}`);
  for (const match of html.matchAll(/(?:src|href|srcset)="(\/(?:assets\/|style\.css|guide\.css|product-info\.css|landing\.css|landing-responsive\.css|installation\.css|launch-ads\.css|launch-ads\.js|install-tour\.js|journey-demo\.js|site\.js)[^"]*)"/g)) await access(path.join(root, 'public', match[1]));
  assert.deepEqual(Object.keys(content.en).sort(), Object.keys(content.ko).sort());
 }
}
console.log('Both locales, homepages and guides: semantic structure, copy boundaries, anchors and local assets verified.');

assert.deepEqual(Object.keys(experience.en).sort(), Object.keys(experience.ko).sort());
for (const language of ["en", "ko"]) {
  const html = render(language);
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert(html.includes("data-replay"));
  assert(html.includes("data-title"));
  assert(html.includes("data-body"));
  assert.equal(experience[language].scenarios[2].wait, null);
}

// Guard the public indexing contract across both page types and languages.
const titles = new Set();
const descriptions = new Set();
for (const [renderer, enPath, koPath] of [[render, '/', '/ko/'], [renderGuide, '/guide/', '/ko/guide/']]) {
  for (const lang of ['en', 'ko']) {
    const html = renderer(lang);
    const url = `https://nudgeon.io${lang === 'ko' ? koPath : enPath}`;
    assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
    assert(html.includes(`<link rel="canonical" href="${url}">`));
    for (const [locale, route] of [['en', enPath], ['ko', koPath], ['x-default', enPath]]) {
      assert(html.includes(`hreflang="${locale}" href="https://nudgeon.io${route}"`));
    }
    assert(!/noindex|nosnippet|data-nosnippet/.test(html), 'Public product pages must remain indexable and quotable');
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    const description = html.match(/name="description" content="([^"]+)"/)[1];
    assert(!titles.has(title), 'Each page needs a distinct title'); titles.add(title);
    assert(!descriptions.has(description), 'Each page needs a distinct description'); descriptions.add(description);
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1])['@graph'];
    const page = graph.find(node => node['@type'] === 'WebPage');
    assert.equal(page.url, url); assert.equal(page.inLanguage, lang);
    assert.equal(escape(page.name), title); assert.equal(escape(page.description), description);
    assert.equal(page.isPartOf['@id'], 'https://nudgeon.io/#website');
    assert(html.includes(`property="og:url" content="${url}"`));
    assert(html.includes(`property="og:image" content="https://nudgeon.io/assets/og-${lang}.png"`));
    if (renderer === renderGuide) {
      const breadcrumbs = graph.find(node => node['@type'] === 'BreadcrumbList').itemListElement;
      assert.equal(breadcrumbs.at(-1).item, url);
      assert.equal(breadcrumbs[0].item, `https://nudgeon.io${lang === 'ko' ? '/ko/' : '/'}`);
    } else {
      assert(graph.some(node => node['@id'] === page.mainEntity['@id'] && node['@type'] === 'SoftwareApplication'));
      const body = html.split('<body>')[1];
      for (const [question, answer] of productInfo[lang].questions) {
        assert(body.includes(`<summary>${escape(question)}</summary>`));
        assert(body.includes(`<p>${escape(answer)}</p>`), 'Product facts must be present without JavaScript');
        if (lang === 'en') assert(llmsTxt().includes(answer), 'Optional machine reading guide must match visible facts');
      }
    }
  }
}
const robots = await readFile(path.join(root, 'public/robots.txt'), 'utf8');
assert.match(robots, /User-agent: \*\s+Allow: \//);
assert.match(robots, /Sitemap: https:\/\/nudgeon.io\/sitemap.xml/);
assert.deepEqual(Object.keys(productInfo.en).sort(), Object.keys(productInfo.ko).sort());
assert.equal(productInfo.en.questions.length, productInfo.ko.questions.length);
console.log('Search discovery: unique metadata, canonical/hreflang, JSON-LD, social cards, crawl policy and no-JS product facts verified.');
