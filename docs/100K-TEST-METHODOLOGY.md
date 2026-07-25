# 100K Test Methodology

**Version:** 1.0 · 2026-07-23  
**Scope:** Business-grade capacity proof for 100,000 concurrent platform users  
**Rule:** Never mark PASS without distributed, backend-exercising, integrity-preserving evidence.

---

## Evidence labels (mandatory)

| Label | Meaning |
|-------|---------|
| **MEASURED** | Observed in an instrumented run with raw artefacts preserved |
| **MODELLED** | Calculated from rates × counts × published prices/quotas |
| **INFERRED** | Deduced from source code / architecture without runtime proof |
| **NOT TESTED** | Required but not executed |

---

## Environments

| Env | Purpose | Allowed for capacity PASS? |
|-----|---------|----------------------------|
| Production `swiftgo-ride-app` | Live traffic only | **No** — no synthetic heavy load |
| Staging (TBD project) | Latency, throughput, listeners, quotas, billing | **Yes** (required) |
| Emulators | Rules correctness, dual-accept races, integrity | Correctness only — **not** capacity |

Staging must mirror: Firestore rules, indexes, Auth providers, Hosting headers, Storage rules, App Check (once added), region, env vars. **Cloud Functions:** none exist today — staging must also have none until architecture changes.

---

## Workload model (configurable)

Config file: `tests/business-load/config/workload-profiles.json`

### Session mix (100K target)

| Role | Sessions | Share |
|------|----------|-------|
| Customer/rider | 80,000 | 80% |
| Partner/driver | 19,000 | 19% |
| Owner | 900 | 0.9% |
| Admin/support | 100 | 0.1% |

### Profiles

| Profile | Rider active % | Drivers online % | Notes |
|---------|----------------|------------------|-------|
| LIGHT | 5% of 80k = 4,000 | 40% of 19k = 7,600 | Mostly idle sockets |
| REALISTIC PEAK | 15% = 12,000 | 70% = 13,300 | Default commercial target |
| SURGE | 30% = 24,000 | 90% = 17,100 | + reconnect storm; 125k spike |

### Current-app GPS rate (INFERRED from code)

`VEHICLE_LOCATION_WRITE_MS = 8000` → **0.125 writes/s/online driver** · **450 writes/hour/driver** while GPS callbacks fire (stationary still writes; offline does not).

---

## Required scenarios (execution order)

1. **E1 Static delivery** — cold/warm, JS boot assertion, multi-region generators  
2. **E2 Auth** — sign-in storms, refresh, revoke, reconnect  
3. **E3 GPS ladder** — 50 → 200 → 500 → 1k → 5k → target online drivers  
4. **E4 Full ride lifecycle** — create → offer → single accept → complete + negative paths  
5. **E5 Listener fan-out** — instrumented read accounting  
6. **E6 Reconnect storm** — 10% / 25% / 50%  
7. **E7 Spike** — 2× searches + GPS + dashboards  
8. **E8 Soak** — ≥2 h at max stable; 24 h only after approval  

### Load ladder (Part F)

| Stage | Concurrent sessions | Min duration |
|------:|--------------------:|-------------:|
| 1 | 100 | 10 min |
| 2 | 500 | 10 min |
| 3 | 1,000 | 15 min |
| 4 | 2,500 | 15 min |
| 5 | 5,000 | 20 min |
| 6 | 10,000 | 30 min |
| 7 | 25,000 | 45 min |
| 8 | 50,000 | 60 min |
| 9 | 75,000 | 60 min |
| 10 | 100,000 | 120 min |
| Headroom | 125,000 | 15 min spike |

Generators must keep **≥30% CPU/network headroom**. If generators saturate → mark run **INVALID**.

---

## Stop conditions (Part G)

Abort stage if: production writes detected; cost > approved limit; data corruption; dual accept of same ride; lost completed rides; error rate >2% sustained; critical txn errors >0.5%; p99 >10 s for 5 consecutive minutes; continuous Firebase throttling; generator overload; third-party ToS risk; cleanup not guaranteed.

---

## Acceptance criteria (Part H) — 100K PASS requires all

See parent brief items 1–21. Short form:

- 100k concurrent × 2 h realistic profile + 125k spike 15 min  
- Critical txn success ≥99.9%; overall errors <0.5%; 5xx <0.1%  
- Boot p95 <3 s; ride ack p95 <2 s; offer p95 <5 s; GPS freshness p95 <15 s  
- No duplicate rides / lost completes / dual ownership / cross-role leakage  
- Commercial map/routing providers; measured monthly cost + cost/ride  
- Monitoring/alerting/backup/rollback live; ≥25% proven headroom  

### Capacity definitions

| Term | Definition |
|------|------------|
| **BREAKING CAPACITY** | First failing stage |
| **MAXIMUM STABLE CAPACITY** | Highest stage meeting all technical criteria |
| **SAFE COMMERCIAL CAPACITY** | ≤70–80% of maximum stable (unless stronger headroom proven) |

---

## Artefact layout

```
tests/business-load/
  config/workload-profiles.json
  scripts/          # runners (refuse production project IDs)
  results/raw/      # JSON/CSV/logs per run
  results/summary/  # rolled-up metrics
docs/100K-*.md
```

Every run must record: git commit, UTC timestamps, Firebase project ID, DB region, generator host inventory, profile name, cost meter snapshot.
