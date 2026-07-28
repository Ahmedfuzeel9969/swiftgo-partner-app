# Free-Tier Post-4H Execution

**Date:** 2026-07-28  
**User constraint:** All work must stay within **free / no-cost** limits.  
**Prior override:** Phase 3C ZERO/NO-COST — still in force.

## What this approval allows (free)

| Action | Status |
|---|---|
| Git Main merge of Phase 4B–4H stack | **Allowed** (no Firebase charge) |
| Local emulator / Node test suites | **Allowed** |
| Documentation / runbooks | **Allowed** |
| Sideload already-built local AABs to own devices | **Allowed** (no Play / no cloud deploy) |

## What remains blocked under no-cost

| Action | Why blocked |
|---|---|
| Production Firebase deploy (Hosting / Functions / Rules / Indexes / Storage) | Phase 3C: cannot prove $0; default project is Production |
| Dedicated Blaze staging deploy | No approved staging project + Blaze written approval |
| Enable / change billing | Forbidden |
| Play Console upload | Separate publish surface; not started under this free pass |
| Paid advertising | Explicitly forbidden |
| Load / soak / paid traffic generation against Production | Quota + cost risk |

## Caps if a future paid/monitored path is approved later

Reuse Phase 3C internal caps (not Firebase guarantees): ≤20 drivers, ≤10 customers, ≤10 complete rides, ≤200 Function invocations, etc.

## Decision

Proceed with **Main fast-forward merge only** + free local verification.  
**No cloud deploy. No Play upload. No ads. No Blaze changes.**
