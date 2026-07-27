# Phase 2A — Test Evidence

**Generated:** 2026-07-27  
**Verdict: CONDITIONAL PASS**

---

## Pre-fix (Phase 1 baseline)

From earlier Phase 1 run (`tests/phase1-emulator-results.json` pre-remediation era):

| Test | Pre-fix |
|------|----------|
| T05 | FAIL (customer could complete) |
| T09 | FAIL (wallet self-increase) |
| T19 | FAIL (partner wallet batch) |

---

## Commands and exit codes

```bash
npm run test:phase2a
# firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/phase2a-run-all.mjs"
# Exit code: 0

npm run test:phase1
# firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/phase1-emulator-contract.mjs"
# Exit code: 0
```

No production Firebase access. Project ID: `demo-swiftgo-phase1`.

---

## Post-fix totals

### `npm run test:phase2a` (merged)

| Metric | Value |
|--------|-------|
| Passed | **64** |
| Failed | **0** |
| Blocked | **3** |
| Exit | **0** |

Breakdown:

| Suite | Passed | Failed | Blocked | Exit |
|-------|--------|--------|---------|------|
| Rules (`phase2a-emulator-suite`) | 33 | 0 | 3 | 0 |
| Settlement (`phase2a-settlement-only`) | 10 | 0 | 0 | 0 |
| Bargaining (`phase2a-bargaining-suite`) | 21 | 0 | 0 | 0 |

Blocked (unchanged harness limits): T07, T08, T20.

### `npm run test:phase1`

| Metric | Value |
|--------|-------|
| Passed | **17** |
| Failed | **0** |
| Blocked | **3** |
| Exit | **0** |

---

## Required individual results

| Case | Result | Evidence |
|------|--------|----------|
| **T05** | **PASS** | Customer cannot complete ride |
| **T09** | **PASS** | Driver cannot increase wallet |
| **T19** | **PASS** | Partner wallet batch denied |
| Simultaneous driver assignment | **PASS** | B17 `driver=race-d1 fulfilled=fulfilled,rejected` |
| Four-booking race | **PASS** | B12 `ok=1 fail=1 count=4` |
| Duplicate settlement | **PASS** | F15–F18 ledgerCount=1; wallet=-35 once |
| Candidate limit 10 / 20 | **PASS** | B02, B03 |
| Invalid candidate limit | **PASS** | B06 `INVALID_CANDIDATE_LIMIT` |
| 11th bargain rejected | **PASS** | B20 `MAX_OPEN_BARGAINS` |
| Expired offer not accepted | **PASS** | B16 |
| Bargaining ≠ assigned | **PASS** | B14 |

Artifacts: `tests/phase2a-emulator-results.json`, `tests/phase2a-settlement-results.json`, `tests/phase2a-bargaining-results.json`, `tests/phase1-emulator-results.json`.

---

## Production touch confirmation

**Confirmed: production Firebase was not touched.**
