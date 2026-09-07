import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import transport from "../functions/native-p2p-transport.js";
import peerSession from "../functions/ride-peer-session.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "phase-seven-native-p2p-test-secret-32-bytes";
const NOW = 1_900_000_000_000;
const ride = {
  status: "in_progress", driverId: "driver_a", userId: "customer_a",
  vehicleId: "vehicle_a", assignmentSessionToken: "assignment_a",
};
const av = peerSession.assignmentVersionFromRide(ride);

function snap(data) { return { exists: data != null, data: () => data }; }
function dbWith(session = null, currentRide = ride) {
  return {
    collection(name) {
      return { doc() { return { get: async () => snap(name === "rides" ? currentRide : name === "ridePeerSessions" ? session : null) }; } };
    },
  };
}

function mint(role = "driver", extra = {}) {
  return transport.mintNativeP2pCredential({ role,
    uid: role === "driver" ? ride.driverId : ride.userId, rideId: "ride_a",
    vehicleId: ride.vehicleId, assignmentId: ride.assignmentSessionToken,
    trackingSessionId: role === "driver" ? "trk_driver_a" : "",
    assignmentVersion: av, ...extra }, { secret: SECRET, nowMs: NOW });
}

test("native capability is short-lived, assignment-bound and tamper evident", () => {
  const issued = mint();
  assert.equal(issued.ok, true);
  assert.equal(issued.expiresAtMs, NOW + transport.TOKEN_TTL_MS);
  assert.equal(transport.verifyNativeP2pCredential(issued.token, { secret: SECRET, nowMs: NOW + 1 }).ok, true);
  assert.equal(transport.verifyNativeP2pCredential(issued.token + "x", { secret: SECRET, nowMs: NOW + 1 }).reason, "INVALID_SIGNATURE");
  assert.equal(transport.verifyNativeP2pCredential(issued.token, { secret: SECRET, nowMs: issued.expiresAtMs }).reason, "TOKEN_EXPIRED");
  assert.equal(transport.verifyNativeP2pCredential(issued.token, { secret: "wrong-secret", nowMs: NOW }).reason, "INVALID_SIGNATURE");
});

test("credential issue derives identity from the live ride, not client claims", async () => {
  const issued = await transport.issueNativeP2pCredential(dbWith(), {
    uid: ride.driverId, role: "driver", rideId: "ride_a", vehicleId: ride.vehicleId,
    assignmentId: ride.assignmentSessionToken, trackingSessionId: "trk_driver_a",
  }, { secret: SECRET, nowMs: NOW });
  assert.equal(issued.ok, true); assert.equal(issued.assignmentVersion, av);
  await assert.rejects(() => transport.issueNativeP2pCredential(dbWith(), {
    uid: "attacker", role: "driver", rideId: "ride_a", trackingSessionId: "trk_driver_a",
  }, { secret: SECRET, nowMs: NOW }), /NOT_PARTICIPANT/);
});

test("native state is role-minimized and never returns the opposite SDP", async () => {
  const session = { ...ride, rideId: "ride_a", sessionId: "ps_native_test_01",
    trackingSessionId: "trk_driver_a", assignmentVersion: av, assignmentId: ride.assignmentSessionToken,
    driverId: ride.driverId, customerId: ride.userId, state: "answer_ready",
    protocolVersion: 1,
    offer: "v=0 offer-private", answer: "v=0 answer-private", offerFingerprint: "sha256_offer",
    answeredOfferFingerprint: "sha256_offer", expiresAt: new Date(NOW + 60_000) };
  const driverToken = mint("driver").token, customerToken = mint("customer").token;
  const driverState = await transport.handleNativeP2pAction(dbWith(session),
    { token: driverToken, action: "state" }, { secret: SECRET, nowMs: NOW });
  const customerState = await transport.handleNativeP2pAction(dbWith(session),
    { token: customerToken, action: "state" }, { secret: SECRET, nowMs: NOW });
  assert.equal(driverState.session.answer, session.answer); assert.equal("offer" in driverState.session, false);
  assert.equal(customerState.session.offer, session.offer); assert.equal("answer" in customerState.session, false);
});

test("reassignment and completed rides invalidate a still-cryptographically-valid capability", async () => {
  const token = mint().token;
  await assert.rejects(() => transport.handleNativeP2pAction(dbWith(null, { ...ride, vehicleId: "vehicle_b" }),
    { token, action: "state" }, { secret: SECRET, nowMs: NOW + 1 }), /STALE_ASSIGNMENT/);
  await assert.rejects(() => transport.handleNativeP2pAction(dbWith(null, { ...ride, status: "completed" }),
    { token, action: "state" }, { secret: SECRET, nowMs: NOW + 1 }), /RIDE_NOT_ACTIVE/);
});

test("native engine is Firebase-SDK-free and server owns the fallback policy gate", () => {
  const engine = fs.readFileSync(path.join(ROOT, "mobile/p2p-shared/src/main/java/com/swiftgo/p2p/NativeRidePeerEngine.java"), "utf8");
  const server = fs.readFileSync(path.join(ROOT, "functions/native-p2p-transport.js"), "utf8");
  const customerFallback = fs.readFileSync(path.join(ROOT, "functions/customer-location.js"), "utf8");
  assert.doesNotMatch(engine, /Firebase(Auth|Firestore)|com\.google\.firebase/);
  assert.match(engine, /swiftgo-loc-v1/); assert.match(engine, /customer_fallback/);
  assert.match(engine, /ack_timeout/); assert.match(engine, /"hb"\.equals\(ackKind\)/);
  assert.match(server, /publishCustomerRideLocation/);
  assert.match(customerFallback, /firebaseFallbackEnabled/);
  assert.match(customerFallback, /firebase_disabled/);
});

test("Capacitor 8 tooling pins fixed transitive dependencies without runtime drift", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "mobile/package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "mobile/package-lock.json"), "utf8"));
  assert.equal(manifest.devDependencies["@capacitor/cli"], "8.5.0");
  assert.equal(manifest.overrides.uuid, "11.1.1");
  assert.equal(lock.packages["node_modules/brace-expansion"].version, "5.0.9");
  assert.equal(lock.packages["node_modules/tar"].version, "7.5.22");
  assert.equal(lock.packages["node_modules/uuid"].version, "11.1.1");
});
