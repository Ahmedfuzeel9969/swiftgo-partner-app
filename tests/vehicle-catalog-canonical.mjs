/**
 * Phase 1 — canonical vehicle catalog parity and resolution tests.
 * Run: node tests/vehicle-catalog-canonical.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail, generatedAt: new Date().toISOString() });
  console.log(`${status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "·"} ${name} — ${status}${detail ? `: ${detail}` : ""}`);
}

const esm = await import(pathToFileURL(join(root, "shared/js/vehicle-catalog.mjs")).href);
const cjs = require(join(root, "functions/vehicle-catalog.js"));
const pricingFare = require(join(root, "functions/pricing-fare.js"));
const { computeCancellationFare } = require(join(root, "functions/partial-fare.js"));

const sharedJson = readFileSync(join(root, "shared/vehicle-catalog.json"), "utf8");
const functionsJson = readFileSync(join(root, "functions/vehicle-catalog.data.json"), "utf8");
const sharedHash = createHash("sha256").update(sharedJson).digest("hex");
const functionsHash = createHash("sha256").update(functionsJson).digest("hex");

record(
  "P01-json-parity-shared-vs-functions",
  sharedHash === functionsHash ? "PASS" : "FAIL",
  sharedHash.slice(0, 16)
);

record(
  "P02-cjs-source-hash-stamped",
  cjs.__SOURCE_SHA256__ === sharedHash ? "PASS" : "FAIL",
  cjs.__SOURCE_SHA256__?.slice(0, 16)
);

record(
  "P03-esm-cjs-exportCatalogData-parity",
  JSON.stringify(esm.exportCatalogDataForParity()) === JSON.stringify(cjs.exportCatalogDataForParity())
    ? "PASS"
    : "FAIL"
);

for (const id of esm.CANONICAL_VEHICLE_IDS) {
  const e = esm.getDefaultVehicleRate(id);
  const c = cjs.getDefaultVehicleRate(id);
  const same =
    e.baseFare === c.baseFare &&
    e.perKmRate === c.perKmRate &&
    e.commissionPercent === c.commissionPercent;
  record(`P04-default-rate-${id}`, same ? "PASS" : "FAIL", `${e.baseFare}/${e.perKmRate}`);
}

const aliasCases = [
  ["mini", "go"],
  ["ac", "go-plus"],
  ["premium", "business"],
  ["rickshaw", "bike-cargo"],
  ["van", "suzuki"],
  ["cargo", "truck"],
];

for (const [legacy, canonical] of aliasCases) {
  const r = esm.resolveVehicleTypeKeyForRead(legacy);
  record(
    `P05-alias-${legacy}-to-${canonical}`,
    r.ok && r.canonicalId === canonical && r.source === "legacy_alias" ? "PASS" : "FAIL",
    JSON.stringify(r)
  );
}

const unknown = esm.resolveVehicleTypeKeyForRead("not-a-real-vehicle-type");
record(
  "P06-unknown-never-maps-to-go",
  !unknown.ok && unknown.code === "UNKNOWN_VEHICLE_TYPE" ? "PASS" : "FAIL",
  JSON.stringify(unknown)
);

let threwUnknown = false;
try {
  pricingFare.resolveVehicleRates({}, { vehicleTypeKey: "totally-unknown-type" });
} catch (err) {
  threwUnknown = err.code === "UNKNOWN_VEHICLE_TYPE";
}
record("P07-pricing-fare-unknown-throws", threwUnknown ? "PASS" : "FAIL");

let threwLegacyWrite = false;
try {
  esm.assertCanonicalVehicleTypeKeyForWrite("mini");
} catch (err) {
  threwLegacyWrite = err.code === "NON_CANONICAL_VEHICLE_TYPE";
}
record("P08-write-rejects-legacy-alias", threwLegacyWrite ? "PASS" : "FAIL");

record(
  "P09-write-accepts-canonical-go",
  esm.assertCanonicalVehicleTypeKeyForWrite("go") === "go" ? "PASS" : "FAIL"
);

const legacyRide = { vehicleTypeKey: "mini", distanceKm: 10, timeMins: 20, farePkr: 500 };
const legacyRates = pricingFare.resolveVehicleRates({}, legacyRide);
record(
  "P10-legacy-mini-partial-rate-uses-go-defaults",
  legacyRates.baseFare === 100 && legacyRates.perKmRate === 35 ? "PASS" : "FAIL",
  `${legacyRates.baseFare}/${legacyRates.perKmRate}`
);

const partial = computeCancellationFare({}, { ...legacyRide, status: "in_progress" }, 5);
record(
  "P11-partial-cancel-legacy-mini-fare",
  partial.baseFare === 100 && partial.perKmRate === 35 && partial.cancellationFare === 275
    ? "PASS"
    : "FAIL",
  JSON.stringify(partial)
);

const canonicalRide = { vehicleTypeKey: "go", distanceKm: 8, timeMins: 16, farePkr: 380 };
const canonicalRates = pricingFare.resolveVehicleRates({}, canonicalRide);
record(
  "P12-canonical-go-unchanged",
  canonicalRates.baseFare === 100 && canonicalRates.perKmRate === 35 ? "PASS" : "FAIL"
);

record(
  "P13-commission-unchanged-default-10",
  esm.CANONICAL_VEHICLE_IDS.every((id) => esm.getDefaultVehicleRate(id).commissionPercent === 10)
    ? "PASS"
    : "FAIL"
);

const failCount = results.filter((r) => r.status === "FAIL").length;
const outPath = join(root, "tests/vehicle-catalog-canonical-results.json");
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      pass: results.filter((r) => r.status === "PASS").length,
      fail: failCount,
      blocked: 0,
      results,
    },
    null,
    2
  )
);

console.log(`\nSummary: pass=${results.length - failCount} fail=${failCount}`);
process.exit(failCount ? 1 : 0);
