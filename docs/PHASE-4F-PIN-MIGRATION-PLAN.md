# PHASE 4F — PIN Migration Plan

**Date:** 2026-07-28  
**Production inventory/migration:** **NOT PERFORMED**

## Tools

| Tool | Purpose | Safety |
|---|---|---|
| `tools/phase4f-pin-inventory.cjs` | Read-only counts (`withPlaintextPinField`, `withPinHash`, vehicle IDs only) | Blocks Production unless `ALLOW_PRODUCTION_PIN_INVENTORY=1` |
| `tools/migrate-vehicle-pins.cjs` | Hash plaintext → delete `pin` | Blocks Production unless `ALLOW_PRODUCTION_PIN_MIGRATE=1`; default dry-run |

**Never log plaintext PIN values.**

## Emulator proof

- Phase 2C C04 migration suite (existing)  
- Phase 4F ops suite runs inventory tool on emulator (**PASS**)

## Production sequence (separate approval required)

1. Approval recorded (who/when/scope).  
2. Read-only inventory:
   ```text
   ALLOW_PRODUCTION_PIN_INVENTORY=1 GCLOUD_PROJECT=swiftgo-ride-app node tools/phase4f-pin-inventory.cjs
   ```
3. Review counts only (`withPlaintextPinField`).  
4. Dry-run migrate:
   ```text
   ALLOW_PRODUCTION_PIN_MIGRATE=1 node tools/migrate-vehicle-pins.cjs --dry-run
   ```
5. Apply once:
   ```text
   ALLOW_PRODUCTION_PIN_MIGRATE=1 node tools/migrate-vehicle-pins.cjs --apply
   ```
6. Re-inventory expecting `withPlaintextPinField == 0` (or only invalid skipped).  
7. Smoke `linkVehicleByPin` on a test vehicle.  
8. Confirm clients never query `where("pin"==…)`.

## Posture after migration

- Store `pinHash` only  
- Trusted `linkVehicleByPin` may still strip leftover plaintext if encountered  
- Rollback cannot restore plaintext (by design) — keep hashes
