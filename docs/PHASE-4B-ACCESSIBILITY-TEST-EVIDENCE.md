# PHASE 4B — Accessibility Test Evidence

**Date:** 2026-07-28  
**Branch:** `phase-4b-accessibility`  
**Production touched:** **No**

## Commands and exit codes

| Command | Exit | Passed | Failed | Blocked | Skipped |
|---|---:|---:|---:|---:|---:|
| `npm run test:phase4b-a11y` | **0** | 9 | 0 | 0 | 0 |
| `npm run test:phase4a-ui` | **0** | — | — | — | — |
| `npm run test:phase1` | **0** | 20 | 0 | 0 | 0 |
| `npm run test:phase2c` | **0** | 114+ | 0 | 0 | 0 |
| `npm run test:phase2d` | **0** | 13 | 0 | 0 | 0 |
| `npm run test:phase2e` | **0** | 43 | 0 | 0 | 0 |
| `npm run test:phase3a` | **0** | 12 | 0 | 0 | 0 |
| `npm run test:phase3b` | **0** | 22 | 0 | 0 | 0 |
| `npm run test:audit` | **0** | 257 | 0 | 0 | 0 |
| `npm run test:i18n` | **0** | PASS | 0 | 0 | 0 |
| `npm run build:hosting` | **0** | PASS | 0 | 0 | 0 |

Summary JSON: `tests/phase4b-regression-summary.json`  
A11y JSON: `tests/phase4b-a11y-results.json`  
UI audit JSON: `tests/phase4a-ui-results.json` (post-fix: **findings = 0**)

## Phase 4A expected outcomes (after 4B)

| Expectation | Result |
|---|---|
| Missing accessible names on identified controls | **0** |
| Unlabeled `#addStopBtn` | **0** |
| Horizontal overflow P1 | **0** |

## Phase 4B a11y suite detail

| Test | Status |
|---|---|
| customer_required_names | PASS |
| customer_keyboard_moves | PASS |
| partner_required_names | PASS |
| partner_auth_focus_contained | PASS |
| owner_auth_focus_contained | PASS |
| admin_required_names | PASS |
| admin_auth_focus_contained | PASS |
| reduced_motion_css | PASS |
| a11y_helpers_packaged | PASS |

## Keyboard results (manual / automated sample)

- Customer: Tab moves across map / links / Where-to / layers (see `phase4b-a11y-results.json` order).
- Partner / Owner / Admin auth: focus remains on dialog focusables; Escape does not dismiss required login gates.
- Customer auth modal: Escape closes via focus-trap `onDismiss`.

## Urdu / English label checks

- Admin finance labels bilingual (Urdu / English) on rate, wallet, dispatch, promo fields.
- Partner recharge / notification labels bilingual.
- Customer form labels use existing `data-i18n` strings; EN/UR dictionaries retained.

## Screen-reader-oriented DOM checks

- Live region helper `announce()` injects `#swiftgoA11yLive` (`role=status`, `aria-live=polite|assertive`).
- Required controls expose `label[for]`, wrapping `<label>`, `aria-label`, or `aria-labelledby`.

## Evidence paths

- `docs/phase4b-a11y-evidence/*.png`
- `docs/PHASE-4B-ACCESSIBILITY-FIX-REPORT.md`
- `docs/PHASE-4B-ACCESSIBILITY-TEST-EVIDENCE.md` (this file)

## Verdict linkage

Supports Phase 4B overall **PASS**. No tests were deleted, skipped, or weakened.
