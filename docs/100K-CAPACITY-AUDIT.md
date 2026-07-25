# 100K Capacity Audit — Existing Test Review (Part A)

**Status:** BASELINE AUDIT COMPLETE — expensive distributed 100K test **NOT STARTED** (awaiting staging + cost approval)  
**Date (UTC):** 2026-07-23  
**Git HEAD (last commit):** `6a73d995239432eb48f1ad3170ca83c51915f4d8` (2026-07-22)  
**Working tree:** dirty — substantial uncommitted customer/driver/owner/admin changes exist; capacity conclusions apply to **deployed hosting** + **current workspace source** as audited this date.  
**Production Firebase project:** `swiftgo-ride-app`  
**Firestore region:** **NOT TESTED** (console location not queried this run; default multi-region US is common but unverified)  
**Load generator:** single machine `DESKTOP-HOUIG70` · Intel i5-8250U 8 threads · ~8.4 GB RAM · Node v24.16.0 · Windows 10  

---

## A1. What the previous test measured

### Artefacts inspected

| Artefact | Role |
|----------|------|
| `tests/load-capacity.mjs` | Stress HTTP GET runner |
| `tests/load-capacity-results.json` | Stress results (c=25…400, 400 req/level) |
| `tests/load-capacity-baseline.json` | Lower-c baseline (c=5…30, 200 req/level) |
| `canvases/load-capacity-report.canvas.tsx` | Human-facing summary mixing MEASURED + MODELLED |
| `tests/business-load/results/raw/a3-http-reverify.json` | Fresh A3 re-run (this audit) |

### Measurement type

**MEASURED:** HTTP `GET` of SPA **entry HTML** for `/`, `/partner/`, `/owner/`, `/admin/` against Firebase Hosting.  
**Headers:** `Cache-Control: no-cache` (attempted cold/bypass from client).  
**NOT MEASURED:** JS boot, Auth, Firestore, GPS, matching, maps, notifications.

Hosting `Cache-Control: no-store` is configured in `firebase.json` (server-side).

### Per-route stress summary (from `load-capacity-results.json`)

Common: **400 requests/level**, levels **25 / 50 / 100 / 200 / 400**, wall ≈ **10–11 s/level**, peak RPS ≈ **38–39** from this one client.

| App | c | RPS | p50 ms | p95 ms | p99 ms | max ms | success% | HTTP 4xx | HTTP 5xx | conn fail (status 0) | avg bytes |
|-----|---|-----|--------|--------|--------|--------|----------|----------|----------|----------------------|-----------|
| customer `/` | 25 | 38.8 | 196 | 486 | 10324 | 10336 | 96.5 | 0 | 0 | 3.5% | ~67 KB |
| customer | 50 | 37.7 | 192 | 1573 | 10625 | 10632 | 95.0 | 0 | 0 | 5.0% | ~66 KB |
| customer | 100 | 38.2 | 249 | 10542 | 10559 | 10564 | 77.8 | 0 | 0 | 22.3% | ~54 KB |
| customer | 200 | 38.2 | 332 | 10590 | 10609 | 10612 | 57.0 | 0 | 0 | 43.0% | ~40 KB |
| customer | 400 | 38.5 | 10472 | 10728 | — | — | 10.5 | 0 | 0 | 89.5% | — |
| driver `/partner/` | 25 | 18.9 | 193 | 10583 | — | — | 92.8 | 0 | 0 | 7.3% | — |
| driver | 50–400 | ~38 | … | climbs to ~10.5s | … | … | down to 14% | 0 | 0 | up to 86% | — |
| owner `/owner/` | 25 | 39.3 | 200 | 475 | — | — | 96.8 | 0 | 0 | 3.3% | — |
| owner | 400 | 38.8 | 10438 | 10783 | — | — | 28.0 | 0 | 0 | 72% | — |
| admin `/admin/` | 25 | 37.8 | 192 | 450 | — | — | 97.3 | 0 | 0 | 2.8% | — |
| admin | 400 | 38.4 | 10477 | 10633 | — | — | 18.8 | 0 | 0 | 81.3% | — |

Full numeric matrix: preserve `tests/load-capacity-results.json` (raw evidence).

### Baseline (c=5…30) — `load-capacity-baseline.json`

Healthy band ≈ **c≤10**: p95 ≈ **300–400 ms**, error ≤ **1%**, RPS ≈ **19**.  
At **c≥20–30**, p95 often jumps to **~10.5 s** and connection failures rise — consistent with **single-generator saturation**, not Firebase 5xx.

### Test-machine resource metrics

| Metric | Status |
|--------|--------|
| CPU during test | **NOT TESTED** (not instrumented) |
| Memory during test | **NOT TESTED** (not instrumented; machine had ~0.6 GB free at audit start) |
| Network Mbps | **NOT TESTED** |

**Inference (INFERRED):** flat ~38 RPS across concurrency + status-0 `TypeError` growth ⇒ **load generator / single-IP path saturated**. Must **not** be reported as Hosting capacity.

---

## A2. Coverage matrix of previous “load test”

| Capability | Label |
|------------|-------|
| HTTP delivery of SPA shell | **MEASURED** |
| JavaScript boot / module graph | **NOT TESTED** |
| Authentication | **NOT TESTED** |
| Firestore reads | **NOT TESTED** |
| Firestore writes | **NOT TESTED** |
| Realtime listeners | **NOT TESTED** (architecture **INFERRED** from code) |
| GPS writes | **NOT TESTED** (interval **MEASURED** from code = 8000 ms) |
| Ride creation | **NOT TESTED** |
| Driver matching | **NOT TESTED** (design **INFERRED**) |
| Ride acceptance / cancel / complete | **NOT TESTED** |
| Owner dashboard load | **NOT TESTED** |
| Admin dashboard load | **NOT TESTED** |
| Maps / tiles | **NOT TESTED** |
| Routing (OSRM) | **NOT TESTED** |
| Geocoding (Nominatim) | **NOT TESTED** |
| Push notifications (FCM) | **NOT TESTED** — FCM client **absent**; browser Notification API only (**INFERRED**) |

Previous canvas “comfortable ~200 customers + 50 drivers” = **MODELLED**, not measured.

---

## A3. Reproducibility (safe HTTP re-verify)

**Re-run:** 2026-07-23T07:33:41Z · c=5 and c=10 · 100 req/level · `tests/business-load/results/raw/a3-http-reverify.json`

| App | c | Prior baseline err% / p95 | Re-verify err% / p95 | Material difference |
|-----|---|---------------------------|----------------------|---------------------|
| customer | 5 | 1% / 347 ms | **0% / 364 ms** | Within noise |
| customer | 10 | 0.5% / 309 ms | **1% / 328 ms** | Within noise |
| driver | 5 | 0.5% / 327 ms | **2% / 283 ms** | Slightly worse err; better p95 |
| driver | 10 | 1% / 391 ms | **5% / …** (see raw) | Network variability |
| owner | 5 | 0.5% / 346 ms | **1% / …** | Within noise |
| admin | 5 | 0% / 305 ms | **1% / …** | Within noise |

**Conclusion:** Low-concurrency Hosting latency is **reproducible in order of magnitude** (~180 ms p50, ~300–400 ms p95). High-concurrency error rates from the original stress run are **not** reproducible application limits — they track **single-client overload**.

---

## A4. Verdict on “the four apps were genuinely load tested”

### **OVERSTATED** (borderline **PARTIALLY ACCURATE** if narrowly scoped to “Hosting HTML GET”)

**Why OVERSTATED**

1. Only SPA entry HTML was stressed — not authenticated platform use.  
2. Failures were connection errors from one laptop, misreadable as app limits.  
3. Business capacity numbers (~200+50 / ~800+200) were **MODELLED** but presented adjacent to measured charts without a hard MEASURED-only ceiling.  
4. No distributed generators, no Firestore exercise, no JS boot check, no integrity tests.

**What remains accurate:** Hosting returned **HTTP 200** (never 4xx/5xx in samples) for successful GETs; public demo map backends were correctly flagged as risks.

---

## Stop line

This audit **does not** approve a 100,000-user claim.  
Next gate: staging project + approved cost envelope (`docs/100K-LOAD-TEST-COST-ESTIMATE.md`) before Part E–F execution.
