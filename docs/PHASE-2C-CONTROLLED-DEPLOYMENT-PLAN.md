# Phase 2C — Controlled Deployment Plan

**Date:** 2026-07-27  
**Status:** Plan only — **DO NOT DEPLOY** until separately approved  
**Production:** not touched in Phase 2C

---

## Prerequisites inspection (no deploy)

| Item | Status | Notes |
|------|--------|-------|
| Firebase targets (`.firebaserc`) | Present | Default / swiftgo → `swiftgo-ride-app`; legacy `ravo` alias present — confirm target before any command |
| `firebase.json` | Present | Hosting `hosting-dist`, Firestore rules/indexes, Storage rules, Functions codebase `functions/` |
| Firestore rules | Ready locally | `firestore.rules` claim-admin + bargaining + settlement protections |
| Indexes | Ready locally | `firestore.indexes.json` includes rides / candidates / `vehicles.pinHash` etc. |
| Functions runtime | Node **20** | `functions/package.json` engines.node=20; deps `firebase-admin`, `firebase-functions` |
| Environment | Emulator-proven | Production needs deployed Functions + settings docs (`settings/pricing`, `settings/dispatch`, `settings/security`) |
| Hosting package | Build OK | `npm run build:hosting` exit 0 → `hosting-dist/` |
| Rollback | Documented | See `docs/PHASE-2C-ROLLBACK-PLAN.md` |
| **Billing / plan** | **DEPLOYMENT BLOCKER** | Deploying Cloud Functions requires **Blaze (pay-as-you-go)**. Enabling billing or changing plan was **not** done and requires **separate approval**. |

---

## Recommended controlled order (after approval)

1. **Separate approval** for Blaze / billing if not already enabled.
2. Confirm project `swiftgo-ride-app` (never demo IDs).
3. Deploy **Firestore indexes** (wait until ready).
4. Deploy **Firestore rules** + **Storage rules**.
5. Deploy **Cloud Functions** (settlement, matching, bargaining, booking gate, PIN link, admin claims).
6. Hosting deploy only if UI packaging is in the same approved window (`hosting-dist` via `tools/build-hosting.mjs`).
7. Super Admin claim transition checklist (`PHASE-2C-ADMIN-CLAIM-READINESS.md`) — execute, do not leave email bootstrap on.
8. Vehicle PIN migration dry-run → apply if plaintext remains (`PHASE-2C-PIN-MIGRATION-READINESS.md`).
9. Smoke: create booking, bargain, assign, settle once, blocked driver denied, PIN lockout, fifth booking rejected.
10. Stop; monitor audit_logs / ledger for duplicates.

---

## Explicit non-goals for the controlled window

- No paid load tests
- No production data redesign
- No bargaining / Karachi grid / progressive search model changes
- No enabling billing inside the engineering phase without approval

---

## Go / no-go

| Gate | Result |
|------|--------|
| Emulator verification Phase 2C | **GO** (114 pass / 0 fail / 0 blocked) |
| Unexplained blocked security tests | **GO** (T08/T20 PASS) |
| Blaze / billing approved | **NO-GO until separate approval** |
| Production admin + PIN ops run | **NO-GO until checklists executed** |

**Recommendation:** approve a **controlled deployment** only after billing/plan approval and with the checklists above; do not treat Phase 2C alone as authorization to deploy.
