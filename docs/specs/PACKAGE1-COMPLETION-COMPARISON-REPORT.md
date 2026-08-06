# Package 1 — Completion Comparison Report

**Status:** **CLOSED / FROZEN**  
**Recovery tag:** `ssot/package1-complete-20260806`  
**Physical verification:** **PASS** (operator sign-off 2026-08-06)  
**Live deploy:** `https://swiftgo-ride-app.web.app/partner/` · `js/driver-app.js?v=package1_ssot_step2_delete_1`

---

## 1. Scope of Package 1

Remove one legacy client-side ride assignment path from the **driver app** only:

| Removed | File |
|---------|------|
| `resolveActiveRequest(nextStatus)` | `driver-app/js/driver-app.js` |

**Not in scope (unchanged):** Cloud Functions, customer app, owner app, offer expiry, listeners, incoming sheet DOM/stubs.

---

## 2. Before vs After

### 2.1 Runtime behavior

| Behavior | Before Package 1 | After Package 1 |
|----------|------------------|-----------------|
| Customer books ride | `createCustomerBooking` CF | **Identical** |
| Driver sees radar candidates | `subscribePendingRadarRides` + inbox | **Identical** |
| Driver accepts initial fare | `acceptCustomerInitialFare` CF via `ride-radar-actions.js` | **Identical** |
| Driver/customer negotiated assign | `finalizeAssignmentFromOffer` CF | **Identical** |
| Post-assign driver UI | `handleRadarRideAccepted` | **Identical** |
| Ride progression | Client `updateDoc`: accepted → arrived → in_progress | **Identical** |
| Legacy incoming sheet | Disabled; buttons inert | **Identical** |
| `resolveActiveRequest` execution | Never invoked (0 call sites) | **Function deleted** |
| Client Firestore assign | Would fail rules if invoked | **N/A — code gone** |

**Physical verification (live):** All eight checklist items **PASS**. No regression reported.

### 2.2 Business rules

| Rule | Before | After |
|------|--------|-------|
| Assign only via Cloud Functions | Enforced (rules + CF) | **Same** |
| Candidate must be invited | CF checks | **Same** |
| Offer expiry before assign | CF guards (P1-B) | **Same** |
| Vehicle linked / driver active | CF checks | **Same** |
| Single winner assignment | CF transaction | **Same** |
| Client `searching_driver → accepted` | **Denied** by Firestore rules | **Same** |
| Subset assign via client tx (vehicle + fare only) | Latent in dead code | **Removed with dead code** |

**Conclusion:** No business rule changed in production. One **latent bypass implementation** removed.

### 2.3 Files changed

| File | Change |
|------|--------|
| `driver-app/js/driver-app.js` | Deleted `resolveActiveRequest` (**92 lines**) |
| `driver-app/index.html` | Cache-bust query for deploy only |
| `hosting-dist/` | Rebuilt on deploy (generated) |

### 2.4 Files removed

**None.** No files deleted. One function removed from an existing file.

---

## 3. Remaining legacy assignment paths (post–Package 1)

| ID | File | Function | Status | Next package |
|----|------|----------|--------|--------------|
| AP-04 | `owner-app/js/owner-app.js` | `resolveActiveRequest` | **Dead / Legacy bypass** | **Package 2** |
| AP-03 | `driver-app/js/driver-app.js` | ~~`resolveActiveRequest`~~ | **REMOVED** | — |
| LG-02 | `customer-app/js/data.js` | `createBooking` | Dead (`bookings/` collection) | Future |
| LG-07 | `customer-app/js/data.js` | `cancelRideRequest` | Legacy cancel bypass | Future |
| LG-08–10 | `driver-app` | incoming sheet stubs + DOM | Legacy UI shell (disabled) | Future |
| LG-11–12 | `owner-app` | `startRideListener`, `showIncomingRide` | Legacy global dispatch | Future |

**Active authoritative paths (unchanged):**

| Path | Location |
|------|----------|
| `finalizeAssignmentFromOffer` | `functions/bargaining.js` |
| `acceptCustomerInitialFareAsDriver` | `functions/bargaining.js` |

**Active client wrappers (unchanged):**

- Driver: `ride-radar-actions.js`, `RideRequestDetail.js`
- Customer: `offer-client.js`, `ride-flow.js`

---

## 4. Verification summary

| Gate | Result |
|------|--------|
| Step 1 disable + deploy | PASS |
| Step 2 delete + deploy | PASS |
| Automated live hosting health | 34/34 PASS |
| Live bundle: no `resolveActiveRequest` | PASS |
| Lab: phase2a-bargaining | 21/21 PASS |
| Physical ride flow (operator) | **PASS** |
| Regression | **None** |

---

## 5. Freeze policy

- **Do not modify** Package 1 artifacts unless a **bug** is discovered in this specific removal.
- Recovery: git tag `ssot/package1-complete-20260806` or Firebase Hosting rollback to `package1_ssot_step2_delete_1`.
- Next work: **Package 2** (`owner-app` `resolveActiveRequest`) — separate approval required.

---

**Related docs:**

- `docs/specs/PACKAGE1-PHYSICAL-REGRESSION-REPORT.md`
- `docs/specs/RIDE-ASSIGNMENT-SINGLE-SOURCE-OF-TRUTH.md` (§ Package 1 completion)
- `docs/specs/PACKAGE2-PRE-APPROVAL-REPORT.md`
