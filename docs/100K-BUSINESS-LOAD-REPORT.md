# 100K Business Load Report — Baseline

**Overall verdict:** **FAIL** for 100,000 concurrent users · **CONDITIONAL PASS** only for a **small commercial pilot** if traffic stays near modelled safe band and ops accepts public-map risk.  
**Date:** 2026-07-23  
**Evidence standard:** labels enforced (MEASURED / MODELLED / INFERRED / NOT TESTED)

---

## Executive answers (required numbered objectives)

| # | Question | Answer | Label |
|---|----------|--------|-------|
| 1 | Max concurrent users safely supported now | **Safe commercial ≈ 150–250 total active platform users** (≈100–200 riders + 30–50 online drivers) pending staging proof | **MODELLED** (prior HTTP-only test is not proof) |
| 2 | Max concurrently online drivers | **Safe commercial ≈ 50**; breaking risk rises sharply **>200–500** due to GPS write volume + global offer fan-out | **MODELLED** |
| 3 | Max simultaneous ride searches | **≪100** before UX/matching quality collapses (global `limit(1)` pool — all drivers see one newest ride) | **INFERRED** |
| 4 | Max sustainable ride requests /s /min | **NOT TESTED**. Modelled: even **1–2 creates/s** notifies all online drivers | **NOT TESTED** / **MODELLED** |
| 5 | First technical bottleneck | **(1)** Public OSRM/Nominatim/OSM for booking UX · **(2)** Global `searching_driver` fan-out · **(3)** GPS `updateDoc` every 8s × fleet · **(4)** Admin unbounded listeners | **INFERRED** |
| 6 | Safe commercial capacity | **≈70–80% of modelled max-stable ≈ 150–250 concurrent active sessions** until staging ladder passes | **MODELLED** |
| 7 | Gap to 100,000 | **≈400–700×** on concurrent active sessions; **worse** on matching architecture | **MODELLED** |
| 8 | Work to reach 100K | See `docs/100K-REMEDIATION-ROADMAP.md` (geo matching, Functions, GPS pipeline, aggregates, commercial maps, App Check, observability) | Plan only |
| 9 | Accuracy of prior load report | **OVERSTATED** — Hosting HTML only; Firestore numbers modelled | See audit |
| 10 | Launch readiness | Pilot: **conditional**. Regional large launch: **not ready**. Public 100K: **not ready** | Assessment |

---

## A–L scoreboard

| ID | Metric | Value | Label |
|----|--------|-------|-------|
| A | Maximum proven concurrent sessions | Hosting HTML only: low-c healthy ≈10 concurrent GETs/client; **no proven authenticated sessions** | **MEASURED** (HTML) / **NOT TESTED** (sessions) |
| B | Maximum proven active users | **0 proven** under business definition | **NOT TESTED** |
| C | Maximum proven online drivers | **0** under load harness | **NOT TESTED** |
| D | Maximum proven simultaneous ride searches | **0** | **NOT TESTED** |
| E | Maximum proven ride requests / minute | **0** | **NOT TESTED** |
| F | Maximum proven GPS updates / second | **0** runtime; code allows 0.125/s/driver | **NOT TESTED** / **INFERRED** |
| G | First failing component | Under true load: **expected** public maps then matching fan-out / GPS+admin reads | **INFERRED** |
| H | Monthly $ at max stable (modelled ~200 drivers) | Firestore GPS-dominated **~$50–150** + Hosting/Auth small + **maps unknown/illegal if public** | **MODELLED** |
| I | Monthly $ at 100K REALISTIC | Firestore GPS alone **~$3.5k–5k+**; listener reads potentially **$10k–$100k+**; commercial maps **$2k–$15k+**; total often **$20k–$150k+/mo** before redesign | **MODELLED** |
| J | Capacity multiplier still required | **~400–700×** sessions; matching redesign is **qualitative**, not linear scale-up | **MODELLED** |
| K | Commercial-readiness % (subjective) | Hosting 70 · Auth unknown · Customer 25 · Driver 15 · GPS 10 · Matching 5 · Owner 20 · Admin 10 · Maps 0 · Routing 0 · Notifications 10 · Observability 5 | Assessment |
| L | Overall verdict | **FAIL** (100K) · Pilot **CONDITIONAL** · Full ladder **NOT TESTED** | — |

---

## Capacity table (Part I)

| Area | Current measured capacity | Safe commercial capacity | 100K target | Gap multiplier | First bottleneck | Confidence |
|------|---------------------------|--------------------------|-------------|----------------|------------------|------------|
| Hosting | HTML GET healthy at low concurrency from 1 client; no 5xx in samples (**MEASURED**) | Tens of thousands of **static** opens via CDN (**INFERRED**) | 100k boots | ~1–3× if assets cached properly | `no-store` headers; single-IP tests misleading | Medium |
| Authentication | **NOT TESTED** | Unknown; plan for thousands sign-ins/min needs proof | 100k sessions | Unknown | Token refresh storms | Low |
| Customer app | **NOT TESTED** active | ~100–200 active (**MODELLED**) | 80k sessions | ~400× | Nominatim/OSRM + history listeners | Low |
| Driver app | **NOT TESTED** | ~30–50 online (**MODELLED**) | 19k | ~400× | Global offer query | Low |
| GPS | Code 8s writes (**INFERRED**) | ~50 drivers (**MODELLED**) | 13.3k online peak | ~250× | Write + admin fan-out cost | Medium |
| Ride matching | Design audited (**INFERRED**) | ≪100 concurrent searches (**MODELLED**) | thousands | >100× + redesign | No geo partition; limit(1) global | High (design) |
| Firestore reads | **NOT TESTED** | Limited by admin/history unbounded queries | huge | >100× | Fan-out + full scans | Low |
| Firestore writes | **NOT TESTED** | GPS-bound | 1.6k+/s GPS alone | Architecture | 8s full-fleet writes | Medium |
| Realtime listeners | Inventory complete (**INFERRED**) | Dozens–low hundreds online drivers | 10k–100k listeners | >100× | searching_driver broadcast | High (design) |
| Owner dashboard | **NOT TESTED** | Tens of owners (**MODELLED**) | 900 | ~50× | Unbounded owner rides | Low |
| Admin dashboard | **NOT TESTED** | 1–2 consoles (**MODELLED**) | 100 | ~50× | Full collection listeners ×2 vehicles | High (design) |
| Maps/geocoding | Public Nominatim (**INFERRED**) | **0 commercial** | 100k | N/A — replace | ToS + rate limits | High |
| Routing | Public OSRM demo (**INFERRED**) | **0 commercial** | 100k | N/A — replace | Shared demo SLAs | High |
| Notifications | Browser Notification only (**INFERRED**) | Foreground tabs only | 100k push | N/A — add FCM | No FCM | High |
| **Total platform** | **No business-grade proof** | **~150–250 concurrent active** (**MODELLED**) | **100,000** | **~400–700×** | Matching + GPS + maps | Medium |

---

## Which profile can the current system support?

| Profile | Supportability |
|---------|----------------|
| LIGHT @ 100k mix | **FAIL** — GPS+fan-out alone |
| REALISTIC PEAK @ 100k | **FAIL** |
| SURGE @ 100k / 125k | **FAIL** |
| LIGHT @ ~200 total users / ~50 drivers | **CONDITIONAL** — **MODELLED**, needs staging confirmation |
| REALISTIC @ current modelled safe band | **CONDITIONAL** |

---

## Architecture map (C1) — compact

```
[Browsers: Customer | Driver | Owner | Admin]
        |  HTTPS
        v
[Firebase Hosting CDN] -- static SPA only
        |
        +--> [Firebase Auth] email/password (+ Google admin)
        +--> [Cloud Firestore] sole backend (nam5? NOT TESTED)
        +--> [Firebase Storage] KYC uploads
        +--> [FCM] configured sender id ONLY — unused
        x    [Cloud Functions / Cloud Run] NONE
        x    [RTDB] NONE
        |
        +--> [OSRM public demo] routing
        +--> [Nominatim public] geocoding
        +--> [OSM + Esri tiles] maps
        +--> [Browser Notification API] local alerts
```

Monitoring/analytics/App Check: **absent** (**INFERRED**).

---

## Profiles & rates (Part B) — MODELLED snapshot @ 100k REALISTIC

| Meter | Value |
|-------|------:|
| Concurrent sessions | 100,000 |
| Active riders (15%) | 12,000 |
| Online drivers (70%) | 13,300 |
| GPS writes/s | ≈1,663 |
| Searching listeners | ≈13,300 on one query |
| Cloud Functions/s | 0 (none) |
| Map/geocode/route | Must be commercial — public **forbidden** |

---

## Integrity notes already known from code (INFERRED)

- Dual accept of same ride: **prevented** by `runTransaction` status check (good).  
- Decline sets ride `declined` globally — can remove ride from all drivers (product risk).  
- No idempotency key on create (**INFERRED** risk of duplicates on retry).  
- No geo filter — distant drivers receive offers.  
- Vehicles readable by any signed-in user (rules) — privacy/abuse surface.

---

## Raw evidence index

- `tests/load-capacity-results.json`  
- `tests/load-capacity-baseline.json`  
- `tests/business-load/results/raw/a3-http-reverify.json`  
- `docs/100K-CAPACITY-AUDIT.md`
