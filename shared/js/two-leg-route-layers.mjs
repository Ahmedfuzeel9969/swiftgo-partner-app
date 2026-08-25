/**
 * Phase 4 — canonical map owner for approach / trip / fallback route layers.
 * One owner only; never logs coordinates.
 */

import { LEG_STATUS, ROUTE_EMPHASIS } from "./two-leg-route-controller.mjs";
import {
  buildRouteMetrics,
  remainingGeometryFromProgress,
} from "./route-projection.mjs";
import { GEOMETRY_KIND } from "./geometry-quality.mjs";

/** Route A (driver→pickup): vivid green. Route B (pickup→destination): vivid blue. */
const STYLE = {
  approachProminent: {
    color: "#16a34a",
    weight: 6,
    opacity: 0.98,
    lineCap: "round",
    lineJoin: "round",
  },
  approachSubdued: {
    color: "#16a34a",
    weight: 4,
    opacity: 0.4,
    lineCap: "round",
    lineJoin: "round",
  },
  tripProminent: {
    color: "#2563eb",
    weight: 6,
    opacity: 0.98,
    lineCap: "round",
    lineJoin: "round",
  },
  /** Before Start Ride: trip stays clearly blue alongside green approach. */
  tripSecondary: {
    color: "#2563eb",
    weight: 5,
    opacity: 0.88,
    lineCap: "round",
    lineJoin: "round",
  },
  fallback: {
    color: "#16a34a",
    weight: 4,
    opacity: 0.75,
    dashArray: "8 10",
    lineCap: "round",
    lineJoin: "round",
    className: "road-route-fallback-line",
  },
};

const FIT_PADDING = { paddingTopLeft: [48, 110], paddingBottomRight: [48, 300] };

/** @param {object | null | undefined} leg */
export function legHasDrawableGeometry(leg) {
  if (!leg) return false;
  const geometry = leg.renderGeometry || leg.geometry;
  return Array.isArray(geometry) && geometry.length >= 2;
}

/** Approach leg has verified or fallback geometry ready to own the map line. */
export function isApproachLegDrawable(approach) {
  if (!approach) return false;
  if (approach.status === LEG_STATUS.CLEARED) return false;
  if (approach.status !== LEG_STATUS.READY && approach.status !== LEG_STATUS.FALLBACK) {
    return false;
  }
  return legHasDrawableGeometry(approach);
}

/**
 * Keep a direct fallback line anchored at the latest raw vehicle position.
 * The fallback is display-only: it must not snap or alter authoritative GPS.
 */
export function remainingFallbackGeometryFromFix(leg, fix) {
  const geometry = leg?.renderGeometry || leg?.geometry;
  if (
    (leg?.fallback !== true &&
      leg?.geometryKind !== GEOMETRY_KIND.DIRECT_ESTIMATE_FALLBACK) ||
    !Array.isArray(geometry) ||
    geometry.length < 2 ||
    !Number.isFinite(fix?.lat) ||
    !Number.isFinite(fix?.lng)
  ) {
    return null;
  }
  const destination = geometry[geometry.length - 1];
  if (!Number.isFinite(destination?.lat) || !Number.isFinite(destination?.lng)) {
    return null;
  }
  return [
    { lat: fix.lat, lng: fix.lng },
    { lat: destination.lat, lng: destination.lng },
  ];
}

/**
 * Suppress Phase-1 straight driver→pickup line only when two-leg approach geometry is drawable.
 * Trip-only fallback must not suppress the legacy approach line.
 */
export function shouldSuppressLegacyApproachLine(model) {
  if (!model || model.emphasis === ROUTE_EMPHASIS.NONE) return false;
  return isApproachLegDrawable(model.approach);
}

/**
 * @param {{
 *   getMap?: () => object|null,
 *   onDiag?: (code: string) => void,
 *   getUserInteracted?: () => boolean,
 * }} [opts]
 */
export function createTwoLegRouteLayers(opts = {}) {
  const getMap = typeof opts.getMap === "function" ? opts.getMap : () => null;
  const diag = opts.onDiag || (() => {});
  let approachLayer = null;
  let tripLayer = null;
  let fallbackLayer = null;
  let attributionEl = null;
  let lastGeneration = -1;
  let userPanZoom = false;
  let mapListenersBound = false;
  /** @type {object|null} */
  let lastModel = null;
  /** @type {ReturnType<typeof buildRouteMetrics>|null} */
  let approachMetrics = null;
  /** @type {ReturnType<typeof buildRouteMetrics>|null} */
  let tripMetrics = null;
  let lastProgressM = 0;
  let lastProgressLeg = "";
  let lastEmphasis = null;

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
    approachMetrics = null;
    tripMetrics = null;
    lastModel = null;
    lastProgressM = 0;
    lastProgressLeg = "";
    lastEmphasis = null;
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
    if (geometry.length === 1) return [[geometry[0].lat, geometry[0].lng]];
    return geometry.map((p) => [p.lat, p.lng]);
  }

  function setPolyline(existing, latlngs, style) {
    const map = getMap();
    if (!map || typeof L === "undefined") return existing;
    if (!latlngs || latlngs.length < 1) return remove(existing);
    if (latlngs.length === 1) {
      // Degenerate remaining route — hide line.
      return remove(existing);
    }
    if (existing) {
      existing.setLatLngs(latlngs);
      existing.setStyle(style);
      return existing;
    }
    return L.polyline(latlngs, { ...style, interactive: false }).addTo(map);
  }

  function metricsFor(leg) {
    const geo = leg?.renderGeometry || leg?.geometry;
    if (!Array.isArray(geo) || geo.length < 2) return null;
    try {
      return buildRouteMetrics(geo);
    } catch {
      return null;
    }
  }

  function visibleGeometry(leg, metrics, isActiveLeg) {
    const full = leg?.renderGeometry || leg?.geometry;
    if (!isActiveLeg || !metrics || !Number.isFinite(lastProgressM) || lastProgressM <= 0) {
      return full;
    }
    return remainingGeometryFromProgress(metrics, lastProgressM) || full;
  }

  function renderAttribution(text) {
    const safe = String(text || "")
      .replace(/<[^>]*>/g, "")
      .slice(0, 120);
    const host =
      document.getElementById("activeRideDriverTrack") ||
      document.getElementById("driverMap") ||
      document.getElementById("activeRideSheet") ||
      document.body;
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
      const track =
        document.getElementById("activeRideDriverTrack") ||
        document.getElementById("driverMap") ||
        document.getElementById("activeRideSheet");
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
      clearAll();
      userPanZoom = false;
      lastGeneration = model.rideGeneration;
    }

    lastModel = model;
    const emphasis = model.emphasis;
    if (emphasis !== lastEmphasis) {
      lastProgressM = 0;
      lastProgressLeg = "";
      lastEmphasis = emphasis;
    }
    const approach = model.approach;
    const trip = model.trip;

    const approachReady = isApproachLegDrawable(approach);
    const tripReady =
      trip &&
      (trip.status === LEG_STATUS.READY || trip.status === LEG_STATUS.FALLBACK) &&
      legHasDrawableGeometry(trip);
    const showTripFallbackSecondary =
      emphasis === ROUTE_EMPHASIS.APPROACH &&
      !approachReady &&
      tripReady &&
      trip.fallback === true;

    approachMetrics = approachReady && !approach.fallback ? metricsFor(approach) : null;
    tripMetrics = tripReady && !trip.fallback ? metricsFor(trip) : null;

    // Approach = GREEN (driver → pickup). Hide when cleared after Start Ride.
    if (emphasis === ROUTE_EMPHASIS.APPROACH && approachReady && !approach.fallback) {
      const geo = visibleGeometry(approach, approachMetrics, true);
      approachLayer = setPolyline(approachLayer, toLatLngs(geo), STYLE.approachProminent);
    } else if (emphasis === ROUTE_EMPHASIS.TRIP && approachReady && !approach.fallback) {
      approachLayer = setPolyline(
        approachLayer,
        toLatLngs(approach.renderGeometry || approach.geometry),
        STYLE.approachSubdued
      );
    } else {
      approachLayer = remove(approachLayer);
    }

    // Trip layer — verified road, or subdued cached pickup→dropoff while approach is pending.
    if (tripReady && !trip.fallback) {
      const activeTrip = emphasis === ROUTE_EMPHASIS.TRIP;
      const geo = visibleGeometry(trip, tripMetrics, activeTrip);
      tripLayer = setPolyline(
        tripLayer,
        toLatLngs(geo),
        activeTrip ? STYLE.tripProminent : STYLE.tripSecondary
      );
    } else if (showTripFallbackSecondary) {
      tripLayer = setPolyline(
        tripLayer,
        toLatLngs(trip.renderGeometry || trip.geometry),
        STYLE.tripSecondary
      );
    } else {
      tripLayer = remove(tripLayer);
    }

    // Fallback dashed (separate layer) when the active navigation leg is fallback.
    const activeFallback =
      (emphasis === ROUTE_EMPHASIS.APPROACH && approachReady && approach?.fallback) ||
      (emphasis === ROUTE_EMPHASIS.TRIP && tripReady && trip?.fallback);
    if (activeFallback) {
      const leg = emphasis === ROUTE_EMPHASIS.TRIP ? trip : approach;
      const m = emphasis === ROUTE_EMPHASIS.TRIP ? tripMetrics : approachMetrics;
      const geo = visibleGeometry(leg, m, true);
      fallbackLayer = setPolyline(fallbackLayer, toLatLngs(geo), STYLE.fallback);
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

  /**
   * Progressively shorten the active route as the vehicle moves (display only).
   * @param {number} progressM
   * @param {"approach"|"trip"|string} [activeLeg]
   */
  function setProgress(progressM, activeLeg = "") {
    if (!Number.isFinite(progressM)) return;
    lastProgressM = Math.max(0, progressM);
    if (activeLeg) lastProgressLeg = String(activeLeg);
    if (!lastModel) return;

    const emphasis = lastModel.emphasis;
    const trimLayer = (layer, metrics) => {
      if (!layer || !metrics) return layer;
      const rem = remainingGeometryFromProgress(metrics, lastProgressM);
      const ll = toLatLngs(rem);
      if (ll && ll.length >= 2) {
        layer.setLatLngs(ll);
        return layer;
      }
      return remove(layer);
    };

    if (emphasis === ROUTE_EMPHASIS.APPROACH) {
      approachLayer = trimLayer(approachLayer, approachMetrics);
      if (fallbackLayer && lastModel.approach) {
        const m = approachMetrics || metricsFor(lastModel.approach);
        fallbackLayer = trimLayer(fallbackLayer, m);
      }
      return;
    }
    if (emphasis === ROUTE_EMPHASIS.TRIP) {
      tripLayer = trimLayer(tripLayer, tripMetrics);
      if (fallbackLayer && lastModel.trip) {
        const m = tripMetrics || metricsFor(lastModel.trip);
        fallbackLayer = trimLayer(fallbackLayer, m);
      }
    }
  }

  /**
   * Raw GPS stays raw, but a dashed direct fallback must still lose the
   * already-travelled tail as the vehicle moves.
   */
  function setRawVehiclePosition(fix) {
    if (!lastModel || !fallbackLayer) return;
    const emphasis = lastModel.emphasis;
    const leg = emphasis === ROUTE_EMPHASIS.TRIP
      ? lastModel.trip
      : emphasis === ROUTE_EMPHASIS.APPROACH
        ? lastModel.approach
        : null;
    const remaining = remainingFallbackGeometryFromFix(leg, fix);
    const latlngs = toLatLngs(remaining);
    if (latlngs?.length >= 2) fallbackLayer.setLatLngs(latlngs);
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
    setProgress,
    setRawVehiclePosition,
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
