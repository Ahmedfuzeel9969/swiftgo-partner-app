import { LOCATION_MAX_AGE_MS } from "../../shared/js/ride-location-contract.mjs";

/** Separate, expiring passenger dot. Never mutates the booked pickup or route. */
export function createCustomerLocationMarker(opts = {}) {
  const nowMs = opts.nowMs || Date.now;
  const setT = opts.setTimeoutFn || setTimeout, clearT = opts.clearTimeoutFn || clearTimeout;
  let marker = null, markerMap = null, latest = null, timer = null;
  function clear() {
    if (timer != null) clearT(timer);
    timer = null;
    marker?.remove?.(); marker = markerMap = latest = null;
  }
  function draw() {
    if (!latest) return;
    if (nowMs() - latest.observedAt >= LOCATION_MAX_AGE_MS) { clear(); return; }
    const map = opts.getMap?.(), leaflet = opts.getLeaflet?.() || globalThis.L;
    if (!map || !leaflet) return;
    if (markerMap !== map) { marker?.remove?.(); marker = null; }
    if (!marker) {
      marker = leaflet.circleMarker([latest.lat, latest.lng], {
        radius: 9, color: "#ffffff", weight: 3, fillColor: "#2563eb", fillOpacity: 1,
      }).addTo(map);
      marker.bindTooltip?.("کسٹمر کی موجودہ جگہ — طے شدہ پک اپ الگ ہے");
      markerMap = map;
    } else marker.setLatLng([latest.lat, latest.lng]);
  }
  return {
    clear, draw,
    update(fix) {
      if (!fix) { clear(); return; }
      latest = fix;
      if (timer != null) clearT(timer);
      timer = setT(clear, Math.max(1, LOCATION_MAX_AGE_MS - (nowMs() - fix.observedAt)));
      draw();
    },
  };
}
