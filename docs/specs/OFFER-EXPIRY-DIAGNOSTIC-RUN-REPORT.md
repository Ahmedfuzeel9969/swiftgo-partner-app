# Offer Expiry — Diagnostic Run Report

**Date:** 2026-08-07  
**Diagnostic package:** **DEPLOYED** (`offer_expiry_diag_1`)  
**Capture status:** **NOT YET COMPLETED** — no operator ring-buffer export received  
**Fix implemented:** **NO**  
**Package 7-B:** **NOT STARTED**  
**Diagnostic logging removed:** **NO** — removal follows capture  

---

## Deploy verification

| Check | Result |
|-------|--------|
| Hosting startup health | **35/35 PASS** |
| `firebase deploy --only hosting` | **PASS** |
| Live `RideRequestDetail.js` contains `offer-expiry-diag` | **PASS** (curl) |
| Live URL | https://swiftgo-ride-app.web.app/partner/?v=offer_expiry_diag_1 |

---

## First failing runtime step

**Cannot be identified yet** — client-side capture sequence not completed.

### What production logs already show (prior run, no diag)

For offer `gMbDcflZ2cP7IL8x3wz0_tyYlQNihZnafD78GXNaPL8L4Vnv2` on **2026-08-07T05:56:58Z**:

| Step | Result |
|------|--------|
| CF `expireRideOffer` invoke + `status: expired` | **PASS** |
| Steps 5–8 (server chain) | **PASS** |

### What diagnostic capture must prove

At timeout boundary, ordered events from `window.__SWIFTGO_OFFER_EXPIRY_DIAG__`:

1. `getOfferForRide` — `inboxOfferExists: true` (bid active)  
2. `syncFromInbox` / `syncOfferUi` — aligned state  
3. After wall-clock expiry — `getOfferForRide` — `inboxOfferExists: false`  
4. `syncFromInbox` — **`myOfferStateExists` still true?** → Step 11 failure candidate  
5. `syncOfferUi` — `offerStatus` still `open`? → UI stale  

**First failing step** = earliest event where expected transition fails (see analysis template below).

---

## Analysis template (complete after capture paste)

| Order | Expected | If FAIL → first broken step |
|-------|----------|----------------------------|
| E1 | `offerExpiresAt` on server (CF log / Firestore) | Step 2 |
| E2 | `getOfferForRide` returns offer before timeout | Step 3/10 |
| E3 | `getOfferForRide` returns null after timeout | Step 10 inbox remove |
| E4 | `syncFromInbox` runs after E3 | Step 3 (not wired) |
| E5 | After E3: `myOfferStateExists: false` | **Step 11** if still true |
| E6 | `syncOfferUi` `offerStatus` not `open` for display | Step 11/13 |
| E7 | Driver detail UI cleared (operator visual) | Step 8 / 13 |

---

## Current conclusion (pre-capture)

| Item | Status |
|------|--------|
| Step 11 as first **runtime** failure | **Unconfirmed** — pending diag capture |
| Step 11 as **hypothesis** | Still leading candidate if E5 shows stale `myOfferState` when `inboxOfferExists: false` |
| Server chain (steps 5–8) | **PASS** on prior production CF evidence |
| Step 11 fix | **Blocked** until capture + analysis complete |
| Remove diagnostic logging | **Blocked** until one full timeout sequence exported |

---

## Next actions (gated)

1. Operator runs capture procedure → `OFFER-EXPIRY-DIAGNOSTIC-PACKAGE.md`  
2. Paste `__SWIFTGO_OFFER_EXPIRY_DIAG__` JSON for analysis  
3. Update this report with **first failing runtime step** (evidence-backed)  
4. Remove diagnostic logging (separate deploy)  
5. Only then: approve or reject Step 11 fix (separate package)  

---

**STOP. No fix. No 7-B. Diagnostics live until capture + removal.**
