# PHASE 4F — Admin Claim Transition Plan

**Date:** 2026-07-28  
**Production execution:** **NOT PERFORMED** (requires separate approval)

## Current design (already in repo)

| Piece | Behavior |
|---|---|
| Primary authz | Custom claim `admin: true` |
| Transitional bootstrap | Verified email constant may call `bootstrapAdminClaim` while `settings/security.adminBootstrapEnabled !== false` |
| Grant/revoke | `grantAdminClaim` / `revokeAdminClaim` (audited) |
| Disable bootstrap | `setAdminEmailBootstrap(false)` — **requires claim admin** |

Emulator suites (Phase 2B/2C/2E) already exercise this path.

## Production transition checklist (approved ops window only)

1. Sign in as bootstrap operator (verified email).  
2. Call `bootstrapAdminClaim` → confirm token refresh shows `admin: true`.  
3. Grant at least **one additional** claim admin (`grantAdminClaim`) — recovery redundancy.  
4. Verify both admins can open Super Admin console operations.  
5. Call `setAdminEmailBootstrap(false)`.  
6. Confirm bootstrap email **without** claim is denied for admin callables.  
7. Confirm `audit_logs` contain bootstrap / grant / flag events.  
8. Document admin UIDs in offline ops vault (not in git).

## Audited recovery method (preserve)

If all claim admins are locked out:

1. Project Owner with GCP/Firebase IAM uses **Firebase Auth console → custom claims** (or Admin SDK from a break-glass service account) to set `admin: true` on a recovery UID.  
2. Log the incident in `audit_logs` via Admin SDK write or ops ticket ID.  
3. Optionally re-enable bootstrap **temporarily** only with dual control, then disable again after recovery.  
4. Rotate any compromised accounts.

Do **not** commit service-account keys or recovery passwords to git.

## Disable transitional email bootstrap

- Target state: `settings/security.adminBootstrapEnabled == false`  
- Callable: `setAdminEmailBootstrap`  
- Only after ≥2 verified claim admins exist  

## Verification commands (emulator rehearsal)

```text
npm run test:phase2b
# or focused admin claim cases inside phase2c / phase2e
```

Production verification must be a separate approved runbook execution — not part of Phase 4F code commit.
