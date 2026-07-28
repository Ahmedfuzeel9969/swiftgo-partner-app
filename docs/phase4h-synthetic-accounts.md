# Phase 4H — Synthetic / test accounts protocol

**Rule:** Use only synthetic accounts. Never use real personal, financial, CNIC, or customer data.

## Allowed identity pattern

| Role | Example pattern | Notes |
|---|---|---|
| Customer | `pilot.customer.N@swiftgo.test` | Emulator Auth or dedicated test Google accounts owned by ops |
| Partner / Driver | `pilot.driver.N@swiftgo.test` | Same |
| Owner | `pilot.owner.N@swiftgo.test` | Same |
| Super Admin | Existing claim-admin test users only | Never invite random testers as admin |

Prefer Firebase Auth Emulator for contract drills. If a Production invited web pilot is later approved separately, still use operator-owned test Gmail accounts — not friends’ personal accounts with KYC selfies.

## KYC / media

- Use blank or clearly fake placeholder images labeled `TEST ONLY`.  
- Do not upload anyone’s real CNIC or face.  
- Delete pilot KYC objects after drills when Storage cleanup is approved.

## PIN

- Use throwaway PINs known only to the test operator.  
- Document lockout tests in the incident log if unexpected behavior appears.  
- Never log PIN values in reports.

## Wallet / money

- No real payments.  
- No paid advertising.  
- Emulator wallet balances only unless a separately approved Production pilot explicitly funds a tiny ops-owned wallet.

## Data retention for pilot evidence

- Prefer screenshots without PII.  
- Redact emails in published docs if Production accounts are used later.  
- Store raw ADB logs offline, not in git.
