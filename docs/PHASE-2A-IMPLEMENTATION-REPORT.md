# Phase 2A — Implementation Report (Bargaining + Settlement Expansion)

**Date:** 2026-07-27  
**Verdict: CONDITIONAL PASS**  
**Production Firebase:** Not touched. No deploy. No production writes.

---

## 1. Exact four P0 findings — final status

| ID | Finding | Final status |
|----|---------|--------------|
| **P1-001** | Client can write `partners.walletBalance` / earnings | **CLOSED** — partner self-update allowlist; settlement only via Admin SDK |
| **P1-002** | Customer can complete accepted ride | **CLOSED** — rules deny; client throws `SETTLEMENT_SERVER_ONLY` |
| **P1-003** | Client `completeRideWithEarnings` batch settlement | **CLOSED** — clients call `completeRideSettlement`; no `walletBalance: increment` on driver/owner |
| **P1-004** | Hardcoded Super Admin email | **PARTIAL** — prefer `admin` claim + `bootstrapAdminClaim`; email bootstrap still present until claims roll out |

---

## 2. Bargaining and assignment contract

Concepts are separated:

| Concept | Storage / mechanism |
|---------|---------------------|
| Booking | `rides/{id}` status `searching_driver` … `completed` |
| Candidates | `ride_candidates/{rideId}_{driverId}` (matching CF only) |
| Offers | `ride_offers/{rideId}_{driverId}` private; statuses `open\|countered\|accepted\|rejected\|withdrawn\|expired` |
| Final assignment | CF `finalizeAssignmentFromOffer` transaction → `rides.status=accepted` + `partners.activeRideId` |
| Settlement | CF `completeRideSettlement` |

Bargaining does **not** assign the driver. Multiple candidate drivers may hold open offers on one booking. Acceptance is atomic; sibling offers are expired/withdrawn after win.

Canonical doc: `docs/PHASE-2A-CANONICAL-CONTRACT.md`.

---

## 3. Super Admin candidate-limit

- Field: `settings/dispatch.candidateDriverLimit` ∈ `{10, 20}` only.
- Validated by `validateCandidateDriverLimit` in `functions/matching.js`.
- Applied by `matchRideCandidates` with progressive rings **1 → 2 → 3 km**.
- Admin UI: Finance view → dispatch form (`super-admin-panel`).
- CF: `setCandidateDriverLimit` (not deployed this phase).

---

## 4. Customer four-booking limit + confirmation

- Max **4** non-terminal (`searching_driver|accepted|arrived|in_progress`).
- Gate: `checkCustomerBookingGate` / UI confirm before bookings 2–4.
- Urdu confirm copy matches required meaning; History navigation on cancel.
- Atomic create: `createCustomerBooking` + `booking_slots/{uid}` (emulator-proven race-safe).
- Client still uses `createRideRequest` + local/CF gate until Functions are deployed (residual).

---

## 5. Driver ten-bargain + one-active-ride

- ≤ **10** concurrent offers in `open|countered` (`MAX_OPEN_BARGAINS`).
- `partners.activeRideId` set on finalize; blocks further bargain/accept.
- Cleared on trusted settlement.
- Sibling open offers withdrawn after assignment.

---

## 6. Files changed (this expansion)

| File | Reason |
|------|--------|
| `docs/PHASE-2A-CANONICAL-CONTRACT.md` | Bargaining + dispatch contract |
| `docs/PHASE-2A-IMPLEMENTATION-REPORT.md` | This report |
| `docs/PHASE-2A-TEST-EVIDENCE.md` | Commands / totals |
| `docs/PHASE-2A-RESIDUAL-RISKS.md` | Remaining P1/P2 |
| `functions/matching.js` | Candidate limit + progressive rings |
| `functions/bargaining.js` | Gate, match, offers, finalize, slots |
| `functions/settlement.js` | Clear `activeRideId` + release booking slot |
| `functions/index.js` | Callables for gate/create/match/offers/dispatch |
| `firestore.rules` | Deny legacy offer/accept; private offers; candidates; slots |
| `firestore.indexes.json` | Offers/candidates/status composites |
| `customer-app/js/firebase.js` | Functions SDK |
| `customer-app/js/booking-gate.js` | 4-booking gate |
| `customer-app/js/offer-client.js` | Offer CF + watch |
| `customer-app/js/ride-flow.js` | Confirm + offers + match trigger |
| `customer-app/js/data.js` | Legacy offer writes removed |
| `customer-app/js/i18n.js` | Confirm / max-booking strings |
| `driver-app/js/ride-radar-actions.js` | Offer/finalize via CF |
| `driver-app/js/ride-radar-service.js` | Candidate-only radar feed |
| `driver-app/js/RideRequestDetail.js` | Watch private offer doc |
| `super-admin-panel/index.html` | Dispatch limit UI |
| `super-admin-panel/js/admin-app.js` | Load/save `settings/dispatch` |
| `tests/phase2a-bargaining-suite.mjs` | Matching/bargain/booking tests |
| `tests/phase2a-run-all.mjs` | Merge bargaining suite |
| `tests/phase1-emulator-contract.mjs` | Candidate-read + client-accept deny |
| `tests/phase2a-emulator-suite.mjs` | Same regression updates |

---

## 7–15. Evidence summary

See `docs/PHASE-2A-TEST-EVIDENCE.md` for full command/exit/totals and key case results.

**Production confirmation:** Emulators used `demo-swiftgo-phase1` only. No `firebase deploy`. No production project writes.

**STOP:** Awaiting approval before any later phase.
