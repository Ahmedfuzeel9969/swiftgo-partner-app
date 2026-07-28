# PHASE 4G — AAB Build Evidence

**Date:** 2026-07-28  
**Pipeline:** Capacitor 6 + Gradle `bundleRelease`  
**Play upload:** **Not performed**

## Signing process (secure)

1. Generate upload keystore offline (not in git).  
2. Fill `mobile/signing/keystore.properties` from `.example`.  
3. `android/app/build.gradle` loads `signingConfigs.release` when properties exist.  
4. Never commit `*.jks`, `keystore.properties`, or passwords.

A local-only upload keystore exists on the operator machine for pipeline proof and remains gitignored.

## Commands

```text
node tools/phase4g-sync-mobile.mjs
cd mobile/<app> && npx cap sync
cd android && gradlew.bat bundleRelease
```

Expected artifact:

`mobile/<app>/android/app/build/outputs/bundle/release/app-release.aab`

## This environment result

| App | Result | Notes |
|---|---|---|
| Customer | **PASS** | Signed release AAB produced |
| Partner | **PASS** | Signed release AAB produced |
| Owner | **PASS** | Signed release AAB produced |

First online attempt failed transiently on a UTF-8 BOM in `variables.gradle` (PowerShell `Set-Content -Encoding utf8`). BOM was stripped; rebuild succeeded.

### SHA-256 (local vault copies under `docs/phase4g-aab-output/` — **gitignored**)

| File | Size | SHA-256 |
|---|---|---|
| `customer-release.aab` | ~3.60 MB | `2A84C52045F49268D769D45F3DD5487E33BBE2075264E7744B1DD2EA5B29E929` |
| `partner-release.aab` | ~3.13 MB | `C9140A752E47B0507E790B47FD39297952CA3851A8B62965E00A186DF1A11AF0` |
| `owner-release.aab` | ~3.09 MB | `63B72B9CCF103A0A60F116662F525314832CD0B04EC0D482E741925169BF761D` |

## Verification harness

`npm run test:phase4g` / `node tests/phase4g-android-verify.mjs` asserts project structure, permissions, signing hygiene, and AAB presence.

## Gate

**Play Console upload was not performed.** Separate written approval is required before any track upload.
