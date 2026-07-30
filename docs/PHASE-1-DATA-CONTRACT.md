# Phase 1 — Shared Data Contract

**Audit date:** 2026-07-29  
**Scope:** Audit-only. Canonical fields as enforced by Cloud Functions + Rules + primary UI paths.

---

## 1. Canonical identity

| Concept | Collection | Doc ID | Key fields |
|---------|------------|--------|------------|
| Customer profile | `users/{uid}` | Auth UID | displayName, email, walletBalance (display; settlement does not credit customer wallet in CF path) |
| Driver / Owner profile | `partners/{uid}` | Auth UID | `role`: `driver`\|`owner`; `accountStatus`: `active`\|`blocked`\|`suspended`\|`deletion_pending`; `walletBalance`, earnings aggregates, `activeRideId`, `currentVehicleId` |
| Legacy driver profile | `drivers/{uid}` | Auth UID | UI seed only; matching uses `partners` + `vehicles` |
| Super Admin | Auth custom claim `admin: true` | — | Optional `admin_registry`; bootstrap email transitional |

**Ride owner field (canonical):** `rides.userId` only (`functions/matching.js` `CUSTOMER_RIDE_OWNER_FIELD`, `customer-app/js/ride-status.js`).  
**Offer party field:** `ride_offers.customerId` stores the same UID as `rides.userId` (name differs — documented mismatch).

---

## 2. Collections inventory

| Collection | ID strategy | Created by | Updated by | Read by | Rules | Indexes / CF |
|------------|-------------|------------|------------|---------|-------|--------------|
| `users` | Auth UID | Customer | Customer (non-wallet), CF deletion | Self, Admin | Self create wallet=0 | — |
| `partners` | Auth UID | Driver/Owner first login; CF pin-link | Self safe fields; Admin block/wallet; CF settle/match | Self, Admin, CF | Strict wallet deny self | Matching, settlement |
| `rides` | Auto ID | **CF create** (canonical); Rules still allow client create | CF assign/cancel/expire/settle; Driver Rules arrived/start; Customer rating | Owner, assigned, candidates, Admin | Create/update branches | Many; CF all money paths |
| `ride_candidates` | `{rideId}_{driverId}` | CF match only | CF decline/expire/close | Invited driver | Client W denied | `driverId+status` |
| `ride_offers` | `{rideId}_{driverId}` | CF submit | CF counter/reject/finalize/close | Parties | Client W denied | Open bargain queries |
| `booking_slots` | Customer UID | CF | CF reconcile | Customer read | Client W denied | Gate/create |
| `vehicles` | Auto / owner create | Owner (or driver self) | Driver location/online; Owner; CF pin | Owner, linked driver, matching | Active driver for online | `status+geoCell`, hotspot |
| `vehicle_pins` | Vehicle-related | Owner | Owner | Owner | Owner | PIN plaintext risk |
| `pin_attempts` | Attempt docs | CF | CF | Driver | Limited | Pin-link |
| `settings/*` | Fixed docs | Admin | Admin / CF dispatch | Signed-in read | Admin write | pricing, dispatch, security, driverForm |
| `promoCodes` | Code ID | Admin | Customer usedCount++; Admin | Signed-in | Increment race | — |
| `rechargeRequests` | Auto | Driver | Admin approve | Driver/Admin | Admin credit partner | Client credit gap |
| `ledger_transactions` | Deterministic settle ID | CF settlement | — | Parties read | Client W false | Idempotent complete |
| `audit_logs` | Auto | CF (settle, claims, pin, deletion) | — | Admin | Client W false | — |
| `admin_audit` | Auto | `cancelRideByAdmin` only | — | Deny client (catch-all) | No match rule | Dual-audit debt |
| `admin_registry` | Email/uid | CF claims | CF | Admin | Admin | — |
| `driver_applications` | Auto | Customer KYC | — (pending only) | Subject; Admin storage | Create pending | No approve CF |
| `bookings` | Legacy | Customer | Customer | Customer | Separate enum | Parallel debt |
| `ride_requests` | Legacy archive | — | — | Read | Create/update denied | — |
| `account_deletion_requests` | Auto | CF | — | Self | — | CF |
| `support_reports` | Auto | CF | — | Self/Admin | — | CF |
| `ops_metrics` | Metric keys | CF ops | CF | Admin | Admin read | ops/geo |

**Storage:** `driver_applications/{userId}/{fileName}` — image &lt;5MB; owner R/W; claim-admin read.

**No `wallets/` collection** — balance lives on `partners.walletBalance`.

---

## 3. Ride status contract

### Canonical non-terminal (`matching.js` / `ride-status.js`)

`searching_driver` → `accepted` → `arrived` → `in_progress`

### Terminal

| Status | Writer |
|--------|--------|
| `completed` | CF `completeRideSettlement` |
| `expired` | CF expire / gate reconcile |
| `cancelled_by_customer` | CF `cancelCustomerBooking` |
| `cancelled_by_user` | Client Rules cancel while searching (legacy/UI path) |
| `cancelled_by_admin` | CF `cancelRideByAdmin` |
| `cancelled_by_driver` | (rematch path keeps searching; terminal cancel variants per CF) |

### Mismatch

- Live CF cancel prefers `cancelled_by_customer`; Rules client path uses `cancelled_by_user`.  
- UIs often accept both.  
- `settlement.js` cancel guard lists are narrower than full terminal set (usually gated by `in_progress` requirement).

---

## 4. Location / matching fields

| Field | Type | Required for match | Writer |
|-------|------|--------------------|--------|
| `vehicles.status` | `online`\|`offline`\|`in_ride` | Must be `online` | Driver / CF |
| `vehicles.location.{lat,lng}` | number | Yes | Driver |
| `vehicles.locationUpdatedAt` | server Timestamp | Yes on geo path (≤10 min) | Driver |
| `vehicles.geoCell` | `g_{i}_{j}` (~400 m) | Yes for geo query | Driver (`matchGeoCellId`) |
| `vehicles.hotspotId` | string\|null | Optional boost | Driver |
| `vehicles.locationGridCell` | coarse ~1 km | **Not** queried by match | Driver |
| `vehicles.driverId` | UID | Yes (candidate key) | PIN link / claim |
| `vehicles.activeRideId` | string\|null | Must be empty | Settle / assign |

**Rings:** 1 → 2 → 3 km. **Limit:** 10 or 20. **Stale:** 10 minutes. **Search expire:** 3 minutes (`expiresAt`).

---

## 5. Offer / candidate statuses

| Entity | Statuses |
|--------|----------|
| Candidate | `invited`, `declined`, `expired`, `withdrawn` (closed variants) |
| Offer | `open`, `countered`, `accepted`, `rejected`, `withdrawn`, `expired` |

---

## 6. Money fields

| Field | Collection | Client writable? | Server |
|-------|------------|------------------|--------|
| `walletBalance` | partners | **No** (self); Admin Rules yes | Settlement debit; recharge Admin client |
| `totalEarnings` / `totalRidesCompleted` | partners | No | Settlement |
| `commissionPkr` / fare on ride | rides | No on complete | Settlement |
| `ledger_transactions` | ledger | No | Settlement idempotent |

---

## 7. Detected contract defects

| Defect | Severity | Notes |
|--------|----------|-------|
| Client `rides` create still Rules-allowed | P0 | Bypasses slots + may skip auto-match |
| `customerId` vs `userId` on offers | P2 | Same UID, different field name |
| `cancelled_by_user` vs `_customer` | P1 | Dual terminal cancel |
| `admin_audit` vs `audit_logs` | P2 | Ops must query both |
| Legacy `bookings` / `ride_requests` / `drivers` | P2 | Parallel models |
| Client timestamps on some Rules creates | P2 | CF uses serverTimestamp |
| Rating aggregate Rules unbound to ride | P0 | Any user can bump ratings |
| `locationGridCell` ≠ `geoCell` | P2 | Easy to confuse in ops |

---

## 8. Canonical happy-path write sequence

```
createCustomerBooking → rides(searching_driver,expiresAt) + booking_slots++
                     → matchRideCandidates → ride_candidates(invited)
submitRideOffer → ride_offers(open)
finalizeAssignmentFromOffer → rides(accepted) + partners.activeRideId
Driver Rules → arrived → in_progress
completeRideSettlement → rides(completed) + ledger + wallet + slots--
```
