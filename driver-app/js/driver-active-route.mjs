/**
 * Phase 5 — driver active-ride two-leg routes + display-only snap pipeline.
 * Never writes snapped coordinates to Firebase/P2P. No second GPS watch.
 */

import { createTwoLegRouteController } from "./two-leg-route-controller.mjs";
import { createTwoLegRouteLayers } from "./two-leg-route-layers.mjs";
import { resolveRouteProvider, ROUTE_PROVIDER_KIND } from "./road-route-provider.mjs";
import { createDisplayLocationPipeline } from "./display-location-pipeline.mjs";

/**
 * @param {{
 *   getMap: () => object|null,
 *   paintDisplayMarker: (pos: {lat:number,lng:number,headingDeg?:number|null}) => void,
 *   onDiag?: (code: string) => void,
 * }} opts
 */
export function createDriverActiveRouteController(opts) {
  const getMap = opts.getMap;
  const paint = opts.paintDisplayMarker || (() => {});
  const diag = opts.onDiag || (() => {});

  let twoLeg = null;
  let layers = null;
  let display = null;
  let lastRideId = "";

  function snapDiag(code) {
    try {
      console.info(JSON.stringify({ type: "snap_diag", reason: String(code || "") }));
    } catch {
      /* ignore */
    }
    diag(code);
  }

  function syncDisplayFromModel(model) {
    if (!display || !model) return;
    const emphasis = model.emphasis;
    if (emphasis === "none") {
      display.clearRoute();
      return;
    }
    const leg = emphasis === "trip" ? model.trip : model.approach;
    const geometry = leg?.renderGeometry || leg?.geometry;
    const ready =
      leg &&
      (leg.status === "ready" || leg.status === "fallback") &&
      Array.isArray(geometry) &&
      geometry.length >= 2;
    if (!ready) {
      display.clearRoute();
      return;
    }
    display.setActiveRoute({
      geometry,
      generation: model.rideGeneration,
      activeLeg: emphasis === "trip" ? "trip" : "approach",
      pickupLoc: null,
      dropoffLoc: null,
    });
  }

  function ensure() {
    if (twoLeg) return twoLeg;
    layers = createTwoLegRouteLayers({
      getMap,
      onDiag: (code) => snapDiag(code),
    });
    display = createDisplayLocationPipeline({
      onDisplayFrame: paint,
      onRawFallback: paint,
      onDiag: snapDiag,
      onRerouteNeeded: ({ origin, generation }) => {
        const provider = resolveRouteProvider();
        if (!provider?.route || provider.id === ROUTE_PROVIDER_KIND.DISABLED) {
          display?.noteRerouteResult(false);
          return;
        }
        void (async () => {
          try {
            const result = await twoLeg.rerouteFromOrigin(origin);
            if (!result?.ok) {
              display?.noteRerouteResult(false);
              return;
            }
            if (generation != null && Number(generation) > Number(result.generation || 0)) {
              display?.noteRerouteResult(false);
              return;
            }
            syncDisplayFromModel(twoLeg.getModel());
            display?.noteRerouteResult(true);
          } catch {
            display?.noteRerouteResult(false);
          }
        })();
      },
    });
    twoLeg = createTwoLegRouteController({
      provider: resolveRouteProvider(),
      onDiag: (code) => snapDiag(code),
      onModel: (model) => {
        layers?.render(model);
        syncDisplayFromModel(model);
        if (
          (model?.approach?.status === "ready" ||
            model?.trip?.status === "ready" ||
            model?.approach?.status === "fallback" ||
            model?.trip?.status === "fallback") &&
          !model.fittedOnceForRide
        ) {
          twoLeg?.markFitted();
        }
      },
    });
    if (typeof window !== "undefined") {
      window.__SWIFTGO_DRIVER_ROUTE_COUNTERS__ = () => twoLeg?.getCounters?.() || null;
      window.__SWIFTGO_DRIVER_SNAP_COUNTERS__ = () => display?.getCounters?.() || null;
    }
    return twoLeg;
  }

  function syncRide(ride, { isVisible = true } = {}) {
    const status = String(ride?.status || "");
    if (!ride?.id || !["accepted", "arrived", "in_progress"].includes(status)) {
      clear();
      return;
    }
    const ctrl = ensure();
    if (lastRideId && lastRideId !== ride.id) {
      display?.clearRoute();
    }
    lastRideId = String(ride.id);
    const withPickupDrop = {
      ...ride,
      pickupLocation: ride.pickupLocation || ride.pickup || null,
      dropoffLocation: ride.dropoffLocation || ride.dropoff || ride.destination || null,
    };
    ctrl.syncRide(withPickupDrop, { isVisible });
  }

  /**
   * Feed canonical local GPS (already the single watch). Display-only snap.
   * Does not write to Firebase.
   */
  function noteRawFix(fix) {
    if (!fix) return;
    ensure();
    twoLeg?.noteDriverLocation(fix);
    display?.ingestValidatedFix(fix);
  }

  function clear() {
    twoLeg?.clear({ emitDiag: true });
    layers?.clear();
    display?.clearRoute();
    lastRideId = "";
  }

  function destroy() {
    clear();
    display?.destroy();
    layers?.destroy();
    twoLeg?.destroy();
    twoLeg = null;
    layers = null;
    display = null;
  }

  return {
    syncRide,
    noteRawFix,
    clear,
    destroy,
    getTwoLeg: () => twoLeg,
    getDisplay: () => display,
  };
}
