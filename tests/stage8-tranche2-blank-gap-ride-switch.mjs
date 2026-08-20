/**
 * Stage 8 tranche 2 — two-leg blank-gap + customer ride-switch ordering.
 *
 * Adapted from main c0f838d / a1d82e4 for this branch's route colors and
 * background-keepalive visibility policy (P2P must not suspend when hidden).
 *
 * Run: node tests/stage8-tranche2-blank-gap-ride-switch.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEG_STATUS, ROUTE_EMPHASIS } from "../shared/js/two-leg-route-controller.mjs";
import {
  createTwoLegRouteLayers,
  isApproachLegDrawable,
  shouldSuppressLegacyApproachLine,
} from "../shared/js/two-leg-route-layers.mjs";
import { createCustomerP2pController } from "../customer-app/js/p2p-ride-controller.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage8-tranche2-blank-gap-ride-switch-results.json");

const PICKUP = { lat: 24.87, lng: 67.02 };
const DROPOFF = { lat: 24.92, lng: 67.08 };
const DRIVER = { lat: 24.865, lng: 66.995 };

/** Branch STYLE.tripSecondary / approachProminent / fallback */
const COLOR_TRIP_SECONDARY = "#2563eb";
const COLOR_APPROACH = "#16a34a";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
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
  };
}

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

console.log("\n=== Stage 8 tranche 2 — blank-gap + ride-switch ===\n");

const harness = createMockMapHarness();
const layers = createTwoLegRouteLayers({ getMap: () => harness.map });

harness.reset();
layers.render(tripFallbackModel());
const snap1 = layerSnapshot(harness);
record(
  "idle-approach-trip-fallback-secondary",
  snap1.count >= 1 && snap1.lastStyle?.color === COLOR_TRIP_SECONDARY ? "PASS" : "FAIL",
  `polylines=${snap1.count} color=${snap1.lastStyle?.color || "none"}`
);

record(
  "idle-approach-legacy-not-suppressed",
  shouldSuppressLegacyApproachLine(tripFallbackModel()) ? "FAIL" : "PASS",
  "trip-only fallback must not suppress legacy approach line"
);

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
  "approach-fallback-visible",
  snap3.lastStyle?.dashArray === "8 10" ? "PASS" : "FAIL",
  `dash=${snap3.lastStyle?.dashArray || "none"}`
);
record(
  "approach-fallback-suppresses-legacy",
  shouldSuppressLegacyApproachLine(approachFallbackModel) ? "PASS" : "FAIL"
);

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
  "approach-ready-visible",
  snap4.lastStyle?.color === COLOR_APPROACH && !snap4.lastStyle?.dashArray ? "PASS" : "FAIL",
  `color=${snap4.lastStyle?.color || "none"}`
);
record(
  "approach-ready-suppresses-legacy",
  shouldSuppressLegacyApproachLine(approachReadyModel) ? "PASS" : "FAIL"
);

const suppressIdle = shouldSuppressLegacyApproachLine(tripFallbackModel());
harness.reset();
layers.render(tripFallbackModel());
const idleVisible = harness.polylines.length > 0;
const suppressReady = shouldSuppressLegacyApproachLine(approachReadyModel);
harness.reset();
layers.render(approachReadyModel);
const readyVisible = harness.polylines.length > 0;
record(
  "idle-to-ready-never-blank",
  idleVisible && readyVisible && !suppressIdle && suppressReady ? "PASS" : "FAIL",
  `idle=${idleVisible} ready=${readyVisible}`
);

record(
  "drawable-helper-approach-fallback",
  isApproachLegDrawable({
    status: LEG_STATUS.FALLBACK,
    fallback: true,
    geometry: [DRIVER, PICKUP],
  })
    ? "PASS"
    : "FAIL"
);

const harnessClear = createMockMapHarness();
const layersClear = createTwoLegRouteLayers({ getMap: () => harnessClear.map });
layersClear.render({
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
});
const beforeClear = harnessClear.polylines.length;
layersClear.render({ emphasis: ROUTE_EMPHASIS.NONE, rideGeneration: 43 });
record(
  "stale-layers-cleared",
  beforeClear > 0 && harnessClear.removed.length > 0 ? "PASS" : "FAIL",
  `drawn=${beforeClear} removed=${harnessClear.removed.length}`
);

const rideFlow = fs.readFileSync(path.join(ROOT, "customer-app/js/ride-flow.js"), "utf8");
const layersSrc = fs.readFileSync(path.join(ROOT, "shared/js/two-leg-route-layers.mjs"), "utf8");
const custCtrl = fs.readFileSync(
  path.join(ROOT, "customer-app/js/p2p-ride-controller.mjs"),
  "utf8"
);

record(
  "static-ride-flow-suppression-helper",
  rideFlow.includes("shouldSuppressLegacyApproachLine") ? "PASS" : "FAIL"
);
record(
  "static-trip-fallback-secondary-branch",
  layersSrc.includes("showTripFallbackSecondary") ? "PASS" : "FAIL"
);
record(
  "static-answerIdentity-includes-sessionId",
  custCtrl.includes("answerIdentity") &&
    custCtrl.includes("${rid}|${sid}|${tid}|${av}")
    ? "PASS"
    : "FAIL"
);
record(
  "static-watch-generation-guards",
  custCtrl.includes("isWatchCurrent") &&
    custCtrl.includes("capturedRideId") &&
    custCtrl.includes("invalidateWatch")
    ? "PASS"
    : "FAIL"
);
record(
  "static-bindRide-before-setVisible",
  /bindRide\(rid\);\s*\n\s*setVisible\(isVisible\);/.test(custCtrl) ? "PASS" : "FAIL"
);
record(
  "static-hidden-does-not-suspend-p2p",
  custCtrl.includes("must not suspend or stop P2P") &&
    !/function setVisible[\s\S]*session\?\.suspend/.test(custCtrl)
    ? "PASS"
    : "FAIL",
  "preserve branch background-keepalive policy vs main suspend-on-hide"
);

{
  const events = [];
  const ctrl = createCustomerP2pController({
    watchRidePeerSession(rid, onData) {
      events.push(`watch:${rid}`);
      onData(null);
      return () => events.push(`unwatch:${rid}`);
    },
  });
  ctrl.syncForRide({ id: "ride_A", status: "accepted" }, { isVisible: true });
  const genA = ctrl._getWatchGeneration();
  const watchA = events.filter((e) => e.startsWith("watch:")).length;
  ctrl.syncForRide({ id: "ride_B", status: "accepted" }, { isVisible: true });
  const genB = ctrl._getWatchGeneration();
  record(
    "ride-switch-bumps-watch-generation",
    genB > genA && ctrl._getRideId() === "ride_B" ? "PASS" : "FAIL",
    `genA=${genA} genB=${genB} ride=${ctrl._getRideId()} watches=${watchA}`
  );
  ctrl.setVisible(false);
  record(
    "hidden-keeps-watching",
    ctrl._isWatching() && ctrl.isUiVisible() === false ? "PASS" : "FAIL",
    `watching=${ctrl._isWatching()} visible=${ctrl.isUiVisible()}`
  );
  ctrl.destroy();
}

const fail = results.filter((r) => r.status === "FAIL").length;
const pass = results.filter((r) => r.status === "PASS").length;
console.log(`\nStage 8 tranche 2: ${pass} PASS / ${fail} FAIL`);
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      stage: 8,
      tranche: 2,
      scope: "blank-gap-and-ride-switch",
      generatedAt: new Date().toISOString(),
      summary: { pass, fail },
      results,
    },
    null,
    2
  )
);
console.log(`Wrote ${OUT}\n`);
if (fail > 0) process.exit(1);
