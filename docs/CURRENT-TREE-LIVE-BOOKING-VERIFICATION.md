# Current-Tree Live Booking Verification

**Date:** 2026-07-29  
**Project:** `swiftgo-ride-app`  
**HEAD commit:** `1b2f877` (`fix(apps): keep each app surface on its own URL for shared Gmail`)  
**Current source under test:** **working tree** (uncommitted booking/ghost/expiry/Driver-location fixes atop HEAD)  
**Production modified this turn:** **No**  
**Code changes this turn:** **None** (verification only; existing working-tree code already correct under emulator)  
**Final verdict:** **CONDITIONAL PASS**

---

## 1. Old survey superseded

The [Explore cancel and match paths](ddeb5820-b6e7-424e-a0ed-473b7847475a) survey examined the **pre-fix** tree.

It is **superseded**. Do not use it to drive new duplicate implementations.

Already present in the **current working tree** (and re-confirmed this turn):

| Capability | Present in current source? |
|------------|----------------------------|
| Close candidates on cancel/expire | Yes |
| Close offers on cancel/expire | Yes |
| Trusted `expiresAt` on create | Yes |
| Cancel-all cancelled/skipped/failed counts | Yes |
| Map-independent Driver location sync | Yes |
| `expiresAt` index declaration | Yes |
| False-success toast guard | Yes |
| Live canonical ride counting + reconcile | Yes |
| Three-minute expiration handling | Yes |

---

## 2. Current-tree feature verification

| Item | File | Function / locus | Test | Commit / tree |
|------|------|------------------|------|---------------|
| Candidate/offer closure | `functions/bargaining.js` | `closeCandidatesAndOffersForRide`; used by cancel/expire/reconcile | ghost `S03`, `E05` | working tree (uncommitted) |
| Trusted `expiresAt` | `functions/bargaining.js` | `createCustomerBooking` sets `Timestamp.now+SEARCH_EXPIRE_MS` | ghost `B01`, `S02` | working tree |
| Cancel-all counts | `functions/bargaining.js` | `cancelAllSearchingBookings` → `cancelledCount`, `failed`, `blockingAssigned` | ghost `S04`, `A04` | working tree |
| Map-independent GPS sync | `driver-app/js/driver-app.js` | `updateDriverLocation` syncs before map mount | ghost `S05` | working tree |
| `expiresAt` index | `firestore.indexes.json` | `rides`: `status` + `expiresAt` | ghost `S07` | working tree |
| False-success guard | `customer-app/js/app.js` | `handleBookRide` → toast only if `ride?.id` | false-success `S01`–`S02` | working tree (also on live Hosting) |
| Live ride counting | `functions/bargaining.js` | `evaluateCustomerBookingGate` / `reconcileCustomerBookingState` + `countCustomerActiveBookings` | false-success `S07`, `E01`–`E02`; ghost `A01` | working tree |
| 3-minute expire | `functions/bargaining.js` | `expireSearchingBooking`, `expireDueSearchingBookings`; client timer → CF | ghost `E01`–`E09` | working tree |
| Shared statuses | `customer-app/js/ride-status.js` + `functions/matching.js` | `NON_TERMINAL_RIDE_STATUSES` | false-success `S05` | working tree |
| Cache bust (local) | `customer-app/index.html` | `app.js?v=ghost_rides_expiry_1` | — | working tree |

**No rewrite performed** — items already correct under emulator.

---

## 3. Source-versus-deployed comparison

**Live Hosting release:** 2026-07-29 10:39:08 (`https://swiftgo-ride-app.web.app`)  
**Evidence:** fetched live HTML/JS markers.

### Customer Hosting

| Check | Current source | Deployed Production | Same? |
|-------|----------------|---------------------|-------|
| JS cache bust | `app.js?v=ghost_rides_expiry_1` | `app.js?v=booking_false_success_fix_1` | **No** |
| False-success `ride?.id` guard | Yes | Yes (present in live `app.js`) | **Yes** |
| Active booking statuses via `ride-status.js` | Yes | Yes (`ride-status.js` 200; gate imports it) | **Yes** |
| Cancel-all result UX (`cancelledCount` / `bookingClearFailed`) | Yes in `ride-flow.js` | **No** (`cancelledCount` absent in live `ride-flow.js`) | **No** |
| Callable names | `checkCustomerBookingGate`, `cancelAllSearchingBookings`, `createCustomerBooking`, `expireSearchingBooking` | Same names used by live clients | **Yes** (names) |
| Functions region | `us-central1` | `us-central1` | **Yes** |
| Firebase project | `swiftgo-ride-app` | `swiftgo-ride-app` | **Yes** |

### Driver Hosting

| Check | Current source | Deployed Production | Same? |
|-------|----------------|---------------------|-------|
| Driver JS bust | `driver-app.js?v=ghost_rides_expiry_1` | `driver-app.js?v=console_stability_1` | **No** |
| Map-independent location sync | Yes | **No** (marker string absent) | **No** |
| Availability diag `#driverAvailDiag` | Yes | **No** | **No** |

### Functions

| Check | Current source | Deployed Production | Same? |
|-------|----------------|---------------------|-------|
| Callable list includes create/gate/cancel/match/expireSearching | Yes | Yes (`firebase functions:list`) | **Yes** |
| `expireDueSearchingBookings` export | Yes | **Absent from deployed list** | **No** |
| Live-count reconcile + cancel-all with counts + `expiresAt` create + candidate/offer close on cancel | Yes (working tree) | **Partial at best** — last Functions deploy was with Hosting at 10:39 (false-success wave). Ghost/expiry/cancel-repair wave was **never deployed** afterward | **No** (ghost/expiry layer) |
| Matching | Yes | `matchRideCandidates` present | **Yes** (callable exists; behaviour = last deployed revision) |

### Index

| Check | Current source | Deployed Production | Same? |
|-------|----------------|---------------------|-------|
| `rides` `status` + `expiresAt` | Declared in `firestore.indexes.json` | **Not present** in `firebase firestore:indexes` dump (`expiresAt index NOT in Production dump`) | **No** |

### Deployment-version mismatch (clear)

| Layer | State |
|-------|--------|
| Customer Hosting | False-success fix **live**; ghost cancel UX + `ghost_rides_expiry_1` **not live** |
| Driver Hosting | Location-without-map fix **not live** |
| Functions | Pre–ghost-rides revision still serving; `expireDueSearchingBookings` **not live** |
| Indexes | `expiresAt` composite **not live** |

**Primary remaining live defect class:** Production is behind the current working tree — not a missing re-implementation of already-correct source.

---

## 4. Account A exact diagnosis

**Live authenticated capture:** **BLOCKED** — Account A UID was not provided; privileged Production Firestore reads were not performed (policy: stop for approval).

### Privileged read that would finish the diagnosis (approval required)

| Item | Value |
|------|--------|
| Reads | `booking_slots/{uidA}` (1); `rides` where `userId==uidA` and `status in [searching_driver,accepted,arrived,in_progress]` (≤10); optional full `userId==uidA` limit 20 for status audit |
| Expected docs | Typically ≤ 4–20 ride docs + 1 slot doc |
| Privacy | Redact to status, createdAt, expiresAt, driverId-present boolean, redacted id prefix — no email/phone/coords/tokens |
| Quota | Negligible (tens of document reads) |

### Which hypotheses remain plausible on live Production (without guessing records)

| # | Hypothesis | Status |
|---|------------|--------|
| 1 | Four real non-terminal rides | Possible — would explain lasting MAX after reconcile-capable gate |
| 2 | Slots=4, live=0 | Less likely if deployed gate reconciles (false-success Functions wave); still possible if gate CF fails and client falls back oddly |
| 3 | Four old searching never expired | Possible — Production lacks deployed `expiresAt` + batch expire + READY index |
| 4 | UI hides rides gate counts | Unlikely on live Hosting: history uses same non-terminal set; if user still sees empty active area with count=4, investigate listener/index errors in browser |
| 5 | Ownership field mismatch | Unlikely in current contract (`userId` only) |
| 6 | Wrong ride IDs on cancel | Possible if UI has no visible IDs and clear-all uses server query only |
| 7 | Status name rejection | Possible on older cancel if status ≠ `searching_driver` (e.g. assigned ghosts) → `NOT_CANCELLABLE` |
| 8 | Old cancellation Function | **Confirmed partial:** deployed cancel-all predates count/reason/candidate-close repair |

**Emulator proof of class-of-bug (Account A fixtures):** inflated slots + zero live → allowed (`A01`); four searching → same IDs gate/list (`A03`); cancel-all frees (`A04`); then new booking possible.

---

## 5. Cancellation failure reason

**Live Account A error code:** not captured (no UID/session).

**Deployed client behaviour:** live `ride-flow.js` lacks `cancelledCount` / `bookingClearFailed` handling — on clear failure it still tends to surface the generic max-booking message, which matches “cancellation failed / still locked” reports.

**Working-tree behaviour (emulator):** exact reasons such as `RIDE_NOT_FOUND`, `NOT_YOUR_BOOKING`, `NOT_CANCELLABLE:<status>`; cancel-all returns structured counts (`A04`–`A05`).

---

## 6. Account B real ride proof

**Live Account B create response:** **BLOCKED** (no UID/session; no privileged ride read).

**Emulator Account B class proof (`B01`–`B03`):**

- Real ride ID returned  
- Canonical `rides` doc `searching_driver` with trusted `expiresAt`  
- Matching creates `invited` candidate  
- Driver listener filters would receive it  

**Live Hosting** already has false-success guard, so toast alone is not sufficient — but Production create still depends on deployed Functions revision (without working-tree `expiresAt`).

---

## 7. Driver location freshness and distance category

**Live Driver position:** **unknown** — no authenticated Driver session / no privileged `vehicles/{id}` read this turn.

**Deployed Driver app:** does **not** contain map-independent Firestore sync → GPS updates can be dropped when the map canvas is not mounted. That alone can leave matching with missing/stale/`geoCell`-absent location.

**Distance category for live test Driver:** **unknown because location may be missing or not server-visible**.

**Emulator distance categories:** proven — within 1 / 1–2 / 2–3 receive; beyond 3 never (`D01`–`D04`).

---

## 8. Driver eligibility result

| Condition | Emulator | Live |
|-----------|----------|------|
| ≤3 km + online + fresh + geoCell + not busy/blocked | Eligible; candidate created | Not measured |
| Beyond 3 km / missing / stale / offline / busy / blocked | Excluded with reason | Not measured |

Do **not** weaken the 3 km radius.

---

## 9. Matching / candidate / listener results

### Emulator chain (PASS)

| Step | Expected | Actual | Result |
|------|----------|--------|--------|
| 1 Create canonical ride | ride id + searching | Yes | PASS |
| 2 Matching starts | invoked | Yes | PASS |
| 3 Nearby cells / rings | 1→2→3 | Yes | PASS |
| 4 Eligible driver | passes filters | Yes | PASS |
| 5 Candidate created | `invited` doc | Yes | PASS |
| 6 Listener contract | `driverId` + `invited` + searching ride | Would receive | PASS |
| 7 UI display | radar list | Covered by listener contract + prior four-app work; Phase 2E not re-run this turn | CONDITIONAL |

### Live chain (Account B)

| Step | Result |
|------|--------|
| 1 Create | Likely works (Account B can create) |
| 2–5 Matching / candidate | **First likely failure:** Driver location not reliably on server (deployed Driver JS) and/or Driver beyond 3 km / offline / offline `geoCell` — **not distinguished without live vehicle+ride reads** |
| 6–7 Listener/UI | Unknown until candidate existence proven |

---

## 10. Three-minute expiration trigger status

| Layer | Status |
|-------|--------|
| Code exists locally | **Yes** (`expiresAt`, `expireSearchingBooking` → `expired`, batch `expireDueSearchingBookings`, client timer) |
| Code deployed | **Partial:** `expireSearchingBooking` callable exists; **`expiresAt` create + batch expire + candidate close on expire = working-tree only (not in post-10:39 ghost deploy)** |
| Trigger configured | **No** Cloud Scheduler for `expireDueSearchingBookings` |
| Required index READY | **No** — missing in Production index dump |
| Trigger has run | **No** evidence of batch expire in Production |

**Do not claim the three-minute rule is fully live** merely because a client timer or `expireSearchingBooking` callable name exists.

Emulator rule proof: `E01`–`E09` all PASS (controllable clock; no real-minute waits).

---

## 11. Test commands, exit codes, totals

| Command | Totals | Exit |
|---------|--------|------|
| `firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/ghost-rides-driver-location-expiry-suite.mjs"` | **37 PASS / 0 FAIL** | 0 |
| `… "node tests/booking-false-success-suite.mjs"` | **23 PASS / 0 FAIL** | 0 |
| `… "node tests/phase2a-bargaining-suite.mjs"` | **21 PASS / 0 FAIL** | 0 |
| `npm run test:phase2c` | **114 PASS / 0 FAIL** | 0 |
| `npm run test:phase3b` | **22 PASS / 0 FAIL** | 0 |
| `npm run build:hosting` | Hosting package built | 0 |
| `npm run test:phase2e` | **Not re-run this turn** | — |

No tests deleted, skipped, or weakened.

---

## 12. Exact files changed this turn

**None.** Verification only.

---

## 13. Minimal required deployment components (approval required)

| Component | Required | Why |
|-----------|----------|-----|
| **Functions** | **Yes** | Ship working-tree cancel repair, `expiresAt`, expire semantics, `expireDueSearchingBookings` |
| **Hosting** (Customer + Driver) | **Yes** | `ghost_rides_expiry_1` cancel UX + map-independent location + avail diag |
| **Indexes** | **Yes** | `status` + `expiresAt` must be READY before relying on batch expire |
| **Cloud Scheduler** | Optional / separate billing approval | Server-side 3-minute guarantee without open Customer tab |
| Rules | Not required for this delta if allowlists unchanged | — |

**Do not deploy without separate approval.**

---

## 14. Limited Production data correction

| Need | Action |
|------|--------|
| Account A genuine old searching rides | After Functions+Hosting deploy, Customer cancel-all should clear them; **do not manually delete** |
| If assigned non-searching ghosts remain | Prepare trusted reconcile/cancel op; **STOP for approval** before any write |
| Privileged diagnostic reads | Need Account A/B UIDs + approval (section 4) |

---

## 15. Billing / quota implications

| Action | Impact |
|--------|--------|
| Deploy Functions/Hosting/Indexes | Normal deploy cost; index build is one-time |
| Enable Scheduler every 1 min, limit 25 | ~43k invocations/month + bounded reads/writes — **do not enable without approval** |
| Diagnostic reads for one UID | Tens of document reads — negligible |

---

## 16. Unrelated features

No UI redesign, Leaflet styling, pricing, wallet, settlement, bargaining model, radius, candidate limits, Android packaging, or Tracking Prevention work.

---

## 17. Production not changed

- No deploy  
- No Production document edits  
- No billing changes  
- No Play upload  

---

## Final verdict

### **CONDITIONAL PASS**

- Current working-tree booking/cancel/match/expiry code is **emulator-proven** and must not be re-implemented.  
- Live Production remains on an **older Hosting+Functions cut** (false-success Customer Hosting live; ghost/expiry/Driver-location layer **not** live).  
- Account A/B live record forensics and Driver distance category are **BLOCKED** without UIDs + approved read.  
- Next step after approval: deploy **Functions + Hosting (Customer+Driver) + Indexes**; optionally Scheduler; then re-verify Account A unlock and Account B→Driver with controlled ≤3 km Driver.
