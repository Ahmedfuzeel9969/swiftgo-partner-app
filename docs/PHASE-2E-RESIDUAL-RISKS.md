# Phase 2E — Residual Risks

**Date:** 2026-07-27

---

## Deployment / operations

1. **Blaze (pay-as-you-go) required** to deploy Cloud Functions — unchanged blocker from Phase 2C/2D.  
2. Production admin claim bootstrap and PIN inventory/migration still operational steps (emulator-only here).  
3. Local Functions host Node **24** vs `engines.node` **20** — confirm deploy image.

---

## Product / UI

1. Super Admin has **no dedicated ledger/audit screen**; ops visibility is rides/finance + trusted writes. Emulator proved ledger/audit docs exist after settlement.  
2. Driver active-ride sheet can sit outside the Playwright viewport; stage progression sometimes needs force-click or status/settlement callable from the driver page.  
3. Emulator E2E uses `seedRoute` hooks so booking does not depend on Nominatim/OSRM — production still relies on live map/geocode.

---

## Test harness

1. Bargain-limit (10/11) and dual-accept tests create rides / candidates with Admin SDK for setup, then exercise **browser → Functions emulator** callables.  
2. Full wall-clock “two drivers finalize in the same millisecond” and “Functions emulator kill mid-request” are not automated.  
3. Playwright uses system **Chrome** channel (`PHASE2E_BROWSER_CHANNEL`) because Chromium download was unreliable in this environment.

---

## Architecture (intentionally unchanged)

Bargaining model, 1-minute location snapshots, Karachi Grid, progressive 1→2→3 km search, and P2P-with-Firebase-fallback were **not** modified in Phase 2E.
