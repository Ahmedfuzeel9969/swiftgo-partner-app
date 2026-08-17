# P1-A Pre-Deploy Change Summary

**Branch:** `validate/p1a-idle-publish-20260805`  
**Base:** `origin/main` @ `969f2ff`  
**Worktree:** `F:/ride-app-p1a-validate`  
**Generated:** 2026-08-05

---

## Modified files (vs origin/main)

| Path | Status |
|------|--------|
| `driver-app/js/driver-app.js` | Modified |
| `driver-app/js/location-checkpoint-policy.mjs` | Modified |
| `functions/bargaining.js` | Modified |
| `functions/index.js` | Modified |
| `super-admin-panel/index.html` | Modified |
| `super-admin-panel/js/admin-app.js` | Modified |

**Stat:** 6 files, +224 / −7

## New files (package artifacts)

| Path | Purpose |
|------|---------|
| `docs/specs/phase1-phase2-P1A-OPTION-A-VALIDATION-REPORT.md` | Lab validation report |
| `docs/specs/phase1-phase2-P1A-PHYSICAL-CHECKLIST.md` | Option A physical checklist |
| `docs/specs/phase1-phase2-P1A-DEPLOY-BLOCKED.md` | Deploy gate status |
| `docs/specs/phase1-phase2-P1A-CHANGE-SUMMARY.md` | This summary |
| `docs/specs/phase1-phase2-P1A-PREDEPLOY-FINAL-REPORT.md` | Final pre-deploy report |
| `tests/p1a-option-a-lab-results.json` | Lab results |
| `tests/p1a-predeploy-final-results.json` | Pre-deploy check results |

## Deleted files

**None.**

## New configuration keys (`settings/dispatch`)

| Key | Type | Default (when missing) | Bounds |
|-----|------|------------------------|--------|
| `idleLocationIntervalMs` | number (ms) | `4000` | 1000 … 1_800_000 |
| `idleLocationMoveMeters` | number (m) | `10` | 1 … 5000 |

Existing keys (`candidateDriverLimit`, radius / rings, etc.) unchanged in meaning.

## Cloud Functions changed

| Export | Change |
|--------|--------|
| `setCandidateDriverLimit` | Optional merge-write of the two idle keys (validated bounds); response may echo them |
| `getDispatchSettings` | Indirect: `readDispatchSettings()` now includes idle keys in returned object (Admin UI loads Firestore directly; driver uses `onSnapshot`) |

**Not changed:** `matchRideCandidates`, booking/offer/settlement, P2P signaling callables, breadcrumb, billing/pricing callables, `mirrorDriverLocationOnVehicleUpdate` logic (untouched source).

## Runtime listeners changed

| Listener | Change |
|----------|--------|
| `onSnapshot(doc(db, "settings", "dispatch"))` | **New** — started in `startDispatchIdleSettingsWatch()` when GPS watch starts; stopped when GPS watch stops; `start` always `stop`s first (no duplicate listeners) |
| All other driver/customer/P2P listeners | **Unchanged** |

## Backups

| Kind | Path |
|------|------|
| Pre-change (`origin/main` copies) | `F:/ride-app-p1a-validate/backups/p1a-prechange-20260805-170226/` |
| Current P1-A copies | `F:/ride-app-p1a-validate/backups/p1a-current-20260805-170226/` |

Backups are local only (not committed).
