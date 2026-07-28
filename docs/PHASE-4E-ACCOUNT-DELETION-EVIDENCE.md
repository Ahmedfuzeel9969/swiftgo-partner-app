# PHASE 4E — Account Deletion Evidence

**Date:** 2026-07-28  
**Harness:** `npm run test:phase4e-deletion`  
**Results:** `tests/phase4e-account-deletion-results.json`

## Guarantees verified on emulators

| Check | Result |
|---|---|
| `requestAccountDeletion` returns `ok` | PASS |
| Response lists retained categories including `ledger_transactions` | PASS |
| `account_deletion_requests/{uid}` status `pending` | PASS |
| User soft-marked `deletionRequested` + `accountStatus=deletion_pending` | PASS |
| Seeded ledger document still exists after request | PASS |
| Seeded audit document still exists after request | PASS |
| Auth user `disabled === true` | PASS |
| `submitSupportReport` stores open report | PASS |

## What deletion does **not** do

- Does not erase wallet ledger rows  
- Does not erase settlement / fare history  
- Does not erase audit logs  
- Does not silently purge KYC storage blobs in this phase (operator follow-up; listed in legal review)

## Client paths

| App | Control | After success |
|---|---|---|
| Customer | Contact → Request account deletion | Status message + `logout()` |
| Partner | Sidebar → Delete account | Status + `logoutPartner()` |
| Owner | Sidebar → Delete account | Status + `logoutPartner()` |
| Admin | Support/legal links only | Operator accounts handled offline / claims process |

## Operator follow-up (not automated here)

1. Review `account_deletion_requests` queue  
2. Confirm retained financial windows with counsel  
3. Optionally purge non-required PII after retention clock  

---

See also: `PHASE-4E-LEGAL-REVIEW-ITEMS.md`
