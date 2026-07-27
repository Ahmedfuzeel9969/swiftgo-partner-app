# Phase 2A — Residual Risks

**Date:** 2026-07-27  
**After:** Bargaining + settlement Phase 2A expansion

---

## Remaining P1

| ID | Risk | Notes |
|----|------|-------|
| P1-004 (partial) | Email bootstrap for Super Admin | Prefer custom claim; rotate email off rules after all admins have `admin: true` |
| P1-006 (mitigated, deploy-gated) | Matching / candidate privacy | Rules + candidate feed implemented; live matching requires deployed Functions |
| New | Client `createRideRequest` vs atomic slots | UI gate + CF `createCustomerBooking` exist; hard race-safe limit needs CF deploy for production creates |
| New | Offer/match/finalize CF not deployed | Apps call Functions; without deploy, bargaining/settlement fail closed (rules deny client writes) |

## Remaining P2

| ID | Risk |
|----|------|
| P1-007 | Dual wallets (`users` vs `partners`) |
| P1-008 | `drivers/{id}` broad self-write |
| P1-011 | Vehicles readable by all signed-in |
| P1-013 | Blocked driver online path not fully harness-tested (T07 BLOCKED) |
| P1-016 | Functions exist locally; **not deployed** (intentional this phase) |
| P1-018 | Vehicle PIN strength / rate limit |
| P1-019 | `ride_requests` legacy collection |

## Intentionally unchanged (scope)

- One-minute location snapshot
- Karachi Golden Hotspots / general grid
- Progressive 1→2→3 km search design (preserved)
- P2P-with-Firebase-fallback design

## Deploy note

Trusted backend is **emulator-ready only**. Do not deploy until separately approved.
