# PHASE 3A — Billing Safety Plan

**Status:** **PREPARED ONLY — NOT ACTIVATED**  
**Date:** 2026-07-27  

This document is a runbook for a future Blaze-controlled pilot. Phase 3A did **not**:

- enable Blaze or billing  
- create budgets or alerts in Google Cloud  
- deploy to Production  
- generate paid API traffic  

---

## 1. Project & environment separation

| Environment | Project | Billing | Traffic |
|---|---|---|---|
| Local / CI | `demo-swiftgo-phase1` (emulators) | None | Emulator only |
| Staging (recommended) | Separate Firebase project | Optional Blaze with hard review | Synthetic + staff only |
| Production | `swiftgo-ride-app` | Blaze **only after** written approval | Real users |

Rules:

- Never point local apps at Production without explicit approval.  
- Prefer `?emulators=1` / demo project for four-app browser tests.  
- No Production load tests.

---

## 2. Budget alerts (warnings, not hard caps)

> **Critical wording:** A Google Cloud **budget alert is a notification**, not a guaranteed hard spending cap, unless a separately documented enforcement mechanism (e.g. automated disable script you own) is verified against current Google Cloud documentation.

Recommended (when billing is later enabled):

1. Budget #1 — daily pilot threshold (e.g. $5–20/day) → email + chat  
2. Budget #2 — monthly envelope (pilot vs early) → escalate  
3. Alert on **Firestore write** and **read** metric spikes (not only $)  
4. Document owner on-call for first 14 pilot days  

Do **not** describe budgets as “the system cannot spend more than X” unless enforcement is proven.

---

## 3. Usage dashboards & monitoring

| Signal | Where | Cadence |
|---|---|---|
| Firestore reads/writes/deletes | Google Cloud Monitoring / Firebase Usage | Daily pilot; weekly later |
| Functions invocations + errors | Cloud Logging / Functions metrics | Daily |
| Storage bandwidth | Firebase Usage | Weekly |
| Hosting bandwidth | Firebase Hosting | Weekly |
| Match latency / timeout | Custom logs on `matchRideCandidates` | Daily |

---

## 4. Abnormal-spike alerts

Trigger investigation if any of:

- Writes/hour > 2× 7-day baseline  
- Reads/hour > 3× baseline  
- Function error rate > 5%  
- Single admin session open > 8 hours with live map  
- Settlement retries/hour anomalous  

---

## 5. Emergency feature flags (design — not shipped as new product flags in 3A)

| Flag | Effect |
|---|---|
| `disableAdminLiveMap` | Force `stopFleetMap`; hide map nav |
| `disableOwnerLiveFleet` | Owner dashboard polling only / closed by default |
| `locationWritesPaused` | Online drivers keep local GPS; pause Firebase snapshots (ops emergency only) |
| `matchRateLimit` | Queue / cooldown matching per customer |
| `disableNonEssentialAudits` | Reduce verbose audit writes |

Larger matching architecture changes remain **out of scope** until approved.

---

## 6. Safe Functions traffic reduction

- Rely on existing settlement **idempotency** (confirmed S12).  
- Avoid client tight-loops calling `matchRideCandidates`.  
- Back off cancel/match storms with UI disable + server rejection.  
- Do not add new fan-out Functions without cost review.

---

## 7. Incident & rollback procedure

1. Acknowledge budget/metric alert within 15 minutes (pilot).  
2. Disable expensive optional listeners (admin map / owner live).  
3. If location write anomaly: confirm clients are on 60s build; block old 8s bundles via Hosting rollback to last known-good.  
4. If match scan melts reads: temporarily lower online fleet (ops) and open incident for geo-match approval — **do not silently change candidate 10/20 without approval**.  
5. Capture timeline in `docs/` incident note.  
6. Only re-enable after metrics normalize.

---

## 8. Daily cost review (pilot checklist)

- [ ] Yesterday’s Firestore R/W vs free tier  
- [ ] Top Functions by invocation  
- [ ] Admin console hours × live map  
- [ ] Failed settlement retry count  
- [ ] Any deploy that changed listeners or location interval  

---

## Activation gate

This plan activates only after explicit written approval to enable Blaze **and** create budgets. Phase 3A stops short of that step.
