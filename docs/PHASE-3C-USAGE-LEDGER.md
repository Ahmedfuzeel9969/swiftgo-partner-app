# PHASE 3C — Usage Ledger

**Date:** 2026-07-27  
**Project:** none (cloud staging not started)  
**Mode:** Emulator-only — cloud progressive tests **not begun**  
**Internal caps:** drivers≤20, customers≤10, complete rides≤10, partial≤10, CF≤200, reads≤5k, writes≤2k, deletes≤200, Storage≤25MB, Hosting≤100MB  

> Budget alerts are not hard caps. This ledger tracks **internal safety caps** and measured operations only. It does not claim zero billing is guaranteed.

## Cap headroom at start

| Cap | Limit | Used (cloud) | Remaining | 70% stop line |
|---|---:|---:|---:|---:|
| Synthetic drivers | 20 | 0 | 20 | 14 |
| Synthetic customers | 10 | 0 | 10 | 7 |
| Complete rides | 10 | 0 | 10 | 7 |
| Partial/failure rides | 10 | 0 | 10 | 7 |
| Function invocations | 200 | 0 | 200 | 140 |
| Firestore reads | 5,000 | 0 | 5,000 | 3,500 |
| Firestore writes | 2,000 | 0 | 2,000 | 1,400 |
| Firestore deletes | 200 | 0 | 200 | 140 |
| Storage test data | 25 MB | 0 | 25 MB | 17.5 MB |
| Hosting test transfer | 100 MB | 0 | 100 MB | 70 MB |

## Planned operation budgets (not executed)

| Step | Test name | Est. max ops (worst case) | Decision |
|---|---|---|---|
| 1 | Deploy indexes | Index builds + unknown build reads | **STOP — not executed** (no staging project / Blaze approval) |
| 2 | Deploy Rules | 1 ruleset publish | **STOP — not executed** |
| 3 | Deploy Functions once | Build + Artifact Registry + ≥1 deploy invocation path | **STOP — unavoidable charge risk** |
| 4 | Deploy Hosting once | ~tens of MB transfer | **STOP — not executed** |
| 5 | Min synthetic accounts | ≤5 Auth users create | **STOP — not executed** |
| 6 | One basic booking | ~≤15 CF invokes, ~≤200 R/W | **STOP — not executed** |
| 7 | Usage check | Dashboard read only | **STOP — N/A** |
| 8 | One bargain/assign | ~≤20 CF, ~≤300 R/W | **STOP — not executed** |
| 9 | Usage check | — | **STOP — N/A** |
| 10 | One settlement | ~≤5 CF, ~≤50 R/W | **STOP — not executed** |
| 11 | Usage check | — | **STOP — N/A** |
| 12 | Further tests | Only with headroom | **STOP — not executed** |

## Executed cloud test groups

*None.*

| Test name | Est. max | Actual measured | CF | Reads | Writes | Deletes | Storage | Hosting | Start totals | End totals | Headroom OK? | Continue/Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | N/A | **STOP at precheck** |

## Emulator-only note

Local `demo-swiftgo-phase1` emulator runs (Phase 1–3B) do not bill Google Cloud. They are **out of scope** for this cloud usage ledger and were not re-run as part of a Phase 3C cloud staging exercise.
