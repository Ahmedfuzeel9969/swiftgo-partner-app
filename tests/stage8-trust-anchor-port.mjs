/**
 * Main-alignment tranche 1 — locationUpdatedAt trust-anchor port.
 *
 * Ports from origin/main without merge/rebase:
 * - firestore.rules vehicleLocationUpdatedAtOk()
 * - live-location-envelope trust-anchor helpers
 * - driver-location mirror gate wiring
 *
 * Run: node tests/stage8-trust-anchor-port.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const env = require("../functions/live-location-envelope.js");
const {
  LOCATION_DIAG,
  SESSION_FIRST_FIX_MAX_AGE_MS,
  SESSION_FIRST_FIX_MAX_FUTURE_MS,
  evaluateFixAgainstPrevious,
  resolveCommittedTrustAnchorMs,
  validateTrustedFixRecency,
  validateTrustAnchorBounds,
  resolveFirstRideFixFreshness,
} = env;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage8-trust-anchor-port-results.json");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
const driverLoc = fs.readFileSync(path.join(ROOT, "functions/driver-location.js"), "utf8");

record(
  "rules-defines-vehicleLocationUpdatedAtOk",
  rules.includes("function vehicleLocationUpdatedAtOk()") &&
    rules.includes("locationUpdatedAt == request.time")
    ? "PASS"
    : "FAIL"
);
record(
  "rules-online-ready-uses-helper",
  /isDriverVehicleOnlineReadyUpdate[\s\S]*vehicleLocationUpdatedAtOk\(\)/.test(rules)
    ? "PASS"
    : "FAIL"
);
record(
  "rules-location-update-uses-helper",
  rules.includes("vehicleLocationUpdatedAtOk()") &&
    /status in \['online', 'in_ride'\]\s*\n\s*&& vehicleLocationUpdatedAtOk\(\)/.test(rules)
    ? "PASS"
    : "FAIL"
);
record(
  "rules-not-timestamp-only-on-online-ready",
  !/isDriverVehicleOnlineReadyUpdate[\s\S]*locationUpdatedAt is timestamp\s*\n\s*&& request\.resource\.data\.locationGridCell/.test(
    rules
  )
    ? "PASS"
    : "FAIL",
  "must require == request.time, not merely timestamp type"
);

{
  const ts = { toMillis: () => 1_700_000_000_000 };
  record(
    "resolve-accepts-timestamp-shape",
    resolveCommittedTrustAnchorMs({ locationUpdatedAt: ts }) === 1_700_000_000_000
      ? "PASS"
      : "FAIL"
  );
  record(
    "resolve-rejects-plain-number",
    resolveCommittedTrustAnchorMs({ locationUpdatedAt: 1_700_000_000_000 }) == null
      ? "PASS"
      : "FAIL"
  );
  record(
    "resolve-rejects-string",
    resolveCommittedTrustAnchorMs({ locationUpdatedAt: "1700000000000" }) == null
      ? "PASS"
      : "FAIL"
  );
}

{
  const now = 5_000_000;
  const ok = validateTrustedFixRecency(now, now);
  const old = validateTrustedFixRecency(now - SESSION_FIRST_FIX_MAX_AGE_MS - 1, now);
  const future = validateTrustedFixRecency(now + SESSION_FIRST_FIX_MAX_FUTURE_MS + 1, now);
  record("trusted-recency-accepts-near-anchor", ok.ok ? "PASS" : "FAIL");
  record(
    "trusted-recency-rejects-too-old",
    !old.ok && old.reason === LOCATION_DIAG.OUT_OF_ORDER ? "PASS" : "FAIL",
    old.reason
  );
  record(
    "trusted-recency-rejects-far-future",
    !future.ok && future.reason === LOCATION_DIAG.OUT_OF_ORDER ? "PASS" : "FAIL",
    future.reason
  );
}

{
  const now = 5_000_000;
  record(
    "anchor-bounds-rejects-far-future-anchor",
    !validateTrustAnchorBounds(now + SESSION_FIRST_FIX_MAX_FUTURE_MS + 1, now).ok
      ? "PASS"
      : "FAIL"
  );
  record("anchor-bounds-accepts-current", validateTrustAnchorBounds(now, now).ok ? "PASS" : "FAIL");
}

{
  const next = { lat: 24.86, lng: 67.0, observedAt: 5_000_000, sequence: 1, sessionId: "trk_a" };
  const viaAnchor = resolveFirstRideFixFreshness(next, {
    hasCommittedTrustAnchor: true,
    trustAnchorMs: 5_000_000,
    serverNowMs: 5_000_000,
    vehicleSessionStartedMs: 1,
  });
  const viaSession = resolveFirstRideFixFreshness(next, {
    hasCommittedTrustAnchor: false,
    vehicleSessionStartedMs: 5_000_000,
  });
  record("first-fix-prefers-committed-anchor", viaAnchor.ok ? "PASS" : "FAIL");
  record("first-fix-falls-back-to-session-start", viaSession.ok ? "PASS" : "FAIL");
}

{
  const next = {
    lat: 24.86,
    lng: 67.0,
    observedAt: 5_000_000,
    sequence: 1,
    sessionId: "trk_port1",
  };
  const accepted = evaluateFixAgainstPrevious(null, next, {
    enforceSessionConsistency: true,
    vehicleSessionId: "trk_port1",
    hasCommittedTrustAnchor: true,
    trustAnchorMs: 5_000_000,
    serverNowMs: 5_000_000,
  });
  const rejected = evaluateFixAgainstPrevious(null, next, {
    enforceSessionConsistency: true,
    vehicleSessionId: "trk_port1",
    hasCommittedTrustAnchor: true,
    trustAnchorMs: 5_000_000 - SESSION_FIRST_FIX_MAX_AGE_MS - 5_000,
    serverNowMs: 5_000_000,
  });
  record(
    "evaluate-first-fix-uses-trust-anchor-accept",
    accepted.accept ? "PASS" : "FAIL",
    accepted.reason
  );
  record(
    "evaluate-first-fix-uses-trust-anchor-reject",
    !rejected.accept ? "PASS" : "FAIL",
    rejected.reason
  );
}

record(
  "driver-location-imports-resolveCommittedTrustAnchorMs",
  driverLoc.includes("resolveCommittedTrustAnchorMs") ? "PASS" : "FAIL"
);
record(
  "driver-location-passes-trust-anchor-ctx",
  driverLoc.includes("hasCommittedTrustAnchor") &&
    driverLoc.includes("trustAnchorMs: committedTrustAnchorMs") &&
    driverLoc.includes("trackingSessionStartedAt")
    ? "PASS"
    : "FAIL"
);
record(
  "driver-location-no-typo-StartedMs-field",
  !driverLoc.includes("trackingSessionStartedMs") ? "PASS" : "FAIL"
);

const fail = results.filter((r) => r.status === "FAIL").length;
const pass = results.filter((r) => r.status === "PASS").length;
console.log(`\nStage 8 trust-anchor port: ${pass} PASS / ${fail} FAIL`);
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      stage: 8,
      tranche: 1,
      scope: "trust-anchor-port",
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
