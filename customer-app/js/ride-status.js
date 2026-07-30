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

/** Customer may cancel only these statuses via trusted cancel callables (before trip start). */
export const CANCELLABLE_RIDE_STATUSES = Object.freeze([
  "searching_driver",
  "accepted",
  "arrived",
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
  return NON_TERMINAL_RIDE_STATUSES.includes(String(status || ""));
}

export function isTerminalRideStatus(status) {
  const s = String(status || "");
  if (NON_TERMINAL_RIDE_STATUSES.includes(s)) return false;
  return TERMINAL_RIDE_STATUSES.includes(s) || Boolean(s);
}
