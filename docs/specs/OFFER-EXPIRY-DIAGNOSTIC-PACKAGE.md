# Offer Expiry — Diagnostic Package (Runtime Observation Only)

**Status:** **DEPLOYED — AWAITING CAPTURE**  
**Date:** 2026-08-07  
**Cache bust:** `?v=offer_expiry_diag_1`  
**Purpose:** Observe runtime only — identify first failing step in offer-expiry chain  

**Not in scope:** Fixes, Package 7-B, CF changes, customer/owner changes, Packages 1–3 / 7-A disable logic.

---

## What was added (read-only)

| File | Function | Logging |
|------|----------|---------|
| `driver-app/js/driver-offer-inbox.js` | `getOfferForRide()` | `[SwiftGo][offer-expiry-diag]` + ring buffer |
| `driver-app/js/RideRequestDetail.js` | `syncFromInbox()` | same |
| `driver-app/js/RideRequestDetail.js` | `syncOfferUi()` | same |

**Ring buffer (read-only):** `window.__SWIFTGO_OFFER_EXPIRY_DIAG__` (max 500 entries)

**Fields logged:**

- `ts` — ISO timestamp  
- `source` — `getOfferForRide` \| `syncFromInbox` \| `syncOfferUi`  
- `rideId`  
- `offerId`  
- `inboxOfferExists` — boolean  
- `myOfferStateExists` — boolean  
- `offerStatus`  
- `syncFromInbox` only: `myOfferStateBeforeExists`, `myOfferStateBeforeStatus`  

**No** Firestore writes · **no** UI changes · **no** logic branch changes · **no** CF changes.

**Package 7-A disable blocks (PL-02 / TM-06 / FW-18): untouched.**

---

## Driver URL

https://swiftgo-ride-app.web.app/partner/?v=offer_expiry_diag_1

Hard-refresh required.

---

## Capture procedure (operator — one complete timeout sequence)

1. Admin: set `settings/dispatch.offerTimeoutSeconds` = **10** (restore after).
2. Customer books; driver online + vehicle linked; open radar **detail** for ride.
3. Driver submits custom bid; keep detail screen open.
4. Wait **past timeout** without accepting (both apps foreground if possible).
5. Open DevTools → Console; filter `offer-expiry-diag`.
6. Export ring buffer:

```javascript
copy(JSON.stringify(window.__SWIFTGO_OFFER_EXPIRY_DIAG__ || [], null, 2))
```

7. Paste export into `docs/specs/OFFER-EXPIRY-DIAGNOSTIC-CAPTURE.json` (or attach to approval message).
8. Note final UI: bid text visible? counter panel? accept-initial visible?

---

## After capture — removal (mandatory)

Remove from both files:

- `logOfferExpiryDiag` helper  
- All `logOfferExpiryDiag(...)` calls  
- Restore cache bust or set post-diag value  
- Rebuild + deploy hosting  
- Tag: `ssot/offer-expiry-diag-removed-YYYYMMDD`  

**Do not implement Step 11 fix in the same deploy as removal unless separately approved.**

---

## Frozen packages

Packages 1, 2, 3, 7-A — disable logic unchanged. Diagnostic adds logging only.

---

**STOP after capture → analysis report → removal.**
