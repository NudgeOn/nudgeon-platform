import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { render, root } from './build.mjs';
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
      url.protocol === 'https:' && ['nudgeon.io', 'developer.nudgeon.io', 'github.com'].includes(url.hostname),
      `Unexpected external destination: ${match[1]}`);
  }
  for (const match of html.matchAll(/href="#([^"]+)"/g)) assert(html.includes(`id="${match[1]}"`), `Missing target: ${match[1]}`);
  for (const match of html.matchAll(/(?:src|href|srcset)="(\/(?:assets\/|style\.css|guide\.css|landing\.css|landing-responsive\.css|installation\.css|launch-ads\.css|launch-ads\.js|install-tour\.js|journey-demo\.js|site\.js)[^"]*)"/g)) await access(path.join(root, 'public', match[1]));
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
