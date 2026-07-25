# 100K Gap Analysis

**Date:** 2026-07-23  
**Target:** 100,000 concurrent complete-platform users (REALISTIC PEAK profile)  
**Current safe commercial capacity (MODELLED):** ≈150–250 concurrent active sessions  

**Gap multiplier (sessions):** ≈ **400–700×**  
**Gap type:** Not a pure horizontal scale problem — **matching, GPS pipeline, admin queries, and map providers must change shape**.

---

## 1. Dimension-by-dimension gaps

| Dimension | Today | 100K need | Gap | Blocking? |
|-----------|-------|-----------|-----|-----------|
| Proven authenticated concurrency | **0 MEASURED** | 100k / 2h | Absolute | Yes |
| Online drivers | Code supports N, billing/fan-out breaks early | ~13.3k online | ~250×+ | Yes |
| Ride matching | Global `limit(1)` broadcast | Geo-sharded server matching | Qualitative redesign | **Yes — critical** |
| GPS path | Direct Firestore `updateDoc` @8s | Batched/RTDB/pipeline + movement filter | Redesign | Yes |
| Admin metrics | Full collection listeners | Aggregate docs / BigQuery | Redesign | Yes |
| Maps/geocode/route | Public demo APIs | Contracted SLA providers | Replace | **Yes — legal/ToS** |
| Push | Browser Notification | FCM/APNs at scale | Build | Yes |
| App Check / abuse | Absent | Required | Build | Yes |
| Observability | console only | APM + SLOs + cost/ride | Build | Yes |
| Cloud Functions | None | Matching, wallet, aggregates | Build | Yes |
| Hosting | CDN OK for static | Fine with cache policy fix | Minor | No |

---

## 2. Why linear “buy more Firebase” fails

### Matching (critical)

Today every online driver listens to:

```text
rides where status==searching_driver orderBy createdAt desc limit(1)
```

Cost and wakeups scale with **online drivers × ride churn**, not with “nearby drivers”. At 13k online drivers, one create/update fans out enormous listener traffic (**MODELLED**). Geo/H3/geohash + server-side dispatch is mandatory for 100k.

### GPS

13.3k × 0.125 = **~1,663 writes/s** sustained (**MODELLED**) before counting admin dual `vehicles` listeners. This is financially and operationally hostile at 100k even if under the 10k writes/s soft ceiling.

### Admin

Unbounded `rides` count + all `completed` + `vehicles`×2 means **fleet GPS turns admin into a read amplifier**. One admin session at 100k-era data sizes is a denial-of-wallet risk.

### External APIs

Nominatim/OSRM demo/**OSM** are **not** commercial capacity. Gap is infinite until replaced — cannot “test into” compliance.

---

## 3. Prior report gap

Prior canvas implied multi-hundred user comfort from Hosting probes + modelling.  
**Correction:** business-proven capacity = **NOT TESTED**; modelled safe band ≈150–250; 100k gap remains **two orders of magnitude + architecture**.

---

## 4. Minimum proof still missing (before any PASS)

1. Staging project with budgets  
2. Distributed generators (not one laptop)  
3. GPS ladder to ≥1,000 drivers with integrity  
4. Ride lifecycle concurrency with dual-accept fuzzing  
5. Listener read accounting (MEASURED $)  
6. Commercial map providers under contract  
7. Stages through at least **5,000** concurrent before discussing 100k spend  

---

## 5. Financial gap (MODELLED)

| Scale | Monthly infra ballpark |
|-------|------------------------:|
| Safe pilot (~50 drivers, low rides) | $50–$500 + maps |
| Current architecture @ REALISTIC 100k | **$20k–$150k+** and still functionally broken on matching |
| Remodeled architecture @ 100k | Often **$5k–$40k** depending on map SKUs and GPS pipeline — **requires redesign first** |

Exact numbers require metered staging (**NOT TESTED**).
