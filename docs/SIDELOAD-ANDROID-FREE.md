# Free-tier Android install (no Play upload)

**Constraint:** No Play Console upload. No Firebase deploy. Local sideload only.

## Prerequisites

- USB debugging on, `adb devices` shows the phone  
- Local signed AAB from Phase 4G (or rebuild with scripts below)  
- Java + Android SDK already used for Phase 4G builds  

## Rebuild AAB (optional)

```text
npm run android:aab:customer
npm run android:aab:partner
npm run android:aab:owner
```

Artifacts:

`mobile/<app>/android/app/build/outputs/bundle/release/app-release.aab`

## Install without Play

Play requires AAB upload for store tracks. For free internal install:

1. Convert AAB → APKs with Google `bundletool` (local jar), **or** build `assembleRelease` APK:

```text
cd mobile/customer/android
gradlew.bat assembleRelease
```

2. Install:

```text
adb install -r app/build/outputs/apk/release/app-release.apk
```

Repeat for partner/owner package IDs as needed. Admin remains web-only.

## Synthetic accounts only

Follow `docs/phase4h-synthetic-accounts.md` and `docs/phase4h-device-runbook.md`.

## Digital Asset Links

Draft file is packaged at `/.well-known/assetlinks.json` by `build:hosting`.  
Replace `REPLACE_WITH_UPLOAD_OR_APP_SIGNING_SHA256` before any future Hosting deploy that should verify App Links. **Do not deploy under no-cost override.**
