# Phase 2B — Data Contract

**Date:** 2026-07-27  
**Preserves:** Phase 2A bargaining / booking limits / settlement semantics.

---

## Wallets

| Actor | Collection | Field | Writer |
|-------|------------|-------|--------|
| Driver / owner earnings & commission wallet | `partners/{uid}` | `walletBalance`, `totalEarnings`, `totalRidesCompleted` | Trusted settlement / Super Admin recharge only |
| Customer app display wallet | `users/{uid}` | `walletBalance` | Client create = 0; client updates cannot change it; settlement **never** writes this for drivers |

**Same UID in both collections:** allowed. Driver settlement updates **only** `partners`. Customer wallet remains independent display/compatibility data and is not destroyed.

---

## Bookings

| Collection | Role |
|------------|------|
| `rides` | **Canonical** booking + lifecycle |
| `ride_requests` | Legacy archive — **read-only** for parties/admin; no client create/update/delete; settlement rejects this collection name |

---

## Vehicles / PIN

| Field | Visibility |
|-------|------------|
| `plate`, `model`, `status`, `location` | Owner, assigned `driverId`, Super Admin |
| `pinHash` | Stored; compared only in trusted `linkVehicleByPin` |
| `pin` (legacy plaintext) | Migrated away on successful link (`FieldValue.delete`); new creates use `pinHash` |
| KYC / private docs | Not on vehicle docs; driver applications remain owner-scoped |

Public signed-in users cannot list/query vehicles.

---

## Admin authorization

1. Primary: Auth custom claim `admin: true`.
2. Transitional: verified bootstrap email **only if** `settings/security.adminBootstrapEnabled != false`.
3. Claim admin may disable bootstrap via `setAdminEmailBootstrap`.
4. Ordinary users cannot grant themselves admin via Rules or client writes.

---

## Partner / driver profiles

- `partners` self-update: existing Phase 2A allowlist (no financial fields).
- `drivers` self-update: `displayName`, `name`, `phone`, `photoUrl`, `currentVehicleId`, `updatedAt` only.
- `accountStatus` `blocked` | `suspended` blocks online, bargain, assign finalize, and ride progression.
