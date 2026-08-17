# P1-B Fix wave — acceptance path expiry audit

**Date:** 2026-08-06  
**Scope:** Confirm every server path that can assign a ride / accept an offer rejects past `offerExpiresAt`.

## Callable entry points that assign a driver

| Callable | Implementation | Expiry guard |
|---|---|---|
| `finalizeAssignmentFromOffer` | `bargaining.finalizeAssignmentFromOffer` | `isOfferPastTimeout` → `markOfferTimedOutInTx` → `__timedOut` → `OFFER_EXPIRED` |
| `acceptCustomerInitialFare` | `bargaining.acceptCustomerInitialFareAsDriver` | Blocks if any prior offer doc exists with `expired` → `OFFER_EXPIRED`; `rejected`/`withdrawn` → `OFFER_CLOSED`; open/countered (active or past-due) → `OFFER_NEGOTIATION_ACTIVE` or `OFFER_EXPIRED`. Only allowed when **no offer doc** or idempotent `accepted`. |
| `expireRideOffer` | `bargaining.expireRideOfferForCaller` | Marks expired; does not assign |

## Non-assign mutation paths (also guarded)

| Function | Guard |
|---|---|
| `counterRideOffer` | Past timeout → expire + `OFFER_EXPIRED` |
| `rejectRideOffer` | Past timeout → expire (status expired) |
| `submitRideOffer` (via expire piggyback) | Due offers expired before new submit continues |

## Other writers of `status: "accepted"` on offers/rides

| Location | Role | Bypass risk |
|---|---|---|
| `finalizeAssignmentFromOffer` tx | Primary customer/driver accept | Guarded |
| `acceptCustomerInitialFareAsDriver` tx | Driver accepts customer fare | Guarded (Fix #3) |
| `closeSiblingOffers` | Marks sibling as accepted after winner assigned | Post-assignment cleanup only; does not create a new assignment from an expired open offer |

No other Cloud Functions in this repo create a fresh ride assignment from an open/countered `ride_offers` document without going through the two callables above.

## Client invoke surfaces

| UI | Accept CF | Expire CF |
|---|---|---|
| Driver inbox / radar | `finalizeAssignmentFromOffer` / `acceptCustomerInitialFare` | `expireRideOffer` via `driver-offer-inbox.js` |
| Driver `RideRequestDetail` | same | `requestExpireRideOffer` + local expiry UI clear |
| Customer offer sheet | `finalizeAssignmentFromOffer` | `expireRideOffer` via `offer-client.js` |

## Verdict

**No remaining bypass** for accepting an offer after `offerExpiresAt`. **`acceptCustomerInitialFare` cannot assign after a custom offer expired** (2026-08-06 bypass fix).
