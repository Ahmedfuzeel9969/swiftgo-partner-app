# Step 3 — Replacement Plan (DOCUMENTATION ONLY)

**Status:** PLANNING ONLY — **no runtime changes**. Awaiting approval before Step 4.  
**Baseline mapping:** `docs/specs/phase1-phase2-STEP2-RUNTIME-MAPPING.md` (approved)  
**Spec:** `docs/specs/phase1-phase2-location-dispatch.spec.mjs`  

**Hard rule:** Nothing in this document authorizes code edits until Step 4 is explicitly approved.

---

## 0. Two independent Phase 2 Firebase policies (mandatory separation)

These must **never** be merged into one timer/gate in implementation.

### Policy A — Backup Storage Policy (P2P healthy / primary)

| Field | Value |
|-------|--------|
| When | P2P in use / healthy (Firebase **not** live delivery) |
| Purpose | Temporary backup **storage** on Firebase only |
| Trigger | **300 m OR 1 minute** (whichever first) |
| Live to customer? | **No** |
| Direction | Driver → Firebase |
| Spec | `PHASE2.backupStoragePolicy` |

### Policy B — Backup Live Delivery Policy (Backup Mode only)

| Field | Value |
|-------|--------|
| When | P2P unavailable / disconnected / failed → **Firebase Backup Mode** |
| Purpose | Live location to customer via Firebase |
| Live trigger | **20 s OR 200 m** (whichever first) |
| Customer viewing gate | Yes — **only** for this Firebase live path |
| Durable/permanent store | **Every 3rd** backup live update |
| Direction | Driver → Firebase → Customer |
| Spec | `PHASE2.backupLiveDeliveryPolicy` |

---

## 1. Conflict register → planned treatment (record only)

| ID | Conflict | Spec | Runtime today | Step 4 intent (plan only) |
|----|----------|------|---------------|---------------------------|
| C-P1-IDLE-INTERVAL | Idle publish | 200m OR **3 min** | 200m OR **5 min** | Replace idle interval constant/policy branch only |
| C-P1-OFFER-TIMEOUT | Per-offer timeout | Admin-configurable per-offer expiry (example 30s) | Only **3 min search** timeout | **Add** new per-offer timeout path; keep search timeout unless spec says otherwise |
| C-P2-P2P-HIDDEN | P2P vs screen | P2P stays on; visibility affects Firebase only | P2P **suspended** when not viewing | Decouple P2P lifecycle from viewer visibility; keep visibility on Firebase Backup Live gate only |
| C-P2-FIREBASE | Phase 2 Firebase | Policy A + Policy B as above | Sparse 30/60s, responsive 4s, read throttle 15s; no 300m/1min; no 20s/3rd | Replace checkpoint matrix with Policy A / Policy B |

Also noted (lower priority, still plan):

| ID | Note |
|----|------|
| C-P1-DEVICE-LOC | Spec requires OS location service On — plan explicit probe if platform API available; else report capability gap before coding |
| C-P1-BARGAIN-UI | Backend multi-offer OK; customer UI single-offer — **out of scope unless separately approved** (spec §5 UX) |

**Numeric examples:** Never hard-code 10/20/30s as sole runtime source. Prefer `settings/dispatch` / Super Admin config; introduce new config keys only when approved in Step 4 for missing knobs (e.g. per-offer timeout, idle interval).

---

## 2. Planned change packages (max scope for later stages)

Implementation (Step 4+) must still be split into tiny stages (2–3 tasks). This plan groups **what** will change, not **when** all at once.

### Package P1-A — Idle Firebase publish (§2–§3)

#### Touch surface

| Kind | Existing item |
|------|----------------|
| File | `driver-app/js/location-checkpoint-policy.mjs` |
| Constants | `IDLE_LOCATION_INTERVAL_MS` (=300000), `MIN_LOCATION_MOVE_M` (=200), `CHECKPOINT_POLICY.NO_ACTIVE_RIDE` |
| Functions | `resolveCheckpointPolicy`, `shouldAllowCheckpointWrite`, `createCheckpointPolicyController` |
| File | `driver-app/js/driver-app.js` |
| Functions | `syncVehicleLocationToFirestore`, `writeOnlineReadyVehicle`, `startLocationWatch`, `activateDriverOnlineMode` |
| Controllers | `checkpointPolicy` instance (`createCheckpointPolicyController`) |
| Queue | `driver-app/js/location-write-queue.mjs` → `createLocationWriteSerializer` |
| Envelope | `driver-app/js/location-envelope.mjs` |
| Listener | `startLocationRefreshRequestWatch` → `vehicles.locationRefreshRequestedAt` |
| GPS | `navigator.geolocation.watchPosition` / `getCurrentPosition` |
| Write | `updateDoc(vehicles/{vehicleId})` → `location`, `locationUpdatedAt`, geo fields |
| Trigger | `functions/index.js` → `mirrorDriverLocationOnVehicleUpdate` (idle rematch path) |
| Dispatch | `functions/bargaining.js` → `silentlyRequestStaleLocationRefresh`, `rematchNearbySearchingRidesForVehicle` |
| Diagnostics aliases | `shared/js/phase1-billing-diagnostics.mjs` `CFG_IDLE_LOCATION_INTERVAL_MS` |
| Tests | `tests/runtime-validation-phase3.mjs`, `tests/checkpoint-policy.mjs` (if present), `tests/cross-device-validation-phase4.mjs`, `tests/runtime-consistency.mjs`, `tests/p2p-webrtc.mjs` (policy matrix) |

#### Remain unchanged
- First-on / re-on force write behaviour (unless proven wrong).
- Latest-only overwrite of `vehicles.location`.
- Active-ride Policy A/B logic (handled in Package P2-*).
- Matching eligibility freshness threshold (`STALE_LOCATION_MS`) — **separate**; report if it must stay 5 min while idle write becomes 3 min (potential conflict — do not silently change).

#### Remove / replace
- Replace idle branch interval **5 min → 3 min** (or admin-config key if introduced).
- Keep **200 m OR interval** OR semantics.

#### New logic
- Optional: read idle interval from `settings/dispatch` if key added (e.g. `idleLocationIntervalMs`); until then, constant = 3 min per spec §2.

#### Why / spec
- Phase 1 §2 Firebase location update (200m OR 3 min).

#### Dependencies (before any edit)

| Function | Callers | Callees | Dependents |
|----------|---------|---------|------------|
| `resolveCheckpointPolicy` | `createCheckpointPolicyController.currentDecision`, tests | none (pure) | All write gates |
| `shouldAllowCheckpointWrite` | controller `evaluateWriteGate` | distance helpers | `syncVehicleLocationToFirestore` |
| `createCheckpointPolicyController` | `driver-app.js` init | resolve/shouldAllow | GPS publish path |
| `syncVehicleLocationToFirestore` | GPS watch callbacks, refresh watch, online write | envelope, checkpointPolicy, write queue, `driverP2p.onLocationFix` | vehicles writes → CF mirror |
| `IDLE_LOCATION_INTERVAL_MS` | policy + diagnostics CFG + tests | — | Consistency suites |

**Firebase collections:** `vehicles` (write), indirectly `rides` if active (not Phase 1 idle), rematch via CF.  
**P2P:** Idle path should not require P2P.  
**Dispatch:** Rematch on location refresh may still fire — do not break.

---

### Package P1-B — Per-offer timeout (§8)

#### Touch surface (existing)

| Kind | Existing item |
|------|----------------|
| Search timeout (KEEP unless approved otherwise) | `functions/matching.js` `SEARCH_EXPIRE_MS`; `expireSearchingBooking`; customer `SEARCH_TIMEOUT_MS` |
| Offers | `functions/bargaining.js` `submitRideOffer`, `closeCandidatesAndOffersForRide`, `closeSiblingOffers` |
| Collections | `ride_offers`, `ride_candidates` |
| Listeners | Driver `RideRequestDetail` / `driver-offer-inbox`; customer `watchRideOffers` |
| Admin | `settings/dispatch` via `readDispatchSettings` / `setCandidateDriverLimit` — **no offerTimeout field today** |
| UI | Super Admin dispatch form — no offer-timeout control today |

#### Remain unchanged
- Booking-level **3 min search** expiry (unless operator later says replace it).
- Atomic assignment TX.
- Fan-out distance/count from admin config.

#### Remove
- Nothing mandatory on day one (no existing per-offer timer to delete).

#### Replace / add (plan)
- **New** server field on `ride_offers` / invitations: e.g. `offerExpiresAt` (server time).
- **New** expiry path: scheduled CF / on-read check / batch sweeper — exact mechanism chosen in Step 4 design sub-step after approval.
- **New** admin config key (preferred): `offerTimeoutSeconds` under `settings/dispatch` (example 30 — not hard-coded sole source).
- On expiry: mark offer/candidate expired/withdrawn; notify client (existing status listeners).
- Client UX: optional countdown — only if approved (may be separate stage).

#### Why / spec
- Phase 1 §8 offer lifetime; §10 cleanup.

#### Dependencies

| Component | Depends on | Depended by |
|-----------|------------|-------------|
| `submitRideOffer` | eligibility, `ride_offers` write | driver radar actions |
| `finalizeAssignmentFromOffer` | offer still open + ride searching | customer/driver accept |
| `expireSearchingBooking` | ride `expiresAt` | customer search timer |
| Offer listeners | `status in open/countered` | UI |

**Risk:** Expiring an offer must not expire the whole search if other offers remain.  
**Risk:** Race with accept TX — expiry must be transactional / failed-precondition safe.

---

### Package P1-C — Eligibility OS location service (§1) — optional / gated

#### Touch surface
- `driver-app/js/fresh-location.mjs`, `driver-app.js` `isOnlineReady` / `activateDriverOnlineMode`
- Possibly Permissions Policy / `navigator.permissions` / Android WebView bridges

#### Plan
- Document platform capability first in Step 4 preflight.
- If no reliable OS “location service master switch” API → **stop and ask** (do not fake it).

#### Spec
- Phase 1 §1.

---

### Package P2-A — Decouple P2P from customer screen visibility (Conflict 3)

#### Touch surface

| Kind | Existing item |
|------|----------------|
| File | `driver-app/js/driver-app.js` |
| Function | `syncDriverP2pForActiveRide` — currently passes `viewerVisible` from lease |
| File | `driver-app/js/p2p-ride-controller.mjs` |
| Function | `syncForRide({ viewerVisible })` → **`suspend()` when `!viewerVisible`** |
| File | `customer-app/js/p2p-ride-controller.mjs` |
| Function | `setVisible(false)` → **`session.suspend()`** |
| File | `customer-app/js/ride-flow.js` |
| Calls | `customerP2p.setVisible` / `syncForRide(..., { isVisible })` from view lifecycle |
| File | `customer-app/js/ride-view-lifecycle.mjs` | visibility → presence + live listener |
| Presence | `viewer-presence-client.mjs`, `viewer-presence-consumer.mjs`, `functions/ride-viewer-presence.js` |
| P2P session | `p2p-peer-session.mjs` `suspend`, `startAsDriver`/`startAsCustomer` |
| Signaling | `ridePeerSessions` watch/create/close |

#### Remain unchanged
- P2P close on: trip complete, trip cancel, (planned) offline, (planned) location permission off.
- Presence lease system for **Firebase** cadence / Backup Live viewing gate.
- Comm modules (Chat/Voice/Call) — do not retarget unless affected by suspend change (report if DC shared).

#### Remove / replace
- **Remove** behaviour: “hidden customer → suspend P2P / tear down PC”.
- Driver: `syncForRide` must **not** suspend solely due to `viewerVisible === false`.
- Customer: `setVisible(false)` must **not** suspend P2P session; may still stop presence heartbeat / Firebase live consumption.

#### New logic
- P2P remains started for execution statuses while ride active and not in close conditions.
- Viewer visibility feeds **only** Policy B live delivery gate (and any non-P2P UI), not P2P transport.

#### Why / spec
- Phase 2 §1 continuous P2P; visibility is Firebase-only.

#### Dependencies

| Function | Callers | Callees | Side effects |
|----------|---------|---------|--------------|
| `syncDriverP2pForActiveRide` | presence lease change, active ride attach/detach, network online, visibility-related paths | `driverP2p.syncForRide`, `checkpointPolicy.setP2pHealthy` | Starts/stops/suspends P2P |
| `driverP2p.syncForRide` | above | `start` / `suspend` / `stop` | Signaling + PC |
| `customerP2p.setVisible` | `ride-flow` lifecycle | `suspend` / `attachWatch` | PC tear-down today |
| Presence heartbeat | view lifecycle | CF `refreshRideViewerPresence` | Lease doc |
| Checkpoint policy | GPS write gate | uses lease + p2p healthy | Firebase write cadence |

**P2P modules:** peer-session, ride-controllers, signaling.  
**Firebase:** presence docs remain; vehicles writes remain.  
**Dispatch:** none directly.  
**Battery/data note:** Keeping P2P with screen off is **spec-required**; list as intentional behaviour change in regression notes.

---

### Package P2-B — Replace checkpoint matrix with Policy A + Policy B

#### Touch surface (heavy)

| Kind | Existing item |
|------|----------------|
| File | `driver-app/js/location-checkpoint-policy.mjs` |
| Policies today | `RESPONSIVE_FIREBASE` (4s), `P2P_SPARSE_*` (30/60s), `BACKGROUND_*` (30/60s), `NO_ACTIVE_RIDE` |
| Functions | `resolveCheckpointPolicy`, `shouldAllowCheckpointWrite`, `createCheckpointPolicyController`, `setP2pHealthy`, `setViewerLease` |
| Orchestrator | `driver-app.js` `syncVehicleLocationToFirestore` |
| Mirror | `functions/driver-location.js` `mirrorDriverLocationToRide` |
| Trigger | `mirrorDriverLocationOnVehicleUpdate` |
| Customer arbiter | `live-location-source-arbiter.mjs` (`FIREBASE_BACKUP_READ_INTERVAL_MS=15s`) |
| Customer ingest | `p2p-ride-controller.ingestFirebaseLocation`, `ride-flow.handleRideSnapshot` |
| Constants | `p2p-protocol.mjs` fallback/read intervals |
| Diagnostics | `phase1-billing-diagnostics.mjs`, `phase2-runtime-verification.mjs`, field-diagnostics |

#### Remain unchanged
- Direction Driver → Firebase → Customer.
- Arbiter preference: P2P wins while healthy (Firebase live ignored for render).
- Settlement formulas (explicitly out of scope — checkpoint docs already warn sparse undercount).
- Phase 1 idle package (P1-A) isolation.

#### Remove / replace
- Remove/retire meaning of current sparse 30/60 + responsive 4s **as the Phase 2 source of truth**.
- Replace with:
  - **Policy A** when P2P healthy: write storage cadence **300m OR 1 min**; **do not** treat these writes as live customer delivery (arbiter already blocks while P2P healthy — keep/enforce).
  - **Policy B** when P2P unavailable: live publish cadence **20s OR 200m**; only propagate live to customer if viewing; durable save every **3rd** live update.

#### New logic (conceptual)
- Explicit mode flag: `p2pPrimary` vs `firebaseBackupMode` (derived from P2P health / unavailable — align with existing `isHealthy` / fallback, confirm 30s silence vs “unavailable” in Step 4 preflight — **do not invent** if ambiguous).
- Counter for “Nth live backup update” for durable save.
- Possibly separate “ephemeral live write” vs “durable stored write” if product requires non-mirrored live — **if current architecture only has `vehicles.location` → mirror, report conflict**: today every vehicles write can mirror to ride and become customer-visible on snapshot. Spec says temporary storage while P2P healthy must **not** go to customer live — arbiter handles render suppression; confirm whether mirror should also be gated. **Flag for approval before coding.**

#### Why / spec
- `PHASE2.backupStoragePolicy` + `PHASE2.backupLiveDeliveryPolicy`.

#### Dependencies

| Piece | Upstream | Downstream |
|-------|----------|------------|
| `evaluateWriteGate` | GPS fix stream | vehicles write |
| `setP2pHealthy` | `driverP2p.onHealthyChange` | policy mode |
| `setViewerLease` | presence consumer | Policy B viewing gate |
| Mirror CF | vehicles onWrite | `rides.driverLocation` |
| Arbiter | P2P ingest + Firebase ingest | map render |
| Verification tests | hard-coded 4s/15s/30s/60s/5min | must be rewritten with approval |

**Critical dependency conflict to resolve in Step 4 preflight (ask if needed):**  
If every `vehicles.location` write mirrors to `rides.driverLocation`, Policy A storage writes are still on the ride doc. Customer must not **render** them while P2P healthy (arbiter). Confirm whether mirror should skip / mark `backupStorageOnly` while P2P healthy.

---

### Package P2-C — P2P close conditions completion

#### Touch surface
- `setDriverOffline` in `driver-app.js`
- Location permission error handlers
- `detachCheckpointPresence`, `driverP2p.stop`
- Customer terminal status stops (already largely OK)

#### Plan
- Ensure offline + permission-off explicitly stop/close P2P + signaling.
- Do not close P2P on visibility hide (Package P2-A).

#### Spec
- Phase 2 P2P close conditions.

---

## 3. Explicit non-goals (will NOT change without new approval)

- Chat / Voice Message / Voice Call UI and comm protocol modules (except incidental shared DC lifecycle from P2P suspend change — must be regression-tested).
- Billing / fare settlement formulas.
- Matching algorithm redesign (rings/geo) beyond config-driven limits.
- Hard-coding example 10/20 drivers or 30s as only source.
- Deleting `ride_offers` documents wholesale (status archive remains unless archive policy config approved).
- Changing Diagnostics **behaviour** beyond updating constants/tests that assert old intervals (those tests must move with policy — listed in checklist).

---

## 4. Suggested Step 4 stage order (after approval — still one stage at a time)

1. **Stage 4.1** — P1-A idle 5→3 min (+ tests/CFG sync)  
2. **Stage 4.2** — P2-A decouple P2P from visibility  
3. **Stage 4.3** — P2-C close on offline/permission  
4. **Stage 4.4** — P2-B Policy A storage only  
5. **Stage 4.5** — P2-B Policy B live delivery + every-3rd durable  
6. **Stage 4.6** — P1-B per-offer timeout + admin config key  
7. **Stage 4.7** — Isolation audit Phase1 vs Phase2  

Each stage: implement → review → build → tests → report → **wait**.

---

## 5. Regression checklist (required before/after each Step 4 stage)

### Must keep working
- Driver go online / offline  
- Radar invitations + bargaining offer/counter  
- Atomic accept (first wins; siblings close)  
- Customer max 4 bookings; driver 1 active ride  
- Search timeout 3 min (until deliberately changed)  
- P2P offer/answer signaling when both viewing  
- Firebase fallback when P2P truly down  
- Location envelope validation / write serializer single-flight  
- CF mirror does not corrupt assignment  
- Super Admin dispatch radius/limit save/load  

### Could accidentally break
- Rematch-on-move / stale location refresh  
- Sparse vs responsive billing diagnostics / phase2 verification reports  
- Viewer presence lease expiry  
- Customer map freshness / arbiter throttling  
- Comm Chat/Voice/Call if DataChannel lifecycle changes  
- Partial-cancel distance accumulation (sparser storage)  
- Tests hard-coded to 5 min / 4s / 15s / 30s / 60s  

### Tests to run (stage-appropriate subset + full related)
- `tests/checkpoint-policy.mjs` / `runtime-validation-phase3.mjs` / `runtime-consistency.mjs` / `cross-device-validation-phase4.mjs`  
- `tests/p2p-webrtc.mjs`, `tests/p2p-customer-receive.mjs`  
- Dispatch/bargaining suites: `phase2a-bargaining-suite.mjs`, `dispatch-booking-radar-e2e.mjs`, `dispatch-readiness-race.mjs`  
- Booking limits / ghost rides suites as applicable  
- `npm run build:hosting` when client files change  
- Functions unit/emulator tests when CF offer-timeout added  

---

## 6. Open points to confirm before Step 4 coding (do not guess)

1. **Mirror gating:** While Policy A storage writes occur under healthy P2P, should `rides.driverLocation` mirror be suppressed, or is arbiter-only suppression enough?  
2. **“P2P unavailable” definition:** Equals existing `FIREBASE_FALLBACK` / `!isHealthy()` / ICE failed / DC closed — confirm the exact predicate.  
3. **Search timeout vs offer timeout:** Keep both (3 min search + per-offer timeout)?  
4. **Admin keys:** Approve new `settings/dispatch` fields for idle interval + offer timeout before implementing?  
5. **Bargain UI multi-offer:** In or out of this feature track?

---

## 7. What Step 3 did / did not do

| Done | Not done |
|------|----------|
| Detailed replacement plan | Runtime edits |
| Separated Policy A vs Policy B | Deleting old logic |
| Dependency notes | Firebase rules changes |
| Regression checklist | Dispatch/P2P behaviour changes |
| Updated spec naming for two policies | Step 4 implementation |

---

## STOP

Submit this Replacement Plan for approval.  
**Do not start Step 4 until explicit operator approval** (including answers to §6 open points where possible).
