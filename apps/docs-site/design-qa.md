# NudgeOn Developer Center Design QA

## Comparison target

- Source visual truth: `design/reference-option-2.png`
- Browser-rendered implementation: `design/implementation-desktop-ko-final.png`
- Final full-view comparison: `design/qa-comparison-final.png`
- Final focused comparison: `design/qa-focused-checklist-final.png`
- Viewport: 1487 × 1058 CSS px
- Source pixels: 1487 × 1058
- Implementation pixels: 1487 × 1058
- Density normalization: none in the final pass; the browser viewport used device scale factor 1, so source and implementation were compared at identical pixel dimensions.
- State: Korean, dark theme, checklist step 1 selected, page scrolled to the top.

## Evidence

### Full view

The final side-by-side comparison confirms the source layout measurements: 245 px fixed sidebar, 72 px top bar, main content at x=297, 974 px checklist card, 297 px step rail, and right-side page table of contents. Hero hierarchy, card top and bottom edges, content order, borders, state colors, and fixed theme control align with the selected concept.

### Focused checklist region

The exact card region was cropped from both images at x=297, y=316, 974 × 650 px and placed in one comparison image. Step geometry, connector line, active circle, two-column split, code surfaces, copy controls, warning treatment, and next-step action are visibly aligned. The implementation intentionally uses the repository-backed `/readyz` response and delivery semantics rather than the illustrative response text in the concept.

### Additional rendered states

- English desktop: `design/implementation-desktop-en.png` at 1440 × 1024.
- Korean mobile: `design/implementation-mobile-ko.png` at 390 × 844.
- English mobile: `design/implementation-mobile-en.png` at 390 × 844.
- Mobile drawer: `design/implementation-mobile-drawer-ko.png` at 390 × 844.
- Minimum-width English header: `design/implementation-mobile-320-en.png` at 320 × 568.

## Functional and accessibility verification

- Korean/English switching updates visible copy, navigation, search index, accessibility labels, document title, and `<html lang>` without losing the selected checklist step.
- Search opens from the header, filters for `202`, supports Enter selection, closes correctly, restores focus, and moves focus to the selected runbook panel.
- Checklist tabs support click plus Arrow, Home, and End keyboard movement with a roving tab stop.
- Code copy changes the button state and announces success through a polite live region.
- Dark/light theme switching was rendered and verified.
- Mobile drawer locks background scrolling, closes from its backdrop or close control, and keeps the theme control accessible inside the drawer.
- At 390 px and 320 px, document `scrollWidth` equals `clientWidth`; no page-level horizontal overflow remains. The mobile English brand truncates before the language control instead of colliding with it.
- Reduced-motion handling, visible focus treatment, semantic landmarks, dialog, listbox, tabs, labels, and icon-only control names are present.
- Browser console check after the final reload and search open/close produced no new warning or error entries. An earlier React `inert` attribute warning was fixed and retested.

## Findings

- P0: none.
- P1: none.
- P2: none.
- P3: the implementation uses a clean solid near-black background while the concept has an extremely subtle vignette/grain. This is retained as optional polish until a brand-approved texture asset exists.

## Comparison history

1. Initial desktop and responsive pass found three actionable issues: code samples lacked the concept’s line-number/syntax treatment, the mobile theme control covered document content, and the 320 px English brand collided with the language control.
2. Code samples gained real line rows and restrained syntax colors; the mobile theme control now appears only with the drawer; the mobile brand became a constrained flex item with ellipsis. Post-fix mobile evidence is saved in the 390 px and 320 px screenshots listed above.
3. The focused card comparison showed smaller text density than the source. Step labels, summaries, runbook copy, code, and next-action type tokens were adjusted while preserving the exact 974 × 652 card geometry and eliminating overflow.
4. Final full-view and focused comparisons found no remaining actionable P0, P1, or P2 differences. The only residual is the optional P3 background texture note above.

## Residual test boundaries

This is a frontend prototype. It does not execute production API requests, APNs/FCM delivery, or real-device receipt. The GitHub target is wired to the repository remote, but external navigation was not needed for visual QA.

final result: passed

## 2026-09-02 theme and guide update

- Scope: persistent dark/light mode plus real Korean/English content for `푸시 만들기`, `저니(시나리오)`, and `세그먼트`.
- Visual comparison: `design/reference-option-2.png` and the latest 1487 × 1058 in-app-browser capture were both inspected with `view_image`. The fixed 245 px sidebar, 72 px top bar, near-black palette, border density, typography hierarchy, and compact documentation chrome remain aligned with the accepted concept.
- Requested visual deviation: an explicit theme switch was added to the top utility row and the mobile top bar. The original fixed sidebar switch remains on desktop.
- Content fidelity: the original first viewport copy and checklist order are unchanged. The new guide library is below the checklist and uses the existing panel, code, warning, accent, and spacing families.
- Interaction evidence: all three sidebar links now have distinct hashes and visible document headings; dark/light switching updates `data-theme`, browser `color-scheme`, body background, and `theme-color`; the choice survives reload; Korean/English switching preserves the selected guide.
- Responsive evidence: at 390 × 844 the mobile menu, language, theme, and search controls remain reachable. A first pass exposed a 553 px document width caused by the guide grid's min-content sizing; `minmax(0, 1fr)`, `min-width: 0`, and wrapping constraints reduced final `scrollWidth` to the 390 px viewport width.
- Palette evidence: light-mode text, muted text, accent, success, warning, and control-border tokens were darkened to maintain AA-oriented contrast on white and light-gray surfaces.
- Core path checked: sidebar → guide anchor → guide workflow/code/note → theme switch → language switch → reload persistence.
- Above-the-fold copy diff: no unrequested hero, navigation, or checklist copy was added, removed, or reordered. The only header addition is the requested theme control.
- Remaining intentional deviations: the optional background grain from the source concept is still omitted because no approved texture asset exists. Production API execution and real APNs/FCM receipt remain outside this frontend verification.

final result: passed
