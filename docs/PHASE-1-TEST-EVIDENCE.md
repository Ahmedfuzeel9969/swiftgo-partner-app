# Phase 1 — Test Evidence

**Audit date:** 2026-07-29  
**Emulator:** Firebase Emulator Suite, project `demo-swiftgo-phase1`  
**Safety:** No production Firestore/Storage writes; no billing enablement; account limits respected in suites

---

## 1. Task 6 — Cross-app contract map (20 scenarios)

Source suite: `tests/phase1-emulator-contract.mjs` via `npm run test:phase1`  
**Exit code: 0** · Results file: `tests/phase1-emulator-results.json` (regenerated this run)

| # | Test name | Expected | Actual | Status | Evidence / Rules |
|---|-----------|----------|--------|--------|------------------|
| 1 | T01-customer-create-driver-read-open | Customer creates searching ride; invited driver can read | Succeeded | **PASS** | `rides` create + get; candidate seeded admin |
| 2 | T02-driver-accept-customer-sees-driver | Client accept denied; trusted assign visible to customer | Denied + seed visible | **PASS** | Client accept branch denied |
| 3 | T03-dual-accept-second-denied | Second driver cannot accept | Denied | **PASS** | rides update |
| 4 | T04-non-assigned-driver-update-denied | Other driver cannot set arrived | Denied | **PASS** | rides |
| 5 | T05-customer-skip-to-completed-denied | Customer cannot jump to completed | Denied | **PASS** | rides |
| 6 | T06-driver-skip-stages-denied | Driver cannot skip to completed | Denied | **PASS** | rides |
| 7 | T07-suspended-driver-online | Blocked partner cannot set vehicle online | Denied | **PASS** | vehicles + partners |
| 8 | T08-customer-fare-tamper | Customer fare update on accepted denied | Denied | **PASS** | rides |
| 9 | T09-driver-wallet-increase-denied | Self walletBalance denied | Denied | **PASS** | partners |
| 10 | T10-owner-other-vehicle-denied | Cross-owner vehicle update denied | Denied | **PASS** | vehicles |
| 11 | T11-owner-not-super-admin | Self `admin_driver` denied | Denied | **PASS** | partners |
| 12 | T12-super-admin-block-driver | Bootstrap admin can set blocked | Succeeded | **PASS** | partners (Admin action; audit log write not asserted in this test — see Unverified) |
| 13 | T13-invalid-ride-create-denied | Missing fields denied | Denied | **PASS** | isValidRide |
| 14 | T14-client-driver-completion-denied | Client complete+commission denied | Denied | **PASS** | rides |
| 15 | T15-duplicate-completion-denied | Repeat client complete denied | Denied | **PASS** | rides |
| 16 | T16-customer-cancel-searching | Searching → cancelled_by_user | Succeeded | **PASS** | rides (note: CF uses cancelled_by_customer) |
| 17 | T17-unauth-read-denied | Unauthenticated get denied | Denied | **PASS** | rides (= logout/unauth) |
| 18 | T18-ride-requests-create-denied | Legacy create denied | Denied | **PASS** | ride_requests |
| 19 | T19-driver-partner-wallet-batch-denied | Batch wallet debit denied | Denied | **PASS** | partners |
| 20 | T20-storage-kyc-privacy | Owner R/W KYC; other user denied | Pass | **PASS** | storage.rules |

**Totals:** passed **20** · failed **0** · blocked **0**

### Coverage notes vs Task 6 wording

| Requirement | Coverage |
|-------------|----------|
| Simultaneous accept exactly one succeeds | Rules deny second **client** accept; **server TX** dual-finalize covered in phase2a race tests (not T03 alone) |
| Super Admin actions logged | T12 proves block write; **ledger/`audit_logs` write not asserted in T12** → partial |
| Stale session / account status | T07 blocked online; Auth disable mid-session **not** emulator-tested |
| Invalid status transitions | T05/T06/T14/T15 |
| Cancellation financial effect | Rules cancel only; settlement cancel covered in cancel-contract suite |
| Duplicate completion wallet | Client path denied; CF idempotency in settlement / phase2a |

---

## 2. Additional emulator suites (this audit)

| Suite | Command | Exit | Pass | Fail | Blocked |
|-------|---------|------|------|------|---------|
| Phase 2B run-all | `npm run test:phase2b` | 0 | **91** | 0 | 0 |
| Phase 2A bargaining | emulator + `phase2a-bargaining-suite.mjs` | 0 | **21** | 0 | 0 |
| False-success booking | `booking-false-success-suite.mjs` | 0 | **23** | 0 | 0 |
| Ghost / expiry | `ghost-rides-…-suite.mjs` | 0 | **39** | 0 | 0 |
| Cancel contract | `booking-cancellation-contract-suite.mjs` | 0 | **18** | 0 | 0 |
| Driver reach | `booking-driver-reach-suite.mjs` | 0 | **11** | 0 | 0 |

**Emulator R/W:** Suites print dispatch debug; Phase 3B historically measured geo reads (~24 vehicles local). Exact counters vary per run — not billed (demo emulator).

---

## 3. Build & static quality gates

| Gate | Command | Exit | Notes |
|------|---------|------|-------|
| Four-app hosting build | `npm run build:hosting` | **0** | customer, partner, owner, admin packaged |
| i18n purity | `npm run test:i18n` | **0** | 368 EN/UR keys; 0 leftovers |
| Static audit | `npm run test:audit` | **1** | **255 PASS / 2 FAIL** |
| Lint | — | N/A | No ESLint script for apps |
| Typecheck | — | N/A | Vanilla JS, no tsc project |

### Audit FAIL details (not silently fixed)

1. **Phase 16.2 searching-for-driver UI state** — static wiring assertion failed (`tests/audit.test.mjs`).  
2. **Partner auth routes strictly by saved role** — static wiring assertion failed (likely intentional no-redirect of owner role on `/partner/` per later product decision).

---

## 4. Task 2 startup evidence

| App | Build artifact | Start model |
|-----|----------------|-------------|
| Customer | `hosting-dist/index.html`, `/customer/` | Static; entry `js/app.js` |
| Driver | `hosting-dist/partner/` | `js/driver-app.js` |
| Owner | `hosting-dist/owner/` | `js/owner-app.js` |
| Admin | `hosting-dist/admin/` | `js/admin-app.js` |

Live HTTP probes inside audit (read-only): `/` and key JS → **200**, projectId `swiftgo-ride-app`.

Playwright `test:phase2e` / interactive console errors: **not re-run** this audit → Unverified.

---

## 5. Aggregate counts (this audit window)

| Category | Passed | Failed | Blocked | Skipped / N/A |
|----------|--------|--------|---------|---------------|
| Phase1 contract (Task 6) | 20 | 0 | 0 | 0 |
| Focused booking suites | 91 | 0 | 0 | 0 |
| Phase2b | 91 | 0 | 0 | 0 |
| Phase2a bargaining | 21 | 0 | 0 | 0 |
| Build hosting | 1 | 0 | 0 | 0 |
| i18n | 1 | 0 | 0 | 0 |
| Static audit checks | 255 | 2 | 0 | 0 |
| Lint/typecheck | — | — | — | N/A |
| phase2e browser | — | — | — | Unverified |

No placeholder security tests were marked PASS without execution.

---

## 6. Secrets / PII

No API secrets, service-account keys, CNIC images, phone numbers, or production customer UIDs are included in this evidence.
