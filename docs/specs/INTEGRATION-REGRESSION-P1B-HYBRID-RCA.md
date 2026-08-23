# Integration Regression RCA — Customer Home + Driver Startup

**Date:** 2026-08-05  
**Status:** Root cause identified; permanent gates implemented; P2-C blocked  
**Severity:** P0 — Customer/Driver intermittently broken after hybrid Hosting deploy

---

## Verdict

Regressions were **not** caused by P1-B offer-timeout logic in Cloud Functions.  
They were caused by the **P1-B (and P1-A) hybrid Hosting deploy strategy**, which mixed incompatible Customer/Driver bundles and left **static ES module imports pointing at files that do not exist** on Hosting.

Firebase Hosting then served **SPA `index.html`** for those missing `.mjs` paths (`text/html`). Browsers fail to parse HTML as JavaScript → Driver boot aborts; Customer boot/home partially initializes or breaks depending on cache.

---

## Symptoms → mechanism

| Symptom | Mechanism |
|---------|-----------|
| Driver App sometimes fails to start | `partner/js/driver-app.js` (hybrid) statically imports `phase1-billing-diagnostics.mjs`, `route-provider-bootstrap.mjs`, `p2p-comm-panel.mjs` → panel imports `p2p-comm-session.mjs` / protocol / voice. Several of those files were **missing** on live; Hosting rewrite returned **partner `index.html`**. Module load throws → boot never runs. |
| Customer Home sometimes renders incorrectly | Live `js/ride-flow.js` came from dirty `F:/ride-app` (imports billing/P2P comm diagnostics) while live `js/app.js` / HTML came from validate tree. Missing `js/phase1-billing-diagnostics.mjs` etc. returned **customer `index.html`**. Import failure / partial init → home/sheet/map inconsistent. |
| “Sometimes” | `Cache-Control` covered `js|css` but **not `.mjs`**. Devices with a cached good `.mjs` from an earlier complete deploy could work until cache miss → HTML → fail. |

---

## Exact introducing change

| Item | Detail |
|------|--------|
| **Change** | Validation Hosting deploy using `hostingStrategy: hybrid-preserve-live-partner-p2p-plus-p1b-admin` |
| **Evidence** | `tests/p1b-validation-deploy-report.json` |
| **Commit used for Admin/build base** | `79d02fe` (P1-B) on top of `9527ed7` (P1-A) |
| **Working apps before hybrid** | Complete Hosting tree from `F:/ride-app` `build-hosting.mjs` (includes full `shared/js` P2P + diagnostics fan-out) |
| **Broken artifact** | Live `partner/js/driver-app.js` SHA16 `018baaf69ae5a3fb` **byte-identical** to `backups/hybrid-p1a-driver-app.js` |
| **Not the culprit** | P1-B functions (`offerExpiresAt`, `expireDueRideOffers`) — Admin-only / server bargain path |

### Live vs trees (smoke)

| File | Live matches |
|------|----------------|
| `partner/js/driver-app.js` | **hybrid backup** (not `9527ed7` / `79d02fe` / current validate source) |
| `js/app.js` | validate tree |
| `js/ride-flow.js` | dirty `F:/ride-app` |
| `js/p2p-peer-session.mjs` | dirty `F:/ride-app` (COMM_TRACE present) |
| `partner/js/phase1-billing-diagnostics.mjs` | **HTML** (`partner/index.html` via rewrite) |
| `partner/js/route-provider-bootstrap.mjs` | **HTML** |
| `partner/js/p2p-comm-session.mjs` | **HTML** |
| `js/phase1-billing-diagnostics.mjs` | **HTML** (`/` index via catch-all) |

Pre–P1-B **code** commit for Option A idle was `9527ed7`, but **live Customer/Driver** were already the fuller P2P-capable `F:/ride-app` hosting build. Hybrid replace broke that coherence.

---

## Why hybrid keeps recurring (process bug)

1. Validate worktree **lacked** complete `shared/js` P2P/diagnostics packager list.  
2. Deploys manually overlaid a subset of live files + `hybrid-p1a-driver-app.js`.  
3. Hosting rewrites `/partner/**` and `**` turned **any miss** into HTML, hiding 404s.  
4. No predeploy import-graph check → broken bundles shipped as “SUCCESS”.

---

## Permanent fix (implemented)

1. **Ban hybrid Customer/Driver overlays** — deploy one coherent `hosting-dist` from a tree whose `tools/build-hosting.mjs` fans out **all** required shared modules. Admin may ship with that same build (P1-B admin synced into `F:/ride-app`).  
2. **`tools/hosting-startup-health.mjs`** — walks Customer + Driver static import graphs; fails if any import is missing or HTML. Checks home markers, Firebase module, P2P modules.  
3. **`firebase.json` predeploy** — `build-hosting` **then** `hosting-startup-health` (deploy aborts on FAIL).  
4. **Rewrite hardening** — removed `/partner/**`, `/customer/**`, `/admin/**`, `/owner/**`, and catch-all `**` SPA fallbacks that served HTML for missing assets. Missing `.js`/`.mjs` now **404**.  
5. **Cache-Control** — include `*.mjs`.  
6. Synced complete `build-hosting.mjs` + shared P2P/diagnostics modules into validate worktree so it cannot silently build a graph-incomplete partner/customer tree the same way.

---

## Restore / verify commands

```powershell
cd F:\ride-app
node tools/build-hosting.mjs
node tools/hosting-startup-health.mjs
# expect FAIL=0

# Prove live is currently broken (before restore deploy):
node tools/hosting-startup-health.mjs --url https://swiftgo-ride-app.web.app

firebase deploy --only hosting --project swiftgo-ride-app

# After deploy:
node tools/hosting-startup-health.mjs --url https://swiftgo-ride-app.web.app
```

---

## P2-C

**Do not start P2-C** until live health check PASSes and operator confirms Customer Home + Driver start on devices.
