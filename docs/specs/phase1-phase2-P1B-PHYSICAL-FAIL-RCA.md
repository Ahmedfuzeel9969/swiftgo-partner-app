# P1-B Physical FAIL — Root Cause (pointer)

Canonical report: `F:/ride-app-p1a-validate/docs/specs/phase1-phase2-P1B-PHYSICAL-FAIL-RCA.md`

**Verdict:** Offers do not auto-expire because `expireDueRideOffers` is admin-callable only (no Scheduler / no app caller). Clients never read `offerExpiresAt`. Chain stops between wall-clock expiry and any closer invocation.

**P2-C:** blocked. No fix applied in this step.
