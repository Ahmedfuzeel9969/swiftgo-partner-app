/**
 * Canonical ride status helpers — shared by Customer gate, active UI, and docs contract.
 * Must stay aligned with functions/matching.js NON_TERMINAL_RIDE_STATUSES
 * and docs/PHASE-2A-CANONICAL-CONTRACT.md.
 */

/** Concurrent booking limit (Phase 2A). */
export const MAX_CUSTOMER_ACTIVE_BOOKINGS = 4;

/** Canonical ownership field on `rides` — must match functions/matching.js. */
export const CUSTOMER_RIDE_OWNER_FIELD = "userId";

/** Searching timeout (ms) — authoritative backend also uses expiresAt. */
export const SEARCH_EXPIRE_MS = 3 * 60 * 1000;

/**
 * Non-terminal booking statuses that count toward the four-booking limit
 * and appear in the Customer active-booking area.
 */
export const NON_TERMINAL_RIDE_STATUSES = Object.freeze([
  "searching_driver",
  "accepted",
  "arrived",
  "in_progress",
]);

/** Legacy / alias statuses still seen on older ride docs — treated as active searching. */
export const LEGACY_SEARCHING_STATUSES = Object.freeze(["created", "pending", "searching"]);

/** Firestore `in` query list for customer active-ride discovery. */
export const FIRESTORE_ACTIVE_RIDE_STATUSES = Object.freeze([
  ...NON_TERMINAL_RIDE_STATUSES,
  ...LEGACY_SEARCHING_STATUSES,
]);

/** Normalize status for UI + gate logic. */
export function normalizeCustomerRideStatus(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (LEGACY_SEARCHING_STATUSES.includes(raw)) return "searching_driver";
  return raw;
}

export function isCustomerActiveRideStatus(status) {
  const normalized = normalizeCustomerRideStatus(status);
  return NON_TERMINAL_RIDE_STATUSES.includes(normalized);
}

/** Customer may cancel these statuses via trusted cancel callables. */
export const CANCELLABLE_RIDE_STATUSES = Object.freeze([
  "searching_driver",
  "accepted",
  "arrived",
  "in_progress",
]);

/** Terminal statuses that must never count toward the four-booking limit. */
export const TERMINAL_RIDE_STATUSES = Object.freeze([
  "completed",
  "cancelled_by_user",
  "cancelled_by_customer",
  "cancelled_by_system",
  "cancelled_by_admin",
  "cancelled_by_driver",
  "cancelled",
  "declined",
  "rejected",
  "expired",
  "no_driver_found",
]);

export function isNonTerminalRideStatus(status) {
  return isCustomerActiveRideStatus(status);
}

export function isTerminalRideStatus(status) {
  const s = String(status || "");
  if (NON_TERMINAL_RIDE_STATUSES.includes(s)) return false;
  return TERMINAL_RIDE_STATUSES.includes(s) || Boolean(s);
}
