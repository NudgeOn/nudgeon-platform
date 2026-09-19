import { mkdir, cp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderLanding } from './landing.mjs';
import { content } from '../src/content.mjs';
import { renderGuide } from './user-guide.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const arrow = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const languages = lang => `<nav class="languages" aria-label="${lang === 'ko' ? '언어 선택' : 'Language'}"><a href="/" lang="en" hreflang="en" ${lang === 'en' ? 'aria-current="page"' : ''}>EN</a><span aria-hidden="true">/</span><a href="/ko/" lang="ko" hreflang="ko" ${lang === 'ko' ? 'aria-current="page"' : ''}>KO</a></nav>`;
const siteUrl = 'https://nudgeon.io';
const docsUrl = 'https://developer.nudgeon.io';
const repoUrl = 'https://github.com/NudgeOn/nudgeon-platform';

export function render(lang) {
  const t = content[lang];
  const pageUrl = `${siteUrl}${lang === 'ko' ? '/ko/' : '/'}`;
  // 소셜 카드는 언어별로 다르다. 로고 락업(3:1)은 카드에서 잘리므로 1200x630 전용 이미지를 쓴다.
  const socialImage = `${siteUrl}/assets/og-${lang}.png`;
  const socialAlt = lang === 'ko'
    ? 'NudgeOn — 다시 찾아올 이유를 보내세요.'
    : 'NudgeOn — Give them a reason to come back.';
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization', '@id': `${siteUrl}/#organization`,
        name: 'NudgeOn', url: `${siteUrl}/`, logo: `${siteUrl}/assets/nudgeon-avatar.png`,
        sameAs: ['https://github.com/NudgeOn']
      },
      {
        '@type': 'SoftwareApplication', '@id': `${siteUrl}/#software`,
        name: 'NudgeOn', url: `${siteUrl}/`, description: t.description,
        applicationCategory: 'BusinessApplication', applicationSubCategory: 'Customer engagement',
        creativeWorkStatus: 'Partner beta candidate', license: `${repoUrl}/blob/main/LICENSE`,
        image: socialImage, sameAs: [repoUrl],
        author: { '@id': `${siteUrl}/#organization` },
        softwareHelp: { '@type': 'CreativeWork', name: 'NudgeOn Developer Center', url: `${docsUrl}/` },
        featureList: ['Event collection', 'Audience segmentation', 'Customer journeys', 'FCM and APNs push', 'Self-hosted deployment', 'Timed full-screen startup ads']
      },
      {
        '@type': 'WebPage', '@id': `${pageUrl}#webpage`, url: pageUrl,
        name: t.title, description: t.description, inLanguage: lang,
        about: { '@id': `${siteUrl}/#software` },
        publisher: { '@id': `${siteUrl}/#organization` }
      }
    ]
  };
  const lines = values => values.map(escape).join('<br>');
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light"><meta name="theme-color" content="#ffffff">
  <title>${escape(t.title)}</title><meta name="description" content="${escape(t.description)}">
  <meta property="og:type" content="website"><meta property="og:site_name" content="NudgeOn">
  <meta property="og:title" content="${escape(t.title)}"><meta property="og:description" content="${escape(t.description)}">
  <meta property="og:locale" content="${lang === 'ko' ? 'ko_KR' : 'en_US'}">
  <link rel="canonical" href="${pageUrl}"><meta property="og:url" content="${pageUrl}">
  <meta property="og:image" content="${socialImage}"><meta property="og:image:secure_url" content="${socialImage}">
  <meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${escape(socialAlt)}">
  <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(t.title)}">
  <meta name="twitter:description" content="${escape(t.description)}"><meta name="twitter:image" content="${socialImage}">
  <meta name="twitter:image:alt" content="${escape(socialAlt)}">
  <script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script>
  <link rel="alternate" hreflang="en" href="${siteUrl}/"><link rel="alternate" hreflang="ko" href="${siteUrl}/ko/"><link rel="alternate" hreflang="x-default" href="${siteUrl}/">
  <link rel="icon" type="image/svg+xml" href="/assets/nudgeon-mark.svg">
  <link rel="stylesheet" href="/landing.css"><link rel="stylesheet" href="/landing-responsive.css"><link rel="stylesheet" href="/installation.css"><link rel="stylesheet" href="/launch-ads.css"><script type="module" src="/launch-ads.js"></script><script type="module" src="/journey-demo.js"></script><script type="module" src="/install-tour.js"></script>
</head>
<body>
  <a class="skip" href="#main">${t.skip}</a>
  ${renderLanding(lang)}
</body></html>`;
}

function llmsTxt() {
  const t = content.en;
  return `# NudgeOn

> ${t.description}

NudgeOn is an open-source customer engagement platform that collects events from mobile apps, builds
audiences, orchestrates journeys, and delivers messages on infrastructure the
operator controls. Licensed under Apache-2.0 with no open-core feature gating.

Status: partner beta candidate. Push (FCM/APNs) and email are implemented;
Alimtalk has a connector contract and mock vendor. Managed hosting is not available.
See the release checklist for verified results and remaining beta gates.

## Site

- [Home](${siteUrl}/): product overview
- [Home (Korean)](${siteUrl}/ko/): 한국어 제품 소개
- [User guide](${siteUrl}/guide/): what the console does
- [User guide (Korean)](${siteUrl}/ko/guide/): 콘솔 사용 안내
- [Developer Center](${docsUrl}/): integration and API reference

## Source

- [Platform](${repoUrl}): NestJS APIs, Next.js console, Go workers, PostgreSQL, ClickHouse, Redis Streams
- [iOS SDK](https://github.com/NudgeOn/nudgeon-ios-sdk): Swift Package, \`from: "0.2.5"\`
- [Android SDK](https://github.com/NudgeOn/nudgeon-android-sdk): Maven Central, \`io.nudgeon:nudgeon-sdk:0.2.5\`
- [Release checklist](${repoUrl}/blob/main/docs-public/RELEASE-CHECKLIST.md): what is and is not verified

## Contact

- hello@nudgeon.io
`;
}

export async function build() {
  await mkdir(path.join(root, 'dist/ko/guide'), { recursive: true });
  await mkdir(path.join(root, 'dist/guide'), { recursive: true });
  await cp(path.join(root, 'public'), path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist/index.html'), render('en'));
  await writeFile(path.join(root, 'dist/ko/index.html'), render('ko'));
  await writeFile(path.join(root, 'dist/guide/index.html'), renderGuide('en'));
  await writeFile(path.join(root, 'dist/ko/guide/index.html'), renderGuide('ko'));
  const routes = ['/', '/ko/', '/guide/', '/ko/guide/'];
  await writeFile(path.join(root, 'dist/sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map(route => `<url><loc>${siteUrl}${route}</loc></url>`).join('')}</urlset>`);
  await writeFile(path.join(root, 'dist/llms.txt'), llmsTxt());
  console.log('Built English and Korean homepages and user guides.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
