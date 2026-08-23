# Ride Assignment SSOT — Technical Priority Report

**Date:** 2026-08-07  
**Context:** Post Package 3 · Packages 1–3 frozen · **Package 4 not started**  
**Scope:** Planning and prioritization only — **no source code modified**

---

## Purpose

Before further dead-code cleanup, classify every **remaining package (4–16)** by real production impact—not just audit hygiene—and recommend **one** next package optimized for:

> **Maximum production stability with minimum risk.**

---

## Evidence baseline (what production already fixed)

These issues were **observed in physical or integration testing** and are **already addressed** in production code (not waiting on Packages 4–16):

| Observed issue | When | Fix status | Remaining package? |
|----------------|------|------------|-------------------|
| Offers never auto-expire (no CF invoke chain) | P1-B physical FAIL | **Fixed** — Fix #1 timers + `expireRideOffer` logging | No |
| Accept after `offerExpiresAt` (server bypass) | P1-B lab + audit | **Fixed** — Fix #3 `acceptCustomerInitialFare` guards | No |
| Driver detail not clearing expired offer | P1-B physical checklist | **Mitigated** — Fix #2 `applyOfferExpiryUi` workaround | **Structural debt → Package 7** |
| Accept-initial button reappears after expiry | P1-B physical / audit B1 | **Mitigated** — `driverOfferRecordExists` + local expire UI | **Residual drift risk → Package 7** |
| Customer/Driver boot failure (missing `.mjs`) | Integration regression 2026-08-05 | **Fixed** — coherent `hosting-dist` + startup health gate | No (operational) |
| Client assign bypass | Pre-SSOT | **Removed** — Packages 1–2 | No |
| Client cancel bypass | Pre-SSOT | **Removed** — Package 3 | No |

**Important:** Server-side assignment and expiry **decisions** are guarded today. Remaining packages mostly address **client duplication**, **latent dead paths**, and **internal CF consolidation**—not open P0 production holes.

---

## 1. Packages that only improve code cleanliness

These packages remove **unwired or already-disabled** code. They do **not** change any active production path if grep/caller proofs hold. Zero user-visible behavior change expected.

| Package | Scope | Why cleanliness-only |
|---------|-------|----------------------|
| **4** | Delete `bargain-capacity.js` | File never imported; no runtime surface |
| **6** | Driver incoming sheet stubs + DOM (LG-08–10) | Functions are no-op stubs; buttons disabled |
| **12** | `ride_requests` archive read path | Read-only simplification; conditional on empty archive |
| **16** | M8 physical sign-off + tag | Validation gate; no code change |

**Near-cleanliness (minimal latent risk, still primarily hygiene):**

| Package | Note |
|---------|------|
| **10** | `bookings/` Firestore rules — security surface shrink, but no active client caller after Package 5 |

---

## 2. Packages that directly improve production reliability

These touch **active** paths, **guarded-but-present** failure modes, or **server authority** that could drift under edge cases.

| Package | Reliability mechanism | Active today? |
|---------|----------------------|---------------|
| **5** | Removes latent `createBooking` Firestore write (LG-02) — bypass vector if ever wired | Dead but **dangerous if invoked** |
| **7** | Eliminates duplicate offer listener + local expire mutation → single inbox truth | **Yes** — driver detail is hot path |
| **8** | Single radar subscription → list/detail cannot diverge on candidate feed | **Yes** — two live listeners |
| **9** | Removes owner global `searching_driver` query (LG-11) | Guarded by `OWNER_FLEET_ONLY`; leak if guard fails |
| **13** | One `assignRideInTransaction` — assign rules cannot drift between two CF bodies | **Yes** — every assign |
| **14** | One `expireOfferIfPastDue` — expiry logic cannot drift across CF entry points | **Yes** — every expire path |
| **15** | Shared offer expiry scheduler — timer behavior consistent across apps | **Yes** — L1/L2 timers |

**Reliability-adjacent (lower immediate impact):**

| Package | Note |
|---------|------|
| **11** | Owner duplicate `advanceActiveRideStatus` — only if owner drives rides |
| **10** | Rules-only; reliability via smaller attack/bypass surface after Package 5 |

---

## 3. Packages that fix real bugs already observed during physical testing

Distinguish **fixed**, **mitigated (workaround)**, and **not observed**.

### Fixed — no package required

- Offer timeout chain not firing → Fix #1  
- Server accept after expiry → Fix #3  
- Hybrid deploy boot breaks → hosting health + coherent build  

### Mitigated — structural fix still open

| Symptom (observed) | Current state | Package that completes fix |
|--------------------|---------------|----------------------------|
| Driver detail vs inbox offer desync | Workaround: `applyOfferExpiryUi` + detail CF expire calls | **7** |
| Accept-initial panel reappears / confusing UX after expiry | Workaround: `driverOfferRecordExists` + local expire | **7** |
| Driver/customer offer state mismatch under timer edge cases | Partially improved; duplicate listeners remain (PL-02, TM-06) | **7** |

### Not observed in physical testing (theoretical / audit-only)

| Package | Issue class |
|---------|-------------|
| **4, 6, 12, 16** | Dead code — no bug reports |
| **5** | No caller today — latent bypass, not observed failure |
| **8** | Double listener — audit flags inconsistency; no dedicated physical FAIL doc |
| **9** | Owner global query — blocked by fleet guard; not observed in driver/customer P1-B runs |
| **10, 11** | Schema / owner fork — not in P1-B physical checklist |
| **13, 14, 15** | Prevent **future** drift/regression — no specific physical FAIL attributed |

**Summary:** Only **Package 7** maps directly to **residual** symptoms from P1-B physical testing. Packages **13–14** prevent recurrence class of P1-B server bugs but those server bugs are **already fixed**.

---

## 4. Packages that only reduce future maintenance cost

Primary value is **developer velocity**, **audit closure**, and **preventing future sync bugs**—not fixing a known live defect today.

| Package | Maintenance benefit |
|---------|---------------------|
| **4** | Removes confusing unwired module |
| **5** | Smaller `data.js`; fewer legacy APIs to grep |
| **6** | Less dead DOM/stubs in driver shell |
| **8** | One radar owner — easier list/detail features |
| **10** | Simpler Firestore rules |
| **11** | Owner/driver parity decision locked in code |
| **12** | One ride collection path in detail |
| **13** | Single assign function to maintain |
| **14** | Single expiry wrapper to maintain |
| **15** | One timer module for both apps |
| **16** | SSOT v1 tag — audit complete |

**Mixed (small latent-risk reduction + maintenance):**

| Package | Note |
|---------|------|
| **9** | Maintenance + removes security footgun if `OWNER_FLEET_ONLY` ever changes |

---

## 5. Goal: maximum production stability with minimum risk

### Decision framework

| Tier | Packages | Stability gain | Risk |
|------|----------|----------------|------|
| **A — Latent bypass removal** | **5** | Removes another unwired client write (`createBooking`) — same class as Package 3 | **Low** — hosting only, 0 callers, proven playbook |
| **B — Pure dead code** | 4, 6, 12 | ~Zero runtime stability gain | **Lowest** |
| **C — Residual P1-B UI debt** | **7** | **Highest** active-path stability gain | **High** — detail/regression surface |
| **D — Active listener merge** | 8 | Medium — feed consistency | **Medium** |
| **E — Guarded owner legacy** | 9, 11 | Low–medium (owner not primary dispatch) | **Medium** |
| **F — Server consolidation** | 13, 14 | High long-term | **High** — functions deploy |
| **G — Polish** | 15 | Medium long-term | **Medium** |
| **H — Validation** | 16 | Confirms stability | **Low** — no code |

**Stability ÷ risk sweet spot:** **Package 5** — removes a **real bypass-class write** (`createBooking` → `bookings/`) with **Package 3–identical** risk profile.  

**Package 7** wins on **absolute stability impact** but **fails** the “minimum risk” constraint. Defer until low-risk latent bypass queue is cleared **or** explicit approval to accept high regression surface.

**Package 4** wins on **absolute minimum risk** but **fails** “maximum production stability” — zero active path.

---

## 6. Full ranking — all remaining packages

Scores: **1 = lowest / worst · 5 = highest / best**  
Risk column: **inverse** — 5 = lowest risk, 1 = highest risk.

| Pkg | Name | Business value | User impact | Prod stability | Risk (5=safe) | Cleanup benefit | **Composite**¹ |
|-----|------|----------------|-------------|----------------|---------------|-----------------|----------------|
| **5** | Customer `data.js` legacy stubs | 3 | 1 | **4** | **5** | 4 | **17** |
| **4** | `bargain-capacity.js` delete | 2 | 1 | 1 | **5** | 4 | 13 |
| **6** | Driver incoming sheet | 2 | 1 | 1 | **5** | 4 | 13 |
| **10** | `bookings/` rules (after 5) | 3 | 1 | 3 | 4 | 3 | 14 |
| **12** | `ride_requests` archive path | 2 | 1 | 2 | 4 | 3 | 12 |
| **16** | M8 sign-off | 4 | 2 | 4 | 5 | 1 | 16 |
| **8** | Single radar subscription | 3 | 3 | 3 | 3 | 3 | 15 |
| **9** | Owner legacy listeners | 2 | 1 | 3 | 3 | 3 | 12 |
| **11** | Owner progression dup | 2 | 2 | 2 | 3 | 2 | 11 |
| **15** | Shared expiry scheduler | 3 | 2 | 3 | 3 | 4 | 15 |
| **7** | Detail → inbox merge | **5** | **5** | **5** | 1 | 5 | 21² |
| **13** | M4 assign SSOT | **5** | 4 | **5** | 1 | 4 | 19² |
| **14** | M5 expiry SSOT | **5** | 4 | **5** | 1 | 4 | 19² |

¹ Composite = sum of Business value + User impact + Prod stability + Risk + Cleanup (max 25).  
² High composite driven by stability/value; **Risk score 1 disqualifies for “minimum risk” goal** despite high totals.

### Rank by production stability (impact only)

1. **7** — residual P1-B UI/listener drift (active driver path)  
2. **13, 14** — server authority consolidation (all assigns/expires)  
3. **5** — latent client write removal  
4. **8** — radar listener dedup  
5. **9** — owner global query removal  
6. **15** — timer unification  
7. **10** — rules shrink  
8. **4, 6, 11, 12, 16** — hygiene / validation  

### Rank by risk (safest first)

1. **4, 6** (tie)  
2. **5, 10, 12, 16**  
3. **8, 9, 11, 15**  
4. **7, 13, 14**  

### Rank for goal: **stability × safety** (recommended order)

1. **Package 5** ← **recommended next**  
2. Package 4  
3. Package 6  
4. Package 10 (after 5)  
5. Package 8  
6. Package 16 (when ready for sign-off wave)  
7. Package 9  
8. Package 12  
9. Package 11  
10. Package 15  
11. Package 7 (high value — schedule with full physical checklist)  
12. Package 13  
13. Package 14  

---

## 7. Single recommendation

### **Next package: Package 5 — Remove customer `data.js` legacy stubs**

| Criterion | Fit |
|-----------|-----|
| **Maximum production stability (within low-risk tier)** | Removes `createBooking` latent Firestore write to legacy `bookings/` (LG-02) — same bypass **class** as removed `cancelRideRequest` |
| **Minimum risk** | 0 production callers; hosting-only deploy; identical disable → test → deploy → physical → delete process as Packages 1–3 |
| **Not cleanliness-only** | Closes a rules-adjacent bypass vector; unblocks Package 10 (rules) |
| **Not the highest absolute stability** | Package 7/13/14 beat it on active-path impact — but those violate minimum risk |
| **Does not fix observed P1-B UI bugs** | Those are Package 7 — defer until explicit high-risk approval |

**Scope (unchanged from status report):**  
`watchBookings`, `createBooking`, `acceptDriverOffer`, `rejectDriverOffer`, `counterDriverOffer`, `createRideRequest` in `customer-app/js/data.js` only.

**Explicitly not recommended next:**

| Package | Why not now |
|---------|-------------|
| **4** | Safe but **stability-neutral** — do immediately after 5 if batching approvals |
| **7** | Best for **residual P1-B UI bugs** — but **High** risk; wrong for “minimum risk” |
| **13/14** | Highest long-term stability — **functions deploy**; wrong for “minimum risk” |

---

## 8. Package classification matrix (quick reference)

| Pkg | Cleanliness only | Prod reliability | Fixes observed physical bugs | Maintenance only |
|-----|------------------|------------------|------------------------------|------------------|
| 4 | **Primary** | — | — | Yes |
| 5 | Partial | **Yes** | — (latent) | Partial |
| 6 | **Primary** | — | — | Yes |
| 7 | — | **Yes** | **Yes (residual)** | Partial |
| 8 | — | **Yes** | — | Yes |
| 9 | Partial | Partial | — | Yes |
| 10 | Partial | Partial | — | **Primary** |
| 11 | — | Partial | — | **Primary** |
| 12 | **Primary** | — | — | Yes |
| 13 | — | **Yes** | Prevent recurrence | **Primary** |
| 14 | — | **Yes** | Prevent recurrence | **Primary** |
| 15 | — | Partial | — | **Primary** |
| 16 | — | Validates | — | **Primary** |

---

## 9. Stop conditions (unchanged)

- Do **not** start Package 4 or 5 until explicit approval naming the package  
- Do **not** combine packages  
- Do **not** start P2-C  
- One business flow per package  

---

**End of Technical Priority Report. No source code modified. Package 4 not started.**
