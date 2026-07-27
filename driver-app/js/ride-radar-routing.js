/**
 * OSRM route fetch for Ride Radar detail map.
 */

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

/**
 * @param {{ lat: number, lng: number }} pickup
 * @param {{ lat: number, lng: number }} dropoff
 * @returns {Promise<{ latlngs: [number, number][], distanceKm: number, durationMin: number } | null>}
 */
export async function fetchRideRoute(pickup, dropoff) {
  if (pickup.lat == null || dropoff.lat == null) return null;
  const url =
    `${OSRM_BASE}/${pickup.lng},${pickup.lat};${dropoff.lng},${dropoff.lat}` +
    "?overview=full&geometries=geojson";
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route?.geometry?.coordinates?.length) return null;
    const latlngs = route.geometry.coordinates.map(([lng, lat]) => /** @type {[number, number]} */ ([lat, lng]));
    return {
      latlngs,
      distanceKm: Number((route.distance / 1000).toFixed(1)),
      durationMin: Math.max(1, Math.round(route.duration / 60)),
    };
  } catch (err) {
    console.warn("[SwiftGo Radar] route", err);
    return null;
  }
}
