# Phase 2A — Canonical Contract (Bargaining + Settlement)

**Status:** Source of truth for Phase 2A (expanded)  
**Date:** 2026-07-27  
**Preserves:** Existing `rides.status` names where valid; bargaining is a separate concern.

---

## Concepts (do not collapse)

| Concept | Storage | Notes |
|---------|---------|-------|
| Booking / request | `rides/{rideId}` | Customer trip intent |
| Bargaining / offer | `ride_offers/{offerId}` | Private per driver↔customer |
| Candidate invitation | `ride_candidates/{rideId}_{driverId}` | Who may see/bargain |
| Final assignment | `rides.status = accepted` + `driverId` | Exactly one driver |
| Active ride | `accepted` \| `arrived` \| `in_progress` | Driver may have ≤1 |
| Settlement | CF `completeRideSettlement` | Trusted only |

---

## Booking lifecycle (`rides.status`)

| Value | Alias | Meaning |
|-------|-------|---------|
| `searching_driver` | requested / negotiating | Open for offers; not assigned |
| `accepted` | assigned | Final driver assigned |
| `arrived` | — | At pickup |
| `in_progress` | started | Trip running |
| `completed` | — | Settled |
| `cancelled_by_user` | cancelled | Customer cancelled while searching |
| `expired` | — | Search timed out (optional terminal) |

```
searching_driver → accepted → arrived → in_progress → completed
searching_driver → cancelled_by_user | expired
```

Bargaining does **not** change booking to `accepted`.

---

## Offer lifecycle (`ride_offers.status`)

`open → countered → accepted | rejected | withdrawn | expired`

- One booking may have many open offers (one per candidate driver).
- Offer acceptance that finalizes assignment must be **atomic** with ride claim.
- Drivers cannot read/write another driver’s offer docs.

---

## Dispatch settings (`settings/dispatch`)

| Field | Type | Rules |
|-------|------|-------|
| `candidateDriverLimit` | number | Integer **10 or 20** (Super Admin); validated server-side; reject other values |
| `searchRingsKm` | number[] | Fixed progressive **[1, 2, 3]** |
| `maxDriverOpenBargains` | number | **10** (contract constant; readable) |
| `maxCustomerActiveBookings` | number | **4** |
| `updatedAt` | timestamp | Admin write |

Written only by Super Admin. Applied by trusted matching (`matchRideCandidates`).

---

## Limits

| Rule | Value |
|------|-------|
| Candidates per booking | Admin `candidateDriverLimit` (10 or 20) via 1→2→3 km rings |
| Driver concurrent open bargains | ≤ 10 offers in `open`\|`countered` |
| Driver concurrent active rides | ≤ 1 (`accepted`\|`arrived`\|`in_progress`) |
| Customer concurrent non-terminal bookings | ≤ 4; confirm before 2–4; reject 5th |

Non-terminal booking statuses: `searching_driver`, `accepted`, `arrived`, `in_progress`.

---

## Final assignment invariants

1. Exactly one `driverId` on an `accepted` ride.  
2. Winner’s other open offers → `withdrawn`.  
3. Losers’ offers on that ride → `expired` or `withdrawn`.  
4. Driver with an active ride cannot finalize another.  
5. Simultaneous finalize → one winner (transaction).

---

## P0 financial contract (unchanged)

Protected fields remain client-immutable; settlement via `completeRideSettlement` only.
