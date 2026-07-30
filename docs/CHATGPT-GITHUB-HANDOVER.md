# ChatGPT GitHub Handover — SwiftGo

Prepared: 2026-07-30  
Purpose: Safe repository handover so ChatGPT can inspect, modify, test, commit, and push without redesigning the app in this step.

---

## Repository identity

| Item | Value |
|------|--------|
| Local project folder | `F:/ride-app` (folder name: `ride-app`) |
| GitHub repository name | `swiftgo-partner-app` |
| Exact GitHub URL | https://github.com/Ahmedfuzeel9969/swiftgo-partner-app |
| Owner | `Ahmedfuzeel9969` |
| Visibility | **Public** |
| Current working branch | `main` |
| Production branch | `main` (GitHub default) |
| Safety branch | `handover/chatgpt-baseline` |
| Latest commit hash | Tip of `handover/chatgpt-baseline` / `main` after handover push (content baseline `c918f6c68922b945cf32ed75c102dacbdaea9b96`) |
| Live site | https://swiftgo-ride-app.web.app/ |
| Firebase project ID | `swiftgo-ride-app` |
| Firebase Hosting | default site for project `swiftgo-ride-app` (public dir `hosting-dist`) |
| Secondary Firebase alias in `.firebaserc` | `ravo-44c4c` (auth/ravo aliases — **not** the live SwiftGo host) |

---

## Push status / Git status

Recorded at handover completion:

- Baseline content commit on `main`: `c918f6c68922b945cf32ed75c102dacbdaea9b96`
- Safety branch `handover/chatgpt-baseline` created from the pushed tip
- Working tree clean after push (aside from intentional follow-up hash note if any)
- No force-push, no history rewrite, no deploy during handover
- Pre-commit: local was synced with `origin/main` (no unpushed commits; no GitHub-ahead commits missing locally)

---

## Project structure

```
ride-app/
  customer-app/          # Passenger (root hosting + /customer/)
  driver-app/            # Partner/driver (/partner/)
  owner-app/             # Fleet owner (/owner/)
  super-admin-panel/     # Administrator (/admin/)
  functions/             # Cloud Functions (Node 22)
  tests/                 # Emulator + static contract suites
  docs/                  # Phase reports + this handover
  tools/build-hosting.mjs
  firebase.json
  .firebaserc
  firestore.rules
  firestore.indexes.json
  storage.rules
  mobile/                # Capacitor Android shells (Phase 4G)
  legal/                 # Privacy/terms drafts (via hosting build)
```

### Application entry points

| App | Entry HTML | Boot JS | Hosted path |
|-----|------------|---------|-------------|
| Passenger | `customer-app/index.html` | `customer-app/js/app.js` | `/` and `/customer/` |
| Driver/Partner | `driver-app/index.html` | `driver-app/js/driver-app.js` | `/partner/` |
| Owner | `owner-app/index.html` | `owner-app/js/owner-app.js` | `/owner/` |
| Admin | `super-admin-panel/index.html` | `super-admin-panel/js/admin-app.js` | `/admin/` |

---

## Completeness checklist

| Area | Present in repo |
|------|-----------------|
| Passenger application | Yes — `customer-app/` |
| Driver/partner application | Yes — `driver-app/` |
| Administrator application | Yes — `super-admin-panel/` (+ owner app) |
| Firebase configuration | Yes — `firebase.json`, `.firebaserc`, `*/js/firebase-config.js` |
| Firestore rules | Yes — `firestore.rules` |
| Storage rules | Yes — `storage.rules` |
| Firestore indexes | Yes — `firestore.indexes.json` |
| Cloud Functions | Yes — `functions/` |
| Auth-related app code | Yes — each app `auth` / Firebase Auth wiring |
| Tests | Yes — `tests/` + `package.json` scripts |
| Build configuration | Yes — `tools/build-hosting.mjs`, `npm run build:hosting` |
| Deployment configuration | Yes — `firebase.json` hosting/functions/firestore/storage |
| Docs to run/test | Yes — `docs/` + this file |

**Outside GitHub but required locally (gitignored):**

- `node_modules/` (root + `functions/`) — recreate with `npm install`
- `hosting-dist/` — recreate with `npm run build:hosting`
- `mobile/signing/keystore.properties`, `*.jks` — Android release signing only
- `mobile/**/google-services.json` — Android Firebase (examples only in git)

No separate “source of truth” folder outside `F:/ride-app` was found for the live site.

---

## Commands

### Safe local run (no production writes)

```bash
# Install deps
npm install
cd functions && npm install && cd ..

# Build Hosting package only
npm run build:hosting

# Serve locally via Firebase Hosting emulator (optional)
firebase emulators:start --only hosting --project demo-swiftgo-phase1
```

Customer apps are static ES modules; production uses Firebase Hosting. Prefer emulator or a local static server against `hosting-dist` for UI. Do **not** point Admin SDK tests at production.

### Test commands (emulator / static — safe)

```bash
npm run test:audit
npm run test:phase1
npm run test:phase2a
npm run test:phase2b
npm run test:phase2c
node tests/booking-false-success-suite.mjs
firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/booking-cancellation-contract-suite.mjs"
firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/booking-driver-reach-suite.mjs"
firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/ghost-rides-driver-location-expiry-suite.mjs"
```

Lint: no project-wide ESLint script is configured (`package.json` has no `lint` target).

### Build command

```bash
npm run build:hosting
# → node tools/build-hosting.mjs → hosting-dist/
```

### Production deployment command (do not run during ChatGPT exploratory work unless explicitly requested)

Full stack (as used for production waves):

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting --project swiftgo-ride-app
```

Hosting only:

```bash
firebase deploy --only hosting --project swiftgo-ride-app
```

Hosting `predeploy` runs `node tools/build-hosting.mjs` automatically.

---

## Verification results (handover run, 2026-07-30)

| Check | Result |
|-------|--------|
| Dependencies present | PASS (`node_modules` root + functions) |
| Functions JS `node --check` | PASS (all `functions/*.js`) |
| Tests `*.mjs` `node --check` | PASS (sampled suites) |
| Browser ESM `node --check` | N/A — app modules are browser ESM; root `package.json` is `"type":"commonjs"` so Node `--check` is misleading |
| Lint | N/A — no lint script |
| `npm run build:hosting` | PASS |
| `node tests/audit.test.mjs` | 236/238 PASS (2 pre-existing wiring FAILs — see Known defects) |
| `booking-false-success-suite` | 13 PASS, 0 FAIL, 1 BLOCKED (emulator not up for E-tests) |
| `booking-driver-reach-suite` | 11 PASS / 0 FAIL |
| `ghost-rides-driver-location-expiry-suite` | 39 PASS / 0 FAIL |
| Phase1 emulator contract | 22 PASS / 0 FAIL |
| Booking cancellation contract (emulator) | 18 PASS / 0 FAIL |
| Production deploy during handover | **Not run** (by design) |
| Production Firebase writes for tests | **Not targeted** (emulator project `demo-swiftgo-phase1`) |

---

## Old versus new passenger booking systems

### Production-live (NEW)

Canonical store: **`rides/{id}`** via trusted Cloud Functions. Client create on `rides` is denied (`allow create: if false`).

**Entry point:** `#bookRideBtn` → `sheet.js` → `app.js` `handleBookRide` → `ride-flow.js` `startRideRequest` → `booking-client.js` `createCustomerBooking` callable → auto `matchRideCandidates`.

**Key files:**

- Customer: `customer-app/js/ride-flow.js`, `booking-client.js`, `booking-gate.js`, `offer-client.js`, `ride-status.js`, `history.js`, `cancel-reason-dialog.js`, `confirm-dialog.js`, `sheet.js`, `app.js`, `index.html`, `css/styles.css`, `i18n.js`
- Functions: `functions/bargaining.js`, `matching.js`, `geo-cells.js`, `ride-cancellation.js`, `ride-rating.js`, `index.js`
- Rules/indexes: `firestore.rules` (`rides`, `ride_offers`, `ride_candidates`, `booking_slots`), `firestore.indexes.json`
- Tests: `tests/booking-*-suite.mjs`, `ghost-rides-*`, phase2a/2c/3b suites, `audit.test.mjs` (new-path wiring)

### OLD system A — `bookings` collection + `createBooking`

- Still present in `customer-app/js/data.js` (`createBooking`, `watchBookings`)
- Rules still allow scoped client create/update on `/bookings/{id}`
- **No UI callers** — dead exports only
- Visible interface: **not reachable**
- Merely hidden: **no** — unwired
- Deleting would break current Book CTA: **no** (if only those APIs removed and audit assertions updated)

### OLD system B — transitional client `createRideRequest`

- `data.js` `createRideRequest` now throws `USE_CREATE_CUSTOMER_BOOKING_CF`
- Unused client mutator stubs for offers/complete in places
- Archive collection `ride_requests` (client writes denied)
- Visible UI: **no**
- Deleting stubs carefully: **safe** if audits updated; keep `watchRideRequest` / promo / rating helpers

### Shared code

Auth, map/routing/fare/sheet UI, `watchRideRequest`, `ride-status.js`, i18n/CSS “booking” wording (serves new UX), Firebase init, driver radar consuming `rides`/candidates.

### Safe deletion plan (DO NOT execute in handover)

1. Re-grep monorepo for `createBooking` / `watchBookings` callers.
2. Remove dead exports from `data.js`; rebuild hosting.
3. Update `tests/audit.test.mjs` and docs that mention legacy create.
4. Optionally lock `bookings` rules (`create/update/delete: if false`) after ops confirm no writers.
5. Remove stub `createRideRequest` / unused throw stubs only after confirming no dynamic imports; keep shared helpers.
6. Smoke: Book CTA still calls `createCustomerBooking` only.

---

## Known defects

1. **Audit FAIL — Phase 16.2 searching-for-driver UI state** — static wiring assertion out of date vs current searching panel markup/JS (236/238 still pass).
2. **Audit FAIL — Partner auth routes strictly by saved role** — assertion expects older strict role routing; partner app now intentionally avoids auto-redirect to owner in some cases.
3. **Legacy `bookings` / `createBooking` dead code** still shipped in customer `data.js` and allowed by rules.
4. **Storage product setup** — prior deploy notes: Firebase Storage may not be fully enabled on the project; Storage rules file exists but Storage deploy can fail if product unset.
5. **Cloud Scheduler** for booking expiry may be left off (billing) — expiry rely on client/callable paths per prior ops notes.
6. **Repo name mismatch** — GitHub repo is `swiftgo-partner-app` while the product/live project is SwiftGo ride app; confusing but functional.
7. **Public repo** — contains public Firebase web API keys (normal for client apps); ensure Console API-key restrictions / App Check.

---

## Production blockers (for ChatGPT awareness)

- Do not force-push `main`.
- Do not enable billable Scheduler without billing approval.
- Do not delete old booking code in the first exploratory pass without the plan above.
- Do not commit `mobile/signing/*` secrets or `google-services.json`.
- Emulator suites must use `--project demo-swiftgo-phase1` and `FIRESTORE_EMULATOR_HOST`; never Admin SDK against production for tests.
- `gh` CLI was not installed on the handover machine; GitHub API confirmed public visibility.

---

## Sensitive-file findings (values not disclosed)

| File | Type | Tracked? | Recommended action |
|------|------|----------|--------------------|
| `*/js/firebase-config.js` | Public Firebase web config | Yes | Keep; restrict keys in Firebase Console |
| `functions/admin-claims.js` | Bootstrap admin email (ops identity) | Yes | Prefer env/secret; keep bootstrap default OFF |
| `tests/phase2c-e2e-suite.mjs` (and similar) | Emulator-only test passwords | Yes | Keep emulator-scoped; never reuse in prod |
| `mobile/signing/keystore.properties` | Android keystore passwords | No (ignored) | Keep ignored; vault backup |
| `mobile/signing/*.jks` | Upload keystore | No (ignored) | Keep ignored; offline backup |
| Service account JSON / `.env` secrets | N/A | **Not found** | Continue excluding via `.gitignore` |

**Critical private keys / service accounts in tracked Git: none found.**

`.gitignore` already excludes: `.env*`, service accounts, `node_modules/`, `hosting-dist/`, emulator exports, PEMs, Android keystores, `google-services.json`. No exclusion changes made during handover.

---

## Permissions ChatGPT needs

To modify and push this repository safely, ChatGPT (or the human operator’s GitHub identity used by the agent) needs:

1. **GitHub write access** to `Ahmedfuzeel9969/swiftgo-partner-app` (collaborator or owner token with `repo` scope).
2. Ability to **push branches** to `origin` (prefer feature branches; protect `main` if possible).
3. Local clone of this repo with Node 22+, npm, and Firebase CLI for emulator tests.
4. **Optional for deploy only (not required to edit code):** Firebase IAM on `swiftgo-ride-app` (Hosting/Functions/Rules). Prefer human-approved deploys.
5. **Must not need:** production service-account JSON in the repo; Android upload keystore for ordinary web work.

Recommended ChatGPT starting point:

1. Inspect branch `handover/chatgpt-baseline` (immutable safety snapshot).
2. Create a new working branch from `main` (or from baseline) for changes.
3. Run emulator/static tests before any push to `main`.

---

## Exact permissions summary for agents

| Action | Allowed after handover? |
|--------|-------------------------|
| Read all source on GitHub | Yes (public) |
| Commit + push feature branches | Yes, with write access |
| Push to `main` | Only with explicit human approval; prefer PR |
| Force-push / history rewrite | **No** |
| Production deploy | Only when human explicitly requests |
| Production data deletes | **No** |
| Delete old booking system | Only after separate approved task |

---

## Handover operator notes

- Local folder used to develop/deploy https://swiftgo-ride-app.web.app/ is **`F:/ride-app`**.
- Last hosting wave before this handover removed customer “Earn as Driver” (`?v=no_earn_driver_1`).
- Phase 2A rules lock (rides client-create denied, rating via CF) is in the committed tree.
)
