/**
 * Stage 7 — server sequence strictness + cadence policy documentation (A8).
 *
 * Run: node tests/stage7-sequence-strictness.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  P2P_SEND_INTERVAL_MS,
  P2P_MIN_LOC_GAP_MS,
} from "../driver-app/js/p2p-protocol.mjs";
import * as custProtocol from "../customer-app/js/p2p-protocol.mjs";

const require = createRequire(import.meta.url);
const bg = require("../functions/background-location-upload.js");
const {
  parseRequiredSequence,
  mintBackgroundLocationCredential,
  ingestBackgroundDriverLocation,
} = bg;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests/stage7-sequence-strictness-results.json");

const SECRET = "stage7-sequence-secret";
const DRIVER_UID = "drv_stage7_seq";
const CUSTOMER_UID = "cust_stage7_seq";
const RIDE_ID = "ride_stage7_seq";
const VEHICLE = "veh_stage7_seq";
const TRACKING = "trk_stage7_seq01";
const AST = "ast_stage7_seq";
const NOW = 7_000_000;

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

function createIngestMockDb(ride, vehicle) {
  let vehicleDoc = { ...vehicle };
  return {
    collection(name) {
      return {
        doc(id) {
          return { _collection: name, _id: id };
        },
      };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          if (ref._collection === "rides") {
            return { exists: true, data: () => ride };
          }
          if (ref._collection === "vehicles") {
            return { exists: true, data: () => vehicleDoc };
          }
          return { exists: false };
        },
        update(ref, patch) {
          if (ref._collection === "vehicles") {
            vehicleDoc = {
              ...vehicleDoc,
              ...patch,
              location: patch.location || vehicleDoc.location,
            };
          }
        },
      };
      return fn(tx);
    },
  };
}

// ---------------------------------------------------------------------------
// A. parseRequiredSequence unit cases
// ---------------------------------------------------------------------------

{
  console.log("\n=== Stage 7 — sequence parse + ingest strictness ===\n");

  const rejectCases = [
    ["missing", undefined],
    ["null", null],
    ["empty-string", ""],
    ["zero", 0],
    ["negative", -5],
    ["nan", Number.NaN],
    ["non-number-string", "nope"],
    ["float", 1.5],
  ];
  for (const [label, raw] of rejectCases) {
    record(
      `parse-rejects-${label}`,
      parseRequiredSequence(raw) == null ? "PASS" : "FAIL",
      `raw=${String(raw)}`
    );
  }

  record("parse-accepts-1", parseRequiredSequence(1) === 1 ? "PASS" : "FAIL");
  record("parse-accepts-string-7", parseRequiredSequence("7") === 7 ? "PASS" : "FAIL");
  record("parse-accepts-42", parseRequiredSequence(42) === 42 ? "PASS" : "FAIL");
}

// ---------------------------------------------------------------------------
// A. ingest rejects invalid sequences (no coerce-to-1)
// ---------------------------------------------------------------------------

{
  const ride = {
    driverId: DRIVER_UID,
    userId: CUSTOMER_UID,
    vehicleId: VEHICLE,
    status: "in_progress",
    assignmentSessionToken: AST,
  };
  const token = mintBackgroundLocationCredential({
    driverUid: DRIVER_UID,
    rideId: RIDE_ID,
    vehicleId: VEHICLE,
    trackingSessionId: TRACKING,
    assignmentSessionToken: AST,
    secret: SECRET,
    nowMs: NOW,
  }).token;
  const baseFix = { lat: 24.86, lng: 67.0, observedAt: NOW };

  const cases = [
    ["missing", {}],
    ["zero", { sequence: 0 }],
    ["negative", { sequence: -5 }],
    ["nan-string", { sequence: "nope" }],
  ];

  for (const [label, seqPatch] of cases) {
    const res = await ingestBackgroundDriverLocation(createIngestMockDb(ride, { location: null }), {
      token,
      secret: SECRET,
      nowMs: NOW,
      fix: { ...baseFix, ...seqPatch },
    });
    record(
      `ingest-rejects-${label}`,
      res.accepted === false && res.reason === "INVALID_SEQUENCE" ? "PASS" : "FAIL",
      `accepted=${res.accepted} reason=${res.reason || ""}`
    );
  }

  const ok = await ingestBackgroundDriverLocation(createIngestMockDb(ride, { location: null }), {
    token,
    secret: SECRET,
    nowMs: NOW,
    fix: { ...baseFix, sequence: 3 },
  });
  record(
    "ingest-accepts-valid-sequence-3",
    ok.accepted === true && ok.sequence === 3 ? "PASS" : "FAIL",
    `accepted=${ok.accepted} sequence=${ok.sequence} reason=${ok.reason || ""}`
  );
}

// ---------------------------------------------------------------------------
// A. static: no Math.max coercion in ingest
// ---------------------------------------------------------------------------

{
  const src = fs.readFileSync(
    path.join(ROOT, "functions/background-location-upload.js"),
    "utf8"
  );
  const ingestBlock = src.slice(
    src.indexOf("async function ingestBackgroundDriverLocation"),
    src.indexOf("module.exports")
  );
  record(
    "ingest-no-math-max-sequence-coercion",
    !ingestBlock.includes("Math.max(1, Math.floor(Number(input.fix?.sequence)")
      ? "PASS"
      : "FAIL"
  );
  record(
    "ingest-uses-parseRequiredSequence",
    ingestBlock.includes("parseRequiredSequence(input.fix?.sequence)") ? "PASS" : "FAIL"
  );
}

// ---------------------------------------------------------------------------
// B. cadence documentation decision (keep 1500ms intentional)
// ---------------------------------------------------------------------------

{
  console.log("\n=== Stage 7 — cadence documentation ===\n");

  record(
    "p2p-send-interval-remains-3000",
    P2P_SEND_INTERVAL_MS === 3_000 ? "PASS" : "FAIL",
    `P2P_SEND_INTERVAL_MS=${P2P_SEND_INTERVAL_MS}`
  );
  record(
    "min-loc-gap-intentional-1500",
    P2P_MIN_LOC_GAP_MS === 1_500 ? "PASS" : "FAIL",
    `P2P_MIN_LOC_GAP_MS=${P2P_MIN_LOC_GAP_MS}`
  );
  record(
    "driver-customer-min-gap-parity",
    custProtocol.P2P_MIN_LOC_GAP_MS === P2P_MIN_LOC_GAP_MS ? "PASS" : "FAIL"
  );

  const drvProto = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-protocol.mjs"), "utf8");
  const drvSession = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8");
  record(
    "protocol-documents-min-gap-intent",
    drvProto.includes("P2P_MIN_LOC_GAP_MS") &&
      drvProto.includes("smoother marker motion")
      ? "PASS"
      : "FAIL"
  );
  record(
    "flush-uses-named-min-gap",
    drvSession.includes("minGapMs = P2P_MIN_LOC_GAP_MS") ? "PASS" : "FAIL"
  );
  record(
    "no-production-cadence-tightening",
    P2P_MIN_LOC_GAP_MS < P2P_SEND_INTERVAL_MS ? "PASS" : "FAIL",
    "kept intentional half-interval; did not force strict 3000ms"
  );
}

const failCount = results.filter((r) => r.status === "FAIL").length;
const passCount = results.filter((r) => r.status === "PASS").length;

console.log(`\nStage 7 sequence strictness: ${passCount} PASS / ${failCount} FAIL`);

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      stage: 7,
      scope: "sequence-strictness-and-cadence-docs",
      finding: "A8",
      generatedAt: new Date().toISOString(),
      cadenceDecision: {
        keepHalfInterval: true,
        P2P_SEND_INTERVAL_MS,
        P2P_MIN_LOC_GAP_MS,
        rationale:
          "1500ms min gap is intentional for smoother marker motion; documented as P2P_MIN_LOC_GAP_MS",
      },
      summary: { pass: passCount, fail: failCount },
      results,
    },
    null,
    2
  )
);
console.log(`Wrote ${OUT}\n`);

if (failCount > 0) process.exit(1);
