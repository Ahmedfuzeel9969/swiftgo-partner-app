# Phase 1 — Foundation, Data Flow, and Four-App Integration Audit

**Project:** SwiftGo (`swiftgo-ride-app`) — Karachi-oriented ride-hailing  
**Audit date:** 2026-07-29  
**Scope:** AUDIT ONLY — no production code changes, no Rules changes, no deploy, no production Firestore/Storage writes, no billing enablement  
**Emulator project:** `demo-swiftgo-phase1`  
**Supersedes:** prior Phase 1 docs dated 2026-07-27 (those predated Cloud Functions and geo matching)

---

## A. Executive Verdict

**CONDITIONAL PASS**

The four apps share one Firebase project, a mostly consistent `rides` / `userId` contract, and a **trusted Cloud Functions layer** for booking create, matching, offers, assignment, settlement, cancel/expire, and PIN link. Emulator contract suites for Rules (20/20), bargaining, security, booking reach, ghost/expiry, and cancel are green.

Foundation is **not** production-ready because residual Rules gaps still allow unauthorized or bypass states (client `rides` create without slot accounting; partner rating aggregate forge; driver↔owner self-role flip; email bootstrap Super Admin default-on).

---

## B. Foundation Score

| Area | Max | Score | Notes |
|------|-----|-------|-------|
| Project structure and build | 10 | **9** | Four vanilla apps + Functions; `build:hosting` exit 0 |
| Authentication and roles | 15 | **11** | Google + claim admin; bootstrap email + role flip remain |
| Shared data contracts | 20 | **15** | Canonical `userId` path strong; dual cancel enums / legacy debt |
| Ride lifecycle consistency | 20 | **16** | CF create→match→offer→assign→settle; arrived/start still client Rules |
| Firestore/Storage rule alignment | 15 | **11** | Wallet/complete hardened; create + rating gaps |
| Server-side protection | 10 | **8** | Settlement/match/assign trusted; recharge still client Admin write |
| Error/recovery foundation | 5 | **4** | TX assign/settle; soft match; rematch; GPS soft-offline |
| Existing test health | 5 | **4** | Phase1 20/20; phase2a/2b green; static audit 2 FAIL |
| **Total** | **100** | **78** | |

---

## C. Critical Risks (summary)

| ID | Sev | Title |
|----|-----|-------|
| P1-2026-001 | **P0** | Client can still `create` `rides` (Rules) bypassing `booking_slots` / auto-match |
| P1-2026-002 | **P0** | Any signed-in user can increment any partner’s `customerRatingSum/Count` |
| P1-2026-003 | **P0** | Super Admin email bootstrap default-on when `settings/security` missing |
| P1-2026-004 | **P1** | Partner may self-switch `role` between `driver` and `owner` |
| P1-2026-005 | **P1** | No KYC gate before Driver go-live / matching |
| P1-2026-006 | **P1** | Dual cancel statuses (`cancelled_by_user` vs `cancelled_by_customer`) |
| P1-2026-007 | **P1** | Arrived / in_progress are client Rules writes (no server audit) |
| P1-2026-008 | **P1** | Admin recharge wallet credit is client batch, not callable/ledger |
| P1-2026-009 | **P2** | Dual audit collections (`audit_logs` vs `admin_audit`) |
| P1-2026-010 | **P2** | Matching depends on fresh `geoCell` + location; soft create+empty match |
| P1-2026-011 | **P3** | Duplicated firebase/i18n modules across four apps |

Full register: [PHASE-1-RISK-REGISTER.md](./PHASE-1-RISK-REGISTER.md)

---

## D. Four-App Connectivity Verdict

| Connection | Reliable? | Evidence |
|------------|-----------|----------|
| Customer ↔ Driver | **Mostly yes** | CF booking + candidates + offers + assign; radar listens invites |
| Driver ↔ Owner | **Partial** | Shared `vehicles` / `ownerId`; same Google may own both roles |
| Customer ↔ Owner | **Indirect** | Via rides `ownerId` only |
| All apps ↔ Super Admin | **Partial** | Claim/email gate; ops callables; client settings writes |
| All clients ↔ Firestore Rules | **Mostly aligned** | Phase1 T01–T20 PASS; residual create/rating gaps |
| Client ↔ trusted server | **Strong for money/match** | Settlement, match, assign, cancel CF; recharge gap |

---

## E. Test Evidence (this audit run)

| Command | Exit | Result |
|---------|------|--------|
| `npm run build:hosting` | **0** | 4 apps → `hosting-dist/` |
| `npm run test:phase1` | **0** | **20 PASS / 0 FAIL / 0 BLOCKED** |
| `npm run test:phase2b` | **0** | phase2b-run-all **91 PASS** |
| `node tests/phase2a-bargaining-suite.mjs` (emulator) | **0** | **21 PASS** |
| `booking-false-success-suite.mjs` | **0** | **23 PASS** |
| `ghost-rides-driver-location-expiry-suite.mjs` | **0** | **39 PASS** |
| `booking-cancellation-contract-suite.mjs` | **0** | **18 PASS** |
| `booking-driver-reach-suite.mjs` | **0** | **11 PASS** |
| `npm run test:i18n` | **0** | EN/UR 368 keys, 0 leftovers |
| `npm run test:audit` | **1** | 255 PASS / **2 FAIL** (static wiring assertions) |

Details: [PHASE-1-TEST-EVIDENCE.md](./PHASE-1-TEST-EVIDENCE.md)

---

## F. Unverified Items

| Item | Why |
|------|-----|
| Live browser console / Playwright four-app E2E (`test:phase2e`) | Not re-run this audit (heavy; Hosting+Functions emulator) — marked **unverified**, not FAIL |
| Production Firestore live forensics (Account A/B UIDs) | Forbidden by audit safety rules |
| FCM push when app backgrounded | Not implemented — N/A |
| Lint / TypeScript typecheck | No ESLint/tsc project scripts for apps (vanilla JS) — **N/A** |
| Cloud Scheduler batch expire | Intentionally off (billing) — not tested as live trigger |
| Started-ride (`in_progress`) financial admin cancel | Explicitly undefined in product (`STARTED_RIDE_ADMIN_CANCEL_UNDEFINED`) |
| Real GPS load / Maps quota | Forbidden this phase |

---

## G. Recommended Next Phase

**Phase 2A: Critical contract/rules correction**

Priority corrections (audit-only recommendation — do not implement until approved):

1. Deny client `rides` create (trusted `createCustomerBooking` only).  
2. Tie partner rating increments to completed ride ownership.  
3. Lock `partners.role` after create (or Admin-only change).  
4. Disable email bootstrap by default (`adminBootstrapEnabled: false`) after claim migration.  
5. Align cancel status enums; move arrived/start to trusted callables if product requires audit.

Do **not** begin Phase 2B/2C/2D until 2A Rules gaps above are closed or explicitly accepted.

---

## Task 1 — Project Structure Map

| App/Component | Main Path | Responsibility | Shared or Separate | Risk/Observation |
|---------------|-----------|----------------|--------------------|------------------|
| Customer | `customer-app/` | Book, map, wallet UI, history | Separate SPA | Served at `/` and `/customer/` |
| Driver/Partner | `driver-app/` | Online, GPS/`geoCell`, radar, offers, settle | Separate SPA | `/partner/`; first login seeds `partners.role=driver` |
| Owner | `owner-app/` | Fleet, PIN share, owner rides | Separate SPA | `/owner/`; may seed `role=owner` |
| Super Admin | `super-admin-panel/` | Ops, pricing, block, recharges, map | Separate SPA | `/admin/`; claim + email bootstrap |
| Cloud Functions | `functions/` | Booking, match, bargain, settle, cancel, PIN, claims | Server | Region `us-central1`, Node 22 |
| Firestore Rules | `firestore.rules` | Client AuthZ | Shared | Naming: `isOwner` = UID owner, not fleet owner |
| Storage Rules | `storage.rules` | KYC under `driver_applications/` | Shared | Claim-admin read only |
| Indexes | `firestore.indexes.json` | Query indexes | Shared | Includes `status+expiresAt`, `geoCell` |
| Hosting build | `tools/build-hosting.mjs` | Path mount 4 apps | Tooling | No CDN role gate |
| Tests | `tests/` | Emulator contracts | Root | Strong phase coverage |
| Mobile | `mobile/{customer,partner,owner}` | Capacitor shells | Separate | Sync from hosting build |

**Stack:** Vanilla HTML/CSS/ES modules + Firebase JS SDK 10.14.1 + Leaflet; no React for web apps.  
**Secrets:** No `.env` in repo; web `apiKey` committed (expected); bootstrap email hardcoded (risk).

---

## Task 2 — Application Startup Verification

| Check | Command / method | Exit | Result |
|-------|------------------|------|--------|
| Hosting package all 4 apps | `npm run build:hosting` | **0** | SUCCESS |
| Customer/Driver/Owner/Admin HTML present | Inspect `hosting-dist/` | — | Present under `/`, `/partner/`, `/owner/`, `/admin/` |
| Live shell HTTP (read-only) | Via `test:audit` HTTP probes | — | Live `/` → 200 (no writes) |
| Fatal missing env | Code review | — | Hardcoded firebase-config; demo emulators on localhost + `?emulators=1` |
| Role cross-open | Code + Hosting | — | Any role can **load** any URL; Admin non-claim redirected to `/partner/` after auth |
| Logout | Code review | — | Firebase `signOut`; local caches cleared per-app (not fully verified in browser this run) |

**Browser console / unhandled rejections:** Not re-executed in Playwright this audit → **Unverified**.

**Do not silently fix:** No production code was modified in this audit.

---

## Companion documents

1. [PHASE-1-DATA-CONTRACT.md](./PHASE-1-DATA-CONTRACT.md)  
2. [PHASE-1-RIDE-LIFECYCLE.md](./PHASE-1-RIDE-LIFECYCLE.md)  
3. [PHASE-1-PERMISSION-MATRIX.md](./PHASE-1-PERMISSION-MATRIX.md)  
4. [PHASE-1-TEST-EVIDENCE.md](./PHASE-1-TEST-EVIDENCE.md)  
5. [PHASE-1-RISK-REGISTER.md](./PHASE-1-RISK-REGISTER.md)  

---

## Final stop

Audit complete. **No deploy. No production code changes. No next phase started.**  
Awaiting explicit approval before any Rules/contract remediation.
