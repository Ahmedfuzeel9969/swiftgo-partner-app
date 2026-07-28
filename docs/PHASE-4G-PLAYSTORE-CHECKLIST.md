# PHASE 4G — Play Store Checklist

**Date:** 2026-07-28  
**Upload this phase:** **NO**

## Packaging

| Item | Status |
|---|---|
| Android projects | Ready (`mobile/*/android`) |
| Unique application IDs | Ready |
| versionName / versionCode | Ready (`1.0.0-phase4g` / `10000`) |
| Release signing wiring | Ready (secrets not in git) |
| AAB produced here | **PASS** (customer / partner / owner signed AABs; not uploaded) |
| Firebase Android apps + `google-services.json` | **Pending operator** (examples only) |
| Icons / splash | Capacitor defaults — replace before public listing |
| Deep links | Manifest intent-filters present; `assetlinks.json` hosting **pending** |
| Emulator-safe vs Production | Production web config bundled; emulator opt-in only |

## Trust / policy

| Item | Status |
|---|---|
| Privacy Policy link | In bundled web + `/legal/privacy.html` |
| Terms link | In bundled web + `/legal/terms.html` |
| Account deletion | Phase 4E request flow |
| Data Safety draft | `docs/phase4g-store-assets/data-safety-draft.md` |
| Store descriptions | Drafts under `docs/phase4g-store-assets/` |
| Screenshots / feature graphic | **Not captured** — produce on device builds before listing |
| Internal testing notes | Draft ready |

## Distribution

| App | Track recommendation |
|---|---|
| Customer | Public when approved |
| Partner | Public or closed→public |
| Owner | Closed/internal first |
| Admin | **Do not upload** |

## Gate before any Play upload (separate approval)

1. Successful signed AABs on a networked build machine  
2. Real Firebase Android configs  
3. Screenshots + feature graphic  
4. Legal review of Data Safety + location disclosures  
5. Written upload approval
