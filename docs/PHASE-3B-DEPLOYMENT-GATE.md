# PHASE 3B — Deployment Gate

**Verdict recommendation:** **CONDITIONAL PASS** for a **controlled staging** deploy after explicit approval.  
**This phase did not deploy and did not enable billing.**

## Gate checklist (must all be true before Production)

- [ ] Written approval to deploy Functions + Rules + Indexes + Hosting (clients with `geoCell`)
- [ ] Staging project smoke: match with geo indexes built (`status+geoCell`, `status+hotspotId`)
- [ ] Confirm no `vehicles where status in [online,in_ride]` full scan in deployed Functions bundle
- [ ] Backfill or force location sync so online vehicles have `geoCell`
- [ ] Budget **alerts** configured (warnings — not hard caps) if Blaze already on
- [ ] `npm run test:phase3b` green on CI/emulator
- [ ] Full regression green (phase1/2c/2d/2e/3a/3b/audit/i18n/build)
- [ ] Rollback plan: previous Functions revision + previous Hosting if match miss-rate spikes

## Recommend

| Target | Recommendation |
|---|---|
| Emulator / local | **Ready** |
| Staging | **Yes — controlled**, with index build wait |
| Production | **Not yet** until staging evidence + geoCell coverage confirmed |

## Explicit non-actions completed this phase

- Production Firebase not modified  
- No Blaze / billing enablement  
- No paid load test  
- No Production PIN / admin claim changes  
