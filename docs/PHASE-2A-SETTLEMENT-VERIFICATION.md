# Phase 2A — Settlement Verification

**Trusted entry point:** Cloud Function `completeRideSettlement` (`functions/index.js`)  
**Core logic:** `functions/settlement.js` `settleRide()`  
**Emulator proof:** `tests/phase2a-settlement-only.mjs` (Admin SDK = same code path as CF)

---

## Settlement algorithm

1. Authenticate caller (callable) / pass `callerUid` in tests  
2. Require assigned driver or admin  
3. Transaction-read ride + ledger + pricing  
4. Require `status == in_progress`  
5. Reject cancelled / wrong status / missing driver / blocked driver  
6. Gross fare from ride `farePkr` / `estimatedFare` / `driverBidFare` (not client input)  
7. Commission % from `settings/pricing` (server)  
8. Compute `commissionAmount`, `driverEarnings`  
9. Idempotency key / ledger id: `settle_{collection}_{rideId}`  
10. Write ledger (immutable), update ride completed + settlement fields  
11. Increment partner `totalEarnings`, `totalRidesCompleted`; decrement `walletBalance` by commission  
12. Write `audit_logs` entry  
13. Retry returns `alreadySettled: true` without double posting  

---

## Emulator results (F15–F24)

| Test | Result |
|------|--------|
| F15 simultaneous completion → one ledger | PASS |
| F16 no duplicate commission (wallet −35) | PASS |
| F17 no duplicate earnings / ride count | PASS |
| F18 no duplicate ledger | PASS |
| F19 invalid/negative fare rejected | PASS |
| F20 cancelled cannot complete | PASS |
| F21 completed not re-settled financially | PASS |
| F22 trusted completion consistent (35/315) | PASS |
| F23 wrong driver denied | PASS |
| F24 audit + trustedCreator recorded | PASS |

---

## Client wiring

| App | Path |
|-----|------|
| Driver | `completeRideWithEarnings` → `requestRideSettlement` |
| Owner | same |
| Customer | `completeRideRequest` throws `SETTLEMENT_SERVER_ONLY` |

---

## Deploy note (not done in Phase 2A)

Functions must be deployed before production clients can complete rides. Emulator/`localhost` uses `connectFunctionsEmulator`. Until deploy, production completion will fail closed (no client financial write path remains).
