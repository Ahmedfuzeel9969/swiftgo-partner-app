# Offer Expiry — Production Run Evidence (Step 11 Proof Attempt)

**Date:** 2026-08-07  
**Objective:** Prove Step 11 is the **first failing runtime step** before any fix  
**Method:** Production Cloud Logging + code trace — **no code changes, no deploy**  
**Verdict:** **Step 11 NOT CONFIRMED as first runtime failure** — client-side state (items 3–8 below) **not observable** in production without instrumentation or operator DevTools capture.

---

## Selected production run (best available evidence)

Anchored to Cloud Function logs on project **`swiftgo-ride-app`** (production).

| Field | Value |
|-------|-------|
| **Offer ID** | `gMbDcflZ2cP7IL8x3wz0_tyYlQNihZnafD78GXNaPL8L4Vnv2` |
| **Ride ID** | `gMbDcflZ2cP7IL8x3wz0` |
| **Driver UID** | `tyYlQNihZnafD78GXNaPL8L4Vnv2` (from offer ID suffix + invoke log) |
| **submitRideOffer** | `2026-08-07T05:56:17.766486Z` (auth VALID) |
| **expireRideOffer invoke** | `2026-08-07T05:56:58.100208Z` |
| **expireRideOffer result** | `2026-08-07T05:56:58.226734Z` — `status: expired`, `alreadyClosed: false`, `closedReason: offer_timeout` |
| **Wall-clock submit → expire** | **~41 seconds** |

Secondary run (duplicate invoke — same offer expired twice):

| Offer ID | invoke | result |
|----------|--------|--------|
| `fECs6IQQ68SMyHyb5ost_tyYlQNihZnafD78GXNaPL8L4Vnv2` | `2026-08-07T05:54:36.198807Z` + `.206473Z` (customer uid `okK6H7OuDqUkg6BknigLZFWBYXC2`) | both `alreadyClosed: true` at `.039233Z` / `.047049Z` |

**Source:** `firebase functions:log --only expireRideOffer` and `submitRideOffer` (executed 2026-08-07, agent shell).

**Not available:** Firestore document snapshot (ADC credentials missing on host). Browser `myOfferState` / DOM (no production instrumentation).

---

## Required proof checklist (8 items)

### 1. `offerExpiresAt` written

| Field | Value |
|-------|-------|
| **Result** | **PASS (inferred)** — not direct Firestore snapshot |
| **File** | `functions/bargaining.js` → `submitRideOffer()` |
| **Function** | Writes `offerExpiresAt` + `offerTimeoutSeconds` on offer payload (L1333, L1382–1383) |
| **Timestamp** | Offer create correlated with `submitRideOffer` **2026-08-07T05:56:17Z** |
| **Runtime evidence** | `expireRideOffer_result` with `closedReason: offer_timeout` and `alreadyClosed: false` — server `isOfferPastTimeout()` must have passed (L191–194). That requires resolvable expiry on the stored offer doc. |
| **Why PASS (inferred)** | CF could not mark `offer_timeout` expired on first close unless `offerExpiresAt` (or fallback fields) was present and past due at invoke time. |
| **Gap** | Direct Firestore read blocked: `Could not load the default credentials` on admin SDK. |

---

### 2. Driver inbox removed the offer

| Field | Value |
|-------|-------|
| **Result** | **NOT CAPTURED** |
| **File** | `driver-app/js/driver-offer-inbox.js` |
| **Function** | `flushExpired()` / `publishFiltered()` → deletes from `offersByRideId` |
| **Timestamp** | Expected between local wall-clock expiry and **05:56:58Z** invoke |
| **Runtime evidence** | **None.** No client log exports `offersByRideId` size or map keys in production bundle. |
| **Why not proven** | Inbox state is in-memory only; not written to Firestore or Cloud Logging. |

---

### 3. `syncFromInbox()` executed

| Field | Value |
|-------|-------|
| **Result** | **NOT CAPTURED** |
| **File** | `driver-app/js/RideRequestDetail.js` |
| **Function** | `syncFromInbox()` (L420–437) |
| **Call path (code)** | `driver-app.js` `onOffersChanged` → `rideRadarUi.syncDetailFromInbox()` → `detailUi.syncFromInbox()` |
| **Timestamp** | Unknown |
| **Runtime evidence** | **None.** Function has no `console.info` / diagnostic hook. Closure — not exposed on `window`. |
| **Why not proven** | Cannot observe execution without code instrumentation or DevTools breakpoint. |

---

### 4. `getOfferForRide()` returned null

| Field | Value |
|-------|-------|
| **Result** | **NOT CAPTURED** |
| **File** | `driver-app/js/driver-offer-inbox.js` |
| **Function** | `getOfferForRide(rideId)` (L250–253) |
| **Timestamp** | Unknown |
| **Runtime evidence** | **None.** Return value not logged. |
| **Why not proven** | Same as item 3 — in-memory only. |

---

### 5. `myOfferState` before sync

| Field | Value |
|-------|-------|
| **Result** | **NOT CAPTURED** |
| **File** | `driver-app/js/RideRequestDetail.js` |
| **Variable** | Closure `myOfferState` (L312) |
| **Timestamp** | Unknown |
| **Runtime evidence** | **None.** |
| **Why not proven** | Private closure variable; operator DevTools snapshot not attached to this investigation. |

---

### 6. `myOfferState` after sync

| Field | Value |
|-------|-------|
| **Result** | **NOT CAPTURED** |
| **File** | `driver-app/js/RideRequestDetail.js` |
| **Function** | End of `syncFromInbox()` (L420–437) |
| **Timestamp** | Unknown |
| **Runtime evidence** | **None.** |
| **Why not proven** | Same as item 5. |

---

### 7. `syncOfferUi()` executed

| Field | Value |
|-------|-------|
| **Result** | **NOT CAPTURED** (likely ran if `syncFromInbox` ran — not proven) |
| **File** | `driver-app/js/RideRequestDetail.js` |
| **Function** | `syncOfferUi()` via `applyOfferExpiryUi()` (7-A: FW-18 disabled → delegates to `syncOfferUi` only) |
| **Timestamp** | Unknown |
| **Runtime evidence** | **None.** |
| **Why not proven** | No logging; DOM could be observed by operator but not captured here. |

---

### 8. Final Driver Detail UI state

| Field | Value |
|-------|-------|
| **Result** | **NOT CAPTURED** |
| **Evidence needed** | `#offerStatus` visibility, counter panel, accept-initial panel, bid sheet text |
| **Runtime evidence** | Operator reported Package 7-A structural PASS and separate expiry UX issue — **no screenshot/DOM dump** attached to this run ID. |
| **Why not proven** | No browser session recording for offer `gMbDcflZ2cP7IL8x3wz0_...` tied to this log window. |

---

## Earlier chain steps (context for “first failing step”)

| Step | Result | Evidence |
|------|--------|----------|
| Super Admin `offerTimeoutSeconds` | **UNKNOWN** | No Firestore `settings/dispatch` read (credentials) |
| Driver inbox timer started | **UNKNOWN** | No client logs |
| Customer timer started | **UNKNOWN** | No client logs |
| Driver invoked `expireRideOffer` | **PASS** | Log `2026-08-07T05:56:58.100208Z`, uid driver |
| Customer invoked `expireRideOffer` | **UNKNOWN** for this offer | Customer invoke seen on **other** offer (`okK6H7...` uid) |
| CF received request | **PASS** | `expireRideOffer_invoke` |
| CF → Firestore `expired` | **PASS** | `expireRideOffer_result`, `alreadyClosed: false` |
| Firestore listeners update | **PASS (inferred)** | Standard query excludes `expired`; required for CF result consistency |
| Driver inbox UI update | **NOT CAPTURED** | In-memory |
| **Step 11 Detail sync** | **NOT CAPTURED** | Items 3–8 above |

---

## Conclusion

### Can Step 11 be confirmed as the first broken **runtime** step?

**No — not with the evidence captured in this investigation.**

| Finding | Detail |
|---------|--------|
| **Earlier steps that PASS (production)** | **Steps 5–8** (driver CF invoke + server expire) for offer `gMbDcflZ2cP7IL8x3wz0_tyYlQNihZnafD78GXNaPL8L4Vnv2` on **2026-08-07 ~05:56:58 UTC** |
| **Earlier steps that FAIL** | **None proven** in this run |
| **Step 11** | **Not proven** — items 2–8 of the proof checklist are **NOT CAPTURED** |
| **Prior RCA status** | Step 11 was **code-inferred** only (`OFFER-EXPIRY-ROOT-CAUSE-INVESTIGATION.md`) — remains **hypothesis**, not runtime-confirmed first failure |

### Implication

If the operator’s expiry complaint refers to the **same run** as the CF logs above, the server chain **did complete**. Any remaining defect would be **client UI / detail sync** — consistent with Step 11 hypothesis — but **must not implement the fix** until items 3–8 are captured.

### Minimum capture required before Step 11 fix approval

**Option A — Operator DevTools (no deploy):** On driver detail during timeout, paste:

```javascript
// Breakpoint in Sources on RideRequestDetail.js syncFromInbox line 422
// Or watch: myOfferState, getOfferForRide(currentRide.id)
```

**Option B — Approved diagnostic-only package:** Add read-only `console.info` markers (separate approval; not done here).

---

## RCA report update

See **`OFFER-EXPIRY-ROOT-CAUSE-INVESTIGATION.md`** §Revision — Step 11 downgraded from “code-proven root cause” to **“leading hypothesis; runtime unconfirmed.”**

**Do not implement Step 11 fix until proof checklist items 3–8 are captured for one run.**

---

**STOP — No implementation. No deployment.**
