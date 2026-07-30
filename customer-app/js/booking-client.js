/**
 * Phase 2D — customer booking create/cancel via trusted Cloud Functions.
 */
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";

function call(name, data) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  return httpsCallable(functions, name)(data).then((r) => r?.data || r);
}

/**
 * Race-safe booking create (server enforces 4-booking limit + slots).
 * @returns {{ id: string, count?: number }}
 */
export async function createCustomerBookingClient({
  confirmedExtraBooking = false,
  pickupLocation,
  dropoffLocation,
  vehicleType,
  vehicleTypeKey,
  distanceKm,
  timeMins,
  farePkr,
  estimatedFare,
  promoCode,
  discountAmount,
  originalFare,
  paymentMethod,
}) {
  return call("createCustomerBooking", {
    confirmedExtraBooking: Boolean(confirmedExtraBooking),
    pickupLocation,
    dropoffLocation,
    vehicleType,
    vehicleTypeKey,
    distanceKm,
    timeMins,
    farePkr,
    estimatedFare,
    promoCode,
    discountAmount,
    originalFare,
    paymentMethod,
  });
}

export async function cancelCustomerBookingClient(rideId, { cancelReason, cancelReasonKey } = {}) {
  return call("cancelCustomerBooking", {
    rideId,
    cancelReason,
    cancelReasonKey,
  });
}

/** Cancel every searching booking for the signed-in customer. */
export async function cancelAllSearchingBookingsClient() {
  return call("cancelAllSearchingBookings", {});
}

/** 3-minute search timeout — mark ride as expired (server authoritative). */
export async function expireSearchingBookingClient(rideId) {
  return call("expireSearchingBooking", { rideId });
}
