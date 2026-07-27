# Phase 1 — Risk Register

| ID | Severity | Apps | Location | Evidence | Business impact | Fix lane |
|----|----------|------|----------|----------|-----------------|----------|
| P1-001 | **P0** | Driver, Admin | `firestore.rules` L522–530; `driver-app.js` L2007–2021 | Emulator T09, T19 PASS (insecure) | Drivers can inflate or adjust wallet/earnings without admin approval — direct financial loss | **Rules** + server settlement |
| P1-002 | **P0** | Customer | `firestore.rules` L164–165; `customer-app/js/data.js` L411–416 | Emulator T05 | Customer can mark ride completed without driver service or commission — fare dispute / fraud | **Rules**; remove dev shortcut |
| P1-003 | **P0** | Driver | `driver-app/js/driver-app.js` `completeRideWithEarnings` | Batch matches open partner rule | Completion may appear to succeed in UI while economics are client-defined | **Server function** or locked rules + single writer |
| P1-004 | **P0** | All | `firestore.rules` L15–18; `super-admin-panel/js/admin-app.js` L42 | Hardcoded email | Compromised owner email = full data/finance control; no rotation | Rules custom claims / server |
| P1-005 | **P1** | Driver | `driver-app.js` L2071–2119 vs rules L246–277 | Accept update missing `farePkr`, `estimatedFare`, `driverBidFare` | Incoming ride accept may fail silently or behave differently from radar | **Client** align payload |
| P1-006 | **P1** | Customer, Driver | `ride-radar-service.js` L20, L241–253 | LIST_LIMIT 40; no km rings | All drivers see all open rides — scale/cost/privacy wrong for Karachi dispatch | **Server** matching |
| P1-007 | **P1** | Customer, Driver | `users` vs `partners` | Two wallet fields | Inconsistent balances across apps | **Contract** merge |
| P1-008 | **P2** | Driver | `firestore.rules` L434–439 | `allow write: if uid == driverId` | Driver profile doc can hold arbitrary fields | Rules schema |
| P1-009 | **P2** | Admin | No collection | Admin block/approve/recharge | No forensic trail for compliance | **Server** audit log |
| P1-010 | **P3** | All | Four `firebase-config.js` | Duplication | Drift on config updates | Build-time shared config |
| P1-011 | **P2** | Driver | `vehicles` read all signed-in | PIN query | Any driver can enumerate vehicles | Rules + server indirection |
| P1-012 | **P2** | Customer | `completeRideRequest` UI exposure | ride-flow may still expose dev complete | Users could skip real ride flow | **Client** remove + rules |
| P1-013 | **P2** | Driver | `accountStatus` block | UI only for online | Blocked driver may still set vehicle online | **Rules** tie to partner status |
| P1-014 | **P3** | Repo | `tests/audit.test.mjs` | ESM import failure | CI cannot gate releases | **Test** fix module resolution |
| P1-015 | **P3** | Customer | `bookings` + `rides` parallel | Two booking systems | Confusing history/analytics | Product consolidation |
| P1-016 | **P2** | All | No Cloud Functions | firebase.json | No trusted compute | **Server** Phase 2+ |
| P1-017 | **P3** | Customer | External OSRM/Nominatim | `routing.js`, `location.js` | API abuse/cost if scaled | Proxy/server |
| P1-018 | **P2** | Driver | 4-digit PIN | `driver-app.js` PIN query | Brute force vehicle hijack if PIN weak | Rate limit / server |
| P1-019 | **P1** | Driver | `ride_requests` create denied | rules L328 | Collection empty unless backend seeds | Backend or remove |
| P1-020 | **P3** | Admin | Recharge approve batch | `admin-app.js` ~684 | No duplicate TID check in rules | Rules + idempotency |

---

## Severity definitions used

- **P0:** Unauthorized access, financial loss, ride corruption, cross-account access  
- **P1:** Serious ride/financial inconsistency or broken dispatch  
- **P2:** Reliability, scale, compliance gaps  
- **P3:** Maintainability and minor quality  

---

## Recommended correction ownership

| Lane | Items |
|------|-------|
| Firestore Rules | P1-001, P1-002, P1-013, P1-018 (partial) |
| Cloud Functions / Run | P1-003, P1-006, P1-016, P1-019 |
| Client apps | P1-005, P1-012, P1-010 |
| Data contract | P1-007, P1-015 |
| Operations / identity | P1-004 |

No corrections applied in Phase 1.
