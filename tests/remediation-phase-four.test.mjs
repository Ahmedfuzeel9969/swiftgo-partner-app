import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { LOCATION_DELIVERY_FIELDS, locationDeliverySettingsPatch, resolveLocationDeliveryPolicy, normalizeRuntimeDeliveryPolicy } from "../shared/js/location-delivery-policy.mjs";
import { createLiveLocationSourceArbiter } from "../shared/js/live-location-source-arbiter.mjs";
import { createFallbackLocationWatch } from "../shared/js/fallback-location-watch.mjs";
import { createBackgroundLocationProbe } from "../shared/js/background-location-probe.mjs";
import { createCheckpointPolicyController } from "../driver-app/js/location-checkpoint-policy.mjs";
import { createLocationWriteSerializer } from "../driver-app/js/location-write-queue.mjs";
import { createCustomerLocationPublisher } from "../customer-app/js/customer-location-publisher.mjs";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { buildP2pAckMessage, buildP2pLocationMessage } from "../driver-app/js/p2p-location-envelope.mjs";
import { rideLocationAssignmentVersion } from "../shared/js/ride-location-contract.mjs";
import { clock, rtcFactory, settle, ride } from "./helpers/location-test-kit.mjs";
const require = createRequire(import.meta.url), server = require("../functions/location-delivery-policy.js");
const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").trim().replace(/\r\n/g, "\n");
const fix = (c, sequence = 1) => ({ lat: 24.86, lng: 67.01, observedAt: c.now(), sequence, trackingSessionId: "gps_phase4" });

test("browser/server delivery settings have byte-for-byte generated parity", () => {
  const core = source("shared/js/location-delivery-policy.mjs");
  const names = [...core.matchAll(/export (?:const|function) (\w+)/g)].map((m) => m[1]);
  assert.equal(source("functions/location-delivery-policy.js"), '// Generated from shared/js/location-delivery-policy.mjs; checked byte-for-byte by tests.\n"use strict";\n' + core.replace(/export /g, "") + `\nmodule.exports = { ${names.join(", ")} };`);
  assert.deepEqual(server.resolveLocationDeliveryPolicy({}), resolveLocationDeliveryPolicy({}));
});
for (const [key, field] of Object.entries(LOCATION_DELIVERY_FIELDS)) {
  test(`admin validates ${key} strictly with explicit safe defaults`, () => {
    for (const value of [null, "12", NaN, Infinity, -1, field.max + 1, 5.5]) {
      assert.throws(() => locationDeliverySettingsPatch({ [key]: value }), { code: "invalid-argument" });
    }
    for (const value of [field.min, field.max, field.default, ...(field.zero ? [0] : [])]) {
      assert.equal(locationDeliverySettingsPatch({ [key]: value })[key], value);
    }
  });
}
test("malformed saved flags fail closed; omission preserves legacy defaults", () => {
  assert.equal(resolveLocationDeliveryPolicy({}).firebaseFallbackEnabled, true);
  for (const value of [null, 1, "true", "false", false]) assert.equal(resolveLocationDeliveryPolicy({ firebaseLocationFallbackEnabled: value }).firebaseFallbackEnabled, false);
  assert.throws(() => locationDeliverySettingsPatch({ firebaseLocationFallbackEnabled: null }));
});
test("P2P grace, fallback write, render and healthy checkpoint intervals are independent", () => {
  const p = resolveLocationDeliveryPolicy({ p2pFallbackAfterSeconds: 20, firebaseFallbackWriteSeconds: 3, firebaseLocationRenderSeconds: 2, firebaseHealthyApproachSeconds: 100, firebaseHealthyTripSeconds: 0 });
  assert.equal(p.p2pFirstGraceMs, 20000); assert.equal(p.firebaseWriteIntervalMs, 3000);
  assert.equal(p.firebaseBackupReadIntervalMs, 2000); assert.equal(p.firebaseHealthyApproachMs, 100000); assert.equal(p.firebaseHealthyTripMs, 0);
  assert.equal(normalizeRuntimeDeliveryPolicy({ firebaseFallbackEnabled: false }, p).firebaseWriteIntervalMs, 3000);
});

function checkpoint() {
  const c = clock(), ctrl = createCheckpointPolicyController({ nowMs: c.now, diag() {} });
  ctrl.configureDeliveryPolicy(resolveLocationDeliveryPolicy({ p2pFallbackAfterSeconds: 5, firebaseFallbackWriteSeconds: 10 }));
  ctrl.setActiveRide({ rideId: ride.id, assignmentId: "a", status: "accepted", active: true });
  return { c, ctrl, gate: (lastWriteMs = 0, extra = {}) => ctrl.evaluateWriteGate({ nowMs: c.now(), lastWriteMs, ...extra }) };
}
test("driver gives P2P its grace even on force, movement and status transitions", () => {
  const h = checkpoint(); assert.equal(h.gate(0, { force: true, movedEnough: true, statusChanged: true }).allow, false);
  h.c.advance(4999); assert.equal(h.gate().allow, false); h.c.advance(1); assert.equal(h.gate().allow, true);
});
test("active driver force/status/movement cannot bypass the admin minimum interval", () => {
  const h = checkpoint(); h.c.advance(5000); const at = h.c.now();
  for (const extra of [{ force: true }, { statusChanged: true }, { movedEnough: true }, { zoneChanged: true }, { matchCellChanged: true }]) assert.equal(h.gate(at, extra).allow, false);
  h.c.advance(10000); assert.equal(h.gate(at).allow, true);
});
test("admin disable stops driver checkpoints and force requests but does not stop idle dispatch", () => {
  const h = checkpoint(); h.c.advance(15000); h.ctrl.configureDeliveryPolicy({ firebaseFallbackEnabled: false });
  assert.equal(h.gate(0, { force: true }).allow, false);
  h.ctrl.setActiveRide({ active: false }); assert.equal(h.gate(0, { force: true }).allow, true);
});
test("healthy checkpoints follow approach/trip controls and zero disables them", () => {
  const h = checkpoint(); h.c.advance(5000); h.ctrl.setP2pHealthy(true);
  h.ctrl.configureDeliveryPolicy({ firebaseHealthyApproachMs: 100000, firebaseHealthyTripMs: 0 });
  assert.equal(h.ctrl.currentDecision().intervalMs, 100000);
  h.ctrl.setActiveRide({ rideId: ride.id, assignmentId: "a", status: "in_progress", active: true });
  assert.equal(h.gate(0, { force: true }).allow, false);
  h.ctrl.setP2pHealthy(false); assert.equal(h.gate().allow, true);
  h.ctrl.setP2pHealthy(true); assert.equal(h.gate().allow, false);
});
test("same-ride status retains grace origin; reassignment restarts it", () => {
  const h = checkpoint(); h.c.advance(5000);
  h.ctrl.setActiveRide({ rideId: ride.id, assignmentId: "a", status: "arrived", active: true }); assert.equal(h.gate().allow, true);
  h.ctrl.setActiveRide({ rideId: ride.id, assignmentId: "b", status: "accepted", active: true }); assert.equal(h.gate().allow, false);
});

function arbiter(extra = {}) {
  const c = clock(), rendered = [], demands = [];
  const a = createLiveLocationSourceArbiter({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, p2pFirstGraceMs: 12000,
    onRender: (f) => rendered.push(f), onFallbackDemand: (d) => demands.push(d), ...extra });
  a.beginP2pFirstWindow(); return { c, a, rendered, demands, gen: a.getGeneration() };
}
test("shortening live admin grace takes effect from original start, not another full wait", () => {
  const h = arbiter(); h.a.ingestFirebase(fix(h.c), h.gen); h.c.advance(6000);
  h.a.configureDeliveryPolicy({ p2pFirstGraceMs: 5000 }); assert.equal(h.rendered.length, 1); assert.equal(h.demands.at(-1), true); h.a.destroy();
});
test("lengthening grace re-arms the old deadline and does not flash Firebase early", () => {
  const h = arbiter(); h.a.ingestFirebase(fix(h.c), h.gen); h.c.advance(4000); h.a.configureDeliveryPolicy({ p2pFirstGraceMs: 20000 });
  h.c.advance(8000); assert.equal(h.rendered.length, 0); h.c.advance(8000); assert.equal(h.rendered.length, 1); h.a.destroy();
});
test("latest throttled Firebase point renders on its own deadline without needing another snapshot", () => {
  const h = arbiter({ p2pFirstGraceMs: 0 }); h.a.ingestFirebase(fix(h.c), h.gen); h.c.advance(1000);
  h.a.ingestFirebase(fix(h.c, 2), h.gen); h.c.advance(1000); h.a.ingestFirebase(fix(h.c, 3), h.gen);
  assert.equal(h.rendered.length, 1); h.c.advance(2000); assert.equal(h.rendered.at(-1).sequence, 3); assert.equal(h.rendered.length, 2); h.a.destroy(); assert.equal(h.c.count(), 0);
});
test("admin render changes immediately re-evaluate queued deadline", () => {
  const h = arbiter({ p2pFirstGraceMs: 0 }); h.a.ingestFirebase(fix(h.c), h.gen); h.c.advance(1500);
  h.a.ingestFirebase(fix(h.c, 2), h.gen); h.a.configureDeliveryPolicy({ firebaseBackupReadIntervalMs: 1000 });
  assert.equal(h.rendered.length, 2); h.a.destroy();
});
test("disable drops pending fallback and re-enable works after startup expired", () => {
  const h = arbiter(); h.a.ingestFirebase(fix(h.c), h.gen); h.a.configureDeliveryPolicy({ firebaseFallbackEnabled: false });
  h.c.advance(13000); assert.equal(h.demands.at(-1), false); assert.equal(h.rendered.length, 0);
  h.a.configureDeliveryPolicy({ firebaseFallbackEnabled: true }); assert.equal(h.demands.at(-1), true); assert.equal(h.rendered.length, 0);
  h.a.ingestFirebase(fix(h.c, 2), h.gen); assert.equal(h.rendered.length, 1); h.a.destroy();
});
test("healthy P2P detaches fallback; exact silence deadline and fresh recovery toggle it once", () => {
  const h = arbiter(); h.a.ingestP2p(fix(h.c), h.gen); h.c.advance(11999); assert.equal(h.demands.at(-1), false);
  h.c.advance(1); assert.equal(h.demands.at(-1), true); h.a.ingestP2p(fix(h.c, 2), h.gen); assert.equal(h.demands.at(-1), false);
  h.a.destroy(); assert.equal(h.c.count(), 0);
});
test("disabled Firebase still expires P2P health and stale duplicate cannot renew it", () => {
  const h = arbiter(); const first = fix(h.c); h.a.ingestP2p(first, h.gen);
  h.a.configureDeliveryPolicy({ firebaseFallbackEnabled: false }); h.c.advance(12000);
  assert.equal(h.a.getState().p2pHealthy, false); assert.equal(h.demands.at(-1), false);
  assert.equal(h.a.ingestP2p(first, h.gen), false); h.a.destroy();
});
test("buffered expired location is revalidated before timed rendering", () => {
  let now; const h = arbiter({ p2pFirstGraceMs: 60000, validateFix: (f) => ({ ok: now == null || now() - f.observedAt <= 30000 }) }); now = h.c.now;
  h.a.ingestFirebase(fix(h.c), h.gen); h.c.advance(60000); assert.equal(h.rendered.length, 0); h.a.destroy();
});

test("location-only watch never attaches without demand; detach invalidates queued callbacks", () => {
  const c = clock(), calls = [], data = []; let closes = 0;
  const watch = createFallbackLocationWatch({ setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout,
    subscribe: (b, next, error) => { calls.push({ b, next, error }); return () => closes++; }, onData: (d) => data.push(d) });
  watch.setBinding({ key: "a" }); assert.equal(calls.length, 0); watch.setNeeded(true); watch.setNeeded(true); assert.equal(calls.length, 1);
  calls[0].next(1); watch.setNeeded(false); calls[0].next(2); assert.deepEqual(data, [1]); assert.equal(closes, 1);
  watch.setNeeded(true); watch.setBinding({ key: "b" }); calls[1].next(3); calls[2].next(4); assert.deepEqual(data, [1, 4]); watch.stop(); assert.equal(c.count(), 0);
});
test("failed watch retries with bounded backoff and disable cancels retry", () => {
  const c = clock(); let count = 0, fail;
  const w = createFallbackLocationWatch({ setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, subscribe: (_b, _next, error) => { count++; fail = error; return () => {}; } });
  w.setBinding({ key: "a" }); w.setNeeded(true); fail(); c.advance(999); assert.equal(count, 1); c.advance(1); assert.equal(count, 2);
  fail(); w.setNeeded(false); c.advance(60000); assert.equal(count, 2); w.stop(); assert.equal(c.count(), 0);
});
test("synchronous listener failure is closed once, then retry remains possible", () => {
  const c = clock(); let count = 0, closed = 0;
  const w = createFallbackLocationWatch({ setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, subscribe: (_b, _next, error) => { if (++count === 1) error(); return () => closed++; } });
  w.setBinding({ key: "a" }); w.setNeeded(true); assert.equal(closed, 1); c.advance(1000); assert.equal(count, 2); w.stop(); assert.equal(closed, 2);
});
test("driver controller uses the admin ACK deadline, not earlier degraded warning", async () => {
  const c = clock(), rtc = rtcFactory(), health = [];
  const ctrl = createDriverP2pController({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, RTCPeerConnection: rtc.Peer,
    ensureIceConfiguration: async () => {}, createRidePeerOfferClient: async () => ({ assignmentVersion: 3 }), watchRidePeerSession: () => () => {}, closeRidePeerSessionClient: async () => {}, onHealthyChange: (h) => health.push(h) });
  await ctrl.start({ rideId: ride.id, trackingSessionId: "driver_gps", assignmentVersion: 3 });
  for (let i = 0; i < 5; i++) await settle();
  const session = ctrl._getSessionForTest(); rtc.instances[0].channel.open(); ctrl.onLocationFix({ ...fix(c), trackingSessionId: "driver_gps" });
  const state = session.getState();
  const ack = buildP2pAckMessage({ peerSessionId: state.peerSessionId, trackingSessionId: "driver_gps", assignmentVersion: 3, role: "customer", sequence: 1, ackKind: "loc" });
  session._handleMessageForTest(ack.serialized, state.generation); assert.equal(ctrl.isHealthy(), true);
  c.advance(10000); assert.equal(ctrl.isHealthy(), true); c.advance(3000); assert.equal(ctrl.isHealthy(), false);
  await ctrl.stop({ closeRemote: false }); ctrl.destroy();
});
test("customer publisher uses write interval rather than the P2P failure deadline", async () => {
  const c = clock(); let gps, count = 0, p2p = 0, healthy = false;
  const publisher = createCustomerLocationPublisher({ nowMs: c.now, setIntervalFn: c.setInterval, clearIntervalFn: c.clearInterval,
    createSessionId: () => "gps_test", geolocation: { watchPosition: (cb) => { gps = cb; return 1; }, clearWatch() {} },
    onP2pFix: () => p2p++, isP2pHealthy: () => healthy, publishFallback: async () => { count++; return { ok: true }; } });
  publisher.configureDeliveryPolicy(resolveLocationDeliveryPolicy({ p2pFallbackAfterSeconds: 20, firebaseFallbackWriteSeconds: 2 }));
  await publisher.syncForRide(ride);
  const sample = () => gps({ timestamp: c.now(), coords: { latitude: 24.86, longitude: 67.01, accuracy: 10 } });
  sample(); c.advance(20000); await settle(); assert.equal(count, 1);
  c.advance(2000); sample(); await settle(); assert.equal(count, 2);
  healthy = true; c.advance(2000); sample(); await settle(); assert.equal(count, 2); assert.equal(p2p, 3); publisher.stop();
});
test("bound driver location subscription detaches on real P2P receipt and reattaches on silence", async () => {
  const c = clock(), rtc = rtcFactory(); let starts = 0, stops = 0;
  const ctrl = createDriverP2pController({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, RTCPeerConnection: rtc.Peer,
    ensureIceConfiguration: async () => {}, createRidePeerOfferClient: async () => ({ assignmentVersion: rideLocationAssignmentVersion(ride) }),
    watchRidePeerSession: () => () => {}, closeRidePeerSessionClient: async () => {}, watchCustomerLocation: () => { starts++; return () => stops++; } });
  ctrl.configureDeliveryPolicy({ p2pFirstGraceMs: 5000, p2pFallbackAfterMs: 5000 });
  ctrl.syncForRide({ ride, trackingSessionId: "driver_gps" }); for (let i = 0; i < 5; i++) await settle();
  assert.equal(starts, 0); c.advance(5000); assert.equal(starts, 1);
  const peer = ctrl._getSessionForTest(); peer._setChannelOpenForTest(true); const meta = peer.getState();
  const packet = buildP2pLocationMessage({ ...fix(c), trackingSessionId: "customer_gps" }, {
    ...meta, role: "customer", rideId: ride.id, assignmentId: ride.assignmentSessionToken, sequence: 1, nowMs: c.now() });
  assert.equal(packet.ok, true); peer._handleMessageForTest(packet.serialized, meta.generation); assert.equal(stops, 1);
  c.advance(5000); assert.equal(starts, 2); ctrl.configureDeliveryPolicy({ firebaseFallbackEnabled: false }); assert.equal(stops, 2);
  await ctrl.stop({ closeRemote: false }); ctrl.destroy(); assert.equal(c.count(), 0);
});
test("background probe applies live interval/disable, rejects old in-flight results, and skips healthy P2P", async () => {
  const c = clock(); let count = 0, paint = 0, needed = false, resolve;
  const p = createBackgroundLocationProbe({ setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, getTarget: () => ({ key: "ride" }), shouldRead: () => needed,
    read: () => { count++; return new Promise((r) => resolve = r); }, onData: () => paint++ });
  p.configureDeliveryPolicy(resolveLocationDeliveryPolicy({ customerLocationFallbackSeconds: 30 })); p.start();
  c.advance(30000); await settle(); assert.equal(count, 0); needed = true; c.advance(30000); await settle(); assert.equal(count, 1);
  p.configureDeliveryPolicy({ customerBackgroundReadIntervalMs: 60000 }); c.advance(60000); await settle(); assert.equal(count, 1, "policy change cannot overlap an existing read");
  p.configureDeliveryPolicy({ firebaseFallbackEnabled: false }); resolve({}); await settle(); assert.equal(paint, 0);
  p.configureDeliveryPolicy({ firebaseFallbackEnabled: true, customerBackgroundReadIntervalMs: 60000 });
  c.advance(30000); assert.equal(count, 1); c.advance(30000); assert.equal(count, 2); resolve({}); await settle(); assert.equal(paint, 1);
  p.configureDeliveryPolicy({ customerBackgroundReadIntervalMs: 0 }); c.advance(600000); assert.equal(count, 2); p.stop(); assert.equal(c.count(), 0);
});
test("skipped queued write does not consume tracking-session stamp or report completion", async () => {
  let skip = true; const calls = [];
  const q = createLocationWriteSerializer({ writeFn: async (job) => { calls.push(job); return skip ? false : undefined; } });
  const job = { generation: 1, sessionId: "one", stampSessionStart: true };
  await q.enqueue(job); assert.equal(q.getStats().writesCompleted, 0); assert.equal(q.getStats().sessionStartStamped, false);
  skip = false; await q.enqueue(job); assert.equal(calls[1].stampSessionStart, true); assert.equal(q.getStats().writesCompleted, 1);
});
test("old in-flight write cannot consume a new tracking-session stamp", async () => {
  let done; const q = createLocationWriteSerializer({ writeFn: () => new Promise((r) => done = r) });
  const pending = q.enqueue({ generation: 1, stampSessionStart: true }); q.resetSessionStartGate(); done(); await pending;
  assert.equal(q.getStats().sessionStartStamped, false); assert.equal(q.getStats().writesCompleted, 0);
});
test("every admin interval has an accessible input, shared validation and server save path", () => {
  const html = source("super-admin-panel/index.html");
  for (const key of Object.keys(LOCATION_DELIVERY_FIELDS)) { assert.ok(html.includes(`id="${key}"`)); assert.ok(html.includes(`for="${key}"`)); }
  assert.ok(source("functions/index.js").includes("locationDeliverySettingsPatch(request.data)"));
  assert.ok(source("functions/admin-claims.js").includes("...LOCATION_DELIVERY_KEYS"));
  assert.ok(source("driver-app/js/driver-app.js").includes("checkpointPolicy.configureDeliveryPolicy(delivery)"));
  assert.equal(source("customer-app/js/ride-flow.js").includes("fetchLiveLocationDeliveryPolicy"), false);
  for (const f of ["driver-app/js/driver-app.js", "customer-app/js/ride-flow.js", "customer-app/js/data.js", "super-admin-panel/js/admin-app.js"]) {
    const check = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source(f), encoding: "utf8" }); assert.equal(check.status, 0, check.stderr);
  }
});
test("native uploader treats admin suppression as consumed, not a failed queued location", () => {
  const native = source("mobile/partner/android/app/src/main/java/com/swiftgo/partner/BackgroundLocationUploader.java");
  const policy = source("mobile/partner/android/app/src/main/java/com/swiftgo/partner/NativeLocationPolicy.java");
  assert.match(policy, /"FIREBASE_DISABLED"\.equals\(reason\)/);
  assert.match(policy, /"P2P_FIRST_GRACE"\.equals\(reason\)/);
  assert.match(native, /NativeLocationPolicy\.drop\(reason\)/);
  assert.match(native, /state\.remove\("pending"\); failures = 0/);
});
