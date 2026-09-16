/**
 * Trusted driver go-online — GPS + session + geo via Admin SDK.
 *
 * Client Firestore writes keep failing on production because heartbeat vs
 * ONLINE_READY allowlists, session-start == request.time, and PIN docs that
 * lack trackingSessionId never stay in sync with live rules. PIN linking
 * already uses Admin SDK; going online must use the same trust boundary.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { locationGeoFields } = require("./geo-cells");
const { isValidTrackingSessionId, isValidLatLng } = require("./live-location-envelope");
const { healStaleDriverPointers } = require("./active-ride-reconcile");

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function assertLatLng(lat, lng) {
  if (typeof isValidLatLng === "function") return isValidLatLng(lat, lng);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

async function setDriverOnlineLocation(db, input) {
  const driverUid = String(input?.driverUid || "").trim();
  if (!driverUid) throw err("unauthenticated", "AUTH_REQUIRED");

  const vehicleId = String(input?.vehicleId || "").trim();
  if (!vehicleId) throw err("invalid-argument", "MISSING_VEHICLE");

  const lat = Number(input?.lat);
  const lng = Number(input?.lng);
  if (!assertLatLng(lat, lng)) throw err("invalid-argument", "INVALID_LOCATION");

  const trackingSessionId = String(input?.trackingSessionId || "").trim();
  if (!isValidTrackingSessionId(trackingSessionId)) {
    throw err("invalid-argument", "INVALID_TRACKING_SESSION");
  }

  const partnerRef = db.collection("partners").doc(driverUid);
  const vehicleRef = db.collection("vehicles").doc(vehicleId);
  const [partnerSnap, vehicleSnap] = await Promise.all([partnerRef.get(), vehicleRef.get()]);

  const partner = partnerSnap.exists ? partnerSnap.data() || {} : {};
  if (partner.accountStatus === "blocked" || partner.accountStatus === "suspended") {
    throw err("permission-denied", "DRIVER_BLOCKED");
  }

  if (!vehicleSnap.exists) throw err("not-found", "VEHICLE_NOT_FOUND");
  const vehicleBefore = vehicleSnap.data() || {};
  const assignedDriver = String(vehicleBefore.driverId || "").trim();
  const partnerVehicle = String(partner.currentVehicleId || "").trim();

  if (assignedDriver && assignedDriver !== driverUid) {
    throw err("failed-precondition", "VEHICLE_IN_USE");
  }
  if (!assignedDriver && partnerVehicle !== vehicleId) {
    throw err("failed-precondition", "VEHICLE_NOT_LINKED");
  }

  await healStaleDriverPointers(db, { driverUid, vehicleId });
  const [vehicleAfterHeal, partnerAfterHeal] = await Promise.all([
    vehicleRef.get(),
    partnerRef.get(),
  ]);
  const vehicle = vehicleAfterHeal.exists ? vehicleAfterHeal.data() || {} : vehicleBefore;
  const partnerLive = partnerAfterHeal.exists ? partnerAfterHeal.data() || {} : partner;
  if (partnerLive.accountStatus === "blocked" || partnerLive.accountStatus === "suspended") {
    throw err("permission-denied", "DRIVER_BLOCKED");
  }
  if (String(vehicle.status || "") === "in_ride" && String(vehicle.activeRideId || "").trim()) {
    throw err("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");
  }

  const geo = locationGeoFields(lat, lng);
  if (!geo.geoCell) throw err("invalid-argument", "INVALID_GEO_CELL");

  const location = {
    lat,
    lng,
    sessionId: trackingSessionId,
    source: String(input?.source || "gps").slice(0, 32) || "gps",
  };
  const observedAt = Number(input?.observedAt);
  if (Number.isFinite(observedAt) && observedAt > 0) location.observedAt = observedAt;
  const sequence = Math.floor(Number(input?.sequence) || 0);
  if (sequence > 0) location.sequence = sequence;

  const sessionIsNew = String(vehicle.trackingSessionId || "") !== trackingSessionId;
  const driverName =
    String(input?.driverName || "").trim() ||
    String(vehicle.driverName || "").trim() ||
    "SwiftGo Driver";

  const vehicleUpdate = {
    driverId: driverUid,
    driverName,
    status: "online",
    location,
    locationUpdatedAt: FieldValue.serverTimestamp(),
    geoCell: geo.geoCell,
    hotspotId: geo.hotspotId,
    locationGridCell: geo.locationGridCell,
    trackingSessionId,
    activeRideId: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (sessionIsNew) {
    vehicleUpdate.trackingSessionStartedAt = FieldValue.serverTimestamp();
  }

  await vehicleRef.update(vehicleUpdate);

  if (partnerVehicle !== vehicleId) {
    await partnerRef.set(
      {
        uid: driverUid,
        role: "driver",
        currentVehicleId: vehicleId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return {
    ok: true,
    vehicleId,
    status: "online",
    geoCell: geo.geoCell,
    locationGridCell: geo.locationGridCell,
    hotspotId: geo.hotspotId,
    trackingSessionId,
  };
}

module.exports = {
  setDriverOnlineLocation,
};
