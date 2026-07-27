# Phase 1 — Canonical Data Contract

**Source:** Static analysis of `customer-app`, `driver-app`, `owner-app`, `super-admin-panel`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`.  
**No production Firestore reads performed.**

---

## Collections overview

| Collection | Doc ID | Created by | Updated by | Read by |
|------------|--------|------------|------------|---------|
| `users/{uid}` | Auth UID | Customer app (`ensureUserProfile`) | Customer (not `walletBalance`) | Customer |
| `bookings/{id}` | Auto | Customer | Customer | Customer |
| `rides/{id}` | Auto | Customer (`createRideRequest`) | Customer, Driver, Owner (copy) | All four |
| `ride_requests/{id}` | — | **Rules: create denied** | Driver (offers/accept) | Driver radar |
| `partners/{uid}` | Auth UID | Driver/Owner/Admin on first login | Self, Admin, **Driver batch (wallet)** | All apps |
| `vehicles/{id}` | Auto | Owner | Owner, Driver, Admin | Driver, Owner, Admin map |
| `drivers/{uid}` | Auth UID | Driver/Owner bootstrap | **Self (full write)** | Admin, self |
| `driver_applications/{id}` | Auto | Customer onboarding | None (rules deny update) | Applicant |
| `rechargeRequests/{id}` | Auto | Driver wallet UI | Admin approve | Driver, Admin |
| `promoCodes/{codeId}` | Code string | Admin | Admin, Customer increment | Customer, Admin |
| `settings/{document}` | e.g. `pricing`, `driverForm`* | Admin | Admin | All signed-in |

\* `settings/driverForm` referenced in customer code; same rules as `settings/{document}`.

**Not found in code:** `zones`, `hotspots`, `commissions`, `audit_logs`, `notifications`, `complaints`, `wallet_transactions` (dedicated).

---

## `rides/{rideId}` — primary live ride contract

| Field | Type | Required on create | Writers | Notes |
|-------|------|-------------------|---------|-------|
| `userId` | string | Yes | Customer | Must equal auth uid |
| `pickupLocation` | `{lat,lng,address}` | Yes | Customer | address ≤500 |
| `dropoffLocation` | `{lat,lng,address}` | Yes | Customer | |
| `vehicleType` | string | Yes | Customer | |
| `vehicleTypeKey` | string | Optional | Customer | Not in rules schema — still stored |
| `distanceKm`, `timeMins` | number | Yes | Customer | ≥0 |
| `farePkr`, `estimatedFare` | number | Yes / later | Customer, Driver | Offer/accept |
| `status` | string | Yes | All roles (conditional) | See lifecycle doc |
| `createdAt` | timestamp | Yes | Customer | `serverTimestamp()` |
| `driverId`, `vehicleId`, `ownerId` | string | On accept | Driver | Rules verify vehicle |
| `driverName`, `vehiclePlate` | string | On accept | Driver | |
| `driverOffer*` | various | Optional | Driver | Bidding |
| `customerCounterFare` | number | Optional | Customer | Counter-offer |
| `commissionAmount`, `driverEarnings` | number | On complete | Driver | Rules: from `in_progress` only |
| `customerRating`, `ratedAt` | number/timestamp | Optional | Customer | One-time |
| `promoCode`, `discountAmount`, `originalFare` | various | Optional | Customer | |

**Status values (code):** `searching_driver`, `accepted`, `arrived`, `in_progress`, `completed`, `cancelled_by_user`, `declined`.  
**Rules `isValidRide` create:** only `searching_driver`.

**Rules reference:** `firestore.rules` `match /rides/{rideId}` L106–316.

**Indexes:** `status+createdAt`, `userId+createdAt`, `driverId+createdAt`.

**Cloud Function:** None.

---

## `ride_requests/{requestId}`

Mirror shape for radar; **create: false** in rules. Driver updates same offer/accept transitions as rides with `pending` instead of `searching_driver`.

**Code:** `driver-app/js/ride-radar-service.js` subscribes with `status == pending`.

**Contract drift:** Customer never writes `ride_requests`; collection cannot populate without admin/backend — radar relies primarily on `rides.searching_driver`.

---

## `partners/{partnerId}`

| Field | Type | Notes |
|-------|------|-------|
| `role` | `owner` \| `driver` | Self-create/update constrained; not `admin_driver` |
| `accountStatus` | `active` \| `blocked` | Super Admin only |
| `walletBalance` | number | **Driver self-update NOT blocked in rules** — P0 |
| `totalEarnings`, `totalRidesCompleted` | number | Updated on complete in client batch |
| `currentVehicleId` | string | Driver PIN link |
| `customerRatingSum`, `customerRatingCount` | number | Increment rules on rating |
| `email`, `name`, `uid` | string | Profile |

**Drift:** Customer app uses `users.walletBalance`; driver uses `partners.walletBalance`.

---

## `vehicles/{vehicleId}`

| Field | Writers | Notes |
|-------|---------|-------|
| `ownerId` | Owner create | Immutable |
| `driverId`, `status` | Driver claim PIN | `online` |
| `location`, `locationUpdatedAt`, `driverName` | Driver GPS | 8s client throttle |
| `activeRideId` | Driver | `online` / `in_ride` |
| `pin` | Owner | **Readable by any signed-in user** (PIN query) |
| `plate` | Owner | |

---

## `users/{userId}` vs `bookings`

Legacy/history: **bookings** use `service`, `pickup`, `destination`, `fare`, status enum `scheduled|current|completed|cancelled`.  
**rides** are the live ride-hailing path.

---

## Storage paths

| Path | Purpose | Rule |
|------|---------|------|
| `driver_applications/{userId}/{fileName}` | KYC images | Owner read/write ≤5MB image |

---

## Detected inconsistencies

| Issue | Severity |
|-------|----------|
| `users.walletBalance` protected; `partners.walletBalance` not | P0 |
| Customer `completeRideRequest` vs driver `in_progress → completed` | P0 |
| `ride_requests` unused for create pipeline | P1 |
| `drivers/{id}` unconstrained self-write | P2 |
| `vehicleTypeKey` on ride not validated in rules | P3 |
| Super Admin = email string in rules vs `partners.role` in apps | P1 |
| No composite index for geo queries (not used anyway) | P3 |

---

## Default deny

`match /{document=**}` → deny — good. Collections not listed cannot be accessed.
