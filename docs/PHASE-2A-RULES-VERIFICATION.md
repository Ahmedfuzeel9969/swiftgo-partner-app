# Phase 2A — Rules Verification

**Rules file:** `firestore.rules`  
**Emulator:** Firestore port 8080, project `demo-swiftgo-phase1`  
**Harness:** `@firebase/rules-unit-testing@3.0.4` + `tests/phase2a-emulator-suite.mjs`

---

## Helper changes

| Helper | Behavior |
|--------|----------|
| `isSuperAdmin()` | `admin` claim **or** bootstrap email + verified |
| `isPartnerSelfSafeUpdate(partnerId)` | Allowlist only: `currentVehicleId`, `name`, `displayName`, `email`, `updatedAt`, `role` |

---

## Critical rule outcomes (emulator)

| Check | Result |
|-------|--------|
| Driver cannot set `walletBalance` | PASS (T09, F01) |
| Driver cannot set `totalEarnings` | PASS (F02) |
| Driver cannot batch wallet/earnings | PASS (T19) |
| Customer cannot `accepted → completed` | PASS (T05, F04) |
| Customer cannot set commission/fare after accept | PASS (F05, F06) |
| Client cannot `in_progress → completed` with commission | PASS (T14) |
| Assigned driver `accepted → arrived → in_progress` | PASS (F08) |
| Skip stages denied | PASS (T06, F09) |
| Ledger create/edit/delete by client denied | PASS (F10, F11) |
| Owner cannot alter driver wallet | PASS (F12) |
| Partner safe profile update allowed | PASS (F25) |
| Dual accept second denied | PASS (T03, F14 via T03 evidence) |

---

## Collections added (client-denied writes)

| Path | Client |
|------|--------|
| `ledger_transactions/{id}` | read (party/admin); write **false** |
| `audit_logs/{id}` | read (admin); write **false** |

---

## Intentional residual admin power

`allow update: if isSuperAdmin()` on `partners` (God Mode) remains — Super Admin can still mutate partner docs. Settlement money path for drivers does not use this; recharge uses dedicated credit rule. Documented in residual risks (P1-004 partial).
