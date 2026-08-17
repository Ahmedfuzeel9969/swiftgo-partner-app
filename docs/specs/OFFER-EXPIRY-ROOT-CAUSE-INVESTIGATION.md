# Offer Auto-Expiry — Root Cause Investigation

**Date:** 2026-08-07  
**Revised:** 2026-08-07 (after production run proof attempt — see `OFFER-EXPIRY-PRODUCTION-RUN-EVIDENCE.md`)  
**Trigger:** Remaining automatic offer-expiry behavior observed during Package 7-A physical testing (separate from 7-A structural acceptance)  
**Scope:** Investigation only — **no code, no deploy, no cleanup**  
**Frozen (must not modify):** Packages 1, 2, 3, 7-A  

**Evidence sources used:**
- Source code trace (`F:/ride-app`)
- Live hosting bundle fetch (`swiftgo-ride-app.web.app`, 2026-08-07)
- **Production Cloud Logging** (`firebase functions:log`, 2026-08-07) — offer `gMbDcflZ2cP7IL8x3wz0_tyYlQNihZnafD78GXNaPL8L4Vnv2`
- Prior lab report: `docs/specs/phase1-phase2-P1B-THREE-FIX-REPORT.md` (9/9 PASS)
- Operator report: Package 7-A structural PASS; expiry behavior incomplete/inconsistent
- Production run proof attempt: **`OFFER-EXPIRY-PRODUCTION-RUN-EVIDENCE.md`**

---

## Revision — Step 11 status (2026-08-07)

| Prior claim | Revised status |
|-------------|----------------|
| Step 11 **FAIL** — “code-proven root cause” | **Hypothesis only** — logic defect visible in source, **not runtime-confirmed** as first failure |
| Steps 5–8 unknown in production | **PASS** for captured run `gMbDcflZ2cP7IL8x3wz0_...` at **2026-08-07T05:56:58Z** (CF logs) |
| Implement `syncFromInbox` null-clear | **Blocked** until proof items 3–8 captured (see production run evidence doc) |

**Reason:** `myOfferState`, `syncFromInbox()` execution, `getOfferForRide()` return value, and Driver Detail DOM are **in-memory / browser-only** — not present in production logs. No code instrumentation permitted in this investigation.

---

## Chain trace (14 steps)

### Step 1 — `offerTimeoutSeconds` read from Super Admin

| Field | Value |
|-------|-------|
| **Result** | **PASS** (code + admin path) |
| **File** | `super-admin-panel/js/admin-app.js` |
| **Function** | `saveDispatchSettings()` → `saveAdminDispatchSettings()` |
| **File** | `super-admin-panel/js/admin-settings-client.js` |
| **Function** | `saveAdminDispatchSettings()` → CF `setCandidateDriverLimit` |
| **File** | `functions/index.js` |
| **Function** | `exports.setCandidateDriverLimit` — writes `payload.offerTimeoutSeconds` to `settings/dispatch` (L713–718) |
| **Timestamp** | Not captured in this investigation |
| **Runtime evidence** | Admin UI validates 5–300s (admin-app.js L1976–1981). CF persists to Firestore. |
| **Why PASS** | Complete write path exists; value consumed server-side via `readDispatchSettings()` → `normalizeOfferTimeoutSeconds()` (`functions/bargaining.js` L415–464, L59–66). Default 30s if unset. |
| **Production caveat** | **UNKNOWN** whether test session used a reduced timeout (e.g. 10s) without operator log. |

---

### Step 2 — `offerExpiresAt` written to Firestore

| Field | Value |
|-------|-------|
| **Result** | **PASS** (code + lab) · **UNKNOWN (production doc snapshot)** |
| **File** | `functions/bargaining.js` |
| **Function** | `submitRideOffer()` — reads dispatch, sets `offerExpiresAt` + `offerTimeoutSeconds` on offer payload (L1330–1333, L1372–1385) |
| **Function** | `counterRideOffer()` — resets `offerExpiresAt` on counter (L1413–1437) |
| **Collection** | `ride_offers/{rideId}_{driverId}` |
| **Timestamp** | Not captured |
| **Runtime evidence** | Lab T1/T8 in `tests/p1b-auto-expire-suite.mjs` uses `offerExpiresAt`; prior run **PASS 9/9** (`phase1-phase2-P1B-THREE-FIX-REPORT.md`). |
| **Why PASS** | Server always writes absolute `offerExpiresAt` Timestamp on submit/counter when CF succeeds. |
| **Failure mode** | If `submitRideOffer` never called, no offer doc — out of expiry chain scope. |

---

### Step 3 — Driver inbox timer starts

| Field | Value |
|-------|-------|
| **Result** | **PASS** (when preconditions met) · **FAIL** (when inbox stopped) |
| **File** | `driver-app/js/driver-offer-inbox.js` |
| **Function** | `createDriverOfferInbox()` → `start()` → `onSnapshot` → `scheduleExpiry()` + `ensureTick()` |
| **File** | `driver-app/js/driver-app.js` |
| **Function** | `syncDriverOfferInbox()` — `canListen` gate (L2402–2410) |
| **Timestamp** | Not captured |
| **Runtime evidence** | Live bundle contains `scheduleExpiry`, `flushExpired("inbox_tick")`, `expireRideOffer_call` (curl partner `driver-offer-inbox.js`, 2026-08-07). |
| **Why PASS** | Inbox starts per-offer `setTimeout` (TM-04) and 1s tick (TM-05) when snapshot delivers offers with `offerExpiresAt`. |
| **Why FAIL** | Inbox **does not run** unless `currentDriver`, `linkedVehicle`, `isOnlineReady()`, and **no** `activeExecutionRide` (driver-app.js L2404–2408). Driver on detail but offline / no PIN / active ride → **no timers**. |
| **Severity if FAIL** | **High** — steps 5, 10, 11 (inbox-driven) never run. |

---

### Step 4 — Customer timer starts

| Field | Value |
|-------|-------|
| **Result** | **PASS** (code + live bundle) · **UNKNOWN (production session)** |
| **File** | `customer-app/js/offer-client.js` |
| **Function** | `watchRideOffers()` → `schedule()` + `setInterval(flushExpired("customer_tick"), 1000)` |
| **File** | `customer-app/js/ride-flow.js` |
| **Function** | `subscribeLive` binds `watchRideOffers` while ride searching (L519–530) |
| **Timestamp** | Not captured |
| **Runtime evidence** | Live `offer-client.js` contains `expireRideOffer_call`, `customer_tick`, `flushExpired` (curl, 2026-08-07). Customer entry `?v=offer_expire_fix_1` (index.html L1205). |
| **Why PASS** | Timer layer deployed on production hosting. |
| **Failure mode** | Timer only active while customer ride view subscribed; app killed/background → **design limit** (no Scheduler). |

---

### Step 5 — Driver invokes `expireRideOffer`

| Field | Value |
|-------|-------|
| **Result** | **PASS** (code) · **UNKNOWN (production console)** |
| **File** | `driver-app/js/driver-offer-inbox.js` |
| **Function** | `requestExpireRideOffer()` ← `flushExpired()` / `scheduleExpiry` timeout / snapshot piggyback |
| **Sources** | `inbox_timer`, `inbox_tick`, `inbox_snapshot`, `inbox_visible` |
| **Post 7-A** | **`detail_ui` source not reachable** (FW-18 disabled — PACKAGE7-A-CLOSURE-REPORT.md) |
| **Timestamp** | Not captured |
| **Runtime evidence** | Code path logs `[SwiftGo] expireRideOffer_call` before CF. No production console capture in this investigation. |
| **Why PASS (code)** | Inbox removes past-due offers from map and calls CF (L119–127, L144–150). |
| **Why UNKNOWN** | Operator did not attach console logs. Cannot confirm invoke occurred on failing run. |
| **Note** | After 7-A, driver has **single** expire scheduler (inbox only). Inbox failure = no driver-side invoke. |

---

### Step 6 — Customer invokes `expireRideOffer`

| Field | Value |
|-------|-------|
| **Result** | **PASS** (code) · **UNKNOWN (production console)** |
| **File** | `customer-app/js/offer-client.js` |
| **Function** | `expireRideOfferClient()` ← `flushExpired()` / `schedule()` timeout |
| **Sources** | `customer_watch`, `customer_timer`, `customer_tick`, `customer_visible` |
| **Timestamp** | Not captured |
| **Runtime evidence** | Live bundle includes invoke + tick (curl). |
| **Why PASS (code)** | Symmetric to driver L2 design. |
| **Why UNKNOWN** | No production console logs attached. |

---

### Step 7 — Cloud Function receives the request

| Field | Value |
|-------|-------|
| **Result** | **PASS** (lab + deployed export) · **UNKNOWN (production logs)** |
| **File** | `functions/index.js` |
| **Function** | `exports.expireRideOffer` (L441–465) — logs `expireRideOffer_invoke` |
| **File** | `functions/bargaining.js` |
| **Function** | `expireRideOffer()` (L171–204) |
| **Timestamp** | Prior deploy ~2026-08-06 15:05 UTC (THREE-FIX-REPORT.md) |
| **Runtime evidence** | Callable exported; auth required. Lab T1 PASS. Emulator re-run **not executed** (port 8080 blocked). |
| **Why PASS (lab)** | 9/9 suite passed on validate tree. |
| **Why UNKNOWN (prod)** | No `firebase functions:log` output from operator session attached. |

---

### Step 8 — Cloud Function changes Firestore status to `expired`

| Field | Value |
|-------|-------|
| **Result** | **PASS** (lab) · **UNKNOWN (production Firestore)** |
| **File** | `functions/bargaining.js` |
| **Function** | `markOfferTimedOutInTx()` (L117–124) inside `expireRideOffer` transaction |
| **Condition** | `isOfferPastTimeout(offer, nowMs)` must be true; else throws `NOT_YET_EXPIRED` (L191–192) |
| **Timestamp** | Not captured |
| **Runtime evidence** | Lab T1: status `expired` after past-due invoke. |
| **Why PASS (lab)** | Server authority works in emulator. |
| **Why UNKNOWN (prod)** | Without Firestore before/after snapshot, cannot confirm production write. |
| **Failure mode** | Clock skew / early invoke → `NOT_YET_EXPIRED`; client may have already hidden offer locally while server still `open`. |

---

### Step 9 — Firestore listeners receive the update

| Field | Value |
|-------|-------|
| **Result** | **PASS** (code behavior) · **UNKNOWN (production timing)** |
| **Driver** | `driver-offer-inbox.js` query `status in open/countered` — expired doc **drops out** of query |
| **Customer** | `offer-client.js` query `status in open/countered` — same |
| **Detail** | PL-02 **disabled** (7-A) — detail no longer listens to offer doc directly |
| **Timestamp** | Not captured |
| **Runtime evidence** | Standard Firestore query semantics; when status becomes `expired`, doc excluded from listener results. |
| **Why PASS** | Both apps use status-filtered queries. |
| **Latency** | Snapshot delay typically sub-second; not measured in this investigation. |

---

### Step 10 — Driver Inbox updates

| Field | Value |
|-------|-------|
| **Result** | **PASS** (code) · **UNKNOWN (production UI observation)** |
| **File** | `driver-app/js/driver-offer-inbox.js` |
| **Function** | `flushExpired` / snapshot handler → `publishFiltered()` → `onOffersChanged` |
| **File** | `driver-app/js/driver-app.js` |
| **Function** | `onOffersChanged` → `refreshList` + `syncDetailFromInbox` (L4681–4684) |
| **Timestamp** | Not captured |
| **Runtime evidence** | Inbox removes past-due from `offersByRideId` before/alongside CF invoke. `getOfferForRide()` returns null for past-due (L250–253). |
| **Why PASS** | Inbox map and badges driven from filtered map. |
| **Note** | Inbox can hide offer **before** step 8 completes (local clock filter). |

---

### Step 11 — Driver Detail updates

| Field | Value |
|-------|-------|
| **Result** | **NOT PROVEN (runtime)** · **FAIL (static code path — hypothesis)** |
| **File** | `driver-app/js/RideRequestDetail.js` |
| **Function** | `syncFromInbox()` (L420–437) → `applyOfferExpiryUi()` (7-A: FW-18 disabled → `syncOfferUi()` only) |
| **Timestamp** | Not captured — see `OFFER-EXPIRY-PRODUCTION-RUN-EVIDENCE.md` |
| **Runtime evidence** | **Production CF logs show steps 5–8 PASS** for ride `gMbDcflZ2cP7IL8x3wz0` — **does not prove** items 3–8 of Step 11 proof checklist. |
| **Static code evidence** | When inbox returns `null`, `syncFromInbox` may leave optimistic `myOfferState` (no expiry fields) unchanged — see `submitBid()` L601–607. |
| **Why not confirmed as first runtime failure** | `myOfferState` before/after sync **not observable** without instrumentation or DevTools. |
| **Severity if confirmed** | **#1 — Critical** (UI-only break after successful server expire) |

---

### Step 12 — Customer UI updates

| Field | Value |
|-------|-------|
| **Result** | **PASS** (local filter) · **UNKNOWN / partial FAIL** (if server still `open`) |
| **File** | `customer-app/js/offer-client.js` |
| **Function** | `emitAlive()` — filters `latestRaw` with `!isOfferPastExpiryLocal(o)` |
| **File** | `customer-app/js/ride-flow.js` |
| **Function** | `updateDriverOfferUi()` — hides panel when no open/countered offers (L964–972) |
| **Timestamp** | Not captured |
| **Runtime evidence** | Customer can hide offer panel on **local clock** before server marks `expired`. |
| **Why PASS** | UI can clear on local expiry even if step 8 delayed. |
| **Why partial FAIL** | If customer timer never fires and server not expired, panel stays visible — **UNKNOWN** without session logs. |
| **Severity** | **#3** — driver/customer visible desync when step 11 FAIL and step 12 PASS. |

---

### Step 13 — Accept buttons disappear

| Field | Value |
|-------|-------|
| **Result** | **Partial FAIL** (driver detail) · **PASS** (server guard) |
| **Driver detail** | `syncOfferUi()` — `myOffer` false when expired, but `driverOfferRecordExists` true whenever `offer != null` (L487–493) — accept-initial panel stays hidden incorrectly **or** counter/bid panels may remain if step 11 FAIL |
| **Customer** | `updateDriverOfferUi` hides accept when no open offers in `activeOffers` |
| **Server** | Accept paths reject with `OFFER_EXPIRED` (Fix #3 — ACCEPT-PATH-AUDIT.md) |
| **Timestamp** | Not captured |
| **Why partial FAIL** | UI buttons may remain visible (step 11 stale state) even when server would reject accept. |
| **Severity** | **#2** — user may attempt accept; server blocks but UX unreliable. |

---

### Step 14 — Ride continues searching for other drivers

| Field | Value |
|-------|-------|
| **Result** | **PASS** (by design) |
| **File** | `functions/bargaining.js` |
| **Function** | `expireRideOffer()` — does **not** change `rides.status` (comment L929–930) |
| **Evidence** | Lab T1 explicitly expects search continues. Offer expiry ≠ search expiry. |
| **Why PASS** | Correct business rule; not the reported defect. |

---

## Broken steps ranked by severity

| Rank | Step | Result | Severity | Evidence type |
|------|------|--------|----------|---------------|
| **1** | **11 — Driver Detail updates** | **FAIL** | **Critical** | Code-proven (`syncFromInbox` + optimistic bid) |
| **2** | **13 — Accept buttons disappear** | **Partial FAIL** | **High** | Code-proven (depends on step 11 + `driverOfferRecordExists`) |
| **3** | **12 — Customer UI** | **UNKNOWN / partial** | **Medium** | Code + operator “inconsistent” report |
| **4** | **3 — Driver inbox timer** | **Conditional FAIL** | **Medium** | Code-proven gate when driver not `canListen` |
| **5** | **5–8 — Invoke + CF + Firestore write** | **UNKNOWN (prod)** | **Medium** | Lab PASS; no production logs |
| **6** | **6 — Customer invoke** | **UNKNOWN (prod)** | **Low–Medium** | No console logs |

Steps **1, 2, 4, 9, 10, 14**: **PASS** (implementation present; 14 by design).

---

## A. Exact root cause

### Production evidence (2026-08-07)

For offer **`gMbDcflZ2cP7IL8x3wz0_tyYlQNihZnafD78GXNaPL8L4Vnv2`**:

- `submitRideOffer` → **05:56:17Z**
- `expireRideOffer_invoke` → **05:56:58Z** (driver uid)
- `expireRideOffer_result` → **`status: expired`**, `alreadyClosed: false`, `closedReason: offer_timeout`

**Therefore steps 5–8 (driver invoke → CF → Firestore expire) PASS for this production run.**  
**Step 11 is NOT proven as the first failing runtime step** — client proof items 2–8 not captured.

### Leading hypothesis (static code — pending runtime proof)

> **Step 11 — `RideRequestDetail.syncFromInbox()` may fail to clear stale `myOfferState` when inbox has no offer.**

**Not confirmed at runtime.** Requires DevTools or approved diagnostic capture (see `OFFER-EXPIRY-PRODUCTION-RUN-EVIDENCE.md`).

**Do not implement fix until proof checklist items 3–8 are captured for one run tied to a failing UI observation.**

---

## B. Minimal fix

**Status: NOT APPROVED FOR IMPLEMENTATION** — runtime proof incomplete.

**Candidate fix (after proof):** In `syncFromInbox()`, when `getOfferForRide()` returns null, set `myOfferState = null`.

See prior analysis in git history / investigation appendix. Do not deploy until items 3–8 captured.

---

## C. Expected side effects

| Effect | Likelihood |
|--------|------------|
| Driver detail clears bid/counter UI when inbox drops offer | **Intended fix** |
| Accept-initial panel may appear when inbox has no offer and ride still `searching_driver` | **Intended** (correct SSOT) |
| Brief flicker if inbox snapshot arrives after optimistic bid | Low — unchanged from today |
| No change to server expiry timing or CF behavior | Expected |
| Customer UI unchanged | Expected |
| Package 7-A frozen code untouched | Expected |

---

## D. Rollback plan

| Item | Action |
|------|--------|
| **If fix deployed via hosting only** | Firebase Hosting rollback to pre-fix release **or** `git checkout` prior `RideRequestDetail.js` only |
| **Functions** | No rollback needed (minimal fix is client-only) |
| **Package 7-A** | Do not rollback 7-A disable blocks |
| **Tag before fix** | `ssot/offer-expiry-fix-baseline-YYYYMMDD` from current 7-A frozen state |

---

## E. Risk level

| Fix scope | Risk |
|-----------|------|
| **`syncFromInbox` null clear only** | **Low–Medium** — one function, one file, hosting-only, aligns with 7-A SSOT intent |
| **Combined with 7-B delete** | **High** — do not combine without separate approval |
| **CF / customer changes** | **High** — not part of minimal fix |

---

## §10 — Operator evidence still needed (production steps 5–8)

To confirm or rule out secondary CF-chain failure, capture one failing run using template in `PACKAGE7-OFFER-EXPIRY-REMAINING-ISSUE-REPORT.md` §10:

- `[SwiftGo] expireRideOffer_call` on driver and customer  
- `firebase functions:log --only expireRideOffer`  
- Firestore `ride_offers/{rideId}_{driverId}` status before/after wall-clock  

---

## Stop

**Investigation incomplete for Step 11 runtime proof.**

**Production run captured (partial):** `OFFER-EXPIRY-PRODUCTION-RUN-EVIDENCE.md`

**Package 7-B blocked.** **Step 11 fix blocked** until operator/DevTools capture completes proof checklist.

**Do not modify Package 7-A.**

---

**End of Root Cause Investigation**
