# Customer Ghost Rides, Driver Location, Match Delivery & 3-Minute Expiry

**Date:** 2026-07-29  
**Scope:** Account A ghost/lock, Account B create→Driver delivery, trusted 3-minute expiry  
**Production changes this turn:** **NONE** (no Hosting/Functions/Rules/Indexes deploy; no Production data edits)  
**Final verdict:** **CONDITIONAL PASS**

---

## 1. Exact difference between Account A and Account B

| | Account A | Account B |
|--|-----------|-----------|
| Create booking | Blocked by four-booking gate | Succeeds (real ride ID) |
| Symptom | Asks to clear old searching; clear appears to fail; cannot book | Booking created but Driver app shows nothing |
| Likely class | UID-specific inflated slots and/or uncancellable non-terminal searching ghosts; cancel UX hid real failure reasons | Matching / Driver location eligibility / candidate listen path |

**Production live UID diagnosis was not run** (no Account A/B UIDs supplied; Production read-only query requires separate approval). Class-of-bug fixed and proven in emulator.

---

## 2. Account A counted rides / stale slot cause (emulator + code)

Proven failure modes:

1. **`booking_slots.count` inflated** (e.g. 4) while live non-terminal `rides` for UID = 0 → false MAX.  
   Fix: gate/create always `reconcileCustomerBookingState` then count live `userId` + non-terminal statuses (`A01`).

2. **Four real `searching_driver` ghosts** owned by UID → gate and active list share identical IDs (`A03`).  
   Fix: `cancelAllSearchingBookings` cancels each via trusted cancel, closes candidates/offers, reconciles, returns counts (`A04`).

3. Terminal (`completed` / cancelled / `expired` / declined) **never** count (`A02`).

Ownership field is canonical **`userId` only** (not `customerId` / `riderId`). Legacy `ride_requests` not counted.

---

## 3. Exact cancellation failure (before → after)

**Before:**

- `cancelCustomerBooking` only accepted exact `searching_driver`; opaque `NOT_CANCELLABLE`.
- `cancelAllSearchingBookings` batch-updated without closing candidates/offers; returned only reconcile summary.
- Client on clear failure toasted generic `bookingMaxActive` (looked like cancel failed / still locked).

**After:**

- Cancel: ownership `userId`, cancellable searching only, idempotent if already cancelled/expired, closes candidates/offers, reconciles slots.
- Failures return exact reasons: `RIDE_NOT_FOUND`, `NOT_YOUR_BOOKING`, `NOT_CANCELLABLE:<status>`.
- `cancelAllSearchingBookings` returns `{ cancelledCount, cancelled, skipped, failed, blockingAssigned, activeCount }`.
- Client surfaces `failed[0].reason`, assigned blockers, or success with count.

---

## 4. Account B real ride creation proof (emulator)

`B01`–`B03`:

- Trusted `createCustomerBooking` returns ride ID.
- Canonical `rides/{id}` with `status=searching_driver`, server `expiresAt = now + 3 minutes`.
- `matchRideCandidates` creates `ride_candidates/{rideId}_{driverId}` with `status=invited`.
- Driver listener contract (`driverId` + `invited` + ride still `searching_driver`) would receive it.

Production Account B response capture requires that UID/session — **not performed**.

---

## 5. Test Driver location & freshness

**Code path fix (Account B class):** `updateDriverLocation` previously returned early when the map canvas was not mounted, so **GPS never reached Firestore** while online on non-map views.

Now: when online + vehicle linked, location sync runs **even without map**; local map paint is optional.

Driver readiness strip (`#driverAvailDiag`) reports (no exact coordinates):

- location missing / permission required / stale  
- vehicle not linked / blocked / busy / online ready  

Production live Driver GPS sample was **not** read (no deploy / no Prod inspect).

---

## 6. Distance from pickup

Ring fixtures (`D01`–`D04`):

| Driver | Distance | Result |
|--------|----------|--------|
| 0.5 km | ring 1 | receives |
| 1.5 km | ring 2 | receives when expanded |
| 2.5 km | ring 3 | receives when expanded |
| 4.0 km | — | **never** |

---

## 7. Driver eligibility

Excluded with recorded reasons: missing location, stale (≥10 min), offline, busy (`activeRideId`), blocked, suspended, beyond 3 km (`classifyDriverMatchExclusion` + progressive select). Limits 10 and 20 preserved (`D07`/`D08`, phase3b).

---

## 8. Matching ring / cell results

Contract rings remain **[1, 2, 3] km**. Phase 3B geo suite: **22 PASS / 0 FAIL** (with auth+firestore+storage+functions emulators). No full-fleet restore; geo-scoped + existing capped probe only.

---

## 9. Candidate creation result

Emulator: invited candidate docs written; ride `matchingStatus=candidates_ready` when candidates exist (`B02`, false-success `E06`, phase3b limits).

---

## 10. Driver listener / UI result

Listener remains: `ride_candidates` where `driverId == uid` and `status == invited`, then load ride if `searching_driver`. Expired candidates closed → removed from feed (`E05`). Map-independent location sync unblocks candidate eligibility upstream.

---

## 11. Three-minute expiration design

| Item | Design |
|------|--------|
| Field | Server-set `expiresAt` on create (`Timestamp.now + 3m`); clients cannot change it via allowed ride update keys |
| Terminal status | Canonical **`expired`** (`expireReason=search_timeout_3min`); `no_driver_found` still treated terminal |
| Authority | Trusted `expireSearchingBooking` TX: only `searching_driver` + no `driverId` + past expiry |
| Race | Assignment TX requires `searching_driver`; expiry TX same — one winner (`E06`/`E07`) |
| Side effects | Close candidates/offers; reconcile slots; **no** wallet/commission/ledger/settlement |
| Idempotent | Repeat expiry → `changed:false` (`E04`) |
| Customer UI | Countdown remains; on `expired` / timeout → “کوئی ڈرائیور دستیاب نہ ہوا” |
| Batch | `expireDueSearchingBookings` queries `status==searching_driver` + `expiresAt<=now`, `limit≤50` |
| Scheduler | **Not enabled.** Admin-only callable `expireDueSearchingBookings` for ops/emulator. Cloud Scheduler must wait for billing approval |

Client timer alone is **not** authoritative; it calls the trusted expire callable.

---

## 12. Measured local read/write/invocation estimates

From `E09` batch (limit 10) sample:

- Query reads ≤ `limit` overdue searching docs  
- Per expired ride: ~1 TX read/write + candidate/offer updates  
- Example: `{ processed:1, expired:1, readsEstimate:3, writesEstimate:3 }`

**Suggested Production schedule (not enabled):** every 1 minute, `limit=25`.

| Component | Rough monthly order (illustrative) |
|-----------|-------------------------------------|
| Scheduler invocations | ~43k / month |
| Reads | ~43k × (1 query + ≤25 ride reads) — scales with overdue backlog, not full collection |
| Writes | only for rides actually expired |

**Do not enable billing / Scheduler without approval.**

Required index (declared, **not deployed** this turn):

`rides`: `status ASC`, `expiresAt ASC`

---

## 13. Exact files changed

| File | Role |
|------|------|
| `functions/bargaining.js` | Reconcile→`expired`; cancel repair; `expiresAt` create; batch expire; close candidates/offers |
| `functions/matching.js` | `SEARCH_EXPIRE_MS`, ownership/cancellable constants, exclusion classifier, stale `>=` |
| `functions/index.js` | `expireDueSearchingBookings` admin callable |
| `customer-app/js/ride-status.js` | Shared owner field + expire ms |
| `customer-app/js/ride-flow.js` | Clear-searching result UX; expire handling |
| `customer-app/js/history.js` | Expired history label |
| `customer-app/js/booking-client.js` | Comment |
| `customer-app/index.html` | Cache bust `ghost_rides_expiry_1` |
| `driver-app/js/driver-app.js` | Location sync without map; availability diag |
| `driver-app/index.html` | Diag element + cache bust |
| `driver-app/css/driver-style.css` | Diag styles |
| `firestore.indexes.json` | `status`+`expiresAt` index declaration |
| `tests/ghost-rides-driver-location-expiry-suite.mjs` | Focused suite |
| `tests/ghost-rides-driver-location-expiry-results.json` | Results artifact |
| `docs/CUSTOMER-GHOST-RIDES-DRIVER-LOCATION-EXPIRY-REPORT.md` | This report |

---

## 14. Tests and exit codes

| Suite | Result | Exit |
|-------|--------|------|
| `ghost-rides-driver-location-expiry-suite.mjs` | **37 PASS / 0 FAIL** | 0 |
| `booking-false-success-suite.mjs` | **23 PASS / 0 FAIL** | 0 |
| `phase2a-bargaining-suite.mjs` | **21 PASS / 0 FAIL** | 0 |
| `npm run test:phase3b` | **22 PASS / 0 FAIL** | 0 |
| `npm run test:phase2c` | **114 PASS / 0 FAIL** | 0 |
| `npm run test:phase2e` | Not re-run this turn (browser four-app; optional before deploy) | — |

---

## 15. Minimal required Production deployment surfaces (approval required)

| Surface | Required? | Why |
|---------|-----------|-----|
| **Functions** | **Yes** | Cancel repair, `expiresAt`, expire TX, batch expire callable |
| **Hosting** (Customer + Driver) | **Yes** | Clear UX, expire messaging, map-independent location sync, avail diag |
| **Indexes** | **Yes** (for scheduled/batch expire) | `status` + `expiresAt` |
| **Rules** | Optional / verify | Ensure clients cannot write `expiresAt` (current customer update allowlist already status-only for cancel) |
| **Cloud Scheduler** | **Separate approval** | Enables server-side guarantee without relying on open Customer tab; billing impact |

**STOP — not deployed this turn.**

---

## 16. Confirmation — no unrelated work

No pricing, settlement, wallet, Android packaging, accessibility, legal, or general map redesign beyond the Driver location sync bugfix and small availability strip required for match delivery.

---

## 17. Confirmation — Production not changed

- No `firebase deploy`
- No Production document edits / manual Account A cancels  
- No Play Store upload  
- No billing enablement  

---

## Final verdict

### **CONDITIONAL PASS**

- Emulator proofs for Account A cancel unlock, Account B create→candidate, rings, and 3-minute atomic expiry are green.  
- Driver location-without-map bug fixed in code.  
- Production Account A/B live forensics blocked without UIDs + read approval.  
- Full Production fix needs approved **Functions + Hosting (+ Indexes; Scheduler optional/extra)** — **awaiting separate approval**.
