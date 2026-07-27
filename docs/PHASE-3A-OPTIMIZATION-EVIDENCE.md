# PHASE 3A — Optimization Evidence

**Date:** 2026-07-27  
**Rule followed:** Only low-risk waste removal; **no** change to approved 10/20 candidates, rings, bargain caps, P2P rules, or 1-minute location policy (policy aligned code to the approved model).

Production was not deployed as part of this phase’s “stop after reporting” gate. Code fixes are local; activation requires separate deploy approval.

---

## OPT-1 — Location write interval 8s → 60s + zone grid

| | |
|---|---|
| **Files** | `driver-app/js/driver-app.js`, `owner-app/js/owner-app.js` |
| **Change** | `VEHICLE_LOCATION_WRITE_MS = 60_000`; `LOCATION_GRID_DEG`; skip write unless minute elapsed or grid cell changes |
| **Business model** | Implements approved 1-minute + zone-change (does **not** invent a new policy) |
| **Pre-fix** | 3600/8 = **450 writes / driver-hour** (timed) |
| **Post-fix** | 3600/60 = **60 writes / driver-hour** timed (+ zone extras) |
| **Measured reduction** | **87%** timed writes (`LOC-model-8s-vs-60s` PASS) |
| **Automated test** | `OPT-location-1min`, `LOC-model-8s-vs-60s` in `tests/phase3a-per-ride-measurement.mjs` |

---

## OPT-2 — Detach Super Admin fleet map listener off live-map

| | |
|---|---|
| **File** | `super-admin-panel/js/admin-app.js` (`setActiveView`) |
| **Change** | Call `stopFleetMap()` whenever active view ≠ `live-map` |
| **Pre-fix** | Map listener could remain after navigating away (unbounded vehicle read fan-out) |
| **Post-fix** | Listener lifecycle tied to map view |
| **Automated test** | `OPT-admin-map-detach` PASS |

---

## OPT-3 — Replace unbounded rides collection listener with count aggregate

| | |
|---|---|
| **File** | `super-admin-panel/js/admin-app.js` |
| **Change** | `getCountFromServer(collection(db,"rides"))` + refresh interval; remove `onSnapshot(collection(db,"rides"))` for totals |
| **Pre-fix** | Every ride create/update could bill a read to admin session (unbounded growth) |
| **Post-fix** | Aggregation read periodically (bounded) |
| **Automated test** | `OPT-admin-no-unbounded-rides-listener` PASS |

---

## Pre / post summary

| Optimization | Pre | Post | Reduction |
|---|---|---|---|
| Location timed writes / driver-hour | 450 | 60 | **87%** |
| Admin map listener off-view | potentially active | detached | **100% of map listener cost when closed** |
| Admin total-rides full listen | 1 doc read per ride mutation while logged in | periodic count | **unbounded → O(1) per poll** |

**Not claimed:** End-to-end Production bill reduction % (no Production metering in Phase 3A).

---

## Regression

See `docs/PHASE-3A-TEST-EVIDENCE.md`. Optimizations gated by Phase 3A tests; full suite required green before any future deploy approval.
