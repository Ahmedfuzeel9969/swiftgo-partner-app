# Package P1-A — Baseline Snapshot (pre-change)

**Captured:** 2026-08-05 (before P1-A runtime edits)  
**Scope:** Idle / waiting driver Firebase location publish only.

---

## Current runtime behaviour (idle / no active ride)

| Behaviour | Current value |
|-----------|----------------|
| Idle policy name | `CHECKPOINT_POLICY.NO_ACTIVE_RIDE` |
| Idle write rule | Force OR status change OR **moved ≥ 200 m** OR **interval elapsed** OR zone/cell change |
| Idle interval | **`IDLE_LOCATION_INTERVAL_MS = 300_000` (5 minutes)** |
| Idle movement threshold | **`MIN_LOCATION_MOVE_M = 200`** |
| First online / re-online | Force write (`writeOnlineReadyVehicle` / `force: true`) |
| Storage | Overwrite latest `vehicles/{id}.location` (no history collection) |
| Config source | **Hard-coded module constants** (not in `settings/dispatch`) |

### Active-ride / P2P (unchanged by P1-A — recorded for comparison)

| Item | Current |
|------|---------|
| Responsive Firebase (visible, P2P down) | ~4 s (`RESPONSIVE_INTERVAL_MS`) |
| Sparse / background | 30 s trip / 60 s approach |
| P2P location send target | ~3 s (`P2P_SEND_INTERVAL_MS`) |
| P2P fallback silence | 30 s |
| Customer Firebase render throttle | 15 s |

### Dispatch (unchanged by P1-A)

| Item | Current |
|------|---------|
| Candidate driver limit | `settings/dispatch.candidateDriverLimit` (default 10) |
| Search radius | `settings/dispatch.maxSearchRadiusKm/Meters` (default ~3 km) |
| Search timeout | 3 minutes booking-level |
| Per-offer timeout | Not implemented |

### Timers / listeners (idle path)

| Kind | Location |
|------|----------|
| GPS | `navigator.geolocation.watchPosition` in `driver-app.js` |
| Write gate | `checkpointPolicy.evaluateWriteGate` per fix |
| Refresh listener | `vehicles.locationRefreshRequestedAt` → force republish |
| No dedicated idle setInterval | Cadence is gate-based on GPS callbacks |

### Firebase write frequency (idle estimate)

- Stationary online driver: **≈ 1 write / 5 min** (+ force on online / refresh).
- Moving: up to **1 write / 200 m** (can be more frequent than 5 min).

### P2P publish frequency

- Not used for Phase 1 idle waiting path as primary; P2P is post-contact (Phase 2).

---

## Files / symbols that P1-A may touch (reversible list)

| File | Functions / symbols |
|------|---------------------|
| `driver-app/js/location-checkpoint-policy.mjs` | `IDLE_LOCATION_INTERVAL_MS`, `MIN_LOCATION_MOVE_M`, `resolveCheckpointPolicy`, `createCheckpointPolicyController` |
| `driver-app/js/driver-app.js` | `checkpointPolicy` init; `syncVehicleLocationToFirestore` move threshold; **new** settings listener |
| `functions/bargaining.js` | `readDispatchSettings` |
| `functions/index.js` | `setCandidateDriverLimit` (merge new keys) |
| `super-admin-panel/index.html` | Dispatch form fields |
| `super-admin-panel/js/admin-app.js` | `loadDispatchSettings`, `saveDispatchSettings` |
| Tests asserting idle = 300000 | Must still pass against **default** constants |

**Must NOT change in P1-A:** offer timeout, P2P, backup policies, ride accept, customer UI, matching algorithm.

---

## Intended post–P1-A behaviour (no silent cadence change)

- Defaults remain **5 min** and **200 m** (current runtime).
- Values become readable from `settings/dispatch`.
- Super Admin can change them (e.g. set interval to **180000** for approved spec example of 3 min).
