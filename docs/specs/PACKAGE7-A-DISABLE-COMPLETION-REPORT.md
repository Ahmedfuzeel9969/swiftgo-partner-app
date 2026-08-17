# Package 7-A — Disable Completion Report

**Status:** **CLOSED / FROZEN** — see `PACKAGE7-A-CLOSURE-REPORT.md`  
**Date:** 2026-08-07  
**Physical result:** **PASS** (Package 7-A objectives only)  
**Scope:** Disable only (no delete) · **Package 7-B not started** (blocked pending expiry review)

---

## Closure note

Package 7-A acceptance was **structural only**. Remaining automatic offer-expiry behavior is documented separately in **`PACKAGE7-OFFER-EXPIRY-REMAINING-ISSUE-REPORT.md`** — not grounds to modify or reopen 7-A.

---

## What was disabled

| Audit ID | Asset | Disable mechanism | File |
|----------|-------|-------------------|------|
| **PL-02** | Per-doc `onSnapshot(ride_offers/{rideId}_{uid})` | Wrapped in `if (false) { ... }` — code retained | `driver-app/js/RideRequestDetail.js` |
| **TM-06** | `detailExpiryTick` 1s interval | Early `return` in `startDetailExpiryTick()` — code retained | same |
| **FW-18** | Local `myOfferState.status = 'expired'` + `detail_ui` expire CF | Early `return` → `syncOfferUi()` only in `applyOfferExpiryUi()` — code retained | same |

**Not modified:** Cloud Functions, customer-app, owner-app, `driver-offer-inbox.js`, Package 8, Packages 4–6.

---

## Files changed

| File | Change |
|------|--------|
| `driver-app/js/RideRequestDetail.js` | Disable PL-02, TM-06, FW-18 only |
| `driver-app/index.html` | Cache bust `?v=package7a_ssot_step1_disable` |

---

## Build & deploy

| Step | Result |
|------|--------|
| `npm run test:hosting-startup-health` | **35/35 PASS** |
| `firebase deploy --only hosting` | **PASS** (predeploy health 35/35) |
| Live URL | https://swiftgo-ride-app.web.app/partner/?v=package7a_ssot_step1_disable |

---

## Live bundle verification (automated proxy)

| Check | Result |
|-------|--------|
| Live `RideRequestDetail.js` contains `PACKAGE 7-A DISABLED (PL-02)` | **PASS** |
| Live contains `PACKAGE 7-A DISABLED (TM-06)` | **PASS** |
| Live contains `PACKAGE 7-A DISABLED (FW-18)` | **PASS** |
| Active code path invokes `detail_ui` expire source | **Not in reachable path** (dead code after FW-18 early return) |

---

## Authoritative offer path after 7-A disable

```
driver-offer-inbox.js (PL-01 + TM-04/05/07)
  → getOfferForRide(rideId)
  → onOffersChanged → driver-app.js → syncDetailFromInbox()
RideRequestDetail.js
  → syncFromInbox() / show() seed from inbox
  → NO PL-02 listener
  → NO TM-06 tick
  → NO FW-18 local expire mutation
```

---

## Physical test checklist (operator)

Hard-refresh driver app:

`https://swiftgo-ride-app.web.app/partner/?v=package7a_ssot_step1_disable`

### Package 7-A objectives (acceptance scope) — PASS

| # | Test | Expected | Result |
|---|------|----------|--------|
| A1 | Driver opens radar detail; submits bid | Detail + inbox aligned via inbox path | **PASS** |
| A2 | Customer counters | Detail counter panel | **PASS** |
| A3 | Console: no active `detail_ui` expire source | Inbox-only expire scheduling on driver | **PASS** |
| A4 | Accept initial fare / bid→accept assign paths | Assign succeeds | **PASS** |
| A5 | Detail ↔ list ↔ reopen | UI matches inbox | **PASS** |

### Out of scope for 7-A close (separate expiry track)

Items P5–P8 (full wall-clock auto-expire business validation) are **not** 7-A gating criteria. See `PACKAGE7-OFFER-EXPIRY-REMAINING-ISSUE-REPORT.md`.

**7-B gate:** Expiry issue reviewed separately **and** explicit 7-B approval — not automatic after 7-A.

---

## Rollback (if physical FAIL)

```powershell
git checkout ssot/package3-complete-20260807 -- driver-app/js/RideRequestDetail.js driver-app/index.html
npm run build:hosting
firebase deploy --only hosting
```

Or Firebase Hosting console rollback to pre–7-A release.

---

## Stop

**Package 7-A CLOSED / FROZEN.**  
**Package 7-B not started** — blocked until expiry issue reviewed (`PACKAGE7-OFFER-EXPIRY-REMAINING-ISSUE-REPORT.md`).
