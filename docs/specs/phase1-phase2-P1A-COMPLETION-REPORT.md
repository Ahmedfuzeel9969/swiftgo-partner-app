# Package P1-A — Completion Report

**Status:** COMPLETE — **STOP**. Package P1-B is **not** started.  
**Authorization:** Execution Order approved; only P1-A.  
**Baseline:** `docs/specs/phase1-phase2-P1A-BASELINE.md`

---

## 1. What changed

### Files changed
| File | Change |
|------|--------|
| `driver-app/js/location-checkpoint-policy.mjs` | `normalizeIdlePublishConfig`, idle overrides on `resolveCheckpointPolicy`, controller `setIdlePublishConfig` / `getIdlePublishConfig` / `getIdleMoveMeters` |
| `driver-app/js/driver-app.js` | Idle move threshold from config; `onSnapshot(settings/dispatch)` → idle config; start/stop with location watch |
| `functions/bargaining.js` | `readDispatchSettings` returns idle keys (defaults 5 min / 200 m) |
| `functions/index.js` | `setCandidateDriverLimit` accepts/merges idle keys |
| `super-admin-panel/index.html` | Idle interval (minutes) + move meters fields |
| `super-admin-panel/js/admin-app.js` | Load/save idle fields |
| `docs/specs/phase1-phase2-P1A-BASELINE.md` | Baseline snapshot |

### Functions / listeners / timers changed
| Kind | Detail |
|------|--------|
| Function | `resolveCheckpointPolicy` — optional `idleIntervalMs` |
| Function | `createCheckpointPolicyController.setIdlePublishConfig` (new) |
| Function | `syncVehicleLocationToFirestore` — idle move uses `getIdleMoveMeters()` |
| Listener | **New** `onSnapshot(settings/dispatch)` for idle publish config |
| Timer | No new setInterval; idle cadence still GPS-callback gate-based |
| Config keys | **Added:** `idleLocationIntervalMs`, `idleLocationMoveMeters` on `settings/dispatch` |

### Defaults (existing runtime preserved)
| Key | Default |
|-----|---------|
| `idleLocationIntervalMs` | **300000** (5 minutes) — current production |
| `idleLocationMoveMeters` | **200** |

To match approved spec example (3 min): Super Admin sets idle interval to **3** minutes (180000 ms). Until then, behaviour matches pre–P1-A.

---

## 2. Scope control (verified)

| Must not change | Status |
|-----------------|--------|
| Dispatch matching algorithm | Untouched (only settings read/write shape) |
| Offer timeout | Not touched |
| Firebase backup / P2P / customer UI / accept | Not touched |

---

## 3. Tests executed

| Suite | Result |
|-------|--------|
| `node tests/runtime-validation-phase3.mjs` | **14 PASS / 0 FAIL** |
| `node tests/runtime-consistency.mjs` | **19 PASS / 0 FAIL** |
| `node tests/checkpoint-policy.mjs` | Unit cases **PASS**; rules/emulator section failed connect (`ECONNREFUSED` 8080) — emulator not running (pre-existing env) |
| Idle override smoke (`normalizeIdlePublishConfig` / controller) | **PASS** |
| `npm run build:hosting` | **SUCCESS** |

### Manual checklist (operator / staging)
- [ ] Driver go online / offline  
- [ ] Location permission still works  
- [ ] Dispatch eligibility unchanged  
- [ ] Idle Firebase writes follow configured interval/move  
- [ ] No unnecessary write increase at default 5 min / 200 m  
- [ ] Ride flow regression smoke  

---

## 4. Performance comparison

| | Previous | New (default config) | If admin sets 3 min |
|--|----------|----------------------|---------------------|
| Idle interval | 5 min | **5 min** (same) | 3 min |
| Idle move | 200 m | **200 m** (same) | 200 m (unless changed) |
| Firebase writes (stationary) | ~12/hour | **~12/hour** | ~20/hour |
| Write reduction/increase at default | — | **None** | +~8 writes/hour/driver if set to 3 min |
| Battery / network at default | — | **No change** | Slightly higher if interval shortened |

---

## 5. Rollback

1. Revert the listed files (git).  
2. Redeploy hosting (driver + admin) and functions if those deploys were applied.  
3. Optional: delete `idleLocationIntervalMs` / `idleLocationMoveMeters` from `settings/dispatch` (harmless if left; old code ignored them).

**Rollback confirmation:** Changes are localized; defaults preserve prior cadence — safe to leave undeployed or revert cleanly.

---

## 6. Deploy note

Code is in-repo and `hosting-dist` rebuilt. **Production deploy of hosting + functions was not requested in this package authorization** — perform when you approve release of P1-A to live.

---

## 7. Remaining issues

1. Emulator rules portion of `checkpoint-policy.mjs` not run (emulator down).  
2. Spec example 3 min is **not** forced; admin must set it.  
3. Manual device checklist above still pending operator.

---

## STOP

**Do not start Package P1-B.**  
Await explicit approval of P1-A (and optional live deploy) before the next package.
