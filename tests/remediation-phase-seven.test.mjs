import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBackgroundLocationNativeController } from "../driver-app/js/background-location-native.mjs";
import { createCustomerP2pBackgroundKeepalive } from "../customer-app/js/p2p-background-keepalive.mjs";
import { credentialCacheMatches, resolveUploadUrl, resolveRefreshUrl, DEFAULT_UPLOAD_BASE, normalizeNativeBinding } from "../driver-app/js/background-location-credential-policy.mjs";
import { getNativePlugin, getNetworkStatus, openBatteryOptimizationSettings } from "../shared/js/native-bridge.mjs";
import { packageWebSlice, verifyMobileSources } from "../tools/mobile-verify.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = 1_900_000_000_000;
const binding = (extra = {}) => ({ rideId: "ride-a", vehicleId: "vehicle", driverUid: "driver",
  trackingSessionId: "tracking-a", assignmentSessionToken: "assignment-a", rideStatus: "accepted", ...extra });
const issued = (extra = {}) => ({ ok: true, token: "test-only-credential", expiresAtMs: NOW + 900_000, ...extra });
const peerIssued = (extra = {}) => ({ ok: true, token: "test-only-p2p-credential",
  expiresAtMs: NOW + 1_800_000, signalPath: "/nativeRidePeerTransport", assignmentVersion: 42, ...extra });
const customerRide = (extra = {}) => ({ id: "ride", status: "accepted", vehicleId: "vehicle",
  driverId: "driver", assignmentSessionToken: "assignment-a", ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(extra = {}) {
  const calls = [], listeners = [], timers = new Map();
  let nextId = 0, timerId = 0;
  const plugin = {
    async start(b) { calls.push(["start", b]); return { ok: true, running: true, lastSequence: 23 }; },
    async stop() { calls.push(["stop"]); return { ok: true }; },
    async noteWebAlive(b) { calls.push(["alive", b]); return { ok: true }; },
    async updateCredential(b) { calls.push(["credential", b]); return { ok: true }; },
    async updateP2pCredential(b) { calls.push(["p2pCredential", b]); return { ok: true }; },
    async addListener(name, fn) {
      const listener = { name, fn, removed: false };
      listeners.push(listener);
      return { remove: async () => { listener.removed = true; } };
    },
    ...extra.plugin,
  };
  const options = { getPlugin: () => plugin, nowMs: () => NOW,
    newSessionId: () => "bridge-" + ++nextId,
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearInterval: id => timers.delete(id),
    httpsCallable: name => async () => ({ data: name === "issueNativeP2pCredential" ? peerIssued() : issued() }),
    issueCredential: async () => peerIssued(), ...extra.options };
  return { plugin, calls, listeners, timers, options, driver: createBackgroundLocationNativeController(options) };
}
for (const endpoint of [
  "http://us-central1-swiftgo-ride-app.cloudfunctions.net/ingestBackgroundDriverLocation",
  DEFAULT_UPLOAD_BASE + ".evil.test/ingestBackgroundDriverLocation",
  DEFAULT_UPLOAD_BASE + "/ingestBackgroundDriverLocation?token=secret",
  DEFAULT_UPLOAD_BASE + "/other/ingestBackgroundDriverLocation",
  "https://user:password@us-central1-swiftgo-ride-app.cloudfunctions.net/ingestBackgroundDriverLocation",
  DEFAULT_UPLOAD_BASE + ":444/ingestBackgroundDriverLocation",
  DEFAULT_UPLOAD_BASE + "/ingestBackgroundDriverLocation#fragment",
]) test("untrusted native endpoint rejected: " + endpoint, () => assert.throws(() => resolveUploadUrl(endpoint)));
test("upload and renewal use distinct exact HTTPS endpoints", () => {
  assert.equal(resolveUploadUrl(), DEFAULT_UPLOAD_BASE + "/ingestBackgroundDriverLocation");
  assert.equal(resolveRefreshUrl(), DEFAULT_UPLOAD_BASE + "/refreshBackgroundDriverLocationCredential");
  assert.throws(() => resolveRefreshUrl("", "https://evil.test"));
});
for (const expiry of [NaN, Infinity, 0, NOW - 1, "not-a-date", undefined]) test("invalid credential expiry is not cached: " + expiry, () => {
  assert.equal(credentialCacheMatches({ ...binding(), token: "t", expiresAtMs: expiry }, binding(), NOW), false);
});
test("credential cache matches every assignment identity field", () => {
  const cached = { ...binding(), token: "t", expiresAtMs: NOW + 900_000 };
  assert.equal(credentialCacheMatches(cached, binding(), NOW), true);
  for (const key of ["rideId", "vehicleId", "driverUid", "trackingSessionId", "assignmentSessionToken"])
    assert.equal(credentialCacheMatches(cached, binding({ [key]: "changed" }), NOW), false);
});
test("invalid bindings/terminal rides never create a service", async () => {
  const f = fixture();
  assert.throws(() => normalizeNativeBinding(binding({ assignmentSessionToken: "" })));
  assert.equal((await f.driver.start(binding({ rideStatus: "completed" }))).ok, false);
  assert.equal(f.calls.filter(c => c[0] === "start").length, 0);
});
test("stop during credential issue cannot resurrect native tracking", async () => {
  const d = deferred(), f = fixture({ options: { httpsCallable: () => () => d.promise } });
  const starting = f.driver.start(binding());
  await f.driver.stop(); d.resolve({ data: issued() });
  assert.equal((await starting).reason, "superseded");
  assert.equal(f.calls.filter(c => c[0] === "start").length, 0);
  assert.equal(f.driver.getLastCredentialMeta(), null);
  assert.equal(f.timers.size, 0);
});
test("late ride-A credential cannot attach itself to ride B", async () => {
  const a = deferred(), b = deferred();
  const f = fixture({ options: { httpsCallable: () => input => input.rideId === "ride-a" ? a.promise : b.promise } });
  const first = f.driver.start(binding()), second = f.driver.start(binding({ rideId: "ride-b" }));
  b.resolve({ data: issued({ token: "credential-b" }) }); assert.equal((await second).ok, true);
  a.resolve({ data: issued({ token: "credential-a" }) }); assert.equal((await first).reason, "superseded");
  const starts = f.calls.filter(c => c[0] === "start");
  assert.equal(starts.length, 1); assert.equal(starts[0][1].rideId, "ride-b"); assert.equal(starts[0][1].token, "credential-b");
  await f.driver.stop();
});
test("stop is not queued behind an OS permission dialog", async () => {
  const pending = deferred();
  const f = fixture({ plugin: { start: () => pending.promise, stop: async () => { pending.reject(new Error("cancelled")); return { ok: true }; } } });
  const starting = f.driver.start(binding()); await drain();
  const stopped = await f.driver.stop(); await starting;
  assert.equal(stopped.ok, true); assert.equal(f.driver.isStarted(), false); assert.equal(f.timers.size, 0);
});
test("late native start result never recreates timers after stop", async () => {
  const pending = deferred();
  const f = fixture({ plugin: { start: () => pending.promise } });
  const starting = f.driver.start(binding()); await drain();
  const stopping = f.driver.stop(); pending.resolve({ ok: true, running: true });
  assert.equal((await starting).reason, "superseded"); await stopping;
  assert.equal(f.driver.isStarted(), false); assert.equal(f.timers.size, 0);
  assert.ok(f.listeners.every(l => l.removed));
});
test("driver filters old-session and wrong-ride events, resumes sequence, redacts metadata", async () => {
  const fixes = [], sequences = [], f = fixture({ options: { onNativeFix: x => fixes.push(x), onNativeSequence: n => sequences.push(n) } });
  await f.driver.start(binding());
  const first = f.listeners.find(l => l.name === "locationFix");
  first.fn({ rideId: "ride-a", bridgeSessionId: "wrong" });
  first.fn({ rideId: "wrong", bridgeSessionId: "bridge-1" });
  first.fn({ rideId: "ride-a", bridgeSessionId: "bridge-1", lat: 1 });
  assert.equal(fixes.length, 1); assert.deepEqual(sequences, [23]);
  assert.deepEqual(Object.keys(f.driver.getLastCredentialMeta()).sort(), ["expiresAtMs", "ready"]);
  await f.driver.start(binding({ trackingSessionId: "tracking-b" }));
  first.fn({ rideId: "ride-a", bridgeSessionId: "bridge-1", lat: 2 });
  assert.equal(fixes.length, 1); await f.driver.stop();
});
test("unchanged assignment does not restart GPS or duplicate listeners", async () => {
  const f = fixture();
  await f.driver.start(binding()); const result = await f.driver.start(binding());
  assert.equal(result.reused, true); assert.equal(f.listeners.length, 3);
  assert.equal(f.calls.filter(c => c[0] === "start").length, 1); await f.driver.stop();
});
test("missing expiry or hostile endpoint permits GPS-only, never credential fallback", async () => {
  for (const bad of [{ expiresAtMs: undefined }, { uploadUrl: "https://evil.test" }]) {
    const f = fixture({ options: { httpsCallable: () => async () => ({ data: issued(bad) }) } });
    const result = await f.driver.start(binding());
    assert.equal(result.ok, true); assert.equal(result.credentialReady, false);
    assert.equal(f.calls.find(c => c[0] === "start")[1].token, ""); await f.driver.stop();
  }
});
test("native false/empty/error result never claims running", async () => {
  for (const result of [undefined, { ok: true }, { ok: false, running: false }]) {
    const f = fixture({ plugin: { start: async () => result } });
    assert.equal((await f.driver.start(binding())).ok, false);
    assert.equal(f.driver.isStarted(), false); assert.equal(f.timers.size, 0);
  }
});
test("heartbeat failure marks stopped and removes refresh timers", async () => {
  const f = fixture({ plugin: { noteWebAlive: async () => ({ ok: false }) } });
  await f.driver.start(binding()); await drain();
  assert.equal(f.driver.isStarted(), false); assert.equal(f.timers.size, 0); await f.driver.stop();
});
test("late credential renewal after stop is discarded", async () => {
  const renewal = deferred(); let clock = NOW, issues = 0;
  const f = fixture({ options: { nowMs: () => clock, httpsCallable: name => () => name === "issueNativeP2pCredential"
    ? Promise.resolve({ data: peerIssued({ expiresAtMs: clock + 1_800_000 }) })
    : ++issues === 1 ? Promise.resolve({ data: issued() }) : renewal.promise } });
  await f.driver.start(binding());
  clock += 850_000;
  const refreshing = [...f.timers.values()].find(t => t.ms === 60_000).fn();
  await drain(); await f.driver.stop();
  renewal.resolve({ data: issued({ expiresAtMs: clock + 900_000 }) }); await refreshing;
  assert.equal(f.calls.filter(c => c[0] === "credential").length, 0); assert.equal(f.driver.getLastCredentialMeta(), null);
});
test("customer late start cannot outlive stop", async () => {
  const d = deferred(), f = fixture({ plugin: { start: () => d.promise } });
  const c = createCustomerP2pBackgroundKeepalive(f.options);
  const starting = c.syncForRide(customerRide()); await drain();
  const stopping = c.stop(); d.resolve({ ok: true, running: true }); await starting; await stopping;
  assert.equal(c.isStarted(), false); assert.equal(f.timers.size, 0);
});
test("customer invalid state and rejected native lease never claim liveness", async () => {
  const f = fixture({ plugin: { start: async () => ({ ok: false }) } }), c = createCustomerP2pBackgroundKeepalive(f.options);
  assert.equal((await c.syncForRide(customerRide())).ok, false);
  await c.syncForRide({ id: "ride", status: "completed" }); assert.equal(c.isStarted(), false);
});
test("customer heartbeat rejection ends its local lease", async () => {
  const f = fixture({ plugin: { noteWebAlive: async () => ({ ok: false }) } }), c = createCustomerP2pBackgroundKeepalive(f.options);
  await c.syncForRide(customerRide({ status: "in_progress" }));
  [...f.timers.values()][0].fn(); await drain(); assert.equal(c.isStarted(), false); assert.equal(f.timers.size, 0);
});
test("plain hosting native bridge is a no-op and never reports settings opened", async () => {
  assert.equal(getNativePlugin("NativeSettings"), null);
  assert.deepEqual(await openBatteryOptimizationSettings(), { ok: false, reason: "web" });
  assert.equal(typeof (await getNetworkStatus()).connected, "boolean");
});
test("installed Android policy is hardened for all three apps", () => {
  assert.equal(verifyMobileSources(ROOT).ok, true);
  for (const app of ["customer", "partner", "owner"]) {
    const base = path.join(ROOT, "mobile", app, "android", "app", "src", "main");
    for (const file of ["backup_rules.xml", "data_extraction_rules.xml"]) {
      const xml = fs.readFileSync(path.join(base, "res", "xml", file), "utf8");
      assert.match(xml, /domain="sharedpref"/); assert.match(xml, /domain="root"/); assert.match(xml, /domain="device_root"/);
    }
  }
});
test("packaging includes shared and cross-app dependencies, excludes unrelated app UIs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "swiftgo-phase-seven-test-"));
  try {
    for (const folder of ["customer", "partner", "owner", "admin", "shared", "driver-app", "customer-app", "legal"]) {
      fs.mkdirSync(path.join(temp, "dist", folder), { recursive: true });
      fs.writeFileSync(path.join(temp, "dist", folder, "index.html"), "test");
    }
    for (const app of ["customer", "partner", "owner"]) {
      const out = path.join(temp, app);
      packageWebSlice(path.join(temp, "dist"), out, app);
      assert.ok(fs.existsSync(path.join(out, "shared", "index.html")));
      assert.ok(fs.existsSync(path.join(out, "driver-app", "index.html")));
      assert.ok(!fs.existsSync(path.join(out, "admin")));
      assert.match(fs.readFileSync(path.join(out, "index.html"), "utf8"), new RegExp("url=./" + app + "/"));
      assert.throws(() => packageWebSlice(path.join(temp, "dist"), out, app), /EXISTING_PACKAGE/);
    }
    assert.throws(() => packageWebSlice(path.join(temp, "dist"), path.join(temp, "bad"), "../"), /INVALID/);
  } finally {
    // A test-created unique directory only; never project/user files.
    assert.ok(path.basename(temp).startsWith("swiftgo-phase-seven-test-"));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("native source guards: no plaintext token persistence, no heartbeat service launch", () => {
  const dir = path.join(ROOT, "mobile/partner/android/app/src/main/java/com/swiftgo/partner");
  const uploader = fs.readFileSync(path.join(dir, "BackgroundLocationUploader.java"), "utf8");
  const store = fs.readFileSync(path.join(dir, "SecureLocationStore.java"), "utf8");
  const plugin = fs.readFileSync(path.join(dir, "DriverLocationPlugin.java"), "utf8");
  assert.match(store, /getNoBackupFilesDir/); assert.match(store, /AuthenticatedEnvelope.encrypt/); assert.match(store, /AtomicFile/);
  assert.match(uploader, /setInstanceFollowRedirects\(false\)/); assert.doesNotMatch(uploader, /Thread\.sleep|putString\("token"/);
  assert.doesNotMatch(plugin.slice(plugin.indexOf("@PluginMethod public void stop")), /startService\(/);
  for (const app of ["customer", "driver", "owner"])
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, app + "-app/js/native-shell.js"), "utf8"), /https:|import\("@capacitor/);
});
