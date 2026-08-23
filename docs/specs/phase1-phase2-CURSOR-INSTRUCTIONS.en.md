# Cursor Implementation Instructions — Phase 1 / Phase 2 Location & Dispatch

**Authority:** Operator Urdu specification is the single final source of truth.  
**Code mirror:** `docs/specs/phase1-phase2-location-dispatch.spec.mjs`  
**Hard rules:**

1. Do **not** add, remove, reinterpret, or “improve” any rule.
2. Phase 1 and Phase 2 are **fully isolated**. No Phase 1 condition may affect Phase 2; no Phase 2 condition may affect Phase 1.
3. Replace **only** existing logic that implements the **same** concerns. Do not touch unrelated systems (Chat, Voice, Billing UI, Matching unrelated paths, Diagnostics behaviour, etc.) unless a step explicitly lists them.
4. If any rule is ambiguous → **stop**, report, ask. Do not decide.
5. Work in **small stages** (max 2–3 related tasks). After each stage: review, build, run related tests, regression check, report, **wait for approval**. Never continue without approval.
6. Clarifications in `SPEC_CLARIFICATIONS_REQUIRED` must be answered before coding those Phase 2 Firebase save rules.

---

## Recommended stage plan (do not run ahead)

### Stage A — Spec lock (THIS STAGE — done when file exists)
- Add/keep `docs/specs/phase1-phase2-location-dispatch.spec.mjs`
- No runtime wiring
- Report + wait

### Stage B — Phase 1 eligibility only (§1)
- Locate current “driver can receive offers / online list” logic
- Replace **only** eligibility checks to match §1 (no active ride, online, device location on, in-app permission on)
- Tests for eligibility gate only
- Report + wait

### Stage C — Phase 1 Firebase publish cadence (§2–§3)
- Replace idle/waiting location write policy with: first-on, re-on, **200m OR 3 min** (whichever first)
- Keep only latest location (overwrite / delete previous)
- Do not change Phase 2 / in-ride publish paths
- Tests + report + wait

### Stage D — Phase 1 offer fan-out / timeout / cleanup (§4, §8, §10)
- Distance **or** count fan-out; Super Admin configurable limits
- Offer auto-expire on configured timeout
- Delete or archive expired/cancelled offers
- Tests + report + wait

### Stage E — Phase 1 bargaining / accept / atomic / limits (§5–§7, §9)
- Simultaneous multi-driver bargaining unchanged in spirit; ensure accept assigns one driver and closes others
- Atomic first-accept wins
- Driver max 1 active ride; customer max 4 concurrent rides
- Tests + report + wait

### Stage F — Phase 2 P2P continuous delivery + close conditions (§1 P2P part)
- P2P remains primary; deliver location with screen open/closed/background while P2P in use
- Close P2P only on: offline, trip complete, trip cancel, location permission off
- **Do not** implement ambiguous Firebase exception until clarifications answered
- Tests + report + wait

### Stage G — Phase 2 Firebase backup (ONLY after clarifications)
- Implement §2 Firebase backup exactly as clarified
- Viewing gate only on Firebase→customer path
- Temporary 300m/1min checkpoint per clarified meaning
- Tests + report + wait

### Stage H — Final dual-phase isolation audit
- Prove Phase 1 timers/distances never applied during Phase 2 path and vice versa
- Full related test suite + regression report

---

## Per-stage report template

1. Files changed  
2. Old logic removed (paths / behaviour)  
3. New logic added (mapped to spec §)  
4. Build result  
5. Tests run + pass/fail  
6. Remaining issues / blockers  
7. Clarifications still open  

**STOP after each stage until operator approval.**
