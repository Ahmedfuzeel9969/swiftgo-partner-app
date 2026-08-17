# Package P1-A — Final Pre-Deploy Report (Option A)

**Date:** 2026-08-05  
**Branch / worktree:** `validate/p1a-idle-publish-20260805` @ `F:/ride-app-p1a-validate`  
**Base:** `origin/main` `969f2ff`  
**Status:** Pre-deploy checks **PASS**. Ready for P1-A-only commit + hybrid validation deploy.  
**P1-B:** Blocked.

---

## 1. Backups

| Kind | Path |
|------|------|
| Pre-change (`origin/main`) | `backups/p1a-prechange-20260805-170226/` |
| Current validate P1-A sources | `backups/p1a-current-20260805-170226/` |
| Live hosting samples (pre-deploy) | `backups/live-hosting-sample-20260805/` |
| Hybrid driver (live P2P + P1-A Option A) | `backups/hybrid-p1a-driver-app.js` |

Every modified source file was backed up (main copy + current copy). Backups are **not** committed.

---

## 2. Change summary

See `docs/specs/phase1-phase2-P1A-CHANGE-SUMMARY.md`.

| Category | Detail |
|----------|--------|
| Modified | 6 source files (+224/−7 vs main) |
| New (docs/tests) | Spec reports + lab/predeploy JSON |
| Deleted | None |
| New config keys | `idleLocationIntervalMs`, `idleLocationMoveMeters` on `settings/dispatch` |
| Cloud Functions | `setCandidateDriverLimit` (write); `readDispatchSettings` / `getDispatchSettings` (read echo) |
| Runtime listeners | **New** `onSnapshot(settings/dispatch)` only; start-stops with GPS watch; stop-before-start |

---

## 3. Final pre-deploy verification

**Artifact:** `tests/p1a-predeploy-final-results.json` — **OVERALL PASS**

| Check | Result |
|-------|--------|
| Valid saved values preserved (not forced to defaults) | PASS |
| Missing doc / empty → defaults 4s / 10m only | PASS |
| Partial keys normalize correctly | PASS |
| 20× restart watch → exactly 1 active listener | PASS |
| Stop clears listener | PASS |
| Rapid successive config applies → last wins, no leak | PASS |
| Active-ride policy unaffected by idle config | PASS |
| Restart reloads saved server values | PASS |
| Prior Option A lab suite | PASS (`tests/p1a-option-a-lab-results.json`) |

### Idle-only config must not trigger other systems

- Admin Save → single callable `setCandidateDriverLimit` → merge write on `settings/dispatch` only.
- Does **not** call match, offer, settlement, P2P, billing, or vehicle location writers.
- Driver `onSnapshot` updates **in-memory** idle knobs only; next GPS gate uses new thresholds — no extra dispatch/customer writes from the config event itself.
- `matchRideCandidates` does not read idle keys.

### Duplicate listeners / memory

`startDispatchIdleSettingsWatch()` always calls `stopDispatchIdleSettingsWatch()` first; simulated 20 restarts → 1 active unsub.

### Restart persistence

Saved keys live in Firestore. Admin reloads via `getDoc(settings/dispatch)`; driver re-subscribes on GPS start and applies saved values. Defaults apply only when keys/doc are missing/invalid — **not** when valid values exist.

---

## 4. Critical live-hosting finding (deploy strategy)

Live `https://swiftgo-ride-app.web.app` (release ~2026-08-05) currently has:

| Item | Live today | Option A target |
|------|------------|-----------------|
| Idle interval hardcode | **5 minutes** (`IDLE_LOCATION_INTERVAL_MS = 5*60_000`) | **4 seconds** default |
| Idle move hardcode | **200 m** | **10 m** default |
| Super Admin idle controls | **Absent** | Present (seconds + meters) |
| Driver `onSnapshot` idle watch | **Absent** | Present |
| P2P emergency (`COMM_TRACE` / comm bind) | **Present** on live | Must **preserve** |

A naive `firebase deploy --only hosting` from the clean validate branch would **restore Option A** but **wipe live P2P emergency files**.

### Deploy plan (P1-A validation, live-safe)

1. Build hosting from validate branch (Option A sources).
2. Overlay live P2P modules (`p2p-peer-session`, `p2p-ride-controller`, `p2p-comm-panel` under partner/customer/root).
3. Replace `partner/js/driver-app.js` with **hybrid** (live driver + P1-A Option A patches only).
4. Keep validate `location-checkpoint-policy.mjs` + Super Admin idle UI (restores 4s/10m defaults).
5. Deploy **hosting** (hybrid tree) + **functions:setCandidateDriverLimit** (and `getDispatchSettings` for read parity).

This is still a **P1-A-only behaviour change** on top of current live, and corrects the accidental 5 min / 200 m live regression.

---

## 5. Estimated Firebase write impact

| State | Idle publish cadence (stationary) | vs current live (5 min) | vs true historical main (4 s) |
|-------|-----------------------------------|-------------------------|-------------------------------|
| Defaults after Option A deploy | ~1 write / **4 s** while idle+online | **↑** denser than today’s wrong live 5 min | **unchanged** vs original main |
| Admin raises e.g. 60 s / 50 m | ~1 write / 60 s if still | ↓ vs 4 s defaults | operator-controlled |
| Config doc save | 1 merge write to `settings/dispatch` | n/a | n/a |

**Note:** Live is currently undersampling idle (5 min). Option A restores main’s 4 s density until Admin changes it. Expect **more** `vehicles/{id}` location writes while idle than today’s broken live, matching original production.

---

## 6. Estimated battery impact

| State | GPS | Radio / Firestore |
|-------|-----|-------------------|
| Defaults 4 s / 10 m | Same GPS watch as main; write gate ~4 s or 10 m | Same as original main idle |
| vs current live 5/200 | Slightly higher cellular/Firestore write rate while idle | Corrective, not a new product mode |
| Admin longer interval | Fewer Firestore writes; GPS watch unchanged | Battery usually dominated by GPS/`watchPosition`, not the idle write cadence |

No new GPS sensors; one additional cheap Firestore listener while online.

---

## 7. Rollback procedure

1. **Hosting:** Redeploy previous live hosting release, **or** restore from `backups/live-hosting-sample-20260805/` + prior hosting version in Firebase console.
2. **Functions:** Redeploy `setCandidateDriverLimit` / `getDispatchSettings` from `origin/main` (`969f2ff`) or from `backups/p1a-prechange-20260805-170226/functions__*.js`.
3. **Firestore config:** Remove or ignore `idleLocationIntervalMs` / `idleLocationMoveMeters` (clients fall back to code defaults).
4. **Source:** `git checkout origin/main --` the six P1-A files on the validate branch.

---

## 8. Remaining risks

1. Hybrid driver is deploy-time assembled (live + P1-A hunks) — not identical to validate `driver-app.js` git blob; P2P paths preserved by construction.
2. Until Admin sets keys, idle returns to **4 s / 10 m** (intentional Option A; denser than today’s mistaken live 5/200).
3. Physical device validation still required.
4. Dirty `F:/ride-app` must not be deployed.
5. P1-B remains blocked.

---

## 9. Explicit next steps (authorized by operator)

1. Commit P1-A-only sources on validate branch.  
2. Hybrid validation deploy (hosting + CF) as above.  
3. Operator runs Option A physical checklist.  
4. No P1-B until physical PASS + explicit approval.
