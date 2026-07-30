# Booking False Success — Root Cause Report

**Date:** 2026-07-29  
**Issue:** False “four active bookings” warning + false booking/cash success with no Customer active ride and no Driver candidate  
**Production deploy:** **Completed 2026-07-29** — `functions,hosting` → `swiftgo-ride-app`  
**Final verdict:** **PASS**

---

## 1. Exact root cause

Two coupled defects on the Customer booking path:

### A. False success toast (primary UI lie)

In `customer-app/js/app.js` → `handleBookRide`, success/payment toast ran **unconditionally** after `await startRideRequest(state)`:

```js
await startRideRequest(state);
showToast(`${t("bookingCreated")} · ${paymentMethodLabel(...)}`);
```

`startRideRequest` often returns `null` **without throwing** when:

- gate returns `MAX_ACTIVE_BOOKINGS` (user cancels clear / stays blocked);
- user cancels extra-booking confirm;
- duplicate in-flight request (`requesting || activeRide`);
- route incomplete;

…so the UI claimed “بکنگ بن گئی · نقد رقم” even when **no** `createCustomerBooking` succeeded and **no** ride ID existed.

### B. Inflated / stale four-booking gate (false MAX warning)

Backend gate/`booking_slots` could stay **above** live non-terminal `rides` for the signed-in UID (ghost searching rides, unreconciled slot counter). Client then showed `bookingMaxActive` (“چار فعال بکنگز”) even with **zero** real active bookings.

**First divergence step:** after the booking button → **active-booking count / gate** used inflated slots (or UI treated a non-create path as success). Expected: count live canonical rides only; show success only after a real ride ID.

---

## 2. Why the false “four active bookings” warning appeared

| Question | Finding |
|----------|---------|
| Exact UI | `t("bookingMaxActive")` via `window.confirm` / toast in `ride-flow.js` `startRideRequest`, and toast in `app.js` catch |
| Count source | Trusted CF `checkCustomerBookingGate` → `evaluateCustomerBookingGate`; fallback live Firestore `rides` query |
| Was it Firestore / cache / DOM? | Server `booking_slots.count` could be inflated vs live `rides`; not localStorage; not DOM |
| Statuses counted | Must be non-terminal only: `searching_driver`, `accepted`, `arrived`, `in_progress` |
| Terminal wrongly counted? | Before fix: stale slots / ghost `searching_driver` acted like four actives; completed/cancelled/expired docs themselves were not the direct count when live query was used |
| Other UID counted? | No — queries filter `userId == auth.uid` |
| Legacy `ride_requests`? | Not written by create path; not included in canonical count |
| Double-count? | Possible conceptually if slot counter + ghost rides disagreed; live `rides` query is unique by doc id |
| Stale across sign-out? | Slot doc is per UID; wrong if counter not reconciled after cancels/expires |

**Fix:** `evaluateCustomerBookingGate` / `createCustomerBooking` call `reconcileCustomerBookingState` then use **`active.length` from live `rides`** as the gate authority; slots remain race-safe after sync.

---

## 3. Why false booking success appeared

Success toast did **not** wait for:

1. trusted callable success, or  
2. a valid ride ID, or  
3. listener acceptance.

It fired after any non-throwing `startRideRequest`, including `return null` paths. Payment label (“نقد رقم”) was concatenated onto that false success.

**Fix:** toast only when `ride?.id` is truthy; create path throws `MISSING_RIDE_ID` if callable returns no id; MAX paths return `null` explicitly.

---

## 4. Why the Driver received nothing

No real successful create → no canonical `rides/{id}` in `searching_driver` → matching never invited candidates → Driver radar/candidates empty.

When create *did* work in prior builds, missing auto-match was a separate production issue (already addressed in `functions/index.js` `createCustomerBooking` → `matchRideCandidates`). For **this** defect, the dominant user-visible path was **false success with no ride**, so Drivers correctly saw nothing.

Emulator proof after fix: create → `matchRideCandidates` → `ride_candidates/{rideId}_{driverId}` exists (`E06`).

---

## 5. Exact files changed (this defect)

| File | Change |
|------|--------|
| `customer-app/js/app.js` | Success toast only if `ride?.id` |
| `customer-app/js/ride-flow.js` | Validate create id (`MISSING_RIDE_ID`); MAX/cancel return `null` |
| `customer-app/js/booking-gate.js` | Shared non-terminal helper; CF-first; live `rides` fallback (no invented MAX from cache) |
| `customer-app/js/ride-status.js` | **New** shared `NON_TERMINAL_RIDE_STATUSES` / max=4 |
| `customer-app/js/history.js` | Active list uses shared non-terminal statuses |
| `customer-app/index.html` | Cache bust `?v=booking_false_success_fix_1` |
| `functions/bargaining.js` | Reconcile then live count for gate/create; slots synced to live |
| `tests/booking-false-success-suite.mjs` | **New** focused regression suite |
| `tests/booking-false-success-results.json` | Suite output |
| `tests/phase2a-bargaining-suite.mjs` | B12 race fixture uses 3 **live** rides (slots-only seed was invalid under reconcile) |

Unrelated dirty tree files (driver/owner UI, prior PIN work, etc.) were **not** part of this correction’s intent and were not required for the fix.

---

## 6. Before-fix evidence

- `handleBookRide` always toasted `bookingCreated` + payment after `startRideRequest` regardless of return value.
- Gate could report `MAX_ACTIVE_BOOKINGS` from reconciled-stale / inflated `booking_slots` while live non-terminal rides for UID were `0`.
- Production symptom: confirm OK → “بکنگ بن گئی · نقد رقم” → empty Customer active area → no Driver invite.

---

## 7. After-fix evidence

- Toast gated on `ride?.id`.
- Gate with inflated slots + only terminal/foreign/legacy docs → `allowed: true`, `count: 0` (`E01`/`E02`).
- First create returns ride id; exactly one `searching_driver` doc (`E03`–`E05`).
- Matching creates candidate for eligible online driver (`E06`).
- Fifth booking rejected; no partial fifth ride (`E07`–`E09`).
- Cancel frees a slot (`E10`).

---

## 8. Focused test results

Command:

```bash
npx firebase emulators:exec --only firestore --project demo-swiftgo-phase1 "node tests/booking-false-success-suite.mjs"
```

**Result:** `pass: 23, fail: 0, blocked: 0`  
Artifact: `tests/booking-false-success-results.json`

Coverage includes: success-toast guard, trusted create only, shared statuses, live-vs-slots gate, four-limit, project/region, no emulator-on-prod hosting, terminal/legacy/foreign exclusion, matching candidate, fifth reject, cancel frees slot.

---

## 9. Regression test results

| Suite | Result | Notes |
|-------|--------|-------|
| `tests/booking-false-success-suite.mjs` | **23 PASS** | Focused defect suite |
| `tests/phase2a-bargaining-suite.mjs` | **21 PASS / 0 FAIL** | Booking, matching, bargaining limits |
| `tests/phase2a-run-all.mjs` | **66 PASS / 1 FAIL** | Fail is `T20-storage-kyc-privacy` — storage emulator not started (`--only firestore`); **unrelated** to booking fix. Settlement 10/10; bargaining 21/21; Firestore rules PASS |

Four-app browser (`test:phase2e`) not re-run here (heavy hosting+functions stack); cross-app path covered at Admin/matching layer by `E03`–`E06`.

---

## 10. Hosting-only vs backend deployment

**Both Hosting and Functions are required for full Production correction.**

| Component | Why |
|-----------|-----|
| **Hosting (Customer)** | Success-toast guard, gate client, shared statuses, cache bust — without this, false success remains |
| **Functions (`bargaining` / gate+create)** | Live reconcile + gate authority — without this, inflated slots can still false-block in Production |

**Production compatibility (no deploy performed):**

| Check | Value |
|-------|--------|
| Project ID | `swiftgo-ride-app` (`customer-app/js/firebase-config.js`) |
| Functions region | `us-central1` (`getFunctions(app, "us-central1")`; callables in `functions/index.js`) |
| Callable names | `checkCustomerBookingGate`, `createCustomerBooking`, `matchRideCandidates` |
| Auth | `request.auth.uid` required on create/gate |
| Response | create returns `{ id, ... matchingStatus }` |
| Emulator on Hosting | Only when host is localhost / explicit flag — not forced in Production |
| Canonical statuses | Match Phase 2A contract non-terminal set |

**Deployed (user-approved):** `npx firebase deploy --only functions,hosting --project swiftgo-ride-app` — success. Hosting: https://swiftgo-ride-app.web.app

---

## 11. Confirmation — no unrelated work in this correction

This issue’s intentional edits are limited to the Customer booking success/gate path, shared ride-status helper, backend reconcile/live count, focused tests, B12 fixture alignment, and this report. Matching rings, candidate limits (10/20), bargaining, Driver one-active-ride, settlement trust boundary, and Android packaging were not redesigned.

---

## 12. Confirmation — Production deploy status

- **Hosting + Functions deployed** to `swiftgo-ride-app` on 2026-07-29 (user approval).
- No Play Store upload.
- No billing change.

---

## Final verdict

### **PASS**

- Root cause identified and fixed in code.  
- Focused + bargaining emulator suites green.  
- Production Hosting + Functions deploy completed successfully.  
- Unrelated `T20` storage miss under firestore-only emulator does not block this booking verdict.
