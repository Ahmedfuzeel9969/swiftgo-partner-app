# Step 2 — Runtime Mapping (NO CODE CHANGES)

**Status:** MAPPING ONLY — awaiting approval before Step 3 (Replacement Plan).  
**Spec source of truth:** `docs/specs/phase1-phase2-location-dispatch.spec.mjs`  
**Clarifications:** Operator answers applied to spec (P2 Backup Mode = P2P unavailable; flow Driver→Firebase→Customer; OR triggers; numeric examples not hard-coded).

**This document does not delete or replace any runtime logic.**

---

## 1. Phase isolation reminder

| Phase | When | Must not affect |
|-------|------|-----------------|
| Phase 1 | Pre-match / waiting / offer / bargain / assign | Phase 2 in-ride P2P/Firebase backup rules |
| Phase 2 | After driver–customer contact (accepted+) | Phase 1 idle eligibility / idle 200m·3min wait publish |

---

## 2. PHASE 1 — Existing runtime map

### 2.1 Eligibility (§1)

| File | Symbols | Role | Listeners / timers / writes |
|------|---------|------|-----------------------------|
| `functions/matching.js` | `isEligibleMatchDriver`, `classifyDriverMatchExclusion` | Server gate: online, no activeRideId, lat/lng, not blocked, location freshness | Reads vehicles/partners |
| `functions/geo-match.js` | `loadAndSelectGeoCandidates` | Loads online vehicles in geo cells | Query `vehicles` status=online |
| `functions/active-ride-reconcile.js` | `isDriverAvailableForRematch`, `reconcileDriverAvailabilityInTx` | Heals stale activeRideId | TX partners/vehicles/rides |
| `functions/bargaining.js` | `driverHasActiveRide`, checks inside `submitRideOffer` | Blocks offer if active ride | Query rides by driverId |
| `driver-app/js/driver-app.js` | `isOnlineReady`, `activateDriverOnlineMode`, `setDriverOffline` | Client online gate + GPS | `watchPosition`; writes `vehicles/{id}` |
| `driver-app/js/fresh-location.mjs` | `createFreshLocationService` | Fresh GPS before first online | Timer ~18s |
| `driver-app/js/ride-radar-controller.js` | `initRideRadarFlow` | Blocks radar if offline / busy | UI |
| `driver-app/js/ride-radar-service.js` | `subscribePendingRadarRides` | Skips when busy | Listener `ride_candidates` |
| `firestore.rules` | `partnerIsActiveDriver`, online-ready vehicle rules | Blocked partners cannot go online | Rules |

**Spec vs code (conflict — do not fix yet):**

- Device OS location service ON: **not explicitly probed** (only geolocation success/permission).
- In-app permission: checked via geolocation / fresh-location path.

### 2.2 Idle Firebase location publish (§2–§3)

| File | Symbols | Role | Writes / timers |
|------|---------|------|-----------------|
| `driver-app/js/location-checkpoint-policy.mjs` | `IDLE_LOCATION_INTERVAL_MS`, `MIN_LOCATION_MOVE_M`, `resolveCheckpointPolicy`, `shouldAllowCheckpointWrite`, `createCheckpointPolicyController` | Idle gate when no active ride | Constants: **200 m OR 5 min** |
| `driver-app/js/driver-app.js` | `syncVehicleLocationToFirestore`, `writeOnlineReadyVehicle`, `startLocationWatch` | First-on / re-on force write; checkpoint gate | Write `vehicles/{id}.location` (overwrite latest) |
| `driver-app/js/location-write-queue.mjs` | `createLocationWriteSerializer` | Single-flight; coalesce newest | In-memory |
| `driver-app/js/location-envelope.mjs` | `normalizeLocationFix`, `evaluateFixAgainstPrevious` | GPS validation | — |
| `functions/bargaining.js` | `silentlyRequestStaleLocationRefresh` | Stamps refresh request | Write `vehicles.locationRefreshRequestedAt` |
| `functions/index.js` | `mirrorDriverLocationOnVehicleUpdate` | Rematch when online+geo changes | Trigger on `vehicles` |

**Conflict:** Spec idle = **200 m OR 3 min**. Code idle = **200 m OR 5 min** (`IDLE_LOCATION_INTERVAL_MS = 300_000`).

### 2.3 Offer fan-out (§4) + admin config

| File | Symbols | Role | Writes / config |
|------|---------|------|-----------------|
| `functions/matching.js` | `selectCandidatesProgressive`, `DEFAULT_CANDIDATE_LIMIT`, `validateSearchRadius` | Distance rings until count filled | Pure |
| `functions/geo-match.js` | `loadAndSelectGeoCandidates` | Geo queries | Query vehicles |
| `functions/bargaining.js` | `readDispatchSettings`, `matchRideCandidates`, `rematchNearbySearchingRidesForVehicle` | Fan-out invitations | Write `ride_candidates`, update `rides` |
| `functions/index.js` | `createCustomerBooking`, `matchRideCandidates`, `setCandidateDriverLimit` | Booking + rematch + admin save | Callables |
| `customer-app/js/ride-flow.js` | `rematchWhileSearching`, `startSearchTimers` | Client rematch every 30s | Timer |
| `customer-app/js/offer-client.js` | `matchCandidatesForRide` | Callable wrapper | — |
| `driver-app/js/ride-radar-service.js` | `subscribePendingRadarRides` | Driver receives invites | Listener `ride_candidates` |
| `super-admin-panel/js/admin-app.js` | `loadDispatchSettings`, `saveDispatchSettings` | Admin UI | Read/write via CF → `settings/dispatch` |
| `super-admin-panel/js/admin-settings-client.js` | `saveAdminDispatchSettings` | CF client | Callable |

**Config doc:** `settings/dispatch` — `candidateDriverLimit`, `maxSearchRadiusKm` / meters, `searchRingsKm`.  
**Rule:** Runtime must keep loading these; do not hard-code 10/20 examples.

### 2.4 Bargaining (§5)

| File | Symbols | Role | Listeners / writes |
|------|---------|------|-------------------|
| `functions/bargaining.js` | `submitRideOffer`, `counterRideOffer`, `rejectRideOffer` | Per-driver offers | Write `ride_offers` |
| `driver-app/js/RideRequestDetail.js` | `initRideRequestDetail` | Driver bid UI | Listener `ride_offers/{id}` |
| `driver-app/js/driver-offer-inbox.js` | `createDriverOfferInbox` | Open/countered offers | Query listener |
| `driver-app/js/ride-radar-actions.js` | `submitDriverOffer`, … | CF clients | Callables |
| `customer-app/js/offer-client.js` | `watchRideOffers`, `counterOfferAsCustomer` | Customer offer watch | Listener |
| `customer-app/js/ride-flow.js` | `updateDriverOfferUi`, `onSendCounterOffer` | UI | — |

**Conflict:** Backend supports multi-driver bargaining; **customer UI shows one offer at a time**.

### 2.5 Accept / atomic / close others (§6, §9)

| File | Symbols | Role | Writes |
|------|---------|------|--------|
| `functions/bargaining.js` | `finalizeAssignmentFromOffer`, `acceptCustomerInitialFareAsDriver`, `closeSiblingOffers`, `closeDriverOtherCandidates` | TX first-accept wins; expire siblings | `rides`, `ride_offers`, `ride_candidates`, `partners`, `vehicles` |
| `customer-app/js/offer-client.js` | `finalizeOfferAsCustomer` | Customer accept | Callable |
| `customer-app/js/ride-flow.js` | `onAcceptDriverOffer` | UI | — |
| `driver-app/js/ride-radar-actions.js` | `acceptRideWithBid`, `acceptCustomerInitialFare` | Driver accept | Callables |

### 2.6 Limits (§7)

| File | Symbols | Role |
|------|---------|------|
| `functions/matching.js` | `MAX_CUSTOMER_ACTIVE_BOOKINGS` (=4) | Constant |
| `functions/bargaining.js` | `evaluateCustomerBookingGate`, `createCustomerBooking`, `countCustomerActiveBookings` | Slot + live reconcile |
| `customer-app/js/booking-gate.js` | `checkCustomerBookingGate` | Pre-book gate |
| `customer-app/js/ride-status.js` | `MAX_CUSTOMER_ACTIVE_BOOKINGS` | Client mirror |
| `functions/active-ride-reconcile.js` | driver active-ride checks | 1 ride/driver |

### 2.7 Offer timeout (§8)

| File | Symbols | Role |
|------|---------|------|
| `functions/matching.js` | `SEARCH_EXPIRE_MS` (=3 min) | **Ride search** timeout |
| `functions/bargaining.js` | `expireSearchingBooking`, `expireDueSearchingBookings` | Expire searching rides |
| `customer-app/js/ride-flow.js` | `SEARCH_TIMEOUT_MS`, `onSearchTimedOut` | Client 3 min |

**Conflict:** Spec §8 is **per-offer** timeout (example 30s, admin-configurable). Code has **only booking-level 3 min search** timeout. **No per-offer 30s timer found.**

### 2.8 Offer cleanup (§10)

| File | Symbols | Role | Writes |
|------|---------|------|--------|
| `functions/bargaining.js` | `closeCandidatesAndOffersForRide`, `closeSiblingOffers` | Status → expired/withdrawn | Batch updates |
| `functions/ride-cancellation.js` | `declineRideCandidate`, `withdrawRideOffer`, … | Decline/withdraw | Status fields |

**Note:** Cleanup = status archive, not hard delete (unless admin archive policy added later via config).

---

## 3. PHASE 2 — Existing runtime map

### 3.1 P2P primary + signaling

| File | Symbols | Role | Timers / listeners / writes |
|------|---------|------|-----------------------------|
| `driver-app/js/p2p-protocol.mjs` + customer mirror | `P2P_SEND_INTERVAL_MS=3s`, `P2P_FALLBACK_AFTER_MS=30s`, `FIREBASE_BACKUP_READ_INTERVAL_MS=15s`, … | Constants | — |
| `driver-app/js/p2p-peer-session.mjs` + customer mirror | `createP2pPeerSession` | WebRTC DC location | Health 2s; HB 12s; send ~3s |
| `driver-app/js/p2p-ride-controller.mjs` | `createDriverP2pController` | Offer + answer watch | Listener `ridePeerSessions` |
| `customer-app/js/p2p-ride-controller.mjs` | `createCustomerP2pController` | Answer + arbiter bridge | Listener `ridePeerSessions` |
| `*/p2p-signaling-client.mjs` | create/publish/watch/close | Signaling clients | Callables + `onSnapshot` |
| `functions/ride-peer-session.js` | `createRidePeerOffer`, `publishRidePeerAnswer`, `closeRidePeerSession` | Server SDP broker | Write `ridePeerSessions/{rideId}` |

### 3.2 Location arbiter + Firebase consume

| File | Symbols | Role | Timers |
|------|---------|------|--------|
| `customer-app/js/live-location-source-arbiter.mjs` | `createLiveLocationSourceArbiter` | Prefer P2P; throttle Firebase | Firebase render ≤1 / **15s** |
| `customer-app/js/ride-flow.js` | `handleRideSnapshot`, `renderFromArbiterFix` | Ingest `rides.driverLocation` | Ride `onSnapshot` |

### 3.3 Firebase checkpoint publish (driver) + mirror

| File | Symbols | Role | Cadence (current) |
|------|---------|------|-------------------|
| `driver-app/js/location-checkpoint-policy.mjs` | `resolveCheckpointPolicy`, … | Adaptive Firebase writes | Idle 5min; responsive **4s**; sparse P2P-healthy **30s/60s**; move **200m** |
| `driver-app/js/viewer-presence-consumer.mjs` | `createViewerPresenceConsumer` | Customer viewing lease | Listener `rideViewerPresence` |
| `customer-app/js/viewer-presence-client.mjs` | `createViewerPresenceClient` | Heartbeat ~45s | Callable |
| `customer-app/js/ride-view-lifecycle.mjs` | `createRideViewLifecycle` | Visibility → presence/P2P | visibility listeners |
| `driver-app/js/driver-app.js` | `syncVehicleLocationToFirestore`, `syncDriverP2pForActiveRide`, `checkpointPolicy` | Orchestrates GPS→P2P+Firebase | `watchPosition` |
| `functions/driver-location.js` | `mirrorDriverLocationToRide` | vehicles → rides.driverLocation | CF trigger |
| `functions/index.js` | `mirrorDriverLocationOnVehicleUpdate` | onWrite vehicles | Trigger |

### 3.4 P2P lifecycle / close

| Spec close condition | Current behaviour |
|----------------------|-------------------|
| Driver offline | GPS stopped / vehicle offline; **P2P not always explicitly stopped** |
| Trip complete / cancel | Yes — detach / stop controllers |
| Location permission off | Offline path; **P2P not always explicitly closed** |
| Otherwise stay on | **Conflict:** P2P **suspended** when customer not viewing (viewer lease) |

---

## 4. Spec ↔ runtime conflict register (report only — no resolution)

| ID | Spec | Runtime | Severity |
|----|------|---------|----------|
| C-P1-IDLE-INTERVAL | 200m OR **3 min** | 200m OR **5 min** | High |
| C-P1-DEVICE-LOC-SERVICE | OS location service must be On | Not explicitly checked | Medium |
| C-P1-OFFER-TIMEOUT | Per-offer timeout (admin config; e.g. 30s) | Missing; only **3 min search** timeout | High |
| C-P1-BARGAIN-UI | Simultaneous multi-driver bargain UX | Backend multi; **UI single offer** | Medium |
| C-P2-TEMP-CHECKPOINT | 300m OR 1 min storage while P2P healthy; not live to customer | No 300m/1min rule; sparse 30s/60s + 200m | High |
| C-P2-BACKUP-20S | Backup Mode: 20s live (if viewing); not durable; durable every 3rd OR 200m | Responsive ~4s; read throttle 15s; no 3rd-counter | High |
| C-P2-P2P-HIDDEN | P2P continues with screen closed/background | P2P **suspended** when not viewing | High |
| C-P2-CLOSE-PERMISSION | Close P2P on permission off | Incomplete | Medium |
| C-P2-FALLBACK-MS | (Backup when P2P unavailable) | Fallback after **30s** silence + ICE fail paths | Note — confirm if 30s silence equals “unavailable” |

---

## 5. Collections / docs touched

| Collection | Phase | Purpose |
|------------|-------|---------|
| `vehicles/{id}` | 1+2 | Driver location publish |
| `rides/{id}` | 1+2 | Booking + mirrored `driverLocation` |
| `ride_candidates` | 1 | Invitations |
| `ride_offers` | 1 | Bargaining |
| `booking_slots` | 1 | Customer concurrent booking cap |
| `settings/dispatch` | 1 | Admin fan-out config |
| `ridePeerSessions` | 2 | P2P signaling |
| `rideViewerPresence` | 2 | Customer viewing lease |

---

## 6. What Step 2 deliberately did NOT do

- No runtime edits  
- No Firebase rule changes  
- No P2P behaviour changes  
- No Dispatch behaviour changes  
- No deletions / replacements  

---

## 7. Proposed next step (needs approval) — Step 3 only

After you approve this mapping, Step 3 will produce a **Replacement Plan** that states for each conflict:

- what will be removed  
- what will remain  
- what will be added  
- why (spec § reference)  

Still **no runtime code** in Step 3.

---

## STOP

Awaiting approval of this mapping document and confirmation of any conflict treatment preferences (especially C-P1-OFFER-TIMEOUT and C-P2-P2P-HIDDEN) before Step 3.
