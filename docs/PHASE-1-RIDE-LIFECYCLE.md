# Phase 1 — Ride Lifecycle Trace

**Audit date:** 2026-07-29  
**Scope:** Audit-only. Canonical path = Cloud Functions + Driver Rules advances.

Status machine:

```
searching_driver → accepted → arrived → in_progress → completed
                 ↘ expired | cancelled_by_customer | cancelled_by_user (client)
accepted|arrived ↘ driver cancel → searching_driver (+ rematch, exclude self)
any pre-start    ↘ admin cancel → cancelled_by_admin
```

---

## Lifecycle steps

| # | Step | App | Function / file | Reads | Writes | Prev → New | Permission | Rules | Server | Race / failure |
|---|------|-----|-----------------|-------|--------|------------|------------|-------|--------|----------------|
| 1 | Gate | Customer | `booking-gate.js` → `checkCustomerBookingGate` | Live rides; may expire overdue; slots | Possible expire + reconcile | — | Auth customer | — | Yes | TOCTOU mitigated in create TX |
| 2 | Create | Customer | `ride-flow.js` → `createCustomerBooking` | Reconcile + slots TX | `rides` + slot++ | → `searching_driver` (+`expiresAt`) | Auth | Client create **still allowed** (bypass risk) | Yes | Soft match after create |
| 3 | Match | Server (+ customer rematch ~30s) | `matchRideCandidates` + `geo-match.js` | dispatch, vehicles geo, partners, candidates | ≤10/20 candidates; ride matching meta | stays searching | Cust/Admin callable | Candidates client W deny | Yes | Empty → probe; injection denied |
| 4 | Radar | Driver | `ride-radar-service.js` | Listen invited candidates; get ride | Local cache | — | Candidate driver | Read if invited + searching | — | getDoc drop surfaced |
| 5 | Offer | Driver | `submitRideOffer` | Capacity, candidate, ride TX | `ride_offers` open | ride unchanged | Active driver | Offers W deny | Yes | Busy / capacity 10 |
| 6 | Counter/reject | Customer | CF counter/reject | Offer TX | Offer status | — | Ride owner | — | Yes | vs finalize |
| 7 | Decline/withdraw | Driver | CF decline/withdraw | Candidate/offer | closed | ride stays searching | Invited driver | — | Yes | Rematch skips declined |
| 8 | Assign | Cust or Drv | `finalizeAssignmentFromOffer` | Offer+ride+partner TX | ride accepted; offer accepted; `activeRideId` | searching → accepted | Party UID | Client accept **denied** | Yes TX | Dual finalize → one winner |
| 9 | Close siblings | Server | `closeSiblingOffers` | Offers | expire/withdraw others | — | — | — | Yes | Brief open window |
| 10 | Arrived | Driver | `driver-app.js` updateDoc | — | status only | accepted → arrived | Assigned | Rules allow | No CF | Double-tap; cancel race |
| 11 | Start | Driver | same | — | status only | arrived → in_progress | Assigned | Rules allow | No CF | No financial cancel after |
| 12 | Complete | Driver | `completeRideSettlement` | ride, ledger, pricing, partner, slot | completed + ledger + wallet + slot | in_progress → completed | Assigned/Admin | Client complete **denied** | Yes + idempotent | Retry safe |
| 13 | Rate | Customer | `submitRideRating` | ride | rating fields (+ partner aggregates UI) | stays completed | Ride owner | Ride rating OK; **partner aggregate Rules weak** | — | Forge risk |
| 14 | Owner observe | Owner | `owner-app.js` | rides by ownerId / fleet | location on own vehicles | observe | Owner | Rules list | — | Listener cost |
| 15 | Admin observe/cancel | Admin | `admin-app.js` / `cancelRideByAdmin` | rides, settings | cancel / settings | → cancelled_by_admin | Claim/email | Settings Admin; cancel CF | Cancel CF | `in_progress` cancel undefined |
| 16 | Expire | Customer timer / CF / gate | `expireSearchingBooking` | ride / indexed query | expired; close cand/offers; slot | searching → expired | Owner/Admin | — | Yes | vs assign one winner |

---

## High-risk transitions

| Transition | Expected control | Actual | Gap |
|------------|------------------|--------|-----|
| searching → accepted | Server TX | CF finalize | OK; sibling cleanup lag |
| Dual accept | One winner | Client accept denied; CF TX | OK for CF path |
| accepted → arrived | Assigned driver | Client Rules | No server audit |
| arrived → in_progress | Assigned driver | Client Rules | No server audit |
| in_progress → completed | Settlement CF | Enforced | OK |
| Customer skip complete | Denied | Phase1 T05 PASS | OK |
| Cancel vs assign | Last TX | Both require searching/unassigned appropriately | UX race remains |
| Client create without match | Should deny | Rules still allow | **P0** |

---

## Matching foundation (Task 7)

| Question | Finding |
|----------|---------|
| Online storage | `vehicles.status` (+ partner `activeRideId`) |
| Location collection | Browser geolocation → Firestore ≤60s or on match-`geoCell` change |
| Local history upload | No trajectory upload; point snapshots only |
| Stale reject | ≥10 min or missing timestamp on geo path |
| Zones/hotspots | `geoCell` grid + Golden `hotspotId` ≤0.5 km |
| 1→2→3 km | Progressive rings; sorted by haversine |
| Max drivers | 10 or 20 only |
| Suspended/busy/offline/stale | Excluded |
| Fake eligibility client | Candidate/offer writes denied; vehicle online requires active partner |
| Indexes | `status+geoCell`, candidate `driverId+status`, ride `status+expiresAt` |
| Client vs server match | Server only; `onlineDrivers` injection denied |
| Latest-driver-in-city | **No** — geo-scoped, not city-wide latest |

**Match R/W estimate (limit 10, early fill):** ~45–55 reads + ≤11 writes. Sparse+probe adds ≤25 vehicle reads. Not full-fleet.

---

## Error / recovery (Task 9) — foundation

| Scenario | Behavior | Risk |
|----------|----------|------|
| Disconnect before create | No ride | Controlled |
| Create OK, match empty | Soft `no_candidates`; rematch ~30s | Driver may appear late |
| Dual finalize | One TX wins | OK |
| Driver disconnect after accept | Ride stays accepted; no auto-reassign | Stuck until cancel/rematch |
| Refresh mid-ride | Listeners reattach to `rides/{id}` | Generally recovers |
| Duplicate complete | Ledger idempotent | OK |
| Cancel while assign | One winner | Possible customer “failed cancel” UX |
| False success toast | Guarded by `ride?.id` | Fixed in current tree |
| Stale GPS | Soft offline after repeated fails; matching excludes stale | Intermittent no-invite |

---

## App roles summary

| App | Role in lifecycle |
|-----|-------------------|
| Customer | Gate, create, rematch, bargain, cancel pre-start, rate, expire client |
| Driver | Presence, radar, offer, assign, arrived/start, settle, pre-start cancel→rematch |
| Owner | Fleet observe + vehicle PIN; execution forked off |
| Super Admin | Dispatch limit, visibility, admin cancel, ops metrics |
