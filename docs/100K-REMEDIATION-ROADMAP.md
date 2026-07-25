# 100K Remediation Roadmap

**Status:** PLAN ONLY — **no production code changes** in this audit  
**Date:** 2026-07-23  
**Instruction:** Implement nothing until baseline staging tests and cost approvals complete.

---

## Phase 0 — Measurement foundation (1–2 weeks)

1. Create isolated staging Firebase project; clone rules + indexes.  
2. Billing budgets/alerts; synthetic data namespace + cleanup jobs.  
3. Commercial **or mock** maps/geocode/routing for tests.  
4. Add OpenTelemetry/Sentry + Firestore usage dashboards.  
5. Run P1 micro-pilot (≤$100) per cost estimate.

**Exit:** MEASURED costs for 50–200 GPS drivers; dual-accept tests green on emulator + staging.

---

## Phase 1 — Stop the bleeding (commercial pilot enablement)

1. **GPS:** increase interval and/or write only on movement threshold; never write identical coords; consider Realtime Database or Cloud Function ingest.  
2. **Admin:** replace full-collection listeners with `limit` + cursors; maintain `stats/global` aggregate doc updated transactionally on ride complete; remove duplicate vehicles listener.  
3. **History:** paginate customer/driver/owner ride lists.  
4. **Hosting cache:** hashed assets + long-cache immutables; HTML short cache.  
5. **App Check** + tighten `vehicles` read rules.  
6. Replace public Nominatim/OSRM/OSM with contracted providers **before** marketing launch.

**Exit:** Safe commercial pilot (~50 drivers, hundreds of riders) with measured SLOs.

---

## Phase 2 — Matching redesign (required for >1k online drivers)

1. Move offer dispatch to **trusted backend** (Cloud Functions / Cloud Run).  
2. Spatial index (geohash / H3) — query K nearest eligible drivers only.  
3. Per-driver offer docs or FCM data messages — **no global searching_driver fan-out**.  
4. Idempotency keys on ride create/accept/complete.  
5. Decline must not poison global pool incorrectly; use driver-offer subdocs.  
6. Server-side wallet/commission — remove sensitive trust from clients.

**Exit:** Staging proof of 1,000–5,000 online drivers with offer p95 <5s.

---

## Phase 3 — Scale path to 50k–100k

1. GPS pipeline at target QPS with load shedding.  
2. FCM for offers + reconnect-safe delivery.  
3. CQRS/read models for owner & admin dashboards (BigQuery or scheduled aggregations).  
4. Multi-region strategy if required by latency SLOs.  
5. Chaos: reconnect storms, dual-accept fuzz, soak 24h.  
6. Execute load ladder stages 6→10 only after Phase 2 exit.

**Exit:** MEASURED PASS against Part H criteria — or documented max stable <100k.

---

## Phase 4 — Operate

1. Cost-per-completed-ride dashboards.  
2. Autoscaling runbooks; abuse rate limits.  
3. Backup/PITR; rollback drills.  
4. Quarterly capacity re-certification.

---

## Explicit non-goals for now

- Do not “optimize” production before staging MEASURED baselines.  
- Do not claim 100k from Hosting HTTP 200s.  
- Do not stress public OSRM/Nominatim/OSM.
