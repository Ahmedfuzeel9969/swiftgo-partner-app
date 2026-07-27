# PHASE 3A — Residual Risks

**Date:** 2026-07-27  
**Verdict context:** CONDITIONAL PASS expected — audit complete; Blaze not financially “ready” for medium/large without further approved architecture work.

---

## Residual risks (still open)

| ID | Risk | Severity | Mitigation status |
|---|---|---|---|
| R1 | `matchRideCandidates` scans **all** online/`in_ride` vehicles | **P0** | Documented only — needs geo/hotspot scoped match approval |
| R2 | Admin fleet monitor may keep **vehicles** listener while map closed | **P1** | Map path fixed; fleet monitor not fully scoped |
| R3 | Dual listeners when admin map + fleet monitor both active | **P1** | Partial |
| R4 | Firebase location fallback may remain after P2P recovery | **P1** | Needs dedicated automated proof |
| R5 | Four concurrent bookings × bargain listeners | **P2** | Accepted business rule |
| R6 | Emulator measurement pollution (leftover online vehicles across scenarios) | **P2** (test accuracy) | Documented in per-ride report |
| R7 | Listener deliveries not emulator-metered → billable read uncertainty | **P2** | Ranges used in cost estimate |
| R8 | Storage KYC large downloads | **P2** | Process/thumbnail recommendation only |
| R9 | Hosting/Auth/SMS not in Phase 3A meters | **P3** | Monitor after Blaze |
| R10 | Prior Production deploy exists outside this phase; Storage rules historically failed setup | **P2** | Ops follow-up — **not acted on in 3A** |

---

## Explicit non-actions (this phase)

- Production Firebase not modified  
- Blaze / billing not enabled  
- Budgets not created  
- No deploy of Functions / Rules / Hosting / indexes  
- No Production PIN migration / admin claim bootstrap  
- No change to candidate 10/20, rings, bargain caps, concurrent booking caps  

---

## Blaze-controlled deployment financially ready?

| Scale | Ready? |
|---|---|
| Tiny pilot with budget alerts + daily review | **Conditionally yes** |
| Early (100 drivers) | **Conditional** — monitor location + match |
| Medium / Large | **No** until R1 addressed under separate approval |

---

## Next approvals needed (not started)

1. Deploy 3A client optimizations (60s location, admin map detach, count aggregate) if not already in a prior user-approved deploy.  
2. Enable Blaze + budget **alerts** (with correct “not a hard cap” wording).  
3. Separate phase for geo-scoped matching / admin listener architecture.
