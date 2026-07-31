/**
 * Client-side dispatch latency marks (T1–T4). Logs to console for field testing.
 */

const sessions = new Map();

function logMark(label, ms, extra = {}) {
  console.info(
    `[SwiftGo Latency] ${label}`,
    `${Math.round(ms)}ms`,
    Object.keys(extra).length ? extra : ""
  );
}

/** @param {string} rideId */
export function startDispatchSession(rideId) {
  if (!rideId) return;
  sessions.set(rideId, { t0: performance.now(), marks: {} });
}

/** T1 — Book clicked → ride doc created (client CF response). */
export function markT1RideCreated(rideId, extra = {}) {
  const s = sessions.get(rideId);
  if (!s) return;
  const ms = performance.now() - s.t0;
  s.marks.T1 = ms;
  logMark("T1 ride_created", ms, { rideId, ...extra });
}

/** T2 — Server reports match finished (from createCustomerBooking response). */
export function markT2MatchFromCreate(rideId, extra = {}) {
  const s = sessions.get(rideId);
  if (!s) return;
  const ms = performance.now() - s.t0;
  s.marks.T2 = ms;
  logMark("T2 match_from_create", ms, { rideId, ...extra });
}

/** T3 — Driver radar received candidate (driver app). */
export function markT3DriverCandidate(rideId, extra = {}) {
  const s = sessions.get(rideId);
  const ms = s ? performance.now() - s.t0 : 0;
  if (s) s.marks.T3 = ms;
  logMark("T3 driver_candidate", ms, { rideId, ...extra });
}

/** T4 — Customer received driver offer. */
export function markT4CustomerOffer(rideId, extra = {}) {
  const s = sessions.get(rideId);
  const ms = s ? performance.now() - s.t0 : 0;
  if (s) s.marks.T4 = ms;
  logMark("T4 customer_offer", ms, { rideId, ...extra });
  if (s) {
    logMark("PIPELINE_SUMMARY", ms, { rideId, marks: { ...s.marks, T4: ms } });
  }
}

export function markDriverOfferSent(rideId, extra = {}) {
  logMark("T4_driver_offer_sent", performance.now(), { rideId, ...extra });
}

export function clearDispatchSession(rideId) {
  sessions.delete(rideId);
}
