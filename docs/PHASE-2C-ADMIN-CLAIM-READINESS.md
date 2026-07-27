# Phase 2C — Super Admin Claim Readiness

**Date:** 2026-07-27  
**Production Auth/Firestore:** **not touched**  
**Emails / tokens:** not printed in this report

---

## Intended Super Admin accounts (identity only)

| Slot | How identified (no email in report) | Authority path |
|------|-------------------------------------|----------------|
| Bootstrap operator | Single configured bootstrap email constant in `functions/admin-claims.js` (`BOOTSTRAP_ADMIN_EMAIL`) | Transitional email path **only while** `settings/security.adminBootstrapEnabled !== false` |
| Claim admins | UIDs granted via `grantAdminClaim` / stored in `admin_registry` | Primary: Auth custom claim `admin: true` |
| Ordinary users | Any non-claim, non-bootstrap Auth user | Must be denied admin callables and Super Admin Rules |

---

## Emulator verification (executed)

Suite: `tests/phase2c-e2e-suite.mjs` case **C03-admin-claim-transition**  
Command (via): `npm run test:phase2c`  
Emulators: Auth `9099`, Firestore `8080`  
Result: **PASS**  
Evidence: `tests/phase2c-e2e-results.json`

| Check | Expected | Actual |
|-------|----------|--------|
| `admin: true` claim auth | Allowed by `isAdminAuth` | PASS |
| Ordinary user | Denied admin | PASS |
| Ordinary cannot `grantAdminClaim` | `ADMIN_ONLY` / permission-denied | PASS |
| `bootstrapAdminClaim` | Sets `customClaims.admin === true` | PASS |
| `grantAdminClaim` then `revokeAdminClaim` | Grant sets claim; revoke clears to `admin: false` | PASS |
| Disable email bootstrap | `adminBootstrapEnabled: false` blocks email path + bootstrap callable | PASS |
| Re-enable for further local tests | Claim admin can toggle back | PASS |

Related Phase 2B cases (regression inside Phase 2C run): S02 / S03 / S05 — PASS.

---

## Production checklist (DO NOT EXECUTE in Phase 2C)

Exact controlled-production sequence (separate approval required):

1. Confirm Blaze / Functions deploy already approved (see deployment plan).
2. Deploy Functions including admin claim callables.
3. Ensure `settings/security.adminBootstrapEnabled` is `true` (or absent → transitional default true).
4. Sign in as the **designated bootstrap operator** (verified email).
5. Call `bootstrapAdminClaim` once; force token refresh; confirm ID token contains `admin: true`.
6. As claim admin, `grantAdminClaim` for each additional intended Super Admin UID.
7. Each new admin: sign out/in or `getIdToken(true)`; confirm `admin: true`.
8. Spot-check: ordinary user calling `grantAdminClaim` / `bootstrapAdminClaim` is denied.
9. Revoke a test admin (if used); after token refresh, Super Admin Rules paths fail for that UID.
10. Call `setAdminEmailBootstrap(false)` as a claim admin.
11. Confirm bootstrap email path no longer grants Super Admin without claim.
12. Record audit_logs entries for bootstrap / grant / revoke / flag toggle.
13. Do **not** leave bootstrap enabled longer than necessary.

---

## Readiness verdict

**Emulator: READY.**  
**Production transition: NOT PERFORMED** (verification-only phase).  
Safe to schedule under a separately approved controlled deployment after Functions are live.
