# Free-Tier Remaining Work — Complete

**Date:** 2026-07-28  
**Branch:** `free-tier-local-completion` → merge to `main`  
**Billing / Blaze / Production deploy / Play upload / ads:** **Not performed**

## Completed (free only)

| Item | Result |
|---|---|
| Main already held 4B–4H | Prior merge `522921c` |
| Digital Asset Links draft + hosting package | `hosting-static/.well-known/assetlinks.json`; `build:hosting` copies it; Firebase ignore allows `.well-known` |
| Customer mobile sync no longer embeds Admin/Partner/Owner | Fixed `tools/phase4g-sync-mobile.mjs` |
| Static audit ignores generated Capacitor/Android embeds | Fixed `tests/phase2c-canonical-audit.mjs` |
| Phase 4D trust-dialog flake | Dismiss location confirm before menu clicks |
| Native shell helpers wired | Customer / Partner / Owner |
| Sideload guide (no Play) | `docs/SIDELOAD-ANDROID-FREE.md` |
| npm AAB helper scripts | `android:aab:customer|partner|owner` |
| i18n UR Latin leftover (`KYC`) | Cleared → `شناختی تصدیق` |

## Regression (free / emulator / local)

| Suite | Exit |
|---|---:|
| phase1 | 0 |
| phase2c (rerun after fixes) | 0 (114/0) |
| phase2d | 0 |
| phase3a | 0 |
| phase3b | 0 |
| phase4b-a11y | 0 |
| phase4d (rerun) | 0 (21/0) |
| phase4e | 0 |
| phase4f-storage | 0 |
| phase4f-ops | 0 |
| i18n | 0 (0 Latin leftovers) |
| phase4g | 0 |
| phase4h | CONDITIONAL (device matrix still BLOCKED — no `adb` handset) |
| audit | 0 (257/0) |

## Still impossible without leaving no-cost / needing hardware

| Item | Why |
|---|---|
| Physical device matrix | No phone on `adb` |
| Production Hosting/Functions/Rules/Storage deploy | Billing risk (Phase 3C) |
| Play Console upload | Separate publish; not free-tier scope here |
| Paid ads | Forbidden |

## Operator next (optional, still free)

1. Plug in Android handsets → run `docs/phase4h-device-runbook.md` + sideload APKs.  
2. Fill real SHA-256 into `assetlinks.json` when a future Hosting deploy is separately approved.
