# Business-load harness

This folder holds the **business-grade** capacity harness for SwiftGo.

## Rules

1. **Never** point destructive or heavy runners at production project `swiftgo-ride-app`.
2. Do not stress public Nominatim, OSRM demo, or OSM tile servers.
3. Preserve raw JSON/CSV under `results/raw/` and summaries under `results/summary/`.
4. Label every published number MEASURED / MODELLED / INFERRED / NOT TESTED.

## Layout

| Path | Purpose |
|------|---------|
| `config/workload-profiles.json` | 100k mix + LIGHT / REALISTIC_PEAK / SURGE |
| `scripts/guardrails.mjs` | Blocks production project IDs |
| `scripts/model-gps-cost.mjs` | MODELLED GPS write/cost calculator (no network) |
| `scripts/http-shell-probe.mjs` | Safe Hosting HTML probe only |
| `results/raw/` | Immutable run artefacts |
| `results/summary/` | Rolled-up reports |

## Status (2026-07-23)

| Scenario | Status |
|----------|--------|
| Prior Hosting stress | Completed (see `tests/load-capacity-*.json`) — **not** business proof |
| A3 HTTP re-verify | `results/raw/a3-http-reverify.json` |
| Staging Firebase | **NOT CREATED** |
| Auth / GPS / ride ladder | **NOT TESTED** — awaiting cost approval |

See `docs/100K-*.md`.
