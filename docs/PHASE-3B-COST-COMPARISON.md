# PHASE 3B — Cost Comparison

**Date:** 2026-07-27  
**Pricing reference:** Firestore Standard us-central1 — $0.03 / 100k reads (beyond free tier). Taxes excluded.  
**Evidence:** `tests/phase3b-matching-results.json` scaleRows

## Old vs new match-path reads

**Old model (removed):** for each match, read all online vehicles + one partner doc each ≈ **2 × onlineCount** document reads (plus settings/ride).

**New model:** cell/hotspot queries only → `vehicleDocsRead + partnerDocsRead` from metrics.

### Measured scale (candidate limit 10, low/normal local density)

| Total online | Old reads (model) | New reads (measured) | Measured reduction |
|---:|---:|---:|---:|
| 100 | 200 | **60** | **70.0%** |
| 1,000 | 2,000 | **86** | **95.7%** |
| 10,000 | 20,000 | **92** | **99.5%** |

Vehicle docs alone: 30 / 43 / 46 — **does not grow with city-wide fleet**.

### Candidate limit 10 vs 20

Limit changes **returned candidate writes**, not the geo query set. Extra cost for 20 is primarily up to +10 candidate document writes and slightly more partner enrichment if more drivers are inspected before filling — not a full-fleet multiplier.

### Density notes

| Area | Behavior |
|---|---|
| Low density | May expand rings to 2–3 km → more cells queried; still bounded by disk |
| Normal | Often fills at 1 km (~35 cells chunked) |
| High-density hotspot | Extra `hotspotId` query; more vehicle docs **inside** hotspot — worst local case, still not city-wide |

### Estimated match-read cost impact (illustrative)

Using measured 10k case: 20,000 → 92 reads/match.  
At $0.03/100k: old ≈ $0.006/match vs new ≈ $0.000028/match **for the match scan component only** (ignoring free tier).  

Do **not** treat as whole-app bill savings — location writes and listeners remain (Phase 3A).

### Indexes

Required composites (added to `firestore.indexes.json`, **not deployed in this phase**):

- `vehicles(status, geoCell)`  
- `vehicles(status, hotspotId)`  

### Remaining scaling limits

- Hotspot with thousands of concurrent online vehicles still returns many docs for that hotspot query.  
- Partner get-per-inspected-driver remains O(inspected); future batching possible.  
- Vehicles missing `geoCell` are invisible to geo match until next location sync.
