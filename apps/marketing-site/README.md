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
- `scripts/landing.mjs`: semantic homepage markup.
- `public/landing.css`, `public/landing-responsive.css`: homepage styles.
- `public/journey-demo.js`: journey selection, message edits and flow playback.
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
