import test from "node:test";
import assert from "node:assert/strict";
import { createRouteMotionController } from "../shared/js/route-motion-controller.mjs";
import { createDisplayLocationPipeline } from "../shared/js/display-location-pipeline.mjs";
import { buildRouteMetrics } from "../shared/js/route-projection.mjs";
import { GEOMETRY_KIND } from "../shared/js/geometry-quality.mjs";
import { clock } from "./helpers/location-test-kit.mjs";
import { createMemoryStorageAdapter, createRideLocationLocalCounterStore } from "../shared/js/ride-location-local-counter-store.mjs";
import { computeDerivedMetrics, classifyReportHealth } from "../shared/js/ride-location-report-schema.mjs";
import { mapCustomerRuntimeCounters, createRideLocationReportClient } from "../shared/js/ride-location-report-client.mjs";
import { createRouteRequestGuard } from "../shared/js/route-request-guard.mjs";
import { createOsrmPreviewProvider, resolveRouteProvider } from "../shared/js/road-route-provider.mjs";
import { createTwoLegRouteController } from "../shared/js/two-leg-route-controller.mjs";
import { resolveStreetTileConfig } from "../shared/js/map-tile-provider.mjs";
import { accumulateDenseChordMeters, validateBreadcrumbPoint } from "../shared/js/breadcrumb-schema.mjs";
import { generateReportSchemaCjs } from "../tools/sync-report-schema-cjs.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildMirrorOutcomeAggregatePatch, serverSectionFromRideAggregate, assignmentServerMirrorAggregateResetPatch } = require("../functions/server-mirror-aggregate.js");
const { accumulateTraveledSegment, resolveCancellationDistance } = require("../functions/partial-fare.js");
const tick = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };
import { requireBreadcrumbEmulators } from "./helpers/breadcrumb-test-safety.mjs";
import { createMissingOnlyBatch } from "../tools/local-preview/seed.mjs";

const geometry = [{ lat: 24.86, lng: 67 }, { lat: 24.86, lng: 67.02 }];
const route = (generation = 1) => ({ geometry, generation, activeLeg: "trip", snapEligible: true,
  geometryKind: GEOMETRY_KIND.FIXTURE_ROAD_ROUTE, providerKind: "fixture", generatedAt: 1_000_000 });
const fix = (sequence, overrides = {}) => ({ lat: 24.86, lng: 67 + sequence * 0.0001,
  observedAt: 1_000_000 + sequence * 1000, sequence, trackingSessionId: "gps-session", source: "p2p", ...overrides });
function motionKit() {
  const time = clock(), frames = [];
  return { time, frames, opts: { nowMs: time.now, raf: (fn) => time.setTimeout(fn, 10), caf: time.clearTimeout,
    onFrame: (p) => frames.push(p), onDisplayFrame: (p) => frames.push(p) } };
}
test("motion retarget starts at painted position, not the old target", () => {
  const k = motionKit(), m = createRouteMotionController(k.opts), metrics = buildRouteMetrics(geometry);
  m.setImmediate(metrics, 0);
  m.animateTo({ metrics, progressM: 100, observedGapMs: 1000 }); k.time.advance(250);
  assert.equal(k.frames.at(-1).progressM, 25);
  m.animateTo({ metrics, progressM: 200, observedGapMs: 1000 }); k.time.advance(10);
  assert.ok(k.frames.at(-1).progressM < 28);
  k.time.advance(1000); assert.equal(k.frames.at(-1).progressM, 200); assert.equal(k.time.count(), 0);
});
test("first animation has no fabricated journey from route zero", () => {
  const k = motionKit(), m = createRouteMotionController(k.opts);
  m.animateTo({ metrics: buildRouteMetrics(geometry), progressM: 900, observedGapMs: 1000 });
  k.time.advance(10); assert.equal(k.frames.at(-1).progressM, 900); m.cancel();
});
test("paint callback cancellation does not resurrect RAF", () => {
  const k = motionKit(); let m;
  m = createRouteMotionController({ ...k.opts, onFrame: () => m.cancel() });
  m.animateTo({ metrics: buildRouteMetrics(geometry), progressM: 20, observedGapMs: 1000 });
  k.time.advance(10); assert.equal(k.time.count(), 0); assert.equal(m.isAnimating(), false);
});
test("display preserves original fix identity/source/time on every animation frame", () => {
  const k = motionKit(), p = createDisplayLocationPipeline(k.opts); p.setActiveRoute(route());
  p.ingestValidatedFix(fix(1)); p.ingestValidatedFix(fix(2)); k.time.advance(300);
  assert.ok(k.frames.length > 20);
  for (const f of k.frames.slice(1)) {
    assert.equal(f.source, "p2p"); assert.equal(f.sequence, 2); assert.equal(f.observedAt, fix(2).observedAt);
  }
  p.destroy(); assert.equal(k.time.count(), 0);
});
test("unusable geometry cancels an old route animation and preserves raw source", () => {
  const k = motionKit(), p = createDisplayLocationPipeline(k.opts); p.setActiveRoute(route());
  p.ingestValidatedFix(fix(1)); p.ingestValidatedFix(fix(2)); k.time.advance(100);
  const n = k.frames.length;
  p.setActiveRoute({ ...route(), snapEligible: false }); k.time.advance(1000); assert.equal(k.frames.length, n);
  p.ingestValidatedFix(fix(3, { source: "firebase" })); assert.equal(k.frames.at(-1).source, "firebase");
  p.destroy();
});
test("stale route generations cannot replace a new route; missing timestamps are not invented", () => {
  const k = motionKit(), p = createDisplayLocationPipeline(k.opts); p.setActiveRoute(route(3));
  assert.equal(p.setActiveRoute(route(2)).reason, "stale_generation");
  assert.equal(p.ingestValidatedFix(fix(1, { observedAt: null })).mode, "ignore");
  p.ingestValidatedFix(fix(1)); const n = k.frames.length;
  assert.equal(p.ingestValidatedFix(fix(1)).mode, "ignore"); assert.equal(k.frames.length, n);
  p.destroy(); assert.equal(p.setActiveRoute(route(4)).reason, "closed");
});
test("unchanged route model retains its motion progress domain", () => {
  const k = motionKit(), p = createDisplayLocationPipeline(k.opts); p.setActiveRoute(route());
  p.ingestValidatedFix(fix(1)); p.ingestValidatedFix(fix(2)); k.time.advance(250);
  p.setActiveRoute(route()); assert.equal(p.getCounters().generationResets, 1);
  p.ingestValidatedFix(fix(3)); k.time.advance(10);
  assert.ok(k.frames.at(-1).lng < fix(2).lng); p.destroy();
});
test("100 animation paints count as one unique GPS fix, with durable deduplication", () => {
  const storage = createMemoryStorageAdapter(), binding = { rideId: "test-ride", assignmentSessionTokenHash: "a".repeat(64) };
  const s = createRideLocationLocalCounterStore({ role: "customer", storage, nowMs: () => 1_000_000 }); s.bind(binding);
  for (let n = 0; n < 100; n++) s.recordDisplayFrame(fix(1), 1_002_000 + n * 10);
  s.bumpSubmitSequence(); const section = s.snapshotSection();
  assert.equal(section.counters.p2pValidRendered, 1); assert.equal(section.counters.mapFramesPainted, 100);
  const again = createRideLocationLocalCounterStore({ role: "customer", storage }); again.bind(binding);
  assert.equal(again.recordDisplayFrame(fix(1), 1_004_000), false);
  assert.equal(again.snapshotSection().counters.p2pValidRendered, 1);
});
test("runtime selection is not falsely counted as map painting", () => {
  const counters = mapCustomerRuntimeCounters({ p2pReceived: 5, p2pAccepted: 4, p2pRendered: 400, firebaseReceived: 8, firebaseAccepted: 2 });
  assert.equal(counters.p2pFramesReceived, 5); assert.equal(counters.p2pFixesAccepted, 4);
  assert.equal(counters.p2pValidRendered, undefined); assert.equal(counters.firebaseSnapshotsReceived, 8);
});
test("write intervals use write times; legacy render ratios are unknown, never 500%", () => {
  const d = computeDerivedMetrics({ driver: { firstFixAtMs: 1000, lastFixAtMs: 40000, firstVehicleWriteAtMs: 2000, lastVehicleWriteAtMs: 8000,
    counters: { vehicleWritesAcknowledged: 3 } }, customer: { counters: { p2pFramesReceived: 1, p2pValidRendered: 10 } } });
  assert.equal(d.avgFirebaseWriteIntervalMs, 3000); assert.equal(d.deliveryRatios.renderedToReceived, null);
  assert.equal(d.avgMapRefreshIntervalMs, null);
});
test("new unique fix ratios and animation cadence have independent counters", () => {
  const d = computeDerivedMetrics({ customer: { measurementVersion: 2, firstMapFrameAtMs: 1000, lastMapFrameAtMs: 2000,
    counters: { p2pFramesReceived: 2, p2pFixesAccepted: 2, p2pValidRendered: 2, mapFramesPainted: 101 } } });
  assert.equal(d.deliveryRatios.renderedToReceived, 1); assert.equal(d.avgMapRefreshIntervalMs, 10);
});
test("configured sparse mirrors do not alone produce a false critical health alarm", () => {
  const health = classifyReportHealth({ driver: { submitSequence: 1, counters: { gpsFixesReceived: 20, validFixesAccepted: 20, vehicleWritesAcknowledged: 8 } },
    server: { longestGapMs: 60000, counters: { mirrorAttempts: 8, mirrorAccepted: 5 } },
    customer: { measurementVersion: 2, submitSequence: 1, counters: { p2pFramesReceived: 5, p2pFixesAccepted: 5, p2pValidRendered: 5 } } });
  assert.equal(health.status, "healthy");
});
test("visible accepted fixes without any marker paint are a real error", () => {
  const h = classifyReportHealth({ customer: { measurementVersion: 2, visibleDurationMs: 10000, counters: { p2pFixesAccepted: 3 } },
    driver: { counters: { gpsFixesReceived: 3, validFixesAccepted: 3 } } });
  assert.equal(h.status, "critical"); assert.ok(h.reasons.includes("accepted_but_no_visible_map_paint"));
});
test("all mirror outcomes are accounted for, legacy counts retained, assignment reset zeroes them", () => {
  let ride = { serverMirrorAccepted: 2 };
  for (const [reason, yes] of [["accepted", true], ["firebase_disabled", false], ["sequence_not_increasing", false], ["retired_session", false], ["location_duplicate_ignored", false], ["terminal_or_inactive", false], ["invalid_coords", false], ["ride_location_mirror_txn_failed", false]])
    ride = { ...ride, ...buildMirrorOutcomeAggregatePatch(ride, reason, yes, 10000) };
  const section = serverSectionFromRideAggregate(ride); assert.equal(section.counters.mirrorAttempts, 10);
  assert.equal(section.counters.mirrorAccepted, 3); assert.equal(section.counters.mirrorFailed, 1);
  assert.equal(Object.entries(section.counters).filter(([k]) => k !== "mirrorAttempts").reduce((n, [, v]) => n + v, 0), 10);
  assert.equal(serverSectionFromRideAggregate(assignmentServerMirrorAggregateResetPatch()), null);
});
test("report schema browser and server copies are generated identically", () => {
  const source = readFileSync(new URL("../shared/js/ride-location-report-schema.mjs", import.meta.url), "utf8");
  assert.equal(readFileSync(new URL("../functions/ride-location-report-schema.js", import.meta.url), "utf8"), generateReportSchemaCjs(source));
});
test("routing deadline ends even a non-aborting provider; late results cannot commit", async () => {
  const c = clock(), g = createRouteRequestGuard({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout, timeoutMs: 100 });
  const p = g.run(() => new Promise(() => {})); const result = assert.rejects(p, /TIMEOUT/);
  c.advance(100); await result; assert.equal(g.getState().pending, 0); assert.equal(c.count(), 0);
});
test("routing budgets, cancellation, and provider Retry-After are enforced", async () => {
  const c = clock(), g = createRouteRequestGuard({ nowMs: c.now, setTimeoutFn: c.setTimeout, clearTimeoutFn: c.clearTimeout });
  await assert.rejects(g.run(() => { throw Object.assign(new Error("busy"), { retryAfterMs: 60000 }); }), /busy/);
  await assert.rejects(g.run(() => 1), /PROVIDER_COOLDOWN/);
  c.advance(60000); const controller = new AbortController(); controller.abort();
  await assert.rejects(g.run(() => 1, { signal: controller.signal }), /ABORTED/);
  assert.equal(await g.run(() => 7), 7); assert.equal(c.count(), 0);
});
test("provider budgets survive repeated resolve calls; errors never log coordinate URLs", async () => {
  const root = { __SWIFTGO_ROUTE_PROVIDER__: { kind: "osrm_preview", enabled: true } };
  assert.equal(resolveRouteProvider(root), resolveRouteProvider(root));
  const p = createOsrmPreviewProvider({ fetchFn: async () => ({ ok: false, status: 503, text: async () => "private location" }) });
  await assert.rejects(p.route({ origin: geometry[0], destination: geometry[1] }), (e) => e.diag.requestUrl === null && e.diag.responseBodySnippet === null);
});
test("an obsolete route timeout cannot paint fallback over the next ride", async () => {
  const pending = [], provider = { id: "fixture", route: (req) => new Promise((resolve, reject) => pending.push({ req, resolve, reject })) };
  const c = createTwoLegRouteController({ provider });
  const ride = { id: "old-ride", status: "in_progress", pickupLocation: geometry[0], dropoffLocation: geometry[1] };
  c.syncRide(ride); c.syncRide({ ...ride, id: "new-ride" });
  pending[0].reject(Object.assign(new Error("old timeout"), { code: "timeout" })); await tick();
  assert.equal(c.getModel().trip.status, "loading"); assert.equal(c.getCounters().fallbackActivations, 0);
  c.destroy(); pending.at(-1).reject(Object.assign(new Error("closed"), { code: "aborted" })); await tick();
});
test("tile configuration preserves attribution and forbids unsafe or credential-bearing URLs", () => {
  const c = resolveStreetTileConfig({}); assert.equal(c.url, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.match(c.options.attribution, /copyright/);
  for (const url of ["http://example.com/{z}/{x}/{y}", "https://user:pass@example.com/{z}/{x}/{y}", "javascript:alert(1)"])
    assert.throws(() => resolveStreetTileConfig({ __SWIFTGO_TILE_PROVIDER__: { url, attribution: "test" } }));
});
test("dense chords retain bends while never bridging long gaps or rejected outliers", () => {
  const points = [fix(1), fix(2, { lat: 24.8601 }), fix(3, { lat: 24.86 })];
  const full = accumulateDenseChordMeters(points); assert.ok(full.distanceMeters > 25);
  const gap = accumulateDenseChordMeters([points[0], { ...points[1], observedAt: points[0].observedAt + 30000 }]);
  assert.equal(gap.distanceMeters, 0); assert.equal(gap.gapCount, 1);
  const outlier = accumulateDenseChordMeters([points[0], fix(2, { lat: 26 }), points[2]]);
  assert.equal(outlier.distanceMeters, 0); assert.equal(outlier.rejectedPointCount, 1);
});
test("billing breadcrumb validation rejects coerced counters/times and every display coordinate", () => {
  for (const patch of [{ sequence: "1" }, { sequence: 1.5 }, { observedAt: "1000001" }, { source: "display_raw" }, { displayMode: "raw" }])
    assert.equal(validateBreadcrumbPoint(fix(1, patch), { nowMs: 1_002_000 }).ok, false);
});
test("sparse accumulation carries sub-threshold progress and metre precision between writes", () => {
  let r = { traveledDistanceKm: 0, lastTrackedLocation: { lat: 0, lng: 0 } };
  for (let n = 1; n <= 100; n++) r = { ...r, ...accumulateTraveledSegment(r, 0, n * 0.00003) };
  assert.ok(r.traveledDistanceMeters > 320 && r.traveledDistanceMeters < 335);
});
test("cancellation chooses validated dense OR sparse distance, never sums overlapping tracks", () => {
  const ride = { traveledDistanceKm: 1, driverId: "d", vehicleId: "v", assignmentSessionToken: "assignment", tripStartedAt: 1000 };
  const tel = { measurementVersion: 2, driverId: "d", vehicleId: "v", assignmentSessionToken: "assignment", acceptedPointCount: 20,
    denseChordDistanceMeters: 1500, coverageStartAt: 1000, coverageEndAt: 4000 };
  assert.equal(resolveCancellationDistance(ride, tel, 5000).traveledDistanceKm, 1.5);
  assert.equal(resolveCancellationDistance(ride, { ...tel, measurementVersion: 1 }, 5000).traveledDistanceKm, 1);
  assert.equal(resolveCancellationDistance(ride, { ...tel, assignmentSessionToken: "old" }, 5000).traveledDistanceKm, 1);
  assert.equal(resolveCancellationDistance(ride, tel, 20000).distanceCoverageIncomplete, true);
});
test("legacy breadcrumb suites refuse the open preview, implicit defaults and production", () => {
  for (const env of [{}, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", GCLOUD_PROJECT: "demo-swiftgo-phase1" },
    { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8190", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9195", GCLOUD_PROJECT: "production" }])
    assert.throws(() => requireBreadcrumbEmulators(env), /ISOLATED_BREADCRUMB/);
  requireBreadcrumbEmulators({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8190", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9195", GCLOUD_PROJECT: "demo-remediation-phase5" });
});
test("synthetic fixture recovery creates only missing documents, never updates existing records", async () => {
  const writes = [], db = { getAll: async () => [{ exists: true }, { exists: false }], batch: () => ({ create: (...args) => writes.push(args), commit: async () => {} }) };
  const batch = createMissingOnlyBatch(db); batch.create("existing", { original: false }); batch.create("missing", { synthetic: true });
  assert.deepEqual(await batch.commit(), { created: 1, kept: 1 }); assert.deepEqual(writes, [["missing", { synthetic: true }]]);
});
test("first actual map paint survives asynchronous report binding", async () => {
  const c = createRideLocationReportClient({ role: "customer", storage: createMemoryStorageAdapter(), getFirebase: () => ({}) });
  const binding = c.bindForRide({ rideId: "paint-ride", assignmentSessionToken: "paint_assignment" });
  c.noteDisplayFrame(fix(1, { rideId: "paint-ride", assignmentId: "paint_assignment" }));
  await binding; assert.equal(c.snapshotSection().counters.p2pValidRendered, 1);
});
test("late old report acknowledgement cannot clear the next ride counters", async () => {
  let ack; const c = createRideLocationReportClient({ role: "customer", storage: createMemoryStorageAdapter(), getFirebase: () => ({}),
    callSubmit: () => new Promise((resolve) => { ack = resolve; }) });
  await c.bindForRide({ rideId: "old-report", assignmentSessionToken: "old_assignment" });
  const flush = c.flushFinal(); await tick();
  await c.bindForRide({ rideId: "new-report", assignmentSessionToken: "new_assignment" });
  c.noteDisplayFrame(fix(1, { rideId: "new-report", assignmentId: "new_assignment" }));
  ack({ ok: true }); await flush;
  assert.equal(c.getBinding().rideId, "new-report"); assert.equal(c.snapshotSection().counters.p2pValidRendered, 1);
});
test("route clear releases in-flight reroute and ignores its stale completion", () => {
  const k = motionKit(), p = createDisplayLocationPipeline(k.opts); p.setActiveRoute(route());
  const off = p.getOffRoute();
  for (let n = 0; n < 4; n++) { off.noteProjection({ confidence: "OFF_ROUTE_CANDIDATE", nearestDistanceM: 120 }); k.time.advance(10000); }
  assert.equal(off.beginReroute().ok, true); p.clearRoute(); assert.equal(off.isInFlight(), false);
  p.setActiveRoute(route(3)); assert.equal(p.noteRerouteResult(true, route(1), 1, 999).reason, "stale_reroute");
  assert.equal(p.getRouteGeneration(), 3); p.destroy();
});
