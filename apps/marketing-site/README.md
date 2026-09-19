# NudgeOn website

Public website for https://nudgeon.io, with English `/`, Korean `/ko/`, and the existing `/guide/` and `/ko/guide/` operator guides.

The original source was recovered from the existing Vercel `nudgeon-site` deployment `dpl_3zMtffJwoBDcnot5HD5g5QdFJ3Mb` on 2026-09-16. This directory now owns the marketing site; `apps/docs-site` remains the separate developer documentation site.

## Development

Node.js 22 or newer; no runtime dependencies or installation required.

```sh
npm run check
npm run build
PORT=4175 npm run dev
```

The server binds to `127.0.0.1`. It builds at startup; run `npm run build` and reload after subsequent edits.

## Source map

- `src/experience.mjs`: bilingual homepage copy and three demo journeys.
- `src/content.mjs`: metadata and original shared content.
- `src/product-info.mjs`: bilingual product questions, support boundaries and role-based entry links; English answers also generate the optional `llms.txt` reading guide.
- `scripts/landing.mjs`: semantic homepage markup.
- `scripts/product-info.mjs`, `public/product-info.css`: server-rendered product questions and documentation links, usable without JavaScript.
- `public/landing.css`, `public/landing-responsive.css`: homepage styles.
- `public/journey-demo.js`: journey selection, message edits and flow playback.
- `scripts/launch-ads.mjs`, `public/launch-ads.css`, `public/launch-ads.js`: bilingual startup-ad feature explanation and a local launch → 4-second ad → main preview.
- `scripts/installation.mjs`, `public/installation.css`, `public/install-tour.js`: bilingual setup walkthrough, command copy, and five actual product screens with synthetic example accounts. Database/owner screens are Korean; login, optional OTP, and dashboard captures are localized.
- `scripts/user-guide.mjs`, `public/guide.css`, `public/style.css`: preserved operator guides.
- `scripts/check.mjs`: locale parity, links, assets, page structure and demo contract checks.
- `design/`: visual references, excluded from deployment.

The homepage demo runs entirely in browser memory. It never sends a notification, makes an API request, or persists message edits. The CSP restricts resources to this origin and uses `connect-src 'none'`. There are no analytics, external fonts, or third-party scripts.

The matching console starters live in `../console/src/app/journeys/journey-templates.ts`. They open editable drafts for apps with Graph V2 capability. Publishing a journey remains an explicit console action.

## Deployment

Use the existing Vercel project `nudgeon-site` in `marvinkim-82s-projects`, project ID `prj_bSmnoofnEbaLRuB4bNEj7dSOaK5U`. Do not create another project or replace the developer documentation deployment.

```sh
vercel link --yes --project nudgeon-site --scope marvinkim-82s-projects
vercel --prod --skip-domain --yes
# Verify the staged deployment, then:
vercel promote <deployment-url> --yes
```

`vercel.json` validates and builds `dist/`. Canonicals, alternate locales, sitemap and social metadata use `https://nudgeon.io`. Keep both guide routes available when updating the homepage.

Release claims must follow the [release checklist](../../docs-public/RELEASE-CHECKLIST.md). Do not imply hosted SaaS availability, guaranteed exactly-once delivery, or four published SDKs before their gates are complete.

## Search discovery maintenance

All four public pages render their content, unique titles/descriptions, self-canonicals, reciprocal EN/KO/x-default alternates and JSON-LD at build time. Homepages describe the organization, website and software; guides include a visible breadcrumb and matching BreadcrumbList. Both page types use localized 1200×630 social images. `npm run check` guards these contracts and checks that product answers exist in the HTML without JavaScript.

The existing `robots.txt` allows all crawlers, including search crawlers such as OAI-SearchBot. Keep crawler access distinct from claims about actual indexing: a successful request with a bot user-agent does not prove requests from the crawler's published IP ranges can reach the site. Check production firewall rules and crawler logs if discovery fails. The existing policy for model-training crawlers has not been changed.

`sitemap.xml` lists the four canonical pages; language alternates are supplied in HTML. Do not add fabricated modification dates, reviews, prices or release claims to metadata. Product/SDK availability changes must update `src/product-info.mjs`, `src/experience.mjs` and the release checklist together. The generated `llms.txt` is a supplemental reading guide, not an indexing protocol or a ranking guarantee.

After deployment, use the verified properties in Google Search Console and Bing Webmaster Tools to submit `https://nudgeon.io/sitemap.xml`, inspect the four URLs, and measure indexing, impressions and clicks. Property access/verification is an account-side step; deploying these files does not submit or verify a property.

References: [Google AI search guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide), [structured data guidance](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data), [OpenAI crawler controls](https://developers.openai.com/api/docs/bots).
