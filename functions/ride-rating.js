/**
 * Trusted customer ride rating + partner aggregate (Phase 2A P0-002).
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ customerUid: string, rideId: string, rating: number }} input
 */
async function submitCompletedRideRating(db, { customerUid, rideId, rating }) {
  const stars = Math.round(Number(rating));
  if (!customerUid) throw err("unauthenticated", "AUTH_REQUIRED");
  if (!rideId || typeof rideId !== "string") throw err("invalid-argument", "RIDE_ID_REQUIRED");
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw err("invalid-argument", "INVALID_RATING");
  }

  const rideRef = db.collection("rides").doc(rideId);
  let partnerId = null;

  await db.runTransaction(async (tx) => {
    const rideSnap = await tx.get(rideRef);
    if (!rideSnap.exists) throw err("not-found", "RIDE_NOT_FOUND");
    const ride = rideSnap.data() || {};
    if (ride.userId !== customerUid) throw err("permission-denied", "NOT_RIDE_OWNER");
    if (ride.status !== "completed") throw err("failed-precondition", "RIDE_NOT_COMPLETED");
    if (ride.customerRating != null) throw err("already-exists", "ALREADY_RATED");

    partnerId = ride.driverId ? String(ride.driverId) : null;
    let partnerRef = null;
    let partnerSnap = null;
    if (partnerId) {
      partnerRef = db.collection("partners").doc(partnerId);
      // Firestore transactions require every read before the first write.
      partnerSnap = await tx.get(partnerRef);
    }

    tx.update(rideRef, {
      customerRating: stars,
      ratedAt: FieldValue.serverTimestamp(),
    });

    if (partnerRef && partnerSnap?.exists) {
      tx.update(partnerRef, {
        customerRatingSum: FieldValue.increment(stars),
        customerRatingCount: FieldValue.increment(1),
      });
    }
  });

  return { ok: true, rideId, rating: stars, partnerId };
}

module.exports = {
  submitCompletedRideRating,
};
