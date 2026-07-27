# Phase 1 — Permission Matrix

**Legend:** ALLOWED | DENIED | CONDITIONAL | NOT IMPLEMENTED | CLIENT-ONLY RISK

**Rules enforcement:** Firestore Security Rules unless noted.  
**Server enforcement:** Cloud Functions — **NOT IMPLEMENTED** (none in repo).

---

## Authentication methods

| Role | Method | Identity store | Role field |
|------|--------|----------------|------------|
| Customer | Google + email/password | `users/{uid}` profile | None (implicit customer) |
| Driver | Google | `partners/{uid}` | `role: driver` |
| Owner | Google | `partners/{uid}` | `role: owner` |
| Super Admin | Google (fixed email) | Firebase Auth token | UI: `isAuthorizedAdmin`; Rules: `isSuperAdmin()` email |

**Status fields:** `partners.accountStatus` (`active`|`blocked`); legacy `partner.status` read in UI; `driver_applications.status` = `pending` only on create.

---

## Matrix (selected actions)

| Action | Customer | Driver | Owner | Super Admin | Rules | Server |
|--------|----------|--------|-------|-------------|-------|--------|
| Create ride (`rides`) | ALLOWED | DENIED | DENIED | ALLOWED* | Yes | — |
| Read open rides | DENIED** | ALLOWED | DENIED** | ALLOWED | Yes | — |
| Accept ride (full payload) | CONDITIONAL*** | ALLOWED | CONDITIONAL*** | — | Yes | — |
| Decline ride | DENIED | ALLOWED | DENIED | — | Yes | — |
| Advance arrived / in_progress | DENIED | CONDITIONAL**** | Same as driver | — | Yes | — |
| Complete with commission | DENIED***** | ALLOWED | Same | — | Yes | — |
| Complete status-only | ALLOWED****** | DENIED | DENIED | — | Yes | — |
| Cancel searching ride | ALLOWED | DENIED | DENIED | — | Yes | — |
| Set own `partners.role` to admin | DENIED | DENIED | DENIED | — | Yes | — |
| Block driver | DENIED | DENIED | DENIED | ALLOWED | Yes | — |
| Approve wallet recharge | DENIED | DENIED | DENIED | ALLOWED | Yes | — |
| Write `partners.walletBalance` | DENIED******* | **ALLOWED******* | DENIED******* | ALLOWED (credit) | **Weak** | — |
| Create vehicle | DENIED | DENIED | ALLOWED | — | Yes | — |
| Claim vehicle via PIN | DENIED | ALLOWED | DENIED | — | Yes | — |
| Update GPS on vehicle | DENIED | CONDITIONAL | DENIED | — | Yes | — |
| Read any vehicle | DENIED | ALLOWED | ALLOWED | ALLOWED | Yes | — |
| Create driver application | ALLOWED | DENIED | DENIED | — | Yes | — |
| Approve KYC | NOT IMPLEMENTED | — | — | NOT IMPLEMENTED | deny update | — |
| Edit pricing settings | DENIED | DENIED | DENIED | ALLOWED | Yes | — |
| Promo create/delete | DENIED | DENIED | DENIED | ALLOWED | Yes | — |
| Promo use increment | ALLOWED | DENIED | DENIED | — | Yes | — |
| Upload KYC image | ALLOWED (own path) | DENIED | DENIED | DENIED | Storage rules | — |
| Read others' KYC | DENIED | DENIED | DENIED | DENIED | Storage owner-only | — |
| Write `users.walletBalance` | DENIED | — | — | — | Yes | — |
| Super admin God Mode vehicle | DENIED | DENIED | DENIED | ALLOWED | Yes | — |

\* Super Admin can read/list all rides; create not used.  
\** Customer reads own rides only via get/list rules.  
\*** Customer accepts offer via transaction.  
\**** Assigned driver only.  
\***** Customer `completeRideRequest` is CLIENT-ONLY RISK if UI exposed; rules currently ALLOW status-only complete from `accepted`.  
\****** Emulator T05 — **ALLOWED by rules**.  
\******* Emulator T09/T19 — driver self-update and batch **ALLOWED** — **CLIENT-ONLY RISK / P0**.

---

## UI-only checks (bypass if API called directly)

| Check | Location | Bypass risk |
|-------|----------|-------------|
| Admin email | `admin-app.js` `isAuthorizedAdmin` | Non-admin signed out in UI; rules still gate writes |
| Owner vs driver URL | `driver-app.js` redirect | User can open `/partner/` manually |
| Wallet lock offline | `driver-app.js` `updateDriverWalletUi` | Does not prevent Firestore write if rules allow |
| Super admin drive mode | Owner app + admin email | Rules `isSuperAdmin()` on vehicle |

---

## Role change while logged in

- **Partner doc listener** (`onSnapshot`) updates block state and may call `routeDriver` again.
- Blocked account: overlay + forced offline in UI; **existing auth session remains** until sign-out — reads/writes limited by rules for blocked user's actions (wallet still writable today — P0).

---

## Can user modify own role?

| Role field | Self-service |
|------------|--------------|
| `partners.role` | Only `owner` or `driver` on create/update — not admin |
| `partners.accountStatus` | Denied self — admin only |
| `users.*` | No role field |

---

## Driver self-approve / online

- **Verified/approved:** No separate flag; PIN + vehicle claim sets `online`.
- **Suspended:** `accountStatus: blocked` — UI blocks; rules do not block vehicle `online` update by accountStatus alone — **gap** (CLIENT-ONLY RISK).

---

## Owner → Super Admin

- **DENIED** in rules and admin UI (email must match owner email).
