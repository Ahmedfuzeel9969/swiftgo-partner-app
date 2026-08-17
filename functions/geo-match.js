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
  haversineKm,
} = require("./matching");
const {
  GEO_QUERY_CHUNK,
  MATCH_GRID_DEG,
  cellsCoveringDisk,
  hotspotsIntersectingDisk,
  chunkArray,
  gridCellId,
  nearestGoldenHotspot,
} = require("./geo-cells");

/** Cap geo cell fan-out per ring so large admin radius cannot spawn thousands of queries. */
const MAX_GEO_CELLS_PER_RING = 48;
const MAX_GEO_QUERY_BATCHES_PER_RING = 8;
/** Bound parallel Firestore `in` queries: reduce serial latency without a fan-out burst. */
const GEO_QUERY_CONCURRENCY = 4;

async function runWithConcurrency(items, maxConcurrency, work) {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, maxConcurrency), items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await work(items[index]);
      }
    }
  );
  await Promise.all(workers);
}

function toMillis(ts) {
  if (ts == null) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts === "number") return ts;
  if (ts instanceof Date) return ts.getTime();
  return null;
}

/**
 * Progressive geo load: expand rings until enough eligible candidates or max radius.
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
  const maxRadiusKm =
    opts.maxRadiusKm != null && Number.isFinite(Number(opts.maxRadiusKm))
      ? Number(opts.maxRadiusKm)
      : rings.length
        ? Math.max(...rings.map(Number).filter((v) => Number.isFinite(v)))
        : SEARCH_RINGS_KM[SEARCH_RINGS_KM.length - 1];

  const metrics = {
    queriedCells: [],
    queriedHotspots: [],
    queryCount: 0,
    vehicleDocsRead: 0,
    partnerDocsRead: 0,
    candidatesInspected: 0,
    ringExpandedToKm: 0,
    maxRadiusKm,
    pickupCell: gridCellId(pickup.lat, pickup.lng),
    pickupHotspot: nearestGoldenHotspot(pickup.lat, pickup.lng)?.id || null,
    usedFullFleetScan: false,
  };

  const queriedCells = new Set();
  const queriedHotspots = new Set();
  const vehicleByDriver = new Map();
  const partnersLoaded = new Set();

  function cellCenterKm(cellId) {
    const m = /^g_(-?\d+)_(-?\d+)$/.exec(String(cellId || ""));
    if (!m) return Infinity;
    const cellLat = (Number(m[1]) + 0.5) * MATCH_GRID_DEG;
    const cellLng = (Number(m[2]) + 0.5) * MATCH_GRID_DEG;
    return haversineKm(pickup, { lat: cellLat, lng: cellLng }) ?? Infinity;
  }

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

    let toQuery = pending;
    if (field === "geoCell" && pending.length > MAX_GEO_CELLS_PER_RING) {
      toQuery = pending
        .slice()
        .sort((a, b) => cellCenterKm(a) - cellCenterKm(b))
        .slice(0, MAX_GEO_CELLS_PER_RING);
      metrics.geoCellsCapped = true;
    }

    const groups = chunkArray(toQuery, GEO_QUERY_CHUNK).slice(0, MAX_GEO_QUERY_BATCHES_PER_RING);
    if (groups.length < chunkArray(toQuery, GEO_QUERY_CHUNK).length) {
      metrics.geoQueryBatchesCapped = true;
    }

    await runWithConcurrency(groups, GEO_QUERY_CONCURRENCY, async (group) => {
      if (!group.length) return;
      metrics.queryCount += 1;
      try {
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
      } catch (queryErr) {
        metrics.queryErrors = (metrics.queryErrors || 0) + 1;
        console.warn("[geo-match] vehicle query failed:", String(queryErr?.message || queryErr));
      }
    });
  }

  async function enrichPartners() {
    const pending = [];
    for (const d of vehicleByDriver.values()) {
      if (partnersLoaded.has(d.driverId)) continue;
      partnersLoaded.add(d.driverId);
      pending.push(
        db
          .collection("partners")
          .doc(d.driverId)
          .get()
          .then((partner) => {
            metrics.partnerDocsRead += 1;
            const p = partner.exists ? partner.data() || {} : {};
            d.accountStatus = p.accountStatus || "active";
            if (p.activeRideId) d.activeRideId = d.activeRideId || p.activeRideId;
          })
          .catch(() => {
            d.accountStatus = d.accountStatus || "active";
          })
      );
    }
    if (pending.length) await Promise.all(pending);
  }

  let selected = [];
  let drivers = [];

  for (const ringKm of rings) {
    metrics.ringExpandedToKm = ringKm;
    await Promise.all([
      fetchChunk("geoCell", cellsCoveringDisk(pickup.lat, pickup.lng, ringKm)),
      fetchChunk("hotspotId", hotspotsIntersectingDisk(pickup.lat, pickup.lng, ringKm)),
    ]);
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
