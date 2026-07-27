/**
 * Phase 3B — geo-scoped driver loading for matching.
 * Queries only grid/hotspot cells intersecting progressive rings (1→2→3 km).
 * Never scans the full online fleet.
 */

"use strict";

const {
  SEARCH_RINGS_KM,
  selectCandidatesProgressive,
  STALE_LOCATION_MS,
} = require("./matching");
const {
  GEO_QUERY_CHUNK,
  cellsCoveringDisk,
  hotspotsIntersectingDisk,
  chunkArray,
  gridCellId,
  nearestGoldenHotspot,
} = require("./geo-cells");

function toMillis(ts) {
  if (ts == null) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts === "number") return ts;
  if (ts instanceof Date) return ts.getTime();
  return null;
}

/**
 * Progressive geo load: expand rings until enough eligible candidates or 3 km.
 *
 * @returns {Promise<{
 *   drivers: object[],
 *   selected: object[],
 *   metrics: object
 * }>}
 */
async function loadAndSelectGeoCandidates(db, pickup, limit, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const staleMs = opts.staleMs != null ? opts.staleMs : STALE_LOCATION_MS;
  const rings = opts.ringsKm || SEARCH_RINGS_KM;

  const metrics = {
    queriedCells: [],
    queriedHotspots: [],
    queryCount: 0,
    vehicleDocsRead: 0,
    partnerDocsRead: 0,
    candidatesInspected: 0,
    ringExpandedToKm: 0,
    pickupCell: gridCellId(pickup.lat, pickup.lng),
    pickupHotspot: nearestGoldenHotspot(pickup.lat, pickup.lng)?.id || null,
    usedFullFleetScan: false,
  };

  const queriedCells = new Set();
  const queriedHotspots = new Set();
  const vehicleByDriver = new Map();
  const partnersLoaded = new Set();

  async function fetchChunk(field, ids) {
    const pending = [];
    for (const id of ids) {
      if (!id) continue;
      if (field === "geoCell") {
        if (queriedCells.has(id)) continue;
        queriedCells.add(id);
        metrics.queriedCells.push(id);
        pending.push(id);
      } else {
        if (queriedHotspots.has(id)) continue;
        queriedHotspots.add(id);
        metrics.queriedHotspots.push(id);
        pending.push(id);
      }
    }

    for (const group of chunkArray(pending, GEO_QUERY_CHUNK)) {
      if (!group.length) continue;
      metrics.queryCount += 1;
      const snap = await db
        .collection("vehicles")
        .where("status", "==", "online")
        .where(field, "in", group)
        .get();
      metrics.vehicleDocsRead += snap.size;
      for (const doc of snap.docs) {
        const v = doc.data() || {};
        const driverId = v.driverId;
        if (!driverId || vehicleByDriver.has(driverId)) continue;
        vehicleByDriver.set(driverId, {
          vehicleId: doc.id,
          driverId,
          lat: Number(v.location?.lat),
          lng: Number(v.location?.lng),
          status: v.status,
          activeRideId: v.activeRideId || null,
          locationUpdatedAtMs: toMillis(v.locationUpdatedAt),
          geoCell: v.geoCell || null,
          hotspotId: v.hotspotId || null,
        });
      }
    }
  }

  async function enrichPartners() {
    for (const d of vehicleByDriver.values()) {
      if (partnersLoaded.has(d.driverId)) continue;
      partnersLoaded.add(d.driverId);
      metrics.partnerDocsRead += 1;
      const partner = await db.collection("partners").doc(d.driverId).get();
      const p = partner.exists ? partner.data() || {} : {};
      d.accountStatus = p.accountStatus || "active";
      if (p.activeRideId) d.activeRideId = d.activeRideId || p.activeRideId;
    }
  }

  let selected = [];
  let drivers = [];

  for (const ringKm of rings) {
    metrics.ringExpandedToKm = ringKm;
    await fetchChunk("geoCell", cellsCoveringDisk(pickup.lat, pickup.lng, ringKm));
    await fetchChunk("hotspotId", hotspotsIntersectingDisk(pickup.lat, pickup.lng, ringKm));
    await enrichPartners();

    drivers = [...vehicleByDriver.values()];
    metrics.candidatesInspected = drivers.length;
    selected = selectCandidatesProgressive(pickup, drivers, limit, {
      nowMs,
      staleMs,
      ringsKm: rings,
      requireFreshLocation: true,
    });

    const withinRing = selected.filter((c) => c.distanceKm <= ringKm);
    if (withinRing.length >= limit) {
      selected = withinRing.slice(0, limit);
      break;
    }
    if (selected.length >= limit) break;
  }

  return { drivers, selected, metrics };
}

module.exports = {
  loadAndSelectGeoCandidates,
};
