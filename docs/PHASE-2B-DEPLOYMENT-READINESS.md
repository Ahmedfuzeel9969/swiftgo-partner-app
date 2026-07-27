# Phase 2B — Deployment Readiness

**Date:** 2026-07-27  
**Controlled deployment ready?** **Not yet — CONDITIONAL.**

---

## Ready locally / emulator

- Rules, matching, bargaining, settlement, PIN link, admin-claim helpers tested on Firestore emulator.
- Hosting package builds (`npm run build:hosting`) without deploy.
- Phase 1 + Phase 2A regressions green; Phase 2B security suite green.

## Required before any controlled production deploy (separate approval)

1. Deploy Firestore Rules + indexes.
2. Deploy Cloud Functions (settlement, matching, bargaining, PIN link, admin claims).
3. Bootstrap Super Admin: call `bootstrapAdminClaim`, verify `admin: true`, then `setAdminEmailBootstrap(false)`.
4. Confirm all owner vehicles have `pinHash` (migrate remaining plaintext `pin` via Admin script if needed).
5. Smoke: blocked driver cannot go online; PIN lockout; one settlement; candidate limits.
6. Do **not** enable billing / load tests in that controlled window unless separately approved.

## Explicitly out of scope this phase

- No production writes
- No Functions/Rules/app deploy
- No UI redesign

---

## Verdict implication

**CONDITIONAL PASS** for Phase 2B engineering closure.  
**Not cleared for production** until the checklist above is executed under a dedicated deploy approval.
