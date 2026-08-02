/**
 * Phase 4 — two-leg road route controller (approach + trip).
 * Never requests a route on every GPS fix. In-memory only — no Firestore geometry writes.
 */

import {
  buildDirectFallback,
  haversineMeters,
  isValidLatLng,
  validateRouteResult,
} from "./route-geometry.mjs";
import { resolveRouteProvider } from "./road-route-provider.mjs";

export const ROUTE_DIAG = Object.freeze({
  APPROACH_REQUESTED: "route_approach_requested",
  APPROACH_READY: "route_approach_ready",
  TRIP_REQUESTED: "route_trip_requested",
  TRIP_READY: "route_trip_ready",
  REQUEST_COALESCED: "route_request_coalesced",
  REQUEST_ABORTED: "route_request_aborted",
  RESPONSE_STALE: "route_response_stale",
  RESPONSE_INVALID: "route_response_invalid",
  PROVIDER_UNAVAILABLE: "route_provider_unavailable",
  FALLBACK_DIRECT: "route_fallback_direct",
  LAYERS_CLEARED: "route_layers_cleared",
  GENERATION_IGNORED: "route_generation_ignored",
});

export const LEG_STATUS = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  FALLBACK: "fallback",
  ERROR: "error",
  CLEARED: "cleared",
});

export const ROUTE_EMPHASIS = Object.freeze({
  APPROACH: "approach",
  TRIP: "trip",
  NONE: "none",
});

/** Minimum time between approach refreshes. */
export const APPROACH_MIN_REFRESH_MS = 60_000;
/** Minimum driver displacement to refresh approach. */
export const APPROACH_MIN_DISPLACEMENT_M = 400;
/** Bounded retry backoff after provider failure. */
export const ROUTE_RETRY_BASE_MS = 5_000;
export const ROUTE_RETRY_MAX_MS = 60_000;
export const ROUTE_RETRY_MAX_ATTEMPTS = 4;

const TRACKABLE = new Set(["accepted", "arrived", "in_progress"]);
const TERMINAL = new Set([
  "completed",
  "cancelled",
  "cancelled_by_user",
  "cancelled_by_customer",
  "cancelled_by_system",
  "expired",
  "declined",
]);

function emptyLeg() {
  return {
    origin: null,
    destination: null,
    geometry: null,
    renderGeometry: null,
    distanceMeters: null,
    durationSeconds: null,
    provider: null,
    providerKind: null,
    geometryKind: null,
    snapEligible: false,
    status: LEG_STATUS.IDLE,
    generatedAt: null,
    fallback: false,
    attribution: "",
  };
}

/**
 * @param {{
 *   provider?: object,
 *   onModel?: (model: object) => void,
 *   onDiag?: (code: string) => void,
 *   nowMs?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   AbortControllerImpl?: typeof AbortController,
 * }} [opts]
 */
export function createTwoLegRouteController(opts = {}) {
  const nowMs = opts.nowMs || (() => Date.now());
  const setT = opts.setTimeoutFn || setTimeout;
  const clearT = opts.clearTimeoutFn || clearTimeout;
  const AbortImpl = opts.AbortControllerImpl || (typeof AbortController !== "undefined" ? AbortController : null);
  const diag = opts.onDiag || (() => {});
  const onModel = opts.onModel || (() => {});
  let provider = opts.provider || resolveRouteProvider();

  let generation = 0;
  let rideId = "";
  let rideStatus = "";
  let closed = false;
  let visible = true;
  let driverLoc = null;
  let pickup = null;
  let dropoff = null;
  let approach = emptyLeg();
  let trip = emptyLeg();
  let tripCachedForRide = "";
  let lastApproachOrigin = null;
  let lastApproachAt = 0;
  let approachInFlight = null;
  let tripInFlight = null;
  let approachAbort = null;
  let tripAbort = null;
  let retryTimer = 0;
  let retryAttempt = 0;
  let fittedOnceForRide = false;

  const counters = {
    requestsAttempted: 0,
    requestsCommitted: 0,
    requestsAborted: 0,
    requestsCoalesced: 0,
    invalidResponses: 0,
    fallbackActivations: 0,
    approachRefreshes: 0,
    tripRefreshes: 0,
    staleIgnored: 0,
    renderedPointCount: 0,
  };

  function emphasis() {
    if (!TRACKABLE.has(rideStatus)) return ROUTE_EMPHASIS.NONE;
    if (rideStatus === "in_progress") return ROUTE_EMPHASIS.TRIP;
    return ROUTE_EMPHASIS.APPROACH;
  }

  function snapshot() {
    const model = {
      rideGeneration: generation,
      rideId,
      rideStatus,
      emphasis: emphasis(),
      fittedOnceForRide,
      approach: { ...approach },
      trip: { ...trip },
      visible,
      counters: { ...counters },
    };
    const pts =
      (approach.renderGeometry?.length || 0) + (trip.renderGeometry?.length || 0);
    counters.renderedPointCount = pts;
    model.counters.renderedPointCount = pts;
    return model;
  }

  function emit() {
    onModel(snapshot());
  }

  function bumpGeneration(reason = "") {
    void reason;
    generation += 1;
    if (approachAbort) {
      try {
        approachAbort.abort();
      } catch {
        /* ignore */
      }
      approachAbort = null;
      counters.requestsAborted += 1;
      diag(ROUTE_DIAG.REQUEST_ABORTED);
    }
    if (tripAbort) {
      try {
        tripAbort.abort();
      } catch {
        /* ignore */
      }
      tripAbort = null;
      counters.requestsAborted += 1;
      diag(ROUTE_DIAG.REQUEST_ABORTED);
    }
    approachInFlight = null;
    tripInFlight = null;
    if (retryTimer) {
      clearT(retryTimer);
      retryTimer = 0;
    }
    return generation;
  }

  function applyFallback(legName, origin, destination) {
    const fb = buildDirectFallback(origin, destination);
    if (!fb) return;
    const validated = validateRouteResult(fb, { origin, destination, nowMs: nowMs() });
    if (!validated.ok) return;
    const leg = {
      origin,
      destination,
      geometry: validated.route.geometry,
      renderGeometry: validated.route.renderGeometry,
      distanceMeters: validated.route.distanceMeters,
      durationSeconds: validated.route.durationSeconds,
      provider: validated.route.provider,
      providerKind: validated.route.providerKind,
      geometryKind: validated.route.geometryKind,
      snapEligible: false, // direct estimate never snappable
      status: LEG_STATUS.FALLBACK,
      generatedAt: validated.route.generatedAt,
      fallback: true,
      attribution: "",
    };
    if (legName === "approach") approach = leg;
    else trip = leg;
    counters.fallbackActivations += 1;
    diag(ROUTE_DIAG.FALLBACK_DIRECT);
  }

  function scheduleRetry() {
    // Disabled / missing provider must not start a retry storm.
    if (!provider?.route || provider.id === "disabled") return;
    if (!visible || closed || retryAttempt >= ROUTE_RETRY_MAX_ATTEMPTS) return;
    if (retryTimer) return;
    const delay = Math.min(
      ROUTE_RETRY_MAX_MS,
      ROUTE_RETRY_BASE_MS * 2 ** retryAttempt + Math.round(Math.random() * 400)
    );
    retryAttempt += 1;
    retryTimer = setT(() => {
      retryTimer = 0;
      void ensureRoutes({ forceApproach: true });
    }, delay);
  }

  async function requestLeg(kind, origin, destination, gen) {
    if (!provider?.route) {
      diag(ROUTE_DIAG.PROVIDER_UNAVAILABLE);
      applyFallback(kind, origin, destination);
      emit();
      return;
    }
    if (kind === "approach" && approachInFlight) {
      counters.requestsCoalesced += 1;
      diag(ROUTE_DIAG.REQUEST_COALESCED);
      return approachInFlight;
    }
    if (kind === "trip" && tripInFlight) {
      counters.requestsCoalesced += 1;
      diag(ROUTE_DIAG.REQUEST_COALESCED);
      return tripInFlight;
    }

    const ctrl = AbortImpl ? new AbortImpl() : null;
    if (kind === "approach") approachAbort = ctrl;
    else tripAbort = ctrl;

    counters.requestsAttempted += 1;
    diag(kind === "approach" ? ROUTE_DIAG.APPROACH_REQUESTED : ROUTE_DIAG.TRIP_REQUESTED);
    if (kind === "approach") {
      approach = {
        ...approach,
        origin,
        destination,
        status: LEG_STATUS.LOADING,
      };
    } else {
      trip = {
        ...trip,
        origin,
        destination,
        status: LEG_STATUS.LOADING,
      };
    }
    emit();

    const promise = (async () => {
      try {
        const result = await provider.route({
          origin,
          destination,
          mode: "driving",
          alternatives: false,
          signal: ctrl?.signal,
          context: { leg: kind },
        });
        if (gen !== generation || closed) {
          counters.staleIgnored += 1;
          diag(ROUTE_DIAG.RESPONSE_STALE);
          return;
        }
        const validated = validateRouteResult(result, {
          origin,
          destination,
          nowMs: nowMs(),
        });
        if (!validated.ok) {
          counters.invalidResponses += 1;
          diag(ROUTE_DIAG.RESPONSE_INVALID);
          applyFallback(kind, origin, destination);
          scheduleRetry();
          emit();
          return;
        }
        // Fail closed: only snap-eligible verified/fixture road geometry becomes READY for snap.
        if (validated.route.snapEligible !== true) {
          counters.invalidResponses += 1;
          diag(ROUTE_DIAG.RESPONSE_INVALID);
          applyFallback(kind, origin, destination);
          scheduleRetry();
          emit();
          return;
        }
        const leg = {
          origin,
          destination,
          geometry: validated.route.geometry,
          renderGeometry: validated.route.renderGeometry,
          distanceMeters: validated.route.distanceMeters,
          durationSeconds: validated.route.durationSeconds,
          provider: validated.route.provider,
          providerKind: validated.route.providerKind,
          geometryKind: validated.route.geometryKind,
          snapEligible: validated.route.snapEligible === true,
          status: LEG_STATUS.READY,
          generatedAt: validated.route.generatedAt,
          fallback: false,
          attribution: validated.route.attribution,
        };
        counters.requestsCommitted += 1;
        retryAttempt = 0;
        if (kind === "approach") {
          approach = leg;
          lastApproachOrigin = { ...origin };
          lastApproachAt = nowMs();
          counters.approachRefreshes += 1;
          diag(ROUTE_DIAG.APPROACH_READY);
        } else {
          trip = leg;
          tripCachedForRide = rideId;
          counters.tripRefreshes += 1;
          diag(ROUTE_DIAG.TRIP_READY);
        }
        emit();
      } catch (err) {
        if (err?.code === "aborted" || err?.name === "AbortError") {
          counters.requestsAborted += 1;
          diag(ROUTE_DIAG.REQUEST_ABORTED);
          return;
        }
        if (gen !== generation || closed) {
          counters.staleIgnored += 1;
          diag(ROUTE_DIAG.RESPONSE_STALE);
          return;
        }
        diag(ROUTE_DIAG.PROVIDER_UNAVAILABLE);
        applyFallback(kind, origin, destination);
        scheduleRetry();
        emit();
      } finally {
        if (kind === "approach") approachInFlight = null;
        else tripInFlight = null;
      }
    })();

    if (kind === "approach") approachInFlight = promise;
    else tripInFlight = promise;
    return promise;
  }

  function shouldRefreshApproach(origin) {
    if (!lastApproachOrigin || approach.status === LEG_STATUS.IDLE) return true;
    if (approach.status === LEG_STATUS.FALLBACK || approach.status === LEG_STATUS.ERROR) {
      return nowMs() - lastApproachAt >= APPROACH_MIN_REFRESH_MS;
    }
    const elapsed = nowMs() - lastApproachAt;
    if (elapsed < APPROACH_MIN_REFRESH_MS) return false;
    const moved = haversineMeters(lastApproachOrigin, origin);
    if (!Number.isFinite(moved) || moved < APPROACH_MIN_DISPLACEMENT_M) return false;
    return true;
  }

  async function ensureRoutes({ forceApproach = false } = {}) {
    if (closed || !visible) return;
    if (!TRACKABLE.has(rideStatus)) return;
    if (!isValidLatLng(pickup?.lat, pickup?.lng) || !isValidLatLng(dropoff?.lat, dropoff?.lng)) {
      return;
    }
    const gen = generation;

    // Trip: once per ride (pickup → dropoff).
    if (tripCachedForRide !== rideId || trip.status === LEG_STATUS.IDLE) {
      await requestLeg("trip", pickup, dropoff, gen);
    }

    // Approach: driver → pickup (not during in_progress).
    if (rideStatus === "in_progress") {
      // Keep trip prominent; approach subdued/cleared visually by layers.
      if (approach.status === LEG_STATUS.READY) {
        approach = { ...approach, status: LEG_STATUS.CLEARED };
        emit();
      }
      return;
    }

    if (!isValidLatLng(driverLoc?.lat, driverLoc?.lng)) {
      return;
    }
    if (!forceApproach && !shouldRefreshApproach(driverLoc)) {
      return;
    }
    await requestLeg("approach", driverLoc, pickup, gen);
  }

  /**
   * Phase 5 — bounded off-route reroute using current raw origin.
   * Approach: origin → pickup. Trip: origin → dropoff.
   * Does not request per GPS fix; caller must gate with off-route policy.
   */
  async function rerouteFromOrigin(origin) {
    if (closed || !visible) return { ok: false, reason: "closed_or_hidden" };
    if (!TRACKABLE.has(rideStatus)) return { ok: false, reason: "not_trackable" };
    if (!isValidLatLng(origin?.lat, origin?.lng)) return { ok: false, reason: "invalid_origin" };
    if (!provider?.route) {
      diag(ROUTE_DIAG.PROVIDER_UNAVAILABLE);
      return { ok: false, reason: "provider_unavailable" };
    }
    // Abort in-flight so this request is not coalesced away.
    if (rideStatus === "in_progress") {
      if (tripAbort) {
        try {
          tripAbort.abort();
        } catch {
          /* ignore */
        }
        tripAbort = null;
      }
      tripInFlight = null;
      if (!isValidLatLng(dropoff?.lat, dropoff?.lng)) return { ok: false, reason: "no_dropoff" };
      const gen = bumpGeneration("reroute_trip");
      await requestLeg("trip", { lat: origin.lat, lng: origin.lng }, dropoff, gen);
      return { ok: true, leg: "trip", generation: gen };
    }
    if (approachAbort) {
      try {
        approachAbort.abort();
      } catch {
        /* ignore */
      }
      approachAbort = null;
    }
    approachInFlight = null;
    if (!isValidLatLng(pickup?.lat, pickup?.lng)) return { ok: false, reason: "no_pickup" };
    const gen = bumpGeneration("reroute_approach");
    lastApproachAt = 0;
    await requestLeg("approach", { lat: origin.lat, lng: origin.lng }, pickup, gen);
    return { ok: true, leg: "approach", generation: gen };
  }

  function syncRide(ride, { isVisible = true } = {}) {
    if (closed) return snapshot();
    visible = Boolean(isVisible);
    const nextId = String(ride?.id || "").trim();
    const status = String(ride?.status || "");
    const nextPickup = ride?.pickupLocation || null;
    const nextDropoff = ride?.dropoffLocation || null;

    if (!nextId || TERMINAL.has(status) || !TRACKABLE.has(status)) {
      clear({ emitDiag: true });
      return snapshot();
    }

    const rideChanged = nextId !== rideId;
    if (rideChanged) {
      bumpGeneration("ride_switch");
      approach = emptyLeg();
      trip = emptyLeg();
      tripCachedForRide = "";
      lastApproachOrigin = null;
      lastApproachAt = 0;
      fittedOnceForRide = false;
      retryAttempt = 0;
      rideId = nextId;
    }

    rideStatus = status;
    pickup = isValidLatLng(nextPickup?.lat, nextPickup?.lng)
      ? { lat: nextPickup.lat, lng: nextPickup.lng }
      : null;
    dropoff = isValidLatLng(nextDropoff?.lat, nextDropoff?.lng)
      ? { lat: nextDropoff.lat, lng: nextDropoff.lng }
      : null;

    const loc = ride?.driverLocation;
    if (isValidLatLng(loc?.lat, loc?.lng)) {
      driverLoc = { lat: loc.lat, lng: loc.lng, observedAt: loc.observedAt };
    }

    if (!visible) {
      emit();
      return snapshot();
    }

    void ensureRoutes();
    return snapshot();
  }

  /**
   * Feed validated live location. Does NOT request a route per fix.
   */
  function noteDriverLocation(fix) {
    if (closed || !fix) return;
    if (!isValidLatLng(fix.lat, fix.lng)) return;
    driverLoc = { lat: fix.lat, lng: fix.lng, observedAt: fix.observedAt };
    if (!visible || !TRACKABLE.has(rideStatus) || rideStatus === "in_progress") return;
    if (shouldRefreshApproach(driverLoc)) {
      void ensureRoutes();
    }
  }

  function setVisible(next) {
    visible = Boolean(next);
    if (!visible) {
      if (retryTimer) {
        clearT(retryTimer);
        retryTimer = 0;
      }
      return snapshot();
    }
    void ensureRoutes();
    return snapshot();
  }

  function markFitted() {
    fittedOnceForRide = true;
  }

  function clear({ emitDiag = false } = {}) {
    bumpGeneration("clear");
    rideId = "";
    rideStatus = "";
    approach = emptyLeg();
    trip = emptyLeg();
    tripCachedForRide = "";
    lastApproachOrigin = null;
    lastApproachAt = 0;
    fittedOnceForRide = false;
    driverLoc = null;
    pickup = null;
    dropoff = null;
    if (emitDiag) diag(ROUTE_DIAG.LAYERS_CLEARED);
    emit();
  }

  function destroy() {
    closed = true;
    clear({ emitDiag: true });
  }

  function setProvider(next) {
    provider = next || resolveRouteProvider();
  }

  return {
    syncRide,
    noteDriverLocation,
    setVisible,
    clear,
    destroy,
    markFitted,
    setProvider,
    ensureRoutes,
    rerouteFromOrigin,
    getModel: snapshot,
    getCounters: () => ({ ...counters }),
    getGeneration: () => generation,
    APPROACH_MIN_REFRESH_MS,
    APPROACH_MIN_DISPLACEMENT_M,
  };
}
