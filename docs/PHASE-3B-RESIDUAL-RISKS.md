# PHASE 3B — Residual Risks

**Date:** 2026-07-27

| ID | Risk | Severity | Notes |
|---|---|---|---|
| R1 | Vehicles without `geoCell` (old clients / never synced) are **not matched** | P1 | Mitigate by deploying client location sync + one-time backfill (separate approval) |
| R2 | Dense Golden Hotspot can still return large online sets for one `hotspotId` | P1 | Bounded by hotspot, not city; monitor |
| R3 | Sequential partner reads for inspected drivers | P2 | Optimize with getAll / denormalized accountStatus later |
| R4 | Indexes must be deployed before Production traffic or queries fail | P0 at deploy | Gate in deployment doc |
| R5 | Emulator metrics ≠ Production billing export | P2 | Validate in staging Usage dashboard |
| R6 | Admin fleet listeners / location writes (Phase 3A) still dominate non-match cost | P1 | Unchanged by 3B |
| R7 | In-memory `onlineDrivers` path remains for unit fixtures | P3 | Callable path cannot use it |

## Not changed (by design)

Bargaining caps, booking caps, P2P, settlement, UI redesign.
