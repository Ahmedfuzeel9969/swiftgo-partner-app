# Phase 2D — Full Regression

**Date:** 2026-07-27  
**Production Firebase:** not touched  
**Billing / Blaze:** not enabled

---

## Commands and exit codes

| Command | Exit | Key totals | Evidence |
|---------|-----:|------------|----------|
| `npm run test:phase1` | 0 | 20 pass / 0 fail / 0 blocked | `tests/phase1-emulator-results.json` |
| `npm run test:phase2c` | 0 | 114 pass / 0 fail / 0 blocked | `tests/phase2c-emulator-results.json` |
| `npm run test:audit` | 0 | 257 pass / 0 fail | `tests/audit-results.json` |
| `npm run test:i18n` | 0 | EN/UR pure | stdout |
| `npm run build:hosting` | 0 | `hosting-dist/` packaged | build log |
| `npm run test:phase2d` | 0 | 13 pass / 0 fail / 0 blocked | `tests/phase2d-functions-runtime-results.json` |

---

## Aggregate

| Metric | Count |
|--------|------:|
| Passed (listed suites) | 20 + 114 + 257 + 13 = **404** assertion/cases (+ i18n/build OK) |
| Failed | **0** |
| Blocked security/settlement | **0** |
| Skipped | **0** |

Phase 1–2C regressions remain green. Hosting build succeeds. Functions callable suite green.

---

## Required result checklist

- [x] 0 unexplained failures  
- [x] 0 blocked security/settlement tests  
- [x] Phase 1–2C green  
- [x] Hosting build succeeds  
- [x] New Functions-runtime tests green  
