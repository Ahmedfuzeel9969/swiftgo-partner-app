# Phase 1 — Test Evidence

**Date:** 2026-07-27  
**Environment:** Windows, Node v24.16.0, Firebase CLI 15.22.0  
**Production Firebase:** Not written to. Emulator project: `demo-swiftgo-phase1`.

---

## Build

```text
Command: node tools/build-hosting.mjs
Exit code: 0
Output: hosting-dist/ (customer root + /customer, /partner, /owner, /admin)
```

---

## Static / repo tests

### `node tests/audit.test.mjs`

```text
Exit code: 1
Failure: SyntaxError importing customer-app/js/firebase-config.js (ESM export in .js while package.json "type":"commonjs")
```

No suite counts — process exited before assertions.

### `node tests/i18n-purity-scan.mjs`

```text
Exit code: 1
EN keys: 308 · UR keys: 308
UR latin leftovers: 1 (driverOfferCounterLabel)
```

### `npm test`

```text
Exit code: 1
Message: "Error: no test specified"
```

---

## Firestore emulator contract tests

**Harness:** `tests/phase1-emulator-contract.mjs`  
**Rules file:** `firestore.rules` (production copy, unmodified)  
**Dependency install (audit only):** `@firebase/rules-unit-testing@3.0.4`, `firebase@10.14.1` (devDependencies)

```text
Command: firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/phase1-emulator-contract.mjs"
Exit code: 1 (3 failed assertions — security expectations not met)
Artifact: tests/phase1-emulator-results.json
```

| # | Test name | Expected | Actual | Result |
|---|-----------|----------|--------|--------|
| T01 | Customer create; driver read open ride | Allow | Allow | **PASS** |
| T02 | Driver accept; customer sees driver | Accept | Accept | **PASS** |
| T03 | Dual accept second driver | Deny | Deny | **PASS** |
| T04 | Non-assigned driver update | Deny | Deny | **PASS** |
| T05 | Customer skip to completed | Deny | **Allow** | **FAIL** |
| T06 | Driver skip stages to complete | Deny | Deny | **PASS** |
| T07 | Suspended driver online | — | — | **BLOCKED** |
| T08 | Customer fare tamper | — | — | **BLOCKED** |
| T09 | Driver increase wallet | Deny | **Allow** | **FAIL** |
| T10 | Owner edit other vehicle | Deny | Deny | **PASS** |
| T11 | Owner become super admin | Deny | Deny | **PASS** |
| T12 | Super admin block driver | Allow | Allow | **PASS** |
| T13 | Invalid ride create | Deny | Deny | **PASS** |
| T14 | Valid driver completion | Allow | Allow | **PASS** |
| T15 | Duplicate completion | Deny | Deny | **PASS** |
| T16 | Customer cancel searching | Allow | Allow | **PASS** |
| T17 | Unauthenticated read | Deny | Deny | **PASS** |
| T18 | ride_requests client create | Deny | Deny | **PASS** |
| T19 | Driver partner wallet batch | Deny | **Allow** | **FAIL** |
| T20 | Storage KYC privacy | — | — | **BLOCKED** |

**Totals:** 14 PASS, 3 FAIL, 3 BLOCKED (of 20 scenarios)

### Interpretation of FAIL rows

- **T05, T09, T19:** Tests expected secure behavior; Firestore allowed insecure operations — documented as **product/rules failures**, not harness bugs.

---

## Storage rules

**Not executed** in emulator harness. Static review:

- `storage.rules`: `driver_applications/{userId}/{fileName}` owner-only; default deny.

---

## Browser / E2E

**BLOCKED** — no Playwright/Cypress config; not run to avoid production interaction.

---

## Emulator read/write counts

Not instrumented in harness (Firebase Emulator UI / logs only). Qualitative: each test seeds via `withSecurityRulesDisabled` then performs 1–3 ruled operations.

---

## Commands summary

| Command | Exit |
|---------|------|
| `node tools/build-hosting.mjs` | 0 |
| `node tests/audit.test.mjs` | 1 |
| `node tests/i18n-purity-scan.mjs` | 1 |
| `npm test` | 1 |
| `firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/phase1-emulator-contract.mjs"` | 1 |
