# PHASE 4F — Controlled Deployment Plan

**Date:** 2026-07-28  
**Status:** Prepared only — **do not execute without separate explicit Production approval**

## Scope of a future approved window

Ordered steps for `swiftgo-ride-app`:

1. **Preflight**  
   - Confirm Blaze plan / billing alerts exist  
   - Tag git commit used for deploy  
   - Ensure local suites green: `test:phase4f-storage`, `test:phase4f-ops`, plus regression (`phase2c`/`phase2d` as needed)

2. **Firestore rules + indexes** (if changed)  
   - `firebase deploy --only firestore:rules,firestore:indexes`

3. **Storage rules**  
   - `firebase deploy --only storage`  
   - Smoke KYC upload/read matrix on pilot accounts

4. **Cloud Functions (includes Node 22 runtime cutover)**  
   - `firebase deploy --only functions`  
   - Confirm console shows **nodejs22**  
   - Smoke: booking gate, match, settlement, new ops callables

5. **Admin claim transition**  
   - Follow `PHASE-4F-ADMIN-CLAIM-PLAN.md`  
   - Disable email bootstrap only after redundant claim admins exist

6. **PIN inventory → migrate**  
   - Follow `PHASE-4F-PIN-MIGRATION-PLAN.md`  
   - Inventory first; migrate only if plaintext remains

7. **Hosting** (if UI already approved for republish)  
   - `firebase deploy --only hosting`  
   - Separate from security cutover if desired

8. **Post-deploy verification**  
   - `getGeoCellCoverageReport` once as admin  
   - `getOpsHealthSummary` once as admin  
   - No full-fleet matching regressions  
   - Watch Cloud Logging for `function_error` / `settlement_failure`

## Explicit prohibitions until approval

- Do not deploy Storage Rules  
- Do not change Production admin claims / bootstrap flag  
- Do not query/migrate Production PINs  
- Do not change Production Functions runtime  
- Do not alter billing  

## Rollback

See `PHASE-4F-MONITORING-AND-ROLLBACK.md`. Prefer layer-scoped redeploys from the pre-window git tag.

## Sign-off template

| Role | Name | Date | Approved? |
|---|---|---|---|
| Business owner |  |  |  |
| Tech operator |  |  |  |
| Scope (rules/functions/pins/claims) |  |  |  |
