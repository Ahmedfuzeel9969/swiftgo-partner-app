/**
 * Phase 4F — geoCell coverage monitoring for online vehicles.
 * Matching remains geo-scoped (no full-fleet scan). Vehicles missing geoCell are simply unmatched.
 */

"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { gridCellId } = require("./geo-cells");

function isValidGeoCell(value) {
  return typeof value === "string" && value.trim().length >= 3;
}

/**
 * Scan online vehicles and report missing/invalid geoCell.
 * Bounded page size for emulator/ops; not used for matching.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ limit?: number }} [opts]
 */
async function reportGeoCellCoverage(db, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 400, 1), 1000);
  const snap = await db.collection("vehicles").where("status", "==", "online").limit(limit).get();

  const missing = [];
  let withGeoCell = 0;
  let withHotspot = 0;

  for (const doc of snap.docs) {
    const v = doc.data() || {};
    const hasCell = isValidGeoCell(v.geoCell) || isValidGeoCell(v.locationGridCell);
    if (hasCell) withGeoCell += 1;
    if (isValidGeoCell(v.hotspotId)) withHotspot += 1;
    if (!hasCell) {
      const lat = Number(v.location?.lat);
      const lng = Number(v.location?.lng);
      let suggested = null;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        try {
          suggested = gridCellId(lat, lng);
        } catch {
          suggested = null;
        }
      }
      missing.push({
        vehicleId: doc.id,
        driverId: v.driverId || null,
        hasLocation: Number.isFinite(lat) && Number.isFinite(lng),
        suggestedGeoCell: suggested,
      });
    }
  }

  const summary = {
    scannedOnline: snap.size,
    withGeoCell,
    withHotspot,
    missingGeoCell: missing.length,
    missingSample: missing.slice(0, 25),
    failSafeNote:
      "Vehicles without geoCell/hotspot are not discovered by geo-scoped matching; full-fleet scan remains disabled.",
    scannedAt: new Date().toISOString(),
  };

  await db.collection("ops_metrics").doc(`geocell_coverage_${Date.now()}`).set({
    metric: "geocell_coverage_snapshot",
    ...summary,
    missingSample: summary.missingSample,
    createdAt: FieldValue.serverTimestamp(),
  });

  return summary;
}

module.exports = {
  reportGeoCellCoverage,
  isValidGeoCell,
};
