# Phase 2C — Vehicle PIN Migration Readiness

**Date:** 2026-07-27  
**Production Firestore:** **not queried and not migrated**  
**PINs:** never logged or returned by the migration tool

---

## Tool

- Script: `tools/migrate-vehicle-pins.cjs`
- Behavior (idempotent):
  - Scan `vehicles`
  - If plaintext `pin` present and valid → write `pinHash` (if missing), delete `pin`, set `pinMigratedAt`
  - If already `pinHash` only → leave unchanged
  - If both → delete `pin`, keep existing hash
- Safety:
  - Refuses to run without `FIRESTORE_EMULATOR_HOST` unless `ALLOW_PRODUCTION_PIN_MIGRATE=1`
  - `--dry-run` (default) vs `--apply`

---

## Inventory

| Scope | with plaintext `pin` | with `pinHash` | Notes |
|-------|----------------------|----------------|-------|
| **Production** | **Not counted** | **Not counted** | Phase 2C forbids Production reads/writes |
| **Emulator fixtures (C04)** | ≥1 seeded (`mig-plain`) | ≥1 seeded (`mig-hash`) + migrated | Proven locally |

Production inventory requires a **separately approved** read-only Admin export or dry-run with explicit production allow flag — not performed here.

---

## Emulator proof (executed)

Test: **C04-pin-migration-emulator** in `tests/phase2c-e2e-suite.mjs`  
Command: `npm run test:phase2c`  
Result: **PASS**  
Evidence: `tests/phase2c-e2e-results.json`

| Step | Expected | Actual |
|------|----------|--------|
| Dry-run | Counts plaintext candidates | `dryMigrated≥1` |
| Apply | Writes hash, deletes pin | `plainHasPin=false`, `plainHasHash=true` |
| Already-hashed doc | Untouched plaintext-free | `hashUntouched=true` |
| PIN link after hash | `linkVehicleByPin` succeeds without returning pin | **C05 PASS** |

Manual equivalent (emulator only):

```text
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tools/migrate-vehicle-pins.cjs --dry-run
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node tools/migrate-vehicle-pins.cjs --apply
```

---

## Client / server posture

- Client apps: no `where("pin"==…)` (canonical audit **A01 PASS**)
- Trusted `linkVehicleByPin` may Admin-fallback to legacy plaintext during transition, then strips `pin` and ensures `pinHash`
- Owner/driver creates store `pinHash`

---

## Production migration checklist (DO NOT RUN now)

1. Separate approval for Production Admin access.
2. Set `FIRESTORE_EMULATOR_HOST` unset; set `ALLOW_PRODUCTION_PIN_MIGRATE=1` only under approval.
3. Dry-run; record counts (scanned / withPlaintextPin / withPinHash) — **do not log PIN values**.
4. Apply once; re-dry-run expecting `withPlaintextPin=0` (or only invalid skipped).
5. Smoke `linkVehicleByPin` on a non-production test vehicle first if possible.

---

## Readiness verdict

**Migration code: READY (emulator proven).**  
**Production migration: NOT PERFORMED** — remaining operational step before/alongside controlled deploy if any plaintext PINs remain in Production.
