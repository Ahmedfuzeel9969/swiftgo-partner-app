import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { validateRideLocationFix, rideLocationAssignmentVersion } from "../shared/js/ride-location-contract.mjs";
import { createLiveLocationSourceArbiter } from "../shared/js/live-location-source-arbiter.mjs";
import { createCustomerLocationPublisher } from "../customer-app/js/customer-location-publisher.mjs";
import { createCustomerLocationMarker } from "../driver-app/js/customer-location-marker.mjs";
import { normalizeLocationFix, evaluateFixAgainstPrevious } from "../driver-app/js/location-envelope.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { clock, rtcFactory, settle, ride } from "./helpers/location-test-kit.mjs";
const require = createRequire(import.meta.url);
const server = require("../functions/ride-location-contract.js");
const source = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").trim().replace(/\r\n/g, "\n");
const now = 1_000_000;
const base = { lat: 24.86, lng: 67.01, observedAt: now, sequence: 1, trackingSessionId: "tracking_one", accuracyM: 10, role: "driver", rideId: ride.id, assignmentId: ride.assignmentSessionToken, assignmentVersion: rideLocationAssignmentVersion(ride) };
const context = { nowMs: now, rideId: ride.id, assignmentId: ride.assignmentSessionToken, assignmentVersion: base.assignmentVersion, role: "driver" };

test("browser/server contract parity is enforced from one canonical source", () => {
  const core = source("shared/js/ride-location-contract.mjs");
  const names = [...core.matchAll(/export (?:const|function) (\w+)/g)].map((m) => m[1]);
  const expected = '// Generated from shared/js/ride-location-contract.mjs; checked by tests.\n"use strict";\n' + core.replace(/export /g, "") + `\nmodule.exports = { ${names.join(", ")} };`;
  assert.equal(source("functions/ride-location-contract.js"), expected);
  assert.deepEqual(server.validateRideLocationFix(base, context), validateRideLocationFix(base, context));
});

for (const [name, delta] of Object.entries({
  numeric_string: { lat: "24.86" }, null_coordinate: { lng: null }, latitude_bounds: { lat: 91 }, longitude_bounds: { lng: -181 },
  missing_time: { observedAt: undefined }, coerced_time: { observedAt: "1000000" }, stale: { observedAt: now - 30001 }, future: { observedAt: now + 10001 },
  missing_sequence: { sequence: undefined }, fractional_sequence: { sequence: 1.5 }, negative_accuracy: { accuracyM: -1 }, poor_accuracy: { accuracyM: 81 },
  invalid_speed: { speedMps: -1 }, impossible_speed: { speedMps: 46 }, invalid_heading: { headingDeg: 361 },
  wrong_ride: { rideId: "other" }, wrong_assignment: { assignmentVersion: 123 }, same_pair_reassignment: { assignmentId: "retired_assignment" },
  wrong_role: { role: "customer" }, missing_session: { trackingSessionId: "" }, invalid_session: { trackingSessionId: "session with space" },
})) test(`strict contract rejects ${name} on both browser and server`, () => {
  for (const validate of [validateRideLocationFix, server.validateRideLocationFix]) assert.equal(validate({ ...base, ...delta }, context).ok, false);
});

test("sub-second, poor-previous-accuracy and session-change jumps have no bypass", () => {
  for (const delta of [{}, { accuracyM: 70 }, { trackingSessionId: "new_session" }]) {
    assert.equal(validateRideLocationFix({ ...base, lat: 25, sequence: 2, observedAt: now + 100, ...delta }, { ...context, previous: { ...base, accuracyM: 70 } }).reason, "impossible_jump");
  }
  assert.equal(validateRideLocationFix({ ...base, lat: base.lat + 0.00001, observedAt: now + 3000, sequence: 2 }, { ...context, previous: base }).ok, true);
});

test("no GPS timestamp is fabricated; duplicate and bad clocks never become a fresh sample", () => {
  assert.equal(normalizeLocationFix({ lat: 24, lng: 67 }, { sessionId: "gps_one", sequence: 1, nowMs: now }).ok, false);
  assert.equal(normalizeLocationFix({ lat: 24, lng: 67, observedAt: NaN }, { sessionId: "gps_one", sequence: 1, nowMs: now }).ok, false);
  const a = { ...base, sessionId: base.trackingSessionId };
  assert.equal(evaluateFixAgainstPrevious(a, { ...a, lat: 26, sequence: 2, observedAt: now + 100 }, { enforceSessionConsistency: true, vehicleSessionId: a.sessionId, nowMs: now }).accept, false);
});

function receiver(c, extra = {}) {
  const frames = [];
  const arbiter = createLiveLocationSourceArbiter({ nowMs: c.now, firebaseBackupReadIntervalMs: 0,
    validateFix: (fix, previous) => validateRideLocationFix(fix, { ...context, nowMs: c.now(), previous }), onRender: (fix) => frames.push(fix), ...extra });
  return { arbiter, frames };
}
test("one GPS fix received on both paths renders once and duplicate P2P cannot renew health", () => {
  const c = clock(), { arbiter, frames } = receiver(c);
  const gen = arbiter.getGeneration();
  assert.equal(arbiter.ingestFirebase(base, gen), true);
  assert.equal(arbiter.ingestP2p({ ...base, sequence: 7 }, gen), false);
  assert.equal(arbiter.getState().p2pHealthy, false);
  c.advance(3000);
  const next = { ...base, observedAt: c.now(), sequence: 2 };
  assert.equal(arbiter.ingestP2p(next, gen), true);
  const proofAt = arbiter.getState().lastP2pAt;
  c.advance(3000);
  assert.equal(arbiter.ingestP2p(next, gen), false);
  assert.equal(arbiter.getState().lastP2pAt, proofAt);
  assert.equal(frames.length, 2); arbiter.destroy();
});
test("bad/old queued fallback cannot overwrite newest valid checkpoint or render after expiry", () => {
  const c = clock(), { arbiter, frames } = receiver(c);
  const gen = arbiter.getGeneration(); arbiter.ingestP2p(base, gen); c.advance(3000);
  arbiter.ingestFirebase({ ...base, sequence: 2, observedAt: c.now() }, gen);
  arbiter.ingestFirebase({ ...base, lat: 99, sequence: 3, observedAt: c.now() + 1 }, gen);
  arbiter.noteP2pUnhealthy(); assert.equal(frames.at(-1).lat, base.lat);
  assert.equal(frames.at(-1).sequence, 2);
  c.advance(1000); arbiter.ingestP2p({ ...base, sequence: 3, observedAt: c.now() }, gen);
  c.advance(1000); arbiter.ingestFirebase({ ...base, sequence: 4, observedAt: c.now() }, gen);
  c.advance(31000); arbiter.noteP2pUnhealthy(); assert.equal(frames.at(-1).sequence, 3);
  arbiter.destroy();
});
test("admin disable is honored on receive, and generation changes reject late packets", () => {
  const c = clock(), { arbiter, frames } = receiver(c); const old = arbiter.getGeneration();
  arbiter.configureDeliveryPolicy({ firebaseFallbackEnabled: false });
  assert.equal(arbiter.ingestFirebase(base, old), false);
  assert.equal(arbiter.ingestP2p(base, old), true);
  arbiter.noteP2pUnhealthy(); assert.equal(arbiter.getState().p2pHealthy, false);
  arbiter.reset(); assert.equal(arbiter.ingestP2p({ ...base, sequence: 2, observedAt: now + 1 }, old), false);
  assert.equal(frames.length, 1); arbiter.destroy();
});

function publisherHarness(extra = {}) {
  const c = clock(); let success, failure, watches = 0, clears = 0, healthy = false;
  const p2p = [], firebase = [];
  const publisher = createCustomerLocationPublisher({
    nowMs: c.now, setIntervalFn: c.setInterval, clearIntervalFn: c.clearInterval, createSessionId: () => "customer_session",
    geolocation: { watchPosition: (ok, err) => { success = ok; failure = err; return ++watches; }, clearWatch: () => clears++ },
    onP2pFix: (fix) => p2p.push(fix), isP2pHealthy: () => healthy,
    publishFallback: async (input) => { firebase.push(input); return { ok: true }; }, ...extra,
  });
  publisher.configureDeliveryPolicy({ firebaseFallbackEnabled: true, p2pFirstGraceMs: 5000, p2pFallbackAfterMs: 5000 });
  return { publisher, c, p2p, firebase, fix: (stamp = c.now()) => success({ coords: { latitude: 24.86, longitude: 67.01, accuracy: 10, heading: null, speed: 0 }, timestamp: stamp }),
    fail: (code) => failure({ code }), counts: () => ({ watches, clears }), health: (value) => healthy = value, captureCallback: () => success };
}
test("customer GPS is P2P-first, Firebase only after grace and at admin interval; recovery stops writes", async () => {
  const h = publisherHarness(); await h.publisher.syncForRide(ride); h.fix(); await settle();
  assert.equal(h.p2p.length, 1); assert.equal(h.firebase.length, 0);
  h.c.advance(5000); await settle(); assert.equal(h.firebase.length, 1);
  h.c.advance(1000); h.fix(); await settle(); assert.equal(h.firebase.length, 1);
  h.c.advance(4000); await settle(); assert.equal(h.firebase.length, 2);
  h.health(true); h.c.advance(5000); h.fix(); await settle(); assert.equal(h.firebase.length, 2);
  h.publisher.configureDeliveryPolicy({ firebaseFallbackEnabled: false }); h.health(false);
  h.c.advance(20000); h.fix(); await settle(); assert.equal(h.firebase.length, 2);
  h.publisher.stop(); assert.equal(h.c.count(), 0);
});
test("status updates keep one GPS watch; termination/permission denial reject captured callbacks", async () => {
  const h = publisherHarness(); await h.publisher.syncForRide(ride);
  await h.publisher.syncForRide({ ...ride, status: "arrived" }); assert.equal(h.counts().watches, 1);
  const stale = h.captureCallback(); await h.publisher.syncForRide({ ...ride, status: "completed" });
  stale({ coords: { latitude: 24, longitude: 67 }, timestamp: h.c.now() }); assert.equal(h.p2p.length, 0);
  await h.publisher.syncForRide(ride); h.fail(1); await h.publisher.syncForRide(ride);
  assert.equal(h.counts().watches, 2); assert.equal(h.publisher.getState().active, false);
  assert.equal(h.c.count(), 0);
});
test("pending consent or Firebase response from an old ride cannot reactivate a stopped watch", async () => {
  let allow;
  const h = publisherHarness({ ensurePermission: () => new Promise((r) => { allow = r; }) });
  const starting = h.publisher.syncForRide(ride); h.publisher.stop(); allow(true); await starting;
  assert.equal(h.counts().watches, 0); assert.equal(h.c.count(), 0);
  let finish;
  const q = publisherHarness({ publishFallback: () => new Promise((r) => { finish = r; }) });
  await q.publisher.syncForRide(ride); q.fix(); q.c.advance(5000); await settle();
  q.publisher.stop(); finish({ ok: true }); await settle(); assert.equal(q.publisher.getState().active, false);
});
test("missing GPS time/default map center is not sent", async () => {
  const h = publisherHarness(); await h.publisher.syncForRide(ride); h.fix(null); h.c.advance(15000); await settle();
  assert.equal(h.p2p.length, 0); assert.equal(h.firebase.length, 0); h.publisher.stop();
});
test("passenger marker expires, clears on terminal state, and never changes the booked pickup", () => {
  const c = clock(); let removed = 0, painted = 0;
  const leaf = { circleMarker: () => ({ addTo() { painted++; return this; }, bindTooltip() {}, remove() { removed++; }, setLatLng() {} }) };
  const marker = createCustomerLocationMarker({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, getMap: () => leaf, getLeaflet: () => leaf });
  marker.update(base); assert.equal(painted, 1); c.advance(30000); assert.equal(removed, 1);
  marker.update({ ...base, observedAt: c.now() }); marker.clear(); assert.equal(removed, 2); assert.equal(c.count(), 0);
});
test("customer controller accepts only bound server mirror; no timestamp invention or duplicate callback", async () => {
  const c = clock(), frames = [], received = [];
  const ctrl = createCustomerP2pController({ nowMs: c.now, p2pFirstGraceMs: 0, onRenderFix: (f) => frames.push(f), onFirebaseFixReceived: (f) => received.push(f),
    watchRidePeerSession: () => () => {}, closeRidePeerSessionClient: async () => {} });
  const data = { ...ride, driverTrackingSessionId: base.trackingSessionId, driverLocation: base };
  ctrl.syncForRide(data, { assignmentVersion: base.assignmentVersion }); await settle();
  assert.equal(frames.length, 1); ctrl.ingestFirebaseLocation(base, data); assert.equal(received.length, 1);
  assert.equal(ctrl.ingestFirebaseLocation({ ...base, observedAt: undefined }, data), false);
  assert.equal(ctrl.ingestFirebaseLocation({ ...base, role: "customer" }, data), false);
  assert.equal(ctrl.ingestFirebaseLocation(base, { ...data, id: "other" }), false);
  await ctrl.stop({ closeRemote: false }); assert.equal(ctrl.ingestFirebaseLocation(base, data), false); ctrl.destroy();
});
test("edited browser entrypoints parse as modules; unsafe parallel vehicle path is absent", () => {
  for (const file of ["customer-app/js/ride-flow.js", "customer-app/js/data.js", "customer-app/js/trust.js", "customer-app/js/i18n.js", "driver-app/js/driver-app.js"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source(file), encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
  assert.equal(source("customer-app/js/ride-flow.js").includes("watchAssignedVehicle"), false);
  assert.equal(source("customer-app/js/ride-flow.js").includes("syncVehicleWatch"), false);
  assert.ok(source("driver-app/js/driver-app.js").includes("lastValidatedGpsEnvelope = normalized.envelope"));
});
