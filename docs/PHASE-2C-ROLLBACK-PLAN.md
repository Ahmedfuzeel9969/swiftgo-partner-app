# Phase 2C — Rollback Plan

**Date:** 2026-07-27  
**Scope:** Controlled production deploy of Rules / Indexes / Functions / Hosting (when separately approved)  
**Phase 2C itself deployed nothing.**

---

## Principles

1. Prefer **forward fix** for Functions bugs if settlements are in flight; hard-rollback mid-settlement risks wallet skew.
2. Rules rollback must not re-open client wallet / client accept / plaintext PIN query paths without a time-boxed incident plan.
3. Keep prior known-good Rules / Functions artifacts tagged in git before deploy.

---

## Component rollbacks

### Firestore Rules

1. Redeploy previous git-tagged `firestore.rules`.
2. Verify: client cannot `increment` partner wallet; client cannot accept rides; `ride_requests` still create-denied if that was the prior posture.
3. If rolling back past Phase 2B claim-admin, ensure bootstrap email path still matches operational reality.

### Storage Rules

1. Redeploy previous `storage.rules`.
2. Spot-check KYC path owner-only.

### Indexes

1. Indexes are additive; rarely hard-rollback.
2. If a new index causes issues, remove from `firestore.indexes.json` and redeploy; allow unused indexes to age out.

### Cloud Functions

1. Redeploy previous Functions revision / git tag for codebase `default`.
2. If Blaze outage: clients fail closed on callables (Rules still deny client settlement/accept) — expect degraded booking/bargain until Functions restore.
3. Never leave a half-deployed mix of new bargaining clients + old Functions without communication.

### Hosting

1. Redeploy previous `hosting-dist` build artifact / prior release.
2. Confirm `/`, `/partner/`, `/owner/`, `/admin/` routes.

### Admin claims

1. Do **not** mass-revoke all admins during an incident unless compromise suspected.
2. If email bootstrap was disabled and claim admins are locked out: emergency path requires Admin SDK / Google Cloud console custom claims by an operator with GCP access (break-glass) — document operators offline, not in-repo emails.

### PIN migration

1. Migration deletes plaintext `pin` after hashing — **not reversible to plaintext** (by design).
2. Rollback is “keep hashes”; do not restore plaintext PINs.

### Settlement / wallet

1. If duplicate ledger suspected: stop Functions; freeze Super Admin recharges; reconcile from `ledger_transactions` + `audit_logs` before re-enabling.
2. Do not client-patch `partners.walletBalance`.

---

## Decision tree (short)

| Symptom | First action |
|---------|----------------|
| Mass permission denials after Rules deploy | Redeploy previous Rules tag |
| Callables 404 / not found | Confirm Functions deploy + region `us-central1` |
| Settlement errors / double debit risk | Disable settlement callable traffic; reconcile ledger |
| Admin lockout | Break-glass GCP custom claims; temporarily re-enable bootstrap only if claim admin exists to toggle |
| PIN link failures post-migrate | Verify `pinHash` index enabled; check lockout docs |

---

## Confirmation

No rollback was executed in Phase 2C because **nothing was deployed** and **Production was not touched**.
