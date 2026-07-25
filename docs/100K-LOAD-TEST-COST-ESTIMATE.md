# 100K Load Test — Cost Estimate (Gate Document)

**Status:** AWAITING EXPLICIT APPROVAL BEFORE ANY PAID DISTRIBUTED RUN  
**Date:** 2026-07-23  
**Production project:** `swiftgo-ride-app` — **FORBIDDEN** for synthetic heavy load  
**Staging project:** **NOT CREATED** (creation itself may incur cost — needs approval)

Prices below are **MODELLED** using commonly published Firebase Blaze unit rates (USD). Confirm live pricing in Google Cloud Billing before purchase. Rates change; treat ±30% uncertainty as normal until a metered staging pilot.

---

## 1. What we will not spend against

| Target | Rule |
|--------|------|
| Production Firestore / Auth / Storage | No synthetic write storms |
| Public Nominatim / OSRM demo / OSM tiles | No stress (ToS + shared capacity) |
| Production Hosting | Light safe GET re-verify only (already done) |

Staging must use **mocked or commercially contracted** map/geocode/route providers with explicit QPS caps.

---

## 2. Work-driven cost drivers (current architecture)

### GPS writes (dominant)

| Online drivers | Writes/s (**MODELLED**) | Writes/hour | Writes/day @12h online |
|---------------:|------------------------:|------------:|-----------------------:|
| 50 | 6.25 | 22,500 | 270,000 |
| 200 | 25 | 90,000 | 1,080,000 |
| 500 | 62.5 | 225,000 | 2,700,000 |
| 1,000 | 125 | 450,000 | 5,400,000 |
| 5,000 | 625 | 2,250,000 | 27,000,000 |
| 13,300 (REALISTIC 70% of 19k) | 1,662.5 | 5,985,000 | 71,820,000 |
| 17,100 (SURGE 90%) | 2,137.5 | 7,695,000 | 92,340,000 |

Firestore write list price assumption: **$0.18 / 100,000 writes** (**MODELLED**).

| Scenario | Writes/month (**MODELLED**, 12h/day × 30) | Write $ / month |
|----------|------------------------------------------:|----------------:|
| 200 drivers | ~32.4M | ~$58 |
| 1,000 drivers | ~162M | ~$292 |
| 5,000 drivers | ~810M | ~$1,458 |
| 13,300 drivers | ~2.15B | ~$3,878 |
| 17,100 drivers | ~2.77B | ~$4,986 |

Listener fan-out on admin `vehicles` ×2 multiplies **read** billing whenever GPS documents change (**MODELLED** risk, **NOT TESTED** magnitude).

### Searching_driver fan-out

Every online driver holds the same query (`status==searching_driver`, `limit(1)`). Each new/changed open ride notifies **all** online listeners → read billing scales with **online drivers × ride churn** (**MODELLED**).

At 13,300 online drivers and 2 ride-state changes/s: order **~26,600 listener read events/s** possible in worst case (**MODELLED** upper bound — actual Firestore billing semantics for query listeners must be metered in staging).

### Cloud Functions

**$0** today — **none deployed**. Future matching workers will add compute cost (see remediation roadmap).

### Map / geocode / route (must be commercial in staging)

| Provider class | Ballpark for 100k REALISTIC (**MODELLED**) |
|----------------|---------------------------------------------|
| Managed maps + geocoding + routing | $2,000–$15,000+/month depending on SKU and cache hit rate |
| Self-hosted OSRM + tile CDN | CapEx + $200–$2,000/month ops (still requires engineering) |

Public demo endpoints: **$0 but NOT ALLOWED** for load or commercial launch.

### Load generators (distributed)

Conservative estimate for ladder through stage 10 + spike:

| Item | Estimate |
|------|----------|
| 20–80 × 2–4 vCPU VMs × several hours | **$150–$800** compute |
| Egress | **$50–$300** |
| k6 Cloud / Locust cloud (optional) | **$200–$2,000** |

---

## 3. Recommended phased spend envelopes

| Phase | Goal | Max spend (proposed) | Stop if |
|-------|------|---------------------:|---------|
| **P0** | Staging project + rules/indexes clone + cost budgets/alerts | **$50** | Project cannot be isolated from prod |
| **P1** | Metered micro-pilot: 100–500 sessions, 50–200 GPS drivers, 30–60 min | **$100** | Dual-accept or cleanup failure |
| **P2** | Ladder stages 1–5 (to 5,000) with commercial map mocks | **$500** | Error/cost stop conditions |
| **P3** | Stages 6–8 (to 50,000) | **$2,000** | Throttling / integrity fail |
| **P4** | Stages 9–10 + 125k spike + 2h soak | **$5,000–$15,000** | Any Part G stop |

**Proposed maximum permitted test cost before re-approval:** **$500** (covers P0–P2 only).  
**P3/P4 require a second written approval.**

---

## 4. Expected volumes for P1 micro-pilot (**MODELLED**)

Assumptions: 200 online drivers × 30 min; 100 customers creating 1 ride each; admin open.

| Meter | Estimate |
|-------|---------:|
| GPS writes | 200 × 0.125 × 1800 s ≈ **45,000** |
| Ride docs writes | ~100 creates + ~100 accepts + ~100 completes ≈ **300–500** |
| Listener reads | Highly variable — **instrument required** |
| Auth sign-ins | ~300 |
| Map requests | Use mock → **0 paid map** |

Expected Firebase $ for P1: **≪ $5** if mocks used.

---

## 5. Automatic stop conditions (cost)

1. Staging billing alert at **50%** of phase envelope  
2. Hard kill at **100%** envelope  
3. Unexpected production project ID in runner config  
4. Map provider QPS > contracted soft limit  
5. Cannot guarantee synthetic data cleanup

---

## 6. Approval checklist (must be signed before P1+)

- [ ] Staging Firebase project ID created and recorded  
- [ ] Billing budget + alerts enabled  
- [ ] Production project denylist in runners verified  
- [ ] Commercial or mock map endpoints configured  
- [ ] Phase spend envelope chosen (default **$500**)  
- [ ] Owner approves: ______________________ date: __________

---

## 7. Decision

**STOP.** Do not start P1+ until this document is approved.

No 100,000-user distributed test has been run. Any claim of 100K readiness today would be **FALSE**.
