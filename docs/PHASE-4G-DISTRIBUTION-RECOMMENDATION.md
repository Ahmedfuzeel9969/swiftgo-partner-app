# PHASE 4G — Distribution Recommendation

**Date:** 2026-07-28  
**Branch:** `phase-4g-android-play-pipeline`  
**Rule:** Documented before packaging. Not a guess — based on Phase 4A inventory + approved trust model.

## Recommendation summary

| App | Play distribution | Rationale |
|---|---|---|
| **Customer** | **Public** (production listing when approved) | Consumer acquisition surface; Privacy/Terms/deletion already required |
| **Driver / Partner** | **Public** listing **or** closed testing → gradual public | Operational workforce app; needs background location; public OK if Data Safety + location disclosures complete |
| **Owner** | **Closed / internal testing** first; public optional later | Smaller audience (fleet owners); PIN/fleet sensitivity; prefer invite track until ops stable |
| **Super Admin** | **Not a public Play app** | Privileged console; claim/bootstrap risk; ship as **private web** (`/admin/`) or later **private Play** / managed device only with explicit security decision |

## Application IDs (reserved)

| App | `applicationId` |
|---|---|
| Customer | `com.swiftgo.customer` |
| Partner | `com.swiftgo.partner` |
| Owner | `com.swiftgo.owner` |
| Admin (reserved, not packaged this phase) | `com.swiftgo.admin` |

## Packaging approach

- **Capacitor** WebView shells wrapping the existing Firebase Hosting SPAs (bundled `www/` from `hosting-dist`).
- Separate Android modules under `mobile/{customer,partner,owner}/`.
- Release builds load **Production** Firebase web config already embedded in apps (emulator only via explicit local flags — never default on device release).
- Firebase **Android** apps + real `google-services.json` must be created in Firebase Console before FCM/Analytics Android features; until then placeholders are examples only.

## Super Admin security decision

Super Admin remains **web-only** for Phase 4G:

1. Avoids accidental public sideload of an admin shell.  
2. Keeps custom-claim / bootstrap transition on controlled browsers.  
3. If a native admin client is required later: **private Play track** or MDM-only, never open production listing without a written security approval.

## Store listing posture (when upload approved later)

- Customer: full store presence (screenshots, feature graphic, Data Safety).  
- Partner: same, with prominent location/background-location disclosure.  
- Owner: start on **internal/closed testing**.  
- Admin: no store upload in this program phase.

## Out of scope for this recommendation

- iOS / App Store  
- Publishing or promoting listings  
- Creating real Firebase Android apps without operator console access
