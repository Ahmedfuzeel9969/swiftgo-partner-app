import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { buildP2pAckMessage } from "../driver-app/js/p2p-location-envelope.mjs";
import { createP2pIceBootstrap } from "../shared/js/p2p-ice-bootstrap-core.mjs";
import { resolveIceConfiguration, createPeerSessionId } from "../driver-app/js/p2p-protocol.mjs";
import { createP2pPeerSession as canonicalPeer } from "../shared/js/p2p-peer-session.mjs";
import { createP2pPeerSession as customerPeer } from "../customer-app/js/p2p-peer-session.mjs";
import { createPeerSessionLease } from "../shared/js/p2p-session-lease.mjs";
import { normalizeTurnServer } from "../shared/js/p2p-ice-config.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";
import { clock, rtcFactory, Channel, settle, ride } from "./helpers/location-test-kit.mjs";

const meta = { peerSessionId: "peer_phase_three_123", trackingSessionId: "driver_tracking", assignmentVersion: 3 };
const fix = (c, sequence = 1) => ({ lat: 24.86, lng: 67.01, observedAt: c.now(), sequence, trackingSessionId: meta.trackingSessionId });
function harness(extra = {}) {
  const c = clock(), rtc = rtcFactory();
  const peer = createP2pPeerSession({ role: "driver", nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout,
    RTCPeerConnection: rtc.Peer, ...extra });
  return { c, rtc, peer };
}

test("a suspended startup cannot create a late peer after credential lookup completes", async () => {
  let finish;
  const h = harness({ ensureIceConfiguration: () => new Promise((r) => { finish = r; }) });
  const starting = h.peer.startAsDriver(meta); await settle(); h.peer.suspend(); finish(); await starting;
  assert.equal(h.rtc.instances.length, 0);
  await h.peer.close(); assert.equal(h.c.count(), 0);
});
test("callbacks from a retired internal generation cannot close the replacement channel", async () => {
  const h = harness(); await h.peer.startAsDriver(meta);
  const oldChannel = h.rtc.instances[0].channel;
  await h.peer.startAsDriver({ ...meta, peerSessionId: "peer_replacement_123" });
  h.rtc.instances[1].channel.open(); const before = h.peer.getState().state;
  oldChannel.onclose(); assert.equal(h.peer.getState().state, before);
  await h.peer.close();
});
test("one old acknowledged sample cannot keep a motionless delivery path healthy forever", async () => {
  const h = harness(); await h.peer.startAsDriver(meta); h.rtc.instances[0].channel.open();
  h.peer.enqueueLocationFix(fix(h.c));
  const ack = buildP2pAckMessage({ ...meta, role: "customer", sequence: 1, ackKind: "loc" });
  h.peer._handleMessageForTest(ack.serialized, h.peer.getState().generation);
  assert.equal(h.peer.getState().isLocDeliveryHealthy, true);
  h.c.advance(10000);
  assert.equal(h.peer.getState().isHealthy, false);
  assert.equal(h.peer.getState().isLocDeliveryHealthy, false);
  await h.peer.close();
});
test("TURN cache belongs to one bootstrap, not to every user or browser context", async () => {
  const a = {}, b = {}; let calls = 0;
  const response = { configured: true, ttlMs: 3600000, turn: { urls: ["turn:relay.test:3478"], username: "u", credential: "test" } };
  await createP2pIceBootstrap({ globalObj: a, fetchTurnCredentials: async () => response }).ensureP2pIceConfiguration();
  await createP2pIceBootstrap({ globalObj: b, fetchTurnCredentials: async () => { calls++; return response; } }).ensureP2pIceConfiguration();
  assert.equal(calls, 1); assert.ok(b.__SWIFTGO_P2P_ICE__?.turn);
});
test("TLS TURN is recognized as a relay rather than mislabeled STUN-only", () => {
  const config = resolveIceConfiguration({ __SWIFTGO_P2P_ICE__: { turn: { urls: ["turns:relay.test:443?transport=tcp"], username: "u", credential: "test" } } });
  assert.equal(config.hasTurn, true);
  assert.equal(config.iceTransportPolicy, "all");
  assert.equal(resolveIceConfiguration({ __SWIFTGO_P2P_ICE__: { iceTransportPolicy: "relay" } }).iceTransportPolicy, "relay");
});

test("both applications import the same canonical functions, not copies", () => {
  assert.equal(createP2pPeerSession, canonicalPeer); assert.equal(customerPeer, canonicalPeer);
  for (const app of ["driver-app", "customer-app"]) for (const file of ["p2p-protocol.mjs", "p2p-peer-session.mjs", "p2p-location-envelope.mjs"]) {
    const text = readFileSync(new URL(`../${app}/js/${file}`, import.meta.url), "utf8");
    assert.ok(text.includes(`export * from "../../shared/js/${file}"`)); assert.ok(text.length < 160);
  }
});
test("session IDs require secure randomness and have 128 random bits", () => {
  assert.throws(() => createPeerSessionId(1, {}), /SECURE_RANDOM_UNAVAILABLE/);
  const ids = Array.from({ length: 1000 }, () => createPeerSessionId(1234));
  assert.equal(new Set(ids).size, 1000); assert.ok(ids.every((id) => /^ps_ya_[a-f0-9]{32}$/.test(id)));
});
test("TURN validation removes browser-blocked port 53 and rejects injected URLs", () => {
  const turn = normalizeTurnServer({ urls: ["turn:relay.test:53", "turn:relay.test:3478?transport=udp", "turns:relay.test:443?transport=tcp",
    "https://attacker.test", "turn:user:pass@relay.test:3478", "turn:relay.test:99999", "turns:relay.test:443?transport=udp"], username: "u", credential: "test" });
  assert.deepEqual(turn.urls, ["turn:relay.test:3478?transport=udp", "turns:relay.test:443?transport=tcp"]);
});
test("reset ignores a credential response that arrives after logout", async () => {
  const c = clock(), g = {}; let finish;
  const b = createP2pIceBootstrap({ globalObj: g, nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout,
    fetchTurnCredentials: () => new Promise((r) => { finish = r; }) });
  const pending = b.ensureP2pIceConfiguration(); await settle(); b.resetP2pIceBootstrapCache();
  finish({ configured: true, ttlMs: 3600000, turn: { urls: ["turn:relay.test:3478"], username: "old", credential: "old" } });
  await pending; await settle(); assert.equal(g.__SWIFTGO_P2P_ICE__.turn, undefined); assert.equal(c.count(), 0);
});
test("hung TURN lookup times out and expired credentials cannot survive a failed refresh", async () => {
  const c = clock(), g = {}; let good = true;
  const b = createP2pIceBootstrap({ globalObj: g, nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout,
    fetchTurnCredentials: () => good ? Promise.resolve({ configured: true, ttlMs: 60000, turn: { urls: ["turn:relay.test:3478"], username: "u", credential: "test" } }) : new Promise(() => {}) });
  await b.ensureP2pIceConfiguration(); good = false; c.advance(61000);
  const pending = b.ensureP2pIceConfiguration(); await settle(); c.advance(5000); await pending;
  assert.equal(g.__SWIFTGO_P2P_ICE__.turn, undefined); b.resetP2pIceBootstrapCache(); assert.equal(c.count(), 0);
});
test("auth/ride changes get separate credentials even inside one app", async () => {
  const g = {}; let calls = 0, uid = "one";
  const b = createP2pIceBootstrap({ globalObj: g, getContextKey: (ctx) => `${uid}|${ctx.rideId}`,
    fetchTurnCredentials: async () => ({ configured: true, ttlMs: 3600000, turn: { urls: ["turn:relay.test:3478"], username: String(++calls), credential: "test" } }) });
  await b.ensureP2pIceConfiguration({ rideId: "a" }); await b.ensureP2pIceConfiguration({ rideId: "a" }); assert.equal(calls, 1);
  uid = "two"; await b.ensureP2pIceConfiguration({ rideId: "a" }); await b.ensureP2pIceConfiguration({ rideId: "b" }); assert.equal(calls, 3);
  b.resetP2pIceBootstrapCache();
});
test("late RTC createOffer cannot publish after close and all timers are released", async () => {
  const h = harness(); let finish;
  h.rtc.Peer.prototype.createOffer = () => new Promise((r) => { finish = r; });
  const pending = h.peer.startAsDriver(meta); await settle(); await h.peer.close(); await pending;
  finish({ type: "offer", sdp: "v=0" }); await settle(); assert.equal(h.peer.getCounters().offers, 0); assert.equal(h.c.count(), 0);
});
test("an unresponsive RTC operation fails within 15 seconds", async () => {
  const h = harness(); h.rtc.Peer.prototype.createOffer = () => new Promise(() => {});
  const pending = assert.rejects(h.peer.startAsDriver(meta), /P2P_OPERATION_TIMEOUT/);
  await settle(); h.c.advance(15000); await pending; await h.peer.close(); assert.equal(h.c.count(), 0);
});
test("incomplete non-trickle ICE is not uploaded at the old four-second cutoff", async () => {
  const h = harness(); h.rtc.Peer.prototype.setLocalDescription = async function (value) { this.localDescription = value; this.iceGatheringState = "gathering"; };
  const pending = assert.rejects(h.peer.startAsDriver(meta), /ICE_GATHER_TIMEOUT/); await settle();
  h.c.advance(4000); await settle(); assert.equal(h.peer.getCounters().offers, 0);
  h.c.advance(8000); await pending; await h.peer.close(); assert.equal(h.c.count(), 0);
});
test("ICE gather listener and timeout are cancelled immediately on suspension", async () => {
  const h = harness(); let listeners = 0;
  h.rtc.Peer.prototype.setLocalDescription = async function (v) { this.localDescription = v; this.iceGatheringState = "gathering"; };
  h.rtc.Peer.prototype.addEventListener = () => listeners++;
  h.rtc.Peer.prototype.removeEventListener = () => listeners--;
  const pending = h.peer.startAsDriver(meta); await settle(); h.peer.suspend(); await pending;
  assert.equal(listeners, 0); assert.equal(h.c.count(), 0); await h.peer.close();
});
test("first-location ACK timeout is armed again after reconnect", async () => {
  let reconnects = 0; const h = harness({ onNeedReconnect: () => reconnects++ });
  await h.peer.startAsDriver(meta); h.rtc.instances[0].channel.open(); h.peer.enqueueLocationFix(fix(h.c));
  await h.peer.startAsDriver({ ...meta, peerSessionId: "peer_phase_three_new" });
  h.rtc.instances[1].channel.open(); h.peer.enqueueLocationFix(fix(h.c)); h.c.advance(15000);
  assert.ok(reconnects > 0); await h.peer.close();
});
test("customer outbound location has its own first-ACK timeout", async () => {
  let reconnects = 0; const h = harness({ role: "customer", onNeedReconnect: () => reconnects++ });
  await h.peer.startAsCustomer({ ...meta, offerSdp: "v=0" });
  const channel = new Channel(); h.rtc.instances[0].ondatachannel({ channel }); channel.open();
  h.peer.enqueueLocationFix({ ...fix(h.c), trackingSessionId: "customer_tracking" }); h.c.advance(15000);
  assert.ok(reconnects > 0); await h.peer.close();
});
test("outgoing heartbeats alone cannot prove the remote peer is alive", async () => {
  const h = harness(); await h.peer.startAsDriver(meta); h.rtc.instances[0].channel.open();
  assert.equal(h.peer.getState().isTransportAlive, false); h.c.advance(12000);
  assert.equal(h.peer.getState().isTransportAlive, false); await h.peer.close();
});
test("brief network handover keeps the same peer; prolonged failure asks for one new generation", async () => {
  let reconnects = 0; const h = harness({ onNeedReconnect: () => reconnects++ }); await h.peer.startAsDriver(meta);
  const pc = h.rtc.instances[0]; pc.channel.open(); pc.connectionState = "disconnected"; pc.onconnectionstatechange();
  h.c.advance(1000); pc.connectionState = "connected"; pc.onconnectionstatechange(); h.c.advance(4000);
  assert.equal(reconnects, 0); assert.equal(h.rtc.instances.length, 1);
  pc.connectionState = "failed"; pc.onconnectionstatechange(); h.c.advance(1); assert.equal(reconnects, 1);
  await h.peer.close();
});
test("reconnect exceptions are caught and use a bounded cooldown instead of stopping forever", async () => {
  const h = harness(); let attempts = 0;
  const fail = async () => { attempts++; throw new Error("fixture failure"); };
  h.peer.scheduleReconnect(fail);
  for (let i = 0; i < 30; i++) { h.c.advance(30000); await settle(); }
  assert.ok(attempts >= 8 && attempts < 30); await h.peer.close(); const before = attempts;
  h.c.advance(200000); await settle(); assert.equal(attempts, before); assert.equal(h.c.count(), 0);
});
test("lease renews for a virtual hour without starting a new transport or renewal storm", async () => {
  const c = clock(); let calls = 0, expired = 0;
  const lease = createPeerSessionLease({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout,
    renew: async () => { calls++; return { ok: true, expiresAtMs: c.now() + 900000 }; }, onExpired: () => expired++ });
  lease.observe("one", c.now() + 900000);
  for (let i = 0; i < 60; i++) { c.advance(60000); await settle(); lease.observe("one", lease.getState().expiresAt); }
  assert.equal(calls, 6); assert.equal(expired, 0); lease.stop(); assert.equal(c.count(), 0);
});
test("a failed or hung renewal reaches a finite deadline and cannot resurrect a stopped lease", async () => {
  const c = clock(); let expired = 0, finish;
  const lease = createPeerSessionLease({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout,
    renew: () => new Promise((r) => { finish = r; }), onExpired: () => expired++ });
  lease.observe("one", c.now() + 310000);
  for (let i = 0; i < 33; i++) { c.advance(10000); await settle(); }
  assert.equal(expired, 1); lease.stop(); finish?.({ ok: true, expiresAtMs: c.now() + 900000 }); await settle();
  assert.equal(c.count(), 0); assert.equal(lease.getState().expiresAt, 0);
});
test("observer lease extends on trusted metadata and expires only once", async () => {
  const c = clock(); let expired = 0;
  const lease = createPeerSessionLease({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, onExpired: () => expired++ });
  lease.observe("one", c.now() + 60000); c.advance(30000); lease.observe("one", c.now() + 60000);
  c.advance(30000); assert.equal(expired, 0); c.advance(30000); assert.equal(expired, 1);
  c.advance(60000); assert.equal(expired, 1); lease.stop();
});
test("customer reconnect retains the exact server offer fingerprint after answering", async () => {
  const c = clock(), rtc = rtcFactory(), closed = []; let onOffer;
  const controller = createCustomerP2pController({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout,
    RTCPeerConnection: rtc.Peer, ensureIceConfiguration: async () => {}, answerMemory: null,
    watchRidePeerSession: (_id, cb) => { onOffer = cb; return () => {}; }, publishRidePeerAnswerClient: async () => ({}),
    closeRidePeerSessionClient: async (payload) => { closed.push(payload); return { ok: true }; } });
  controller.syncForRide(ride, { assignmentVersion: 3 });
  onOffer({ ...meta, sessionId: meta.peerSessionId, assignmentId: ride.assignmentSessionToken,
    offer: "v=0", state: "offer_ready", offerFingerprint: "sha256_fixture", expiresAt: c.now() + 900000 });
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(controller._getSessionForTest().getState().state, "CONNECTING");
  c.advance(30000); await settle();
  assert.equal(closed.length, 1); assert.equal(closed[0].offerFingerprint, "sha256_fixture");
  assert.equal(closed[0].peerSessionId, meta.peerSessionId);
  await controller.stop({ closeRemote: false }); controller.destroy(); assert.equal(c.count(), 0);
});

test("one virtual hour of bidirectional GPS/ACK uses one transport per side", async () => {
  const c = clock(), rtc = rtcFactory(); let driverReceived = 0, customerReceived = 0;
  const deps = { nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, RTCPeerConnection: rtc.Peer };
  const driver = canonicalPeer({ ...deps, role: "driver", onLocationFix: () => { driverReceived++; return true; } });
  const customer = canonicalPeer({ ...deps, role: "customer", onLocationFix: () => { customerReceived++; return true; } });
  await driver.startAsDriver(meta); await customer.startAsCustomer({ ...meta, offerSdp: "v=0" }); await driver.acceptRemoteAnswer("v=0");
  const dc = rtc.instances[0].channel, cc = new Channel(); dc.remote = cc; cc.remote = dc;
  rtc.instances[1].ondatachannel({ channel: cc }); dc.readyState = cc.readyState = "open"; dc.open(); cc.open();
  for (let i = 1; i <= 1200; i++) {
    driver.enqueueLocationFix({ ...fix(c, i), lat: 24.86 + i * 0.000001 });
    customer.enqueueLocationFix({ ...fix(c, i), lat: 24.85 + i * 0.000001, trackingSessionId: "customer_tracking" });
    c.advance(3000); await settle();
  }
  assert.equal(driverReceived, 1200); assert.equal(customerReceived, 1200);
  for (const peer of [driver, customer]) {
    assert.equal(peer.getCounters().sessionsStarted, 1); assert.equal(peer.getCounters().acknowledgementsReceived, 1200);
    assert.equal(peer.getState().isLocDeliveryHealthy, true); await peer.close();
  }
  assert.equal(c.count(), 0);
});
test("active TURN credentials refresh before expiry without replacing a healthy PC", async () => {
  let calls = 0, binding;
  const h = harness({ rideId: ride.id, assignmentId: ride.assignmentSessionToken,
    ensureIceConfiguration: async (context) => {
      calls++; binding = context;
      return { turn: { urls: ["turns:relay.test:443?transport=tcp"], username: `temporary_${calls}`, credential: "test" }, turnExpiresAtMs: h.c.now() + 120000 };
    } });
  h.rtc.Peer.prototype.setConfiguration = function (cfg) { this.updatedConfig = cfg; };
  await h.peer.startAsDriver(meta); const pc = h.rtc.instances[0]; pc.channel.open();
  h.c.advance(60000); await settle();
  assert.equal(calls, 2); assert.equal(pc.updatedConfig.iceServers.at(-1).username, "temporary_2");
  assert.equal(binding.rideId, ride.id); assert.equal(binding.assignmentId, ride.assignmentSessionToken);
  assert.equal(h.rtc.instances.length, 1); await h.peer.close(); assert.equal(h.c.count(), 0);
});

test("a delayed ACK for an expired GPS sample cannot revive delivery health", async () => {
  const h = harness({ fallbackAfterMs: 5000, onNeedReconnect: () => {} });
  await h.peer.startAsDriver(meta); h.rtc.instances[0].channel.open(); h.peer.enqueueLocationFix(fix(h.c)); h.c.advance(6000);
  h.peer._handleMessageForTest(buildP2pAckMessage({ ...meta, role: "customer", sequence: 1, ackKind: "loc" }).serialized, h.peer.getState().generation);
  assert.equal(h.peer.getCounters().acknowledgementsReceived, 0); assert.equal(h.peer.getState().isLocDeliveryHealthy, false);
  await h.peer.close();
});
