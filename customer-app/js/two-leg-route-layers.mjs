/**
 * Phase 4 — canonical map owner for approach / trip / fallback route layers.
 * One owner only; never logs coordinates.
 */

import { getMap } from "./map.js";
import { LEG_STATUS, ROUTE_EMPHASIS } from "./two-leg-route-controller.mjs";

const STYLE = {
  approachProminent: {
    color: "#0b7a4b",
    weight: 5,
    opacity: 0.95,
    lineCap: "round",
    lineJoin: "round",
  },
  approachSubdued: {
    color: "#64748b",
    weight: 3,
    opacity: 0.35,
    lineCap: "round",
    lineJoin: "round",
  },
  tripProminent: {
    color: "#1d4ed8",
    weight: 5,
    opacity: 0.9,
    lineCap: "round",
    lineJoin: "round",
  },
  tripSecondary: {
    color: "#93c5fd",
    weight: 4,
    opacity: 0.55,
    lineCap: "round",
    lineJoin: "round",
    dashArray: "1 0",
  },
  fallback: {
    color: "#0b7a4b",
    weight: 3,
    opacity: 0.7,
    dashArray: "8 10",
    lineCap: "round",
    lineJoin: "round",
    className: "road-route-fallback-line",
  },
};

const FIT_PADDING = { paddingTopLeft: [48, 110], paddingBottomRight: [48, 300] };

/**
 * @param {{
 *   onDiag?: (code: string) => void,
 *   getUserInteracted?: () => boolean,
 * }} [opts]
 */
export function createTwoLegRouteLayers(opts = {}) {
  const diag = opts.onDiag || (() => {});
  let approachLayer = null;
  let tripLayer = null;
  let fallbackLayer = null;
  let attributionEl = null;
  let lastGeneration = -1;
  let userPanZoom = false;
  let mapListenersBound = false;

  function remove(layer) {
    const map = getMap();
    if (layer && map) {
      try {
        map.removeLayer(layer);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function clearAll() {
    approachLayer = remove(approachLayer);
    tripLayer = remove(tripLayer);
    fallbackLayer = remove(fallbackLayer);
    if (attributionEl?.parentNode) {
      attributionEl.parentNode.removeChild(attributionEl);
    }
    attributionEl = null;
    diag("route_layers_cleared");
  }

  function bindMapInteraction() {
    if (mapListenersBound) return;
    const map = getMap();
    if (!map?.on) return;
    mapListenersBound = true;
    map.on("dragstart zoomstart", () => {
      userPanZoom = true;
    });
  }

  function toLatLngs(geometry) {
    if (!Array.isArray(geometry) || geometry.length < 2) return null;
    return geometry.map((p) => [p.lat, p.lng]);
  }

  function setPolyline(existing, latlngs, style) {
    const map = getMap();
    if (!map || typeof L === "undefined") return existing;
    if (!latlngs) return remove(existing);
    if (existing) {
      existing.setLatLngs(latlngs);
      existing.setStyle(style);
      return existing;
    }
    return L.polyline(latlngs, { ...style, interactive: false }).addTo(map);
  }

  function renderAttribution(text) {
    const safe = String(text || "")
      .replace(/<[^>]*>/g, "")
      .slice(0, 120);
    const host = document.getElementById("activeRideDriverTrack") || document.body;
    if (!safe) {
      if (attributionEl?.parentNode) attributionEl.parentNode.removeChild(attributionEl);
      attributionEl = null;
      return;
    }
    if (!attributionEl) {
      attributionEl = document.createElement("div");
      attributionEl.className = "road-route-attribution";
      attributionEl.setAttribute("aria-hidden", "true");
      host.appendChild(attributionEl);
    }
    attributionEl.textContent = safe;
  }

  function renderFallbackBanner(show) {
    let el = document.getElementById("roadRouteFallbackBanner");
    if (!show) {
      if (el) el.hidden = true;
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "roadRouteFallbackBanner";
      el.className = "road-route-fallback-banner";
      el.setAttribute("role", "status");
      const track = document.getElementById("activeRideDriverTrack");
      (track || document.body).appendChild(el);
    }
    el.hidden = false;
    el.textContent =
      "سڑک کا راستہ دستیاب نہیں، اندازاً سیدھا رخ دکھایا جا رہا ہے";
  }

  /**
   * @param {object} model — from two-leg controller
   * @param {{ fit?: boolean }} [opts]
   */
  function render(model, renderOpts = {}) {
    bindMapInteraction();
    if (!model || model.emphasis === ROUTE_EMPHASIS.NONE) {
      clearAll();
      renderFallbackBanner(false);
      lastGeneration = model?.rideGeneration ?? -1;
      return;
    }

    if (model.rideGeneration !== lastGeneration) {
      // New ride generation — drop old layers before drawing.
      clearAll();
      userPanZoom = false;
      lastGeneration = model.rideGeneration;
    }

    const emphasis = model.emphasis;
    const approach = model.approach;
    const trip = model.trip;

    const approachReady =
      approach &&
      (approach.status === LEG_STATUS.READY || approach.status === LEG_STATUS.FALLBACK) &&
      approach.status !== LEG_STATUS.CLEARED;
    const tripReady =
      trip && (trip.status === LEG_STATUS.READY || trip.status === LEG_STATUS.FALLBACK);

    // Approach layer (hide when cleared / in_progress emphasis).
    if (emphasis === ROUTE_EMPHASIS.APPROACH && approachReady && !approach.fallback) {
      approachLayer = setPolyline(
        approachLayer,
        toLatLngs(approach.renderGeometry || approach.geometry),
        STYLE.approachProminent
      );
    } else if (emphasis === ROUTE_EMPHASIS.TRIP && approachReady && !approach.fallback) {
      approachLayer = setPolyline(
        approachLayer,
        toLatLngs(approach.renderGeometry || approach.geometry),
        STYLE.approachSubdued
      );
    } else {
      approachLayer = remove(approachLayer);
    }

    // Trip layer
    if (tripReady && !trip.fallback) {
      tripLayer = setPolyline(
        tripLayer,
        toLatLngs(trip.renderGeometry || trip.geometry),
        emphasis === ROUTE_EMPHASIS.TRIP ? STYLE.tripProminent : STYLE.tripSecondary
      );
    } else {
      tripLayer = remove(tripLayer);
    }

    // Fallback dashed (separate layer) when active leg is fallback.
    const activeFallback =
      (emphasis === ROUTE_EMPHASIS.APPROACH && approach?.fallback) ||
      (emphasis === ROUTE_EMPHASIS.TRIP && trip?.fallback);
    if (activeFallback) {
      const leg = emphasis === ROUTE_EMPHASIS.TRIP ? trip : approach;
      fallbackLayer = setPolyline(
        fallbackLayer,
        toLatLngs(leg.renderGeometry || leg.geometry),
        STYLE.fallback
      );
      renderFallbackBanner(true);
    } else {
      fallbackLayer = remove(fallbackLayer);
      renderFallbackBanner(false);
    }

    const attr =
      (emphasis === ROUTE_EMPHASIS.TRIP ? trip?.attribution : approach?.attribution) ||
      trip?.attribution ||
      approach?.attribution ||
      "";
    renderAttribution(attr);

    const shouldFit =
      renderOpts.fit === true ||
      (!model.fittedOnceForRide && !userPanZoom && (approachReady || tripReady));
    if (shouldFit) {
      fitOnce(model);
    }
  }

  function fitOnce(model) {
    const map = getMap();
    if (!map || typeof L === "undefined") return;
    if (opts.getUserInteracted?.() || userPanZoom) return;
    const pts = [];
    const push = (leg) => {
      const g = leg?.renderGeometry || leg?.geometry;
      if (Array.isArray(g)) g.forEach((p) => pts.push([p.lat, p.lng]));
    };
    if (model.emphasis === ROUTE_EMPHASIS.TRIP) push(model.trip);
    else {
      push(model.approach);
      push(model.trip);
    }
    if (pts.length < 2) return;
    try {
      map.fitBounds(L.latLngBounds(pts), { ...FIT_PADDING, maxZoom: 16, animate: true });
    } catch {
      /* ignore */
    }
  }

  function destroy() {
    clearAll();
    renderFallbackBanner(false);
  }

  return {
    render,
    clear: clearAll,
    destroy,
    markUserInteracted: () => {
      userPanZoom = true;
    },
    resetUserInteracted: () => {
      userPanZoom = false;
    },
  };
}
