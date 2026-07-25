# 100K Architecture & Operations Audit (Part C)

**Date:** 2026-07-23 · Labels: MEASURED / MODELLED / INFERRED / NOT TESTED  
**Code basis:** workspace as of audit date · Git HEAD `6a73d995…` + dirty tree

---

## C1. Architecture map

See also `docs/100K-BUSINESS-LOAD-REPORT.md`.

| Component | Present? | Notes |
|-----------|----------|-------|
| Browser SPAs (4) | Yes | Hosting paths `/`, `/partner/`, `/owner/`, `/admin/` |
| Firebase Hosting | Yes | `no-store` on all assets |
| Firebase Auth | Yes | Email/password; admin Google + hardcoded email gate |
| Cloud Firestore | Yes | Sole transactional backend |
| Realtime Database | **No** | — |
| Cloud Functions / Run | **No** | Confirmed no `functions/` |
| FCM | Config only | `messagingSenderId` set; no client SDK usage |
| Storage | Yes | Driver KYC paths |
| Map tiles | OSM + Esri | Public/third-party |
| Geocoding | Nominatim public | Debounce 320 ms |
| Routing | OSRM public demo | Haversine fallback |
| Analytics / APM | **No** | console only |
| App Check | **No** | — |

---

## C2. Important actions → operations (INFERRED from code)

| Action | FS reads | FS writes | Listeners | Functions | Map/geo/route | Notes |
|--------|----------|-----------|-----------|-----------|---------------|-------|
| Open customer app | 0 until auth | 0 | 0 | 0 | tile fetches | Hosting HTML+JS |
| Log in | profile read via listener attach | 0–1 profile | `users/{uid}` | 0 | — | |
| Go online (driver) | vehicle/partner | vehicle status | +`searching_driver` limit1 + history | 0 | geolocation | |
| GPS tick | 0 | 1 × `vehicles/{id}` /8s | Admin vehicles fans out | 0 | — | Stationary still writes |
| Search place | 0 | 0 | 0 | 0 | Nominatim | |
| Route/fare | pricing settings read possible | 0 | 0 | 0 | OSRM | |
| Create ride | rules gets | 1 create `searching_driver` | All online drivers notified | 0 | — | |
| Accept ride | tx read ride+vehicle; rule gets | 1 update | Others see status change | 0 | — | Atomic tx |
| Decline ride | tx | status `declined` | Removes from global pool | 0 | — | Product risk |
| Complete ride | tx/reads | status + wallet fields client-side | histories | 0 | — | Trust client |
| Customer history | unbounded rides by userId | 0 | live | 0 | — | Grows forever |
| Owner dashboard | all owner rides + vehicles | 0 | live unbounded | 0 | — | |
| Admin dashboard | many full collections | recharge/promo ops | vehicles×2, rides full, completed full | 0 | tiles | |

Transferred bytes / retries: **NOT TESTED** under load.

---

## C3. GPS audit

| Question | Answer | Label |
|----------|--------|-------|
| Interval | **8000 ms** | INFERRED (code constant) |
| Sent while stationary? | **Yes** | INFERRED |
| Sent when offline? | **No** | INFERRED |
| Movement distance check? | **No** | INFERRED |
| Written directly to Firestore? | **Yes** `updateDoc(vehicles/{id})` | INFERRED |
| Same doc repeatedly updated? | **Yes** | INFERRED |
| Indexes affected | Single-doc update — no composite index required for write itself; listeners on collection still wake | INFERRED |
| Writes/hour/driver | **450** max | MODELLED |
| 50 / 200 / 500 / 5k / 19k drivers writes/s | 6.25 / 25 / 62.5 / 625 / 2375 | MODELLED |
| Monthly write volume @13.3k×12h×30d | ~2.15B writes | MODELLED |
| Monthly $ @ $0.18/100k | ~$3.9k writes only | MODELLED |
| Reconnect behaviour | watchPosition restarts; throttle may burst 1 write | INFERRED |
| Retry storm? | Possible if many tabs/devices; **NOT TESTED** | NOT TESTED |
| Stale location expiry? | **No automatic TTL** found | INFERRED |

---

## C4. Listener inventory (summary)

Full table in exploration notes; high-risk entries:

| Listener | Limit | Fan-out risk |
|----------|------:|--------------|
| Driver `searching_driver` | 1 | **All online drivers** share query |
| Admin `vehicles` | none ×**2** | Every GPS write ×2 |
| Admin all `rides` (count) | none | Grows without bound |
| Admin `completed` rides | none | Revenue sum client-side |
| Customer/driver/owner histories | none | Per-user growth |

Unsubscribe: generally present on logout/stop helpers (**INFERRED**). Reconnect: Firestore SDK resync — can re-bill reads (**NOT TESTED** magnitude).

At 100k sessions cost: **NOT TESTED**; order-of-magnitude **MODELLED** as dominant bill after GPS.

---

## C5. Ride matching audit

| Question | Answer |
|----------|--------|
| Rider listens to all drivers? | **No** — rider listens to own ride doc |
| Drivers filtered geographically? | **No** |
| Geohash/H3/S2? | **No** |
| Drivers receiving one request | Effectively **all online** (same limit1 newest) |
| Matching locus | **Client** |
| Two drivers accept one ride? | **Blocked** by transaction status check |
| Atomic accept? | **Yes** (`runTransaction`) |
| Idempotency key? | **No** found |
| Duplicate rides on retry? | **Risk** — NOT TESTED |
| Stale online driver offers? | **Yes** possible (no freshness gate on offer) |
| 1k/5k/10k simultaneous searches | **NOT TESTED**; design predicts collapse (single newest ride wins visibility) |

---

## C6. Owner/admin audit

| Question | Answer |
|----------|--------|
| Full collection listeners? | **Yes** (admin vehicles, rides count, completed, drivers, promos) |
| Limits/cursors? | Only all-rides feed `limit(100)`; others unbounded |
| Old rides re-downloaded? | Live snapshots retain growing sets |
| Aggregate docs? | **No** |
| Charts from raw rides? | Revenue from all completed |
| One ride update → many dashboards | Yes if multiple admins/owners listening |
| Reads/min/admin | **NOT TESTED**; scales with fleet GPS |
| Reads at 100k target | **NOT TESTED** — projected unsustainable without redesign |

---

## C7. External services

| Provider | Endpoint | Type | Rate limit / SLA | Cache | Fallback | Commercial OK? |
|----------|----------|------|------------------|-------|----------|----------------|
| OSRM demo | router.project-osrm.org | Public demo | Best-effort | No app cache | Haversine | **No** for scale |
| Nominatim | nominatim.openstreetmap.org | Public | Strict ToS | Debounce only | None | **No** |
| OSM tiles | tile.openstreetmap.org | Public | Usage policy | Browser | — | **No** heavy |
| Esri imagery | ArcGIS | Third-party tiles | Unknown here | Browser | — | Verify license |

Do **not** stress these. Capacity: **NOT TESTED** (forbidden).

---

## C8. Security & abuse

| Control | Status |
|---------|--------|
| App Check | **Absent** |
| Auth | Present |
| Rules | Present; super-admin email hardcoded; vehicles readable if signed in |
| Role isolation | Partial (rules + client) |
| Server-side validation | Weak — no Functions |
| Rate limiting | **None** app-level |
| GPS spoofing controls | **None** |
| Duplicate op controls | Accept tx only |
| Bot protection | **None** |

Abuse can inflate GPS writes, ride creates, and admin listener costs → billing attack (**INFERRED**).

---

## C9. Observability

| Signal | Present? |
|--------|----------|
| Frontend error tracking | No |
| Firestore/Functions errors | console |
| Permission denials metrics | No |
| Listener reconnects | No |
| Map/route failure SLIs | No |
| GPS age SLO | No |
| Matching/accept timers | No |
| Duplicate ride detector | No |
| Billing usage automation | No |
| Cost per ride | No |
| p95/p99 product latency | No |

---

## Part D status — staging environment

| Item | Status |
|------|--------|
| Staging Firebase project | **NOT CREATED** (awaiting approval) |
| Cost estimate doc | `docs/100K-LOAD-TEST-COST-ESTIMATE.md` |
| Synthetic users/drivers | **NOT CREATED** |
| Cleanup automation | **NOT IMPLEMENTED** |
| Emulator for correctness | Allowed later — **not** used as capacity proof |

**STOP** before paid distributed ladder.
