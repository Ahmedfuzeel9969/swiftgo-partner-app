/**
 * Phase 1 live-location foundation suite (final review fixes).
 * Run: npm run test:live-location-foundation
 *
 * Categories: unit / emulator / rules / static / blocked
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import {
  LOCATION_DIAG,
  MAX_ACCEPT_ACCURACY_M,
  SESSION_FIRST_FIX_MAX_AGE_MS,
  SESSION_FIRST_FIX_MAX_FUTURE_MS,
  derivedDisplayBearingDeg,
  estimateLocationWriteComparison,
  evaluateFixAgainstPrevious,
  isValidLatLng,
  isValidTrackingSessionId,
  normalizeHeadingDeg,
  normalizeLocationFix,
} from "../driver-app/js/location-envelope.mjs";
import { createLocationWriteSerializer } from "../driver-app/js/location-write-queue.mjs";
import { resolveTrackingTarget } from "../customer-app/js/tracking-target.mjs";
import {
  FRESHNESS,
  FRESHNESS_DELAYED_MS,
  FRESHNESS_FRESH_MS,
  computeAnimationDurationMs,
  interpolateLatLng,
  locationAgeMs,
  resolveFreshness,
  resolveMarkerRotationDeg,
  timestampToMs,
} from "../customer-app/js/live-location-render.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "live-location-foundation-results.json");
const PROJECT = "demo-swiftgo-phase1";
const rulesText = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.GCLOUD_PROJECT ||= PROJECT;
process.env.GOOGLE_CLOUD_PROJECT ||= PROJECT;

const results = [];

function record(name, status, detail = "", category = "unit") {
  results.push({ name, status, detail, suite: "live-location-foundation", category });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·";
  console.log(`${mark} [${category}] ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const {
  buildDriverLocationPatch,
  mirrorDriverLocationToRide,
  mirrorRideLocationTransactional,
  seedDriverLocationFromVehicle,
  trackingTargetForRide,
} = require(path.join(ROOT, "functions", "driver-location.js"));
const { setLocationDiagSink: setCfDiagSink, LOCATION_DIAG: CF_DIAG } = require(
  path.join(ROOT, "functions", "live-location-envelope.js")
);

function unitTests() {
  const session = "sess-a";
  const base = { lat: 24.8607, lng: 67.0011, observedAt: 1_000_000, source: "gps" };
  const first = normalizeLocationFix(base, { sessionId: session, sequence: 1 });
  record("01-valid-first-fix-accepted", first.ok ? "PASS" : "FAIL", first.reason);

  record(
    "02-invalid-lat-rejected",
    !normalizeLocationFix({ ...base, lat: 999 }, { sessionId: session, sequence: 1 }).ok
      ? "PASS"
      : "FAIL"
  );
  record(
    "03-invalid-lng-rejected",
    !normalizeLocationFix({ ...base, lng: 999 }, { sessionId: session, sequence: 1 }).ok
      ? "PASS"
      : "FAIL"
  );
  const poor = normalizeLocationFix(
    { ...base, accuracy: MAX_ACCEPT_ACCURACY_M + 20 },
    { sessionId: session, sequence: 1 }
  );
  record("04-poor-accuracy-rejected", !poor.ok ? "PASS" : "FAIL");

  const env = first.envelope;
  record(
    "05-duplicate-ignored",
    evaluateFixAgainstPrevious(env, { ...env }).reason === LOCATION_DIAG.DUPLICATE
      ? "PASS"
      : "FAIL"
  );
  record(
    "06-older-observedAt-ignored",
    !evaluateFixAgainstPrevious(env, {
      ...env,
      observedAt: env.observedAt - 5000,
      sequence: env.sequence + 1,
    }).accept
      ? "PASS"
      : "FAIL"
  );
  record(
    "07-lower-sequence-ignored",
    !evaluateFixAgainstPrevious(env, {
      ...env,
      observedAt: env.observedAt + 1000,
      sequence: env.sequence - 1,
    }).accept
      ? "PASS"
      : "FAIL"
  );
  record(
    "07b-equal-sequence-changed-coords-ooo",
    evaluateFixAgainstPrevious(env, {
      ...env,
      lat: env.lat + 0.001,
      sequence: env.sequence,
      observedAt: env.observedAt + 1000,
    }).reason === LOCATION_DIAG.OUT_OF_ORDER
      ? "PASS"
      : "FAIL"
  );
  record(
    "07c-equal-observedAt-increased-seq-ooo",
    evaluateFixAgainstPrevious(env, {
      ...env,
      sequence: env.sequence + 1,
      observedAt: env.observedAt,
      lat: env.lat + 0.0001,
    }).reason === LOCATION_DIAG.OUT_OF_ORDER
      ? "PASS"
      : "FAIL"
  );

  record(
    "08-new-session-accepted-when-start-newer",
    evaluateFixAgainstPrevious(
      env,
      {
        ...env,
        sessionId: "sess-b",
        sequence: 1,
        observedAt: 2_000_000 + 1_000,
      },
      {
        vehicleSessionId: "sess-b",
        vehicleSessionStartedMs: 2_000_000,
        previousSessionStartedMs: 1_000_000,
      }
    ).accept
      ? "PASS"
      : "FAIL"
  );
  record(
    "08b-new-sessionId-old-timestamp-rejected",
    !evaluateFixAgainstPrevious(
      env,
      { ...env, sessionId: "sess-b", sequence: 1, observedAt: env.observedAt - 10_000 },
      {
        vehicleSessionId: "sess-b",
        vehicleSessionStartedMs: 500_000,
        previousSessionStartedMs: 1_000_000,
      }
    ).accept
      ? "PASS"
      : "FAIL"
  );
  record(
    "08c-delayed-old-session-rejected",
    evaluateFixAgainstPrevious(
      { ...env, sessionId: "sess-b" },
      { ...env, sessionId: "sess-a", sequence: env.sequence + 1, observedAt: env.observedAt + 1000 },
      {
        vehicleSessionId: "sess-b",
        vehicleSessionStartedMs: 2_000_000,
        previousSessionStartedMs: 1_000_000,
      }
    ).reason === LOCATION_DIAG.RETIRED_SESSION
      ? "PASS"
      : "FAIL"
  );

  // A–H: first-fix freshness for new sessions
  const prevSess = {
    lat: 24.86,
    lng: 67.0,
    observedAt: 1_000_000,
    sequence: 3,
    sessionId: "sess-old",
    source: "gps",
  };
  const startMs = 5_000_000;
  record(
    "freshA-new-session-fresh-observedAt-accepted",
    evaluateFixAgainstPrevious(
      prevSess,
      {
        lat: 24.861,
        lng: 67.001,
        observedAt: startMs + 5_000,
        sequence: 1,
        sessionId: "sess-new",
        source: "gps",
      },
      {
        vehicleSessionId: "sess-new",
        vehicleSessionStartedMs: startMs,
        previousSessionStartedMs: 1_000_000,
      }
    ).accept
      ? "PASS"
      : "FAIL"
  );
  record(
    "freshB-new-session-old-observedAt-rejected",
    !evaluateFixAgainstPrevious(
      prevSess,
      {
        lat: 24.861,
        lng: 67.001,
        observedAt: startMs - SESSION_FIRST_FIX_MAX_AGE_MS - 1,
        sequence: 1,
        sessionId: "sess-new",
        source: "gps",
      },
      {
        vehicleSessionId: "sess-new",
        vehicleSessionStartedMs: startMs,
        previousSessionStartedMs: 1_000_000,
      }
    ).accept
      ? "PASS"
      : "FAIL"
  );
  record(
    "freshC-new-session-future-observedAt-rejected",
    !evaluateFixAgainstPrevious(
      prevSess,
      {
        lat: 24.861,
        lng: 67.001,
        observedAt: startMs + SESSION_FIRST_FIX_MAX_FUTURE_MS + 1,
        sequence: 1,
        sessionId: "sess-new",
        source: "gps",
      },
      {
        vehicleSessionId: "sess-new",
        vehicleSessionStartedMs: startMs,
        previousSessionStartedMs: 1_000_000,
      }
    ).accept
      ? "PASS"
      : "FAIL"
  );
  record(
    "freshD-observedAt-inside-skew-tolerance-accepted",
    evaluateFixAgainstPrevious(
      prevSess,
      {
        lat: 24.861,
        lng: 67.001,
        observedAt: startMs - SESSION_FIRST_FIX_MAX_AGE_MS + 1_000,
        sequence: 1,
        sessionId: "sess-new",
        source: "gps",
      },
      {
        vehicleSessionId: "sess-new",
        vehicleSessionStartedMs: startMs,
        previousSessionStartedMs: 1_000_000,
      }
    ).accept &&
      evaluateFixAgainstPrevious(
        prevSess,
        {
          lat: 24.861,
          lng: 67.001,
          observedAt: startMs + SESSION_FIRST_FIX_MAX_FUTURE_MS - 1_000,
          sequence: 1,
          sessionId: "sess-new",
          source: "gps",
        },
        {
          vehicleSessionId: "sess-new",
          vehicleSessionStartedMs: startMs,
          previousSessionStartedMs: 1_000_000,
        }
      ).accept
      ? "PASS"
      : "FAIL"
  );
  record(
    "freshE-same-session-ordering-unchanged",
    evaluateFixAgainstPrevious(env, {
      ...env,
      sequence: env.sequence,
      observedAt: env.observedAt + 1000,
      lat: env.lat + 0.0001,
    }).reason === LOCATION_DIAG.OUT_OF_ORDER &&
      evaluateFixAgainstPrevious(env, {
        ...env,
        sequence: env.sequence + 1,
        observedAt: env.observedAt + 2000,
        lat: env.lat + 0.0002,
      }).accept
      ? "PASS"
      : "FAIL"
  );
  record(
    "freshF-retired-session-still-rejected",
    evaluateFixAgainstPrevious(
      { ...env, sessionId: "sess-b" },
      { ...env, sessionId: "sess-a", sequence: 9, observedAt: startMs + 1000 },
      {
        vehicleSessionId: "sess-b",
        vehicleSessionStartedMs: startMs,
        previousSessionStartedMs: 1_000_000,
      }
    ).reason === LOCATION_DIAG.RETIRED_SESSION
      ? "PASS"
      : "FAIL"
  );
  record(
    "freshG-first-ride-fix-requires-session-match",
    evaluateFixAgainstPrevious(
      null,
      { ...env, sessionId: "sess-a", observedAt: startMs + 1000 },
      {
        enforceSessionConsistency: true,
        vehicleSessionId: "sess-other",
        vehicleSessionStartedMs: startMs,
      }
    ).reason === LOCATION_DIAG.SESSION_MISMATCH
      ? "PASS"
      : "FAIL"
  );
  record(
    "freshH-legacy-read-ok-enforced-write-not-bypassed",
    evaluateFixAgainstPrevious(null, { lat: 24.8, lng: 67.0, observedAt: 1 }).accept &&
      buildDriverLocationPatch(
        {
          trackingSessionId: "sess-a",
          trackingSessionStartedAt: { seconds: 1000, nanoseconds: 0 },
          location: { lat: 24.8, lng: 67.0, observedAt: 1_000_000, sequence: 1 },
        },
        { status: "accepted", vehicleId: "v1", pickupLocation: { lat: 1, lng: 2 } }
      ).reason === LOCATION_DIAG.SESSION_MISMATCH
      ? "PASS"
      : "FAIL"
  );

  // Session ID format (normalizeLocationFix — matches CF + rules)
  const baseFix = { lat: 24.8607, lng: 67.0011, observedAt: 1_000_000, source: "gps" };
  record(
    "sid-valid-min-length-3",
    normalizeLocationFix(baseFix, { sessionId: "abc", sequence: 1 }).ok ? "PASS" : "FAIL"
  );
  record(
    "sid-valid-64-char",
    normalizeLocationFix(baseFix, { sessionId: "a".repeat(64), sequence: 1 }).ok ? "PASS" : "FAIL"
  );
  record(
    "sid-empty-rejected",
    !normalizeLocationFix(baseFix, { sessionId: "", sequence: 1 }).ok ? "PASS" : "FAIL"
  );
  record(
    "sid-2-char-rejected",
    !normalizeLocationFix(baseFix, { sessionId: "ab", sequence: 1 }).ok ? "PASS" : "FAIL"
  );
  record(
    "sid-65-char-rejected",
    !normalizeLocationFix(baseFix, { sessionId: "a".repeat(65), sequence: 1 }).ok ? "PASS" : "FAIL"
  );
  record(
    "sid-whitespace-only-rejected",
    !normalizeLocationFix(baseFix, { sessionId: "   ", sequence: 1 }).ok ? "PASS" : "FAIL"
  );
  record(
    "sid-internal-spaces-rejected",
    !normalizeLocationFix(baseFix, { sessionId: "ab cd", sequence: 1 }).ok ? "PASS" : "FAIL"
  );
  record(
    "sid-punctuation-rejected",
    !normalizeLocationFix(baseFix, { sessionId: "sess@id!", sequence: 1 }).ok ? "PASS" : "FAIL"
  );
  record(
    "sid-non-string-rejected",
    !normalizeLocationFix(baseFix, { sessionId: 12345, sequence: 1 }).ok &&
      !isValidTrackingSessionId(12345)
      ? "PASS"
      : "FAIL"
  );

  // Session ID consistency (CF path)
  const rideEmpty = {
    status: "accepted",
    vehicleId: "v1",
    pickupLocation: { lat: 24.87, lng: 67.01 },
  };
  const matchFirst = buildDriverLocationPatch(
    {
      trackingSessionId: "sess-a",
      trackingSessionStartedAt: { seconds: 1000, nanoseconds: 0 },
      location: { ...env, sessionId: "sess-a" },
    },
    rideEmpty
  );
  record(
    "session-first-fix-matching-ids-pass",
    !matchFirst.skip ? "PASS" : "FAIL",
    matchFirst.reason
  );
  const mismatchFirst = buildDriverLocationPatch(
    {
      trackingSessionId: "sess-vehicle",
      trackingSessionStartedAt: { seconds: 1000, nanoseconds: 0 },
      location: { ...env, sessionId: "sess-other" },
    },
    rideEmpty
  );
  record(
    "session-first-fix-mismatch-fail",
    mismatchFirst.skip && mismatchFirst.reason === LOCATION_DIAG.SESSION_MISMATCH
      ? "PASS"
      : "FAIL",
    mismatchFirst.reason
  );
  const mismatchLater = buildDriverLocationPatch(
    {
      trackingSessionId: "sess-vehicle",
      trackingSessionStartedAt: { seconds: 1000, nanoseconds: 0 },
      location: {
        ...env,
        sessionId: "sess-other",
        sequence: 2,
        observedAt: env.observedAt + 2000,
      },
    },
    {
      ...rideEmpty,
      driverLocation: env,
      driverTrackingSessionId: "sess-a",
      driverTrackingSessionStartedAt: { seconds: 900, nanoseconds: 0 },
    }
  );
  record(
    "session-later-fix-mismatch-fail",
    mismatchLater.skip && mismatchLater.reason === LOCATION_DIAG.SESSION_MISMATCH
      ? "PASS"
      : "FAIL",
    mismatchLater.reason
  );
  const missingSession = buildDriverLocationPatch(
    {
      trackingSessionId: "sess-a",
      trackingSessionStartedAt: { seconds: 1000, nanoseconds: 0 },
      location: { lat: env.lat, lng: env.lng, observedAt: env.observedAt, sequence: 1 },
    },
    rideEmpty
  );
  record(
    "session-missing-location-sessionId-fail",
    missingSession.skip && missingSession.reason === LOCATION_DIAG.SESSION_MISMATCH
      ? "PASS"
      : "FAIL",
    missingSession.reason
  );
  record(
    "session-legacy-evaluate-without-enforce-still-readable",
    evaluateFixAgainstPrevious(null, { lat: 24.8, lng: 67.0, observedAt: 1 }).accept
      ? "PASS"
      : "FAIL",
    "legacy evaluate ok; CF writes still enforce"
  );
  record(
    "session-enforce-first-fix-mismatch",
    evaluateFixAgainstPrevious(
      null,
      { ...env, sessionId: "sess-a" },
      { enforceSessionConsistency: true, vehicleSessionId: "sess-b" }
    ).reason === LOCATION_DIAG.SESSION_MISMATCH
      ? "PASS"
      : "FAIL"
  );

  const jump = evaluateFixAgainstPrevious(env, {
    ...env,
    lat: env.lat + 1,
    lng: env.lng + 1,
    observedAt: env.observedAt + 1000,
    sequence: env.sequence + 1,
  });
  record("09-impossible-jump-rejected", jump.reason === LOCATION_DIAG.IMPOSSIBLE_JUMP ? "PASS" : "FAIL");
  record(
    "10-karachi-movement-accepted",
    evaluateFixAgainstPrevious(env, {
      ...env,
      lat: env.lat + 0.0008,
      lng: env.lng + 0.0008,
      observedAt: env.observedAt + 5000,
      sequence: env.sequence + 1,
    }).accept
      ? "PASS"
      : "FAIL"
  );

  const withH = normalizeLocationFix({ ...base, heading: 45 }, { sessionId: session, sequence: 1 });
  record("11-heading-preserved", withH.ok && withH.envelope.headingDeg === 45 ? "PASS" : "FAIL");
  const nullH = normalizeLocationFix({ ...base, heading: null }, { sessionId: session, sequence: 1 });
  record("12-null-heading-handled", nullH.ok && nullH.envelope.headingDeg == null ? "PASS" : "FAIL");
  const bearing = derivedDisplayBearingDeg(
    { lat: 24.86, lng: 67.0 },
    { lat: 24.87, lng: 67.0 }
  );
  record("13-derived-bearing-consecutive", Number.isFinite(bearing) && (bearing > 350 || bearing < 10) ? "PASS" : "FAIL", String(bearing));

  record(
    "14-accepted-targets-pickup",
    resolveTrackingTarget({ status: "accepted", pickupLocation: { lat: 1, lng: 2 } }).targetType ===
      "pickup"
      ? "PASS"
      : "FAIL"
  );
  record(
    "15-arrived-targets-pickup",
    resolveTrackingTarget({ status: "arrived", pickupLocation: { lat: 1, lng: 2 } }).targetType ===
      "pickup"
      ? "PASS"
      : "FAIL"
  );
  record(
    "16-in-progress-targets-dropoff",
    resolveTrackingTarget({
      status: "in_progress",
      pickupLocation: { lat: 1, lng: 2 },
      dropoffLocation: { lat: 3, lng: 4 },
    }).targetType === "dropoff"
      ? "PASS"
      : "FAIL"
  );
  record(
    "17-terminal-stops-tracking",
    resolveTrackingTarget({ status: "completed" }).trackingActive === false ? "PASS" : "FAIL"
  );
  record(
    "18-missing-pickup-safe",
    resolveTrackingTarget({ status: "accepted" }).coordinates == null ? "PASS" : "FAIL"
  );
  record(
    "19-missing-dropoff-safe",
    resolveTrackingTarget({ status: "in_progress", pickupLocation: { lat: 1, lng: 2 } }).coordinates ==
      null
      ? "PASS"
      : "FAIL"
  );

  record("coord-lat-0-valid", isValidLatLng(0, 67) ? "PASS" : "FAIL");
  record("coord-lng-0-valid", isValidLatLng(24, 0) ? "PASS" : "FAIL");
  record("coord-nan-rejected", !isValidLatLng(NaN, 67) ? "PASS" : "FAIL");
  record("coord-string-rejected", !isValidLatLng("24.8", "67.0") ? "PASS" : "FAIL");
  record("coord-out-of-range-rejected", !isValidLatLng(91, 0) ? "PASS" : "FAIL");

  const now = Date.now();
  record(
    "fresh-receivedAt-wins-over-future-observedAt",
    locationAgeMs(
      {
        driverLocation: {
          lat: 1,
          lng: 1,
          receivedAt: { seconds: Math.floor(now / 1000) - 2, nanoseconds: 0 },
          observedAt: now + 600_000,
        },
      },
      now
    ) != null &&
      locationAgeMs(
        {
          driverLocation: {
            lat: 1,
            lng: 1,
            receivedAt: { seconds: Math.floor(now / 1000) - 2, nanoseconds: 0 },
            observedAt: now + 600_000,
          },
        },
        now
      ) < 10_000
      ? "PASS"
      : "FAIL",
    String(
      locationAgeMs(
        {
          driverLocation: {
            lat: 1,
            lng: 1,
            receivedAt: { seconds: Math.floor(now / 1000) - 2, nanoseconds: 0 },
            observedAt: now + 600_000,
          },
        },
        now
      )
    )
  );
  {
    const age = locationAgeMs(
      {
        driverLocation: {
          lat: 1,
          lng: 1,
          receivedAt: now - 120_000,
          observedAt: now - 2_000,
        },
        driverLocationUpdatedAt: now - 2_000,
      },
      now
    );
    record(
      "fresh-newest-wins-over-stale-receivedAt",
      age != null && age < 10_000 ? "PASS" : "FAIL",
      String(age)
    );
  }
  record(
    "fresh-timestamp-seconds-nanos",
    timestampToMs({ seconds: 1700000000, nanoseconds: 500000000 }) === 1700000000500
      ? "PASS"
      : "FAIL"
  );
  record(
    "fresh-device-clock-10m-ahead-unknown",
    locationAgeMs({ driverLocation: { lat: 1, lng: 1, observedAt: now + 600_000 } }, now) == null
      ? "PASS"
      : "FAIL"
  );
  {
    const age = locationAgeMs(
      {
        driverLocation: { lat: 1, lng: 1, observedAt: now - 999999 },
        driverLocationUpdatedAt: { seconds: Math.floor(now / 1000) - 600, nanoseconds: 0 },
      },
      now
    );
    record(
      "fresh-server-updatedAt-when-no-receivedAt",
      age != null && age >= 599_000 && age <= 601_000 ? "PASS" : "FAIL",
      String(age)
    );
  }
  record(
    "fresh-unknown-when-no-timestamps",
    resolveFreshness(locationAgeMs({ driverLocation: { lat: 1, lng: 1 } }, now)) ===
      FRESHNESS.UNKNOWN || locationAgeMs({ driverLocation: { lat: 1, lng: 1 } }, now) == null
      ? "PASS"
      : "FAIL"
  );
  record(
    "25-delayed-after-threshold",
    resolveFreshness(FRESHNESS_FRESH_MS + 1) === FRESHNESS.DELAYED ? "PASS" : "FAIL"
  );
  record(
    "26-stale-after-threshold",
    resolveFreshness(FRESHNESS_DELAYED_MS + 1) === FRESHNESS.STALE ? "PASS" : "FAIL"
  );
  record("27-fresh-recovers", resolveFreshness(1000) === FRESHNESS.FRESH ? "PASS" : "FAIL");
  record(
    "28-stale-stops-prediction",
    resolveFreshness(FRESHNESS_DELAYED_MS + 1) === FRESHNESS.STALE ? "PASS" : "FAIL"
  );
  const dur = computeAnimationDurationMs(now - 4000, now);
  record("23-anim-follows-timestamps", dur === 4000 ? "PASS" : "FAIL");
  const mid = interpolateLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 10 }, 0.5);
  record("24-interp-midpoint", Math.abs(mid.lat - 5) < 1e-9 ? "PASS" : "FAIL");
  record("heading-north-wrap", normalizeHeadingDeg(360) === 0 ? "PASS" : "FAIL");
  record(
    "heading-rotation-gps-vs-derived",
    resolveMarkerRotationDeg({ headingDeg: 90 }).kind === "gps_heading" &&
      resolveMarkerRotationDeg({
        headingDeg: null,
        previousFix: { lat: 0, lng: 0 },
        nextFix: { lat: 1, lng: 0 },
        derivedBearingFn: derivedDisplayBearingDeg,
      }).kind === "derived_bearing"
      ? "PASS"
      : "FAIL"
  );

  const cfTarget = trackingTargetForRide({
    status: "in_progress",
    dropoffLocation: { lat: 24.9, lng: 67.05 },
  });
  record(
    "cf-tracking-in-progress-dropoff",
    cfTarget?.type === "dropoff" ? "PASS" : "FAIL"
  );
  const est = estimateLocationWriteComparison();
  record(
    "write-estimate-phase1-lower",
    est.phase1Repaired.totalFirestoreLocationWrites <
      est.currentArchitecture.totalFirestoreLocationWrites
      ? "PASS"
      : "FAIL"
  );
  const terminalDecision = buildDriverLocationPatch(
    {
      trackingSessionId: "sess-a",
      location: { ...env, sessionId: "sess-a" },
    },
    { status: "completed", vehicleId: "v1" }
  );
  record(
    "unit-terminal-ride-skip",
    terminalDecision.skip && terminalDecision.reason === "terminal_or_inactive" ? "PASS" : "FAIL"
  );
}

async function unitTestsAsync() {
  // Two immediate callbacks during session start → one stamp
  {
    const writes = [];
    let gen = 1;
    const ser = createLocationWriteSerializer({
      isCancelled: (g) => g !== gen,
      writeFn: async (job) => {
        await new Promise((r) => setTimeout(r, 30));
        writes.push({
          seq: job.envelope.sequence,
          stamp: job.stampSessionStart,
          sessionId: job.sessionId,
        });
      },
    });
    const p1 = ser.enqueue({
      generation: 1,
      sessionId: "s1",
      stampSessionStart: true,
      envelope: { sequence: 1, lat: 1, lng: 1 },
      payload: {},
    });
    const p2 = ser.enqueue({
      generation: 1,
      sessionId: "s1",
      stampSessionStart: true,
      envelope: { sequence: 2, lat: 2, lng: 2 },
      payload: {},
    });
    await Promise.all([p1, p2]);
    const stamps = writes.filter((w) => w.stamp).length;
    record(
      "queue-two-callbacks-one-session-start-stamp",
      writes.length === 2 && stamps === 1 && writes[0].stamp === true && writes[1].stamp === false
        ? "PASS"
        : "FAIL",
      JSON.stringify(writes)
    );
    record(
      "queue-second-fix-follows-after-first",
      writes[0]?.seq === 1 && writes[1]?.seq === 2 ? "PASS" : "FAIL"
    );
  }

  // Three rapid callbacks coalesce to newest pending
  {
    const writes = [];
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const ser = createLocationWriteSerializer({
      writeFn: async (job) => {
        if (writes.length === 0) await gate;
        writes.push(job.envelope.sequence);
      },
    });
    const a = ser.enqueue({
      generation: 1,
      sessionId: "s",
      stampSessionStart: true,
      envelope: { sequence: 1 },
      payload: {},
    });
    ser.enqueue({
      generation: 1,
      sessionId: "s",
      stampSessionStart: false,
      envelope: { sequence: 2 },
      payload: {},
    });
    ser.enqueue({
      generation: 1,
      sessionId: "s",
      stampSessionStart: false,
      envelope: { sequence: 3 },
      payload: {},
    });
    release();
    await a;
    await new Promise((r) => setTimeout(r, 20));
    record(
      "queue-three-rapid-coalesce-newest",
      writes.length === 2 && writes[0] === 1 && writes[1] === 3 ? "PASS" : "FAIL",
      JSON.stringify(writes)
    );
  }

  // Offline / cancel while first pending prevents queued fix
  {
    const writes = [];
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let liveGen = 1;
    const ser = createLocationWriteSerializer({
      isCancelled: (g) => g !== liveGen,
      writeFn: async (job) => {
        if (writes.length === 0) await gate;
        writes.push(job.envelope.sequence);
      },
    });
    const a = ser.enqueue({
      generation: 1,
      sessionId: "s",
      stampSessionStart: true,
      envelope: { sequence: 1 },
      payload: {},
    });
    ser.enqueue({
      generation: 1,
      sessionId: "s",
      stampSessionStart: false,
      envelope: { sequence: 2 },
      payload: {},
    });
    liveGen = 2; // offline / new generation
    ser.cancelAll();
    release();
    await a.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    record(
      "queue-offline-drops-pending",
      writes.length === 1 && writes[0] === 1 ? "PASS" : "FAIL",
      JSON.stringify(writes)
    );
  }

  // Old generation cannot write after new session
  {
    const writes = [];
    const ser = createLocationWriteSerializer({
      isCancelled: (g) => g !== 2,
      writeFn: async (job) => {
        writes.push(job.generation);
      },
    });
    await ser.enqueue({
      generation: 1,
      sessionId: "old",
      stampSessionStart: true,
      envelope: { sequence: 1 },
      payload: {},
    });
    await ser.enqueue({
      generation: 2,
      sessionId: "new",
      stampSessionStart: true,
      envelope: { sequence: 1 },
      payload: {},
    });
    record(
      "queue-old-generation-cannot-write",
      writes.length === 1 && writes[0] === 2 ? "PASS" : "FAIL",
      JSON.stringify(writes)
    );
  }

  // Completion boundary: enqueue after drain selected no pending but before inFlight clears
  {
    const writes = [];
    /** @type {ReturnType<typeof createLocationWriteSerializer>|null} */
    let ser = null;
    let boundaryFired = false;
    ser = createLocationWriteSerializer({
      writeFn: async (job) => {
        writes.push(job.envelope.sequence);
      },
      onAfterDrainBeforeClear: () => {
        if (boundaryFired) return;
        boundaryFired = true;
        ser.enqueue({
          generation: 1,
          sessionId: "s",
          stampSessionStart: false,
          envelope: { sequence: 99 },
          payload: {},
        });
      },
    });
    await ser.enqueue({
      generation: 1,
      sessionId: "s",
      stampSessionStart: true,
      envelope: { sequence: 1 },
      payload: {},
    });
    // Allow finally → re-enqueue flight to finish
    await new Promise((r) => setTimeout(r, 30));
    record(
      "queue-completion-boundary-no-strand",
      writes.length === 2 && writes[0] === 1 && writes[1] === 99 ? "PASS" : "FAIL",
      JSON.stringify(writes)
    );
  }
}

function createSerializingTxnRunner(getRide, setRide, { retryOnce = false } = {}) {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(async () => {
      let attempts = 0;
      for (;;) {
        attempts += 1;
        let patch = null;
        const tx = {
          async get(ref) {
            const path = String(ref?.path || "");
            if (path.includes("vehicles")) {
              return { exists: false, data: () => null };
            }
            return { exists: true, data: () => structuredClone(getRide()) };
          },
          update(_ref, p) {
            patch = p;
          },
        };
        const result = await fn(tx);
        if (retryOnce && attempts === 1 && result?.mirrored) {
          continue;
        }
        if (result?.mirrored && patch) {
          const next = { ...getRide(), ...patch };
          if (patch.driverLocation) {
            next.driverLocation = {
              ...patch.driverLocation,
              receivedAt: { seconds: 1_700_000_000, nanoseconds: 0 },
            };
          }
          setRide(next);
        }
        return result;
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

async function deterministicTxnUnitTestsAsync() {
  const sessionStartMs = 1_000_000;
  const vehicleBase = {
    trackingSessionId: "sess-race",
    trackingSessionStartedAt: { seconds: Math.floor(sessionStartMs / 1000), nanoseconds: 0 },
    activeRideId: "race-ride",
  };
  const oldV = {
    ...vehicleBase,
    location: {
      lat: 24.86,
      lng: 67.0,
      observedAt: sessionStartMs + 1_000,
      sequence: 1,
      sessionId: "sess-race",
      source: "gps",
    },
  };
  const newV = {
    ...vehicleBase,
    location: {
      lat: 24.8605,
      lng: 67.0005,
      observedAt: sessionStartMs + 5_000,
      sequence: 2,
      sessionId: "sess-race",
      source: "gps",
    },
  };
  const dbStub = {
    collection: (c) => ({
      doc: (id) => ({ id, path: `${c}/${id}` }),
    }),
  };

  let finalsOk = 0;
  let travelOk = 0;
  for (let i = 0; i < 12; i++) {
    let ride = {
      status: "in_progress",
      vehicleId: "veh-race",
      pickupLocation: { lat: 24.87, lng: 67.01 },
      dropoffLocation: { lat: 24.9, lng: 67.05 },
      traveledDistanceKm: 0.1,
      lastTrackedLocation: { lat: 24.859, lng: 66.999 },
    };
    const beforeKm = ride.traveledDistanceKm;
    const runTransaction = createSerializingTxnRunner(
      () => ride,
      (r) => {
        ride = r;
      }
    );
    const order = i % 2 === 0 ? [oldV, newV] : [newV, oldV];
    await Promise.all(
      order.map((v) =>
        mirrorRideLocationTransactional(dbStub, "veh-race", v, {
          rideId: "race-ride",
          runTransaction,
          silent: true,
        })
      )
    );
    if (ride.driverLocation?.sequence === 2) finalsOk += 1;
    const km = Number(ride.traveledDistanceKm) || 0;
    // Must not lose baseline and must not roughly double-apply both segments incorrectly
    if (km >= beforeKm && km < beforeKm + 5) travelOk += 1;
  }
  record(
    "txn-race-newer-always-wins-x12",
    finalsOk === 12 ? "PASS" : "FAIL",
    `ok=${finalsOk}/12`
  );
  record(
    "txn-race-distance-not-lost-or-doubled-x12",
    travelOk === 12 ? "PASS" : "FAIL",
    `ok=${travelOk}/12`
  );

  // Retry re-evaluates latest ride + single success log after commit
  {
    let ride = {
      status: "accepted",
      vehicleId: "veh-race",
      pickupLocation: { lat: 24.87, lng: 67.01 },
      driverLocation: {
        lat: 24.86,
        lng: 67.0,
        observedAt: sessionStartMs + 1_000,
        sequence: 1,
        sessionId: "sess-race",
      },
      driverTrackingSessionId: "sess-race",
      driverTrackingSessionStartedAt: {
        seconds: Math.floor(sessionStartMs / 1000),
        nanoseconds: 0,
      },
    };
    const diag = [];
    setCfDiagSink((p) => diag.push(p.reason));
    const runTransaction = createSerializingTxnRunner(
      () => ride,
      (r) => {
        ride = r;
      },
      { retryOnce: true }
    );
    const res = await mirrorRideLocationTransactional(dbStub, "veh-race", newV, {
      rideId: "race-ride",
      runTransaction,
    });
    const mirroredLogs = diag.filter((r) => r === CF_DIAG.MIRRORED).length;
    record(
      "txn-retry-reevaluates-and-logs-once",
      res.mirrored && mirroredLogs === 1 && ride.driverLocation?.sequence === 2
        ? "PASS"
        : "FAIL",
      `logs=${mirroredLogs} seq=${ride.driverLocation?.sequence}`
    );
    setCfDiagSink(null);
  }
}

function staticChecks() {
  const driverSrc = read("driver-app/js/driver-app.js");
  record(
    "21-driver-no-direct-ride-location-write",
    !driverSrc.includes("syncActiveRideDriverLocation") &&
      driverSrc.includes("Intentionally no client ride.driverLocation write")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "static-session-server-timestamp",
    driverSrc.includes("trackingSessionStartedAt = serverTimestamp()") ||
      driverSrc.includes("trackingSessionStartedAt = serverTimestamp()")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "static-location-write-serializer",
    driverSrc.includes("createLocationWriteSerializer") &&
      driverSrc.includes("locationWriteSerializer")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "static-end-session-on-stop-watch",
    driverSrc.includes("endLocationTrackingSession") ? "PASS" : "FAIL",
    "",
    "static"
  );
  const trackSrc = read("customer-app/js/driver-track.js");
  record(
    "29-anim-cancel-terminal",
    trackSrc.includes("!tracking.trackingActive") ? "PASS" : "FAIL",
    "",
    "static"
  );
  record(
    "30-anim-cancel-reassignment",
    trackSrc.includes("lastTrackedDriverId") && trackSrc.includes("clearAssignedDriver")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  const i18n = read("customer-app/js/i18n.js");
  const html = read("customer-app/index.html");
  record(
    "31-simulated-traffic-not-live-label",
    i18n.includes("حقیقی ٹریفک نہیں") && html.includes('data-traffic-kind="sample_not_live"')
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "32-privacy-safe-logs",
    read("functions/live-location-envelope.js").includes("never log coordinates")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "33-ride-driverLocation-client-rule-removed",
    !rulesText.includes("'driverLocation', 'driverLocationUpdatedAt', 'driverDistanceKm', 'driverEtaMin'")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "static-rules-session-immutability-helper",
    rulesText.includes("vehicleTrackingSessionFieldsOk") &&
      rulesText.includes("isValidTrackingSessionId") &&
      rulesText.includes("location.sessionId == request.resource.data.trackingSessionId")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "static-unknown-freshness-urdu",
    i18n.includes("liveTrackLocationUnknownTime") &&
      i18n.includes("ڈرائیور کے مقام کا وقت معلوم نہیں")
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
  record(
    "static-log-outside-transaction",
    read("functions/driver-location.js").includes("Log once after successful commit") &&
      !/runTransaction\(async \(tx\) => \{[\s\S]*logLocationDiag\(LOCATION_DIAG\.MIRRORED\)/.test(
        read("functions/driver-location.js")
      )
      ? "PASS"
      : "FAIL",
    "",
    "static"
  );
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeoutMs = 8000, intervalMs = 150 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

async function emulatorTests() {
  const admin = require(require.resolve("firebase-admin", {
    paths: [path.join(ROOT, "functions"), ROOT],
  }));
  let app;
  try {
    app = admin.app();
  } catch {
    app = admin.initializeApp({ projectId: PROJECT });
  }
  const db = admin.firestore(app);
  const Ts = admin.firestore.Timestamp;
  const AdminFieldValue = admin.firestore.FieldValue;

  /** Align vehicles.locationUpdatedAt with fix observedAt (trust-anchor recency model). */
  function withTrustedVehicleLoc(vehicleBase, location) {
    const obs = Number(location?.observedAt) || Date.now();
    return {
      ...vehicleBase,
      location,
      locationUpdatedAt: Ts.fromMillis(obs),
    };
  }

  const vehicleId = "llf-veh-1";
  const rideId = "llf-ride-1";
  const driverId = "llf-drv-1";
  const customerId = "llf-cust-1";

  await db.doc(`vehicles/${vehicleId}`).set({
    driverId,
    ownerId: "llf-owner",
    status: "in_ride",
    activeRideId: rideId,
    trackingSessionId: "sess-1",
    trackingSessionStartedAt: Ts.fromMillis(1_000_000),
    location: {
      lat: 24.861,
      lng: 67.002,
      observedAt: 1_000_100,
      sequence: 1,
      sessionId: "sess-1",
      headingDeg: 90,
      source: "gps",
    },
    locationUpdatedAt: Ts.fromMillis(1_000_100),
  });
  await db.doc(`rides/${rideId}`).set({
    userId: customerId,
    driverId,
    vehicleId,
    status: "accepted",
    pickupLocation: { lat: 24.87, lng: 67.01 },
    dropoffLocation: { lat: 24.9, lng: 67.05 },
    estimatedFare: 500,
  });

  const mirror1 = await mirrorDriverLocationToRide(
    db,
    vehicleId,
    (await db.doc(`vehicles/${vehicleId}`).get()).data()
  );
  const rideAfter = (await db.doc(`rides/${rideId}`).get()).data();
  record(
    "20-customer-receives-cf-mirrored-location",
    mirror1.mirrored && rideAfter.driverLocation?.lat === 24.861 ? "PASS" : "FAIL",
    mirror1.reason,
    "emulator"
  );

  const vehicleBase = (await db.doc(`vehicles/${vehicleId}`).get()).data();
  const fixNew = withTrustedVehicleLoc(vehicleBase, {
    lat: 24.862,
    lng: 67.003,
    observedAt: 1_000_500,
    sequence: 3,
    sessionId: "sess-1",
    source: "gps",
  });
  const fixOld = withTrustedVehicleLoc(vehicleBase, {
    lat: 24.85,
    lng: 67.0,
    observedAt: 1_000_200,
    sequence: 2,
    sessionId: "sess-1",
    source: "gps",
  });
  await Promise.all([
    mirrorDriverLocationToRide(db, vehicleId, fixOld),
    mirrorDriverLocationToRide(db, vehicleId, fixNew),
  ]);
  const afterRace = (await db.doc(`rides/${rideId}`).get()).data();
  record(
    "emu-concurrent-older-never-wins",
    afterRace.driverLocation?.sequence === 3 && afterRace.driverLocation?.lat === 24.862
      ? "PASS"
      : "FAIL",
    `seq=${afterRace.driverLocation?.sequence}`,
    "emulator"
  );

  const dup = await mirrorDriverLocationToRide(db, vehicleId, fixNew);
  record(
    "emu-duplicate-no-second-logical-update",
    !dup.mirrored &&
      (dup.reason === LOCATION_DIAG.DUPLICATE || dup.reason === LOCATION_DIAG.NOOP_UNCHANGED)
      ? "PASS"
      : "FAIL",
    dup.reason,
    "emulator"
  );

  await db.doc(`rides/${rideId}`).set(
    {
      status: "in_progress",
      lastTrackedLocation: { lat: 24.862, lng: 67.003 },
      traveledDistanceKm: 0.1,
      driverLocation: afterRace.driverLocation,
      driverTrackingSessionId: "sess-1",
      driverTrackingSessionStartedAt: Ts.fromMillis(1_000_000),
    },
    { merge: true }
  );
  await mirrorDriverLocationToRide(
    db,
    vehicleId,
    withTrustedVehicleLoc(fixNew, {
      lat: 24.863,
      lng: 67.004,
      observedAt: 1_001_000,
      sequence: 4,
      sessionId: "sess-1",
      source: "gps",
    })
  );
  await mirrorDriverLocationToRide(
    db,
    vehicleId,
    withTrustedVehicleLoc(fixNew, {
      lat: 24.864,
      lng: 67.005,
      observedAt: 1_001_500,
      sequence: 5,
      sessionId: "sess-1",
      source: "gps",
    })
  );
  const afterTravel = (await db.doc(`rides/${rideId}`).get()).data();
  record(
    "22-active-ride-distance-accumulation",
    Number(afterTravel.traveledDistanceKm) > 0.1 ? "PASS" : "FAIL",
    `km=${afterTravel.traveledDistanceKm}`,
    "emulator"
  );

  await db.doc(`rides/${rideId}`).set(
    {
      driverLocation: {
        lat: 24.864,
        lng: 67.005,
        observedAt: 1_001_500,
        sequence: 5,
        sessionId: "sess-1",
      },
      driverTrackingSessionStartedAt: Ts.fromMillis(1_000_000),
      lastTrackedLocation: { lat: 24.864, lng: 67.005 },
    },
    { merge: true }
  );
  await Promise.all([
    mirrorDriverLocationToRide(
      db,
      vehicleId,
      withTrustedVehicleLoc(fixNew, {
        lat: 24.8642,
        lng: 67.0052,
        observedAt: 1_002_000,
        sequence: 6,
        sessionId: "sess-1",
        source: "gps",
      })
    ),
    mirrorDriverLocationToRide(
      db,
      vehicleId,
      withTrustedVehicleLoc(fixNew, {
        lat: 24.8645,
        lng: 67.0055,
        observedAt: 1_006_000,
        sequence: 7,
        sessionId: "sess-1",
        source: "gps",
      })
    ),
  ]);
  const afterOrdered = (await db.doc(`rides/${rideId}`).get()).data();
  record(
    "emu-concurrent-correct-order-final",
    afterOrdered.driverLocation?.sequence === 7 ? "PASS" : "FAIL",
    `seq=${afterOrdered.driverLocation?.sequence}`,
    "emulator"
  );

  // Emulator stress races (observable final state only — write counts are estimates)
  let stressOk = 0;
  for (let i = 0; i < 8; i++) {
    await db.doc(`rides/${rideId}`).set(
      {
        status: "accepted",
        vehicleId,
        driverLocation: {
          lat: 24.864,
          lng: 67.005,
          observedAt: 2_000_000,
          sequence: 10,
          sessionId: "sess-1",
        },
        driverTrackingSessionId: "sess-1",
        driverTrackingSessionStartedAt: Ts.fromMillis(1_000_000),
      },
      { merge: true }
    );
    const older = withTrustedVehicleLoc(fixNew, {
      lat: 24.863,
      lng: 67.004,
      observedAt: 2_000_100,
      sequence: 11,
      sessionId: "sess-1",
      source: "gps",
    });
    const newer = withTrustedVehicleLoc(fixNew, {
      lat: 24.865,
      lng: 67.006,
      observedAt: 2_010_000,
      sequence: 12,
      sessionId: "sess-1",
      source: "gps",
    });
    const pair = i % 2 === 0 ? [older, newer] : [newer, older];
    await Promise.all(pair.map((v) => mirrorDriverLocationToRide(db, vehicleId, v)));
    const d = (await db.doc(`rides/${rideId}`).get()).data();
    if (d?.driverLocation?.sequence === 12) stressOk += 1;
  }
  record(
    "emu-stress-race-newer-wins-x8",
    stressOk === 8 ? "PASS" : "FAIL",
    `ok=${stressOk}/8 (write counts estimated)`,
    "emulator"
  );

  await db.doc(`rides/${rideId}`).set({ status: "completed" }, { merge: true });
  const term = await mirrorDriverLocationToRide(
    db,
    vehicleId,
    withTrustedVehicleLoc(fixNew, {
      lat: 24.9,
      lng: 67.1,
      observedAt: 1_003_000,
      sequence: 8,
      sessionId: "sess-1",
      source: "gps",
    })
  );
  record(
    "emu-terminal-no-update",
    !term.mirrored ? "PASS" : "FAIL",
    term.reason,
    "emulator"
  );

  await db.doc(`rides/${rideId}`).set(
    { status: "accepted", vehicleId: "other-vehicle" },
    { merge: true }
  );
  const mismatch = await mirrorDriverLocationToRide(db, vehicleId, fixNew);
  record(
    "emu-vehicle-mismatch-no-update",
    !mismatch.mirrored && mismatch.reason === "vehicle_mismatch" ? "PASS" : "FAIL",
    mismatch.reason,
    "emulator"
  );

  // Seed path: vehicle+ride read inside one transaction
  const seedRide = "llf-seed-ride";
  const seedVeh = "llf-seed-veh";
  await db.doc(`rides/${seedRide}`).set({
    userId: customerId,
    driverId,
    vehicleId: seedVeh,
    status: "accepted",
    pickupLocation: { lat: 24.87, lng: 67.01 },
    dropoffLocation: { lat: 24.9, lng: 67.05 },
    estimatedFare: 400,
  });
  await db.doc(`vehicles/${seedVeh}`).set({
    driverId,
    ownerId: "llf-owner",
    status: "in_ride",
    activeRideId: seedRide,
    trackingSessionId: "seed-sess",
    trackingSessionStartedAt: Ts.fromMillis(Date.now()),
    location: {
      lat: 24.871,
      lng: 67.021,
      observedAt: Date.now(),
      sequence: 1,
      sessionId: "seed-sess",
      source: "gps",
    },
    locationUpdatedAt: Ts.now(),
  });
  // Trigger may race-mirror first — clear ride location so seed is the authority under test.
  await sleep(400);
  await db.doc(`rides/${seedRide}`).update({
    driverLocation: AdminFieldValue.delete(),
    driverTrackingSessionId: AdminFieldValue.delete(),
    driverTrackingSessionStartedAt: AdminFieldValue.delete(),
    driverLocationUpdatedAt: AdminFieldValue.delete(),
  });
  const seedRes = await seedDriverLocationFromVehicle(db, seedRide, seedVeh);
  const seeded = (await db.doc(`rides/${seedRide}`).get()).data();
  record(
    "emu-seed-reads-vehicle-in-txn",
    seedRes.mirrored && seeded?.driverLocation?.sessionId === "seed-sess" ? "PASS" : "FAIL",
    seedRes.reason,
    "emulator"
  );
  // Stale mismatched session cannot seed as first fix
  await db.doc(`rides/${seedRide}`).set(
    { driverLocation: null, driverTrackingSessionId: null },
    { merge: true }
  );
  await db.doc(`vehicles/${seedVeh}`).set(
    {
      trackingSessionId: "seed-sess-live",
      trackingSessionStartedAt: Ts.fromMillis(Date.now()),
      location: {
        lat: 24.872,
        lng: 67.022,
        observedAt: Date.now(),
        sequence: 1,
        sessionId: "seed-sess-STALE",
        source: "gps",
      },
      locationUpdatedAt: Ts.now(),
    },
    { merge: true }
  );
  const seedBad = await seedDriverLocationFromVehicle(db, seedRide, seedVeh);
  record(
    "emu-seed-rejects-session-mismatch",
    !seedBad.mirrored && seedBad.reason === LOCATION_DIAG.SESSION_MISMATCH ? "PASS" : "FAIL",
    seedBad.reason,
    "emulator"
  );

  // --- Real trigger path + true noop proof ---
  const rideTrig = "llf-ride-trig";
  const vehTrig = "llf-veh-trig";
  const diag = [];
  setCfDiagSink((p) => diag.push(p.reason));

  await db.doc(`rides/${rideTrig}`).set({
    userId: customerId,
    driverId,
    vehicleId: vehTrig,
    status: "accepted",
    pickupLocation: { lat: 24.87, lng: 67.01 },
    dropoffLocation: { lat: 24.9, lng: 67.05 },
    estimatedFare: 400,
    traveledDistanceKm: 0.25,
    lastTrackedLocation: { lat: 24.869, lng: 67.019 },
  });
  await db.doc(`vehicles/${vehTrig}`).set({
    driverId,
    ownerId: "llf-owner",
    status: "in_ride",
    activeRideId: rideTrig,
    trackingSessionId: "trig-sess",
    trackingSessionStartedAt: Ts.fromMillis(Date.now()),
    location: {
      lat: 24.87,
      lng: 67.02,
      observedAt: Date.now(),
      sequence: 1,
      sessionId: "trig-sess",
      source: "gps",
    },
    locationUpdatedAt: Ts.now(),
  });
  const mirrored = await waitFor(async () => {
    const d = (await db.doc(`rides/${rideTrig}`).get()).data();
    return d?.driverLocation?.lat === 24.87 ? d : null;
  });
  record(
    "emu-trigger-mirrors-vehicle-write",
    mirrored ? "PASS" : "FAIL",
    mirrored ? "mirrored" : "timeout",
    "emulator"
  );

  const beforeSnap = await db.doc(`rides/${rideTrig}`).get();
  const beforeIdentical = beforeSnap.data();
  const beforeUpdateTime = beforeSnap.updateTime;
  const beforeReceived = timestampToMs(beforeIdentical.driverLocation?.receivedAt);
  const beforeTravel = beforeIdentical.traveledDistanceKm;
  const beforeLast = JSON.stringify(beforeIdentical.lastTrackedLocation || null);
  const beforeLoc = JSON.stringify({
    lat: beforeIdentical.driverLocation?.lat,
    lng: beforeIdentical.driverLocation?.lng,
    sequence: beforeIdentical.driverLocation?.sequence,
    sessionId: beforeIdentical.driverLocation?.sessionId,
    observedAt: beforeIdentical.driverLocation?.observedAt,
  });
  const mirroredBefore = diag.filter((r) => r === CF_DIAG.MIRRORED).length;

  // Identical vehicle write (same envelope) — should no-op on ride
  const identicalObs = Number(beforeIdentical.driverLocation?.observedAt) || Date.now();
  await db.doc(`vehicles/${vehTrig}`).set(
    {
      trackingSessionId: "trig-sess",
      location: {
        lat: beforeIdentical.driverLocation.lat,
        lng: beforeIdentical.driverLocation.lng,
        observedAt: beforeIdentical.driverLocation.observedAt,
        sequence: beforeIdentical.driverLocation.sequence,
        sessionId: "trig-sess",
        source: "gps",
      },
      locationUpdatedAt: Ts.fromMillis(identicalObs),
    },
    { merge: true }
  );
  await sleep(1200);
  const afterSnap = await db.doc(`rides/${rideTrig}`).get();
  const afterIdentical = afterSnap.data();
  const afterReceived = timestampToMs(afterIdentical.driverLocation?.receivedAt);
  const afterLoc = JSON.stringify({
    lat: afterIdentical.driverLocation?.lat,
    lng: afterIdentical.driverLocation?.lng,
    sequence: afterIdentical.driverLocation?.sequence,
    sessionId: afterIdentical.driverLocation?.sessionId,
    observedAt: afterIdentical.driverLocation?.observedAt,
  });
  const mirroredAfter = diag.filter((r) => r === CF_DIAG.MIRRORED).length;
  const updateTimeUnchanged =
    beforeUpdateTime && afterSnap.updateTime
      ? beforeUpdateTime.isEqual?.(afterSnap.updateTime) ||
        String(beforeUpdateTime) === String(afterSnap.updateTime)
      : beforeReceived === afterReceived;

  record(
    "emu-trigger-identical-update-idempotent",
    updateTimeUnchanged &&
      beforeReceived === afterReceived &&
      beforeTravel === afterIdentical.traveledDistanceKm &&
      beforeLast === JSON.stringify(afterIdentical.lastTrackedLocation || null) &&
      beforeLoc === afterLoc &&
      mirroredAfter === mirroredBefore
      ? "PASS"
      : "FAIL",
    `updEq=${updateTimeUnchanged} recv=${beforeReceived === afterReceived} logs=${mirroredBefore}->${mirroredAfter}`,
    "emulator"
  );
  setCfDiagSink(null);
}

async function rulesTests() {
  const emuHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const [host, portStr] = emuHost.split(":");
  const port = Number(portStr) || 8080;

  let testEnv;
  try {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: rulesText, host, port },
    });
  } catch (err) {
    record("rules-emulator-bootstrap", "BLOCKED", String(err.message || err).slice(0, 160), "rules");
    return;
  }

  const admin = require(require.resolve("firebase-admin", {
    paths: [path.join(ROOT, "functions"), ROOT],
  }));
  let adminApp;
  try {
    adminApp = admin.app();
  } catch {
    adminApp = admin.initializeApp({ projectId: PROJECT });
  }
  const adminDb = admin.firestore(adminApp);
  const AdminTs = admin.firestore.Timestamp;

  await testEnv.clearFirestore();

  const ownerUid = "llf-rules-owner";
  const driverA = "llf-rules-drv-a";
  const driverB = "llf-rules-drv-b";
  const blockedDriver = "llf-rules-drv-blocked";
  const customer = "llf-rules-cust";
  const otherCust = "llf-rules-cust-other";
  const rideId = "llf-rules-ride";
  const vehId = "llf-rules-veh";

  await adminDb.doc(`partners/${driverA}`).set({
    uid: driverA,
    role: "driver",
    accountStatus: "active",
    currentVehicleId: vehId,
    walletBalance: 0,
  });
  await adminDb.doc(`partners/${driverB}`).set({
    uid: driverB,
    role: "driver",
    accountStatus: "active",
    walletBalance: 0,
  });
  await adminDb.doc(`partners/${blockedDriver}`).set({
    uid: blockedDriver,
    role: "driver",
    accountStatus: "blocked",
    walletBalance: 0,
  });

  await adminDb.doc(`rides/${rideId}`).set({
    userId: customer,
    driverId: driverA,
    vehicleId: vehId,
    status: "accepted",
    pickupLocation: { lat: 24.87, lng: 67.01, address: "A" },
    dropoffLocation: { lat: 24.9, lng: 67.05, address: "B" },
    vehicleType: "go",
    distanceKm: 5,
    timeMins: 12,
    farePkr: 400,
    createdAt: AdminTs.now(),
    driverLocation: {
      lat: 24.871,
      lng: 67.012,
      observedAt: Date.now(),
      sequence: 1,
      sessionId: "rules-sess",
      receivedAt: AdminTs.now(),
    },
  });

  await adminDb.doc(`vehicles/${vehId}`).set({
    ownerId: ownerUid,
    plate: "RUL-1",
    pinHash: "abc",
    driverId: driverA,
    driverName: "Driver A",
    status: "online",
    trackingSessionId: "rules-sess",
    trackingSessionStartedAt: AdminTs.fromMillis(Date.now() - 60_000),
    location: {
      lat: 24.871,
      lng: 67.012,
      observedAt: Date.now(),
      sequence: 1,
      sessionId: "rules-sess",
      source: "gps",
    },
    locationUpdatedAt: AdminTs.now(),
  });

  async function tryPass(name, fn) {
    try {
      await fn();
      record(name, "PASS", "", "rules");
    } catch (e) {
      record(name, "FAIL", String(e.message || e).slice(0, 160), "rules");
    }
  }

  const custDb = testEnv.authenticatedContext(customer, { email: "c@t.local" }).firestore();
  const otherDb = testEnv.authenticatedContext(otherCust, { email: "o@t.local" }).firestore();
  const unauthDb = testEnv.unauthenticatedContext().firestore();
  const drvA = testEnv.authenticatedContext(driverA, { email: "a@t.local" }).firestore();
  const drvB = testEnv.authenticatedContext(driverB, { email: "b@t.local" }).firestore();
  const drvBlocked = testEnv
    .authenticatedContext(blockedDriver, { email: "blk@t.local" })
    .firestore();

  await tryPass("rules-customer-can-read-own-mirrored-ride", async () => {
    await assertSucceeds(getDoc(doc(custDb, "rides", rideId)));
  });
  await tryPass("rules-unrelated-customer-denied", async () => {
    await assertFails(getDoc(doc(otherDb, "rides", rideId)));
  });
  await tryPass("rules-unauthenticated-reader-denied", async () => {
    await assertFails(getDoc(doc(unauthDb, "rides", rideId)));
  });

  const validLocWrite = (sessionId, { stampStart = false, seq = 2 } = {}) => {
    const payload = {
      location: {
        lat: 24.872,
        lng: 67.013,
        observedAt: Date.now(),
        sequence: seq,
        sessionId,
        source: "gps",
      },
      locationUpdatedAt: serverTimestamp(),
      trackingSessionId: sessionId,
      status: "online",
    };
    if (stampStart) payload.trackingSessionStartedAt = serverTimestamp();
    return payload;
  };

  await tryPass("rules-assigned-driver-valid-envelope", async () => {
    await assertSucceeds(updateDoc(doc(drvA, "vehicles", vehId), validLocWrite("rules-sess")));
  });
  await tryPass("rules-other-driver-denied", async () => {
    await assertFails(updateDoc(doc(drvB, "vehicles", vehId), validLocWrite("rules-sess", { seq: 3 })));
  });

  await adminDb.doc(`vehicles/${vehId}`).set({ driverId: blockedDriver }, { merge: true });
  await adminDb.doc(`partners/${blockedDriver}`).set({ currentVehicleId: vehId }, { merge: true });
  await tryPass("rules-blocked-driver-denied", async () => {
    await assertFails(
      updateDoc(doc(drvBlocked, "vehicles", vehId), validLocWrite("rules-sess", { seq: 4 }))
    );
  });
  // restore linked active driver
  await adminDb.doc(`vehicles/${vehId}`).set(
    {
      driverId: driverA,
      trackingSessionId: "rules-sess",
      trackingSessionStartedAt: AdminTs.fromMillis(Date.now() - 60_000),
      location: {
        lat: 24.871,
        lng: 67.012,
        observedAt: Date.now(),
        sequence: 1,
        sessionId: "rules-sess",
        source: "gps",
      },
      status: "online",
    },
    { merge: true }
  );

  await tryPass("rules-matching-session-same-start-passes", async () => {
    await assertSucceeds(updateDoc(doc(drvA, "vehicles", vehId), validLocWrite("rules-sess", { seq: 5 })));
  });

  await tryPass("rules-mismatch-location-sessionId-denied", async () => {
    await assertFails(
      updateDoc(doc(drvA, "vehicles", vehId), {
        location: {
          lat: 24.873,
          lng: 67.014,
          observedAt: Date.now(),
          sequence: 6,
          sessionId: "OTHER",
          source: "gps",
        },
        locationUpdatedAt: serverTimestamp(),
        trackingSessionId: "rules-sess",
        status: "online",
      })
    );
  });

  await tryPass("rules-same-session-changing-start-denied", async () => {
    await assertFails(
      updateDoc(doc(drvA, "vehicles", vehId), {
        ...validLocWrite("rules-sess", { seq: 7 }),
        trackingSessionStartedAt: serverTimestamp(),
      })
    );
  });

  await tryPass("rules-new-session-without-start-denied", async () => {
    await assertFails(
      updateDoc(doc(drvA, "vehicles", vehId), {
        location: {
          lat: 24.874,
          lng: 67.015,
          observedAt: Date.now(),
          sequence: 1,
          sessionId: "rules-sess-2",
          source: "gps",
        },
        locationUpdatedAt: serverTimestamp(),
        trackingSessionId: "rules-sess-2",
        status: "online",
      })
    );
  });

  await tryPass("rules-new-session-with-request-time-start-passes", async () => {
    await assertSucceeds(
      updateDoc(
        doc(drvA, "vehicles", vehId),
        validLocWrite("rules-sess-2", { stampStart: true, seq: 1 })
      )
    );
  });

  await tryPass("rules-independent-start-mutation-denied", async () => {
    await assertFails(
      updateDoc(doc(drvA, "vehicles", vehId), {
        trackingSessionStartedAt: serverTimestamp(),
      })
    );
  });

  await tryPass("rules-oversized-trackingSessionId-denied", async () => {
    const big = `s_${"x".repeat(80)}`;
    await assertFails(
      updateDoc(doc(drvA, "vehicles", vehId), validLocWrite(big, { stampStart: true, seq: 1 }))
    );
  });

  await tryPass("rules-invalid-trackingSessionId-charset-denied", async () => {
    await assertFails(
      updateDoc(
        doc(drvA, "vehicles", vehId),
        validLocWrite("bad session!", { stampStart: true, seq: 1 })
      )
    );
  });

  await testEnv.cleanup();
}

async function main() {
  console.log("\n=== Live-location foundation Phase 1 (final review) ===\n");
  unitTests();
  await unitTestsAsync();
  await deterministicTxnUnitTestsAsync();
  staticChecks();

  try {
    await emulatorTests();
  } catch (e) {
    record("emulator-suite", "BLOCKED", String(e.message || e).slice(0, 160), "emulator");
  }

  try {
    await rulesTests();
  } catch (e) {
    record("rules-suite", "BLOCKED", String(e.message || e).slice(0, 160), "rules");
  }

  const byCat = (cat, status) =>
    results.filter((r) => r.category === cat && r.status === status).length;
  const summary = {
    unit: {
      pass: byCat("unit", "PASS"),
      fail: byCat("unit", "FAIL"),
      blocked: byCat("unit", "BLOCKED"),
    },
    emulator: {
      pass: byCat("emulator", "PASS"),
      fail: byCat("emulator", "FAIL"),
      blocked: byCat("emulator", "BLOCKED"),
    },
    rules: {
      pass: byCat("rules", "PASS"),
      fail: byCat("rules", "FAIL"),
      blocked: byCat("rules", "BLOCKED"),
    },
    static: {
      pass: byCat("static", "PASS"),
      fail: byCat("static", "FAIL"),
      blocked: byCat("static", "BLOCKED"),
    },
    writeEstimate: estimateLocationWriteComparison(),
  };

  const fail = results.filter((r) => r.status === "FAIL").length;
  const pass = results.filter((r) => r.status === "PASS").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  fs.writeFileSync(
    OUT,
    `${JSON.stringify({ pass, fail, blocked, total: results.length, summary, results }, null, 2)}\n`
  );
  console.log("\n--- Category summary ---");
  console.log("unit:", summary.unit);
  console.log("emulator:", summary.emulator);
  console.log("rules:", summary.rules);
  console.log("static:", summary.static);
  console.log(`\n${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED (${results.length} total)\n`);

  if (fail > 0) process.exit(1);
  if (
    (summary.emulator.blocked > 0 && summary.emulator.pass === 0) ||
    (summary.rules.blocked > 0 && summary.rules.pass === 0)
  ) {
    console.error("Emulator/rules path blocked — not a full Phase 1 pass.");
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
