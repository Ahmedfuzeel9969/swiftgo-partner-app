# Phase 1 — Risk Register

**Audit date:** 2026-07-29  
**Verdict context:** CONDITIONAL PASS (score 78/100)  
**Policy:** Findings only — no production fixes in this phase

---

## P0 — Unauthorized access, financial loss, ride corruption, cross-account

### P1-2026-001 — Client `rides` create bypasses booking slots / auto-match

| Field | Detail |
|-------|--------|
| Severity | **P0** |
| Apps | Customer (any Auth client) |
| File / line | `firestore.rules` ~222–223 (`allow create` + `isValidRide`); leftover `customer-app/js/data.js` `createRideRequest` ~324 |
| Evidence | Phase1 T01 **PASS** proves client create still succeeds; live UI uses CF but SDK/console can bypass `booking_slots` and skip auto-match |
| Business impact | Customer can open unlimited searching rides without gate; drivers may never be invited |
| Correction | Deny client create; Admin SDK / CF only |
| Layer | **Rules** (+ remove/guard client helper) |

### P1-2026-002 — Partner rating aggregates forgeable by any signed-in user

| Field | Detail |
|-------|--------|
| Severity | **P0** |
| Apps | All signed-in clients |
| File / line | `firestore.rules` ~492–500 (`customerRatingSum` / `customerRatingCount` increment without ride ownership check) |
| Evidence | Rules allowlist; UI checks in `data.js` are not security |
| Business impact | Fake driver ratings / reputation abuse |
| Correction | Require completed ride ownership in Rules or move to CF |
| Layer | **Rules** or **Server** |

### P1-2026-003 — Super Admin email bootstrap default-on

| Field | Detail |
|-------|--------|
| Severity | **P0** |
| Apps | Admin + all Rules paths using `isSuperAdmin()` |
| File / line | `firestore.rules` ~26–33; `functions/admin-claims.js` ~10,28–31; `super-admin-panel/js/admin-app.js` ~44 |
| Evidence | Missing `settings/security` → bootstrap enabled; hardcoded email |
| Business impact | Single email identity is full admin if compromised; env-not-driven secret |
| Correction | Set `adminBootstrapEnabled: false` after claim migration; remove hardcode to config |
| Layer | **Rules** + **Server** + Admin ops |

---

## P1 — Breaks rides or serious inconsistency

### P1-2026-004 — Partner self role flip driver↔owner

| Field | Detail |
|-------|--------|
| Severity | **P1** |
| Apps | Driver, Owner |
| File / line | `firestore.rules` `isPartnerSelfSafeUpdate` ~57–66 |
| Evidence | Role in safe update allowlist; Phase1 only denies `admin_driver` |
| Business impact | Driver can create fleet vehicles as owner without Admin approval |
| Correction | Lock role after create; Admin-only change |
| Layer | **Rules** |

### P1-2026-005 — No KYC / approval gate before go-live

| Field | Detail |
|-------|--------|
| Severity | **P1** |
| Apps | Driver, Customer onboarding |
| File / line | `firestore.rules` partner create ~445–447; `driver-app.js` seeds `isApproved: true` ~414; `driver_applications` create-only ~588 |
| Evidence | Matching does not check KYC; applications never approved via Rules |
| Business impact | Unverified drivers receive live rides |
| Correction | Server gate on matching + Admin approve CF |
| Layer | **Server** (+ Rules) |

### P1-2026-006 — Dual cancel status enums

| Field | Detail |
|-------|--------|
| Severity | **P1** |
| Apps | Customer, Admin, reports |
| File / line | CF `cancelled_by_customer` (`bargaining.js`); Rules/client `cancelled_by_user`; settlement cancel list narrow (`settlement.js` ~131) |
| Evidence | Phase1 T16 uses `cancelled_by_user`; cancel-contract uses CF customer status |
| Business impact | History/filters miss cancels; ops confusion |
| Correction | Canonical single status; migrate readers |
| Layer | **Server** + clients |

### P1-2026-007 — Arrived / in_progress are client Rules writes

| Field | Detail |
|-------|--------|
| Severity | **P1** |
| Apps | Driver |
| File / line | `driver-app.js` `advanceActiveRideStatus`; `firestore.rules` assigned status-only branch |
| Evidence | Lifecycle audit; no CF audit trail for these steps |
| Business impact | Harder dispute resolution; cancel race non-transactional |
| Correction | Trusted callables for progress steps |
| Layer | **Server** |

### P1-2026-008 — Admin recharge wallet credit is client-side

| Field | Detail |
|-------|--------|
| Severity | **P1** |
| Apps | Super Admin |
| File / line | `super-admin-panel/js/admin-app.js` ~751–761 |
| Evidence | Relies on Rules `isSuperAdmin()`; no ledger idempotency for recharge |
| Business impact | Double-approve / no financial audit trail for top-ups |
| Correction | Callable + ledger entry |
| Layer | **Server** |

### P1-2026-010 — Soft match + geoCell dependency

| Field | Detail |
|-------|--------|
| Severity | **P1** (ops) |
| Apps | Customer, Driver |
| File / line | `functions/index.js` create soft-match; `geo-match.js`; driver location sync |
| Evidence | Reach suite + live history; create succeeds with `no_candidates` |
| Business impact | “Booking created but driver never sees it” |
| Correction | Already improved (probe + rematch); still monitor `matchingStatus` |
| Layer | Client UX + ops (not necessarily new Rules) |

---

## P2 — Reliability / performance / maintainability

| ID | Title | File | Correction layer |
|----|-------|------|------------------|
| P1-2026-009 | Dual audit (`audit_logs` vs `admin_audit`) | `ride-cancellation.js` ~295 | Server unify |
| P1-2026-011 | Duplicated firebase/i18n modules ×4 | `*/js/firebase*.js`, `i18n.js` | Maintainability |
| P1-2026-012 | Plaintext vehicle PINs / legacy `vehicles.pin` | `vehicle_pins`, `pin-link.js` | Server + data migration |
| P1-2026-013 | `linkVehicleByPin` overwrites role→driver | `functions/pin-link.js` ~111 | Server |
| P1-2026-014 | Storage admin review requires claim only (bootstrap email insufficient) | `storage.rules` | Rules |
| P1-2026-015 | Legacy `bookings` / `ride_requests` / `drivers` | multiple | Deprecate |
| P1-2026-016 | Static audit 2 FAIL (searching UI / partner role routing) | `tests/audit.test.mjs` | Tests or intentional doc |

---

## P3 — Minor

| ID | Title |
|----|-------|
| P1-2026-017 | Admin UI status map missing some terminal enums |
| P1-2026-018 | Rules helper name `isOwner` means document UID owner |
| P1-2026-019 | Offer field `customerId` vs ride `userId` naming |

---

## Closed / mitigated since 2026-07-27 Phase 1 (do not re-open as current P0)

| Former ID | Topic | Current state |
|-----------|-------|---------------|
| Old P1-001 | Driver self wallet write | **Mitigated** — Phase1 T09/T19 PASS |
| Old P1-002 | Customer accepted→completed | **Mitigated** — T05/T14 PASS |
| Old “no Cloud Functions” | Trusted server missing | **Mitigated** — Functions live for booking/match/settle |
| Old “no geo 1/2/3 km” | Global latest driver | **Mitigated** — geo rings + limit 10/20 |

---

## Counts

| Severity | Count (open) |
|----------|--------------|
| P0 | **3** |
| P1 | **6** (004–008, 010) |
| P2 | **8** |
| P3 | **3** |

---

## Recommended remediation order (await approval)

1. Rules: deny client `rides` create (P0-001)  
2. Rules: bind rating increments to completed ride (P0-002)  
3. Ops: disable bootstrap email default (P0-003)  
4. Rules: lock `partners.role` (P1-004)  
5. Server: KYC gate + recharge callable (P1-005, P1-008)

**Next phase recommendation:** Phase 2A Critical contract/rules correction.
