# PHASE 4H — Incident Log

**Phase window:** 2026-07-28  
**Rule:** Log pilot/internal-test incidents here. Redact PII, PINs, tokens, KYC.

## Open incidents

_None._

## Resolved / observed during Phase 4H prep

| ID | Severity | Summary | Impact | Resolution |
|---|---|---|---|---|
| 4H-OBS-001 | Info | No Android device on `adb` | Physical matrix BLOCKED | Use device runbook when hardware available |
| 4H-OBS-002 | Info | i18n scan notes Latin `KYC` inside one Urdu string | Cosmetic purity warning | Accepted for pilot prep; optional copy cleanup later |

## Incident template (copy per event)

```text
ID:
When (UTC+5):
App (customer/partner/owner/admin):
Build (versionName / versionCode):
Account type (synthetic only):
Steps:
Expected:
Actual:
Severity (S1–S4):
Workaround:
Owner:
Status (open/mitigated/closed):
```

## Escalation

1. Freeze expanding the tester list.  
2. Capture Cloud Logging / emulator logs offline.  
3. Follow `docs/PHASE-4F-MONITORING-AND-ROLLBACK.md` for settlement or matching faults.  
4. Do not delete ledger rows.
