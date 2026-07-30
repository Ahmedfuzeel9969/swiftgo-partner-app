# Phase 1 — Permission Matrix

**Audit date:** 2026-07-29  
**Legend:** ALLOWED · DENIED · CONDITIONAL · NOT IMPLEMENTED · CLIENT-ONLY RISK

---

## Authentication & account

| Action | Customer | Driver | Owner | Super Admin | Rules | Server |
|--------|----------|--------|-------|-------------|-------|--------|
| Sign in (Google) | ALLOWED | ALLOWED | ALLOWED | ALLOWED | Auth | — |
| Email/password | ALLOWED (E2E) | DENIED (UI) | DENIED (UI) | DENIED (UI) | Auth | — |
| Create `users/{uid}` | ALLOWED | — | — | — | ALLOWED (wallet=0) | Soft-delete CF |
| Create `partners` as driver/owner | — | ALLOWED | ALLOWED | — | ALLOWED (not admin_driver) | Pin may force driver |
| Self-set `admin` claim | DENIED | DENIED | DENIED | CONDITIONAL (bootstrap/grant) | DENIED | Claims CF |
| Self `role` → `admin_driver` | — | DENIED | DENIED | — | DENIED | — |
| Self `role` driver↔owner | — | **CLIENT-ONLY RISK** | **CLIENT-ONLY RISK** | — | **ALLOWED** | — |
| Set `accountStatus` blocked/suspended | DENIED | DENIED | DENIED | ALLOWED | Admin | Deletion→pending |
| Open other role’s Hosting URL | ALLOWED (load) | ALLOWED | ALLOWED | ALLOWED | No CDN gate | UI redirects admin-only |

---

## Booking & matching

| Action | Customer | Driver | Owner | Super Admin | Rules | Server |
|--------|----------|--------|-------|-------------|-------|--------|
| Canonical create booking | ALLOWED (CF) | DENIED | DENIED | — | — | `createCustomerBooking` |
| Client direct `rides` create | **CLIENT-ONLY RISK** | DENIED | DENIED | — | **ALLOWED** | Slots bypassed |
| Match / rematch | ALLOWED (CF) | DENIED | DENIED | ALLOWED (CF) | Candidates W DENIED | `matchRideCandidates` |
| Inject candidates from client | DENIED | DENIED | DENIED | DENIED | — | Injection denied |
| Read searching ride | Own | CONDITIONAL (invited) | CONDITIONAL (ownerId) | ALLOWED | Enforced | — |
| Cancel searching/accepted/arrived | ALLOWED (CF) | DENIED | DENIED | ALLOWED (admin CF) | Client searching→`cancelled_by_user` only | CF cancel preferred |
| Expire searching | ALLOWED (CF) | DENIED | DENIED | ALLOWED (batch CF) | — | Yes |

---

## Bargain & assignment

| Action | Customer | Driver | Owner | Super Admin | Rules | Server |
|--------|----------|--------|-------|-------------|-------|--------|
| Submit offer | DENIED | ALLOWED (CF) | DENIED* | — | Offers W DENIED | Yes |
| Counter / reject offer | ALLOWED (CF) | DENIED | DENIED | — | — | Yes |
| Decline candidate / withdraw offer | DENIED | ALLOWED (CF) | DENIED | — | — | Yes |
| Finalize assign | ALLOWED (CF) | ALLOWED (CF) | DENIED* | — | Client accept DENIED | TX |
| Client set status accepted | DENIED | DENIED | DENIED | — | DENIED | — |

\* Owner fleet-only: ride execution disabled in owner app fork.

---

## Trip progress & money

| Action | Customer | Driver | Owner | Super Admin | Rules | Server |
|--------|----------|--------|-------|-------------|-------|--------|
| Arrived / in_progress | DENIED | ALLOWED | DENIED* | — | Assigned status-only | Not CF |
| Complete + settle | DENIED | ALLOWED (CF) | DENIED* | ALLOWED (CF) | Client complete DENIED | Ledger TX |
| Self increase wallet | DENIED | DENIED | DENIED | ALLOWED (Rules credit) | Self DENIED | Recharge path client Admin |
| Write ledger / audit_logs | DENIED | DENIED | DENIED | DENIED (client) | false | Admin SDK |
| Fare tamper on accepted ride | DENIED | DENIED | DENIED | CONDITIONAL | Phase1 T08 DENIED customer | — |
| Rate completed ride | ALLOWED | DENIED | DENIED | — | One-time on ride | — |
| Forge partner rating aggregates | **CLIENT-ONLY RISK** | **CLIENT-ONLY RISK** | **CLIENT-ONLY RISK** | — | **Weak allow** | UI checks only |

---

## Vehicles, PIN, KYC

| Action | Customer | Driver | Owner | Super Admin | Rules | Server |
|--------|----------|--------|-------|-------------|-------|--------|
| Create vehicle | DENIED | CONDITIONAL (as ownerId=self) | ALLOWED | — | ownerId=uid | — |
| Link by PIN | DENIED | ALLOWED (CF) | ALLOWED (CF) | — | — | Forces role driver |
| Go online (blocked partner) | — | DENIED | — | — | DENIED | Matching excludes |
| KYC upload | ALLOWED | — | — | Read (claim) | Create pending | No approve CF |
| Approve KYC | NOT IMPLEMENTED | — | — | NOT IMPLEMENTED (Rules deny app update) | — | — |

---

## Admin / settings

| Action | Customer | Driver | Owner | Super Admin | Rules | Server |
|--------|----------|--------|-------|-------------|-------|--------|
| Edit pricing/dispatch | DENIED | DENIED | DENIED | ALLOWED | isSuperAdmin | setCandidateDriverLimit CF also |
| Block partner | DENIED | DENIED | DENIED | ALLOWED | Yes | — |
| Grant/revoke admin claim | DENIED | DENIED | DENIED | ALLOWED (CF) | — | Yes + audit |
| Admin cancel ride | DENIED | DENIED | DENIED | ALLOWED (CF) | — | `admin_audit` |
| Cancel in_progress financially | NOT IMPLEMENTED | NOT IMPLEMENTED | — | NOT IMPLEMENTED (explicit undefined) | — | Throws |

---

## Session / stale status (foundation)

| Action | Result |
|--------|--------|
| Role changed while logged in | Next Rules/CF read uses new `partners` doc / claims; UI may lag until refresh |
| Blocked driver old session | Vehicle online denied; matching excludes; Driver UI overlay |
| Logout then protected ops | Unauthenticated Rules DENIED (Phase1 T17) |
| Disabled customer | No dedicated `users.disabled` gate beyond Auth disable — **partial** |

---

## Enforcement summary

| Layer | Strength |
|-------|----------|
| UI | Convenience only — Hosting paths not gated |
| Firestore Rules | Strong on wallet/complete/offers; weak on ride create + rating + role flip |
| Cloud Functions | Strong on booking, match, assign, settle, cancel |
| Storage Rules | KYC owner + claim-admin; bootstrap email not mirrored |
