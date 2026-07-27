# PHASE 3C — No-Cost Precheck

**Date:** 2026-07-27  
**Override applied:** ZERO/NO-COST SAFETY OVERRIDE  
**Action taken:** **STOP before any deployment**

## 1. Blaze / billing enablement

| Check | Result |
|---|---|
| Agent enabled Blaze | **No** |
| Agent attached/changed billing account | **No** |
| Separate explicit user approval for Blaze on a **dedicated staging** project | **Not present** in this override message |
| Proceed to deploy | **No** |

## 2. Project identity

| Item | Finding |
|---|---|
| `.firebaserc` default | `swiftgo-ride-app` (**Production**) |
| Active CLI project | `swiftgo-ride-app` |
| Dedicated staging project ID | **Not found** |
| Firebase projects visible to CLI | `swiftgo-ride-app`, `ravo-44c4c`, and unrelated projects — **none named/aliased as SwiftGo staging** |
| Emulator / demo project | `demo-swiftgo-phase1` (local only; not a cloud staging project) |

**Rule:** Never use Production or an uncertain project → cloud staging deploy is **not permitted**.

## 3. Usage / remaining no-cost quotas

| Check | Result |
|---|---|
| Staging project usage dashboard | **N/A — no staging project** |
| Remaining Spark/Blaze free allowances on staging | **Cannot verify** |
| Billing-account-level shared Cloud Functions free allowance across other projects | **Cannot verify** (no approved staging billing account identified) |
| Production billing deep-inspect | **Not performed** (would target Production; blocked by safety override) |

## 4. Pre-deploy usage estimate (if a real Blaze staging deploy were attempted)

These are **worst-case planning estimates**, not a bill. They assume one controlled deploy cycle + progressive tests under internal caps.

| Surface | Worst-case estimate | Charge risk |
|---|---|---|
| Firestore indexes deploy | Index build jobs; reads during build vary | Usually small; **not guaranteed $0** |
| Firestore rules deploy | Metadata write | Typically negligible; **not guaranteed $0** |
| Cloud Functions deploy (once) | Cloud Build + Artifact Registry + image storage + logging | **Often the first unavoidable paid-path risk** even with free-tier headroom |
| Hosting deploy (once) | Transfer + storage for four apps (order ~tens of MB) | May stay in free Hosting allowance; **not guaranteed** |
| Progressive tests (≤20 drivers, ≤10 customers, ≤10 complete rides) | Well under internal caps if monitored | Still burns Blaze free quotas shared at billing-account level |

**Internal caps (safety, not Firebase guarantees):**

- ≤20 synthetic drivers, ≤10 customers  
- ≤10 complete rides + ≤10 partial  
- ≤200 Function invocations, ≤5k reads, ≤2k writes, ≤200 deletes  
- ≤25 MB Storage, ≤100 MB Hosting transfer  
- No load/soak/burst/concurrency  

## 5. Unavoidable-charge assessment

| Question | Answer |
|---|---|
| Can real staging Functions/Hosting deploy be proven to create **no** charge under all conditions? | **No** |
| Do budget alerts hard-cap spend? | **No** — alerts are warnings only |
| Does ZERO/NO-COST override require stopping if charge cannot be ruled out? | **Yes** |

Therefore: **do not deploy to Blaze**. Continue **Firebase Emulator Suite only**.

## 6. Precheck decision

**DEPLOYMENT BLOCKED**

Required before any future cloud staging attempt:

1. Dedicated staging Firebase project ID (not Production).  
2. Explicit written Blaze approval **for that staging project only**.  
3. Verified billing account, free-quota headroom, and shared-Functions-allowance check.  
4. Separate approval to configure **low** budget alerts (alerts ≠ hard caps).  
5. User acceptance that a **small, monitored billing risk** remains even when staying under free allowances.
