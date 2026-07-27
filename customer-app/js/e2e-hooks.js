/**
 * Phase 2E — customer emulator/E2E hooks (no-op outside ?emulators=1).
 * Seeds map route + sheet state so Playwright can click #bookRideBtn without Nominatim.
 */
import { setRoutePoint, getRouteInfo, routeState } from "./routing.js";
import {
  setLocationFieldValue,
  selectCategory,
  selectVehicle,
  syncRideReady,
  setDynamicVehicleFares,
  expandSheet,
  getSheetState,
} from "./sheet.js";
import { setLocationCue } from "./map.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirebase, useEmulators } from "./firebase.js";

export function installCustomerE2EHooks() {
  if (!useEmulators || typeof window === "undefined") return;

  const api = (window.__SWIFTGO_E2E__ = window.__SWIFTGO_E2E__ || {});

  api.seedRoute = function seedRoute(opts = {}) {
    const pickup = opts.pickup || {
      lat: 24.8607,
      lng: 67.0011,
      label: "Pickup E2E Clifton",
    };
    const dropoff = opts.dropoff || {
      lat: 24.9056,
      lng: 67.0822,
      label: "Drop E2E Gulshan",
    };
    const fare = Number.isFinite(opts.fare) ? Math.round(opts.fare) : 250;

    setLocationFieldValue("pickupInput", pickup.label, { autoExpand: false });
    setLocationFieldValue("destInput", dropoff.label, { autoExpand: false });
    setRoutePoint("pickup", pickup.lat, pickup.lng);
    setRoutePoint("dropoff", dropoff.lat, dropoff.lng);
    // Deterministic distance for emulator (do not depend on OSRM network).
    routeState.totalDistance = Number.isFinite(opts.distanceKm) ? opts.distanceKm : 6.2;
    routeState.totalTime = Number.isFinite(opts.timeMins) ? opts.timeMins : 18;
    routeState.source = "e2e";
    setLocationCue("pickup", pickup.lat, pickup.lng);
    setLocationCue("dropoff", dropoff.lat, dropoff.lng);

    selectCategory("ride");
    selectVehicle(opts.vehicle || "bike", { silent: true });
    setDynamicVehicleFares(
      {
        bike: fare,
        go: fare + 40,
        "go-plus": fare + 80,
        business: fare + 120,
      },
      12
    );
    window.SwiftGo = window.SwiftGo || {};
    window.SwiftGo.lastEstimatedFare = fare;
    window.SwiftGo.lastFaresByVehicle = {
      bike: fare,
      go: fare + 40,
      "go-plus": fare + 80,
      business: fare + 120,
    };
    syncRideReady({ autoExpand: true });
    expandSheet();
    return { pickup, dropoff, fare, route: getRouteInfo(), sheet: getSheetState() };
  };

  api.getActiveRide = () => window.__SWIFTGO_ACTIVE_RIDE__ || null;
  api.getRouteInfo = () => getRouteInfo();

  api.signInEmail = async function signInEmail(email, password) {
    const { auth } = getFirebase();
    if (!auth) throw new Error("AUTH_UNAVAILABLE");
    return signInWithEmailAndPassword(auth, email, password);
  };

  api.ready = true;
}
