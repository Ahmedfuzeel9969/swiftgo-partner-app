# PHASE 3A — Test Evidence

**Date:** 2026-07-27  
**Production Firebase modified in this phase:** No  
**Billing / Blaze enabled:** No  
**Deploys in this phase:** None  

---

## Commands & exit codes

| Command | Exit code | Passed | Failed | Blocked | Skipped |
|---|---:|---:|---:|---:|---:|
| `npm run test:phase3a` | **0** | 12 | 0 | 0 | 0 |
| `npm run test:phase1` | **0** | 20 | 0 | 0 | 0 |
| `npm run test:phase2c` | **0** | 114 | 0 | 0 | 0 |
| `npm run test:phase2d` | **0** | 13 | 0 | 0 | 0 |
| `npm run test:phase2e` | **0** | 43 | 0 | 0 | 0 |
| `npm run test:audit` | **0** | 257 | 0 | 0 | 0 |
| `npm run test:i18n` | **0** | (EN/UR 312 keys; 0 purity leftovers) | 0 | 0 | 0 |
| `npm run build:hosting` | **0** | hosting-dist packaged | — | — | — |

Phase 3A script composition:

```text
node tests/phase3a-inventory-scan.mjs
&& firebase emulators:exec --only auth,firestore,storage,functions --project demo-swiftgo-phase1
   "node tests/phase3a-per-ride-measurement.mjs"
```

Artifacts:

- `tests/phase3a-inventory-results.json`
- `tests/phase3a-per-ride-results.json`

---

## Phase 3A test breakdown (12/12 PASS)

| Test | Result |
|---|---|
| OPT-location-1min | PASS |
| OPT-admin-map-detach | PASS |
| OPT-admin-no-unbounded-rides-listener | PASS |
| LOC-model-8s-vs-60s (87% timed write cut) | PASS |
| MEAS-S1 … S4, S11, S12 | PASS |
| CMP-10-vs-20-candidates | PASS |
| S5–S10 modelled-only (no paid traffic) | PASS |

---

## Pre-fix / post-fix operation counts

| Metric | Pre-fix | Post-fix | Reduction |
|---|---:|---:|---:|
| Timed location writes / driver-hour | 450 (8 s) | 60 (60 s) | **87%** |
| Admin map listener when view ≠ live-map | potentially active | detached | **100% of that listener** |
| Admin total-rides metering | unbounded collection listen | periodic `getCountFromServer` | unbounded → O(1)/poll |

Per-ride measured baseline (S1, limit 10, minimal bargain):

| Metric | Count |
|---|---:|
| Function invocations | 5 |
| Candidates written | 10 |
| Ledger docs / ride | 1 |
| Est. server reads | 35 |
| Est. writes | 24 |
| Est. listener deliveries | 28 |

---

## Limitations

1. Emulator does not expose Production billable read meters; listeners estimated.  
2. Sequential per-ride scenarios can leave online vehicles (scan-size noise on late scenarios).  
3. S5–S10 (P2P / dashboard open-closed / 4 bookings) are **modelled**, not separately metered journeys.  
4. `npm run test:audit` includes read-only HTTP GETs against already-hosted Production URLs (`swiftgo-ride-app.web.app`) — no writes, no billing plan changes.  
5. Function CPU-seconds / Storage bytes / Hosting GiB not billed in emulator.

---

## Confirmation

- No test was weakened or skipped to obtain PASS.  
- Phase 3A stops after reporting — **no deploy, no Blaze enablement**.
