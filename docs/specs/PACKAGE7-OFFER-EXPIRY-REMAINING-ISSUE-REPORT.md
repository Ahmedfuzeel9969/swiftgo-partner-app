# Remaining Automatic Offer-Expiry Issue — Separate Report

**Date:** 2026-08-07  
**Context:** Observed during Package 7-A physical testing  
**Relationship to Package 7-A:** **NOT part of 7-A acceptance** — do not modify 7-A for this issue  
**Relationship to Package 7-B:** **7-B blocked** until this issue is reviewed and disposition decided separately  

**Code changes in this document:** None (investigation / planning only)

---

## Executive summary

Package 7-A **passed its structural objectives** (disable duplicate detail offer pipeline). Physical testing also surfaced **incomplete or inconsistent automatic offer-expiry behavior** — a **business-rule / runtime chain** problem, not a failure of PL-02 / TM-06 / FW-18 disable.

This report isolates that remaining issue so it is **not conflated** with Package 7 structural cleanup or used to reopen 7-A.

---

## 1. Issue classification

| Dimension | Package 7-A (CLOSED) | This issue (OPEN — separate track) |
|-----------|----------------------|-------------------------------------|
| **Type** | Structural SSOT — one offer pipeline on driver detail | Business rule — offer must auto-expire at `offerExpiresAt` |
| **Audit IDs** | PL-02, TM-06, FW-18 | CF-03 chain, TM-04/05, TM-01/02, SD-01, CO-12 |
| **Acceptance** | Disable verified; inbox-only detail | Wall-clock timeout → server `expired` → UI hides on both apps |
| **Fix location** | `RideRequestDetail.js` disable (done) | Likely inbox, customer `offer-client`, CF, or ops config — **not 7-A rollback** |

---

## 2. Expected automatic expiry chain (reference)

```
offerExpiresAt reached (wall clock)
  → Client timer (driver inbox TM-04/05 OR customer offer-client TM-01/02)
  → CF expireRideOffer (CF-03)
  → Firestore ride_offers.status = expired (FW-12)
  → onSnapshot refresh OR client filter hides offer
  → Driver inbox + detail (via syncFromInbox) + customer panel update
```

**Parallel reinforcement (not primary clock):** piggyback expire on match/reconcile, inline guards on counter/reject/assign, admin batch (`expireDueRideOffers`).

**Design intent (P1-B):** Client-assisted expiry while app is in use; **no Cloud Scheduler** unless separately approved (`phase1-phase2-P1B-AUTO-EXPIRE-DESIGN.md`).

---

## 3. What Package 7-A changed vs expiry

| Before 7-A | After 7-A | Expiry impact |
|------------|-----------|---------------|
| Detail had PL-02 listener + TM-06 tick + FW-18 local expire + `detail_ui` CF calls | Detail reads inbox only; **inbox remains sole driver expire scheduler** | Removed **duplicate** expire invokes from detail; expiry now **depends entirely on inbox (+ customer client)** |
| Two driver expire loops could race | One driver expire loop (inbox) | Should reduce duplicate CF calls; if expiry fails, **inbox is now single point of failure on driver side** |

**Important:** Disabling FW-18 / `detail_ui` was **intentional**. Any expiry gap after 7-A is **not fixed by re-enabling 7-A disabled code** — that would violate frozen 7-A.

---

## 4. Observed gap (operator report)

During 7-A physical testing:

- **Package 7-A structural checks:** PASS (inbox/detail alignment, assign paths, no active duplicate pipeline).
- **Automatic offer-expiry behavior:** **Incomplete or inconsistent** — reported separately from 7-A objectives.

This report treats the expiry observation as **OPEN** pending structured review. Exact failing sub-step (timer, CF invoke, Firestore write, or UI filter) should be recorded in the review section below when operator fills evidence.

---

## 5. Hypothesis tree (for separate review — not 7-A)

Review each link **independently** of Package 7 structural work.

### H1 — Client timer never fires

| Check | Driver | Customer |
|-------|--------|----------|
| Module | `driver-offer-inbox.js` | `offer-client.js` |
| Symptoms | No `expireRideOffer_call` in console | Same on customer |
| Causes | Background tab throttling; missing `offerExpiresAt` / fallback fields; inbox not started (driver offline path) | Same |
| Prior art | P1-B Fix #1 added 1s tick + visibility flush | Same |

### H2 — CF invoke fails or never reached

| Check | Evidence |
|-------|----------|
| Console | `[SwiftGo] expireRideOffer_fail` |
| Cloud Logging | Missing `expireRideOffer_invoke` / `expireRideOffer_result` |
| Causes | Functions auth, wrong project, stale hosting bundle without Fix #1 |

### H3 — Server expires but UI does not update

| Check | Driver | Customer |
|-------|--------|----------|
| Firestore | Doc `status=expired` in console | Same |
| UI | Inbox map filtered; detail via `syncFromInbox` | `emitAlive()` filter |
| Causes | `syncFromInbox` local expire branches still mutate without inbox refresh; query still returns `open` until snapshot | Customer filter vs server lag |

### H4 — Detail-specific stale UI (post-7-A)

| Check | Note |
|-------|------|
| `syncFromInbox()` local branches (L417–427) | **Still active in 7-A** — can set local `expired` without inbox map update; **not part of FW-18 disable** |
| Optimistic `submitBid` | Brief mismatch until inbox snapshot |
| **Not a reason to revert 7-A** | Fix belongs in 7-B or a **dedicated expiry package**, not re-enabling PL-02/TM-06/FW-18 |

### H5 — Configuration / test setup

| Check | Note |
|-------|------|
| `settings/dispatch.offerTimeoutSeconds` | Must be set for test window |
| Admin vs production default | Restore after test |
| Cache bust | Driver `package7a_ssot_step1_disable`; customer may need separate bust |

### H6 — Apps closed / no client clock

| Check | Note |
|-------|------|
| Design limit | No Scheduler — offers may stay `open` until piggyback/admin if **no client running** |
| Out of scope unless Scheduler approved | Document as known limitation vs bug |

---

## 6. Known codebase areas (not Package 7-A)

| Area | File | Relevance |
|------|------|-----------|
| Driver expire scheduler | `driver-offer-inbox.js` | TM-04, TM-05, TM-07; `requestExpireRideOffer` |
| Customer expire scheduler | `customer-app/js/offer-client.js` | TM-01, TM-02, TM-03 |
| Server authority | `functions/bargaining.js` | `expireRideOffer`, `markOfferTimedOutInTx`, `isOfferPastTimeout` |
| Detail sync (not disabled in 7-A) | `RideRequestDetail.js` `syncFromInbox` | Local expire branches — may affect UI without fixing server |
| Future consolidation | M5 `expireOfferIfPastDue` | Not started |

---

## 7. Recommended review process (separate from 7-B)

**Do not start Package 7-B until this review completes and disposition is approved.**

| Step | Action | Owner |
|------|--------|-------|
| R1 | Capture one failing run: rideId, offerId, `offerExpiresAt`, timeout setting | Operator |
| R2 | DevTools: driver + customer console for `expireRideOffer_call` / `_ok` / `_fail` | Operator |
| R3 | Firestore: offer doc before/after wall-clock | Operator |
| R4 | `firebase functions:log --only expireRideOffer` for invoke/result | Operator |
| R5 | Classify failing link (H1–H6) | Engineering |
| R6 | **Disposition decision** (see §8) | Product / operator approval |

---

## 8. Disposition options (after review — not pre-approved)

| Option | Description | Touches 7-A? |
|--------|-------------|--------------|
| **A** | Dedicated **Offer Expiry Fix** package (inbox/customer/CF only) | **No** |
| **B** | Proceed with **7-B delete** if expiry gap is classified H6 (design limit) or unrelated to delete | **No** (7-B still needs explicit approval) |
| **C** | **M5** server expiry SSOT consolidation | **No** |
| **D** | Cloud Scheduler for unattended expire (requires explicit approval per design doc) | **No** |
| **Rejected** | Re-enable PL-02 / TM-06 / FW-18 in 7-A | **Violates frozen 7-A** |

---

## 9. Separation rules (mandatory)

1. **Package 7-A remains CLOSED/FROZEN** regardless of expiry review outcome.  
2. **Do not block 7-A closure** on full P1-B expiry checklist.  
3. **Do not start 7-B** until expiry review disposition is recorded and 7-B explicitly approved.  
4. **Do not mix** structural delete (7-B) with expiry business fixes in one deploy unless separately approved as combined package.

---

## 10. Evidence template (operator — for review session)

```
Date:
Driver URL: https://swiftgo-ride-app.web.app/partner/?v=package7a_ssot_step1_disable
Customer URL:
offerTimeoutSeconds (admin):
rideId:
offerId:
offerExpiresAt (Firestore):
Wall-clock when past due:
Driver console expireRideOffer_call: yes/no (source: ___)
Customer console expireRideOffer_call: yes/no
CF expireRideOffer_invoke in logs: yes/no
Firestore status after wait: open / expired
Driver UI: inbox badge / detail panels
Customer UI: offer panel visible/hidden
Package 7-A structural checks: PASS/FAIL (separate from expiry)
```

---

## 11. References

- `docs/specs/PACKAGE7-A-CLOSURE-REPORT.md` — 7-A closed objectives  
- `docs/specs/phase1-phase2-P1B-THREE-FIX-REPORT.md` — prior expiry fix wave  
- `docs/specs/phase1-phase2-P1B-PHYSICAL-FAIL-RCA.md` — original chain-break RCA  
- `docs/specs/PACKAGE7-IMPLEMENTATION-PLAN.md` — 7-B delete plan (gated)  
- `docs/specs/RIDE-ASSIGNMENT-SINGLE-SOURCE-OF-TRUTH.md` — M5 expiry SSOT target  

---

**End of separate expiry issue report. No code modified. Package 7-B not started.**
