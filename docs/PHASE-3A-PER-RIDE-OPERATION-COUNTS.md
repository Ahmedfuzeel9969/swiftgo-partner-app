# PHASE 3A — Per-Ride Operation Counts

**Date:** 2026-07-27  
**Harness:** `npm run test:phase3a` → `tests/phase3a-per-ride-results.json`  
**Project:** `demo-swiftgo-phase1` (emulators only)  
**Production / Blaze / paid traffic:** None

## Measurement method

| Metered on emulator | Modelled (not emulator-billed) |
|---|---|
| Callable Function invocation counts | Listener delivery counts |
| Doc collection deltas (rides, offers, candidates, ledger, audit) | Auth session ops |
| Journey success / candidate ≤ limit / ledger idempotency | Storage bytes, Hosting egress |
| Code-path Firestore R/W estimate tied to online scan size | Exact Production billable read IDs |

**Important:** Firestore Standard bills each listener document delivery as a **read**. Emulator does not expose that meter; estimates include `listenerDeliveriesEstimate` separately. Summing estimate reads + listener deliveries approximates billable reads for UI+server path (excluding ambient admin/owner dashboards).

---

## Baseline complete ride (S1)

`booking → match → offer → assign → arrived → started → settlement`  
**Candidate limit 10, minimal bargaining, ~12 online vehicles seeded.**

| Metric | Value |
|---|---:|
| Function invocations (measured) | **5** |
| Candidates written (measured) | **10** |
| Ledger docs for ride (measured) | **1** |
| Audit docs delta (measured) | **1** |
| Estimated Firestore reads (server path) | **35** |
| Estimated Firestore writes | **24** |
| Estimated listener deliveries | **28** |
| Approx. billable reads (server + listeners) | **~63** |
| Storage / Auth | **0** in this path |

Function chain: `createCustomerBooking` → `matchRideCandidates` → `submitRideOffer` → `finalizeAssignmentFromOffer` → `completeRideSettlement`.

---

## Scenario matrix

| ID | Scenario | Invocations | Candidates | Est. reads | Est. writes | Est. listeners | Notes |
|---|---|---:|---:|---:|---:|---:|---|
| S1 | Limit 10, minimal bargain | 5 | 10 | 35 | 24 | 28 | Baseline |
| S2 | Limit 10, 3 counters | 8 | 10 | 41 | 27 | 28 | +3 counter callables |
| S3 | Limit 20, minimal | 5 | 20 | 61 | 34 | 38 | More match scan + candidate docs |
| S4 | Limit 20, 3 counters | 8 | 20 | 67 | 37 | 38 | |
| S5 | P2P success | — | — | ≈S1 | ≈S1 | ≈S1 | **Modelled:** 0 Firebase live location writes during trip |
| S6 | P2P fail → Firebase fallback | — | — | S1 + trip mins | S1 + ~1 write/min | +owner/driver listens | **Modelled:** approved 1-min fallback |
| S7 | Owner dashboard closed vs open | — | — | open adds fan-out | — | +~20 est. | Closed = no owner live listeners |
| S8 | Admin live map closed vs open | — | — | open adds vehicle snaps | — | +fleet size | **OPT:** map listener detaches when view leaves `live-map` |
| S9 | One booking | =S1 | 10 | 35 | 24 | 28 | |
| S10 | Four concurrent bookings | ≈4× booking/match/bargain | ≤40 cand peak | ≈4× | ≈4× | ≈4× listeners | Cap is business rule, not removed |
| S11 | Cancelled after match | 3 | ~10 | lower | lower | lower | No settlement/ledger |
| S12 | Settlement retried ×3 | 7 | ≤10 | +settle reads | writes stay ~1 ledger | 28 | Idempotent ledger (**1** ledger doc) |

Raw JSON: `tests/phase3a-per-ride-results.json`.

---

## 10 vs 20 candidate drivers

| | Limit 10 (S1) | Limit 20 (S3) | Delta |
|---|---:|---:|---:|
| Candidates written | 10 | 20 | **+10 writes** |
| Est. server reads | 35 | 61 | **+26** (mostly match scan partners/vehicles in seed) |
| Est. listeners | 28 | 38 | **+10** (radar fan-out) |
| Functions | 5 | 5 | 0 |
| Approx. billable reads | ~63 | ~99 | **~+57%** |

**Caveat:** Match cost scales with **online drivers scanned**, not only the candidate limit. Limit caps **writes**; an unbounded online fleet still costs O(online) reads inside `matchRideCandidates` (`vehicles where status in [online,in_ride]` + partner reads).

---

## Settlement / cancel evidence

- **S12:** three `completeRideSettlement` invocations → still **one** ledger document for the ride (idempotency holds). Extra cost = Function invocations + repeated transaction reads, not duplicate payouts.
- **S11:** cancel path completed with 3 invocations; no settlement ledger required.

---

## What cannot be mapped 1:1 to billing

1. Emulator Function CPU/GB-seconds ≠ Production Cloud Run / Functions runtime bill.  
2. Listener deliveries estimated from UI subscription patterns.  
3. Sequential scenarios share one emulator DB — later matches may see leftover `online` vehicles (S12 showed `candidatesWritten` capped by limit while prior vehicles remained). Treat absolute S12 scan size as **noisy**; relative S1↔S3 and OPT gates are reliable.  
4. Hosting transfer, Auth MAU, Storage download bytes not measured in this harness.  
5. Admin always-on fleet listeners are **ambient** and not included in the per-ride baseline.
