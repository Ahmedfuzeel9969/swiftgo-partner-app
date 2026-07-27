# Phase 2E — Failure and Recovery

**Date:** 2026-07-27  
**Environment:** Local emulators only

---

## Covered in automated browser suite

| Scenario | How tested | Outcome |
|----------|------------|---------|
| Browser refresh during session | Customer reload with `?emulators=1` / localStorage flag (E80) | Emulator hooks + Auth session survive |
| Duplicate settlement / repeated complete | Second complete press + ledger recount (E46) | Still exactly one ledger entry |
| Two drivers / second finalize while active | Driver finalizes ride A then ride B (E72) | Second finalize rejected |
| 11th concurrent bargain | 10 OK then 11th submitRideOffer fails (E70–E71) | Rejected as designed |
| Booking confirm dismiss | `window.confirm` dismissed (E62) | No extra booking |
| Booking 5 under active cap | Gate rejects (E63) | At most 4 searching |
| Cancel frees slot | Cancel CF then new book (E64) | New booking allowed |
| Customer fare tamper | Client `updateDoc` fare fields (E52) | Denied |
| Ordinary admin access | Non-bootstrap user on `/admin/` (E02) | Denied |

---

## Partially covered / residual

| Scenario | Status | Notes |
|----------|--------|-------|
| Customer/driver close & reopen app | Partial | Reload covered; full cold-start multi-tab not separately timed |
| Temporary Functions emulator interruption | Not automated | Would require killing port 5001 mid-flight; residual risk |
| Duplicate button press on book | Soft | `requesting` / `activeRide` guards exist in `ride-flow.js`; not stressed as a dedicated case |
| Simultaneous dual-driver finalize race | Covered as sequential second finalize | True wall-clock parallel race not instrumented |
| Logout/login mid active booking | Not automated | Residual — recommend manual check before production |
| Delayed cross-app snapshot lag | Observed via waits | Apps converge; no duplicate settlement observed |

---

## Integrity checks after recovery paths

- No duplicate `ledger_transactions` for the settled ride (E44, E46).  
- Assignment remains single-driver (E18, E72).  
- Booking slots release on cancel/complete paths used in E60–E64 / settlement.  
- Production project never written (E81).

---

## Conclusion

Core durability properties (no duplicate settlement, bargain/booking caps, assignment exclusivity, refresh survival) were demonstrated on the emulator. Remaining interruption scenarios are listed as residual risks, not as silent passes.
