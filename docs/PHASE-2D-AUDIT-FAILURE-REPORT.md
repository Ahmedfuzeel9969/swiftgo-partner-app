# Phase 2D — Audit Failure Report

**Date:** 2026-07-27  
**Pre-fix:** `npm run test:audit` → 237 passed / **20 failed** / 0 skipped  
**Post-fix:** `npm run test:audit` → **257 passed / 0 failed** (exit 0)

Production Firebase was not touched.

---

## Original 20 failures

| # | Suite | Name | Classification | Resolution | Final |
|---|-------|------|----------------|------------|-------|
| 1 | html | `#earnDriverBtn` | Missing UI wiring | Restored sidebar CTA `id="earnDriverBtn"` | **PASS** |
| 2 | html | `#trafficToggle` | Renamed component | Assert `#btnLayerTraffic` | **PASS** |
| 3 | html | `#mapPickOverlay` | Renamed component | Assert `#mapPinMode` | **PASS** |
| 4 | html | `#mapPickConfirm` | Renamed component | Assert `#mapPinConfirm` | **PASS** |
| 5 | css | Extra stops styles | Renamed CSS | Assert `.route-search__stops` | **PASS** |
| 6 | security | Booking list HTML escaped | Moved helper | Assert `history.js` `escapeHtml` | **PASS** |
| 7 | wiring | Dashboard payment + traffic + lang | Moved wiring | Assert pay sheet + map traffic + `setLang`/`syncLangButtons` | **PASS** |
| 8 | wiring | Promo codes interactive | Renamed constant | Assert `applyPromo` + `FALLBACK_PROMOS` | **PASS** |
| 9 | wiring | Booking persists fare/payment/promo | Real defect | Wire `paymentMethod` into ride create + CF client path | **PASS** |
| 10 | html | Phase 13.1 50/50 header | Renamed/moved UI | Assert `routeSearchCard` pickup/dropoff | **PASS** |
| 11 | i18n | UR promo/GPS/Firebase purity | Stale string | Assert current Urdu `currentLocation` + Firebase strings | **PASS** |
| 12 | wiring | Phase 14.1 OSRM polyline | Stale color | Assert OSRM + polyline + any route color | **PASS** |
| 13 | wiring | Phase 15 fare matrix | Formula evolved | Assert `calculateVehicleFare` + 7-vehicle rates | **PASS** |
| 14 | wiring | Owner app fleet + history | Stale rules string | Drop obsolete `vehiclePlate` pair; keep ownerId/driverName | **PASS** |
| 15 | html | Map clean (no floating controls) | Renamed layout | Assert route-search + no `z-index: 420` | **PASS** |
| 16 | wiring | Dynamic stops universal component | Renamed classes | Assert `route-search__stop` + location gps/map handlers | **PASS** |
| 17 | wiring | Map pick reverse-geocode | Renamed overlay | Assert `mapPinMode` + reverse geocode path | **PASS** |
| 18 | wiring | Nominatim autocomplete | Renamed function | Assert `runSearch` + Nominatim host | **PASS** |
| 19 | wiring | Smart Maps paste | Stale regex | Assert `@(-?\d` style matcher | **PASS** |
| 20 | a11y | Booking tabs `role=tab` | Removed feature | Assert tabs removed + `role="search"` on route card | **PASS** |

---

## Classification counts

| Class | Count |
|-------|------:|
| Stale assertion / renamed component | 16 |
| Missing UI wiring | 1 |
| Real application defect | 1 (`paymentMethod` not persisted on ride create) |
| Environment limitation | 0 |

No tests were deleted, skipped, or weakened below current product truth.
