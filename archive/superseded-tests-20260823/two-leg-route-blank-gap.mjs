/**
 * Phase 1 — blank route-line gap regression suite.
 * Run: npm run test:two-leg-route-blank-gap
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEG_STATUS,
  ROUTE_EMPHASIS,
  createTwoLegRouteController,
} from "../shared/js/two-leg-route-controller.mjs";
import {
  createTwoLegRouteLayers,
  isApproachLegDrawable,
  shouldSuppressLegacyApproachLine,
} from "../shared/js/two-leg-route-layers.mjs";
import { resolveRouteProvider } from "../shared/js/road-route-provider.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "two-leg-route-blank-gap-results.json");

const PICKUP = { lat: 24.87, lng: 67.02 };
const DROPOFF = { lat: 24.92, lng: 67.08 };
const DRIVER = { lat: 24.865, lng: 66.995 };

const results = [];

function record(name, status, detail = "", category = "unit") {
  results.push({ name, status, detail, suite: "two-leg-route-blank-gap", category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${category}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function tripFallbackModel(overrides = {}) {
  return {
    rideGeneration: 1,
    rideId: "ride-a",
    rideStatus: "accepted",
    emphasis: ROUTE_EMPHASIS.APPROACH,
    fittedOnceForRide: false,
    approach: {
      status: LEG_STATUS.IDLE,
      fallback: false,
      geometry: null,
      renderGeometry: null,
    },
    trip: {
      status: LEG_STATUS.FALLBACK,
      fallback: true,
      geometry: [PICKUP, DROPOFF],
      renderGeometry: [PICKUP, DROPOFF],
    },
    visible: true,
    ...overrides,
  };
}

function createMockMapHarness() {
  const polylines = [];
  const removed = [];
  const map = {
    on() {},
    removeLayer(layer) {
      removed.push(layer);
    },
    fitBounds() {},
  };
  globalThis.L = {
    polyline(latlngs, style) {
      const layer = {
        latlngs,
        style: { ...style },
        setLatLngs(next) {
          this.latlngs = next;
        },
        setStyle(next) {
          this.style = { ...next };
        },
        addTo() {
          return this;
        },
      };
      polylines.push(layer);
      return layer;
    },
    latLngBounds(pts) {
      return { pts };
    },
  };
  return {
    map,
    polylines,
    removed,
    reset() {
      polylines.length = 0;
      removed.length = 0;
    },
  };
}

function layerSnapshot(harness) {
  const last = harness.polylines[harness.polylines.length - 1];
  return {
    count: harness.polylines.length,
    lastStyle: last?.style || null,
    lastLatlngs: last?.latlngs || null,
  };
}

async function run() {
  console.log("\n=== two-leg-route-blank-gap (Phase 1) ===\n");

  if (typeof globalThis.document === "undefined") {
    const elements = new Map();
    globalThis.document = {
      getElementById(id) {
        return elements.get(id) || null;
      },
      createElement(tag) {
        const el = {
          tag,
          hidden: false,
          textContent: "",
          className: "",
          parentNode: null,
          setAttribute() {},
          appendChild(child) {
            child.parentNode = el;
          },
        };
        return el;
      },
      body: {
        appendChild(child) {
          child.parentNode = globalThis.document.body;
        },
      },
    };
  }

  const harness = createMockMapHarness();
  const layers = createTwoLegRouteLayers({ getMap: () => harness.map });

  // 1. approach IDLE + trip FALLBACK → subdued trip fallback visible
  harness.reset();
  layers.render(tripFallbackModel());
  const snap1 = layerSnapshot(harness);
  record(
    "01-idle-approach-trip-fallback-secondary",
    snap1.count >= 1 && snap1.lastStyle?.color === "#93c5fd" ? "PASS" : "FAIL",
    `polylines=${snap1.count} color=${snap1.lastStyle?.color || "none"}`
  );

  // 2. approach IDLE + valid driver/pickup → legacy line not suppressed
  record(
    "02-idle-approach-legacy-not-suppressed",
    shouldSuppressLegacyApproachLine(tripFallbackModel()) ? "FAIL" : "PASS",
    "trip-only fallback must not suppress legacy approach line"
  );

  // 3. approach FALLBACK → approach fallback visible, legacy suppressed
  harness.reset();
  const approachFallbackModel = tripFallbackModel({
    approach: {
      status: LEG_STATUS.FALLBACK,
      fallback: true,
      geometry: [DRIVER, PICKUP],
      renderGeometry: [DRIVER, PICKUP],
    },
  });
  layers.render(approachFallbackModel);
  const snap3 = layerSnapshot(harness);
  record(
    "03-approach-fallback-visible",
    snap3.lastStyle?.dashArray === "8 10" ? "PASS" : "FAIL",
    `dash=${snap3.lastStyle?.dashArray || "none"}`
  );
  record(
    "03b-approach-fallback-suppresses-legacy",
    shouldSuppressLegacyApproachLine(approachFallbackModel) ? "PASS" : "FAIL"
  );

  // 4. approach READY → approach route visible, legacy suppressed
  harness.reset();
  const approachReadyModel = tripFallbackModel({
    approach: {
      status: LEG_STATUS.READY,
      fallback: false,
      geometry: [DRIVER, PICKUP, { lat: 24.872, lng: 67.01 }],
      renderGeometry: [DRIVER, PICKUP],
    },
  });
  layers.render(approachReadyModel);
  const snap4 = layerSnapshot(harness);
  record(
    "04-approach-ready-visible",
    snap4.lastStyle?.color === "#0b7a4b" && !snap4.lastStyle?.dashArray ? "PASS" : "FAIL",
    `color=${snap4.lastStyle?.color || "none"}`
  );
  record(
    "04b-approach-ready-suppresses-legacy",
    shouldSuppressLegacyApproachLine(approachReadyModel) ? "PASS" : "FAIL"
  );

  // 5. transition IDLE → READY does not leave both systems hidden
  const suppressIdle = shouldSuppressLegacyApproachLine(tripFallbackModel());
  harness.reset();
  layers.render(tripFallbackModel());
  const idleVisible = harness.polylines.length > 0;
  const suppressReady = shouldSuppressLegacyApproachLine(approachReadyModel);
  harness.reset();
  layers.render(approachReadyModel);
  const readyVisible = harness.polylines.length > 0;
  record(
    "05-idle-to-ready-never-blank",
    idleVisible && readyVisible && !suppressIdle && suppressReady ? "PASS" : "FAIL",
    `idle=${idleVisible} ready=${readyVisible} suppressIdle=${suppressIdle} suppressReady=${suppressReady}`
  );

  // 6. accepted → arrived keeps line visible
  harness.reset();
  layers.render(
    tripFallbackModel({
      rideStatus: "arrived",
      approach: {
        status: LEG_STATUS.FALLBACK,
        fallback: true,
        geometry: [DRIVER, PICKUP],
        renderGeometry: [DRIVER, PICKUP],
      },
    })
  );
  record(
    "06-arrived-keeps-line",
    harness.polylines.length > 0 ? "PASS" : "FAIL",
    `polylines=${harness.polylines.length}`
  );

  // 7. arrived → in_progress shows trip emphasis without blank transition
  const harness7 = createMockMapHarness();
  const layers7 = createTwoLegRouteLayers({ getMap: () => harness7.map });
  layers7.render(
    tripFallbackModel({
      rideStatus: "in_progress",
      emphasis: ROUTE_EMPHASIS.TRIP,
      approach: { status: LEG_STATUS.CLEARED, fallback: false, geometry: null },
    })
  );
  record(
    "07-in-progress-trip-fallback-visible",
    harness7.polylines.length > 0 && harness7.polylines.some((p) => p.style.dashArray === "8 10")
      ? "PASS"
      : "FAIL",
    `polylines=${harness7.polylines.length}`
  );

  // 8. missing driverLocation — trip fallback still visible via controller
  const ctrl = createTwoLegRouteController({
    provider: resolveRouteProvider(),
    onModel: () => {},
  });
  const renderHarness = createMockMapHarness();
  const renderLayers = createTwoLegRouteLayers({ getMap: () => renderHarness.map });
  let lastModel = null;
  const wired = createTwoLegRouteController({
    provider: resolveRouteProvider(),
    onModel: (model) => {
      lastModel = model;
      renderLayers.render(model);
    },
  });
  wired.syncRide(
    {
      id: "ride-gap",
      status: "accepted",
      pickupLocation: PICKUP,
      dropoffLocation: DROPOFF,
    },
    { isVisible: true }
  );
  await new Promise((r) => setTimeout(r, 20));
  record(
    "08-missing-driver-trip-fallback-visible",
    lastModel?.trip?.status === LEG_STATUS.FALLBACK && renderHarness.polylines.length > 0 ? "PASS" : "FAIL",
    `trip=${lastModel?.trip?.status || "none"} polylines=${renderHarness.polylines.length}`
  );
  record(
    "08b-missing-driver-no-throw",
    lastModel ? "PASS" : "FAIL",
    "controller emitted model"
  );
  void ctrl;

  // 9. provider disabled — drawable fallback still works
  record(
    "09-disabled-provider-drawable-fallback",
    resolveRouteProvider().id === "disabled" && isApproachLegDrawable({
      status: LEG_STATUS.FALLBACK,
      fallback: true,
      geometry: [DRIVER, PICKUP],
    })
      ? "PASS"
      : "FAIL",
    `provider=${resolveRouteProvider().id}`
  );

  // 10. stale layers cleaned when emphasis clears
  const harness10 = createMockMapHarness();
  const layers10 = createTwoLegRouteLayers({ getMap: () => harness10.map });
  const drawModel = {
    rideGeneration: 42,
    emphasis: ROUTE_EMPHASIS.APPROACH,
    fittedOnceForRide: false,
    approach: {
      status: LEG_STATUS.READY,
      fallback: false,
      geometry: [DRIVER, PICKUP],
      renderGeometry: [DRIVER, PICKUP],
    },
    trip: { status: LEG_STATUS.IDLE, fallback: false, geometry: null, renderGeometry: null },
  };
  layers10.render(drawModel);
  const beforeClear = harness10.polylines.length;
  layers10.render({ emphasis: ROUTE_EMPHASIS.NONE, rideGeneration: 43 });
  record(
    "10-stale-layers-cleared",
    beforeClear > 0 && harness10.removed.length > 0 ? "PASS" : "FAIL",
    `drawn=${beforeClear} removed=${harness10.removed.length}`
  );

  // Static wiring checks
  const rideFlow = fs.readFileSync(path.join(ROOT, "customer-app/js/ride-flow.js"), "utf8");
  const layersSrc = fs.readFileSync(path.join(ROOT, "shared/js/two-leg-route-layers.mjs"), "utf8");
  record(
    "static-ride-flow-suppression-helper",
    rideFlow.includes("shouldSuppressLegacyApproachLine") ? "PASS" : "FAIL",
    "",
    "static"
  );
  record(
    "static-trip-fallback-secondary-branch",
    layersSrc.includes("showTripFallbackSecondary") ? "PASS" : "FAIL",
    "",
    "static"
  );

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  console.log(`\nPhase 1 two-leg-route-blank-gap: ${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED\n`);
  fs.writeFileSync(OUT, JSON.stringify({ pass, fail, blocked, results }, null, 2));
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
