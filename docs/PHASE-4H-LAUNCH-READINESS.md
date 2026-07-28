# PHASE 4H — Launch Readiness Decisions

**Date:** 2026-07-28  
**Branch:** `phase-4h-internal-pilot`  
**Authority:** Separate written approval still required before any upgrade below.

## Decision matrix

| Track | Decision | Rationale |
|---|---|---|
| **Internal testing** (ops + synthetic accounts, emulator/web, optional sideload AAB) | **APPROVED to proceed** when operators follow synthetic + device runbooks | Contract suites green; packaging ready; no public exposure |
| **Invited closed pilot** (limited real testers on web or Play internal track) | **NOT APPROVED yet** | Physical device matrix incomplete; Production ops gates from 4F (Storage deploy, claims, PIN posture) not executed; no Play upload |
| **Public Play Store launch** | **NOT APPROVED** | Explicitly out of scope; AABs exist but listing/assets/Firebase Android apps incomplete |
| **Paid advertising** | **NOT APPROVED** | Forbidden until public launch readiness is separately approved |

## Entry criteria still open before closed pilot

1. Complete device runbook on ≥2 Android OS versions (Customer + Partner).  
2. Separate approval for any Production Hosting/Functions/Storage deploy.  
3. Real `google-services.json` if using Play internal testing.  
4. Store screenshots / Data Safety review if Play track used.  
5. Confirm Dev Mode / trust labels acceptable on the chosen surface (web vs native).  
6. Empty or acceptable incident log after a dry run.

## Exit / stop rules for any future pilot

- Settlement or ledger anomaly → freeze invites; run 4F rollback playbook.  
- KYC cross-user read → disable uploads; redeploy Storage rules.  
- Matching outage → keep geo fail-safe; do not re-enable full-fleet scan.

## Summary

Phase 4H establishes **internal-test readiness**, not launch.  
**Public Play + ads remain blocked.**
