# Phase 1 — Ride Lifecycle Trace

**Primary path:** Customer `rides` + Driver Ride Radar / execution.  
**Secondary / legacy:** Driver `incomingRideSheet` + `resolveActiveRequest`.

---

## Status machine (canonical intent)

```
searching_driver → accepted → arrived → in_progress → completed
                 ↘ cancelled_by_user (customer)
                 ↘ declined (driver, searching only)
```

**Rules also allow:** Customer `accepted → completed` (status only) — **conflicts** with driver path.

---

## Step-by-step trace

| Step | App | File / function | Read | Write | From → To | Permission |
|------|-----|-----------------|------|-------|-----------|------------|
| 1 Create request | Customer | `data.js` `createRideRequest` | — | `rides` add | → `searching_driver` | Rules `isValidRide` |
| 2 Validate | Rules | `isValidRide` | — | — | — | Server rules only |
| 3 List for drivers | Driver | `ride-radar-service.js` | Query `rides` + `ride_requests` | — | — | Any signed-in list open rides |
| 4 Notify drivers | Driver | `subscribePendingRadarRides` | Snapshots | — | — | **Not** push to 10; broadcast query |
| 5 Driver offer | Driver | `ride-radar-actions.js` `submitDriverOffer` | Transaction get ride | Update offer fields | stays open | Rules offer branch |
| 6 Customer accept offer | Customer | `data.js` `acceptDriverOffer` | Transaction | `accepted` + driver fields | searching → accepted | Rules + transaction |
| 6b Driver accept bid | Driver | `ride-radar-actions.js` `acceptRideWithBid` | Transaction | `accepted` | searching → accepted | Rules + transaction |
| 6c Legacy accept | Driver | `driver-app.js` `resolveActiveRequest` | Transaction | partial fields | searching → accepted | **May violate rules** (missing farePkr) |
| 7 Other drivers blocked | Rules | accept branch | — | — | — | Second accept fails (T03 PASS) |
| 8 En route | Driver | `advanceActiveRideStatus` | — | `arrived` | accepted → arrived | Assigned driver only |
| 9 Start | Driver | same | — | `in_progress` | arrived → in_progress | Rules |
| 10 Complete | Driver | `completeRideWithEarnings` | `settings/pricing` | ride complete + **partners batch** | in_progress → completed | Ride rules OK; **partners batch allowed — P0** |
| 11 Customer dev complete | Customer | `data.js` `completeRideRequest` | — | `completed` only | accepted → completed | **Rules allow — P0** |
| 12 Rating | Customer | `submitRideRating` | Transaction | ride + partners aggregates | — | Rules |
| 13 Owner view | Owner | `owner-app.js` ride listeners | `rides` by ownerId | — | — | Rules list/get |
| 14 Admin view | Admin | `admin-app.js` | `rides` queries | — | — | Super admin get/list |
| 15 Cancel search | Customer | `cancelRideRequest` | — | `cancelled_by_user` | searching → cancelled | Rules |

---

## High-risk transitions vs rules

| Transition | Code path | Rules | Match? |
|------------|-----------|-------|--------|
| searching → accepted (full) | `acceptRideWithBid` | Requires vehicle verify + fare fields | **Yes** |
| searching → accepted (partial) | `resolveActiveRequest` | Requires farePkr, estimatedFare, driverBidFare | **No** |
| accepted → arrived | `advanceActiveRideStatus` | status-only, assigned driver | **Yes** |
| arrived → in_progress | same | **Yes** |
| in_progress → completed | `completeRideWithEarnings` | + commission fields | **Yes** |
| accepted → completed (customer) | `completeRideRequest` | status-only customer | **Yes (undesired)** |
| searching → cancelled_by_user | `cancelRideRequest` | **Yes** |
| searching → declined | `resolveActiveRequest("declined")` | status + driverId | **Yes** |

---

## Race conditions

| Race | Mitigation | Gap |
|------|------------|-----|
| Two drivers accept | `runTransaction` on ride doc | OK for radar path |
| Customer cancel vs accept | Last write wins / transaction error | UI message only |
| Double complete | Second update denied if already completed | Customer shortcut may complete without commission |
| Duplicate wallet debit | No idempotency key | Batch could run twice if first commit succeeded client-side but UI retries |

---

## Financial side effects on complete

`driver-app/js/driver-app.js` `completeRideWithEarnings` (≈ L1992–2022):

- Computes `commissionAmount`, `driverEarnings` client-side from `settings/pricing`.
- `writeBatch`: ride `completed` + `partners` increment earnings and **decrement wallet**.

Emulator **T19:** partner wallet batch **succeeds** under current rules — financial integrity depends on client honesty.

---

## Cancellation / dispute

- Customer cancel while searching: supported.
- No dedicated `disputed` status in rules or code.
- `declined` clears driver from searching ride but does not model customer notification beyond snapshot.

---

## Field name alignment (Customer ↔ Driver ↔ Rules)

| Concept | Customer | Driver | Rules |
|---------|----------|--------|-------|
| Pickup | `pickupLocation` | same | same |
| Dropoff | `dropoffLocation` | same | same |
| Fare | `farePkr` | `farePkr` / bid | `farePkr` |
| Cancel | `cancelled_by_user` | — | same |
| Open status | `searching_driver` | radar maps to pending | same |

**No** `rideRequests` camelCase collection — use `ride_requests`.
