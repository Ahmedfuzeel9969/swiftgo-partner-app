/**
 * Phase 1 — resolve customer map tracking target from ride status.
 * Pure / testable. No Firebase I/O.
 */

export const TRACKING_UI = Object.freeze({
  TOWARD_PICKUP: "toward_pickup",
  DRIVER_ARRIVED: "driver_arrived",
  TRIP_IN_PROGRESS: "trip_in_progress",
  STOPPED: "stopped",
});

const ACTIVE = new Set(["accepted", "arrived", "in_progress"]);
const TERMINAL = new Set(["completed", "cancelled", "cancelled_by_user", "expired"]);

function coordOrNull(point) {
  if (!point) return null;
  const lat = point.lat;
  const lng = point.lng;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * @param {object|null|undefined} ride
 * @returns {{
 *   targetType: 'pickup'|'dropoff'|null,
 *   coordinates: {lat:number,lng:number}|null,
 *   uiMode: string,
 *   trackingActive: boolean,
 *   statusTextKey: string|null,
 *   approachLine: boolean,
 *   showDriverMarker: boolean,
 * }}
 */
export function resolveTrackingTarget(ride) {
  const status = String(ride?.status || "");

  if (!status || TERMINAL.has(status) || !ACTIVE.has(status)) {
    return {
      targetType: null,
      coordinates: null,
      uiMode: TRACKING_UI.STOPPED,
      trackingActive: false,
      statusTextKey: null,
      approachLine: false,
      showDriverMarker: false,
    };
  }

  if (status === "accepted") {
    const pickup = coordOrNull(ride?.pickupLocation);
    return {
      targetType: "pickup",
      coordinates: pickup,
      uiMode: TRACKING_UI.TOWARD_PICKUP,
      trackingActive: true,
      statusTextKey: "liveTrackDriverComing",
      approachLine: Boolean(pickup),
      showDriverMarker: true,
    };
  }

  if (status === "arrived") {
    const pickup = coordOrNull(ride?.pickupLocation);
    return {
      targetType: "pickup",
      coordinates: pickup,
      uiMode: TRACKING_UI.DRIVER_ARRIVED,
      trackingActive: true,
      statusTextKey: "liveTrackDriverArrived",
      approachLine: Boolean(pickup),
      showDriverMarker: true,
    };
  }

  // in_progress → dropoff
  const dropoff = coordOrNull(ride?.dropoffLocation);
  return {
    targetType: "dropoff",
    coordinates: dropoff,
    uiMode: TRACKING_UI.TRIP_IN_PROGRESS,
    trackingActive: true,
    statusTextKey: "liveTrackTripInProgress",
    approachLine: Boolean(dropoff),
    showDriverMarker: true,
  };
}

/** Provider-neutral route display state placeholder (Phase 2 will fill). */
export function createRouteDisplayState() {
  return {
    provider: null,
    geometry: null,
    unavailable: true,
    reason: "phase1_no_road_routing",
    targetType: null,
  };
}

export function clearRouteDisplayState(state) {
  if (!state) return createRouteDisplayState();
  state.provider = null;
  state.geometry = null;
  state.unavailable = true;
  state.reason = "cleared";
  state.targetType = null;
  return state;
}
