"use strict";
const { randomInt } = require("node:crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { fail, documentId, digest, takeRateLimit, requireApprovedDriver } = require("./security-policy");
const CODE_TTL_MS = 10 * 60 * 1000;
const validLinkCode = (value) => typeof value === "string" && /^[0-9]{12}$/.test(value);
const newLinkCode = () => String(randomInt(100000000000, 1000000000000));
function idleVehicle(vehicle) {
  if (!vehicle || vehicle.activeRideId || vehicle.status === "in_ride") fail("failed-precondition", "VEHICLE_HAS_ACTIVE_RIDE");
}
function ownerAllowed(partner) {
  if (partner?.role !== "owner" || partner.accountStatus !== "active") fail("permission-denied", "APPROVED_OWNER_REQUIRED");
}
function vehicleText(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail("invalid-argument", `INVALID_${label}`);
  return value.trim();
}
function writeCode(tx, db, vehicleRef, ownerUid, code, now) {
  const codeId = digest(code);
  tx.create(db.doc(`vehicle_link_codes/${codeId}`), { vehicleId: vehicleRef.id, ownerId: ownerUid,
    expiresAt: Timestamp.fromMillis(now + CODE_TTL_MS), usedBy: null, createdAt: FieldValue.serverTimestamp() });
  tx.set(db.doc(`vehicle_link_state/${vehicleRef.id}`), { codeId });
}
async function createFleetVehicle(db, uid, data, { now = Date.now(), codeFactory = newLinkCode } = {}) {
  documentId(uid);
  const model = vehicleText(data?.model, 100, "MODEL");
  const plate = vehicleText(data?.plate, 32, "PLATE").toUpperCase();
  await takeRateLimit(db, "fleet_create", uid, { limit: 10, now });
  const vehicleRef = db.collection("vehicles").doc();
  const code = codeFactory();
  if (!validLinkCode(code)) fail("internal", "INVALID_GENERATED_CODE");
  await db.runTransaction(async (tx) => {
    ownerAllowed((await tx.get(db.doc(`partners/${uid}`))).data());
    tx.create(vehicleRef, { ownerId: uid, model, plate, driverId: null, status: "offline", createdAt: FieldValue.serverTimestamp() });
    writeCode(tx, db, vehicleRef, uid, code, now);
    tx.create(db.collection("audit_logs").doc(), { action: "fleet_vehicle_created", actorUid: uid, vehicleId: vehicleRef.id, createdAt: FieldValue.serverTimestamp() });
  });
  return { ok: true, vehicleId: vehicleRef.id, code, expiresAtMs: now + CODE_TTL_MS };
}
async function rotateVehicleLinkCode(db, uid, vehicleId, { now = Date.now(), codeFactory = newLinkCode } = {}) {
  documentId(uid); documentId(vehicleId, "VEHICLE");
  await takeRateLimit(db, "fleet_code", uid, { limit: 10, now });
  const code = codeFactory();
  if (!validLinkCode(code)) fail("internal", "INVALID_GENERATED_CODE");
  const ref = db.doc(`vehicles/${vehicleId}`);
  await db.runTransaction(async (tx) => {
    const [partner, vehicle, state] = await Promise.all([tx.get(db.doc(`partners/${uid}`)), tx.get(ref), tx.get(db.doc(`vehicle_link_state/${vehicleId}`))]);
    ownerAllowed(partner.data());
    if (!vehicle.exists || vehicle.data().ownerId !== uid) fail("permission-denied", "VEHICLE_NOT_OWNED");
    idleVehicle(vehicle.data());
    if (vehicle.data().driverId) fail("failed-precondition", "RELEASE_DRIVER_FIRST");
    if (state.data()?.codeId) tx.delete(db.doc(`vehicle_link_codes/${state.data().codeId}`));
    writeCode(tx, db, ref, uid, code, now);
    tx.update(ref, { pin: FieldValue.delete(), pinHash: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    tx.delete(db.doc(`vehicle_pins/${vehicleId}`));
    tx.create(db.collection("audit_logs").doc(), { action: "vehicle_link_code_rotated", actorUid: uid, vehicleId, createdAt: FieldValue.serverTimestamp() });
  });
  return { ok: true, vehicleId, code, expiresAtMs: now + CODE_TTL_MS };
}
async function releaseFleetVehicle(db, uid, vehicleId) {
  documentId(uid); documentId(vehicleId, "VEHICLE");
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`vehicles/${vehicleId}`);
    const [snap, caller] = await Promise.all([tx.get(ref), tx.get(db.doc(`partners/${uid}`))]);
    const vehicle = snap.data();
    if (!vehicle || (vehicle.ownerId !== uid && vehicle.driverId !== uid)) fail("permission-denied", "VEHICLE_NOT_OWNED_OR_LINKED");
    if (vehicle.ownerId === uid) ownerAllowed(caller.data());
    idleVehicle(vehicle);
    const driverRef = vehicle.driverId ? db.doc(`partners/${documentId(vehicle.driverId)}`) : null;
    const driver = driverRef ? await tx.get(driverRef) : null;
    const state = await tx.get(db.doc(`vehicle_link_state/${vehicleId}`));
    if (driver?.data()?.activeRideId) fail("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");
    if (driver?.data()?.currentVehicleId === vehicleId) tx.update(driverRef, { currentVehicleId: null, updatedAt: FieldValue.serverTimestamp() });
    tx.update(ref, { driverId: null, driverName: FieldValue.delete(), status: "offline", pin: FieldValue.delete(), pinHash: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    if (state.data()?.codeId) tx.delete(db.doc(`vehicle_link_codes/${state.data().codeId}`));
    tx.delete(db.doc(`vehicle_link_state/${vehicleId}`));
    tx.delete(db.doc(`vehicle_pins/${vehicleId}`));
    tx.create(db.collection("audit_logs").doc(), { action: "vehicle_released", actorUid: uid, vehicleId, createdAt: FieldValue.serverTimestamp() });
    return { ok: true, vehicleId };
  });
}
async function linkVehicleByCode(db, { driverUid, pin, requestIp }, { now = Date.now() } = {}) {
  documentId(driverUid, "DRIVER");
  if (!validLinkCode(pin)) fail("invalid-argument", "INVALID_PIN_FORMAT");
  await takeRateLimit(db, "vehicle_link_uid", driverUid, { limit: 5, windowMs: 15 * 60000, now });
  if (requestIp) await takeRateLimit(db, "vehicle_link_ip", requestIp, { limit: 30, windowMs: 15 * 60000, now });
  return db.runTransaction(async (tx) => {
    const partnerRef = db.doc(`partners/${driverUid}`);
    const codeRef = db.doc(`vehicle_link_codes/${digest(pin)}`);
    const [partnerSnap, codeSnap] = await Promise.all([tx.get(partnerRef), tx.get(codeRef)]);
    const partner = partnerSnap.data();
    requireApprovedDriver(partner);
    const code = codeSnap.data();
    if (!code || code.expiresAt.toMillis() <= now) fail("not-found", "PIN_NOT_FOUND");
    const ref = db.doc(`vehicles/${documentId(code.vehicleId)}`);
    const [vehicleSnap, state] = await Promise.all([tx.get(ref), tx.get(db.doc(`vehicle_link_state/${code.vehicleId}`))]);
    const vehicle = vehicleSnap.data();
    if (!vehicle || vehicle.ownerId !== code.ownerId || state.data()?.codeId !== codeRef.id) fail("not-found", "PIN_NOT_FOUND");
    if (code.usedBy === driverUid && partner.currentVehicleId === ref.id && vehicle.driverId === driverUid) {
      return { ok: true, vehicleId: ref.id, plate: vehicle.plate, ownerId: vehicle.ownerId, status: vehicle.status, idempotent: true };
    }
    if (code.usedBy) fail("not-found", "PIN_NOT_FOUND");
    idleVehicle(vehicle);
    if (partner.activeRideId) fail("failed-precondition", "DRIVER_HAS_ACTIVE_RIDE");
    if (vehicle.driverId && vehicle.driverId !== driverUid) fail("failed-precondition", "VEHICLE_IN_USE");
    const previousRef = partner.currentVehicleId && partner.currentVehicleId !== ref.id ? db.doc(`vehicles/${documentId(partner.currentVehicleId)}`) : null;
    const previous = previousRef ? await tx.get(previousRef) : null;
    if (previous?.exists && previous.data().driverId === driverUid) {
      idleVehicle(previous.data());
      tx.update(previousRef, { driverId: null, driverName: FieldValue.delete(), status: "offline", updatedAt: FieldValue.serverTimestamp() });
    }
    tx.update(ref, { driverId: driverUid, driverName: partner.displayName || partner.name || "SwiftGo Driver", status: "offline",
      pin: FieldValue.delete(), pinHash: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    // Linking never re-stamps old GPS as fresh, nor changes owner/driver role.
    tx.update(partnerRef, { currentVehicleId: ref.id, updatedAt: FieldValue.serverTimestamp() });
    tx.update(codeRef, { usedBy: driverUid, usedAt: FieldValue.serverTimestamp() });
    tx.create(db.collection("audit_logs").doc(), { action: "vehicle_linked", actorUid: driverUid, vehicleId: ref.id, createdAt: FieldValue.serverTimestamp() });
    return { ok: true, vehicleId: ref.id, plate: vehicle.plate, ownerId: vehicle.ownerId, status: "offline", idempotent: false };
  });
}
module.exports = { CODE_TTL_MS, validLinkCode, newLinkCode, idleVehicle, createFleetVehicle, rotateVehicleLinkCode, releaseFleetVehicle, linkVehicleByCode };
