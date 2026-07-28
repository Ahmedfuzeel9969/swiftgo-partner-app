# Hosting-Only Production Deploy

**Date:** 2026-07-28  
**Approval:** User chose option 1 — Hosting only (not full stack)  
**Git tip deployed from:** `main` @ `73c9ee8`  
**Project:** `swiftgo-ride-app`

## Deployed

| Surface | Deployed? |
|---|---|
| Firebase Hosting (all four web apps + legal + assetlinks draft) | **Yes** |
| Cloud Functions | **No** |
| Firestore Rules | **No** |
| Storage Rules | **No** |
| Firestore Indexes | **No** |

## Command

```text
npm run build:hosting
firebase deploy --only hosting --project swiftgo-ride-app
```

**Result:** Deploy complete  
**Hosting URL:** https://swiftgo-ride-app.web.app

## App paths

| App | URL |
|---|---|
| Customer | https://swiftgo-ride-app.web.app/ |
| Customer (alias) | https://swiftgo-ride-app.web.app/customer/ |
| Partner | https://swiftgo-ride-app.web.app/partner/ |
| Owner | https://swiftgo-ride-app.web.app/owner/ |
| Admin | https://swiftgo-ride-app.web.app/admin/ |
| Legal | https://swiftgo-ride-app.web.app/legal/privacy.html |

## Note

Backend callables/rules on Production remain whatever was last deployed before this Hosting-only release. New Phase 4E–4F function/rule code is in git but **not** live until a separate full-stack approval.
