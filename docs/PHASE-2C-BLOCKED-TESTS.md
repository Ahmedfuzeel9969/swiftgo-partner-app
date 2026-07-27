# Phase 2C — Previously Blocked Tests (T08 / T20)

**Date:** 2026-07-27  
**Status after Phase 2C:** both **PASS** (executed; not skipped)

---

## Summary

Phase 1 / Phase 2B left exactly **two** security tests as **BLOCKED**. Phase 2C identified, classified, unblocked, and re-ran them on the local emulator harness.

| Test ID | Prior status (Phase 2B) | Phase 2C status |
|---------|-------------------------|-----------------|
| **T08** | BLOCKED | **PASS** |
| **T20** | BLOCKED | **PASS** |

Evidence: `tests/phase1-emulator-results.json`, `tests/phase2a-emulator-results.json` (merged via `phase2c-run-all`).

---

## 1. T08 — Customer fare tamper after accept

| Field | Detail |
|-------|--------|
| **Test ID** | `T08-customer-fare-tamper` |
| **Purpose** | Prove a customer cannot update `farePkr` / `estimatedFare` / `driverBidFare` on an accepted ride |
| **Prior block reason** | Marked beyond Phase 1 harness scope even though F06 covered a similar path; not executed as T08 |
| **Affected feature** | Fare integrity after assignment (rides Rules) |
| **Classification** | **Test / harness gap** (not a code defect). Rules already denied the update (also covered by F06) |
| **Unblock requirement** | Add explicit T08 `assertFails(updateDoc(...fare...))` in Phase 1 + Phase 2A suites and execute under Firestore emulator |
| **Unblock action taken** | Implemented and executed in `tests/phase1-emulator-contract.mjs` and `tests/phase2a-emulator-suite.mjs` |
| **Command** | `npm run test:phase1` / `npm run test:phase2c` |
| **Expected** | Customer fare update denied |
| **Actual** | Denied; status **PASS** |
| **Exit code** | `0` (Phase 1 standalone) |

---

## 2. T20 — KYC Storage privacy

| Field | Detail |
|-------|--------|
| **Test ID** | `T20-storage-kyc-privacy` |
| **Purpose** | Owner can write/read KYC under `driver_applications/{uid}/…`; another authenticated user cannot read |
| **Prior block reason** | Storage emulator not included in the Phase 1/2B harness (`--only firestore`) |
| **Affected feature** | Storage rules for driver application / KYC privacy |
| **Classification** | **Missing emulator capability in harness** (environment/harness limitation), not a known Rules defect |
| **Unblock requirement** | Start Storage emulator; load `storage.rules`; run upload + cross-user read denial |
| **Unblock action taken** | `firebase.json` Storage emulator port `9199`; npm scripts use `--only firestore,storage`; T20 uses `@firebase/rules-unit-testing` + `uploadBytes` / `getDownloadURL` |
| **Command** | `npm run test:phase1` / `npm run test:phase2c` |
| **Expected** | Owner write/read succeeds; other user read fails |
| **Actual** | As expected; status **PASS** |
| **Exit code** | `0` (Phase 1 standalone) |

---

## Residual blocked security/settlement tests

**None** unexplained after Phase 2C. Production-readiness is no longer held by T08/T20.
