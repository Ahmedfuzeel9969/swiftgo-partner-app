# Data Safety form — evidence draft (Phase 4G)

**Status:** Draft for Play Console Data Safety. Not submitted.

## Data collected (approx.)

| Data type | Collected? | Shared? | Purpose |
|---|---|---|---|
| Location | Yes (approx + precise while in use; Partner may use background while online) | With assigned driver/partner for trips | App functionality |
| Personal info (name, email) | Yes (auth) | Backend/Firebase | Account |
| Financial info | Wallet balances / fare records (server) | Not sold | App functionality |
| Photos / KYC docs (driver apply) | Yes when applying | Backend/Storage private paths | Account verification |
| App activity | Rides, offers, support reports | Backend | App functionality |
| Device ids | Firebase / Analytics TBD when Android apps registered | Google infrastructure | Analytics / crash (if enabled later) |

## Security practices

- Data encrypted in transit (HTTPS)
- Account deletion request available in-app (soft-disable; ledger retained — disclose accurately)
- Users can request deletion

## To finalize before submit

- Map exact Firebase Android SDKs once `google-services.json` is added
- Confirm background location disclosure text with legal review (Phase 4E drafts)
- Confirm no third-party ad SDKs (none in Capacitor shells today)
