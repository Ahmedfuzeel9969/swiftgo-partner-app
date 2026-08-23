# Package 2 — Pre-Approval Report (Ride Assignment Cleanup)

**Status:** Awaiting approval — **no code changes**  
**Prerequisite:** Package 1 **CLOSED / FROZEN** (`ssot/package1-complete-20260806`)  
**Objective:** Remove **one** legacy assignment path — same class as Package 1, **owner app** copy.

---

## Proposed removal (single path)

| # | Field | Value |
|---|-------|-------|
| **1. File name** | `owner-app/js/owner-app.js` |
| **2. Function name** | `resolveActiveRequest(nextStatus)` (~lines 2052–2135) |
| **3. Why it still exists** | Pre–Phase 2A client Firestore transaction from legacy **incoming ride sheet**, copied from driver-app before radar + CF bargaining. Owner shell was never fully aligned with driver radar. |
| **4. Status** | **Dead Code** (latent **Legacy bypass**) |
| **5. Why safe to remove** | See proof below |
| **6. Replacement** | Owner app does **not** drive rides in production today. If owner-as-driver is used, same CF paths as driver app: `acceptCustomerInitialFare`, `finalizeAssignmentFromOffer` (would require owner-app radar parity — **future**, not this package). Removing dead assign code does not remove any **active** owner flow. |
| **7. Rollback plan** | Git tag pre-Package-2 → restore function → `npm run build:hosting` → `firebase deploy --only hosting` with new cache bust on `owner/index.html`. Functions unchanged. |

---

## Proof (same evidence class as Package 1)

### No callers

```
grep "resolveActiveRequest(" → owner-app.js:2052 only (definition)
```

### Early exit in fleet-only mode

```javascript
async function resolveActiveRequest(nextStatus) {
  if (OWNER_FLEET_ONLY) return;  // owner fleet shell
  ...
}
```

### Firestore rules block client assign

`tests/phase2a-emulator-suite.mjs` T02: client `updateDoc` → `status: "accepted"` **fails**. Same rules apply to owner-authenticated driver uid.

### Business rule comparison

| Rule | `resolveActiveRequest` | Authoritative CF |
|------|------------------------|------------------|
| Ride `searching_driver` | Partial | Yes |
| Candidate invited | No | Yes |
| Offer expiry | No | Yes |
| `ride_offers` / `ride_candidates` update | No | Yes |
| `partners.activeRideId`, vehicle `in_ride` | No | Yes |
| Rules allow write | **No** | Yes (CF admin) |

### Package 1 precedent

Driver-app copy removed 2026-08-06; physical verification **PASS**; zero behavior change. Owner copy is **byte-for-byte parallel** legacy code.

---

## Package 2 scope boundaries

**Will do (after approval):**

1. Step 1: Temporarily disable `resolveActiveRequest` in `owner-app.js` (early return)
2. Build, test, deploy hosting only, physical smoke (owner app load + driver app regression spot-check)
3. Step 2: Delete function only
4. Build, test, deploy hosting only, confirm no regression

**Will NOT do:**

- `startRideListener` / global searching query (Package 3+ candidate)
- `showIncomingRide` / incoming sheet DOM
- Customer `createBooking` / `cancelRideRequest`
- Cloud Function consolidation
- Any driver-app (Package 1) changes

---

## Recommended physical verification (Package 2)

Owner app is primarily **fleet/wallet**; minimal ride-assign surface. After deploy:

| # | Check |
|---|-------|
| 1 | Owner app loads at `/owner/` |
| 2 | Driver app full ride flow still PASS (unchanged code path) |
| 3 | Customer book + assign still PASS |
| 4 | No console errors on owner home |

If owner-as-driver mode is used in your environment, repeat Package 1 driver checklist on owner shell.

---

## Approval request

Approve Package 2 to remove **`owner-app/js/owner-app.js` → `resolveActiveRequest`** using the same two-step safety process as Package 1.

**Do not implement until explicit approval.**
