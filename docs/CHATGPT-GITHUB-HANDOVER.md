# ChatGPT GitHub Handover — SwiftGo

Prepared: 2026-07-31  
Purpose: Safe repository handover so ChatGPT can inspect, modify, test, commit, and push without redesigning the app in this step.

---

## Repository identity

| Item | Value |
|------|--------|
| Local project folder | `F:/ride-app` (folder name: `ride-app`) |
| GitHub repository name | `swiftgo-partner-app` |
| Exact GitHub URL | https://github.com/Ahmedfuzeel9969/swiftgo-partner-app |
| Owner | `Ahmedfuzeel9969` |
| Visibility | **Public** (confirmed via prior handover; `gh` CLI not installed on handover machine) |
| Current working branch | `main` |
| Production branch | `main` (GitHub default `origin/HEAD → origin/main`) |
| Safety branch (this handover) | `handover/chatgpt-baseline-20260731` |
| Prior safety branch (do not overwrite) | `handover/chatgpt-baseline` |
| Latest commit hash | `16047432d44323e377e3ea803a3f1614f32ab0ec` |
| Live site | https://swiftgo-ride-app.web.app/ |
| Firebase project ID | `swiftgo-ride-app` |
| Firebase Hosting | default site for project `swiftgo-ride-app` (public dir `hosting-dist`, built by predeploy) |
| Secondary Firebase aliases in `.firebaserc` | `ravo-44c4c`, `auth` — **not** the live SwiftGo host |

---

## Push status / Git status (2026-07-31 handover)

- **Latest commit:** `16047432d44323e377e3ea803a3f1614f32ab0ec` on `main` and `handover/chatgpt-baseline-20260731`
- **Working tree:** clean after push

- **Modified tracked files:** customer-app, driver-app, owner-app, super-admin-panel, functions, firestore.rules, firestore.indexes.json, tests (see commit diff)
- **New untracked files added:** dispatch-latency, partial-fare, pricing-fare, driver-location, rate-details, pricing-client, admin-settings-client, driver-offer-inbox, driver-track modules
- **Staged at commit time:** all legitimate source above (no `hosting-dist/`, no debug logs, no secrets)
- **Unpushed commits before handover:** none on `main` (was synced with `origin/main`; large local diff uncommitted)
- **Force-push / history rewrite:** not used
- **Deploy during handover:** **not run**
- **Production Firebase writes:** **not performed**

Regenerate exact status anytime:

```bash
git status
git log -1 --oneline
git branch -a
```

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
| Auth-related app code | Yes — each app auth + Firebase Auth wiring |
| Tests | Yes — `tests/` + `package.json` scripts |
| Build configuration | Yes — `tools/build-hosting.mjs`, `npm run build:hosting` |
| Deployment configuration | Yes — `firebase.json` hosting/functions/firestore/storage |
| Docs to run/test | Yes — `docs/` + this file |

**Outside GitHub but required locally (gitignored):**

- `node_modules/` (root + `functions/`) — recreate with `npm install` / `cd functions && npm install`
- `hosting-dist/` — recreate with `npm run build:hosting`
- `mobile/signing/keystore.properties`, `*.jks` — Android release signing only
- `mobile/**/google-services.json` — Android Firebase (`.example` files only in git)
- `firestore-debug.log`, `firebase-debug.log` — local emulator/debug output

No separate “source of truth” folder outside `F:/ride-app` was identified for the live site.

---

## Commands

### Safe local run (no production writes)

```bash
npm install
cd functions && npm install && cd ..

npm run build:hosting

# Optional: Hosting emulator only
firebase emulators:start --only hosting --project demo-swiftgo-phase1
```

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
firebase emulators:exec --only storage --project demo-swiftgo-phase1 "node tests/phase4f-storage-rules.mjs"
```

Lint: no project-wide ESLint script (`package.json` has no `lint` target).

### Build command

```bash
npm run build:hosting
# → node tools/build-hosting.mjs → hosting-dist/
```

### Production deployment command (human-approved only)

Full stack:

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting --project swiftgo-ride-app
```

Hosting only:

```bash
firebase deploy --only hosting --project swiftgo-ride-app
```

Hosting `predeploy` runs `node tools/build-hosting.mjs` automatically.

---

## Verification results (handover run, 2026-07-31)

| Check | Result |
|-------|--------|
| Dependencies present | PASS (`node_modules` root + functions) |
| Functions JS `node --check` | PASS (all `functions/*.js`) |
| `npm run build:hosting` | PASS |
| `node tests/audit.test.mjs` | **235 PASS / 3 FAIL** (98.7%) — see Known defects |
| `node tests/booking-false-success-suite.mjs` | **11 PASS / 2 FAIL / 1 BLOCKED** (emulator E00 blocked) |
| Emulator integration suites | **Not run** (Firestore emulator not running at handover time) |
| Production deploy | **Not run** |
| Production Firebase writes | **Not performed** |

---

## Old versus new passenger booking systems

### Production-live (NEW — canonical)

**Store:** `rides/{id}` via trusted Cloud Functions. Client create on `rides` is denied (`allow create: if false`).

**Entry:** `#bookRideBtn` → `sheet.js` → `app.js` `handleBookRide` → `ride-flow.js` `startRideRequest` → `booking-client.js` `createCustomerBooking` → auto `matchRideCandidates`.

**Customer files:**

- `customer-app/js/ride-flow.js`, `booking-client.js`, `booking-gate.js`, `offer-client.js`, `ride-status.js`, `history.js`, `cancel-reason-dialog.js`, `confirm-dialog.js`, `dispatch-latency.js`, `driver-track.js`, `sheet.js`, `app.js`, `index.html`, `css/styles.css`, `i18n.js`

**Functions:**

- `functions/index.js`, `bargaining.js`, `matching.js`, `geo-match.js`, `geo-cells.js`, `dispatch-latency.js`, `driver-location.js`, `partial-fare.js`, `pricing-fare.js`, `ride-cancellation.js`, `settlement.js`

**Rules/indexes:** `firestore.rules`, `firestore.indexes.json`

**Tests:** `tests/booking-*-suite.mjs`, `ghost-rides-*`, phase2a/2c/3b suites, `audit.test.mjs`

### OLD system A — `bookings` collection + `createBooking`

| Path | Role |
|------|------|
| `customer-app/js/data.js` | `createBooking()`, `watchBookings()` — **no UI callers** |
| `firestore.rules` | `/bookings/{id}` still allows scoped client create/update |

**Reachability:** not reachable through visible UI (dead exports).  
**Deleting would break current Book CTA:** **no** (if only dead exports removed + audits updated).

### OLD system B — `ride_requests` archive + client `createRideRequest` stub

| Path | Role |
|------|------|
| `customer-app/js/data.js` | `createRideRequest()` throws `USE_CREATE_CUSTOMER_BOOKING_CF` |
| `firestore.rules` | `ride_requests` read-only archive |
| `driver-app/js/RideRequestDetail.js` | legacy `sourceCollection === "ride_requests"` display branch |

**Reachability:** not bookable from customer; archive/driver fallback only.  
**Status:** hidden archive, not active booking path.

### OLD system C — direct client cancel/offer/complete stubs in `data.js`

Uncalled or throw-only; live flow uses `booking-client.js` / `offer-client.js`.

### Rent UI (not a booking system)

`sheet.js` rent category → `utility-drawer.js` — local prefs only, no Firestore ride create.

### Shared code

Auth, map/routing/fare/sheet UI, `watchRideRequest`, `ride-status.js` (includes legacy status normalization), i18n/CSS, Firebase init, driver radar on `ride_candidates` + `rides`.

### Safe deletion plan (DO NOT execute in handover)

1. Re-grep for `createBooking` / `watchBookings` / `createRideRequest` callers.
2. Remove dead exports from `customer-app/js/data.js`; rebuild hosting.
3. Update `tests/audit.test.mjs` and docs referencing legacy create.
4. Optionally lock `bookings` rules after confirming no writers.
5. Remove driver `ride_requests` branches only after archive empty + migration.
6. Smoke: Book CTA still calls `createCustomerBooking` only.

---

## Known defects

1. **Audit FAIL — walletBalance read-only (Phase 9)** — rules assertion drift.
2. **Audit FAIL — Phase 16.2 searching-for-driver UI state** — static wiring vs current searching panel markup.
3. **Audit FAIL — Partner auth routes strictly by saved role** — partner app intentionally avoids strict auto-redirect in some cases.
4. **booking-false-success S05/S07 FAIL** — static contract assertions vs current gate implementation (emulator E-tests blocked).
5. **Dispatch matching `candidateCount: 0`** — operational issue when driver vehicle lacks valid GPS/geoCell or is outside search radius (see driver `paintDriverAvailabilityDiag`).
6. **Legacy `bookings` dead code** still in `customer-app/js/data.js` with permissive rules.
7. **Repo name mismatch** — GitHub `swiftgo-partner-app` vs product name SwiftGo.
8. **Public repo** — Firebase web API keys in client config (normal; restrict in Console / App Check).

---

## Production blockers (for ChatGPT awareness)

- Do not force-push `main`.
- Do not delete old booking code in the first exploratory pass.
- Do not commit `mobile/signing/*` secrets or `google-services.json`.
- Emulator suites: use `--project demo-swiftgo-phase1` and emulator hosts; never Admin SDK tests against production.
- `handover/chatgpt-baseline` is frozen; use **`handover/chatgpt-baseline-20260731`** for this snapshot.

---

## Sensitive-file findings (values not disclosed)

| File | Type | Tracked? | Recommended action |
|------|------|----------|--------------------|
| `customer-app/js/firebase-config.js` | Public Firebase web config (apiKey, projectId) | Yes | Keep; restrict keys in Firebase Console |
| `driver-app/js/firebase-config.js` | Public Firebase web config | Yes | Same |
| `owner-app/js/firebase-config.js` | Public Firebase web config | Yes | Same |
| `super-admin-panel/js/firebase-config.js` | Public Firebase web config | Yes | Same |
| `functions/admin-claims.js` | Bootstrap admin email (ops identity) | Yes | Prefer env/secret; bootstrap default OFF |
| `tests/phase4f-ops-verify.mjs` (and similar) | Emulator-only test passwords | Yes | Keep emulator-scoped; never reuse in prod |
| `mobile/signing/keystore.properties` | Android keystore passwords | No (ignored) | Keep ignored; vault backup |
| `mobile/signing/*.jks` | Upload keystore | No (ignored) | Keep ignored; offline backup |
| Service account JSON / `.env` secrets | Private credentials | **Not found in git** | Continue excluding via `.gitignore` |

**Private keys / service-account JSON in tracked Git: NO.**  
**Public Firebase web API keys in tracked client config: YES (expected for web apps).**

`.gitignore` excludes: `.env*`, service accounts, `node_modules/`, `hosting-dist/`, emulator exports, PEMs, Android keystores, `google-services.json`. No exclusion changes made during this handover.

---

## Permissions ChatGPT needs

1. **GitHub write access** to `Ahmedfuzeel9969/swiftgo-partner-app` (collaborator or owner token with `repo` scope).
2. Ability to **push branches** to `origin` (prefer feature branches; protect `main` if possible).
3. Local clone with Node 22+, npm, Firebase CLI for emulator tests.
4. **Optional for deploy only:** Firebase IAM on `swiftgo-ride-app` — prefer human-approved deploys.
5. **Must not need:** production service-account JSON in repo; Android upload keystore for ordinary web work.

**Recommended ChatGPT workflow:**

1. Inspect `handover/chatgpt-baseline-20260731` (immutable safety snapshot).
2. Branch from `main` for changes.
3. Run static + emulator tests before merging to `main`.

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
- Prior safety branch `handover/chatgpt-baseline` was **not overwritten**; new branch `handover/chatgpt-baseline-20260731` created from pushed tip.
- Recent waves include: dispatch latency fixes, in-progress cancel partial fare, driver GPS NaN guards, dynamic dispatch settings, fare rate details UI.
