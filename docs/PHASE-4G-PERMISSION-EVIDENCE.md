# PHASE 4G — Permission Evidence

**Date:** 2026-07-28

## Manifest declarations

### Customer (`com.swiftgo.customer`)

- `INTERNET`, `ACCESS_NETWORK_STATE`  
- `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`  
- `POST_NOTIFICATIONS` (Android 13+)

### Partner (`com.swiftgo.partner`)

- All Customer permissions, plus:  
- `ACCESS_BACKGROUND_LOCATION`  
- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`  
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`

### Owner (`com.swiftgo.owner`)

- Same class as Customer (no background location)

## Runtime explanation UX

| Permission | Explanation |
|---|---|
| Location | Phase 4E in-web dialog before geolocation (`ensureLocationPermissionExplained`) + system dialog via Capacitor Geolocation |
| Camera / KYC | Phase 4E camera explanation before `getUserMedia` |
| Notifications | Declared for Android 13+; request at runtime when notification features are enabled with FCM |
| Background location (Partner) | Store listing + in-app online toggle should state matching needs location while online; Android 10+ requires foreground grant before background |

## Android 13 / 14 / 15

- `targetSdkVersion = 35`  
- `POST_NOTIFICATIONS` required on 33+  
- Background location is a separate permission prompt on 10+ / stricter on 14+  
- Photo picker / partial media not used for KYC yet (file/camera inputs in WebView)

## Battery optimization (Partner)

- Permission declared.  
- Operators should guide drivers to exempt SwiftGo Driver in OEM battery settings for reliable online location.  
- Full OEM-by-OEM automation is out of scope; document in release notes.

## Network status

- `@capacitor/network` included for native shells.  
- Web `navigator.onLine` remains fallback.
