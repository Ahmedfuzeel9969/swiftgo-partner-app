# PHASE 3A — Cost Hotspots

**Date:** 2026-07-27  
Ranked by likely Production impact under the approved business model.

Severity:

- **P0** — uncontrolled cost or service failure risk at modest scale  
- **P1** — serious recurring cost  
- **P2** — important optimization  
- **P3** — minor saving  

---

## Top 10

| Rank | Finding | Sev | Evidence | Status |
|---:|---|---|---|---|
| 1 | **`matchRideCandidates` reads all online/`in_ride` vehicles + partner docs** (O(online)), while candidate limit only caps writes (10/20) | **P0** | `functions/index.js` / bargaining match path; Phase 3A estimates jump with `onlineCount` | **Report only** — changing requires geo-index approval |
| 2 | **Driver location writes historically 8 s** (would dominate writes) | **P0** (pre-fix) | Replaced by approved **60 s + zone** | **Fixed in 3A** (−87% timed writes) |
| 3 | **Admin / owner live listeners on large `vehicles` sets** while consoles open | **P1** | `admin-app.js`, `fleet-map.js`, owner listeners | Map detach **fixed**; fleet monitor still ambient |
| 4 | **Unbounded admin `onSnapshot(collection(rides))` for totals** | **P1** (pre-fix) | Replaced with `getCountFromServer` + interval | **Fixed in 3A** |
| 5 | **Dual vehicle listeners** (admin fleet monitor + live map) when map open | **P1** | Two `onSnapshot` paths on vehicles | Partially mitigated (map stops off-view) |
| 6 | **Listener fan-out to ≤20 candidates** per search (each candidate doc + offer updates) | **P1** | Approved 10/20 model | Accepted business cost; monitor |
| 7 | **Four concurrent customer bookings** × full bargain listeners | **P2** | Approved cap | Accepted; cost ×4 peak |
| 8 | **Settlement retries** add Function invocations + txn reads | **P2** | S12: 3 invokes, 1 ledger | Idempotent writes OK; watch retry storms |
| 9 | **Audit log + ledger writes per settlement** | **P2** | Measured +1 audit, +1 ledger / ride | Necessary; avoid verbose debug audits in prod |
| 10 | **KYC / image Storage downloads** on admin review | **P3–P2** | Storage rules + admin UI | Use thumbnails / signed short-lived URLs (recommend) |

---

## Checklist vs Phase brief

| Check | Result | Sev |
|---|---|---|
| Listeners reading entire collections | Admin vehicles/partners; former full rides listen | P0/P1 |
| Listeners not detached after screen close | Admin map **fixed**; verify owner/driver radar paths in QA | P1 |
| Repeated dashboard reads | Admin count poll 60s (acceptable vs full listen) | P2 |
| Duplicate booking listeners across apps | Customer + driver + optional owner — necessary mirrors | P2 |
| Matching queries repeated unnecessarily | Client should not re-match in tight loops — gate in UI | P2 |
| Reading all online drivers instead of candidates | **Yes in match CF** | **P0** |
| Excessive audit-log writes | One per settlement observed | P3 |
| Repeated settlement retries | Idempotent; still burns invocations | P2 |
| Location writes exceeding 1-minute rule | **Corrected to 60s** | Was P0 |
| Firebase fallback after P2P recovery | Needs runtime verification | P1 if stuck on |
| Super Admin live listeners when map closed | Map **stops**; other admin listeners may remain | P1 |
| Large KYC downloads | Possible | P2 |
| Missing pagination / query limits | Admin rides feed uses limit(100) in places; vehicles often unbounded | P1 |

---

## Recommended (not implemented — need approval)

1. Geo / hotspot-scoped matching so Functions do not scan entire online fleet.  
2. Admin vehicles listener: query only `status in (online,in_ride)` + pagination, or snapshot on map only.  
3. Feature flags to disable admin live fleet and owner live maps under cost incidents.  
4. Explicit “stop Firebase location fallback” on P2P recovery (automated test).  
5. Cap audit verbosity / sample non-critical admin telemetry.
