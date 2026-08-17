# Ride Assignment — Duplicate Flow Audit

**Date:** 2026-08-06  
**Based on:** `docs/specs/RIDE-ASSIGNMENT-ARCHITECTURE-AUDIT.md`  
**Scope:** Duplicate, legacy, parallel, client-only, and server-only assignment paths  
**Code changes:** None (audit only)

**Legend**

| Field | Meaning |
|-------|---------|
| **Active** | In production use today |
| **Legacy** | Superseded pattern; may still execute |
| **Duplicate** | Same responsibility implemented twice+ |
| **Dead Code** | Present but unwired / never called |

| Recommendation | Meaning |
|----------------|---------|
| **Keep** | Retain as-is |
| **Merge** | Consolidate into single path |
| **Remove** | Delete when safe |
| **Replace** | Swap for canonical implementation |

---

## 1. Every duplicate ride assignment path

| ID | File | Function | Why it exists | Status | Booking bugs? | Bypass rules? | Recommendation |
|----|------|----------|---------------|--------|---------------|---------------|----------------|
| AP-01 | `functions/bargaining.js` | `finalizeAssignmentFromOffer` | Canonical assign after negotiation (`open`/`countered` offer) | **Active** | NO | NO | **Keep** (primary path) |
| AP-02 | `functions/bargaining.js` | `acceptCustomerInitialFareAsDriver` | Direct assign at customer estimated fare without custom bid | **Active** | NO (post-fix) | NO (post-fix) | **Keep** (second intentional path; mutual exclusion enforced server-side) |
| AP-03 | `driver-app/js/driver-app.js` | `resolveActiveRequest` | Pre–Phase 2A client Firestore transaction: `searching_driver` → `accepted` without CF | **Dead Code** | YES (if invoked) | YES | **Remove** |
| AP-04 | `owner-app/js/owner-app.js` | `resolveActiveRequest` | Copy of driver legacy client assign | **Dead Code** | YES (if invoked) | YES | **Remove** |
| AP-05 | `driver-app/js/ride-radar-actions.js` | `acceptRideWithBid` → `finalizeAssignmentFromOffer` | Driver accepts customer counter | **Active** | NO | NO | **Keep** (wrapper over AP-01) |
| AP-06 | `driver-app/js/RideRequestDetail.js` | `acceptCustomerOffer` → `acceptCustomerInitialFare` | UI entry for AP-02 | **Active** | NO | NO | **Keep** |
| AP-07 | `customer-app/js/ride-flow.js` | `onAcceptDriverOffer` → `finalizeOfferAsCustomer` | UI entry for AP-01 (customer side) | **Active** | NO | NO | **Keep** |
| AP-08 | `owner-app/js/owner-app.js` | `resolveActiveRequest` (would assign) vs driver radar CF paths | Owner shell forked from driver before radar/CF bargaining | **Legacy** | YES (if wired) | YES | **Remove** (function body); **Replace** owner dispatch with driver-app parity if owner ever drives |

**Note:** AP-01 and AP-02 are **parallel by design**, not accidental duplicates. The duplicate-risk is **two server assign implementations** that must stay rule-synchronized (expiry, candidate check, vehicle link).

---

## 2. Every legacy assignment path

| ID | File | Function | Why it exists | Status | Booking bugs? | Bypass rules? | Recommendation |
|----|------|----------|---------------|--------|---------------|---------------|----------------|
| LG-01 | `customer-app/js/data.js` | `watchBookings` | Pre–Phase 2A `bookings/` collection watcher | **Dead Code** | NO | NO | **Remove** |
| LG-02 | `customer-app/js/data.js` | `createBooking` | Writes `bookings/` docs | **Dead Code** | YES (if called) | YES | **Remove** |
| LG-03 | `customer-app/js/data.js` | `acceptDriverOffer` | Stub; throws redirect to Phase 2A | **Legacy** | YES (if old caller) | N/A | **Remove** |
| LG-04 | `customer-app/js/data.js` | `rejectDriverOffer` | Stub | **Legacy** | NO | NO | **Remove** |
| LG-05 | `customer-app/js/data.js` | `counterDriverOffer` | Stub | **Legacy** | NO | NO | **Remove** |
| LG-06 | `customer-app/js/data.js` | `createRideRequest` | Stub | **Legacy** | NO | NO | **Remove** |
| LG-07 | `customer-app/js/data.js` | `cancelRideRequest` | Client `updateDoc` → `cancelled_by_user` (bypasses CF cancel) | **Legacy** | YES | YES | **Replace** with `cancelCustomerBookingClient` only; **Remove** direct write |
| LG-08 | `driver-app/js/driver-app.js` | `startRideListener` | Pre-radar global incoming ride sheet | **Legacy** | NO (disabled) | NO | **Remove** (stub already no-ops) |
| LG-09 | `driver-app/js/driver-app.js` | `showIncomingRide` | Incoming sheet UI | **Legacy** | NO | NO | **Remove** with LG-08 |
| LG-10 | `driver-app/index.html` | `#acceptRideBtn`, `#incomingRideSheet` | Legacy incoming UI shell | **Dead Code** | NO | NO | **Remove** DOM + refs |
| LG-11 | `owner-app/js/owner-app.js` | `startRideListener` | Lists **all** `searching_driver` rides globally | **Legacy** | YES | YES | **Remove** or **Replace** with candidate-scoped radar |
| LG-12 | `owner-app/js/owner-app.js` | `showIncomingRide` | Legacy incoming sheet for owner | **Legacy** | YES | NO | **Remove** with LG-11 |
| LG-13 | `driver-app/js/RideRequestDetail.js` | `collectionNameFor` → `ride_requests` | Phase 2B archive read path | **Legacy** | NO | NO | **Keep** read-only until archive empty; then **Remove** |
| LG-14 | `customer-app/js/ride-status.js` | `LEGACY_SEARCHING_STATUSES` | Normalizes old ride status strings | **Active** | NO | NO | **Keep** (compat shim) |
| LG-15 | `firestore.rules` | `bookings/{id}` rules block | Old booking shape | **Legacy** | NO | NO | **Remove** when LG-01/LG-02 removed |

---

## 3. Every parallel listener

| ID | File | Function / listener | Why it exists | Status | Booking bugs? | Bypass rules? | Recommendation |
|----|------|---------------------|---------------|--------|---------------|---------------|----------------|
| PL-01 | `driver-app/js/driver-offer-inbox.js` | `onSnapshot(ride_offers)` query driverId + open/countered | L1 inbox for radar badges + expiry | **Active** | YES | NO | **Keep** as single driver offer source |
| PL-02 | `driver-app/js/RideRequestDetail.js` | `onSnapshot(ride_offers/{rideId}_{uid})` | Detail screen offer state | **Duplicate** | YES | NO | **Merge** — subscribe only via inbox `getOfferForRide` / shared controller |
| PL-03 | `driver-app/js/RideRequestDetail.js` | `onSnapshot(rides/{id})` | Detail ride status / assign detect | **Active** | NO | NO | **Keep** (detail-specific) |
| PL-04 | `driver-app/js/driver-app.js` | `subscribePendingRadarRides` (background feed) | Radar card list while online | **Active** | NO | NO | **Keep** |
| PL-05 | `driver-app/js/AvailableRidesList.js` | `subscribePendingRadarRides` (when list open) | Same feed for list view | **Duplicate** | NO | NO | **Merge** — single subscription in `driver-app.js`, list consumes cache |
| PL-06 | `customer-app/js/offer-client.js` | `watchRideOffers` → `onSnapshot(ride_offers)` | Customer offer panel | **Active** | YES | NO | **Keep** |
| PL-07 | `customer-app/js/data.js` | `watchRideRequest` → `onSnapshot(rides/{id})` | Customer ride lifecycle | **Active** | NO | NO | **Keep** |
| PL-08 | `customer-app/js/ride-flow.js` | Binds both PL-06 and PL-07 via lifecycle | Searching + offer UI | **Active** | YES | NO | **Keep** binding; fix PL-02 driver side |
| PL-09 | `driver-app/js/bargain-capacity.js` | `subscribeOpenBargainCount` | Planned open-bargain cap UI | **Dead Code** | NO | NO | **Remove** |
| PL-10 | `owner-app/js/owner-app.js` | `startRideListener` → global `rides` searching query | Legacy dispatch | **Legacy** | YES | YES | **Remove** |
| PL-11 | `owner-app/js/owner-app.js` | `startActiveRideWatch` → `rides/{id}` | Post-assign execution | **Duplicate** of driver | NO | NO | **Merge** into shared module if owner drives |
| PL-12 | `driver-app/js/driver-app.js` | `startActiveRideWatch` | Post-assign execution | **Active** | NO | NO | **Keep** |
| PL-13 | `driver-app/js/driver-app.js` | `startDispatchIdleSettingsWatch` → `settings/dispatch` | Reads `offerTimeoutSeconds` | **Active** | NO | NO | **Keep** |
| PL-14 | `customer-app/js/history.js` | `onSnapshot(rides)` userId | History list | **Active** | NO | NO | **Keep** (separate concern) |
| PL-15 | `driver-app/js/earnings-service.js` | rides by driverId | Earnings | **Active** | NO | NO | **Keep** |

---

## 4. Every duplicate timer

| ID | File | Function / timer | Why it exists | Status | Booking bugs? | Bypass rules? | Recommendation |
|----|------|------------------|---------------|--------|---------------|---------------|----------------|
| TM-01 | `customer-app/js/offer-client.js` | `schedule()` per-offer `setTimeout` | L2 expire at `offerExpiresAt` | **Active** | YES (if fails) | NO | **Keep** one customer timer layer |
| TM-02 | `customer-app/js/offer-client.js` | `setInterval` 1000ms `flushExpired` | Background throttle recovery | **Active** | YES | NO | **Keep** paired with TM-01 |
| TM-03 | `customer-app/js/offer-client.js` | `visibilitychange` flush | Tab resume | **Active** | YES | NO | **Keep** |
| TM-04 | `driver-app/js/driver-offer-inbox.js` | `scheduleExpiry` per-offer `setTimeout` | L1 driver expire | **Duplicate** of TM-01 (driver side) | YES | NO | **Keep** until merged controller |
| TM-05 | `driver-app/js/driver-offer-inbox.js` | `setInterval` 1000ms `inbox_tick` | Same as TM-02 for driver | **Duplicate** | YES | NO | **Merge** with TM-06 into one driver timer service |
| TM-06 | `driver-app/js/RideRequestDetail.js` | `detailExpiryTick` `setInterval` 1000ms | Detail-only expiry UI | **Duplicate** | YES | NO | **Remove** — rely on inbox + shared state |
| TM-07 | `driver-app/js/driver-offer-inbox.js` | `visibilitychange` inbox flush | Tab resume | **Duplicate** of TM-03 | YES | NO | **Keep** one visibility handler per app |
| TM-08 | `customer-app/js/ride-flow.js` | `SEARCH_TIMEOUT_MS` 180s → `expireSearchingBooking` | 3-min search window | **Active** | NO | NO | **Keep** |
| TM-09 | `customer-app/js/ride-flow.js` | `SEARCH_REMATCH_MS` 30s → `matchRideCandidates` | Rematch while searching | **Active** | NO | NO | **Keep** |
| TM-10 | `customer-app/js/ride-flow.js` | `searchTickId` 1s UI countdown | Display only | **Active** | NO | NO | **Keep** |
| TM-11 | `customer-app/js/offer-client.js` | `matchCandidatesForRetry` 800ms | CF retry | **Active** | NO | NO | **Keep** |

**Duplicate cluster:** TM-01/TM-04 (per-offer timeout), TM-02/TM-05/TM-06 (1s tick), TM-03/TM-07 (visibility). Driver side has **three** parallel expiry loops (inbox + detail tick + detail `applyOfferExpiryUi` calls).

---

## 5. Every duplicate Firestore write

| ID | File | Function | Write | Why it exists | Status | Booking bugs? | Bypass rules? | Recommendation |
|----|------|----------|-------|---------------|--------|---------------|---------------|----------------|
| FW-01 | `functions/bargaining.js` | `finalizeAssignmentFromOffer` | `rides.status=accepted` | Canonical assign | **Active** | NO | NO | **Keep** |
| FW-02 | `functions/bargaining.js` | `acceptCustomerInitialFareAsDriver` | `rides.status=accepted` | Direct assign | **Active** | NO | NO | **Keep** (sync rules with FW-01) |
| FW-03 | `driver-app/js/driver-app.js` | `resolveActiveRequest` | `rides.status=accepted` client tx | Legacy | **Dead Code** | YES | YES | **Remove** |
| FW-04 | `owner-app/js/owner-app.js` | `resolveActiveRequest` | same as FW-03 | Legacy copy | **Dead Code** | YES | YES | **Remove** |
| FW-05 | `driver-app/js/driver-app.js` | `advanceActiveRideStatus` | `rides.status` → arrived/in_progress | Phase 32 client progression | **Active** | NO | NO | **Keep** (rules-gated) |
| FW-06 | `owner-app/js/owner-app.js` | `advanceActiveRideStatus` | same as FW-05 | Owner fork | **Duplicate** | NO | NO | **Merge** or **Remove** owner copy |
| FW-07 | `functions/settlement.js` | `settleRide` | `rides.status=completed` | Settlement | **Active** | NO | NO | **Keep** |
| FW-08 | `customer-app/js/data.js` | `cancelRideRequest` | `cancelled_by_user` | Legacy cancel | **Legacy** | YES | YES | **Remove** |
| FW-09 | `functions/bargaining.js` | `expireSearchingBooking` | `rides.status=expired` | Search timeout | **Active** | NO | NO | **Keep** |
| FW-10 | `functions/bargaining.js` | `reconcileCustomerBookingState` batch | `rides.status=expired` | Piggyback reconcile | **Duplicate** path to FW-09 | NO | NO | **Keep** (lazy reconcile); document as parallel to TM-08 |
| FW-11 | `functions/bargaining.js` | `expireDueSearchingBookings` | batch expire | Admin sweeper | **Duplicate** path to FW-09 | NO | NO | **Keep** (admin only) |
| FW-12 | `functions/bargaining.js` | `markOfferTimedOutInTx` | `ride_offers.status=expired` | Offer timeout | **Active** | NO | NO | **Keep** (single writer helper) |
| FW-13 | `functions/bargaining.js` | `expireRideOffer` callable | uses FW-12 | Client timer authority | **Active** | NO | NO | **Keep** |
| FW-14 | `functions/bargaining.js` | `expireDueOffersForRide` | batch per ride | Piggyback | **Duplicate** trigger of FW-12 | NO | NO | **Keep** |
| FW-15 | `functions/bargaining.js` | `expireDueRideOffers` | admin batch | Admin sweeper | **Duplicate** trigger of FW-12 | NO | NO | **Keep** |
| FW-16 | Inline guards | `counterRideOffer`, `rejectRideOffer`, `finalizeAssignmentFromOffer`, `acceptCustomerInitialFare` | expire via FW-12 | Lazy on action | **Active** | NO | NO | **Keep** |
| FW-17 | `functions/bargaining.js` | `closeCandidatesAndOffersForRide` | offers/candidates expired | Ride close cleanup | **Active** | NO | NO | **Keep** |
| FW-18 | `driver-app/js/RideRequestDetail.js` | `applyOfferExpiryUi` | **local** `myOfferState.status=expired` (no Firestore) | Client-only UI | **Duplicate** semantics | YES | YES | **Remove** local mutation; drive UI from server snapshot only |
| FW-19 | `customer-app/js/offer-client.js` | `emitAlive` filter | **no write**; hides offer | Client-only | **Duplicate** semantics | YES | NO | **Keep** filter but must always call FW-13 |

---

## 6. Every duplicate Cloud Function

| ID | Export | Internal impl | Why it exists | Status | Booking bugs? | Bypass rules? | Recommendation |
|----|--------|---------------|---------------|--------|---------------|---------------|----------------|
| CF-01 | `finalizeAssignmentFromOffer` | `bargaining.finalizeAssignmentFromOffer` | Assign from offer | **Active** | NO | NO | **Keep** |
| CF-02 | `acceptCustomerInitialFare` | `acceptCustomerInitialFareAsDriver` | Direct assign | **Active** | NO | NO | **Keep** |
| CF-03 | `expireRideOffer` | `bargaining.expireRideOffer` | Single-offer expire (client) | **Active** | NO | NO | **Keep** |
| CF-04 | `expireDueRideOffers` | `bargaining.expireDueRideOffers` | Admin batch offer expire | **Duplicate** of CF-03 | NO | NO | **Keep** (admin); optional future Scheduler |
| CF-05 | `expireDueOffersForRide` (internal) | piggyback on match/submit/reconcile | Event-driven expire | **Duplicate** of CF-03 | NO | NO | **Keep** |
| CF-06 | `expireSearchingBooking` | `bargaining.expireSearchingBooking` | Client 3-min search expire | **Active** | NO | NO | **Keep** |
| CF-07 | `expireDueSearchingBookings` | batch | Admin search expire | **Duplicate** of CF-06 | NO | NO | **Keep** (admin) |
| CF-08 | `reconcileCustomerBookingState` (internal) | batch search expire + offer piggyback | Gate/reconcile | **Duplicate** of CF-05/CF-06 | NO | NO | **Keep** |
| CF-09 | `matchRideCandidates` | `bargaining.matchRideCandidates` | Invite candidates | **Active** | NO | NO | **Keep** |
| CF-10 | `createCustomerBooking` | auto-calls CF-09 after create | Booking + match | **Active** | NO | NO | **Keep** |
| CF-11 | `submitRideOffer` | offer create | Driver bid | **Active** | NO | NO | **Keep** |
| CF-12 | `counterRideOffer` / `rejectRideOffer` | negotiation | Customer actions | **Active** | NO | NO | **Keep** |
| CF-13 | `cancelCustomerBooking` vs `cancelAllSearchingBookings` | cancel variants | Partial overlap | **Active** | NO | NO | **Keep** (different scope) |
| CF-14 | `cancelAssignedRideByDriver` | unassign + rematch | Driver cancel pre-start | **Active** | NO | NO | **Keep** |

**No duplicate CF exports** assign rides other than CF-01/CF-02 (intentional dual path).

---

## 7. Every client-only decision

| ID | File | Function / logic | Decision made client-side | Why it exists | Status | Booking bugs? | Bypass rules? | Recommendation |
|----|------|------------------|----------------------------|---------------|--------|---------------|---------------|----------------|
| CD-01 | `customer-app/js/offer-client.js` | `isOfferPastExpiryLocal` | Hide offer before/without server expire | L2 UX + timer trigger | **Active** | YES | NO | **Keep** but always invoke CF-03 |
| CD-02 | `driver-app/js/driver-offer-inbox.js` | `isOfferPastExpiryLocal` + filter map | Drop offer from inbox UI | L1 UX | **Active** | YES | NO | **Keep** |
| CD-03 | `driver-app/js/RideRequestDetail.js` | `syncOfferUi` → `showAcceptInitial` / `driverOfferRecordExists` | Show/hide accept-initial panel | UX mutual exclusion | **Active** | YES (fixed) | NO | **Keep** |
| CD-04 | `driver-app/js/RideRequestDetail.js` | `applyOfferExpiryUi` sets local `expired` | UI state without server | Expiry UX | **Duplicate** | YES | YES | **Remove** local status mutation |
| CD-05 | `driver-app/js/RideRequestDetail.js` | `submitBid` optimistic `myOfferState` | Immediate UI after bid | Responsiveness | **Active** | NO | NO | **Keep**; reconcile on snapshot |
| CD-06 | `customer-app/js/ride-flow.js` | `updateDriverOfferUi` / `setSearchingOfferVisible` | Offer panel visibility | UX | **Active** | YES | NO | **Keep** |
| CD-07 | `customer-app/js/ride-flow.js` | `onSearchTimedOut` → expire CF | Search expired | 3-min timer | **Active** | NO | NO | **Keep** |
| CD-08 | `customer-app/js/ride-flow.js` | `rematchWhileSearching` | Trigger rematch | 30s timer | **Active** | NO | NO | **Keep** |
| CD-09 | `customer-app/js/ride-flow.js` | `purgeGhostSearchingRides` | Heuristic cancel | Ghost cleanup | **Active** | YES | NO | **Keep**; document as client heuristic |
| CD-10 | `customer-app/js/ride-status.js` | `normalizeCustomerRideStatus` | Map legacy statuses | Compat | **Active** | NO | NO | **Keep** |
| CD-11 | `driver-app/js/driver-app.js` | `advanceActiveRideStatus` | arrived / in_progress | Rules allow client | **Active** | NO | NO | **Keep** |
| CD-12 | `driver-app/js/location-checkpoint-policy.mjs` | status-based GPS gates | When to publish location | Performance | **Active** | NO | NO | **Keep** |
| CD-13 | `customer-app/js/live-location-source-arbiter.mjs` | P2P vs Firestore source | Display source | Post-assign UX | **Active** | NO | NO | **Keep** |
| CD-14 | `customer-app/js/data.js` | `cancelRideRequest` | Cancel without CF | Legacy | **Legacy** | YES | YES | **Remove** |

---

## 8. Every server-only decision

| ID | File | Function | Decision made server-side | Why it exists | Status | Booking bugs? | Bypass rules? | Recommendation |
|----|------|----------|---------------------------|---------------|--------|---------------|---------------|----------------|
| SD-01 | `functions/bargaining.js` | `isOfferPastTimeout` / `resolveOfferExpiryMs` | Authoritative offer expiry | P1-B | **Active** | NO | NO | **Keep** (source of truth) |
| SD-02 | `functions/bargaining.js` | `finalizeAssignmentFromOffer` guards | Reject closed/expired offers | Business rules | **Active** | NO | NO | **Keep** |
| SD-03 | `functions/bargaining.js` | `acceptCustomerInitialFareAsDriver` guards | Block expired/negotiation | P1-B fix | **Active** | NO | NO | **Keep** |
| SD-04 | `functions/bargaining.js` | `submitRideOffer` | `OFFER_NOT_OPEN` on terminal prev | No reopen | **Active** | NO | NO | **Keep** |
| SD-05 | `functions/matching.js` | candidate selection / limits | Who gets invited | Dispatch policy | **Active** | NO | NO | **Keep** |
| SD-06 | `functions/bargaining.js` | `createCustomerBooking` + slot tx | Booking limit 4 | Business rules | **Active** | NO | NO | **Keep** |
| SD-07 | `functions/bargaining.js` | `expireSearchingBooking` tx | Atomic vs assign race | Search timeout | **Active** | NO | NO | **Keep** |
| SD-08 | `functions/ride-cancellation.js` | `cancelAssignedRideByDriver` | Rematch + exclude driver | Business rules | **Active** | NO | NO | **Keep** |
| SD-09 | `functions/settlement.js` | `settleRide` | completed + wallet | Billing | **Active** | NO | NO | **Keep** |
| SD-10 | `firestore.rules` | rides update | Only allowed client transitions | Security | **Active** | NO | Partial (FW-03 latent) | **Keep**; close FW-03 hole |
| SD-11 | `firestore.rules` | ride_offers create/update | **false** — CF only | Security | **Active** | NO | NO | **Keep** |
| SD-12 | `functions/index.js` | blocks `onlineDrivers` injection on match | Anti-cheat | Security | **Active** | NO | NO | **Keep** |

---

## 9. Every place where old and new systems coexist

| ID | Location | Old system | New system | Status | Booking bugs? | Bypass rules? | Recommendation |
|----|----------|------------|------------|--------|---------------|---------------|----------------|
| CO-01 | Customer data layer | `bookings/` collection (`data.js`) | `rides/` + CF `createCustomerBooking` | **Legacy + Active** | YES | YES | **Remove** old |
| CO-02 | Customer cancel | `cancelRideRequest` client write | `cancelCustomerBookingClient` CF | **Legacy + Active** | YES | YES | **Remove** old |
| CO-03 | Customer accept offer | `data.js` stubs | `offer-client.js` CF | **Legacy + Active** | NO | NO | **Remove** stubs |
| CO-04 | Driver dispatch UI | Incoming sheet (`incomingRideSheet`) | Ride radar + candidates | **Legacy + Active** | NO | NO | **Remove** sheet code/DOM |
| CO-05 | Driver assign | `resolveActiveRequest` client tx | CF finalize / acceptInitial | **Dead + Active** | YES | YES | **Remove** dead |
| CO-06 | Owner app | Full legacy listener + assign copy | Same as CO-04/CO-05 | **Legacy** | YES | YES | **Remove** or align with driver-app |
| CO-07 | Detail offer path | `ride_requests` archive docs | `rides` canonical | **Legacy + Active** | NO | NO | **Remove** when archive empty |
| CO-08 | Repo trees | `F:/ride-app` (hosting) | `F:/ride-app-p1a-validate` (functions lab) | **Duplicate** deploy sources | YES | NO | **Merge** to single release branch |
| CO-09 | Deploy artifact | `customer-app/`, `driver-app/` source | `hosting-dist/` built copy | **Duplicate** | YES | NO | **Keep** build pipeline; enforce health check |
| CO-10 | Shared modules | `shared/js/*.mjs` | Per-app copies via `build-hosting.mjs` | **Duplicate** | YES | NO | **Keep** sync script; verify on deploy |
| CO-11 | Status strings | `created`/`pending`/`searching` | `searching_driver` | **Legacy + Active** | NO | NO | **Keep** normalizer |
| CO-12 | Offer expiry | Client timers (L1/L2) | Server `expireRideOffer` + piggyback | **Parallel by design** | YES | NO | **Keep**; add logging/metrics |
| CO-13 | Search expiry | Client 3-min timer | Server reconcile + admin batch | **Parallel by design** | NO | NO | **Keep** |
| CO-14 | Assign paths | `acceptCustomerInitialFare` | `finalizeAssignmentFromOffer` | **Parallel by design** | NO | NO | **Keep** synchronized |
| CO-15 | Post-assign progression | Client `updateDoc` arrived/in_progress | CF settlement for completed | **Split by design** | NO | NO | **Keep** |
| CO-16 | Location display | Firestore `driverLocation` mirror | P2P location stream | **Parallel** | NO | NO | **Keep** (arbiter chooses) |

---

## 10. Every path that should be removed

Consolidated **Remove** recommendations (do not implement in this audit).

| Priority | ID(s) | File(s) | Function / asset | Reason |
|----------|-------|---------|------------------|--------|
| P0 | AP-03, AP-04, FW-03, FW-04, CO-05 | `driver-app/js/driver-app.js`, `owner-app/js/owner-app.js` | `resolveActiveRequest` | Client assign bypass; dead but dangerous |
| P0 | LG-07, FW-08, CD-14, CO-02 | `customer-app/js/data.js` | `cancelRideRequest` | Bypasses CF cancel/settlement rules |
| P1 | PL-02, TM-06, FW-18, CD-04 | `RideRequestDetail.js` | detail offer listener + tick + local expire | Duplicate of inbox; causes state drift |
| P1 | PL-05 | `AvailableRidesList.js` | second `subscribePendingRadarRides` | Double candidate listener |
| P1 | LG-11, LG-12, PL-10, CO-06 | `owner-app/js/owner-app.js` | `startRideListener`, `showIncomingRide` | Global searching leak; legacy |
| P2 | LG-01–LG-06, CO-01 | `customer-app/js/data.js` | bookings + stubs | Dead legacy |
| P2 | LG-08–LG-10, CO-04 | `driver-app` | incoming sheet + disabled listener | Dead UI/code |
| P2 | PL-09 | `bargain-capacity.js` | entire file | Unwired duplicate |
| P2 | LG-13 | `RideRequestDetail.js` | `ride_requests` path | When archive empty |
| P3 | FW-06 | `owner-app.js` | duplicate `advanceActiveRideStatus` | If owner not driving |
| P3 | LG-15 | `firestore.rules` | `bookings/` rules | After LG-01/02 removed |

**Merge (not remove):**

| ID(s) | Target |
|-------|--------|
| TM-04/TM-05/TM-07 | Single `driver-offer-expiry-controller.mjs` |
| CD-01/CD-02 + SD-01 | Shared `offer-expiry.mjs` imported by client + tested against server |
| PL-04/PL-05 | Single radar subscription owner in `driver-app.js` |
| CO-08 | Single deploy tree |

**Replace (not remove alone):**

| ID | Replace with |
|----|--------------|
| LG-07 | `cancelCustomerBookingClient` everywhere |
| LG-11 | Candidate-scoped radar (same as driver-app) or deprecate owner driving |

---

## Cross-reference: duplicate-flow → booking bug symptoms

| Symptom | Primary duplicate IDs |
|---------|------------------------|
| Offer bookable after timeout | CD-01/CD-02 + FW-18 + AP-02 (fixed server) |
| Accept-initial button reappears | CD-03 + FW-18 |
| Driver/customer offer mismatch | PL-01 + PL-02 + TM-06 |
| Stale behavior after deploy | CO-09 + CO-10 |
| Random ride visible to wrong driver | LG-11 + PL-10 |
| Cancel/settlement inconsistency | LG-07 + CO-02 |

---

## Audit metadata

| Item | Value |
|------|-------|
| Total items catalogued | 120+ |
| P0 remove candidates | 2 paths (client assign + client cancel) |
| Highest-risk active duplicate | PL-02 + TM-06 + FW-18 (driver offer state) |
| Intentional parallel (keep) | CF-01/CF-02, CF-03/CF-05/CF-06, CO-12/CO-13 |

**End of duplicate-flow audit. No code was modified.**
