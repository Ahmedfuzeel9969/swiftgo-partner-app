# PHASE 3A — Location Cost Model

**Date:** 2026-07-27  
**Approved architecture preserved** (not redesigned):

- Local continuous tracking on device  
- **One Firebase location snapshot per minute** while online  
- **Additional write on zone change** (~1 km grid: `LOCATION_GRID_DEG = 0.009`)  
- No permanent high-frequency ride-location history collection  
- P2P after assignment; Firebase fallback only when required  
- Owner / Super Admin live map listeners only while map open (admin map detach optimized in 3A)

**Code:** `driver-app/js/driver-app.js`, `owner-app/js/owner-app.js` — `VEHICLE_LOCATION_WRITE_MS = 60_000`.

---

## Assumptions (explicit)

| Assumption | Value | Rationale |
|---|---|---|
| Online hours per driver per day | **10 h** | Karachi shift mix |
| Timed Firebase writes | **1 / min** = 60 / h | Approved |
| Extra zone-change writes | **4 / h** | City traffic; grid ~1 km |
| Total writes / online-driver-hour | **64** | 60 + 4 |
| Writes / online-driver-day | **640** | 64 × 10 |
| Days / month | **30** | Calendar approx. |
| Trip P2P success rate (ops model) | **80%** | Fallback hours use same 1/min rule |
| Old model (comparison only) | **1 write / 8 s** = 450 / h | Historical accidental pattern — **not implemented** |

---

## Online-driver scales (presence only)

| Online drivers | Writes / hour | Writes / day | Writes / month |
|---:|---:|---:|---:|
| 10 | 640 | 6,400 | 192,000 |
| 50 | 3,200 | 32,000 | 960,000 |
| 100 | 6,400 | 64,000 | 1,920,000 |
| 1,000 | 64,000 | 640,000 | 19,200,000 |
| 10,000 | 640,000 | 6,400,000 | 192,000,000 |

Firestore free allowance (Standard, daily): **20,000 writes / day**.  
→ **~31 online drivers** at this model saturate free write quota on location alone (20,000 / 640 ≈ 31).

---

## Approved vs old 8-second model

| Model | Writes / driver-hour | vs approved |
|---|---:|---|
| Old 8 s Firebase write | 450 | baseline waste |
| Approved 60 s only | 60 | **−86.7%** |
| Approved 60 s + 4 zone/h | 64 | **−85.8%** |

Test gate `LOC-model-8s-vs-60s`: timed-only saving **87%** (`3600/8` → `3600/60`).

| Online drivers | Old writes / day | Approved writes / day | Writes saved / day |
|---:|---:|---:|---:|
| 10 | 45,000 | 6,400 | 38,600 |
| 100 | 450,000 | 64,000 | 386,000 |
| 1,000 | 4,500,000 | 640,000 | 3,860,000 |
| 10,000 | 45,000,000 | 6,400,000 | 38,600,000 |

**Illustrative write-cost only** (us-central1 Standard **$0.09 / 100k writes**, ignoring free tier):

| Online drivers | Old $/month (writes) | Approved $/month | Saving |
|---:|---:|---:|---:|
| 100 | ≈ $12.15 | ≈ $1.73 | ~86% |
| 1,000 | ≈ $121.50 | ≈ $17.28 | ~86% |
| 10,000 | ≈ $1,215 | ≈ $173 | ~86% |

Taxes/FX not included. Free tier reduces small-pilot bills toward $0 for location alone.

---

## Listener / dashboard coupling

| Surface | Location-related reads |
|---|---|
| Driver app | Own vehicle doc updates (~1/min) while online |
| Owner live fleet (open) | Each owned vehicle update delivered as listener read |
| Admin live map (open) | Each visible vehicle update; **stops when map closed** (3A OPT) |
| Admin fleet monitor (logged in) | Still may receive vehicle snapshots independently of map — residual P1 |

---

## P2P vs Firebase fallback (during assigned trip)

| Mode | Extra Firebase location writes during trip |
|---|---|
| P2P success | **0** beyond normal online presence snapshot |
| P2P fail / fallback | Same **1/min + zone** (no return to 8 s) |

Do **not** keep fallback writers active after P2P recovers (recommendation — verify in residual risks).
