# Design QA — Journey ZIP email template sheet (option 2)

## Comparison target

- Source visual truth: `/Users/youngjoo/.codex/generated_images/01a0602e-bd95-7251-845d-965babbb8b35/exec-90b0d3c2-9665-44a6-965d-ad7a663bd855.png`
- Rendered implementation: `/private/tmp/nudgeon-journey-template-sheet-final2-1487x1058.png`
- Responsive evidence: `/private/tmp/nudgeon-journey-template-sheet-mobile-760x900.png`, `/private/tmp/nudgeon-journey-template-sheet-mobile-pass2-390x844.png`
- Full-view combined comparison: `/private/tmp/nudgeon-design-qa-comparison-pass2.png`
- Focused sheet comparison: `/private/tmp/nudgeon-design-qa-comparison-focused-pass2.png`
- Route: `http://localhost:3000/journeys/e8925a7b-2de9-4b1f-9120-a643889d5425`
- State: draft journey, email message selected, `review-request.zip` imported, right-side sheet open, Desktop preview selected.

## Viewport and normalization

- Source pixels: 1487 × 1058.
- Implementation pixels: 1487 × 1058.
- Implementation CSS viewport: 1487 × 1058 CSS px.
- Device scale factor: 1; no density resampling was needed.
- The source is a 1487 × 1058 design frame and was compared directly to an equal-pixel browser capture.
- Responsive captures use 760 × 900 and 390 × 844 CSS px at 1× density.

## Findings

- No actionable P0, P1, or P2 differences remain in the final comparison.
- P3 — the selected concept uses a flat bag illustration while the QA ZIP contains a generated product photograph with the same teal shopping-bag subject. This is expected dynamic email-template content, not fixed application chrome. The asset is a real raster image and remains sharp at Desktop and Mobile widths.
- P3 — the ZIP file tile reuses NudgeOn's existing message icon instead of introducing a one-off document icon. This preserves the product icon family; a future shared file icon can refine the semantic cue.

## Required fidelity surfaces

- Fonts and typography: the existing Inter/Pretendard stack, Korean wrapping, weights, line heights, and compact hierarchy match the selected direction. The sheet title, checks, controls, and sticky-footer copy remain readable without truncation at tested widths.
- Spacing and layout rhythm: the final sheet is 720 px wide at desktop, begins below the 66 px product topbar, keeps the journey canvas visible, and uses a fixed action footer. At 900/901 px the width is continuous; at 760 px and below it becomes a full-screen sheet.
- Colors and tokens: the surface, border, sea-green accent, pale canvas, success state, and focus colors use the Journey token system. Small muted copy was strengthened for AA contrast in light mode and retains the existing dark-mode token.
- Image quality and asset fidelity: the ZIP's real JPEG hero is inlined as a data URI, remains sharp, and is framed without stretching. No CSS art, placeholder box, emoji, handcrafted illustration, or inline SVG substitutes the visible email asset.
- Copy and content: `템플릿 적용 전 미리보기`, ZIP validation labels, `Desktop`/`Mobile`, `새로고침`, `취소`, and `이 템플릿 사용` are coherent and match the selected workflow. Status copy distinguishes `적용 전` from `현재 HTML에 적용됨`.
- Icons: visible application icons reuse the established `JourneyIcon` stroke family and remain aligned at the tested sizes.
- Accessibility: the dialog has an accessible title, empty iframe sandbox, descriptive iframe title, visible keyboard focus, explicit Escape handling, focus return to the preview launcher, no hidden file-input tab stop, and 44 px mobile actions.

## Interaction and runtime evidence

- Direct HTML → ZIP template switching works.
- Visible file chooser imports a ZIP and the sheet opens only after inspection completes.
- `다른 ZIP 선택` closes the modal layer before opening the external file input.
- Latest-import generation guarding prevents an older asynchronous ZIP read from overwriting a newer choice.
- Desktop/Mobile preview widths switch correctly; Mobile measured 390 px inside the desktop sheet.
- `새로고침` remounts the sandbox preview.
- Applying copies the inlined HTML into the current journey and changes the save state to `저장 전`.
- Switching back to direct HTML exposes an editable 70,623-character value containing the inlined JPEG and preserving `{{ name }}`.
- Undo restores the original HTML and returns the save state to `저장됨`.
- Escape closes the sheet and returns focus to `미리보기`.
- A ZIP containing `<script>` is rejected with a blocking error; no dialog opens and the existing HTML is unchanged.
- No browser warnings/errors were present in the final state, and the sandbox preview had no non-data image sources.

## Comparison history

### Pass 1 — blocked

Evidence: `/private/tmp/nudgeon-journey-template-sheet-pass1-1487x1058.png`

- P1: the visually hidden file input inherited the inspector's `width: 100%`, expanded the document to 2604 px, and scrolled the editor 1132 px horizontally when the sheet opened.
- P2: the 18% blurred backdrop obscured the canvas that option 2 was intended to preserve.
- P2: the header and preview stage were too compressed, leaving the email preview cropped above the primary CTA.

Fixes:

- Replaced the inherited hidden-input styling with a truly hidden, non-tabbable file input; added modal scroll-position restoration and document scroll locking.
- Removed backdrop dimming.
- Converted the sheet body/preview to a fill layout and narrowed the email viewport for the selected composition.

### Pass 2 — blocked

Evidence: `/private/tmp/nudgeon-journey-template-sheet-pass2-1487x1058.png`

- P1: code review found that overlapping ZIP reads could let an older import overwrite the latest file.
- P2: the 680 px sheet was visibly narrower than the selected source's roughly 720 px region.
- P2: programmatic modal focus exposed a prominent close-button focus ring in a pointer-opened visual state.
- P2: 641–760 px topbar overlap, a 900/901 px width discontinuity, and small-screen horizontal overflow remained.
- P2: the source-mode label, muted-text contrast, and focus return needed accessibility corrections.

Fixes:

- Added import-generation guarding, stale-result suppression, and immediate sheet closing during replacement import.
- Set the desktop sheet to 720 px, used a focusable heading without a decorative outline for initial focus, and sized footer actions to the selected composition.
- Made the sheet full screen at 760 px and below, unified the width formula above that breakpoint, and locked root/body scroll while open.
- Replaced the orphan form label with `aria-labelledby`, strengthened muted text, preserved topbar focus-visible styling, and restored focus to the visible preview button.

### Pass 3 — passed

Evidence: `/private/tmp/nudgeon-journey-template-sheet-final2-1487x1058.png`, `/private/tmp/nudgeon-design-qa-comparison-pass2.png`, `/private/tmp/nudgeon-design-qa-comparison-focused-pass2.png`

- Full-view comparison confirms the selected option-2 composition: compact product topbar, palette and journey canvas retained, wide contextual sheet, ZIP checks, large preview, and sticky footer.
- Focused comparison confirms the title, file summary, validation row, viewport controls, email frame, and action hierarchy are aligned with the source direction.
- The 760 × 900 and 390 × 844 captures show no overlap or document-level horizontal scrolling, with persistent footer actions.
- No actionable P0/P1/P2 findings remain.

## Implementation checklist

- [x] Keep the existing Journey design system and canvas behavior.
- [x] Support direct HTML and ZIP template modes.
- [x] Inspect and preview before applying.
- [x] Inline local CSS/images and isolate preview content.
- [x] Preserve existing dirty/save/undo behavior.
- [x] Verify desktop, intermediate, and mobile layouts.
- [x] Verify keyboard close/focus, invalid ZIP rejection, and browser console state.
- [x] Pass build, typecheck, tests, and `git diff --check`.

## Follow-up polish

- P3: add a shared file/archive icon to the product icon set when the broader console icon library is formalized.
- P3: run an additional Safari file-picker smoke test before treating browser compatibility as release proof.

final result: passed
