# Prototype Instructions

The selected NudgeOn brand mark is “행동의 연쇄”: three rounded domino tiles leaning progressively forward, in navy #0B2438. Use the dedicated /assets/nudgeon-mark.svg for the sidebar/mobile brand icon; do not crop the horizontal wordmark to simulate an icon.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

The selected source of truth is `design/reference-option-2.png`: the dark, documentation-first NudgeOn Developer Center concept with a fixed sidebar, compact top utility bar, five-step runbook, and right-side page table of contents. The prototype must provide complete Korean and English UI/content versions with an in-page language switch; do not reduce this to a translated hero only.

The prototype must support both dark and light themes with an accessible, persistent switch that remains reachable on desktop and mobile. Sidebar entries must lead to real, distinct content rather than sharing placeholder anchors; in particular, `푸시 만들기`, `저니(시나리오)`, and `세그먼트` require implemented Korean and English guide content grounded in the current API contracts.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

Keep iOS and Android runnable-example entry points near the top of the app-launch guide. Platform selection must expose API URL/public SDK key configuration and build/run steps before the long reference material.
