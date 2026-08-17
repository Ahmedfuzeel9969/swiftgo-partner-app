/**
 * Unit contract: an in-cell stale→fresh GPS update must trigger immediate rematch.
 * Run: node tests/dispatch-rematch-trigger.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { STALE_LOCATION_MS } = require("../functions/matching.js");
const { evaluateVehicleRematchTrigger } = require("../functions/dispatch-rematch.js");

const nowMs = 1_700_000_000_000;
const location = { lat: 24.86, lng: 67.001 };

const staleBefore = {
  status: "online",
  geoCell: "g_6905_18611",
  location,
  locationUpdatedAt: { toMillis: () => nowMs - STALE_LOCATION_MS - 1 },
};
const freshAfterSameCell = {
  ...staleBefore,
  locationUpdatedAt: { toMillis: () => nowMs - 100 },
};

const refreshed = evaluateVehicleRematchTrigger(staleBefore, freshAfterSameCell, nowMs);
assert.equal(refreshed.shouldRematch, true);
assert.equal(refreshed.reason, "stale_location_refreshed");

const alreadyFresh = evaluateVehicleRematchTrigger(freshAfterSameCell, freshAfterSameCell, nowMs);
assert.equal(alreadyFresh.shouldRematch, false);

const changedCell = evaluateVehicleRematchTrigger(
  freshAfterSameCell,
  { ...freshAfterSameCell, geoCell: "g_6906_18611" },
  nowMs
);
assert.equal(changedCell.shouldRematch, true);
assert.equal(changedCell.reason, "geo_cell_changed");

console.log("dispatch-rematch-trigger: PASS");
