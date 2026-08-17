# Package 7 — Driver Offer SSOT (Detail → Inbox Merge)

**Implementation plan only — no code changes in this document**

**Date:** 2026-08-07  
**SSOT phase:** M2  
**Priority:** Production reliability (over code cleanup)  
**Frozen (do not modify):** Packages 1–3  
**Explicitly not in scope:** Packages 4, 5, 6, 8–16, P2-C, Cloud Functions deploy, customer-app changes

---

## Executive summary

Package 7 removes the **second driver offer listener** and **local offer status mutation** on the ride detail screen. After migration, **one module** (`driver-offer-inbox.js`) owns driver offer truth; `RideRequestDetail.js` becomes a **read-only consumer** via `getOfferForRide()` + `syncFromInbox()`.

This addresses **residual P1-B physical symptoms** (detail/inbox desync, accept-initial panel confusion) that were **mitigated** by Fix #2 workarounds but not structurally resolved.

---

## 1. Exact files involved

### Primary (must change)

| File | Role today | Change in Package 7 |
|------|------------|---------------------|
| `driver-app/js/RideRequestDetail.js` | Detail UI; **duplicate** offer listener (PL-02); local expire tick (TM-06); `applyOfferExpiryUi` local mutation (FW-18/CD-04) | Remove offer listener + detail tick + local expire; UI reads inbox only |
| `driver-app/js/driver-offer-inbox.js` | L1 offer SSOT — query listener, timers, `getOfferForRide`, expire CF invokes | Minor: ensure API sufficient for detail (may expose read-only snapshot helpers; **no second listener**) |

### Secondary (wiring / coordination — likely small or zero diff)

| File | Role today | Expected change |
|------|------------|-----------------|
| `driver-app/js/ride-radar-controller.js` | Passes `getOfferForRide` to detail; exposes `syncDetailFromInbox()` | Verify detail receives inbox updates on every offer change; optional explicit `onOfferForRideChanged(rideId)` callback |
| `driver-app/js/driver-app.js` | Creates inbox; `onOffersChanged` → `refreshList` + `syncDetailFromInbox` | Confirm callback fires on **all** inbox mutations (already wired at L4681–4684) |

### Unchanged (in scope boundary — do not modify)

| File | Why untouched |
|------|---------------|
| `driver-app/js/ride-radar-actions.js` | CF wrappers (assign, bid, withdraw) — already server-authoritative |
| `driver-app/js/AvailableRidesList.js` | Package 8 (radar subscription merge) — separate package |
| `driver-app/js/ride-radar-service.js` | Candidate feed — not offer state |
| `customer-app/js/offer-client.js` | Customer L2 listener — separate app; mismatch explained below |
| `customer-app/js/ride-flow.js` | Customer offer panel — unchanged |
| `functions/bargaining.js` | Server guards already fixed (P1-B Fix #3); no CF deploy in Package 7 |
| `driver-app/index.html` | Detail DOM structure unchanged |

### Deploy artifact

| Path | Note |
|------|------|
| `hosting-dist/partner/js/RideRequestDetail.js` | Rebuilt via `npm run build:hosting` |
| `hosting-dist/partner/js/driver-offer-inbox.js` | If inbox API extended |

**Deploy type:** Hosting only (driver/partner bundle). **No Functions deploy.**

---

## 2. Exact listeners involved

### Remove (Package 7)

| Audit ID | File | Listener | Firestore path | Purpose today |
|----------|------|----------|----------------|---------------|
| **PL-02** | `RideRequestDetail.js` L401–408 | `offerUnsub = onSnapshot(doc(db, "ride_offers", \`${ride.id}_${driver.uid}\`))` | `ride_offers/{rideId}_{driverId}` per-doc | Detail-local offer state (`myOfferState`) |

**Code to delete (conceptual):** `offerUnsub` setup in `startRideWatch()`, teardown in `stopRideWatch()`, and any logic that treats this snapshot as authoritative over inbox.

### Keep (unchanged in Package 7)

| Audit ID | File | Listener | Firestore path | Purpose |
|----------|------|----------|----------------|---------|
| **PL-01** | `driver-offer-inbox.js` L193–233 | `onSnapshot(query(ride_offers where driverId==uid, status in open/countered))` | Collection query | **Single driver offer SSOT** |
| **PL-03** | `RideRequestDetail.js` L385–398 | `onSnapshot(doc(db, rides|ride_requests, ride.id))` | `rides/{id}` or archive | Ride status, assign detection — **not offer negotiation** |
| PL-04 | `driver-app.js` / `ride-radar-service.js` | `subscribePendingRadarRides` | `ride_candidates` → `rides` | Radar list — Package 8 |
| PL-12 | `driver-app.js` | `startActiveRideWatch` | `rides/{id}` | Post-assign execution |
| PL-13 | `driver-app.js` | `settings/dispatch` | Settings doc | `offerTimeoutSeconds` |
| PL-06 | `customer-app/js/offer-client.js` | `watchRideOffers` query | `ride_offers` by rideId + customerId | Customer L2 — separate concern |

### After Package 7 — driver assignment listeners (offer concern)

```
Driver online + detail open:
  PL-01  inbox query     →  authoritative offer map
  PL-03  ride doc        →  ride.status only (searching_driver → accepted)
  (no PL-02)
```

---

## 3. Exact timers involved

### Remove (Package 7)

| Audit ID | File | Timer | Interval / trigger | Purpose today |
|----------|------|-------|-------------------|---------------|
| **TM-06** | `RideRequestDetail.js` L341–346 | `detailExpiryTick = setInterval(..., 1000)` | 1s | Calls `applyOfferExpiryUi` — duplicate of inbox tick |

**Also remove:** `startDetailExpiryTick()`, `stopDetailExpiryTick()` and call from `startRideWatch()` / `stopRideWatch()`.

### Keep (unchanged — inbox owns expiry scheduling)

| Audit ID | File | Timer | Purpose |
|----------|------|-------|---------|
| TM-04 | `driver-offer-inbox.js` | Per-offer `setTimeout` until `offerExpiresAt` | Wake → `requestExpireRideOffer` (`inbox_timer`) |
| TM-05 | `driver-offer-inbox.js` | `setInterval(flushExpired, 1000)` | `inbox_tick` — mobile throttle recovery |
| TM-07 | `driver-offer-inbox.js` | `visibilitychange` → `flushExpired` | Tab resume |

### Customer (context only — not modified)

| ID | File | Timers |
|----|------|--------|
| TM-01–TM-03 | `offer-client.js` | Per-offer timeout, 1s tick, visibility |

**After Package 7:** Driver has **one** expiry loop for offers (inbox TM-04/TM-05/TM-07). Detail has **zero** offer timers.

---

## 4. Exact Firestore writes

Package 7 is primarily about **reads and local state**. Firestore **writes** impact:

### Removed behavior (not Firestore — local only)

| Audit ID | File | "Write" | Type |
|----------|------|---------|------|
| **FW-18** | `RideRequestDetail.js` `applyOfferExpiryUi` | `myOfferState = { ...myOfferState, status: "expired" }` | **In-memory only** — violates SSOT; pretends terminal state without server doc |

### Unchanged CF invokes (stay on inbox path)

| Callable | Trigger after P7 | Who invokes |
|----------|------------------|-------------|
| `expireRideOffer` | Offer past `offerExpiresAt` | **Inbox only** (`inbox_timer`, `inbox_tick`, `inbox_snapshot`, `inbox_visible`) |
| `submitRideOffer` | Driver bid | `RideRequestDetail.submitBid` → `ride-radar-actions.js` |
| `finalizeAssignmentFromOffer` | Accept counter | Detail accept handlers |
| `acceptCustomerInitialFare` | Accept initial fare | Detail accept handler |

### Detail must NOT invoke after migration

| Removed from detail | Reason |
|---------------------|--------|
| `requestExpireRideOffer(..., { source: "detail_ui" })` inside `applyOfferExpiryUi` | Duplicate expire trigger; inbox already schedules expire |

### Unchanged client Firestore writes (out of Package 7 scope)

| Write | File | Note |
|-------|------|------|
| None for offer status | — | Rules deny client offer writes |
| `rides.status` arrived/in_progress | `driver-app.js` | Post-assign — unchanged |

**Net Firestore effect:** Fewer duplicate `expireRideOffer` CF calls from detail; **single client-side expire scheduler** (inbox). Server remains authoritative for `ride_offers.status = expired`.

---

## 5. Exact UI synchronization problem

### Surfaces affected (driver app)

| DOM / state | Controlled by | Function |
|-------------|---------------|----------|
| `#offerStatus` / offer status text | `syncOfferUi` | Bid sent / counter received messages |
| Counter panel + accept counter button | `syncOfferUi` | `counterPanel`, `acceptCounterBtn` |
| Accept-initial panel (`customerOfferPanel`) | `syncOfferUi` | `showAcceptInitial` + `driverOfferRecordExists` |
| Bid buttons / custom fare | `renderBids`, `submitBid` | Optimistic update on bid |
| Radar list badges | `driver-app.js` + inbox | `onOffersChanged` → `refreshList` |

### The bug pattern

Two independent pipelines update **`myOfferState`** in detail:

```
Pipeline A (inbox):  PL-01 snapshot → offersByRideId → getOfferForRide() → syncFromInbox()
Pipeline B (detail): PL-02 snapshot → myOfferState = snap.data() → applyOfferExpiryUi()
                     TM-06 tick      → local status = 'expired' → syncOfferUi()
```

**Pipeline B can override or diverge from Pipeline A** because:

1. PL-02 sees Firestore doc still `open` while inbox has already **filtered** the offer from its map (past local expiry clock).
2. `applyOfferExpiryUi` sets local `expired` but **`driverOfferRecordExists` remains true** (offer object non-null), hiding accept-initial incorrectly or showing stale counter UI.
3. `syncFromInbox()` exists but runs **after** PL-02 may have already mutated `myOfferState` on the same tick.
4. Optimistic `submitBid` sets `myOfferState` before inbox snapshot confirms — PL-02 can overwrite with stale empty doc.

### P1-B Fix #2 status

Fix #2 **added** `applyOfferExpiryUi` + `detailExpiryTick` as a **workaround** for inbox/detail desync. Package 7 **removes** that workaround by eliminating the duplicate pipeline.

---

## 6. Why Driver Inbox and Driver Detail become inconsistent

| # | Mechanism | Inbox behavior | Detail behavior | Result |
|---|-----------|----------------|-----------------|--------|
| 1 | **Dual listeners** | Query: all open/countered for driver | Doc: single `ride_offers/{rideId}_{uid}` | Different snapshot timing |
| 2 | **Local expiry filter** | `publishFiltered()` **drops** past-due offers from map | PL-02 still receives Firestore doc until CF marks `expired` | Inbox hides offer; detail still shows open |
| 3 | **Inverse: local expire mutation** | Offer removed from map | `applyOfferExpiryUi` sets local `expired` but keeps object | Detail shows expired UI; inbox badge gone; `driverOfferRecordExists` blocks accept-initial |
| 4 | **Dual 1s ticks** | `inbox_tick` flush | `detailExpiryTick` | Expire CF invoked twice; UI updates at different seconds |
| 5 | **syncFromInbox partial logic** | Clears when `!cached && isOfferPastExpiryLocal` | PL-02 re-populates from Firestore on next snapshot | Flicker / wrong panel |
| 6 | **Optimistic bid** | Waits for PL-01 snapshot | `submitBid` sets local open offer immediately | Brief mismatch until inbox catches up |

**Root cause:** Detail maintains a **second copy** of offer state instead of rendering inbox truth.

---

## 7. Why Customer and Driver sometimes see different offer states

Customer and driver apps are **supposed** to use separate listeners (different queries, different UX). Mismatch becomes **user-visible** when clocks and filters diverge:

| Factor | Customer (`offer-client.js`) | Driver (today) | Mismatch symptom |
|--------|------------------------------|----------------|------------------|
| **Listener scope** | `rideId` + `customerId` — all drivers' offers for ride | Inbox: by `driverId`; Detail: single offer doc | Customer may see offer sheet while driver detail shows accept-initial |
| **Expiry filter** | `emitAlive()` hides past-due locally | Inbox filters map; detail may still show PL-02 snapshot | Customer panel hides; driver detail still shows "bid sent" |
| **Expire invoke** | `expireRideOfferClient` from customer timers | Inbox + **detail** both invoke | Server eventually consistent; UI diverges for 1–N seconds |
| **Local terminal mutation** | Customer does **not** mutate status to expired locally | Detail **does** (FW-18) | Driver UI shows expired; customer still sees open until snapshot |
| **Accept-initial path** | Customer always in searching UI | Driver detail `showAcceptInitial` gated by `driverOfferRecordExists` | Driver sees accept-initial after own bid expired locally |
| **Counter display** | `updateDriverOfferUi` from customer query | Detail `syncOfferUi` from `myOfferState` | Counter fare visible on one side first |

**Package 7 scope:** Fixes **driver-internal** duplication (inbox vs detail). Customer/driver cross-app alignment improves because driver detail no longer invents local `expired` state or holds stale PL-02 snapshots — driver UI tracks the same filtered truth as inbox, which aligns better with server-driven snapshots customer eventually receives.

**Not in Package 7:** Shared `offer-expiry.mjs` (M7) or customer changes.

---

## 8. Proposed Single Source of Truth

### Driver offer state — target architecture

```
┌─────────────────────────────────────────────────────────┐
│  driver-offer-inbox.js  (ONLY offer authority)          │
│  • PL-01 onSnapshot query                               │
│  • TM-04/TM-05/TM-07 expiry schedule + flush            │
│  • offersByRideId: Map<rideId, offer>                   │
│  • getOfferForRide(rideId) → offer | null               │
│  • onOffersChanged(map) → subscribers                   │
│  • requestExpireRideOffer → CF expireRideOffer          │
└───────────────────────────┬─────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
   driver-app.js    AvailableRidesList   RideRequestDetail
   refreshList      (badges via inbox)   syncFromInbox()
                                         syncOfferUi(inboxOffer)
                                         NO PL-02, NO TM-06
                                         NO local status mutation
```

### Detail screen rules (post-P7)

| Rule | Implementation |
|------|----------------|
| **Read** offer only via `getOfferForRide(currentRide.id)` | On show, on `syncFromInbox`, on inbox `onOffersChanged` |
| **Never** subscribe to `ride_offers/{rideId}_{uid}` in detail | Delete PL-02 |
| **Never** set `myOfferState.status = 'expired'` locally | Delete `applyOfferExpiryUi` mutation; delete FW-18 |
| **Expire** only via inbox timers → CF | Remove detail `requestExpireRideOffer` calls |
| **Optimistic bid** | Allowed briefly: after `submitBid`, set display from result **or** wait for inbox snapshot; reconcile on next `syncFromInbox` |
| **Accept buttons** | Disable/hide based on **inbox offer** + `isOfferPastExpiryLocal(inboxOffer)` + server error codes (`OFFER_EXPIRED`, `OFFER_NEGOTIATION_ACTIVE`) |
| **Accept-initial panel** | Show when: `ride.status === searching_driver` AND inbox returns **null** for ride AND no in-flight optimistic bid |
| **Ride status** | Still from PL-03 ride listener only |

### SSOT principle restored

> Clients **schedule** and **display**; they **never decide** terminal offer status. Terminal `expired` comes from Firestore snapshot (via inbox query refresh after CF) or from inbox removing offer from alive map after local clock + CF invoke.

---

## 9. Migration plan

Follow the same **controlled package process** as Packages 1–3. One business flow: **driver offer display on detail screen**.

### Phase 0 — Pre-approval verification (no deploy)

| Step | Action | Pass criteria |
|------|--------|---------------|
| 0.1 | Tag baseline | `ssot/package7-baseline-YYYYMMDD` from `ssot/package3-complete-20260807` |
| 0.2 | Document live SHA | Record hosted `RideRequestDetail.js` + `driver-offer-inbox.js` hashes |
| 0.3 | Grep proof | Confirm PL-02 only in `RideRequestDetail.js`; `syncFromInbox` wired from `driver-app.js` L4683 |
| 0.4 | Write Package 7 verification report | 7-field pre-approval report (scope, callers, risk, rollback, physical tests) |

### Phase 1 — Disable duplicate path (deploy, physical test)

| Step | Action | File(s) |
|------|--------|---------|
| 1.1 | **Disable PL-02:** comment out `offerUnsub = onSnapshot(...)`; rely on `syncFromInbox` only | `RideRequestDetail.js` |
| 1.2 | **Disable TM-06:** stop calling `startDetailExpiryTick` | same |
| 1.3 | **Disable FW-18:** make `applyOfferExpiryUi` delegate to `syncOfferUi` only (no local mutation, no detail expire call) | same |
| 1.4 | Ensure `show()` calls `syncFromInbox()` after `startRideWatch()` | same |
| 1.5 | Optional: inbox exposes `getRawOfferForRide` if detail needs pre-filter doc (prefer not — use filtered map only) | `driver-offer-inbox.js` |

| Step | Action |
|------|--------|
| 1.6 | `npm run build:hosting` |
| 1.7 | `npm run test:hosting-startup-health` — must PASS |
| 1.8 | Deploy hosting only with cache bust `?v=package7_ssot_step1_disable` |
| 1.9 | **Physical test** (see §11 checklist) on disable build |

**Stop gate:** Physical PASS on disable build before delete phase.

### Phase 2 — Delete dead code (deploy, physical test)

| Step | Action | Remove |
|------|--------|--------|
| 2.1 | Delete PL-02 listener code | `offerUnsub`, offer `onSnapshot` block |
| 2.2 | Delete TM-06 | `detailExpiryTick`, `startDetailExpiryTick`, `stopDetailExpiryTick` |
| 2.3 | Delete FW-18 / CD-04 | `applyOfferExpiryUi` entirely; callers → `syncFromInbox()` or `syncOfferUi()` |
| 2.4 | Remove unused import if `requestExpireRideOffer` no longer used in detail | `RideRequestDetail.js` imports |
| 2.5 | Simplify `syncFromInbox`: set `myOfferState = getOfferForRide(id) ?? null` (no local expire branch) | same |
| 2.6 | Simplify `syncOfferUi`: derive all panels from inbox offer; fix `driverOfferRecordExists` to require **alive** open/countered offer | same |

| Step | Action |
|------|--------|
| 2.7 | Build + hosting health test |
| 2.8 | Deploy hosting `?v=package7_ssot_step2_delete` |
| 2.9 | Repeat physical checklist |
| 2.10 | Tag freeze: `ssot/package7-complete-YYYYMMDD` |

### Phase 3 — Sign-off

| Step | Action |
|------|--------|
| 3.1 | Package 7 completion report |
| 3.2 | Update project status report |
| 3.3 | **STOP** — await approval for Package 8+ |

### Out of scope for this migration

- Customer app changes  
- Cloud Functions deploy  
- M4/M5 server consolidation  
- Package 8 radar listener merge  
- Removing `bargain-capacity.js` or customer `data.js` stubs  

---

## 10. Rollback plan

### Triggers

| Trigger | Action |
|---------|--------|
| Detail offer UI blank while inbox shows badge | Rollback hosting to Phase 0 tag |
| Accept-initial shows during active negotiation | Rollback |
| Accept counter fails with false `OFFER_EXPIRED` | Rollback |
| Physical P1-B regression (offer timeout / accept after expiry) | Rollback |
| Hosting startup health FAIL after build | Do not deploy |

### Rollback procedure

```powershell
# Restore driver detail + inbox from frozen baseline
git checkout ssot/package7-baseline-YYYYMMDD -- driver-app/js/RideRequestDetail.js driver-app/js/driver-offer-inbox.js driver-app/js/ride-radar-controller.js driver-app/js/driver-app.js

npm run build:hosting
npm run test:hosting-startup-health
firebase deploy --only hosting
```

Or Firebase Hosting console → rollback to previous release.

### Rollback artifacts (required before Phase 1)

| Artifact | Purpose |
|----------|---------|
| Git tag `ssot/package7-baseline-*` | Known-good pre-P7 |
| Git tag `ssot/package7-complete-*` | Post-P7 freeze (after success) |
| Hosting release ID / timestamp | Console one-click rollback |
| Physical checklist results (disable + delete) | Evidence gate |

### Rollback policy

- **Hosting rollback only** — no Functions rollback needed (Package 7 is client-only).
- **Never** re-enable PL-02 without inbox merge — if fix forward fails, revert entire package tag.
- **Do not** rollback Packages 1–3.

---

## 11. Expected user-visible improvements

### Driver app

| Before | After |
|--------|-------|
| Inbox badge disappears but detail still shows "bid sent" | Detail clears when inbox clears |
| Accept-initial panel reappears after offer expired | Panel only when inbox has **no** alive offer for ride |
| Counter panel flickers at timeout boundary | Single tick drives UI |
| Duplicate expire toasts / console `detail_ui` + `inbox_timer` | Single expire path from inbox |
| Detail and list disagree on same ride | Both read `getOfferForRide` |

### Customer app (indirect)

| Before | After |
|--------|-------|
| Customer offer visible while driver detail shows confusing mixed state | Driver actions match visible offer state; fewer "ghost" negotiations |
| Perceived desync on timeout | Both sides converge faster once CF expires (driver no longer holds local fake expired) |

### Operational / reliability

| Metric | Expected change |
|--------|-----------------|
| Duplicate `expireRideOffer` invokes | Reduced (no `detail_ui` source) |
| Firestore listener count per detail open | **−1** per open detail (PL-02 removed) |
| P1-B physical checklist item: accept-initial after expiry | **PASS** structurally (not workaround-dependent) |
| SSOT success criteria #3, #5, #6 | Progress toward driver single offer listener, zero local expired mutation |

### Physical test checklist (operator — required at disable + delete)

1. Admin: `settings/dispatch.offerTimeoutSeconds` = **10** (restore after).
2. Customer books; driver opens **radar detail** for ride.
3. Driver submits custom bid → detail shows bid sent; inbox badge appears.
4. Customer counters → driver detail shows counter panel (both apps foreground).
5. Wait past timeout **without accept**:
   - Driver inbox badge gone  
   - Driver detail: no bid/counter panels; accept-initial may appear only if server doc gone from inbox map  
   - Customer: offer panel hides  
   - Console: `expireRideOffer_call` from inbox sources only (no `detail_ui`)  
   - CF logs: `expireRideOffer_invoke`
6. Attempt accept after expiry → **`OFFER_EXPIRED`** toast, no assignment.
7. **New ride:** driver accepts customer initial fare **without** prior bid → assign works.
8. **New ride:** custom bid → customer accepts → assign works.
9. Navigate detail → back to list → reopen same ride → UI matches inbox.

---

## Appendix — Audit ID closure map

| ID | Disposition in Package 7 |
|----|--------------------------|
| PL-02 | **Remove** |
| TM-06 | **Remove** |
| FW-18 | **Remove** (local mutation) |
| CD-04 | **Remove** |
| P1 row (audit §10) | **Close** |

---

## Appendix — Risk summary

| Risk | Mitigation |
|------|------------|
| Detail UI blank after bid | Optimistic bid + mandatory `syncFromInbox` on `onOffersChanged` |
| Accept-initial regression | Physical test 5–7; server errors remain backstop |
| Missed expire if inbox stopped | Inbox already runs whenever driver online; unchanged |
| High regression surface | Disable → physical → delete; hosting-only rollback |

**Risk level:** **High** (active driver path) — justified by production reliability priority at project transition point.

---

**End of Package 7 implementation plan. No implementation. No code modified. STOP.**
