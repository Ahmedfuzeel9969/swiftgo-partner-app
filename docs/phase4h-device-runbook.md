# Phase 4H — Device / field runbook

**Audience:** Internal testers with synthetic accounts  
**Apps:** Customer web or AAB, Partner web or AAB, Owner closed web/AAB  
**Admin:** Web only — do not install on Play

## Preconditions

1. `adb devices` shows the handset (USB debugging on).  
2. Install from local AAB/APK **or** open Hosting URLs — do not use public Play listing until separately approved.  
3. Follow `docs/phase4h-synthetic-accounts.md`.  
4. Capture pass/fail into `docs/PHASE-4H-PILOT-EVIDENCE.md` and incidents into `docs/PHASE-4H-INCIDENT-LOG.md`.

## Matrix (mark each row)

| # | Scenario | Customer | Partner | Notes |
|---|---|---|---|---|
| 1 | Fresh install / cold start | ☐ | ☐ | |
| 2 | Android 10 / 12 / 13 / 14 / 15 sample | ☐ | ☐ | At least two OS versions |
| 3 | Weak mobile data (throttle) | ☐ | ☐ | |
| 4 | Airplane mode mid-flow then restore | ☐ | ☐ | |
| 5 | GPS off | ☐ | ☐ | Expect clear UX |
| 6 | Location permission denied | ☐ | ☐ | |
| 7 | Partner background location while online | — | ☐ | Battery exemption note |
| 8 | Force-stop app → reopen mid-ride | ☐ | ☐ | Auth rehydrate |
| 9 | Phone reboot mid-ride | ☐ | ☐ | |
| 10 | Double-tap book / accept | ☐ | ☐ | |
| 11 | Blocked / suspended user | ☐ | ☐ | Ops-prepared flag |
| 12 | KYC upload privacy (no cross-user read) | — | ☐ | |
| 13 | PIN lockout after bad attempts | — | ☐ / Owner ☐ | |
| 14 | Ride history visible; receipt honesty | ☐ | ☐ | Stub receipt remains disabled if unimplemented |
| 15 | Support + account deletion request | ☐ | ☐ | |
| 16 | Ops health callable (admin) | Admin ☐ | | `getOpsHealthSummary` |
| 17 | Rollback dry-run documented | Ops ☐ | | See Phase 4F rollback doc |

## Evidence capture

For each FAIL: screenshot + approximate time + app build (`1.0.0-phase4g` / versionCode `10000`) + short note.  
Do not paste tokens, PINs, or KYC images into git.
