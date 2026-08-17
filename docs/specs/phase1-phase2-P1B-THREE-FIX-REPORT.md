# P1-B — Three confirmed defects — implementation report

**Date:** 2026-08-06  
**Scope:** Fix #1 timeout chain · Fix #2 Driver UI expiry · Fix #3 accept-path expiry  
**P2-C / other packages:** not started

---

## Verdict

| Item | Status |
|------|--------|
| Lab `p1b-auto-expire-suite` | **PASS 9/9** |
| Acceptance-path audit | **No bypass remaining** |
| Functions deploy | **Done** (2026-08-06 ~15:05 UTC) |
| Hosting deploy | **Done** (`https://swiftgo-ride-app.web.app`) |
| Live asset check | **Deployed JS contains Fix #1/#2 chain** |
| Physical dual-device CF invoke log | **Pending operator run** (checklist below) |

---

## Fix #1 — Restore `expireRideOffer` client → CF chain

**Root cause:** timers could miss expiry under mobile throttling; missing `offerExpiresAt` left schedules silent; insufficient logging.

**Changes:**
- Driver `driver-offer-inbox.js`: `resolveOfferExpiryMs` fallback; 1s tick; visibility flush; `expireRideOffer_call` / `_ok` / `_fail` console markers.
- Customer `offer-client.js`: same.
- Server `expireRideOffer`: `logger.info("expireRideOffer_invoke" | "_result")` for Cloud Logging evidence.
- Cache bust: `?v=offer_expire_fix_1` on Customer + Driver entry scripts.

**Live proof (code):** Hosted  
`https://swiftgo-ride-app.web.app/partner/js/driver-offer-inbox.js?v=offer_expire_fix_1`  
contains `expireRideOffer_call` + `inbox_tick` / `inbox_timer` sources.

---

## Fix #2 — Driver UI removes expired offers everywhere

**Root cause:** `RideRequestDetail` used a separate `onSnapshot` and did not clear when inbox hid the offer.

**Changes:**
- Detail screen: `applyOfferExpiryUi` + local tick; clears offer state; invokes `requestExpireRideOffer` with `source: "detail_ui"`.
- Accept handlers treat `OFFER_EXPIRED` and force expiry UI.

---

## Fix #3 — Highest priority: no accept bypass

**Root cause:** `acceptCustomerInitialFareAsDriver` did not check `isOfferPastTimeout`.

**Changes:**
- Past-timeout open/countered offer → mark expired → throw `OFFER_EXPIRED`.
- `resolveOfferExpiryMs` prefers `offerExpiresAt`, else `createdAt`/`updatedAt` + `offerTimeoutSeconds`.
- Lab **T7** proves `acceptCustomerInitialFare` → `OFFER_EXPIRED`.

**Audit:** `docs/specs/phase1-phase2-P1B-ACCEPT-PATH-AUDIT.md`  
Only assign callables: `finalizeAssignmentFromOffer`, `acceptCustomerInitialFare` — both guarded.

---

## Lab evidence

```
PASS | T7-acceptCustomerInitialFare-OFFER_EXPIRED — code=OFFER_EXPIRED status=expired
PASS | T8-resolveOfferExpiryMs-fallback
OVERALL PASS pass=9 fail=0
```

Emulator run: `firebase emulators:exec` → `tests/p1b-auto-expire-suite.mjs` (exit 0).

---

## Deploy evidence

**Functions** (`swiftgo-ride-app`, from `F:/ride-app-p1a-validate`):
- `expireRideOffer`, `acceptCustomerInitialFare`, `finalizeAssignmentFromOffer`
- `submitRideOffer`, `counterRideOffer`, `rejectRideOffer`  
Revision note: `expirerideoffer-00002-yas` ACTIVE after update.

**Hosting** (`F:/ride-app`): health 35/35 then `firebase deploy --only hosting`.

---

## Physical test checklist (operator — required for Fix #1 CF log evidence)

Hard-refresh both apps with cache bust:

- Customer: `https://swiftgo-ride-app.web.app/?v=offer_expire_fix_1`
- Driver: `https://swiftgo-ride-app.web.app/partner/?v=offer_expire_fix_1`

Steps:
1. Admin: set `settings/dispatch.offerTimeoutSeconds` = **10** (or 15).
2. Customer books; Driver submits offer; leave both apps foreground.
3. Wait past timeout **without** accepting.
4. **Expect Driver:** inbox + detail offer gone / expired UI.
5. **Expect Customer:** offer disappears; ride stays searching (spinner).
6. DevTools console: `[SwiftGo] expireRideOffer_call` then `expireRideOffer_ok`.
7. Server: `firebase functions:log --only expireRideOffer` must show **`expireRideOffer_invoke`** + **`expireRideOffer_result`**.
8. Attempt accept after expiry → **`OFFER_EXPIRED`** (not assignment).
9. Restore offer timeout to production default when done.

Agent cannot operate two physical phones / Gmail sessions; CF invoke lines above are the Fix #1 evidence gate.

---

## Stop

No P2-C. No further packages until physical checklist is confirmed and CF `expireRideOffer_invoke` evidence is attached.
