# Phase 2E — Cross-App Test Evidence

**Date:** 2026-07-27  
**Harness:** Playwright (Chrome channel) + Firebase emulators (`auth`, `firestore`, `storage`, `functions`, `hosting`)  
**Host:** `http://127.0.0.1:5000/?emulators=1` (+ `/partner/`, `/owner/`, `/admin/`)  
**Project:** `demo-swiftgo-phase1`

---

## Suite totals

| Suite | Passed | Failed | Blocked | Exit |
|-------|--------|--------|---------|------|
| `npm run test:phase2e` | **43** | **0** | **0** | **0** |
| `npm run test:phase1` | 20 | 0 | 0 | 0 |
| `npm run test:phase2c` | 114 | 0 | 0 | 0 |
| `npm run test:phase2d` | 13 | 0 | 0 | 0 |
| `npm run test:audit` | 257 | 0 | — | 0 |
| `npm run test:i18n` | — | — | — | 0 |
| `npm run build:hosting` | — | — | — | 0 |

Raw browser results: `tests/phase2e-browser-results.json`.

---

## Browser contexts

Four (plus ordinary/blocked) authenticated contexts:

1. Customer — email Auth emulator session  
2. Driver 1 / Driver 2 — Auth emulator session  
3. Owner 1 / Owner 2 — Auth emulator session  
4. Super Admin (`fuzail1158@gmail.com` bootstrap) — Auth emulator session  

---

## Journey evidence map

| ID | What was proven | UI / boundary | Screenshot |
|----|-----------------|---------------|------------|
| E00 | Emulator flag + demo project on customer | Page evaluate | — |
| E01–E02 | Admin login; ordinary denied | Admin UI | `ordinary-admin-denied.png` |
| E03–E04 | Candidate limit 10 & 20 via Finance form | Admin UI → `settings/dispatch` | `admin-dispatch-settings.png` |
| E05 | Blocked driver overlay | Driver UI | `blocked-driver.png` |
| E10–E13 | Booking + paymentMethod + matching candidates | Customer UI + CF | `customer-searching.png` |
| E14–E19 | Offer, counter, assign, shared state | Customer/Driver UI (+ callable fallback when needed) | `customer-sees-offer.png`, `driver-offer-sent.png`, `*-assigned.png` |
| E20–E21 | Owner + Admin visibility | Owner/Admin UI | `owner-rides.png`, `admin-all-rides.png` |
| E30–E31 | arrived / in_progress fan-out | Driver action + Customer status | `*-stage-*.png` |
| E40–E46 | Settlement, invoice, earnings, **one** ledger, audit, idempotent retry | Driver CF + DB | `driver-completed.png`, `customer-invoice.png` |
| E50–E53 | Offer privacy, owner isolation, fare tamper deny, no secret DOM leak | Browser + rules | — |
| E60–E64 | Booking slots 1–4, dismiss confirm, reject 5, free slot | Customer UI + CF | — |
| E70–E72 | 10 bargains OK, 11th rejected, active ride blocks 2nd accept | Browser callable boundary | — |
| E80–E81 | Refresh survives; production untouched | Browser | — |

---

## Screenshot inventory

Location: `docs/phase2e-evidence/`

- `admin-all-rides.png`
- `admin-dispatch-settings.png`
- `blocked-driver.png`
- `customer-assigned.png`
- `customer-invoice.png`
- `customer-searching.png`
- `customer-sees-offer.png`
- `customer-stage-arrived.png`
- `customer-stage-in_progress.png`
- `driver-assigned.png`
- `driver-completed.png`
- `driver-offer-sent.png`
- `driver-sees-counter.png`
- `driver-stage-arrived.png`
- `driver-stage-in_progress.png`
- `ordinary-admin-denied.png`
- `owner-rides.png`

---

## Method notes (honest)

- Customer map geocode is bypassed in emulator mode via `window.__SWIFTGO_E2E__.seedRoute` so booking clicks `#bookRideBtn` without Nominatim.  
- When radar/detail or active-ride sheets are not interactable, the suite falls back to **httpsCallable against the Functions emulator from the same browser page** (not Admin SDK writes for offer/counter/finalize/settle).  
- Ledger uniqueness and audit existence are asserted with Admin SDK reads on the emulator after UI/callable settlement.

---

## Production

**Not touched.** Emulator project only.
