# Phase 2D — UI Wiring Fixes

**Date:** 2026-07-27  
**Scope:** Customer / Driver(Partner) / Owner / Super Admin routes verified via `test:audit` + client Function name scan  
**No UI redesign** — restored missing wiring and aligned assertions to current approved layout.

---

## Files changed (why)

| File | Reason |
|------|--------|
| `customer-app/index.html` | Restore `#earnDriverBtn` in sidebar |
| `customer-app/css/styles.css` | Style for earn-driver sidebar control |
| `customer-app/js/data.js` | Persist `paymentMethod` on `createRideRequest` |
| `customer-app/js/ride-flow.js` | Use trusted `createCustomerBooking` / cancel CF clients; pass payment method |
| `customer-app/js/booking-client.js` | **New** — callable wrappers for booking create/cancel |
| `firestore.rules` | Optional `paymentMethod` allowlist on ride create |
| `functions/bargaining.js` | Enforce one-active-ride via ride-status query (callable-safe) |
| `functions/index.js` | Pass `paymentMethod` into booking payload; FieldValue/app init hygiene |
| `functions/settlement.js`, `pin-link.js`, `admin-claims.js` | Modular `FieldValue` for Functions emulator |
| `tools/migrate-vehicle-pins.cjs` | FieldValue from functions package (test + tool compatible) |
| `tests/audit.test.mjs` | Truthful updates for renamed UI + booking CF wiring |
| `tests/phase2d-functions-runtime.mjs` | **New** callable/HTTPS suite |
| `tests/phase2*-*.mjs`, `helpers/settle-once.mjs` | Resolve `firebase-admin` from `functions/` for shared FieldValue |
| `package.json` | Add `test:phase2d` |

---

## Route verification

| Route | Evidence |
|-------|----------|
| Customer | Audit HTML/JS wiring; booking via `booking-client.js`; offers via `offer-client.js`; region `us-central1` |
| Driver / Partner | PIN + settlement + submit/finalize callables; region `us-central1` |
| Owner | Fleet/history audit PASS; PIN/settlement clients region-matched |
| Super Admin | Shell/independence audit PASS; admin claim callables covered in Functions runtime |

---

## Pre / post

| Check | Pre | Post |
|-------|-----|------|
| `npm run test:audit` | 237/20 | **257/0** exit 0 |
| Earn-as-driver entry | Missing DOM id | Present + wired |
| Ride paymentMethod | Not written on live create | Written via CF/client path |
| Booking create path | Direct Firestore in ride-flow | `createCustomerBooking` callable |
