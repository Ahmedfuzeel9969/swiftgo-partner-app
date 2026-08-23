# Package P1-A — Option A Lab Validation Report

**Date:** 2026-08-05  
**Decision:** Option A (preserve live production defaults)  
**Status:** Lab validation **PASS**. **No Firebase deploy.** **P1-B not started.**  
**Branch:** `validate/p1a-idle-publish-20260805`  
**Worktree:** `F:/ride-app-p1a-validate` (clean; from `origin/main` @ `969f2ff`)  
**Dirty tree `F:/ride-app`:** **not used** for this package / must not be deployed  

---

## Verdict

P1-A on the clean validation branch makes idle Firebase publish **configurable** via Super Admin → `settings/dispatch`, while keeping **runtime defaults identical to current production: 4 seconds / 10 meters**. Changing either value in Admin applies on the driver through `onSnapshot` without restart. Snapshot errors keep last-known / default config and **do not** stop GPS. Diff is limited to six files; no customer, P2P signaling, radar, or backup-path files changed.

---

## Operator conditions — checklist

| # | Condition | Result |
|---|-----------|--------|
| 1 | Do not deploy from dirty working tree | **Met** — work only in `F:/ride-app-p1a-validate` |
| 2 | Continue on clean validation branch only | **Met** — `validate/p1a-idle-publish-20260805` |
| 3 | Option A baseline: production 4s / 10m remain defaults | **PASS** (lab) |
| 4 | Admin only configures; no silent prod behaviour change until admin edits | **PASS** — missing keys → normalize to 4000 / 10 |
| 5 | Admin change → driver hot-applies via `onSnapshot` (no restart) | **PASS** (unit/controller lab) |
| 6 | Config unavailable → fallback; location updates continue | **PASS** (error callback + try/catch keep config; GPS watch untouched) |
| 7 | No bleed into dispatch match, ride assignment, P2P, Firebase backup, customer | **PASS** (scoped diff + idle keys unused by matcher) |
| 8 | Report with screenshots / tests / files / risks | **This document** |
| 9 | No P1-B until P1-A validated + explicitly approved | **Stopped** |

---

## Production baseline (Option A)

| Knob | Constant / default | Value |
|------|--------------------|-------|
| Idle interval | `IDLE_LOCATION_INTERVAL_MS` = `RESPONSIVE_INTERVAL_MS` | **4000 ms (4 s)** |
| Idle move | `MIN_LOCATION_MOVE_M` (idle uses `getIdleMoveMeters()`) | **10 m** |
| Gate | move **OR** interval | unchanged |

Until `settings/dispatch` contains valid `idleLocationIntervalMs` / `idleLocationMoveMeters`, driver behaviour matches `origin/main`.

---

## Lab test results

**Artifact:** `tests/p1a-option-a-lab-results.json`  
**Overall:** **PASS** (10/10)

| Test | Result |
|------|--------|
| defaults-match-production-4s | PASS |
| defaults-match-production-10m | PASS |
| normalize-empty → 4000 / 10 | PASS |
| idle-decision-default-4s | PASS |
| hot-apply-without-restart (setIdlePublishConfig → 180s / 200m) | PASS |
| fallback-keeps-last-on-bad-omit | PASS |
| restore-defaults | PASS |
| OR-move / OR-block / OR-time | PASS |

### Hot config (no restart) — how verified

1. Controller starts with default idle decision `intervalMs === 4000`.
2. `setIdlePublishConfig({ idleLocationIntervalMs: 180000, idleLocationMoveMeters: 200 })` updates `currentDecision().intervalMs` and `getIdleMoveMeters()` **in the same process** (same path as `onSnapshot` → `normalizeIdlePublishConfig` → `setIdlePublishConfig` in `driver-app.js`).
3. Driver wiring: `startDispatchIdleSettingsWatch()` attaches `onSnapshot(doc(db, "settings", "dispatch"), …)` when location watch starts; exposes `window.__SWIFTGO_IDLE_PUBLISH_CONFIG__` for device checks.

### Config unavailable — how verified

- `onSnapshot` **error** callback: empty — explicitly does **not** stop location; in-memory config retained.
- Handler `try/catch`: on parse failure, keeps last good / default.
- Missing/invalid fields: `normalizeIdlePublishConfig` falls back to **4000 / 10**.
- `stopLocationWatch` only stops the settings watch when GPS watch stops — settings failure never clears `watchPosition`.

### Cross-flow isolation

`git diff origin/main --name-only` (validate branch):

```
driver-app/js/driver-app.js
driver-app/js/location-checkpoint-policy.mjs
functions/bargaining.js
functions/index.js
super-admin-panel/index.html
super-admin-panel/js/admin-app.js
```

- **Not touched:** `customer-app/**`, P2P signaling clients, radar, offer inbox, breadcrumb, partial-fare, Firebase backup paths.
- `readDispatchSettings` returns idle keys for Admin/read; **`matchRideCandidates` does not read idle keys** (only `candidateDriverLimit` / radius rings as before).
- Active-ride checkpoints still use existing presence / P2P sparse / background intervals; idle move override applies only when `!activeExecutionRide?.id`.

---

## Screenshots

| Surface | Status |
|---------|--------|
| Super Admin idle fields | **Code-complete** on validate branch (defaults **4** seconds / **10** meters in HTML). Live UI screenshot **deferred** until authorized validation hosting/deploy (operator rule: no deploy yet). |
| Driver `__SWIFTGO_IDLE_PUBLISH_CONFIG__` | Lab verified via controller; device screenshot after validation deploy. |
| Firestore `settings/dispatch` | N/A until admin Save on a deployed CF + panel. |

**UI fields (Super Admin → Dispatch):**

- `idleLocationIntervalSeconds` — default `4`, range 1–1800 (saved as ms).
- `idleLocationMoveMeters` — default `10`, range 1–5000.
- Helper note: production defaults 4s OR 10m; live apply after Save.

---

## Affected files (+224 / −7 vs `origin/main`)

| File | Change |
|------|--------|
| `driver-app/js/location-checkpoint-policy.mjs` | Option A defaults; normalize + bounds; controller `setIdlePublishConfig` / `getIdleMoveMeters`; idle interval in `resolveCheckpointPolicy` |
| `driver-app/js/driver-app.js` | Idle move from config; `startDispatchIdleSettingsWatch` / stop; safe snapshot fallback |
| `functions/bargaining.js` | `readDispatchSettings` exposes idle keys (defaults 4000 / 10) |
| `functions/index.js` | `setCandidateDriverLimit` merge-writes idle keys with bounds |
| `super-admin-panel/index.html` | Idle interval (seconds) + move (meters) controls |
| `super-admin-panel/js/admin-app.js` | Load / validate / save wiring |

**Commit:** changes are **present in the validate worktree but not yet committed** (awaiting your commit/deploy authorization). Base SHA remains `969f2ff` until first P1-A commit.

---

## Remaining risks

1. **No end-to-end Firebase/device run yet** — lab proves policy + wiring; physical OR gate and Admin→Firestore→driver path still need a **P1-A-only validation deploy** (when you approve).
2. **4s / 10m is dense** — physical “stationary for N minutes” checks are hard at defaults; raise Admin values temporarily for observability (see updated physical checklist), then restore 4 / 10.
3. **Doc missing vs snapshot error** — if `settings/dispatch` **does not exist**, snapshot success with `exists()===false` re-applies normalize defaults (4000/10). Network/permission **errors** keep last in-memory values. Both keep publishing.
4. **Partial CF deploy** — Admin Save needs the updated callable; driver hot-reload only needs Hosting/static driver JS + existing Firestore doc. Deploy order should keep CF + admin panel + driver together for full Admin write path.
5. **Dirty `F:/ride-app` tree** still contains unrelated work and older 5 min / 200 m assumptions — **never** deploy that tree for P1-A.

---

## Explicit stops

- **No validation deploy** until you approve this report and authorize deploy from the clean branch commit.
- **Package P1-B not started.**

---

## Asked next (operator)

1. Approve this Option A lab report (or request fixes).  
2. If approved: authorize **commit** on `validate/p1a-idle-publish-20260805`, then **P1-A-only validation deploy**.  
3. Run physical checklist (Option A edition).  
4. Only after physical PASS + explicit approval → production promote; only then consider **P1-B**.
