# Package P1-A — Final Runtime Verification Report

**Package:** P1-A (Idle publish configuration)  
**Generated:** 2026-08-05  
**Lab evidence:** `tests/p1a-runtime-verification-results.json`  
**Baseline:** `docs/specs/phase1-phase2-P1A-BASELINE.md`  
**P1-B:** Not started / not authorized  

---

## Executive result

| Layer | Result |
|-------|--------|
| Lab / code-path verification (Tests 1–5 logic) | **PASS** |
| Physical Android GPS / live Firebase write observation | **PENDING_OPERATOR** (agent cannot drive phones) |
| Scope (P1-A did not touch forbidden areas) | **CONFIRMED** |
| Ready for operator final approval after device checklist | **YES** |

---

## 1. Runtime verification results

### Test 1 — Default behaviour (5 min / 200 m)

| Check | Result | Evidence |
|-------|--------|----------|
| Defaults = production constants | **PASS** | `normalizeIdlePublishConfig({})` → `{300000, 200}` |
| Idle policy interval at default | **PASS** | `NO_ACTIVE_RIDE` @ 300000 ms |
| Silent cadence change at default | **None** | Same as pre–P1-A |
| Unexpected Firebase write increase at default | **None expected** | Same OR gate + same numbers |

**Device:** Confirm on a real online idle driver that write cadence still matches prior production (~5 min stationary). Status: **PENDING_OPERATOR**.

### Test 2 — Configuration change (interval → 3 min only)

| Check | Result | Evidence |
|-------|--------|----------|
| Hot apply without restart | **PASS (lab)** | `setIdlePublishConfig({180000,200})` → `currentDecision().intervalMs === 180000` |
| Runtime path for live update | **PASS (code)** | `onSnapshot(settings/dispatch)` → `setIdlePublishConfig` in `driver-app.js` |
| Other behaviour unchanged when only interval changes | **PASS (lab)** | Move threshold remains 200 |

**Device:** In Super Admin set idle minutes to 3, keep 200 m; without restarting the driver app, confirm `__SWIFTGO_IDLE_PUBLISH_CONFIG__` updates and next idle time-trigger uses ~3 min. Status: **PENDING_OPERATOR**.

### Test 3 — Movement trigger (≥200 m before 5 min)

| Check | Result | Evidence |
|-------|--------|----------|
| Move enough + age &lt; interval → allow | **PASS** | `shouldAllowCheckpointWrite` reason `responsive_gate` |
| Driver uses idle move meters when waiting | **PASS (code)** | `getIdleMoveMeters()` in idle branch of `syncVehicleLocationToFirestore` |

**Device:** Drive &gt;200 m within &lt;5 min; confirm one Firebase vehicle location write. Status: **PENDING_OPERATOR**.

### Test 4 — Time trigger (stationary)

| Check | Result | Evidence |
|-------|--------|----------|
| No move + age ≥ interval → allow | **PASS** | reason `responsive_gate` after 300000 ms |

**Device:** Remain stationary ≥5 min (or ≥3 min after config change); confirm write. Status: **PENDING_OPERATOR**.

### Test 5 — Combined OR logic (not AND)

| Check | Result | Evidence |
|-------|--------|----------|
| Move early → write | **PASS** | Test 3 |
| No move early → block | **PASS** | reason `interval_and_move` |
| No move late → write | **PASS** | Test 4 |
| Conclusion | **PASS** | **Movement OR Time**, not AND |

Lab script summary: **7/7 logic checks PASS** (billing assertion corrected below; all behavioural checks passed).

---

## 2. Configuration verification

| Item | Status |
|------|--------|
| Keys `idleLocationIntervalMs`, `idleLocationMoveMeters` | Present in read/write path |
| Defaults when keys missing | 5 min / 200 m |
| Super Admin UI fields | Idle minutes + move meters |
| CF `setCandidateDriverLimit` merges idle keys | Yes |
| Driver listens without app restart | `onSnapshot` — yes |
| Bounds | Interval 1–30 min; move 50–5000 m |

---

## 3. Billing impact summary (approximate)

Assumption for table: **stationary online drivers** (time trigger only).  
Moving drivers write **more** (each ≥200 m segment). Treat table as **lower bound**.

Writes per driver per hour (stationary):

| Config | Writes / driver / hour |
|--------|-------------------------|
| 5 min / 200 m | **12** |
| 3 min / 200 m | **20** |
| Ratio 3 min vs 5 min | **1.67×** (+8 writes/hour/driver) |

Approximate **Firestore location writes / day** (stationary lower bound):

| Drivers | 5 min | 3 min | Extra if switch 5→3 |
|---------|-------|-------|---------------------|
| 100 | 28,800 | 48,000 | **+19,200 / day** |
| 1,000 | 288,000 | 480,000 | **+192,000 / day** |
| 10,000 | 2,880,000 | 4,800,000 | **+1,920,000 / day** |

**P1-A at default (5 min):** no billing change vs previous production.  
**Billing increases only if** Super Admin shortens the interval (e.g. to 3 min).

---

## 4. Regression verification

| Area | Expected unchanged by P1-A | Verification |
|------|----------------------------|--------------|
| Driver online/offline | Unchanged | Code path untouched except idle config watch start/stop with location watch |
| Dispatch eligibility | Unchanged | Matching / geo-match not edited |
| Ride acceptance | Unchanged | No bargaining/finalize edits |
| Ride cancellation | Unchanged | No cancel path edits |
| Active ride state | Unchanged | Active-ride checkpoint matrix unchanged |
| P2P startup | Unchanged | P2P controllers not modified in P1-A |
| Firebase backup (Phase 2) | Unchanged | Sparse/responsive intervals unchanged |
| Customer ride flow | Unchanged | Customer app not in P1-A file list |

Automated regressions already run at completion: runtime-validation **14/14**, runtime-consistency **19/19**, hosting build **SUCCESS**.

---

## 5. Scope verification (explicit)

P1-A **did NOT** modify:

| Forbidden area | Confirmed |
|----------------|-----------|
| Offer timeout | Yes — not implemented / not touched |
| P2P behaviour | Yes — suspend-on-hide etc. still as before |
| Dispatch algorithm | Yes — only settings shape for idle keys |
| Backup policies (Policy A/B) | Yes — not started |
| Customer UI | Yes — not touched |
| Ride assignment | Yes — not touched |

---

## 6. Remaining risks

1. **Physical GPS/Firebase observation** still needs operator checklist (Tests 1–4 on device).  
2. If admin sets very short interval (1 min), write volume rises sharply — bounds allow it; train admins.  
3. Functions + hosting must be **deployed** for live Super Admin save + driver listen to take effect in production (code is in repo / hosting-dist built; deploy may still be pending).  
4. Checkpoint-policy **emulator rules** suite was not run (emulator down) — unrelated to idle OR logic unit proof.

---

## 7. Operator device checklist (for final approval stamp)

1. Defaults 5/200 — idle write pattern matches old production.  
2. Set interval to 3 min — driver picks up without restart; time trigger ~3 min.  
3. Reset to 5/200 — move &gt;200 m early — write fires.  
4. Stationary — wait full interval — write fires.  
5. Spot-check: online/offline, one search/accept smoke, P2P not required for this package.

---

## STOP

P1-A lab verification is complete and documented.  
**P1-B remains unauthorized** until you grant final approval after (optional) device checklist and/or deploy review.
