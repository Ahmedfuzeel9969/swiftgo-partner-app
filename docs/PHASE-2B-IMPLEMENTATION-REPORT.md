# Phase 2B — Implementation Report

**Date:** 2026-07-27  
**Verdict: CONDITIONAL PASS**  
**Production Firebase:** Not touched. No deploy.

---

## 1. Risks addressed

| Risk | Final status |
|------|--------------|
| P1-004 Super Admin email bootstrap | **MITIGATED** — claim-primary; email gated by `settings/security.adminBootstrapEnabled` (default true until claim admins disable it) |
| P1-007 Dual wallet users/partners | **CLOSED** — canonical driver wallet = `partners.walletBalance`; customer display = `users.walletBalance`; settlement never writes `users` |
| P1-008 `drivers/{id}` broad write | **CLOSED** — allowlisted self-updates only |
| P1-011 Vehicles world-readable | **CLOSED** — owner / assigned driver / Super Admin only; PIN query removed from clients |
| P1-013 Blocked driver online | **CLOSED** — rules + bargain/match; **T07 PASS** |
| P1-018 Vehicle PIN brute force | **CLOSED** — hash storage, CF link, 5-attempt / 15-min lockout, audit without PIN |
| P1-019 `ride_requests` legacy | **CLOSED** — read-only archive; canonical = `rides`; settlement rejects `ride_requests` |
| P1-016 Functions not deployed | **ACCEPTED** (this phase) — emulator-only |

---

## 2. Files changed (reason)

| File | Reason |
|------|--------|
| `firestore.rules` | Claim/bootstrap admin; drivers allowlist; vehicle privacy; blocked online/progress; ride_requests lock; pin_attempts/admin_registry |
| `firestore.indexes.json` | `vehicles.pinHash` |
| `functions/admin-claims.js` | Bootstrap / grant / revoke / toggle email bootstrap |
| `functions/pin-security.js` | Hash + lockout helpers |
| `functions/pin-link.js` | Trusted PIN link |
| `functions/index.js` | Wire Phase 2B callables; admin auth via settings |
| `functions/settlement.js` | Canonical `rides` only; reject legacy collection |
| `functions/bargaining.js` | Blocked/suspended deny on offer/finalize |
| `functions/matching.js` | Exclude suspended |
| `driver-app/js/pin-hash.js`, `pin-link-client.js` | Hash + CF link client |
| `driver-app/js/driver-app.js` | PIN via CF; store pinHash on create |
| `driver-app/js/settlement-client.js` | Force `rides` |
| `driver-app/js/ride-radar-service.js` | Document legacy archive |
| `owner-app/js/pin-hash.js`, `owner-app.js`, `settlement-client.js` | pinHash create; no ride_requests settle |
| `super-admin-panel/js/admin-app.js` | Claim-aware admin check helpers |
| `tests/phase1-emulator-contract.mjs` | T07 real PASS |
| `tests/phase2a-emulator-suite.mjs` | T07 real PASS |
| `tests/phase2b-security-suite.mjs` | New S01–S24 |
| `tests/phase2b-run-all.mjs` | Merge runner |
| `package.json` | `test:phase2b`, `build:hosting` |
| `docs/PHASE-2B-*.md` | Reports |

---

## 3. Canonical sources of truth

| Domain | Canonical | Secondary / compatibility |
|--------|-----------|---------------------------|
| Driver/owner financial wallet | `partners/{uid}.walletBalance` | `users.walletBalance` is customer-display only; never written by settlement |
| Bookings | `rides` | `ride_requests` read-only legacy archive |
| Super Admin | Auth custom claim `admin: true` | Email bootstrap while `settings/security.adminBootstrapEnabled != false` |

---

## 4–8. Key results

- **Custom claims:** Claim admin writes settings; ordinary/revoked denied; bootstrap disable closes email path (S01–S06).
- **T07 / blocked driver:** **PASS** (Phase 1 + 2A + S13–S16).
- **Vehicle privacy:** Unrelated users cannot get/query vehicles/PIN (S12).
- **PIN:** Lockout after 5 fails; success strips plaintext; no PIN in response (S17–S21).
- **Legacy collection:** Create/update denied; settlement rejects `ride_requests` (S09, S22).

---

## 9–11. Commands / totals

See `docs/PHASE-2B-SECURITY-TEST-EVIDENCE.md`.

---

## 12–14. Residual / deploy / production

See `docs/PHASE-2B-RESIDUAL-RISKS.md` and `docs/PHASE-2B-DEPLOYMENT-READINESS.md`.

**Production not touched.**
