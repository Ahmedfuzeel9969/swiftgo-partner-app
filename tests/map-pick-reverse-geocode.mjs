/**
 * Map-pick confirmation must reuse a matching reverse-geocode preview.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "customer-app/js/location.js"), "utf8");
const start = source.indexOf("function hasMatchingPickPreview");
const end = source.indexOf("\nfunction notifyMapPick", start);
if (start < 0 || end < 0) throw new Error("map-pick confirmation helper source bounds not found");

function createHarness() {
  const sandbox = {};
  const helpers = source.slice(start, end);
  vm.runInNewContext(
    `let pickPreviewLabel = "";\nlet pickCoords = null;\n${helpers}
     this.setPreview = (label, coords) => { pickPreviewLabel = label; pickCoords = coords; };
     this.confirm = resolveMapPickConfirmation;`,
    sandbox
  );
  return sandbox;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

const center = { lat: 24.8607, lng: 67.0011 };
const h = createHarness();
h.setPreview("Cached preview", { ...center });
let calls = 0;
const reused = await h.confirm(center, async () => {
  calls += 1;
  throw new Error("must not fetch");
});
record(
  "unchanged-center-reuses-preview-without-request",
  calls === 0 && reused.label === "Cached preview" && reused.lat === center.lat && reused.lng === center.lng,
  `requests=${calls}`
);

const changedCenter = { lat: 24.8617, lng: 67.0021 };
const refreshed = await h.confirm(changedCenter, async (lat, lng) => {
  calls += 1;
  return { lat, lng, label: "Fresh preview" };
});
record(
  "changed-center-performs-fresh-reverse-geocode",
  calls === 1 && refreshed.label === "Fresh preview" && refreshed.lat === changedCenter.lat && refreshed.lng === changedCenter.lng,
  `requests=${calls}`
);

const missing = createHarness();
const fallback = await missing.confirm(center, async () => {
  throw new Error("Nominatim unavailable");
});
record(
  "missing-or-failed-preview-uses-coordinate-fallback",
  fallback.label === "24.86070, 67.00110" && fallback.lat === center.lat && fallback.lng === center.lng,
  fallback.label
);

assert.equal(reused.lat, center.lat);
assert.equal(reused.lng, center.lng);
assert.equal(refreshed.lat, changedCenter.lat);
assert.equal(refreshed.lng, changedCenter.lng);
record("confirmed-pickup-dropoff-coordinates-remain-correct", true, "cached and fresh coordinates preserved");

if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
