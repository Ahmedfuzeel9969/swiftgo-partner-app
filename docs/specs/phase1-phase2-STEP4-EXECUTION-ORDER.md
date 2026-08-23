# Step 4 Preflight — Execution Order (NO RUNTIME YET)

**Status:** DOCUMENTATION ONLY — awaiting approval before **any** runtime modification.  
**Blueprint:** `docs/specs/phase1-phase2-STEP3-REPLACEMENT-PLAN.md` (approved)  
**Mapping baseline:** `docs/specs/phase1-phase2-STEP2-RUNTIME-MAPPING.md`  
**Spec:** `docs/specs/phase1-phase2-location-dispatch.spec.mjs`

**Rule:** After each package: Stop → Build → Relevant tests → Regression → Report → **Wait for approval**. Never start the next package without explicit approval.

---

## 0. Locked decisions (from Step 3 Q&A)

| # | Decision |
|---|----------|
| 1 | **Policy A:** arbiter-only + **do not mirror** `rides.driverLocation` while P2P healthy. Customer live location = P2P only when P2P healthy. |
| 2 | **`p2pAvailable`:** single boolean for Backup Mode. True when P2P can reliably deliver live location; false on disconnect/fail/ICE fail/heartbeat timeout/transport closed/etc. All Backup Mode decisions use this flag only. |
| 3 | Keep **search timeout**; add **separate per-offer timeout** (independent). |
| 4 | Prefer **Super Admin / `settings/dispatch`** for configurable knobs (idle interval/distance, offer timeout, search timeout, driver count, radius, backup storage interval/distance, backup delivery interval/distance). No hard-coded production-only values when config exists. |
| 5 | **Multi-offer customer UI:** out of this track (separate track). |

### Config keys to introduce/wire (when each package needs them)

| Key (proposed) | Used by package | Notes |
|----------------|-----------------|-------|
| `idleLocationIntervalMs` | P1-A | Spec example 3 min — load from config |
| `idleLocationMoveMeters` | P1-A | Spec example 200 m |
| `offerTimeoutSeconds` | P1-B | Spec example 30 s |
| `searchTimeoutMs` / existing search expiry | P1-B (read-only keep) + admin | Keep existing behaviour; expose if not already |
| `candidateDriverLimit` | (existing) | Already in dispatch settings |
| `maxSearchRadiusKm` / meters | (existing) | Already in dispatch settings |
| `backupStorageIntervalMs` | P2-B Policy A | Spec example 1 min |
| `backupStorageMoveMeters` | P2-B Policy A | Spec example 300 m |
| `backupDeliveryIntervalMs` | P2-B Policy B | Spec example 20 s |
| `backupDeliveryMoveMeters` | P2-B Policy B | Spec example 200 m |

Exact field names may match existing `settings/dispatch` conventions; chosen in-package with no silent renames of existing keys.

---

## 1. Exact implementation order

| Order | Package | Title | Est. risk | Est. regression risk | Rollback method |
|-------|---------|-------|-----------|----------------------|-----------------|
| **1** | **P1-A** | Idle publish: 200m OR interval from config (spec 3 min example) | **Low** | **Low–Medium** | Revert constant/config default to previous 5 min; redeploy client hosting |
| **2** | **P1-B** | Add per-offer timeout (keep search timeout) | **Medium** | **Medium** | Feature-flag off / remove expiry sweeper + ignore `offerExpiresAt`; redeploy functions (+ client if UI countdown added — prefer server-only first) |
| **3** | **P2-C** | P2P close on offline + location permission off | **Low–Medium** | **Medium** | Revert explicit `stop`/`detach` calls in offline/permission paths |
| **4** | **P2-A** | P2P continues when customer screen hidden; visibility → Firebase only | **High** | **High** | Restore `viewerVisible` → `suspend()` coupling on driver + customer controllers |
| **5** | **P2-B** | Policy A storage + Policy B live delivery + `p2pAvailable` + no mirror while healthy | **High** | **High** | Revert checkpoint policy matrix + mirror gate + arbiter constants; redeploy client + functions |

**Out of order / deferred tracks:** Multi-offer customer bargaining UI. Eligibility OS “location master switch” probe (capability preflight inside a later micro-stage if approved).

---

## 2. Package details

### Order 1 — P1-A Idle interval / movement

| Field | Detail |
|-------|--------|
| **Goal** | Phase 1 idle Firebase publish uses config-driven **move OR interval** (spec examples: 200 m OR 3 min). First-on / re-on unchanged. Latest-only overwrite unchanged. |
| **Risk** | Low |
| **Regression risk** | Low–Medium (rematch freshness, diagnostics CFG equality tests) |
| **Rollback** | Git revert package commits; restore `IDLE_LOCATION_INTERVAL_MS=5min` (or config default); `npm run build:hosting` + hosting deploy if client shipped |
| **Expected files** | `driver-app/js/location-checkpoint-policy.mjs`; possibly `driver-app/js/driver-app.js` (read config); `shared/js/phase1-billing-diagnostics.mjs` CFG; `functions/bargaining.js` / `readDispatchSettings` + Super Admin save/load if new keys; `super-admin-panel/js/admin-app.js`, `admin-settings-client.js`, `functions/index.js` `setCandidateDriverLimit` (or dispatch settings writer); tests asserting 5 min |
| **Not in this package** | Active-ride Policy A/B; P2P; offer timeout |
| **Tests after** | `tests/runtime-validation-phase3.mjs`, `tests/runtime-consistency.mjs`, `tests/cross-device-validation-phase4.mjs`, checkpoint/policy tests, `npm run build:hosting`; smoke: driver online idle write cadence |
| **Stop** | Report → wait approval |

---

### Order 2 — P1-B Per-offer timeout

| Field | Detail |
|-------|--------|
| **Goal** | Independent per-offer expiry from admin config; **keep** existing search timeout. On expiry: offer/candidate closed per §10; does not cancel whole search if other offers remain. |
| **Risk** | Medium (TX races with accept) |
| **Regression risk** | Medium (bargaining, atomic accept, radar) |
| **Rollback** | Disable sweeper/callable; stop writing `offerExpiresAt`; clients ignore; redeploy functions |
| **Expected files** | `functions/bargaining.js` (`submitRideOffer`, new expire helper, cleanup); `functions/matching.js` / index exports; `functions/index.js` schedule or callable; `settings/dispatch` reader/writer + Super Admin UI field; optionally driver/customer listeners already react to `status`; **no** multi-offer UI redesign |
| **Not in this package** | Customer multi-offer UI; Phase 2 location |
| **Tests after** | Bargaining / assign suites (`phase2a-bargaining-suite.mjs`, dispatch radar e2e as applicable); expire-vs-accept race test (add if missing); functions emulator if used; regression: search still expires at 3 min (or admin search timeout) |
| **Stop** | Report → wait approval |

---

### Order 3 — P2-C P2P close conditions

| Field | Detail |
|-------|--------|
| **Goal** | When driver goes offline or location permission is turned off, explicitly close/stop P2P + signaling (in addition to existing complete/cancel paths). Introduce or wire toward shared **`p2pAvailable=false`** on these closes (full flag ownership may complete in P2-B; this package must at least stop transport). |
| **Risk** | Low–Medium |
| **Regression risk** | Medium (offline flow, GPS deny, active ride teardown) |
| **Rollback** | Revert offline/permission handlers to prior behaviour |
| **Expected files** | `driver-app/js/driver-app.js` (`setDriverOffline`, location error handlers, `detachCheckpointPresence` / `driverP2p.stop`); possibly `p2p-ride-controller.mjs` |
| **Not in this package** | Hidden-screen decoupling (P2-A); Policy A/B matrix (P2-B) |
| **Tests after** | P2P close/suspend tests; manual/scripted offline during ride; `tests/p2p-webrtc.mjs` subset; ensure complete/cancel still stop P2P |
| **Stop** | Report → wait approval |

---

### Order 4 — P2-A Hidden screen must not stop P2P

| Field | Detail |
|-------|--------|
| **Goal** | Customer screen visibility must **not** suspend/tear down P2P. Presence/view lifecycle may still affect **Firebase** paths only. P2P stays up for active execution ride subject to close conditions. |
| **Risk** | High (battery/data + long-lived PC) |
| **Regression risk** | High (presence, checkpoint cadence, customer lifecycle, comm DC) |
| **Rollback** | Restore `viewerVisible === false` → `suspend()` on driver `syncForRide` and customer `setVisible(false)` |
| **Expected files** | `driver-app/js/driver-app.js` (`syncDriverP2pForActiveRide`); `driver-app/js/p2p-ride-controller.mjs`; `customer-app/js/p2p-ride-controller.mjs`; `customer-app/js/ride-flow.js` (visibility calls); tests that currently expect suspend-on-hide |
| **Not in this package** | Full Policy A/B rewrite (P2-B); may leave old sparse/responsive cadences temporarily |
| **Tests after** | `tests/p2p-customer-receive.mjs`, `tests/p2p-webrtc.mjs`; verify P2P stays connected when customer hides; presence still stops/starts; Chat/Voice smoke if DC shared; `build:hosting` |
| **Stop** | Report → wait approval |

---

### Order 5 — P2-B Policy A + Policy B + `p2pAvailable`

| Field | Detail |
|-------|--------|
| **Goal** | Single **`p2pAvailable`** boolean drives Backup Mode. **Policy A** (P2P available): storage writes 300m OR 1min (config); **no** `rides.driverLocation` mirror; customer live = P2P only. **Policy B** (`!p2pAvailable`): live 20s OR 200m (config) if customer viewing; durable every 3rd live update; Driver→Firebase→Customer. Retire old 4s/30s/60s matrix as source of truth. |
| **Risk** | High |
| **Regression risk** | High (mirror CF, arbiter, settlement distance sampling, diagnostics, verification reports) |
| **Rollback** | Revert checkpoint policy + mirror gate + `p2pAvailable` wiring + admin keys; redeploy client + functions |
| **Expected files** | `location-checkpoint-policy.mjs`; `driver-app.js`; `functions/driver-location.js` / `mirrorDriverLocationOnVehicleUpdate` (skip/gate mirror when P2P available / storage-only writes); `live-location-source-arbiter.mjs`; `p2p-peer-session` / controllers (expose `p2pAvailable`); protocol constants; Super Admin dispatch settings; phase1/phase2 diagnostics + verification tests |
| **Not in this package** | Multi-offer UI; unrelated billing formula changes |
| **Tests after** | Full checkpoint + P2P + arbiter suites; phase2 runtime verification (update expectations); emulator mirror-gate test; regression: assignment, search, bargaining untouched; `build:hosting`; functions deploy if mirror changed |
| **Stop** | Final package report → wait before any further work |

---

## 3. Cross-cutting rules for every package

1. **Phase isolation:** Phase 1 packages must not alter Phase 2 active-ride delivery; Phase 2 packages must not alter Phase 1 idle eligibility/fan-out except shared config readers.  
2. **No reinterpretation** of the approved spec.  
3. **No multi-offer customer UI** in this track.  
4. **Config over hard-coding** whenever Super Admin / dispatch settings can hold the value.  
5. **Report template after each package:** files changed; old logic removed; new logic added; build result; tests run + pass/fail; residual risks; rollback note executed or ready.

---

## 4. What this document does / does not authorize

| Authorizes | Does **not** authorize |
|------------|-------------------------|
| Ordered blueprint for Step 4 | Starting P1-A coding now |
| Locked Q&A decisions | Editing runtime before approval of this Execution Order |
| Per-package rollback sketches | Combining packages in one PR/stage |

---

## STOP

Execution Order submitted.  

**Do not begin Step 4 / Package P1-A until this document is explicitly approved.**
