# PHASE 4G — Android Architecture

**Date:** 2026-07-28  
**Branch:** `phase-4g-android-play-pipeline`  
**Distribution decision:** see `PHASE-4G-DISTRIBUTION-RECOMMENDATION.md`

## Layout

```text
mobile/
  customer/          Capacitor app  com.swiftgo.customer
  partner/           Capacitor app  com.swiftgo.partner
  owner/             Capacitor app  com.swiftgo.owner
  signing/           keystore README + *.example (secrets gitignored)
tools/phase4g-sync-mobile.mjs
tools/phase4g-apply-android-hardening.mjs
```

Super Admin is **not** packaged.

## Runtime model

1. `npm run build:hosting` builds SPAs into `hosting-dist/`.  
2. `phase4g-sync-mobile` copies slices into each `www/` (gitignored).  
3. `npx cap sync` embeds assets into Android `assets/public`.  
4. Release Gradle build produces AAB with optional signing from `mobile/signing/keystore.properties`.

## Versions

| Setting | Value |
|---|---|
| minSdk | 24 |
| targetSdk / compileSdk | 35 (Android 15 API) |
| versionName | `1.0.0-phase4g` |
| versionCode | `10000` |
| Capacitor | 6.x |

## Production vs emulator

- Bundled web apps use existing Production Firebase web config by default.  
- Emulator mode remains opt-in (`?emulators=1` / localStorage) and should not be used for Play release builds.  
- Real Android `google-services.json` is **not** committed; operators add per-app files after creating Firebase Android apps.

## Native capabilities

| Capability | Customer | Partner | Owner |
|---|---|---|---|
| Network status plugin | yes | yes | yes |
| Geolocation plugin | yes | yes | yes |
| Notifications permission (13+) | yes | yes | yes |
| Background location | no | **yes** | no |
| Deep links https + `swiftgo://` | yes | yes | yes |
| Account deletion / legal | via bundled web UI (Phase 4E) | same | same |

## Process recovery

- `launchMode=singleTask` on MainActivity.  
- Web app already rehydrates auth via Firebase `onAuthStateChanged` after process death.  
- Partner should request battery optimization exemption (permission declared; UX copy in store assets).
