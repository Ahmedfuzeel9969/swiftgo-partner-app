## Summary

Fixes the T3 driver-readiness race: drivers were marked online before Firestore had fresh `location`, `locationUpdatedAt`, and `geoCell`, causing initial `matchRideCandidates` to return zero (`geo_scoped_plus_capped_probe`) until a later rematch.

- **Driver app:** OFFLINE → LOCATING → WRITING_GEO → ONLINE_READY state machine; radar/offer inbox start only after successful geo write
- **Backend:** authoritative `candidateCount` after rematch; probe fallback requires valid `geoCell`; geo/dispatch fixes from safety branch
- **Firestore rules:** new `isDriverVehicleOnlineReadyUpdate()` for combined `writeOnlineReadyVehicle()` client payload (owner vehicle policy unchanged from main)
- **Customer UI:** separate booking created vs search pending vs drivers invited toasts
- **Emulator tests:** dispatch E2E, readiness race (CASE A/B), authenticated driver ONLINE_READY rules

## Test results (branch tip `6392d01`)

| Suite | Result |
|-------|--------|
| `npm run test:dispatch-online-ready-rules` | **8/8 PASS** |
| `npm run test:dispatch-readiness` | **21/21 PASS** |
| `npm run test:dispatch-e2e` | **23/23 PASS** |
| `npm run test:ci-preview` | **PASS** (13 pass, 1 blocked emulator) |
| `node tests/booking-false-success-suite.mjs` | **13/13 PASS** (1 blocked emulator) |
| `node -e "require('./functions/index.js')"` | **PASS** |
| `npm run build:hosting` | **PASS** |
| `node tests/audit.test.mjs` | **235/238 PASS** — **3 pre-existing failures** (unchanged by this PR) |

## Production & deploy status

- **Production is unchanged** — no live customer/driver impact from this branch alone
- **Firebase has not been deployed** from this PR
- After merge approval, deploy **Firestore rules, Cloud Functions, and Hosting together** (preview workflow deploys Hosting only; it cannot validate new Functions/rules behavior)

## Test plan

- [x] Emulator dispatch + readiness + rules suites pass locally
- [ ] PR Preview — Tests and Firebase Hosting workflow passes
- [ ] Manual: driver online → customer booking → driver radar invitation (requires full backend deploy post-merge)
