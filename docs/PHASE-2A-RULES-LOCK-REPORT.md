# Phase 2A — Critical contract / Rules correction

**Date:** 2026-07-29  
**Project:** `swiftgo-ride-app`  
**Source:** Phase 1 CONDITIONAL PASS remediation (user approved)

---

## Changes shipped

| ID | Fix | Layer |
|----|-----|-------|
| P0-001 | Client `rides` create → `allow create: if false` | `firestore.rules` |
| P0-001 | `createRideRequest` throws `USE_CREATE_CUSTOMER_BOOKING_CF` | `customer-app/js/data.js` |
| P0-002 | Partner rating aggregates no longer client-writable | `firestore.rules` |
| P0-002 | Trusted `submitCompletedRideRating` callable | `functions/ride-rating.js` + `index.js` |
| P0-002 | Customer rating UI calls CF | `customer-app/js/data.js` |
| P0-003 | Email bootstrap **default OFF** (must set `settings/security.adminBootstrapEnabled: true`) | Rules + `admin-claims.js` |
| P1-004 | `partners.role` locked after create (only legacy `admin_driver`→`driver` demotion) | `firestore.rules` |

**Not in this cut (deferred):** KYC gate before go-live; Admin recharge callable/ledger (P1-005 / P1-008).

---

## Tests (emulator)

| Suite | Result |
|-------|--------|
| `npm run test:phase1` | **22 PASS / 0 FAIL** |
| `phase2a-emulator-suite.mjs` | **36 PASS / 0 FAIL** |
| `phase2b-security-suite.mjs` | **24 PASS / 0 FAIL** |

---

## Ops note — Super Admin bootstrap

After deploy, Super Admin access requires:

1. Auth custom claim `admin: true`, **or**
2. Explicit `settings/security` with `adminBootstrapEnabled: true` **and** verified bootstrap email.

If claim is already granted, no action needed. To re-enable transitional bootstrap once:

```
settings/security = { adminBootstrapEnabled: true }
```

Then call `bootstrapAdminClaim` and set `adminBootstrapEnabled: false` again.

---

## Cache bust

Customer Hosting: `?v=phase2a_rules_lock_1`
