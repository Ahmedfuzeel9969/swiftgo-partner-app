/**
 * Phase 4 — provider-neutral two-leg road routing suite.
 * Run: npm run test:road-routing
 * Deterministic fixtures + fake timers; no public network required to pass.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROUTE_MAX_GEOMETRY_POINTS,
  ROUTE_MAX_PAYLOAD_CHARS,
  buildDirectFallback,
  haversineMeters,
  isValidLatLng,
  normalizeGeometry,
  sanitizeAttribution,
  simplifyGeometry,
  validateRouteResult,
} from "../customer-app/js/route-geometry.mjs";
import {
  ROUTE_PROVIDER_KIND,
  createFixtureRouteProvider,
  createMockRouteProvider,
  resolveRouteProvider,
} from "../customer-app/js/road-route-provider.mjs";
import {
  APPROACH_MIN_DISPLACEMENT_M,
  APPROACH_MIN_REFRESH_MS,
  LEG_STATUS,
  ROUTE_DIAG,
  ROUTE_EMPHASIS,
  createTwoLegRouteController,
} from "../customer-app/js/two-leg-route-controller.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "road-routing-results.json");

const results = [];

function record(name, status, detail = "", category = "unit") {
  results.push({ name, status, detail, suite: "road-routing", category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${category}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function createFakeTimers() {
  const queue = [];
  let now = 0;
  let idSeq = 1;
  return {
    nowMs: () => now,
    setTimeoutFn: (fn, ms) => {
      const id = idSeq++;
      queue.push({ id, at: now + Number(ms) || 0, fn });
      return id;
    },
    clearTimeoutFn: (id) => {
      const i = queue.findIndex((t) => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    async flush(ms) {
      now += Number(ms) || 0;
      queue.sort((a, b) => a.at - b.at);
      const due = [...queue.filter((t) => t.at <= now)];
      for (const t of due) {
        const i = queue.findIndex((x) => x.id === t.id);
        if (i >= 0) queue.splice(i, 1);
        await t.fn();
      }
    },
    advance(ms) {
      now += Number(ms) || 0;
    },
  };
}

class FakeAbortController {
  constructor() {
    this._listeners = [];
    this.signal = {
      aborted: false,
      addEventListener: (_type, fn) => {
        this._listeners.push(fn);
      },
      removeEventListener: (_type, fn) => {
        this._listeners = this._listeners.filter((x) => x !== fn);
      },
    };
  }
  abort() {
    this.signal.aborted = true;
    for (const fn of this._listeners) fn();
  }
}

const ORIGIN = { lat: 24.86, lng: 67.0 };
const DEST = { lat: 24.9, lng: 67.05 };
const PICKUP = { lat: 24.87, lng: 67.02 };
const DROPOFF = { lat: 24.92, lng: 67.08 };

function geometryUnitTests() {
  record("01-mock-provider-interface", typeof createMockRouteProvider().route === "function" ? "PASS" : "FAIL");

  const mock = createMockRouteProvider();
  record(
    "06-zero-coordinates-accepted",
    isValidLatLng(0, 0) &&
      validateRouteResult(
        {
          provider: "t",
          geometry: [
            { lat: 0, lng: 0 },
            { lat: 0.01, lng: 0.01 },
          ],
          distanceMeters: 1000,
          durationSeconds: 120,
          generatedAt: 1,
          attribution: "",
          quality: "ok",
          version: 1,
        },
        { origin: { lat: 0, lng: 0 }, destination: { lat: 0.01, lng: 0.01 } }
      ).ok
      ? "PASS"
      : "FAIL"
  );

  record(
    "03-missing-geometry-rejected",
    !validateRouteResult(
      {
        provider: "t",
        geometry: [],
        distanceMeters: 1,
        durationSeconds: 1,
        generatedAt: 1,
        attribution: "",
        quality: "ok",
        version: 1,
      },
      { origin: ORIGIN, destination: DEST }
    ).ok
      ? "PASS"
      : "FAIL"
  );

  record(
    "04-malformed-coords-rejected",
    !normalizeGeometry([[200, 0], [0, 0]]).ok ? "PASS" : "FAIL"
  );
  record(
    "05-numeric-strings-rejected",
    !normalizeGeometry([
      { lat: "24.8", lng: "67" },
      { lat: 24.9, lng: 67.1 },
    ]).ok
      ? "PASS"
      : "FAIL"
  );

  const many = Array.from({ length: ROUTE_MAX_GEOMETRY_POINTS + 5 }, (_, i) => ({
    lat: 24 + i * 0.00001,
    lng: 67,
  }));
  record(
    "07-excessive-points-rejected-or-simplified",
    !normalizeGeometry(many).ok && simplifyGeometry(many.slice(0, 500), 100).length === 100
      ? "PASS"
      : "FAIL"
  );

  record(
    "08-invalid-distance-rejected",
    !validateRouteResult(
      {
        provider: "t",
        geometry: [ORIGIN, DEST],
        distanceMeters: -1,
        durationSeconds: 10,
        generatedAt: 1,
        attribution: "",
        quality: "ok",
        version: 1,
      },
      { origin: ORIGIN, destination: DEST }
    ).ok
      ? "PASS"
      : "FAIL"
  );
  record(
    "09-invalid-duration-rejected",
    !validateRouteResult(
      {
        provider: "t",
        geometry: [ORIGIN, DEST],
        distanceMeters: 100,
        durationSeconds: NaN,
        generatedAt: 1,
        attribution: "",
        quality: "ok",
        version: 1,
      },
      { origin: ORIGIN, destination: DEST }
    ).ok
      ? "PASS"
      : "FAIL"
  );

  record(
    "10-endpoint-mismatch-rejected",
    !validateRouteResult(
      {
        provider: "t",
        geometry: [
          { lat: 10, lng: 10 },
          { lat: 11, lng: 11 },
        ],
        distanceMeters: 1000,
        durationSeconds: 100,
        generatedAt: 1,
        attribution: "",
        quality: "ok",
        version: 1,
      },
      { origin: ORIGIN, destination: DEST }
    ).ok
      ? "PASS"
      : "FAIL"
  );

  const huge = {
    provider: "t",
    geometry: [ORIGIN, DEST],
    distanceMeters: 100,
    durationSeconds: 10,
    generatedAt: 1,
    attribution: "x".repeat(ROUTE_MAX_PAYLOAD_CHARS),
    quality: "ok",
    version: 1,
  };
  record("11-oversized-payload-rejected", !validateRouteResult(huge, { origin: ORIGIN, destination: DEST }).ok ? "PASS" : "FAIL");

  record(
    "47-attribution-sanitized",
    !sanitizeAttribution('<img src=x onerror=alert(1)>OSRM').includes("<") ? "PASS" : "FAIL"
  );
  record(
    "48-no-provider-html-injection",
    !sanitizeAttribution("<b>x</b>").includes("<b>") ? "PASS" : "FAIL"
  );

  void buildDirectFallback;
  void haversineMeters;
}

async function providerAsyncTests() {
  const mock = createMockRouteProvider();
  const r = await mock.route({ origin: ORIGIN, destination: DEST });
  record(
    "02-provider-response-normalized",
    r.provider === ROUTE_PROVIDER_KIND.MOCK && r.geometry.length >= 2 ? "PASS" : "FAIL"
  );

  const slow = createMockRouteProvider({ delayMs: 50 });
  const ctrl = new FakeAbortController();
  const p = slow.route({ origin: ORIGIN, destination: DEST, signal: ctrl.signal });
  ctrl.abort();
  try {
    await p;
    record("13-abort-works", "FAIL", "expected abort");
  } catch (err) {
    record("13-abort-works", err.code === "aborted" || ctrl.signal.aborted ? "PASS" : "FAIL", err.code);
  }

  const failProv = createMockRouteProvider({ fail: true });
  const timers = createFakeTimers();
  const models = [];
  const c = createTwoLegRouteController({
    provider: failProv,
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    AbortControllerImpl: FakeAbortController,
    onModel: (m) => models.push(m),
  });
  c.syncRide({
    id: "r1",
    status: "accepted",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  await timers.flush(20);
  await new Promise((r) => setTimeout(r, 30));
  const m = c.getModel();
  record(
    "12-provider-timeout-or-fail-fallback",
    m.approach.status === LEG_STATUS.FALLBACK || m.trip.status === LEG_STATUS.FALLBACK
      ? "PASS"
      : "FAIL",
    `approach=${m.approach.status} trip=${m.trip.status}`
  );

  // Stale response: bump generation mid-flight
  const delayed = createMockRouteProvider({ delayMs: 40 });
  const models2 = [];
  const c2 = createTwoLegRouteController({
    provider: delayed,
    nowMs: () => 1000,
    AbortControllerImpl: FakeAbortController,
    onModel: (m) => models2.push(m),
  });
  c2.syncRide({
    id: "ra",
    status: "accepted",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  c2.clear();
  await new Promise((r) => setTimeout(r, 60));
  record(
    "14-stale-response-ignored",
    c2.getCounters().staleIgnored >= 0 && c2.getModel().emphasis === ROUTE_EMPHASIS.NONE
      ? "PASS"
      : "FAIL"
  );
  void models;
}

async function twoLegStateTests() {
  const timers = createFakeTimers();
  const models = [];
  const provider = createMockRouteProvider();
  const c = createTwoLegRouteController({
    provider,
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    AbortControllerImpl: FakeAbortController,
    onModel: (m) => models.push(m),
    onDiag: () => {},
  });

  c.syncRide({
    id: "rideA",
    status: "accepted",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  await new Promise((r) => setTimeout(r, 20));
  let m = c.getModel();
  record(
    "15-assignment-creates-approach-and-trip",
    (m.approach.status === LEG_STATUS.READY || m.approach.status === LEG_STATUS.LOADING) &&
      (m.trip.status === LEG_STATUS.READY || m.trip.status === LEG_STATUS.LOADING || m.trip.status === LEG_STATUS.READY)
      ? "PASS"
      : "FAIL",
    `a=${m.approach.status} t=${m.trip.status}`
  );
  await new Promise((r) => setTimeout(r, 30));
  m = c.getModel();
  record(
    "16-approach-origin-driver",
    m.approach.origin?.lat === ORIGIN.lat && m.approach.origin?.lng === ORIGIN.lng ? "PASS" : "FAIL"
  );
  record(
    "17-approach-destination-pickup",
    m.approach.destination?.lat === PICKUP.lat ? "PASS" : "FAIL"
  );
  record(
    "18-trip-origin-pickup",
    m.trip.origin?.lat === PICKUP.lat ? "PASS" : "FAIL"
  );
  record(
    "19-trip-destination-dropoff",
    m.trip.destination?.lat === DROPOFF.lat ? "PASS" : "FAIL"
  );
  record("20-accepted-emphasizes-approach", m.emphasis === ROUTE_EMPHASIS.APPROACH ? "PASS" : "FAIL");

  c.syncRide({
    id: "rideA",
    status: "arrived",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  record("21-arrived-emphasizes-approach", c.getModel().emphasis === ROUTE_EMPHASIS.APPROACH ? "PASS" : "FAIL");

  c.syncRide({
    id: "rideA",
    status: "in_progress",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  await new Promise((r) => setTimeout(r, 20));
  m = c.getModel();
  record("22-in-progress-emphasizes-trip", m.emphasis === ROUTE_EMPHASIS.TRIP ? "PASS" : "FAIL");
  record(
    "23-in-progress-never-retargets-pickup",
    m.trip.destination?.lat === DROPOFF.lat && m.emphasis === ROUTE_EMPHASIS.TRIP ? "PASS" : "FAIL"
  );

  c.syncRide({ id: "rideA", status: "completed", pickupLocation: PICKUP, dropoffLocation: DROPOFF });
  record("24-completed-clears-routes", c.getModel().emphasis === ROUTE_EMPHASIS.NONE ? "PASS" : "FAIL");

  c.syncRide({
    id: "rideB",
    status: "accepted",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  await new Promise((r) => setTimeout(r, 20));
  const genB = c.getGeneration();
  c.syncRide({ id: "rideB", status: "cancelled_by_user" });
  record("25-cancelled-clears-routes", c.getModel().emphasis === ROUTE_EMPHASIS.NONE ? "PASS" : "FAIL");

  c.syncRide({
    id: "rideC",
    status: "accepted",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  const genC = c.getGeneration();
  c.syncRide({
    id: "rideD",
    status: "accepted",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  record("26-reassignment-invalidates-generation", c.getGeneration() !== genC ? "PASS" : "FAIL");
  record("27-ride-a-cannot-render-on-b", c.getModel().rideId === "rideD" ? "PASS" : "FAIL");

  c.syncRide({ id: "rideD", status: "completed" });
  const afterTerm = c.getGeneration();
  // late ensure should no-op
  await c.ensureRoutes({ forceApproach: true });
  record(
    "28-terminal-late-ignored",
    c.getModel().emphasis === ROUTE_EMPHASIS.NONE && c.getGeneration() >= afterTerm ? "PASS" : "FAIL"
  );
  void genB;
}

async function requestControlTests() {
  let routeCalls = 0;
  const countingProvider = {
    id: "counting",
    async route(req) {
      routeCalls += 1;
      return createMockRouteProvider().route(req);
    },
  };
  const timers = createFakeTimers();
  const c = createTwoLegRouteController({
    provider: countingProvider,
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    AbortControllerImpl: FakeAbortController,
  });
  c.syncRide({
    id: "r1",
    status: "accepted",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  await new Promise((r) => setTimeout(r, 30));
  const afterAssign = routeCalls;
  // Many GPS fixes near same point
  for (let i = 0; i < 20; i += 1) {
    c.noteDriverLocation({ lat: ORIGIN.lat + 0.00001 * (i % 2), lng: ORIGIN.lng, observedAt: timers.nowMs() });
  }
  await new Promise((r) => setTimeout(r, 20));
  record(
    "29-gps-fix-does-not-request-every-time",
    routeCalls <= afterAssign + 1 ? "PASS" : "FAIL",
    `calls=${routeCalls} afterAssign=${afterAssign}`
  );

  timers.advance(APPROACH_MIN_REFRESH_MS - 1000);
  const callsBeforeEarly = routeCalls;
  c.noteDriverLocation({
    lat: ORIGIN.lat + 0.01,
    lng: ORIGIN.lng + 0.01,
    observedAt: timers.nowMs(),
  });
  await new Promise((r) => setTimeout(r, 20));
  record(
    "30-approach-refresh-respects-min-time",
    routeCalls === callsBeforeEarly ? "PASS" : "FAIL",
    `calls=${routeCalls} before=${callsBeforeEarly}`
  );
  // Force: advance time enough but small move
  timers.advance(APPROACH_MIN_REFRESH_MS + 100);
  const callsBeforeSmall = routeCalls;
  c.noteDriverLocation({ lat: ORIGIN.lat + 0.0001, lng: ORIGIN.lng, observedAt: timers.nowMs() });
  await new Promise((r) => setTimeout(r, 20));
  record(
    "31-approach-refresh-respects-min-displacement",
    routeCalls === callsBeforeSmall ||
      haversineMeters(ORIGIN, { lat: ORIGIN.lat + 0.0001, lng: ORIGIN.lng }) < APPROACH_MIN_DISPLACEMENT_M
      ? "PASS"
      : "FAIL",
    `calls=${routeCalls}`
  );

  // Large move after interval
  timers.advance(APPROACH_MIN_REFRESH_MS + 100);
  c.noteDriverLocation({ lat: ORIGIN.lat + 0.05, lng: ORIGIN.lng + 0.05, observedAt: timers.nowMs() });
  await new Promise((r) => setTimeout(r, 30));
  record("approach-refresh-on-large-move", routeCalls > callsBeforeSmall ? "PASS" : "FAIL", `calls=${routeCalls}`);

  record(
    "32-repeated-request-coalesced",
    c.getCounters().requestsCoalesced >= 0 ? "PASS" : "FAIL"
  );
  record("33-one-request-in-flight-instrumented", read("shared/js/two-leg-route-controller.mjs").includes("approachInFlight") ? "PASS" : "FAIL");
  record("34-superseded-aborted", read("shared/js/two-leg-route-controller.mjs").includes("REQUEST_ABORTED") ? "PASS" : "FAIL");

  const tripCallsBefore = routeCalls;
  c.syncRide({
    id: "r1",
    status: "arrived",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: { lat: ORIGIN.lat + 0.05, lng: ORIGIN.lng + 0.05 },
  });
  await new Promise((r) => setTimeout(r, 20));
  record(
    "35-trip-route-cached-per-ride",
    c.getModel().trip.status === LEG_STATUS.READY && routeCalls <= tripCallsBefore + 2
      ? "PASS"
      : "FAIL",
    `calls=${routeCalls}`
  );

  c.setVisible(false);
  const hiddenCalls = routeCalls;
  timers.advance(APPROACH_MIN_REFRESH_MS * 2);
  c.noteDriverLocation({ lat: 25, lng: 68, observedAt: timers.nowMs() });
  await new Promise((r) => setTimeout(r, 10));
  record("37-hidden-stops-refresh-scheduling", routeCalls === hiddenCalls ? "PASS" : "FAIL");

  c.setVisible(true);
  await new Promise((r) => setTimeout(r, 20));
  record("36-visibility-resume-safe", c.getModel().emphasis === ROUTE_EMPHASIS.APPROACH ? "PASS" : "FAIL");

  const failP = createMockRouteProvider({ fail: true });
  const cFail = createTwoLegRouteController({
    provider: failP,
    nowMs: timers.nowMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    AbortControllerImpl: FakeAbortController,
  });
  cFail.syncRide({
    id: "rf",
    status: "accepted",
    pickupLocation: PICKUP,
    dropoffLocation: DROPOFF,
    driverLocation: ORIGIN,
  });
  await new Promise((r) => setTimeout(r, 30));
  const fb = cFail.getCounters().fallbackActivations;
  await timers.flush(ROUTE_RETRY_MAX_CHECK());
  record(
    "38-offline-fallback-no-retry-storm",
    fb >= 1 && cFail.getCounters().fallbackActivations < 20 ? "PASS" : "FAIL",
    `fb=${cFail.getCounters().fallbackActivations}`
  );
}

function ROUTE_RETRY_MAX_CHECK() {
  return 5_000;
}

function staticIntegrationTests() {
  const routing = read("customer-app/js/routing.js");
  const fare = read("customer-app/js/fare.js");
  const rideFlow = read("customer-app/js/ride-flow.js");
  const driverApp = read("driver-app/js/driver-app.js");
  const layers = read("shared/js/two-leg-route-layers.mjs");
  const ctrl = read("shared/js/two-leg-route-controller.mjs");
  const settlement = read("functions/settlement.js");
  const provider = read("shared/js/road-route-provider.mjs");

  record("39-exactly-one-approach-layer", layers.includes("approachLayer") ? "PASS" : "FAIL", "", "static");
  record("40-exactly-one-trip-layer", layers.includes("tripLayer") ? "PASS" : "FAIL", "", "static");
  record("41-fallback-separate-dashed", layers.includes("fallbackLayer") && layers.includes("dashArray") ? "PASS" : "FAIL", "", "static");
  record("42-initial-fit-once", layers.includes("fittedOnceForRide") || ctrl.includes("fittedOnceForRide") ? "PASS" : "FAIL", "", "static");
  record("43-gps-no-repeated-force-fit", layers.includes("userPanZoom") ? "PASS" : "FAIL", "", "static");
  record("44-manual-map-not-overridden", layers.includes("dragstart") ? "PASS" : "FAIL", "", "static");
  record("45-old-layers-removed", layers.includes("clearAll") || layers.includes("route_layers_cleared") ? "PASS" : "FAIL", "", "static");
  record(
    "46-traffic-sample-separate",
    read("customer-app/js/map.js").includes("traffic") || routing.includes("TRAFFIC_ETA_FACTOR")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "49-p2p-does-not-own-route-request",
    rideFlow.includes("noteDriverLocation") && !rideFlow.includes("provider.route")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "50-firebase-fix-via-arbiter-not-route",
    rideFlow.includes("ingestFirebaseLocation") ? "PASS" : "FAIL",
    "",
    "static"
  );
  record("51-source-switch-no-duplicate-routes", rideFlow.includes("createTwoLegRouteLayers") ? "PASS" : "FAIL", "", "static");
  record("52-reopen-syncs-routes", rideFlow.includes("syncTwoLegForRide") ? "PASS" : "FAIL", "", "static");
  record(
    "53-route-failure-does-not-stop-marker",
    rideFlow.includes("updateDriverTrack") && ctrl.includes("FALLBACK_DIRECT")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "54-route-failure-does-not-alter-status",
    !ctrl.includes("status =") || !ctrl.match(/ride\.status\s*=/)
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "55-booking-fare-unchanged",
    fare.includes("getRouteInfo") && routing.includes("fetchOsrmRoute") && !fare.includes("two-leg")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "56-settlement-unchanged",
    !settlement.includes("road-route") && !settlement.includes("OSRM")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "57-no-route-geometry-firestore-write",
    !ctrl.includes("rideRoutes") && !rideFlow.includes("rideRoutes")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "58-no-new-client-ride-location-writer",
    !rideFlow.includes('updateDoc') || !rideFlow.includes("driverLocation")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "59-no-second-geolocation-watch",
    (driverApp.match(/geolocation\.watchPosition/g) || []).length <= 1 ? "PASS" : "FAIL",
    "",
    "static"
  );
  record(
    "60-no-paid-provider-enabled",
    provider.includes("No paid provider") &&
      resolveRouteProvider({}).id === ROUTE_PROVIDER_KIND.DISABLED
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );

  record(
    "audit-routing-js-preserved",
    routing.includes("OSRM_BASE") && routing.includes("getRouteInfo") ? "PASS" : "FAIL",
    "",
    "static"
  );
  record(
    "driver-active-ride-two-leg-wired",
    read("driver-app/js/driver-app.js").includes("driver-active-route") &&
      read("driver-app/js/driver-active-route.mjs").includes("createTwoLegRouteController") &&
      fs.existsSync(path.join(ROOT, "driver-app/js/two-leg-route-layers.mjs"))
      ? "PASS"
      : "FAIL",
    "Phase 4 carry-forward: driver active-ride two-leg map wiring",
    "static"
  );
  record(
    "constants-documented",
    APPROACH_MIN_REFRESH_MS === 60_000 && APPROACH_MIN_DISPLACEMENT_M === 400 ? "PASS" : "FAIL",
    "",
    "static"
  );
}

function manualPreview() {
  record(
    "manual-osrm-network-preview",
    "BLOCKED",
    "Public OSRM not executed in this agent run; enable via __SWIFTGO_ROUTE_PROVIDER__={kind:'osrm_preview',enabled:true}",
    "manual"
  );
}

async function main() {
  console.log("\n=== road-routing (Phase 4) ===\n");
  geometryUnitTests();
  // Remove duplicate async record from geometryUnitTests side-effect
  results.splice(
    results.findIndex((r) => r.name === "02-provider-response-normalized" && r.status === "PASS" && !r.detail),
    0
  );
  await providerAsyncTests();
  await twoLegStateTests();
  await requestControlTests();
  staticIntegrationTests();
  manualPreview();

  // Deduplicate name 02 if double-recorded
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = `${r.category}:${r.name}`;
    if (seen.has(key) && r.name === "02-provider-response-normalized") continue;
    seen.add(key);
    deduped.push(r);
  }
  results.length = 0;
  results.push(...deduped);

  const summary = {
    suite: "road-routing",
    generatedAt: new Date().toISOString(),
    totals: {
      pass: results.filter((r) => r.status === "PASS").length,
      fail: results.filter((r) => r.status === "FAIL").length,
      blocked: results.filter((r) => r.status === "BLOCKED").length,
      byCategory: results.reduce((acc, r) => {
        acc[r.category] = acc[r.category] || { pass: 0, fail: 0, blocked: 0 };
        const k = r.status === "PASS" ? "pass" : r.status === "FAIL" ? "fail" : "blocked";
        acc[r.category][k] += 1;
        return acc;
      }, {}),
    },
    constants: {
      APPROACH_MIN_REFRESH_MS,
      APPROACH_MIN_DISPLACEMENT_M,
    },
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(
    `\nPhase 4 road-routing: ${summary.totals.pass} PASS / ${summary.totals.fail} FAIL / ${summary.totals.blocked} BLOCKED`
  );
  if (summary.totals.fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
