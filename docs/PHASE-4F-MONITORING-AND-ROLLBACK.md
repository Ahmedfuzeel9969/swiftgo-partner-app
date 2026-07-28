# PHASE 4F — Monitoring and Rollback

**Date:** 2026-07-28

## Monitoring implemented (repo)

| Signal | Mechanism |
|---|---|
| Structured function errors | JSON `console.error` via `ops-monitor.logStructured` + `ops_metrics` counters |
| Settlement failures | `recordSettlementFailure` from `completeRideSettlement` |
| Matching failures | `recordMatchingFailure` from `matchRideCandidates` |
| Auth denials | `recordAuthDenial` when unauthenticated paths hit `wrapCall` |
| Duplicate ledger sample | `getOpsHealthSummary` samples ledger keys |
| GeoCell coverage | `getGeoCellCoverageReport` (admin) — missing cells listed; matching stays geo-scoped |
| Budget / usage | **Documented only** — configure Google Cloud Billing budgets in console (not automated here) |

Admin callables:

- `getOpsHealthSummary`
- `getGeoCellCoverageReport`

## Wallet / ledger reconciliation (operator)

1. For a disputed ride: locate `ledger_transactions` id `settle_{collection}_{rideId}`.  
2. Compare ride fare fields vs ledger gross/commission/net.  
3. Confirm partner `walletBalance` movements match settlement events only (never client writes).  
4. If duplicate settlement suspected: check idempotent ledger doc existence before re-running `completeRideSettlement`.  
5. Record incident ID in ops ticket; optionally write `audit_logs` entry via Admin SDK.

## Settlement incident response

1. Freeze manual wallet edits (Admin UI should already be server-gated).  
2. Capture rideId, timestamps, function logs (Cloud Logging filter `event=settlement_failure`).  
3. Do not delete ledger rows.  
4. If CF bug: rollback Functions to previous git tag / prior Cloud Functions revision.  
5. Re-run settlement only after root-cause fix and idempotency check.

## Rollback artifacts

| Layer | Rollback method |
|---|---|
| Cloud Functions | Redeploy previous git SHA; Firebase retains prior revisions — traffic shift if needed |
| Firestore rules | Redeploy previous `firestore.rules` from git tag |
| Storage rules | Redeploy previous `storage.rules` |
| Hosting | Redeploy previous `hosting-dist` / git tag |
| Indexes | Prefer additive; removing indexes needs care — document before drop |
| PIN hashes | Not reversible to plaintext — do not attempt |

## GeoCell fail-safe

Vehicles online **without** `geoCell`/`hotspotId` are simply not returned by geo queries.  
`usedFullFleetScan` remains **false** in `geo-match.js`. Do not reintroduce full-fleet scans.

## Alerting still required in GCP (manual)

- Billing budget alerts  
- Cloud Functions error-rate alert policies  
- Optional: log-based metrics on `settlement_failure` / `matching_failure` JSON events
