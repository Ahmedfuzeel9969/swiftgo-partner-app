# Phase 1 — Foundation, Data Flow, and Four-App Integration Audit

**Project:** SwiftGo ride-hailing (Karachi-oriented)  
**Audit date:** 2026-07-27  
**Scope:** Audit-only — no production code changes, no rules changes, no deploy, no production writes  
**Repository:** `F:/ride-app` (git working tree included uncommitted driver home-hub work)

---

## A. Executive Verdict

**FAIL**

The four apps share one Firebase project and a mostly consistent `rides`-centric model, but **financial and ride-completion protections are not reliably enforced** at Firestore Rules for `partners/{uid}`, and **there is no trusted server layer** (no Cloud Functions). Emulator-backed rules tests confirmed that drivers can mutate partner wallet aggregates and that customers can force `accepted → completed` without the driver lifecycle. Client transactions help accept races but do not replace server-side settlement.

---

## B. Foundation Score

| Area | Max | Score | Notes |
|------|-----|-------|-------|
| Project structure and build | 10 | **8** | Static four-app hosting bundle builds cleanly |
| Authentication and roles | 15 | **9** | Google Auth + UI role routing; weak rules-side role model |
| Shared data contracts | 20 | **11** | Dual ride stores, split wallet semantics |
| Ride lifecycle consistency | 20 | **9** | Multiple accept/complete paths; legacy incoming-ride flow |
| Firestore/Storage rule alignment | 15 | **6** | Gaps on `partners`, customer complete shortcut |
| Server-side protection | 10 | **1** | No Cloud Functions / Run |
| Error/recovery foundation | 5 | **2** | Transactions in some paths; batch completion fragile |
| Existing test health | 5 | **2** | Audit suite broken on Node 24; npm test placeholder |
| **Total** | **100** | **48** | |

---

## C. Critical Risks (summary)

| ID | Sev | Title | Apps |
|----|-----|-------|------|
| P1-001 | **P0** | `partners.walletBalance` writable by driver self-update | Driver, Owner, Admin |
| P1-002 | **P0** | Customer `accepted → completed` allowed by rules (skips commission) | Customer, Driver |
| P1-003 | **P0** | `completeRideWithEarnings` partner batch aligns with open wallet rule | Driver |
| P1-004 | **P0** | Super Admin = single hardcoded email in rules | All |
| P1-005 | **P1** | Legacy `resolveActiveRequest` accept missing fare fields vs rules | Driver |
| P1-006 | **P1** | No geo dispatch (1/2/3 km, max 10 drivers) — global query limit 40 | Customer, Driver |
| P1-007 | **P1** | `users` vs `partners` duplicate wallet/identity | Customer, Driver |
| P1-008 | **P2** | `drivers/{uid}` fully writable by owner uid | Driver |
| P1-009 | **P2** | No audit log collection for admin actions | Admin |
| P1-010 | **P3** | Four duplicated `firebase-config.js` / `firebase.js` per app | All |

Full register: [PHASE-1-RISK-REGISTER.md](./PHASE-1-RISK-REGISTER.md)

---

## D. Four-App Connectivity Verdict

| Connection | Reliable? | Evidence |
|------------|-----------|----------|
| Customer ↔ Driver | **Partial** | Same `rides` collection; radar + offer flow; rules gaps on completion/wallet |
| Driver ↔ Owner | **Partial** | Shared `vehicles`, `ownerId` on rides; owner app mirrors driver ride ops |
| Customer ↔ Owner | **Weak** | Indirect via rides only; no customer-facing owner API |
| All apps ↔ Super Admin | **Partial** | Admin reads/writes pricing, partners, recharges; no audit trail |
| All clients ↔ Firestore Rules | **Unreliable** | Emulator tests: 14 pass, 3 fail, 3 blocked |
| Client ↔ trusted server | **Missing** | No backend functions |

---

## E. Test Evidence

| Command | Exit code | Result |
|---------|-----------|--------|
| `node tools/build-hosting.mjs` | **0** | 76 files → `hosting-dist/` (customer, partner, owner, admin) |
| `node tests/audit.test.mjs` | **1** | Crashes importing `customer-app/js/firebase-config.js` (ESM in `.js`, root `"type":"commonjs"`) |
| `node tests/i18n-purity-scan.mjs` | **1** | 1 UR latin leftover (`driverOfferCounterLabel`) |
| `npm test` | **1** | Placeholder script only |
| `firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/phase1-emulator-contract.mjs"` | **1** | 14 PASS, 3 FAIL, 3 BLOCKED — see [PHASE-1-TEST-EVIDENCE.md](./PHASE-1-TEST-EVIDENCE.md) |

**Emulator:** Firestore only, demo project `demo-swiftgo-phase1`, no production data.  
**Dev tooling added for audit:** `devDependencies`: `@firebase/rules-unit-testing@3.0.4`, `firebase@10.14.1` (required to run contract tests; not deployed).

---

## F. Unverified Items

- Browser startup console errors for all four SPAs (no Playwright in repo; audit HTTP smoke not re-run after Node audit failure).
- Storage Rules enforcement (KYC paths) — **BLOCKED** in Firestore-only harness.
- Suspended driver online toggle end-to-end — **BLOCKED** (needs Auth + app UI emulator).
- Real simultaneous accept under production latency — inferred from rules + `runTransaction` code only.
- Push notifications / FCM — browser notification API only; no server push audit.
- `settings/driverForm` document — read in customer app with fallback; not verified in production Firestore.

---

## G. Recommended Next Phase

**Phase 2A: Critical contract/rules correction**

Fix `partners` wallet immutability, remove or tighten customer `accepted → completed`, align all accept/complete clients with one rules path, then re-run emulator contract suite before security load work.

---

## Task 1 — Project Structure Map

| App / Component | Main path | Responsibility | Shared or separate | Risk / observation |
|-----------------|-----------|----------------|--------------------|--------------------|
| Customer app | `customer-app/` | Book rides, wallet UI, KYC apply, map/fare | Separate static SPA | Uses `users` + `rides` |
| Driver / Partner app | `driver-app/` → `/partner/` | PIN link, radar, ride execution, wallet recharge | Separate | Duplicated owner logic fragments |
| Owner app | `owner-app/` → `/owner/` | Fleet, PIN, ride history, drive mode (super) | Separate | Large overlap with driver-app patterns |
| Super Admin | `super-admin-panel/` → `/admin/` | Pricing, promos, block drivers, recharges, fleet map | Separate | Email gate in UI + rules |
| Hosting bundle | `tools/build-hosting.mjs` → `hosting-dist/` | Copy four apps | Shared output | No bundler per app |
| Firestore rules | `firestore.rules` | Authorization | Shared | Email-based super admin |
| Storage rules | `storage.rules` | KYC images | Shared | Narrow allow paths |
| Indexes | `firestore.indexes.json` | Composite queries | Shared | No geo indexes |
| Cloud Functions | *(none)* | — | **Missing** | All logic client-side |
| Auth | `*/js/firebase.js`, Google popup | Firebase Auth | Per-app duplicate config | Same project ID |
| Maps / routing | Leaflet + OSRM/Nominatim | Client-only | Per app | External HTTP |
| Notifications | `audio-service.js`, `Notification` API | Local alerts | Per app | No FCM server |
| Wallet | `partners.walletBalance`, `users.walletBalance`, `rechargeRequests` | Client + admin approve | Split model | **P0** partner wallet writes |
| Ride matching | `ride-radar-service.js` | Query + client sort by distance | Driver client | Not server dispatch |
| Tests | `tests/audit.test.mjs`, `tests/phase1-emulator-contract.mjs` | Static + rules | Repo root | Audit suite fragile |
| Secrets | `*/firebase-config.js` | Public web API keys | Duplicated ×4 | Expected for Firebase web; no `.env` |

**Stack:** Vanilla HTML/CSS/ES modules; Firebase JS SDK 10.14.1 from CDN; ApexCharts in driver dashboard; no React/Vue build for apps (root `package.json` lists unused React chart deps).

---

## Task 2 — Application Startup Verification

| App | Build | Start fatal? | Notes |
|-----|-------|--------------|-------|
| Customer | Via hosting build | **Not run in browser this phase** | Module entry `js/app.js` |
| Partner | Via hosting build | **Not run** | `js/driver-app.js` |
| Owner | Via hosting build | **Not run** | `js/owner-app.js` |
| Admin | Via hosting build | **Not run** | `js/admin-app.js` |

- **Build:** `node tools/build-hosting.mjs` → exit **0**.
- **Missing env:** None required beyond Firebase web config in source.
- **Firebase failure:** Each `firebase.js` exposes `ready` flag; apps show demo/auth messaging when unconfigured.
- **Role cross-open:** Driver app redirects `role === "owner"` to `/owner/`; admin UI rejects non-owner email; owner app does not redirect to partner (driver must use partner URL).
- **Logout:** `signOut(auth)` + `hideProtectedUi()` / listeners stopped in each app.

---

## Task 7 — Location & Matching (summary)

| Question | Finding |
|----------|---------|
| Online/offline | `vehicles.status` + driver geolocation watch; partner doc for block/wallet |
| Location write rate | Throttled **8s** (`VEHICLE_LOCATION_WRITE_MS`) to `vehicles.location` |
| 1 / 2 / 3 km search | **Not implemented** — haversine sort on client over query results |
| Max 10 drivers | **Not implemented** — `LIST_LIMIT = 40`, all signed-in drivers can list `searching_driver` |
| Stale location | No server-side staleness filter in queries |
| Client fake eligibility | Driver can write `vehicles.location` while `online`/`in_ride` per rules |
| Indexes | status + createdAt on `rides` and `ride_requests` |

**Estimated reads/writes one matching attempt (code analysis):**  
Customer create ride: **1 write**. Each online driver radar subscription: **2 listeners** (`ride_requests` + `rides`) with snapshot updates — **O(drivers listening × churn)**; not push-to-10-drivers.

---

## Task 8 — Trusted Server Operations (summary)

| Operation | Classification |
|-----------|----------------|
| Ride accept (radar) | Must use transaction — **implemented**; rules-validated |
| Ride accept (incoming sheet) | Transaction but **incomplete payload** — rules may deny |
| Fare / commission | **Client-only** — calculated in driver/owner app |
| Wallet debit on complete | **Missing protection** — rules allow partner batch |
| Recharge approve | Super Admin batch — **rules OK** |
| Role / block | UI + rules (super admin email) |
| KYC approve | **Not implemented** in admin (applications read-only after create) |

Detail: [PHASE-1-RISK-REGISTER.md](./PHASE-1-RISK-REGISTER.md)

---

## Task 9 — Error / Offline / Recovery (summary)

| Scenario | Behavior |
|----------|----------|
| Network drop before ride create | Client throws; no local queue |
| Dual accept | Transaction second writer fails — **good** (emulator T03) |
| Driver offline after accept | Ride doc remains; customer sees snapshot |
| Refresh mid-ride | `onSnapshot` / watch restores state if auth persists |
| Duplicate complete button | No idempotent server; second complete denied by rules if already completed |
| Customer cancel vs driver accept | Race — transaction winner; loser gets error in UI |
| Wallet partial batch | Batch commit atomic; if rules deny, UI shows failure (but rules currently **allow** partner wallet — **risk**) |

---

## Task 10 — Baseline Quality Gates

| Suite | Total | Passed | Failed | Skipped | Blocked | Exit |
|-------|-------|--------|--------|---------|---------|------|
| Build hosting | 1 | 1 | 0 | 0 | 0 | 0 |
| audit.test.mjs | — | — | bootstrap | — | — | 1 |
| i18n-purity-scan | 1 | 0 | 1 | 0 | 0 | 1 |
| npm test | 1 | 0 | 1 | 0 | 0 | 1 |
| phase1-emulator-contract | 20 | 14 | 3 | 0 | 3 | 1 |
| Firestore rules unit (official) | 0 | 0 | 0 | 0 | 0 | n/a |
| Storage rules unit | 0 | 0 | 0 | 0 | 1 | n/a |
| Lint / typecheck | 0 | — | — | — | — | n/a |

---

## Related deliverables

1. [PHASE-1-DATA-CONTRACT.md](./PHASE-1-DATA-CONTRACT.md)  
2. [PHASE-1-RIDE-LIFECYCLE.md](./PHASE-1-RIDE-LIFECYCLE.md)  
3. [PHASE-1-PERMISSION-MATRIX.md](./PHASE-1-PERMISSION-MATRIX.md)  
4. [PHASE-1-TEST-EVIDENCE.md](./PHASE-1-TEST-EVIDENCE.md)  
5. [PHASE-1-RISK-REGISTER.md](./PHASE-1-RISK-REGISTER.md)

---

**Stop rule:** Phase 1 complete. Awaiting explicit approval before Phase 2.
