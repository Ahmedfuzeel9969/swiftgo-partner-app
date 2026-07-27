# Phase 2C — End-to-End Test Evidence

**Date:** 2026-07-27  
**Project under test:** `demo-swiftgo-phase1` (emulators only)  
**Production Firebase:** not touched

---

## Commands

| Command | Exit code | Evidence |
|---------|-----------|----------|
| `npm run test:phase1` | `0` | `tests/phase1-emulator-results.json` |
| `npm run test:phase2c` | `0` | `tests/phase2c-emulator-results.json`, `tests/phase2c-e2e-results.json`, `tests/phase2c-canonical-audit-results.json`, `tests/phase2b-emulator-results.json` |
| `npm run build:hosting` | `0` | `hosting-dist/` packaged (no deploy) |
| `npm run test:i18n` | `0` | stdout purity scan |
| `npm run test:audit` | `1` | `tests/audit-results.json` (237 pass / 20 fail — pre-existing UI/wiring; not Phase 2C security/settlement blockers) |

Phase 2C aggregate (2A + 2B + E2E + canonical audit): **passed=114 failed=0 blocked=0**.

---

## Journey coverage (Phase 2C E2E)

| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| C01 Functions exports | Matching, bargaining, assignment, booking gate, settlement, PIN link, admin claims exported | all present | **PASS** |
| C02 Candidate limits 10/20 | 10 and 20 select; invalid rejected | n10=10 n20=20 invalidRejected=true | **PASS** |
| C03 Admin claim transition | Bootstrap claim; ordinary denied; revoke; bootstrap disable | all flags true | **PASS** |
| C04 PIN migration | Plaintext removed; hash present | proven | **PASS** |
| C05 PIN link | Link OK; no pin in response | ok | **PASS** |
| C06 Booking + match | Booking created; blocked driver not candidate | cands≥1 blockedCand=false | **PASS** |
| C07 Bargain + counter + assign | Counter then single assignment | status=accepted fare=310 | **PASS** |
| C08 One active ride | Second offer blocked | DRIVER_HAS_ACTIVE_RIDE | **PASS** |
| C09 Four booking limit | Fifth rejected | MAX_ACTIVE_BOOKINGS | **PASS** |
| C10 Settlement once | Commission/earnings/ledger/audit once; repeats idempotent | ledger=1 wallet/earnings match | **PASS** |
| C11 Unauthorized settle | Wrong driver denied | NOT_ASSIGNED_DRIVER | **PASS** |

Evidence file: `tests/phase2c-e2e-results.json`.

---

## Prior blocked tests

| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| T08 customer fare tamper | Denied | Denied | **PASS** |
| T20 KYC storage privacy | Owner OK; other denied | As expected | **PASS** |

---

## Canonical sources audit

| Test | Status | Notes |
|------|--------|-------|
| A01–A12 | **PASS** (12/12) | No client plaintext PIN query; settlement partners-only; no app writes to `ride_requests`; wallets aligned |

Remaining intentional legacy note: `driver-app/js/RideRequestDetail.js` sourceCollection branch for archive-aware reads (non-writing) — **A12 PASS**.

Trusted Admin fallback `functions/pin-link.js` may query legacy `pin` during migration only.

---

## Functions completeness

Exported and exercised (module / Admin SDK against emulators):

- matching (`validateCandidateDriverLimit`, `selectCandidatesProgressive`, `matchRideCandidates`)
- bargaining / counter / finalize assignment
- customer booking gate / four-booking limit
- settlement (`settleRide` / `completeRideSettlement` export)
- PIN linking (`linkVehicleByPin`)
- Super Admin claims (`bootstrapAdminClaim`, `grantAdminClaim`, `revokeAdminClaim`, `setAdminEmailBootstrap`)

Note: Phase 2C harness started Auth + Firestore + Storage emulators. Core logic was invoked in-process against those emulators. Full Cloud Functions **runtime** emulator HTTPS round-trip was not required for these module proofs and was not used as a production substitute.

---

## E2E journey verdict

**PASS** — complete booking → bargain → assign → limits → settle-once path verified on emulator.
