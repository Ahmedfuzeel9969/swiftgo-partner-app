# PHASE 4F — Storage Rules Evidence

**Date:** 2026-07-28  
**Rules file:** `storage.rules`  
**Harness:** `npm run test:phase4f-storage` → `tests/phase4f-storage-results.json`  
**Production deploy:** **Not performed**

## Path model

| Path | Who | Actions |
|---|---|---|
| `driver_applications/{uid}/{file}` | Subject (`uid`) | create/update (image &lt;5MB), read, delete |
| same | Claim admin (`token.admin == true`) | **read only** |
| same | Other signed-in users | deny |
| same | Unauthenticated | deny |
| Any other path | Anyone | deny (`/{allPaths=**}`) |

List of another user’s KYC prefix is denied.

## Emulator matrix

| Check | Result |
|---|---|
| Owner upload image | PASS |
| Other upload to owner path | PASS (denied) |
| Unauth upload | PASS (denied) |
| Owner read | PASS |
| Other read | PASS (denied) |
| Admin read | PASS |
| Owner overwrite/update | PASS |
| Other update metadata | PASS (denied) |
| Other list prefix | PASS (denied) |
| Non-KYC path write | PASS (denied) |
| Owner delete own | PASS |
| Other delete | PASS (denied) |

**Totals:** 15 PASS / 0 FAIL

## Controlled Storage deployment plan (do not run without approval)

1. Confirm default Storage bucket exists for `swiftgo-ride-app`.  
2. Backup current live rules (Firebase console → Storage → Rules).  
3. `firebase deploy --only storage --project swiftgo-ride-app`  
4. Smoke: owner upload from Driver onboarding on staging/pilot account; unrelated account cannot download.  
5. Claim-admin account can open KYC for review.  
6. Rollback: paste previous rules text and redeploy Storage only.

## Residual notes

- Storage rules cannot evaluate Firestore `adminBootstrapEnabled`; only **custom claim** admins get KYC read. Complete claim transition before relying on admin review in Production.  
- Historical “Storage setup failed” gap remains until this deploy is explicitly approved and executed.
