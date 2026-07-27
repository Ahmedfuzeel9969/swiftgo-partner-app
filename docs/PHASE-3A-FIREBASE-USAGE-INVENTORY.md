# PHASE 3A — Firebase Usage Inventory

**Date:** 2026-07-27  
**Scope:** Complete repository static scan + code-path review  
**Production touched:** No  
**Billing enabled:** No  
**Machine scan:** `npm run test:phase3a` → `tests/phase3a-inventory-results.json` (61 call-site groups)

Static call-site totals (not billable units):

| Service:operation | Call sites |
|---|---:|
| firestore:listener | 32 |
| firestore:write | 34 |
| firestore:read | 26 |
| firestore:transaction | 12 |
| functions:function-export | 16 |
| functions:function-call | 8 |
| auth:auth | 6 |
| auth:auth-listener | 4 |
| storage:upload/download | 1 / 1 |
| firestore:read-aggregate | 1 |
| firestore:delete | 1 |
| firestore:write-batch | 1 |

---

## 1. Customer App

| Module / file | Firebase service | Path / Function | Op | One-time / recurring | Frequency | Users | Necessary? | Duplicate risk | Stops on screen close? |
|---|---|---|---|---|---|---|---|---|---|
| `auth.js` | Auth | email/password, `onAuthStateChanged` | auth / listener | session | login + auth changes | 1 customer | Yes | Low | Auth listener lives for app session |
| `booking-client.js` / `booking-gate.js` | Functions | `checkCustomerBookingGate`, `createCustomerBooking`, `cancelCustomerBooking` | invocation | per booking event | ≤4 concurrent bookings | customer | Yes | Gate may precede create | N/A |
| `data.js` / `ride-flow.js` | Firestore | `rides/{id}`, `ride_offers` | listener / read / write | recurring while booking active | status + offer updates | 1 customer (+ mirrors) | Yes | Multiple ride watchers if 4 bookings | Should detach when booking UI ends |
| Map/search (OSRM/Nominatim) | *(non-Firebase)* | — | — | — | — | — | — | — | — |

**Notes:** Customer does not write high-frequency GPS to Firebase. Booking creation and matching are Function-mediated.

---

## 2. Driver / Partner App

| Module / file | Firebase service | Path / Function | Op | Recurring? | Frequency | Necessary? | Duplicate risk | Stops when closed? |
|---|---|---|---|---|---|---|---|---|
| `driver-app.js` location path | Firestore | `vehicles/{id}` location fields | write | Yes while online | **1 / min** + zone-change (~1 km grid) | Yes (approved model) | Was 8s — fixed in 3A | Stops when offline / app teardown |
| `ride-radar-service.js` | Firestore | `ride_candidates` query | listener | Yes while radar on | per candidate change | Yes | Duplicate radar subscribe if re-entered without unsub | Unsub on radar stop |
| Offer / assignment callables | Functions | `submitRideOffer`, `finalizeAssignmentFromOffer`, `completeRideSettlement` | invocation | event | bargain → settle | Yes | Settlement retries idempotent | N/A |
| Active ride listeners | Firestore | `rides/{id}`, offers | listener | Yes during trip | status progression | Yes | Customer + driver both listen same ride (necessary) | Detach after complete/cancel |
| P2P live path | *(local/WebRTC-style)* | — | — | during trip | high-frequency local | Yes | Firebase fallback only on failure | Fallback must stop on P2P recovery (report recommendation) |
| PIN link | Functions | `linkVehicleByPin` | invocation | rare | link events | Yes | Low | N/A |
| KYC / docs | Storage + Firestore | storage paths + partner/vehicle docs | upload / write | rare | onboarding | Yes | Re-download if UI reopens docs | On demand |

---

## 3. Owner App

| Module / file | Firebase service | Path | Op | Recurring? | Necessary? | Stops when closed? |
|---|---|---|---|---|---|---|
| `owner-app.js` fleet / rides | Firestore | owner-scoped `vehicles`, `rides` | listener / read | While dashboard open | Yes for live fleet | Must stop when dashboard closed (approved) |
| Location (owner-driven vehicle) | Firestore | `vehicles/{id}` | write | 1/min + zone | Same approved model | When vehicle offline |
| Earnings / wallet views | Firestore | partners, ledger | read / listener | screen-scoped | Yes | On navigate away |

---

## 4. Super Admin App

| Module / file | Firebase service | Path / Function | Op | Recurring? | Necessary? | Duplicate risk | Stops when closed? |
|---|---|---|---|---|---|---|---|
| `admin-app.js` fleet monitor | Firestore | `vehicles`, `partners`, limited rides | listener | While admin logged in | Operational | **P1** — vehicles listener always-on even if map closed | `stopLiveData` on logout |
| `fleet-map.js` | Firestore | `vehicles` | listener | **Only while live-map open** | Yes (approved) | Dual vehicles listen if map + fleet monitor both active | **OPT done:** `stopFleetMap()` when leaving `live-map` |
| Total rides stat | Firestore | `rides` count | `getCountFromServer` | ~60s poll | Yes | Was unbounded `onSnapshot(collection(rides))` — **removed** | Interval cleared with live data stop |
| Dispatch settings | Functions | `getDispatchSettings`, `setCandidateDriverLimit` | invocation | rare | Yes | Low | N/A |
| Admin claims | Functions | `bootstrapAdminClaim`, `grantAdminClaim`, `revokeAdminClaim` | invocation | rare | Yes | Low | N/A |
| KYC review | Storage + Firestore | KYC objects | download / read | on review | Yes | Large images → bandwidth | On demand |

---

## 5. Cloud Functions (`functions/`)

| Function | Typical Firestore ops | Frequency | Necessary? | Cost note |
|---|---|---|---|---|
| `createCustomerBooking` | slot + ride create | per booking | Yes | Bounded |
| `cancelCustomerBooking` | ride + candidates cleanup | cancel | Yes | Candidate fan-out cleanup |
| `matchRideCandidates` | **reads all online/`in_ride` vehicles + partner docs**; writes ≤10/20 candidates | per match | Yes (business) | **P0 at scale** — O(online drivers) |
| `submitRideOffer` / `counterRideOffer` / `rejectRideOffer` | offer + ride reads/writes | bargain | Yes | Grows with counters |
| `finalizeAssignmentFromOffer` | multi-doc assignment | once per ride | Yes | |
| `completeRideSettlement` | txn: ride, wallet, ledger, audit | once (retries idempotent) | Yes | Retries add invocations + reads |
| `linkVehicleByPin` | vehicle query by pinHash | rare | Yes | |
| Admin claim / dispatch helpers | settings / auth claims | rare | Yes | |

---

## 6–9. Platform services

| Service | Usage in system | Recurring? | Cost relevance |
|---|---|---|---|
| **Firestore** | Core state for rides, offers, candidates, vehicles, partners, ledger, audit, settings | Dominant | Highest bill risk |
| **Authentication** | Email/password (and related) across four apps | Per session | Usually small vs Firestore |
| **Storage** | KYC / vehicle documents | Rare per user | Bandwidth + storage GiB |
| **Hosting** | Four static apps | CDN egress | Modest unless heavy admin image use |
| **Listeners** | Real-time UI | While screens open | Billed as **document reads** (Standard edition) |

---

## Lifecycle map (one ride)

1. **Booking** — `createCustomerBooking` (+ optional gate)  
2. **Matching** — `matchRideCandidates` → `ride_candidates` × N (10 or 20)  
3. **Bargaining** — offers / counters (customer + candidate drivers listen)  
4. **Assignment** — `finalizeAssignmentFromOffer`  
5. **Arrived / started** — ride status writes; P2P preferred for live location  
6. **Completed / settlement** — `completeRideSettlement` → ledger + audit  
7. **Presence** — independent of ride: online drivers write location 1/min + zone  

---

## Inventory limitations

- Static scan counts **call sites**, not runtime multiplicity (N drivers × listeners).  
- Emulator does not expose Production billable counters; per-ride numbers combine measured Function/doc deltas with a code-path estimate (`tests/phase3a-per-ride-measurement.mjs`).  
- Hosting/CDN and Auth phone quotas were not exercised in emulator measurement.
