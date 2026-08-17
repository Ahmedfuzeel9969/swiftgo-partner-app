# Package P1-A — Physical Device Validation Checklist (Option A)

**Status:** Awaiting operator PASS after authorized **P1-A-only** validation deploy.  
**Code defaults (must remain):** Idle interval = **4 seconds**, move = **10 meters**.  
**Recommended physical observability config (Admin override only):** e.g. **60 seconds** / **50 meters** — then restore **4 / 10** after tests.  
**Devices:** 1 Driver (+ optional Customer for smoke only).  
**Agent cannot operate phones** — operator must run and mark PASS/FAIL.  
**Deploy source:** clean branch `validate/p1a-idle-publish-20260805` only — **never** dirty `F:/ride-app`.

---

## Prep

1. Deploy **only** P1-A from the clean validate branch (after lab report approval + commit).
2. Confirm **before any Admin edit**: driver online → console  
   `window.__SWIFTGO_IDLE_PUBLISH_CONFIG__`  
   expect `{ idleLocationIntervalMs: 4000, idleLocationMoveMeters: 10 }`  
   (or equivalent if keys absent and code defaults apply).
3. Super Admin → Dispatch: set idle **60** seconds, move **50** m → Save (observability only).
4. **Do not** restart driver app. Confirm console updates to `{ idleLocationIntervalMs: 60000, idleLocationMoveMeters: 50 }`.
5. Open Firebase Console → `vehicles/{driverVehicleId}` → watch `locationUpdatedAt`.

| Prep item | PASS / FAIL | Notes |
|-----------|-------------|-------|
| Defaults 4s / 10m before Admin edit | | |
| Admin 60s / 50m saved | | |
| Hot apply without restart | | |
| Driver online + GPS | | |

---

## Scenario 1 — Stationary (interval)

**Action:** Driver stays still ~70+ seconds with Admin **60s / 50m**.  
**Expect:** No burst; publish ≈ after 60 seconds while stationary.

| Check | PASS / FAIL | Notes |
|-------|-------------|-------|
| No unnecessary move-triggered writes while still | | |
| One time-based publish ≈ 60 s | | |
| No write burst | | |

---

## Scenario 2 — Movement OR (before interval)

**Action:** Move driver **>50 m** before 60 seconds.  
**Expect:** Publish on move; timer need not expire.

| Check | PASS / FAIL | Notes |
|-------|-------------|-------|
| Publish on >50 m move | | |
| Occurred before 60 s elapsed | | |

---

## Scenario 3 — Live config change (no app restart)

**Action:** Super Admin change idle seconds **60 → 30**, keep **50** m; **do not** restart driver.  
**Expect:** `__SWIFTGO_IDLE_PUBLISH_CONFIG__` updates; next idle time-trigger ≈ **30** seconds.

| Check | PASS / FAIL | Notes |
|-------|-------------|-------|
| Config updated in console without restart | | |
| Stationary publish cadence ≈ 30 s | | |

---

## Scenario 4 — Fallback (config unavailable)

**Action:** Simulate offline / rules deny on `settings/dispatch` if practical, **or** note lab-covered error path.  
**Expect:** Driver keeps last-known idle config; GPS / vehicle updates **continue**.

| Check | PASS / FAIL | Notes |
|-------|-------------|-------|
| Location updates continue | | |
| No hard stop / crash | | |

---

## Scenario 5 — Restore production defaults

**Action:** Super Admin set idle **4** seconds, move **10** m → Save (or clear keys only if product supports; prefer explicit 4 / 10).  
**Expect:** Driver returns to production cadence without restart.

| Check | PASS / FAIL | Notes |
|-------|-------------|-------|
| Console shows 4000 / 10 | | |
| Publish behaviour matches prior production density | | |

---

## Scenario 6 — No bleed (smoke)

**Action:** One short booking smoke (offer → accept optional). Spot-check P2P / customer map not broken for an active ride.

| Check | PASS / FAIL | Notes |
|-------|-------------|-------|
| Dispatch / offer still works | | |
| Active-ride tracking still works | | |
| Customer flow smoke OK | | |

---

## Sign-off

| Role | Name | Date | Result |
|------|------|------|--------|
| Operator | | | PASS / FAIL |

**Only after PASS + explicit approval:** production promote. **Do not start P1-B** until then.
