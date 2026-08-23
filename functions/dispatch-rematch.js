"use strict";

const { STALE_LOCATION_MS } = require("./matching");

function timestampToMs(value) {
  if (value == null) return 0;
  if (typeof value.toMillis === "function") return Number(value.toMillis()) || 0;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : 0;
}

function hasValidLocation(vehicle) {
  return (
    Number.isFinite(Number(vehicle?.location?.lat)) &&
    Number.isFinite(Number(vehicle?.location?.lng))
  );
}

/**
 * Decides if a vehicle update can make the driver newly matchable.
 * A fresh GPS timestamp in the same geoCell is significant when the prior
 * location was stale; without it, dispatch waits for the client fallback.
 */
function evaluateVehicleRematchTrigger(before, after, nowMs = Date.now()) {
  const hasLocation = hasValidLocation(after);
  const becameOnline = before?.status !== "online" && after?.status === "online";
  const gotGeoCell = !before?.geoCell && Boolean(after?.geoCell);
  const geoCellChanged =
    Boolean(before?.geoCell) &&
    Boolean(after?.geoCell) &&
    before.geoCell !== after.geoCell;
  const gotValidLocation = !hasValidLocation(before) && hasLocation;
  const beforeUpdatedAtMs = timestampToMs(before?.locationUpdatedAt);
  const afterUpdatedAtMs = timestampToMs(after?.locationUpdatedAt);
  const refreshedStaleLocation =
    hasLocation &&
    (beforeUpdatedAtMs === 0 || nowMs - beforeUpdatedAtMs >= STALE_LOCATION_MS) &&
    afterUpdatedAtMs > 0 &&
    nowMs - afterUpdatedAtMs >= 0 &&
    nowMs - afterUpdatedAtMs < STALE_LOCATION_MS;

  const reason = becameOnline
    ? "became_online"
    : gotGeoCell
      ? "geo_cell_added"
      : geoCellChanged
        ? "geo_cell_changed"
        : gotValidLocation
          ? "location_added"
          : refreshedStaleLocation
            ? "stale_location_refreshed"
            : "";

  return {
    shouldRematch: Boolean(reason),
    reason,
    hasLocation,
    refreshedStaleLocation,
  };
}

module.exports = {
  timestampToMs,
  hasValidLocation,
  evaluateVehicleRematchTrigger,
};
