# PHASE 3B — Implementation Report

**Date:** 2026-07-27  
**Production touched:** No  
**Deployed:** No  
**Billing enabled:** No  

## Full-fleet scans removed

| Location | Before | After |
|---|---|---|
| `functions/index.js` `matchRideCandidates` | `vehicles.where(status in [online,in_ride]).get()` + partner get per vehicle | Geo-scoped `matchRideCandidates(db, { rideId, pickup })` only |
| Other matching paths | None other active | Confirmed via repo grep — only `geo-match.js` queries online vehicles by cell/hotspot |

## Code changes

1. **Added** `functions/geo-cells.js`, `functions/geo-match.js`  
2. **Updated** `functions/matching.js` — stale/busy/offline/blocked filters; optional `requireFreshLocation`  
3. **Updated** `functions/bargaining.js` — geo load when `onlineDrivers` omitted  
4. **Updated** `functions/index.js` — injection denial; settings-only limit for customers  
5. **Updated** `firestore.rules` — allow `geoCell`, `hotspotId`, `locationGridCell` on driver location updates  
6. **Updated** `firestore.indexes.json` — status+geoCell, status+hotspotId  
7. **Updated** driver/owner location sync to write match geo fields  
8. **Updated** phase2d/2e/3a seeds to include geo fields + timestamps  
9. **Added** `tests/phase3b-geo-matching.mjs`, `npm run test:phase3b`

## Privacy

- Candidate docs still server-written only.  
- List rules unchanged (driver sees own invitations; customers do not list all candidates).  
- Clients cannot supply candidate lists to the Function.

## Compatibility

- In-memory `onlineDrivers` still accepted by Admin-SDK helper for older unit fixtures (`phase2a` etc.).  
- Production callable path **never** accepts client driver lists.
