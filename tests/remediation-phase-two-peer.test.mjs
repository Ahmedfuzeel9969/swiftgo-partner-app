import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createP2pPeerSession as driverPeer } from "../driver-app/js/p2p-peer-session.mjs";
import { createP2pPeerSession as customerPeer } from "../customer-app/js/p2p-peer-session.mjs";
import { buildP2pLocationMessage, validateP2pMessage, buildP2pAckMessage } from "../driver-app/js/p2p-location-envelope.mjs";
import { createDriverP2pController } from "../driver-app/js/p2p-ride-controller.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { rideLocationAssignmentVersion } from "../shared/js/ride-location-contract.mjs";
import { clock, rtcFactory, Channel, settle, ride } from "./helpers/location-test-kit.mjs";
const av = rideLocationAssignmentVersion(ride);
const meta = { peerSessionId: "peer_session_123456", trackingSessionId: "driver_tracking", assignmentVersion: av };

async function peers(options = {}) {
  const c = clock(), rtc = rtcFactory(), driverReceived = [], customerReceived = [];
  const deps = { nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout,
    RTCPeerConnection: rtc.Peer, ensureIceConfiguration: async () => {}, rideId: ride.id, assignmentId: ride.assignmentSessionToken };
  const driver = driverPeer({ ...deps, role: "driver", onLocationFix: (f) => { driverReceived.push(f); return options.acceptDriver !== false; } });
  const customer = customerPeer({ ...deps, role: "customer", onLocationFix: (f) => { customerReceived.push(f); return options.acceptCustomer !== false; } });
  await driver.startAsDriver(meta);
  await customer.startAsCustomer({ ...meta, offerSdp: "v=0\r\no=- offer\r\n" });
  await driver.acceptRemoteAnswer("v=0\r\no=- answer\r\n");
  const dc = rtc.instances[0].channel, cc = new Channel(); dc.remote = cc; cc.remote = dc;
  rtc.instances[1].ondatachannel({ channel: cc });
  // Set both ready before firing either open event so synchronous test ACKs can return.
  dc.readyState = cc.readyState = "open"; dc.open(); cc.open();
  const fix = (role, sequence = 1) => ({ lat: 24.86 + sequence * 0.00001, lng: 67.01, accuracyM: 10, observedAt: c.now(),
    sequence, trackingSessionId: role === "driver" ? meta.trackingSessionId : "customer_tracking" });
  return { c, driver, customer, dc, cc, driverReceived, customerReceived, fix,
    close: async () => { await driver.close(); await customer.close(); } };
}

test("driver and customer use identical transport/protocol implementations", () => {
  for (const file of ["p2p-peer-session.mjs", "p2p-location-envelope.mjs"]) {
    assert.equal(readFileSync(new URL(`../driver-app/js/${file}`, import.meta.url), "utf8"), readFileSync(new URL(`../customer-app/js/${file}`, import.meta.url), "utf8"));
  }
});
test("both directions deliver original sample identity and distinct location ACKs", async () => {
  const h = await peers();
  h.customer.enqueueLocationFix(h.fix("customer", 71));
  assert.equal(h.driverReceived.length, 1);
  assert.equal(h.driverReceived[0].sequence, 71);
  assert.equal(h.driverReceived[0].transportSequence, 1);
  assert.equal(h.driverReceived[0].trackingSessionId, "customer_tracking");
  assert.equal(h.customer.getState().isOutboundLocationHealthy, true);
  assert.equal(h.customer.getState().isLocDeliveryHealthy, false, "sending customer GPS cannot prove inbound driver delivery");
  assert.equal(h.driver.getState().isLocDeliveryHealthy, false, "receiving customer GPS cannot prove driver's outbound delivery");
  h.driver.enqueueLocationFix(h.fix("driver", 41));
  assert.equal(h.customerReceived.length, 1);
  assert.equal(h.customerReceived[0].sequence, 41);
  assert.equal(h.driver.getState().isLocDeliveryHealthy, true);
  assert.equal(h.customer.getState().isLocDeliveryHealthy, true);
  assert.equal(h.driver.getCounters().acknowledgementsReceived, 1);
  assert.equal(h.customer.getCounters().acknowledgementsReceived, 1);
  assert.equal(h.cc.sent.find((m) => m.type === "ack" && m.ackKind === "loc").role, "customer");
  assert.equal(h.dc.sent.find((m) => m.type === "ack" && m.ackKind === "loc").role, "driver");
  await h.close(); assert.equal(h.c.count(), 0);
});
test("continuous bidirectional GPS does not throttle the opposite direction or confuse sequence counters", async () => {
  const h = await peers();
  for (let i = 1; i <= 20; i++) {
    h.driver.enqueueLocationFix(h.fix("driver", i));
    h.c.advance(200);
    h.customer.enqueueLocationFix(h.fix("customer", i));
    h.c.advance(2800);
  }
  assert.equal(h.driverReceived.length, 20); assert.equal(h.customerReceived.length, 20);
  assert.equal(h.driver.getCounters().acknowledgementsReceived, 20);
  assert.equal(h.customer.getCounters().acknowledgementsReceived, 20);
  await h.close();
});
test("downstream rejected location is not acknowledged and never establishes delivery health", async () => {
  const h = await peers({ acceptCustomer: false, acceptDriver: false });
  h.driver.enqueueLocationFix(h.fix("driver")); h.customer.enqueueLocationFix(h.fix("customer"));
  assert.equal(h.driver.getCounters().acknowledgementsReceived, 0);
  assert.equal(h.customer.getCounters().acknowledgementsReceived, 0);
  assert.equal(h.driver.getState().isLocDeliveryHealthy, false);
  assert.equal(h.customer.getState().isLocDeliveryHealthy, false);
  await h.close();
});
test("wrong ride/assignment/role/session, duplicate sample and impossible jump never receive ACKs", async () => {
  const h = await peers(); h.driver.enqueueLocationFix(h.fix("driver"));
  const packet = h.dc.sent.find((m) => m.type === "loc");
  const before = h.cc.sent.filter((m) => m.ackKind === "loc").length;
  for (const delta of [{ rideId: "other" }, { assignmentId: "retired_assignment" }, { role: "customer" }, { sampleSessionId: "retired" },
    { observedAt: h.c.now() - 30001 }, { lat: 70, observedAt: h.c.now() + 100 }, { observedAt: h.c.now() }]) {
    h.cc.onmessage({ data: JSON.stringify({ ...packet, seq: 2, fixSequence: 2, ...delta }) });
  }
  assert.equal(h.customerReceived.length, 1);
  assert.equal(h.cc.sent.filter((m) => m.ackKind === "loc").length, before);
  assert.ok(h.customer.getCounters().invalidMessages >= 7);
  await h.close();
});
test("heartbeat ACK and forged unsent ACK do not mark either outbound direction healthy", async () => {
  const h = await peers();
  for (const [target, channel, role] of [[h.driver, h.dc, "customer"], [h.customer, h.cc, "driver"]]) {
    const ack = buildP2pAckMessage({ ...meta, role, sequence: 999, ackKind: "loc" });
    channel.onmessage({ data: ack.serialized });
    assert.equal(target.getState().isOutboundLocationHealthy, false);
  }
  await h.close();
});
test("backpressure retains only latest original GPS sample and stale queued fixes are discarded", async () => {
  const h = await peers(); h.cc.bufferedAmount = 1_000_000;
  h.customer.enqueueLocationFix(h.fix("customer", 1)); h.c.advance(3000);
  h.customer.enqueueLocationFix(h.fix("customer", 2)); h.cc.bufferedAmount = 0; h.c.advance(1000);
  assert.equal(h.driverReceived.length, 1); assert.equal(h.driverReceived[0].sequence, 2);
  h.cc.bufferedAmount = 1_000_000; h.c.advance(3000); h.customer.enqueueLocationFix(h.fix("customer", 3));
  h.c.advance(31000); h.cc.bufferedAmount = 0; h.c.advance(1000);
  assert.equal(h.driverReceived.length, 1); await h.close();
});
test("P2P builder rejects fabricated or coerced GPS before transport", () => {
  for (const delta of [{ observedAt: undefined }, { lat: "24.86" }, { accuracyM: -1 }, { observedAt: 1 }]) {
    assert.equal(buildP2pLocationMessage({ lat: 24.86, lng: 67.01, observedAt: 1_000_000, ...delta }, { ...meta, sequence: 1, nowMs: 1_000_000 }).ok, false);
  }
});
test("driver controller routes P2P customer position to its one marker and rejects retired assignments", async () => {
  const c = clock(), rtc = rtcFactory(), frames = [];
  const controller = createDriverP2pController({ nowMs: c.now, RTCPeerConnection: rtc.Peer, ensureIceConfiguration: async () => {},
    createRidePeerOfferClient: async () => ({ assignmentVersion: av }), closeRidePeerSessionClient: async () => {}, watchRidePeerSession: () => () => {},
    onCustomerLocation: (fix) => { if (fix) frames.push(fix); } });
  controller.syncForRide({ ride, trackingSessionId: meta.trackingSessionId }); await settle();
  const peer = controller._getSessionForTest(); assert.ok(peer); peer._setChannelOpenForTest(true);
  const bound = peer.getState();
  const packet = buildP2pLocationMessage({ lat: 24.86, lng: 67.01, observedAt: c.now(), sequence: 8, trackingSessionId: "customer_tracking" }, {
    ...bound, role: "customer", rideId: ride.id, assignmentId: ride.assignmentSessionToken, sequence: 1, nowMs: c.now() });
  assert.equal(packet.ok, true); peer._handleMessageForTest(packet.serialized, bound.generation);
  assert.equal(frames.length, 1); assert.equal(frames[0].role, "customer");
  controller.syncForRide({ ride: { ...ride, assignmentSessionToken: "new_assignment_123" }, trackingSessionId: meta.trackingSessionId });
  await settle(); peer._handleMessageForTest(packet.serialized, bound.generation); assert.equal(frames.length, 1);
  await controller.stop({ closeRemote: false }); controller.destroy();
});
test("old asynchronous remote-close completion cannot destroy a newly bound customer ride", async () => {
  const rtc = rtcFactory(); let onOffer, finishClose;
  const controller = createCustomerP2pController({ RTCPeerConnection: rtc.Peer, nowMs: () => 1_000_000, ensureIceConfiguration: async () => {},
    watchRidePeerSession: (_id, fn) => { onOffer = fn; return () => {}; }, publishRidePeerAnswerClient: async () => ({}),
    closeRidePeerSessionClient: () => new Promise((r) => { finishClose = r; }) });
  controller.syncForRide(ride, { assignmentVersion: av });
  onOffer({ ...meta, sessionId: meta.peerSessionId, assignmentId: ride.assignmentSessionToken, offer: "v=0\r\no=- offer\r\n", state: "offer_ready" }); await settle();
  assert.ok(controller._getSessionForTest());
  const closing = controller.stop(); await settle();
  controller.syncForRide({ ...ride, id: "next_ride" }, { assignmentVersion: av });
  finishClose?.({ ok: true }); await closing;
  assert.equal(controller._getRideId(), "next_ride"); assert.equal(controller._isWatching(), true);
  await controller.stop({ closeRemote: false }); controller.destroy();
});

test("private Firebase passenger listener honors P2P grace, admin off and assignment-generation cleanup", async () => {
  const c = clock(), rtc = rtcFactory(), frames = [], listeners = [];
  let unsubscribed = 0;
  const controller = createDriverP2pController({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout,
    RTCPeerConnection: rtc.Peer, ensureIceConfiguration: async () => {}, createRidePeerOfferClient: async () => ({ assignmentVersion: av }),
    closeRidePeerSessionClient: async () => {}, watchRidePeerSession: () => () => {},
    watchCustomerLocation: (id, callback, _error, assignmentId) => { listeners.push({ id, callback, assignmentId }); return () => unsubscribed++; },
    onCustomerLocation: (fix) => { if (fix) frames.push(fix); } });
  controller.configureDeliveryPolicy({ p2pFirstGraceMs: 5000, p2pFallbackAfterMs: 5000, firebaseFallbackEnabled: true });
  controller.syncForRide({ ride, trackingSessionId: meta.trackingSessionId }); await settle();
  const sample = { lat: 24.86, lng: 67.01, observedAt: c.now(), sequence: 1, trackingSessionId: "customer_tracking", role: "customer",
    rideId: ride.id, assignmentVersion: av, assignmentId: ride.assignmentSessionToken };
  assert.equal(listeners.length, 0); // Phase four: do not bill a location-only listener during grace.
  c.advance(5000);
  assert.equal(listeners[0].assignmentId, ride.assignmentSessionToken);
  listeners[0].callback({ location: sample }); assert.equal(frames.length, 1); assert.equal(frames[0].source, "firebase");
  controller.configureDeliveryPolicy({ firebaseFallbackEnabled: false }); c.advance(1000);
  listeners[0].callback({ location: { ...sample, observedAt: c.now(), sequence: 2 } }); assert.equal(frames.length, 1);
  controller.syncForRide({ ride: { ...ride, assignmentSessionToken: "new_assignment_123" }, trackingSessionId: meta.trackingSessionId }); await settle();
  listeners[0].callback({ location: { ...sample, observedAt: c.now(), sequence: 3 } }); assert.equal(frames.length, 1);
  assert.equal(unsubscribed, 1);
  await controller.stop({ closeRemote: false }); assert.equal(unsubscribed, 1); assert.equal(c.count(), 0); controller.destroy();
});

test("ride switch cannot paint a queued old Firebase fix during synchronous P2P teardown", async () => {
  const c = clock(), frames = [];
  const controller = createCustomerP2pController({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, p2pFirstGraceMs: 5000,
    watchRidePeerSession: () => () => {}, onRenderFix: (fix) => frames.push(fix), closeRidePeerSessionClient: async () => {} });
  const old = { lat: 24.86, lng: 67.01, observedAt: c.now(), sequence: 1, trackingSessionId: meta.trackingSessionId,
    role: "driver", rideId: ride.id, assignmentVersion: av, assignmentId: ride.assignmentSessionToken };
  controller.syncForRide({ ...ride, driverLocation: old }, { assignmentVersion: av });
  assert.equal(frames.length, 0);
  controller.syncForRide({ ...ride, id: "new_ride" }, { assignmentVersion: av });
  assert.equal(frames.length, 0); c.advance(5000); assert.equal(frames.length, 0);
  await controller.stop({ closeRemote: false }); controller.destroy();
});
