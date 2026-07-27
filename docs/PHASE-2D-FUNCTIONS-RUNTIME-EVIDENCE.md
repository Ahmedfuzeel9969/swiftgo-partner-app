# Phase 2D — Functions Runtime Evidence

**Date:** 2026-07-27  
**Command:** `npm run test:phase2d`  
**Emulators:** Auth, Firestore, Storage, Functions (`demo-swiftgo-phase1`)  
**Exit code:** `0`  
**Evidence:** `tests/phase2d-functions-runtime-results.json`  
**Production:** not touched

---

## Method

Client SDK (`firebase` Auth + Functions) signed in on Auth emulator and invoked **HTTPS callables** on Functions emulator (`us-central1`, host `127.0.0.1:5001`). This is not in-process module invocation.

---

## Results (13/13 PASS)

| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| R00 client region/names | `us-central1` + correct names; booking via CF | all true | **PASS** |
| R01 unauth denied | create denied without auth | denied | **PASS** |
| R02 createCustomerBooking | returns ride id | id returned | **PASS** |
| R03 match limits 10/20 | match works; limit 20 accepted | cands≥1 / limit 20 | **PASS** |
| R04 submitRideOffer | offer id | ok | **PASS** |
| R05 counterRideOffer | status countered | ok | **PASS** |
| R06 finalizeAssignment | accepted + driver | ok | **PASS** |
| R07 one-active-ride | DRIVER_HAS_ACTIVE_RIDE | blocked | **PASS** |
| R08 four-booking limit | fifth MAX_ACTIVE_BOOKINGS | denied | **PASS** |
| R09 settlement idempotent | one ledger; alreadySettled | ok | **PASS** |
| R10 unauthorized settle | NOT_ASSIGNED_DRIVER | denied | **PASS** |
| R11 linkVehicleByPin | ok, no pin echoed | ok | **PASS** |
| R12 admin claims | bootstrap/grant/revoke/toggle; ordinary denied | ok | **PASS** |

Totals: **passed=13 failed=0 blocked=0 skipped=0**

---

## Auth context & errors

- Authenticated callables received `auth: VALID` in Functions logs.
- Unauthenticated callers denied.
- Controlled codes observed via callable errors (`failed-precondition` messages include `DRIVER_HAS_ACTIVE_RIDE`, `MAX_ACTIVE_BOOKINGS`, `NOT_ASSIGNED_DRIVER`, `BOOTSTRAP_DISABLED`).
- Repeat settlement returned `alreadySettled` with a single ledger row.

---

## Client configuration

Customer, driver, and owner apps use `getFunctions(app, "us-central1")` and `connectFunctionsEmulator(..., 5001)` on localhost. Callable names match exports in `functions/index.js`.
