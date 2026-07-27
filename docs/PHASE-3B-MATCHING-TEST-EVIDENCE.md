# PHASE 3B — Matching Test Evidence

**Command:** `npm run test:phase3b`  
**Exit code:** 0  
**Totals:** **22 passed / 0 failed / 0 blocked / 0 skipped**  
**Artifact:** `tests/phase3b-matching-results.json`

## Scenario coverage

| Requirement | Test | Result |
|---|---|---|
| Candidate limit 10 | `limit-10-geo` | PASS |
| Candidate limit 20 | `limit-20-geo` | PASS |
| 1 km search | `search-1km` | PASS |
| Expand 1→2 km | `expand-1-to-2km` | PASS |
| Expand 2→3 km | `expand-2-to-3km`, `geo-expand-to-3km-for-distant` | PASS |
| No driver within 3 km | `no-driver-within-3km` | PASS |
| Overlapping cells dedupe | `overlapping-cells-dedupe` | PASS |
| Golden Hotspot boundary | `golden-hotspot-boundary` | PASS |
| General grid | `grid-cell-stability`, `cells-grow-with-radius` | PASS |
| Stale/blocked/suspended/busy/offline | `exclude-stale-blocked-busy-offline`, `busy-driver-excluded` | PASS |
| Nearest ordering | `nearest-driver-ordering` | PASS |
| Invalid Super Admin limits | `invalid-limit-15` | PASS |
| Client cannot manipulate | `client-cannot-inject-candidates`, `customer-cannot-bump-limit` | PASS |
| Full-fleet scan removed | `no-full-fleet-scan-in-cf` | PASS |
| Scale 100 / 1k / 10k | `scale-*-online` | PASS |
| Distant drivers don’t inflate | `distant-drivers-do-not-inflate-reads` | PASS |

## Example metrics (limit 10 geo match)

From results JSON: ~24 vehicle docs read in dense local fixture; `usedFullFleetScan: false`; source `geo_scoped`.

## Limitations

- Emulator document-read counters are instrumented in `geo-match` metrics (query result sizes + partner gets), not Google Billing export.  
- Scale fixtures use 30 local + (N−30) far drivers; reduction % is measured against old full-fleet model `2 × N` reads.
