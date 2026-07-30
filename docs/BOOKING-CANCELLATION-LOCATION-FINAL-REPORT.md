# Booking Delivery, Location & Complete Cancellation Contract

**Date:** 2026-07-29  
**Project:** `swiftgo-ride-app`  
**Production changed this turn:** **No**  
**Final verdict:** **CONDITIONAL PASS**

---

## 0. Contract note (Phase 2A vs this task)

| Topic | Phase 2A canonical text | This task (approved) | Resolution |
|-------|-------------------------|----------------------|------------|
| Customer cancel | searching → cancelled | searching + **accepted** + **arrived** (before start) | **Expanded** per this mandate |
| Driver before assign | offers only | decline candidate / withdraw own offer only | Implemented; does **not** terminal booking |
| Driver after assign | not defined | cancel before start → rematch same ride, fresh 3 min, exclude self | **New** (no Phase 2A conflict) |
| Phase 1 global `declined` | old model | not restored | Explicitly avoided |

Started-ride (`in_progress`) Admin/Customer/Driver cancel with financial handling remains a **separate business decision** (`STARTED_RIDE_ADMIN_CANCEL_UNDEFINED`).

---

## 1. Account A root cause

**Live UID forensics:** not run (no UID; no privileged Production reads).

**Class-of-bug (proven + Production parity):**

1. Working-tree cancel/expiry/slot reconcile fixes are **not fully deployed**.
2. Live Customer Hosting is still `booking_false_success_fix_1` (older than `booking_cancel_contract_1`).
3. Ghost searching rides and/or inflated slots + opaque cancel UX explain “four active / not visible / cancel fails”.

**Emulator:** slots=4 live=0 → allowed; four searching → cancellable; slots released; new booking allowed (ghost suite).

---

## 2. Account B booking result

**Live create capture:** blocked (no UID).

**Emulator:** trusted create → ride ID + `expiresAt` → match → `invited` candidate → listener contract PASS (ghost `B01`–`B03`).

---

## 3. Driver location and distance category

**Live Driver:** unknown (no session / no privileged vehicle read).

**Deployed Driver Hosting:** still lacks map-independent GPS sync (`console_stability_1`).

**Working tree:** location sync without map + availability strip present.

**Distance:** emulator rings 0.5 / 1.5 / 2.5 receive; >3 km never. Live distance category: **unknown / possibly not server-visible**.

---

## 4. First failed booking-to-Driver step (live)

Most likely **step 4–5** (eligible Driver / candidate creation): deployed Driver location may never reach Firestore when map is unmounted; and/or Driver beyond 3 km / stale / offline.

Not weakened radius to force a pass.

---

## 5. Automatic three-minute expiry proof

| Check | Result |
|-------|--------|
| `expiresAt = now + 3m` on create | Emulator PASS |
| Before 3m → `NOT_YET_EXPIRED` | PASS |
| After 3m → `expired` once | PASS |
| Slot release + candidate/offer close | PASS |
| Assigned not expired; assign vs expire one winner | PASS (ghost suite) |
| No settlement/ledger on expiry | PASS |
| Production trigger live? | **No** — `expireDueSearchingBookings` not deployed; `expiresAt` index not READY; Scheduler not enabled |
| Browser timer authority? | **No** — calls trusted `expireSearchingBooking` |

---

## 6. Customer cancellation proof

| Case | Result |
|------|--------|
| Own searching | PASS (`cancelledCount: 1`) |
| Own accepted | PASS; assignee `activeRideId` cleared |
| Other Customer | `NOT_YOUR_BOOKING` |
| Repeat | idempotent |
| After `in_progress` | `NOT_CANCELLABLE` |
| Candidates/offers closed | via `closeCandidatesAndOffersForRide` |
| Direct Firestore cancel | not used (callable only) |

---

## 7. Driver decline / withdraw / cancellation proof

| Case | Result |
|------|--------|
| Decline candidate only | booking stays `searching_driver`; candidate `declined` |
| Withdraw own offer | offer `withdrawn`; booking not terminal |
| Unassigned cancel ride | denied |
| Assigned cancel before start | rematch same ride; fresh `expiresAt`; excluding cancelling Driver |
| Same booking / no extra slot | PASS |
| After start | denied |

Client: radar decline/withdraw buttons; active-ride cancel before start.

---

## 8. Super Admin cancellation proof

| Case | Result |
|------|--------|
| Cancel with reason + `admin_audit` | PASS |
| Repeat | already safe |
| Empty reason | `REASON_REQUIRED` |
| `in_progress` | `STARTED_RIDE_ADMIN_CANCEL_UNDEFINED` |
| Callable | `cancelRideByAdmin` requires claim admin |

Ordinary user denied at callable gate (`ADMIN_ONLY`).

---

## 9. Source-versus-Production comparison

| Component | Current source | Deployed Production | Same? |
|-----------|----------------|---------------------|-------|
| Customer Hosting bust | `booking_cancel_contract_1` | `booking_false_success_fix_1` | **No** |
| Driver Hosting bust | `booking_cancel_contract_1` | `console_stability_1` | **No** |
| Map-independent GPS | Yes | No | **No** |
| Cancel-all counts / `expiresAt` / candidate close | Yes | Partial / older Functions | **No** |
| `expireDueSearchingBookings` | Yes | **Missing** | **No** |
| New callables: decline/withdraw/driver-cancel/admin-cancel | Yes | **Missing** | **No** |
| `expiresAt` index | Declared | **Not in Production dump** | **No** |
| False-success toast guard | Yes | Yes | Yes |
| Project / region | `swiftgo-ride-app` / `us-central1` | Same | Yes |

---

## 10. Exact files changed (this turn)

| File | Change |
|------|--------|
| `functions/ride-cancellation.js` | **New** — decline, withdraw, driver rematch cancel, admin cancel |
| `functions/bargaining.js` | Customer cancel accepted/arrived; rematch exclude; probe exclude |
| `functions/matching.js` | Expanded `CANCELLABLE_*`; `DRIVER_PRE_START_*`; exclude in select |
| `functions/index.js` | New callables wired |
| `customer-app/js/ride-status.js` | Cancellable + terminal status lists |
| `customer-app/js/ride-flow.js` | Cancel allowed through arrived |
| `customer-app/index.html` | Cache bust |
| `driver-app/js/ride-radar-actions.js` | Client wrappers |
| `driver-app/js/RideRequestDetail.js` | Decline / withdraw |
| `driver-app/js/driver-app.js` | Assigned cancel → rematch |
| `driver-app/index.html` | Cancel button + bust |
| `tests/booking-cancellation-contract-suite.mjs` | **New** focused suite |
| `docs/BOOKING-CANCELLATION-LOCATION-FINAL-REPORT.md` | This report |

---

## 11. Test commands and totals

| Command | Totals | Exit |
|---------|--------|------|
| `… booking-cancellation-contract-suite.mjs` | **18 PASS / 0 FAIL** | 0 |
| `… ghost-rides-driver-location-expiry-suite.mjs` | **37 PASS / 0 FAIL** | 0 |
| `… booking-false-success-suite.mjs` | **23 PASS / 0 FAIL** | 0 |
| `… phase2a-bargaining-suite.mjs` | **21 PASS / 0 FAIL** | 0 |
| `npm run test:phase2c` | **114 PASS / 0 FAIL** | 0 |
| `npm run test:phase3b` | **22 PASS / 0 FAIL** | 0 |
| `npm run build:hosting` | OK | 0 |
| `npm run test:phase2e` | Not re-run this turn | — |

---

## 12. Expected billing impact

| Item | Impact |
|------|--------|
| Deploy Functions/Hosting/Indexes | Normal deploy; index build one-time |
| Scheduler every 1 min for `expireDueSearchingBookings` (limit 25) | ~43k invocations/month + bounded reads/writes — **do not enable without approval** |
| Diagnostic UID reads | Tens of docs — negligible |

---

## 13. Minimal deployment list (approval required)

**Order:**

1. **Indexes** — `rides` `status` + `expiresAt` (wait READY)  
2. **Functions** — full working-tree (create/expire/cancel/rematch/admin/decline/withdraw)  
3. **Customer Hosting**  
4. **Driver Hosting**  
5. **Expiry Scheduler** — only with separate billing approval  

**Already live:** false-success Customer toast guard; basic create/gate/match/expireSearching callables (older revision).

**Rollback:** redeploy previous Hosting version + previous Functions revision; leave index in place (harmless).

**Smoke after deploy:**

1. Account A: clear searching → count 0 → create  
2. Account B: create → confirm ride ID + matching fields  
3. Driver online with GPS on non-map view → candidate appears within 3 km  
4. Wait/force expire → `expired`, slot free  
5. Assigned Driver cancel → searching rematch, self not re-invited  

---

## 14. Remaining business decisions

1. Enable Cloud Scheduler for server-side 3-minute guarantee (billing).  
2. Started-ride (`in_progress`) emergency Admin cancel + financial policy.  
3. Privileged Account A/B UID reads for production forensics.  
4. Whether Customer cancel of `arrived` should notify Driver with a mandatory reason UI (callable already accepts reason).

---

## 15. Unrelated work

No pricing, wallet, settlement redesign, Android packaging, legal pages, general map redesign, or Leaflet Tracking Prevention work.

---

## 16. Production not changed

No deploy, no Production document edits, no billing enablement, no Play upload, no manual Account A deletes.

---

## Final verdict

### **CONDITIONAL PASS**

- Cancellation contract (Customer / Driver / Admin) + rematch + expiry proven in emulator.  
- Live Production remains behind; Account A/B live forensics and Driver distance still need deploy + optional UID reads.  
- **STOP** — deploy only after separate approval.
