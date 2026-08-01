# Phase 5 — Display-only local road snapping

## Scope

Visual/navigation aid only. Does **not** alter Firestore vehicle locations, ride mirrors, P2P envelopes, fare, or settlement.

Canonical order: Raw GPS → Phase 3 validation/arbitration → Phase 5 projection/confidence → route-progress smoothing → one marker renderer.

## Thresholds (test starting values)

| Constant | Value | Role |
|----------|-------|------|
| `SNAP_HIGH_DISTANCE_M` | 25 m | High-confidence corridor |
| `SNAP_MAX_DISTANCE_M` | 55 m | Max ordinary snap |
| `SNAP_HEADING_TOLERANCE_DEG` | 55° | When speed ≥ 1.5 m/s |
| `SNAP_HEADING_MIN_SPEED_MPS` | 1.5 | Ignore heading below |
| `SNAP_LOCAL_WINDOW` | 12 segments | Bounded search |
| `SNAP_POOR_ACCURACY_M` | 40 m | Widen max snap cautiously; never force distant snap |
| `PROGRESS_JITTER_M` | 12 m | Hold on minor backward jitter |
| `OFF_ROUTE_MIN_FIXES` | 3 | Sustained evidence |
| `OFF_ROUTE_DISTANCE_M` | 65 m | Outside corridor |
| `OFF_ROUTE_SUSTAIN_MS` | 15 s | Duration |
| `REROUTE_COOLDOWN_MS` | 75 s | Bounded reroute |

## Karachi-specific risks

Dense parallel roads, service lanes, flyovers, underpasses, multi-level roads, GPS drift near tall buildings, slow traffic, U-turns, one-way roads. Continuity + heading + local window mitigate parallel mis-snaps; poor accuracy never forces a distant snap.

## Provider

Default live provider remains **disabled**. Public OSRM preview is not production. No paid Roads/map-matching/route APIs enabled.
