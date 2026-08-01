/**
 * Ride Radar detail map routing — uses shared provider-neutral OSRM preview adapter.
 * Preview/dev only; not traffic-aware; not a production SLA.
 */

import { createOsrmPreviewProvider } from "./road-route-provider.mjs";

const previewProvider = createOsrmPreviewProvider();

/**
 * @param {{ lat: number, lng: number }} pickup
 * @param {{ lat: number, lng: number }} dropoff
 * @returns {Promise<{ latlngs: [number, number][], distanceKm: number, durationMin: number } | null>}
 */
export async function fetchRideRoute(pickup, dropoff) {
  if (pickup?.lat == null || dropoff?.lat == null) return null;
  try {
    const route = await previewProvider.route({
      origin: { lat: Number(pickup.lat), lng: Number(pickup.lng) },
      destination: { lat: Number(dropoff.lat), lng: Number(dropoff.lng) },
      mode: "driving",
    });
    return {
      latlngs: route.renderGeometry.map((p) => /** @type {[number, number]} */ ([p.lat, p.lng])),
      distanceKm: Number((route.distanceMeters / 1000).toFixed(1)),
      durationMin: Math.max(1, Math.round(route.durationSeconds / 60)),
    };
  } catch (err) {
    console.warn("[SwiftGo Radar] route", err?.code || err?.message || "unavailable");
    return null;
  }
}
