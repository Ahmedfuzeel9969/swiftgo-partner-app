# Phase 2B — Security Test Evidence

**Date:** 2026-07-27  
**Verdict: CONDITIONAL PASS**

---

## Pre-fix (from Phase 2A residual)

| Item | Pre-fix |
|------|----------|
| T07 blocked driver online | BLOCKED |
| Dual wallet | Open (P1-007) |
| drivers broad write | Open (P1-008) |
| Vehicles readable by all signed-in | Open (P1-011) |
| PIN query brute-force | Open (P1-018) |
| ride_requests writable progression | Partial (create denied only) |
| Admin email always trusted | Open (P1-004 partial) |

---

## Commands and exit codes

```text
npm run test:phase1
→ exit 0
  passed=18 failed=0 blocked=2

npm run test:phase2b
→ exit 0
  phase2a-run-all: passed=65 failed=0 blocked=2
  phase2b-security: passed=24 failed=0 blocked=0
  merged: passed=89 failed=0 blocked=2

npm run build:hosting
→ exit 0
  packaged hosting-dist/ (no deploy)
```

Project: `demo-swiftgo-phase1` emulator only.

---

## Post-fix highlights

| Case | Result |
|------|--------|
| T05 / T09 / T19 | PASS (regression) |
| **T07** | **PASS** — blocked cannot go online |
| S02 ordinary ≠ Super Admin | PASS |
| S03 revoked claim no access | PASS |
| S05 bootstrap disabled → email denied | PASS |
| S08 partners wallet only on settle | PASS (`partners=-20`, `users=50` unchanged) |
| S09 legacy settlement denied | PASS |
| S12 vehicle privacy | PASS |
| S14 blocked cannot bargain | PASS |
| S19 PIN lockout | PASS |
| B17 one assignment / B12 four-booking race / F15 duplicate settle | PASS (Phase 2A regression inside phase2b-run-all) |

Artifacts: `tests/phase1-emulator-results.json`, `tests/phase2a-emulator-results.json`, `tests/phase2b-security-results.json`, `tests/phase2b-emulator-results.json`.

---

## Production confirmation

**Confirmed: Production Firebase was not touched.**
