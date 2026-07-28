# PHASE 4D — Real Device / Viewport Evidence

**Date:** 2026-07-28  
**Branch:** `phase-4d-responsive-visual`  
**Harness:** `npm run test:phase4d` → `tests/phase4d-responsive-verify.mjs`  
**Summary:** `tests/phase4d-regression-summary.json`

## Device availability

| Device class | Available in this run? | Method |
|---|---|---|
| Small Android phone (physical) | **No** — not attached to this workstation | Deferred to pilot |
| Larger Android phone (physical) | **No** | Deferred to pilot |
| Playwright Chrome viewports | **Yes** | Proxy for responsive matrix |

Physical Android evidence remains a **pilot checklist item** (Phase 4H). Safe-area CSS (`viewport-fit=cover` + `env(safe-area-inset-*)`) is present in all four apps; keyboard inset uses `visualViewport`.

## Automated viewport / language checks

| Check | Result | Evidence |
|---|---|---|
| Customer Where-to EN | PASS | Live DOM `#whereToTrigger` |
| Customer Where-to UR + `dir=rtl` | PASS | `customer-where-to-urdu.png` |
| Landscape map ≥120px height | PASS | metrics in results JSON |
| Landscape sheet ≤55% viewport | PASS | `customer-landscape-sheet.png` |
| Partner auth EN + `dir=ltr` | PASS | `partner-auth-en.png` |
| Owner auth EN + `dir=ltr` | PASS | `owner-auth-en.png` |
| Admin login shell | PASS | `admin-login.png` |
| Safe-area / focus / landscape CSS present | PASS | static CSS assertions |

**Totals:** 21 PASS / 0 FAIL (`tests/phase4d-responsive-results.json`)

## Regression (same session)

| Suite | Exit | Notes |
|---|---:|---|
| `npm run test:phase4d` | **0** | 21/0 |
| `npm run test:phase4b-a11y` | **0** | 9/0 |
| `npm run test:audit` | **0** | 257/0 |

## Screenshot index

| File | What it shows |
|---|---|
| `docs/phase4d-responsive-evidence/customer-where-to-urdu.png` | Urdu “کہاں جانا ہے؟” after sidebar lang switch |
| `docs/phase4d-responsive-evidence/customer-landscape-sheet.png` | 844×390 landscape map + capped sheet |
| `docs/phase4d-responsive-evidence/partner-auth-en.png` | Partner English auth |
| `docs/phase4d-responsive-evidence/owner-auth-en.png` | Owner English auth |
| `docs/phase4d-responsive-evidence/admin-login.png` | Admin login shell |

## Pilot device checklist (for Phase 4H)

- [ ] Small Android (≤360 CSS px): notch safe-area, keyboard over PIN/auth fields  
- [ ] Larger Android (≥390 CSS px): landscape map usable with sheet expanded  
- [ ] Partner EN/UR toggle after Google sign-in (authenticated chrome)  
- [ ] Owner EN/UR toggle on fleet view  

---

**STOP — Phase 4E not started. Await approval.**
