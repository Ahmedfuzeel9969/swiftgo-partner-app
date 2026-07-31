/**
 * Driver-side dispatch latency marks (T3, offer send).
 */

function logMark(label, ms, extra = {}) {
  console.info(
    `[SwiftGo Latency] ${label}`,
    `${Math.round(ms)}ms`,
    Object.keys(extra).length ? extra : ""
  );
}

/** T3 — ride_candidates listener delivered an invited ride. */
export function markT3DriverCandidate(rideId, extra = {}) {
  logMark("T3 driver_candidate", performance.now(), { rideId, ...extra });
}

/** Driver tapped bid/accept — CF submit started. */
export function markDriverOfferSent(rideId, extra = {}) {
  logMark("T4_driver_offer_sent", performance.now(), { rideId, ...extra });
}
