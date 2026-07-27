# PHASE 3B — Geo Matching Design

**Date:** 2026-07-27  
**Status:** Implemented (emulator-validated); **not deployed**

## Problem

`matchRideCandidates` previously loaded **all** `vehicles` with `status in [online, in_ride]` and then partner docs for each — O(online fleet). Candidate limit 10/20 only capped **writes**, not match reads (Phase 3A P0).

## Approved rules preserved

| Rule | How preserved |
|---|---|
| Progressive 1 → 2 → 3 km | Rings still applied after geo load |
| Candidate limit 10 or 20 | Super Admin `settings/dispatch` only (clients cannot bump) |
| Karachi Golden Hotspots | `hotspotId` + 0.5 km radius centers |
| General grid ≈ 300–500 m | `MATCH_GRID_DEG = 0.0036` ≈ **400 m** |
| Exclude offline / stale / blocked / suspended / busy | Eligibility gate + `status == online` queries |
| Bargain ≤10 / one active ride / ≤4 bookings | Unchanged bargaining modules |
| 1-min location + zone-change | Unchanged write throttle; match cells written alongside |
| P2P + Firebase fallback | Untouched |

## Design

### Vehicle fields (written on location sync)

| Field | Purpose |
|---|---|
| `geoCell` | `g_{i}_{j}` matching cell (~400 m) |
| `hotspotId` | Nearest Golden Hotspot id if within 0.5 km, else null |
| `locationGridCell` | Zone-change throttle cell (may differ from match cell) |
| `location` / `locationUpdatedAt` | Haversine + stale filter (3 minutes) |

### Match algorithm

1. Read ride pickup + dispatch settings (limit 10|20).  
2. For ring R in `[1, 2, 3]` km:  
   - Compute grid cells intersecting disk(pickup, R).  
   - Compute Golden Hotspots intersecting that disk.  
   - Query `vehicles` where `status == "online"` and `geoCell in (…)`, chunked by 10.  
   - Query `hotspotId in (…)` similarly.  
   - Deduplicate by `driverId`.  
   - Enrich partner docs for newly seen drivers.  
   - Run `selectCandidatesProgressive` (true haversine, nearest-first).  
   - Stop when enough candidates within current ring (or limit filled).  
3. Write only invited `ride_candidates` (trusted CF / Admin SDK).

### Trust boundary

- Callable rejects `onlineDrivers` / `candidates` injection.  
- Non-admin callers cannot override `candidateDriverLimit`.  
- Clients cannot create/update `ride_candidates` (existing rules).

### Indexes required

Composite:

- `vehicles`: `status` ASC + `geoCell` ASC  
- `vehicles`: `status` ASC + `hotspotId` ASC  

## Modules

| File | Role |
|---|---|
| `functions/geo-cells.js` | Grid / hotspot math |
| `functions/geo-match.js` | Progressive geo queries + metrics |
| `functions/matching.js` | Eligibility + progressive selection |
| `functions/bargaining.js` | `matchRideCandidates` geo default |
| `functions/index.js` | Callable — no full-fleet scan |
| driver/owner location sync | Persist `geoCell` / `hotspotId` |

## Cost property

Match reads scale with **drivers (and cells) near the pickup**, not with city-wide online count. Distant online vehicles outside queried cells are not read.
