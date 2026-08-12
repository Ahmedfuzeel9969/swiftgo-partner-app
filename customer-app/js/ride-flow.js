/**
 * Phase 16–32 — Ride request, live status, active ride, and invoice.
 */

import {
  watchRideRequest,
  submitRideRating,
  fetchRideById,
} from "./data.js";
import { createCustomerBookingClient, cancelCustomerBookingClient, cancelAllSearchingBookingsClient, expireSearchingBookingClient, previewCancellationFareClient } from "./booking-client.js";
import { CANCELLABLE_RIDE_STATUSES } from "./ride-status.js";
import {
  finalizeOfferAsCustomer,
  counterOfferAsCustomer,
  rejectOfferAsCustomer,
  matchCandidatesForRide,
  watchRideOffers,
} from "./offer-client.js";
import { checkCustomerBookingGate, listActiveCustomerBookings } from "./booking-gate.js";
import { assertCanonicalVehicleTypeKeyForWrite } from "./vehicle-catalog.mjs";
import {
  startDispatchSession,
  markT1RideCreated,
  markT2MatchFromCreate,
  markT4CustomerOffer,
  clearDispatchSession,
} from "./dispatch-latency.js";
import { getPaymentMethod } from "./dashboard.js";
import { getRouteInfo, clearRoutePoint } from "./routing.js";
import { clearLocationCue } from "./map.js";
import { t } from "./i18n.js";
import { announce } from "./a11y.js";
import { askExtraBookingConfirm } from "./confirm-dialog.js";
import { askCancelRideReason, askNoDriverAvailable } from "./cancel-reason-dialog.js";
import { expandSheet } from "./sheet.js";
import { syncActiveRideDrawer } from "./utility-drawer.js";
import {
  normalizeCustomerRideStatus,
  isCustomerActiveRideStatus,
  isTerminalRideStatus,
} from "./ride-status.js";
import { updateDriverTrack, stopDriverTrack, setRoadRouteLineSuppressed } from "./driver-track.js";
import {
  createRideViewLifecycle,
  attachBrowserLifecycleListeners,
  VIEWER_DIAG,
} from "./ride-view-lifecycle.mjs";
import { createViewerPresenceClient } from "./viewer-presence-client.mjs";
import { createCustomerP2pController } from "./p2p-ride-controller.mjs";
import { assignmentVersionFromToken } from "./breadcrumb-schema.mjs";
import { createTwoLegRouteController } from "./two-leg-route-controller.mjs";
import {
  createTwoLegRouteLayers,
  shouldSuppressLegacyApproachLine,
} from "./two-leg-route-layers.mjs";
import { resolveRouteProvider } from "./road-route-provider.mjs";
import { createDisplayLocationPipeline } from "./display-location-pipeline.mjs";
import { getMap, setAssignedDriverLocation } from "./map.js";
import { getFirebase } from "./firebase.js";
import { createRideLocationReportClient } from "./ride-location-report-client.mjs";

const SEARCH_TIMEOUT_MS = 180_000;
const TRACKABLE_VIEW_STATUSES = new Set(["accepted", "arrived", "in_progress"]);
/** Re-run match while searching so drivers who come online mid-search get invited. */
const SEARCH_REMATCH_MS = 30_000;
const ACTIVE_RIDE_STORAGE_KEY = "swiftgo_customer_active_ride_id";

const VEHICLE_NAME_KEYS = {
  bike: "vehBike",
  go: "vehGo",
  "go-plus": "vehGoPlus",
  business: "vehBusiness",
  "bike-cargo": "vehBikeCargo",
  suzuki: "vehSuzuki",
  truck: "vehTruck",
};

const STATUS_MESSAGE_KEYS = {
  accepted: "rideDriverOnTheWay",
  arrived: "rideDriverArrived",
  in_progress: "rideInProgress",
};

let els = {};
let onToast = null;
let onReset = null;
let onGoHome = null;
let activeRide = null;
let requesting = false;
let selectedRating = 0;
let ratingSubmitting = false;
let offerBusy = false;
let unsubscribeRide = () => {};
let unsubscribeOffers = () => {};
let unsubscribeVehicle = () => {};
let watchedVehicleId = "";
let activeOffers = [];
let selectedOfferId = null;
let pendingExtraBookingConfirm = false;
let searchTimeoutId = 0;
let searchTickId = 0;
let searchRematchId = 0;
let searchStartedAtMs = 0;
/** @type {ReturnType<typeof createRideViewLifecycle> | null} */
let rideViewLifecycle = null;
/** @type {ReturnType<typeof createViewerPresenceClient> | null} */
let presenceClient = null;
function customerP2pAssignmentVersion(ride) {
  return assignmentVersionFromToken(String(ride?.assignmentSessionToken || ""));
}

function syncCustomerP2pForRide(ride, { isVisible = true } = {}) {
  customerP2p?.syncForRide(ride, {
    isVisible,
    assignmentVersion: customerP2pAssignmentVersion(ride),
  });
}

let customerP2p = null;
/** @type {ReturnType<typeof createCustomerP2pController> | null} */
/** @type {ReturnType<typeof createTwoLegRouteController> | null} */
let twoLegRoutes = null;
/** @type {ReturnType<typeof createTwoLegRouteLayers> | null} */
let twoLegLayers = null;
/** @type {ReturnType<typeof createDisplayLocationPipeline> | null} */
let displayPipeline = null;
/** @type {ReturnType<typeof createRideLocationReportClient> | null} */
let customerLocationReport = null;
let detachBrowserLifecycle = () => {};
let detachingFromLifecycle = false;

function ensureCustomerLocationReport() {
  if (customerLocationReport) return customerLocationReport;
  customerLocationReport = createRideLocationReportClient({
    role: "customer",
    getFirebase,
    getRuntimeCounters: () => ({
      p2p: customerP2p?.getCounters?.() || {},
      display: displayPipeline?.getCounters?.() || {},
      lifecycle: rideViewLifecycle?.getCounters?.() || {},
    }),
  });
  if (typeof window !== "undefined") {
    window.__SWIFTGO_LOCATION_REPORT_COUNTERS__ = () => customerLocationReport?.snapshotSection?.() || null;
    window.addEventListener("online", () => {
      void ensureCustomerLocationReport().retryPendingReports();
    });
    window.addEventListener("visibilitychange", () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void ensureCustomerLocationReport().retryPendingReports();
      }
    });
  }
  return customerLocationReport;
}

function syncCustomerLocationReportBinding(ride) {
  const token = String(ride?.assignmentSessionToken || "").trim();
  if (!ride?.id || !token || !isCustomerActiveRideStatus(ride.status)) return;
  void ensureCustomerLocationReport().bindForRide({
    rideId: ride.id,
    assignmentSessionToken: token,
  });
}

function maybeFlushCustomerLocationReport(ride, previousStatus) {
  if (!ride?.id || !isTerminalRideStatus(ride.status)) return;
  if (previousStatus && isTerminalRideStatus(previousStatus)) return;
  void ensureCustomerLocationReport().flushFinal({ finalSubmit: true });
}

function authUid() {
  try {
    return String(getFirebase()?.auth?.currentUser?.uid || "").trim();
  } catch {
    return "";
  }
}

function viewerDiag(code) {
  try {
    console.info(JSON.stringify({ type: "viewer_lifecycle_diag", reason: String(code || "") }));
  } catch {
    /* ignore */
  }
}

function clearLiveSubscriptions() {
  unsubscribeRide();
  unsubscribeRide = () => {};
  unsubscribeOffers();
  unsubscribeOffers = () => {};
  unsubscribeVehicle();
  unsubscribeVehicle = () => {};
  watchedVehicleId = "";
  stopDriverTrack();
  void customerP2p?.stop({ closeRemote: false });
  twoLegRoutes?.setVisible(false);
}

function clearTwoLegRoutes() {
  twoLegRoutes?.clear({ emitDiag: true });
  twoLegLayers?.clear();
  displayPipeline?.clearRoute();
  setRoadRouteLineSuppressed(false);
}

function paintDisplayFrame(pos) {
  if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
  const rot = Number.isFinite(pos.headingDeg) ? pos.headingDeg : 0;
  setAssignedDriverLocation(pos.lat, pos.lng, rot, {
    observedAt: Date.now(),
    skipAnimation: true,
    allowPredict: false,
  });
}

function syncDisplayPipelineFromModel(model) {
  if (!displayPipeline || !model) return;
  const emphasis = model.emphasis;
  if (emphasis === "none") {
    displayPipeline.clearRoute();
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
    displayPipeline.clearRoute();
    return;
  }
  // Pass immutable quality metadata — fallback lines render via layers but never snap.
  displayPipeline.setActiveRoute({
    geometry,
    generation: model.rideGeneration,
    activeLeg: emphasis === "trip" ? "trip" : "approach",
    pickupLoc: activeRide?.pickupLocation || null,
    dropoffLoc: activeRide?.dropoffLocation || null,
    geometryKind: leg.geometryKind,
    snapEligible: leg.snapEligible === true && leg.fallback !== true,
    providerKind: leg.providerKind || leg.provider,
    generatedAt: leg.generatedAt,
  });
}

function ensureTwoLegRoutes() {
  if (twoLegRoutes) return twoLegRoutes;
  twoLegLayers = createTwoLegRouteLayers({
    getMap,
    onDiag: (code) => {
      try {
        console.info(JSON.stringify({ type: "road_route_diag", reason: String(code || "") }));
      } catch {
        /* ignore */
      }
    },
  });
  displayPipeline = createDisplayLocationPipeline({
    onDisplayFrame: paintDisplayFrame,
    onRawFallback: paintDisplayFrame,
    onDiag: (code) => {
      try {
        console.info(JSON.stringify({ type: "snap_diag", reason: String(code || "") }));
      } catch {
        /* ignore */
      }
    },
    onRerouteNeeded: ({ origin, generation }) => {
      const ctrl = twoLegRoutes;
      if (!ctrl) {
        displayPipeline?.noteRerouteResult(false);
        return;
      }
      const provider = resolveRouteProvider();
      if (!provider?.route || provider.id === "disabled") {
        displayPipeline?.noteRerouteResult(false);
        return;
      }
      void (async () => {
        try {
          const result = await ctrl.rerouteFromOrigin(origin);
          if (!result?.ok) {
            displayPipeline?.noteRerouteResult(false);
            return;
          }
          if (generation != null && Number(generation) > Number(result.generation || 0)) {
            displayPipeline?.noteRerouteResult(false);
            return;
          }
          const model = ctrl.getModel();
          const activeLeg = model.emphasis === "trip" ? model.trip : model.approach;
          if (activeLeg?.snapEligible === true && activeLeg.fallback !== true) {
            syncDisplayPipelineFromModel(model);
            displayPipeline?.noteRerouteResult(
              true,
              {
                geometry: activeLeg.renderGeometry || activeLeg.geometry,
                geometryKind: activeLeg.geometryKind,
                snapEligible: true,
                providerKind: activeLeg.providerKind || activeLeg.provider,
                generatedAt: activeLeg.generatedAt,
              },
              result.generation
            );
          } else {
            displayPipeline?.noteRerouteResult(false);
          }
        } catch {
          displayPipeline?.noteRerouteResult(false);
        }
      })();
    },
  });
  twoLegRoutes = createTwoLegRouteController({
    provider: resolveRouteProvider(),
    onDiag: (code) => {
      try {
        console.info(JSON.stringify({ type: "road_route_diag", reason: String(code || "") }));
      } catch {
        /* ignore */
      }
    },
    onModel: (model) => {
      const hasRoad =
        model?.approach?.status === "ready" ||
        model?.trip?.status === "ready" ||
        model?.approach?.status === "fallback" ||
        model?.trip?.status === "fallback";
      setRoadRouteLineSuppressed(shouldSuppressLegacyApproachLine(model));
      twoLegLayers?.render(model);
      syncDisplayPipelineFromModel(model);
      if (hasRoad && !model.fittedOnceForRide) {
        twoLegRoutes?.markFitted();
      }
    },
  });
  if (typeof window !== "undefined") {
    window.__SWIFTGO_ROUTE_COUNTERS__ = () => twoLegRoutes?.getCounters?.() || null;
    window.__SWIFTGO_SNAP_COUNTERS__ = () => displayPipeline?.getCounters?.() || null;
  }
  return twoLegRoutes;
}

function syncTwoLegForRide(ride, { isVisible = true } = {}) {
  const status = String(ride?.status || "");
  if (!ride?.id || !["accepted", "arrived", "in_progress"].includes(status)) {
    clearTwoLegRoutes();
    return;
  }
  // Hide booking pickup→dropoff polyline during assigned tracking (fare already computed).
  clearRoutePoint("pickup");
  clearRoutePoint("dropoff");
  ensureTwoLegRoutes().syncRide(ride, { isVisible });
  if (!isVisible) {
    displayPipeline?.getMotion?.()?.cancel("hidden");
  }
}

function renderFromArbiterFix(fix) {
  if (!activeRide || !fix) return;
  const rideForTrack = {
    ...activeRide,
    driverLocation: {
      ...(activeRide.driverLocation || {}),
      lat: fix.lat,
      lng: fix.lng,
      observedAt: fix.observedAt,
      accuracyM: fix.accuracyM ?? null,
      headingDeg: fix.headingDeg ?? null,
      speedMps: fix.speedMps ?? null,
      trackingSessionId: fix.trackingSessionId,
      sequence: fix.sequence,
    },
    driverLocationUpdatedAt: fix.observedAt,
  };
  // Authoritative raw stays on rideForTrack for distance/ETA; marker owned by display pipeline.
  ensureTwoLegRoutes();
  twoLegRoutes?.noteDriverLocation(fix);
  updateDriverTrack(rideForTrack, { skipMarker: true });
  displayPipeline?.ingestValidatedFix(fix);
}

function ensureRideViewLifecycle() {
  if (rideViewLifecycle) return rideViewLifecycle;

  presenceClient = createViewerPresenceClient({
    isVisible: () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
    isCurrentGeneration: (gen) => Boolean(rideViewLifecycle?.isCurrentGeneration(gen)),
    onDiag: (code) => viewerDiag(code),
    onAttempt: () => rideViewLifecycle?.bumpHeartbeatAttempt(),
    onSuccess: () => rideViewLifecycle?.bumpHeartbeatSuccess(),
    onFailure: () => rideViewLifecycle?.bumpHeartbeatFailure(),
  });

  customerP2p = createCustomerP2pController({
    onDiag: (code) => {
      try {
        console.info(JSON.stringify({ type: "p2p_diag", reason: String(code || "") }));
      } catch {
        /* ignore */
      }
    },
    onRenderFix: (fix) => renderFromArbiterFix(fix),
  });

  rideViewLifecycle = createRideViewLifecycle({
    diag: (code) => viewerDiag(code),
    isTerminalStatus: (s) => isTerminalRideStatus(s),
    fetchLatestRide: async (rideId) => {
      const ride = await fetchRideById(rideId);
      const uid = authUid();
      if (!ride || !uid) return null;
      if (String(ride.userId || "") !== uid) return null;
      return ride;
    },
    onLatestRide: (ride, gen) => {
      if (!rideViewLifecycle?.isCurrentGeneration(gen)) {
        viewerDiag(VIEWER_DIAG.STALE_GENERATION);
        return;
      }
      if (!ride) {
        stopDriverTrack();
        void customerP2p?.stop({ closeRemote: true });
        clearTwoLegRoutes();
        activeRide = null;
        clearActiveRideId();
        document.body.classList.remove("has-active-ride");
        if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
        restoreVehicleState();
        viewerDiag(VIEWER_DIAG.TERMINAL_CLEANUP);
        return;
      }
      handleRideSnapshot(ride);
    },
    subscribeLive: (rideId, gen) => {
      clearLiveSubscriptions();
      unsubscribeRide = watchRideRequest(
        rideId,
        (raw) => {
          if (!rideViewLifecycle?.isCurrentGeneration(gen)) {
            viewerDiag(VIEWER_DIAG.STALE_GENERATION);
            return;
          }
          rideViewLifecycle?.noteSnapshot();
          handleRideSnapshot(raw);
        },
        (err) => console.warn("[SwiftGo] ride watch", err)
      );
      unsubscribeOffers = watchRideOffers(
        rideId,
        (offers) => {
          if (!rideViewLifecycle?.isCurrentGeneration(gen)) return;
          activeOffers = offers || [];
          if (activeOffers.length) {
            markT4CustomerOffer(rideId, { offerCount: activeOffers.length });
          }
          updateDriverOfferUi(activeRide);
        },
        (err) => console.warn("[SwiftGo] offers watch", err)
      );
      syncVehicleWatch(activeRide);
    },
    unsubscribeLive: () => {
      detachingFromLifecycle = true;
      try {
        clearLiveSubscriptions();
      } finally {
        detachingFromLifecycle = false;
      }
    },
    startPresenceHeartbeat: (rideId, gen) => {
      if (!presenceClient) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const status = normalizeCustomerRideStatus(activeRide?.status);
      if (!TRACKABLE_VIEW_STATUSES.has(status)) return;
      presenceClient.start({ rideId, generation: gen });
      customerP2p?.setVisible(true);
      if (activeRide) {
        syncCustomerP2pForRide(activeRide, { isVisible: true });
        syncTwoLegForRide(activeRide, { isVisible: true });
      }
    },
    stopPresenceHeartbeat: () => {
      presenceClient?.stop();
      customerP2p?.setVisible(false);
      twoLegRoutes?.setVisible(false);
    },
  });

  detachBrowserLifecycle = attachBrowserLifecycleListeners(rideViewLifecycle);
  if (typeof window !== "undefined") {
    window.__SWIFTGO_VIEWER_COUNTERS__ = () => rideViewLifecycle?.getCounters?.() || null;
    window.__SWIFTGO_P2P_COUNTERS__ = () => customerP2p?.getCounters?.() || null;
  }
  return rideViewLifecycle;
}

function bindRideView(rideId, { forceRestart = false } = {}) {
  const lc = ensureRideViewLifecycle();
  lc.bindRide({ rideId, forceRestart });
}

function unbindRideView() {
  if (!rideViewLifecycle) return;
  detachingFromLifecycle = true;
  try {
    rideViewLifecycle.unbind();
  } finally {
    detachingFromLifecycle = false;
  }
}

/** Sign-out / session teardown — zero listeners and heartbeats. */
export function clearCustomerRideSession() {
  unbindRideView();
  void ensureCustomerLocationReport().clearBinding({ flushFirst: true });
  presenceClient?.stop();
  if (activeRide?.id) clearDispatchSession(activeRide.id);
  clearSearchTimers();
  activeOffers = [];
  selectedOfferId = null;
  clearLiveSubscriptions();
  clearTwoLegRoutes();
  void customerP2p?.stop({ closeRemote: true });
  activeRide = null;
  clearActiveRideId();
  document.body.classList.remove("has-active-ride");
  if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
  restoreVehicleState();
}

function rideCreatedAtMs(ride) {
  const ts = ride?.createdAt;
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts?.seconds === "number") return ts.seconds * 1000;
  if (typeof ts === "number") return ts;
  return 0;
}

function isGhostSearchingRide(ride) {
  const status = normalizeCustomerRideStatus(ride?.status);
  if (status !== "searching_driver" || ride?.driverId) return false;
  if (ride?.matchingStatus === "match_failed" || ride?.matchingStatus === "invalid_pickup") {
    return true;
  }
  if (!ride?.matchedAt && !ride?.matchingStatus) return true;
  return false;
}

async function purgeGhostSearchingRides() {
  try {
    const active = await listActiveCustomerBookings();
    const ghosts = active.filter(isGhostSearchingRide);
    if (!ghosts.length) return 0;
    for (const ride of ghosts) {
      try {
        await cancelCustomerBookingClient(ride.id, {
          cancelReasonKey: "other",
          cancelReason: "ghost_cleanup",
        });
      } catch (err) {
        console.warn("[SwiftGo] ghost ride cancel", ride.id, err);
      }
    }
    return ghosts.length;
  } catch (err) {
    console.warn("[SwiftGo] purge ghost rides", err);
    return 0;
  }
}

function pickLatestActiveRide(rides = []) {
  return (
    [...rides]
      .filter((r) => isCustomerActiveRideStatus(r?.status))
      .sort((a, b) => rideCreatedAtMs(b) - rideCreatedAtMs(a))[0] || null
  );
}

function mountActiveRideUi(ride, rideId) {
  const status = normalizeCustomerRideStatus(ride.status || "searching_driver");
  activeRide = { id: rideId, ...ride, status };
  if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = activeRide;
  document.body.classList.add("has-active-ride");
  persistActiveRideId(rideId);
  bindRideView(rideId);

  if (status === "searching_driver") {
    showSearchingState();
    startSearchTimers(rideId);
    updateDriverOfferUi(activeRide);
  } else if (status === "accepted" || status === "arrived" || status === "in_progress") {
    showActiveRideState(status);
  } else if (status === "completed") {
    showInvoicePanel(activeRide);
  }
}

export function initRideFlow(handlers = {}) {
  onToast = handlers.onToast || null;
  onReset = handlers.onReset || null;
  onGoHome = handlers.onGoHome || null;
  els = {
    ridePanel: document.getElementById("ridePanel"),
    searchingPanel: document.getElementById("searchingPanel"),
    searchingSpinner: document.getElementById("searchingSpinner"),
    searchingPanelText: document.getElementById("searchingPanelText"),
    searchingTimer: document.getElementById("searchingTimer"),
    driverOfferPanel: document.getElementById("driverOfferPanel"),
    driverOfferDriverName: document.getElementById("driverOfferDriverName"),
    driverOfferVehicle: document.getElementById("driverOfferVehicle"),
    driverOfferFare: document.getElementById("driverOfferFare"),
    acceptDriverOfferBtn: document.getElementById("acceptDriverOfferBtn"),
    rejectDriverOfferBtn: document.getElementById("rejectDriverOfferBtn"),
    driverOfferCounterInput: document.getElementById("driverOfferCounterInput"),
    sendCounterOfferBtn: document.getElementById("sendCounterOfferBtn"),
    cancelBtn: document.getElementById("cancelRideBtn"),
    activeCancelBtn: document.getElementById("activeRideCancelBtn"),
    activePanel: document.getElementById("activeRidePanel"),
    activeVehicle: document.getElementById("activeRideVehicle"),
    activeStatusText: document.getElementById("activeRideStatusText"),
    activeDriverName: document.getElementById("activeRideTitle"),
    invoicePanel: document.getElementById("rideInvoicePanel"),
    invoiceFare: document.getElementById("rideInvoiceFare"),
    invoiceDoneBtn: document.getElementById("rideInvoiceDoneBtn"),
    ratingBlock: document.getElementById("rideRatingBlock"),
    ratingStars: document.getElementById("rideRatingStars"),
    ratingThanks: document.getElementById("rideRatingThanks"),
  };
  els.cancelBtn?.addEventListener("click", () => {
    void cancelActiveRide();
  });
  els.activeCancelBtn?.addEventListener("click", () => {
    void cancelActiveRide();
  });
  els.acceptDriverOfferBtn?.addEventListener("click", onAcceptDriverOffer);
  els.rejectDriverOfferBtn?.addEventListener("click", onRejectDriverOffer);
  els.sendCounterOfferBtn?.addEventListener("click", onSendCounterOffer);
  els.invoiceDoneBtn?.addEventListener("click", dismissInvoiceAndReset);
  initRatingStars();
  ensureRideViewLifecycle();
  ensureCustomerLocationReport();
  scheduleCustomerLocationReportStartupRetry();
}

function scheduleCustomerLocationReportStartupRetry() {
  void (async () => {
    for (let i = 0; i < 30; i += 1) {
      const fb = getFirebase();
      if (fb?.ready && fb?.functions) {
        await ensureCustomerLocationReport().retryPendingReports();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
  })();
}

function clearSearchTimers() {
  window.clearTimeout(searchTimeoutId);
  window.clearInterval(searchTickId);
  window.clearInterval(searchRematchId);
  searchTimeoutId = 0;
  searchTickId = 0;
  searchRematchId = 0;
  searchStartedAtMs = 0;
  if (els.searchingTimer) {
    els.searchingTimer.textContent = "";
    els.searchingTimer.hidden = true;
  }
}

function formatSearchCountdown(remainingMs) {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function paintSearchTimer() {
  if (!els.searchingTimer || !searchStartedAtMs) return;
  const remaining = SEARCH_TIMEOUT_MS - (Date.now() - searchStartedAtMs);
  els.searchingTimer.hidden = false;
  els.searchingTimer.textContent = `${t("searchingTimerLabel") || "وقت باقی"} ${formatSearchCountdown(remaining)}`;
}

function startSearchTimers(rideId) {
  clearSearchTimers();
  searchStartedAtMs = Date.now();
  paintSearchTimer();
  searchTickId = window.setInterval(paintSearchTimer, 1000);
  searchRematchId = window.setInterval(() => {
    void rematchWhileSearching(rideId);
  }, SEARCH_REMATCH_MS);
  searchTimeoutId = window.setTimeout(() => {
    void onSearchTimedOut(rideId);
  }, SEARCH_TIMEOUT_MS);
}

async function rematchWhileSearching(rideId) {
  if (!rideId || activeRide?.id !== rideId) return;
  if (String(activeRide?.status || "searching_driver") !== "searching_driver") return;
  try {
    const result = await matchCandidatesForRide(rideId);
    const count = Number(result?.candidateCount ?? result?.candidates?.length ?? 0);
    if (count > 0) {
      // Soft signal only — offers UI already watches Firestore.
      console.info("[SwiftGo] rematch invited", count);
    }
  } catch (err) {
    console.warn("[SwiftGo] rematch while searching", err?.code || err?.message);
  }
}

async function onSearchTimedOut(rideId) {
  if (!rideId || activeRide?.id !== rideId) return;
  if (activeRide?.status && activeRide.status !== "searching_driver") return;
  clearSearchTimers();
  try {
    const result = await expireSearchingBookingClient(rideId);
    // Only show no-driver message when expiry actually applied (or already expired).
    if (result?.changed === false && result?.reason === "already_assigned_or_done") {
      return;
    }
  } catch (err) {
    console.warn("[SwiftGo] expire searching", err);
    const code = String(err?.message || err?.code || "");
    if (code.includes("RIDE_NOT_EXPIREABLE") || code.includes("already_assigned")) {
      return;
    }
  }
  stopRideWatch();
  stopDriverTrack();
  activeRide = null;
  clearActiveRideId();
  document.body.classList.remove("has-active-ride");
  if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
  restoreVehicleState();
  onToast?.(t("noDriverAvailable") || "کوئی ڈرائیور دستیاب نہ ہوا");
  announce(t("noDriverAvailable") || "No driver available", { assertive: true });
  const choice = await askNoDriverAvailable();
  if (choice === "retry") {
    onReset?.();
  }
}

function initRatingStars() {
  if (!els.ratingStars || els.ratingStars.childElementCount) return;

  for (let value = 1; value <= 5; value += 1) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ride-rating__star";
    btn.dataset.value = String(value);
    btn.setAttribute("aria-label", `${value} star${value === 1 ? "" : "s"}`);
    btn.textContent = "★";
    btn.addEventListener("click", () => setSelectedRating(value));
    els.ratingStars.appendChild(btn);
  }
}

function setSelectedRating(value) {
  if (activeRide?.customerRating) return;
  selectedRating = Math.max(1, Math.min(5, Math.round(Number(value) || 0)));
  updateRatingStarsUi();
}

function updateRatingStarsUi(existingRating = null) {
  if (!els.ratingStars) return;
  const activeValue = existingRating ?? selectedRating;
  [...els.ratingStars.querySelectorAll(".ride-rating__star")].forEach((btn) => {
    const starValue = Number(btn.dataset.value);
    const filled = starValue <= activeValue;
    btn.classList.toggle("is-filled", filled);
    btn.classList.toggle("is-selected", filled && !existingRating);
    btn.disabled = Boolean(existingRating);
    btn.setAttribute("aria-checked", String(starValue === activeValue));
  });
  if (els.ratingStars) {
    els.ratingStars.setAttribute("aria-label", t("rideRatingAria"));
  }
}

function resetRatingUi() {
  selectedRating = 0;
  if (els.ratingThanks) els.ratingThanks.hidden = true;
  if (els.ratingBlock) els.ratingBlock.classList.remove("is-rated");
  updateRatingStarsUi();
  [...(els.ratingStars?.querySelectorAll(".ride-rating__star") || [])].forEach((btn) => {
    btn.disabled = false;
  });
}

export function isSearchingDriver() {
  // Suppress vehicle list for any live trip session (search → invoice).
  return Boolean(activeRide);
}

/** Phase 2E — expose active ride for emulator/browser assertions. */
export function getActiveRide() {
  return activeRide;
}

function rideFareAmount(ride) {
  const value = Number(ride?.estimatedFare ?? ride?.farePkr ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function persistActiveRideId(rideId) {
  if (!rideId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ACTIVE_RIDE_STORAGE_KEY, String(rideId));
  } catch {
    /* ignore quota / private mode */
  }
}

function clearActiveRideId() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(ACTIVE_RIDE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function vehicleLabelForRide(ride) {
  const key = String(ride?.vehicleTypeKey || "").trim();
  if (key && VEHICLE_NAME_KEYS[key]) return t(VEHICLE_NAME_KEYS[key]);
  return ride?.vehicleType || t("vehGo");
}

function paintActiveRideDetails(ride) {
  const source = ride || activeRide;
  if (!source) return;
  const plate = source.vehiclePlate || "—";
  const driverName = source.driverName || t("activeRideDriver");
  if (els.activeDriverName) els.activeDriverName.textContent = driverName;
  if (els.activeVehicle) {
    els.activeVehicle.textContent = `${vehicleLabelForRide(source)} · ${plate}`;
  }
  syncActiveRideDrawer(source);
}

function syncVehicleWatch(ride) {
  const vehicleId = String(ride?.vehicleId || "").trim();
  const trackable = ["accepted", "arrived", "in_progress"].includes(String(ride?.status || ""));

  if (!vehicleId || !trackable) {
    watchedVehicleId = "";
    unsubscribeVehicle();
    unsubscribeVehicle = () => {};
    return;
  }

  // Phase 1: ride.driverLocation (CF mirror) is authoritative for the customer map.
  // Do not override tracking from a parallel vehicle listener (avoids dual write/read paths).
  if (vehicleId === watchedVehicleId) return;
  watchedVehicleId = vehicleId;
  unsubscribeVehicle();
  unsubscribeVehicle = () => {};
}

function attachRideWatch(rideId) {
  if (!rideId) return;
  bindRideView(rideId, { forceRestart: true });
}

function maybeStartPresenceForActiveRide() {
  const rideId = String(activeRide?.id || "").trim();
  if (!rideId || !rideViewLifecycle || !presenceClient) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (!rideViewLifecycle.isLiveAttached()) return;
  const status = normalizeCustomerRideStatus(activeRide?.status);
  if (!TRACKABLE_VIEW_STATUSES.has(status)) return;
  presenceClient.start({
    rideId,
    generation: rideViewLifecycle.getGeneration(),
  });
}

function showSearchingState() {
  hideInvoicePanel();
  stopDriverTrack();
  if (els.ridePanel) els.ridePanel.hidden = true;
  els.activePanel?.classList.remove("is-visible");
  if (els.activePanel) els.activePanel.hidden = true;
  if (!els.searchingPanel) return;
  els.searchingPanel.hidden = false;
  setSearchingOfferVisible(false);
  expandSheet();
  requestAnimationFrame(() => els.searchingPanel.classList.add("is-visible"));
  announce(t("searchingDriver") || "Searching for drivers");
  if (els.cancelBtn) {
    els.cancelBtn.hidden = false;
    els.cancelBtn.textContent = t("cancelRide") || "کینسل کریں";
  }
}

function setSearchingOfferVisible(hasOffer) {
  if (els.searchingSpinner) els.searchingSpinner.hidden = hasOffer;
  if (els.driverOfferPanel) els.driverOfferPanel.hidden = !hasOffer;
  if (els.searchingPanelText) {
    els.searchingPanelText.hidden = hasOffer;
    if (!hasOffer) {
      els.searchingPanelText.textContent = t("searchingDriver");
      els.searchingPanelText.dataset.i18n = "searchingDriver";
    }
  }
}

function updateDriverOfferUi(_ride) {
  const open = (activeOffers || []).filter((o) =>
    ["open", "countered"].includes(o.status)
  );
  if (!open.length) {
    setSearchingOfferVisible(false);
    selectedOfferId = null;
    return;
  }
  const offer = open.find((o) => o.id === selectedOfferId) || open[0];
  const isNewOffer = selectedOfferId !== offer.id;
  selectedOfferId = offer.id;
  setSearchingOfferVisible(true);
  if (isNewOffer) announce(t("driverOfferReceived") || "Offer received");
  const fare = Math.round(Number(offer.fare) || 0);
  if (els.driverOfferDriverName) {
    els.driverOfferDriverName.textContent = offer.driverName || t("activeRideDriver");
  }
  if (els.driverOfferVehicle) {
    els.driverOfferVehicle.textContent = offer.vehiclePlate || "—";
  }
  if (els.driverOfferFare) {
    els.driverOfferFare.textContent = `Rs. ${fare.toLocaleString("en-PK")}`;
  }
  if (els.driverOfferCounterInput && !els.driverOfferCounterInput.value) {
    els.driverOfferCounterInput.placeholder = String(
      Math.round(Number(offer.customerCounterFare) || fare || 0)
    );
  }
}

async function onAcceptDriverOffer() {
  const ride = activeRide;
  if (!ride?.id || !selectedOfferId || offerBusy) return;
  offerBusy = true;
  if (els.acceptDriverOfferBtn) els.acceptDriverOfferBtn.disabled = true;
  try {
    await finalizeOfferAsCustomer(selectedOfferId);
    onToast?.(t("driverOfferAcceptedToast"));
    announce(t("rideAccepted") || "Driver assigned");
  } catch (err) {
    console.warn("[SwiftGo] accept offer", err);
    onToast?.(t("driverOfferError"));
    announce(t("driverOfferError") || "Offer error", { assertive: true });
  } finally {
    offerBusy = false;
    if (els.acceptDriverOfferBtn) els.acceptDriverOfferBtn.disabled = false;
  }
}

async function onRejectDriverOffer() {
  if (!selectedOfferId || offerBusy) return;
  offerBusy = true;
  try {
    await rejectOfferAsCustomer(selectedOfferId);
    onToast?.(t("driverOfferRejectedToast"));
  } catch (err) {
    console.warn("[SwiftGo] reject offer", err);
    onToast?.(t("driverOfferError"));
  } finally {
    offerBusy = false;
  }
}

async function onSendCounterOffer() {
  if (!selectedOfferId || offerBusy) return;
  const fare = Math.round(Number(els.driverOfferCounterInput?.value) || 0);
  if (fare <= 0) {
    onToast?.(t("driverOfferCounterInvalid"));
    return;
  }
  offerBusy = true;
  if (els.sendCounterOfferBtn) els.sendCounterOfferBtn.disabled = true;
  try {
    await counterOfferAsCustomer(selectedOfferId, fare);
    onToast?.(t("driverOfferCounterSent"));
    announce(t("driverOfferCounterSent") || "Counteroffer sent");
  } catch (err) {
    console.warn("[SwiftGo] counter offer", err);
    onToast?.(t("driverOfferError"));
    announce(t("driverOfferError") || "Offer error", { assertive: true });
  } finally {
    offerBusy = false;
    if (els.sendCounterOfferBtn) els.sendCounterOfferBtn.disabled = false;
  }
}

function restoreVehicleState() {
  els.searchingPanel?.classList.remove("is-visible");
  els.activePanel?.classList.remove("is-visible");
  hideInvoicePanel();
  window.setTimeout(() => {
    if (els.searchingPanel) els.searchingPanel.hidden = true;
    if (els.activePanel) els.activePanel.hidden = true;
    if (els.ridePanel) els.ridePanel.hidden = false;
  }, 280);
}

function hideInvoicePanel() {
  els.invoicePanel?.classList.remove("is-visible");
  if (els.invoicePanel) els.invoicePanel.hidden = true;
}

function updateActiveRideStatusUi(status) {
  const key = STATUS_MESSAGE_KEYS[status] || "rideDriverOnTheWay";
  if (els.activeStatusText) {
    els.activeStatusText.textContent = t(key);
    els.activeStatusText.dataset.i18n = key;
  }
  if (els.activeCancelBtn) {
    const cancellable = CANCELLABLE_RIDE_STATUSES.includes(String(status || ""));
    els.activeCancelBtn.hidden = !cancellable;
  }
}

function showActiveRideState(status = "accepted") {
  // Force-hide searching sheet immediately so Active Ride is not covered.
  els.searchingPanel?.classList.remove("is-visible");
  if (els.searchingPanel) els.searchingPanel.hidden = true;
  if (els.ridePanel) els.ridePanel.hidden = true;
  hideInvoicePanel();

  paintActiveRideDetails(activeRide);
  updateActiveRideStatusUi(status);
  const visible =
    typeof document === "undefined" || document.visibilityState !== "hidden";
  syncCustomerP2pForRide(activeRide, { isVisible: visible });
  syncTwoLegForRide(activeRide, { isVisible: visible });
  if (!customerP2p && activeRide) updateDriverTrack(activeRide);

  if (!els.activePanel) return;
  els.activePanel.hidden = false;
  expandSheet();
  onGoHome?.();
  requestAnimationFrame(() => els.activePanel.classList.add("is-visible"));
}

function showInvoicePanel(ride) {
  stopDriverTrack();
  void customerP2p?.stop({ closeRemote: true });
  clearTwoLegRoutes();
  els.searchingPanel?.classList.remove("is-visible");
  els.activePanel?.classList.remove("is-visible");
  if (els.searchingPanel) els.searchingPanel.hidden = true;
  if (els.activePanel) els.activePanel.hidden = true;
  if (els.ridePanel) els.ridePanel.hidden = true;

  if (els.invoiceFare) {
    const fare = rideFareAmount(ride);
    const discount = Number(ride?.discountAmount) || 0;
    if (discount > 0 && ride?.originalFare) {
      els.invoiceFare.textContent = `Rs. ${fare} (−${discount})`;
    } else {
      els.invoiceFare.textContent = `Rs. ${fare}`;
    }
  }

  if (ride?.customerRating) {
    selectedRating = ride.customerRating;
    updateRatingStarsUi(ride.customerRating);
    if (els.ratingThanks) els.ratingThanks.hidden = false;
    if (els.ratingBlock) els.ratingBlock.classList.add("is-rated");
  } else {
    resetRatingUi();
  }

  if (!els.invoicePanel) return;
  els.invoicePanel.hidden = false;
  expandSheet();
  onGoHome?.();
  requestAnimationFrame(() => els.invoicePanel.classList.add("is-visible"));
  onToast?.(t("rideCompleted"));
}

function stopRideWatch() {
  if (activeRide?.id) clearDispatchSession(activeRide.id);
  clearSearchTimers();
  activeOffers = [];
  selectedOfferId = null;
  if (!detachingFromLifecycle) {
    unbindRideView();
  }
  clearLiveSubscriptions();
}

function clearMapRouteState() {
  clearRoutePoint("pickup");
  clearRoutePoint("dropoff");
  clearLocationCue("pickup");
  clearLocationCue("dropoff");
}

function resetToVehicleSelection(messageKey) {
  stopRideWatch();
  stopDriverTrack();
  void customerP2p?.stop({ closeRemote: true });
  clearTwoLegRoutes();
  activeRide = null;
  clearActiveRideId();
  document.body.classList.remove("has-active-ride");
  if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
  restoreVehicleState();
  if (messageKey) onToast?.(t(messageKey));
}

function dismissInvoiceAndReset() {
  if (ratingSubmitting) return;

  const ride = activeRide;
  const submitRating = selectedRating >= 1 && !ride?.customerRating;

  const finish = () => {
    stopRideWatch();
    stopDriverTrack();
    activeRide = null;
    clearActiveRideId();
    document.body.classList.remove("has-active-ride");
    if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
    resetRatingUi();
    hideInvoicePanel();
    clearMapRouteState();
    if (els.ridePanel) els.ridePanel.hidden = false;
    onReset?.();
  };

  if (!submitRating || !ride?.id) {
    finish();
    return;
  }

  ratingSubmitting = true;
  if (els.invoiceDoneBtn) els.invoiceDoneBtn.disabled = true;

  submitRideRating(ride.id, selectedRating, ride.driverId)
    .then(() => {
      if (els.ratingThanks) els.ratingThanks.hidden = false;
      if (els.ratingBlock) els.ratingBlock.classList.add("is-rated");
      updateRatingStarsUi(selectedRating);
      onToast?.(t("rideRatingThanks"));
    })
    .catch((err) => {
      console.warn("[SwiftGo] ride rating", err);
      onToast?.(t("rideRatingError"));
    })
    .finally(() => {
      ratingSubmitting = false;
      if (els.invoiceDoneBtn) els.invoiceDoneBtn.disabled = false;
      finish();
    });
}

function handleRideSnapshot(rawRide) {
  if (!rawRide) return;
  const ride = {
    ...rawRide,
    status: normalizeCustomerRideStatus(rawRide.status),
  };
  const previousStatus = activeRide?.status;
  activeRide = { ...activeRide, ...ride };
  syncCustomerLocationReportBinding(activeRide);
  if (ride?.driverLocation?.lat && ride?.driverLocation?.lng) {
    activeRide.driverLocationReceivedAt = Date.now();
  }
  if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = activeRide;
  document.body.classList.toggle("has-active-ride", Boolean(activeRide));
  syncVehicleWatch(activeRide);

  if (ride.status === "accepted" || ride.status === "arrived" || ride.status === "in_progress") {
    clearSearchTimers();
    maybeStartPresenceForActiveRide();
    const visible =
      typeof document === "undefined" || document.visibilityState !== "hidden";
    syncCustomerP2pForRide(ride, { isVisible: visible });
    syncTwoLegForRide(ride, { isVisible: visible });
    if (ride?.driverLocation) {
      customerP2p?.ingestFirebaseLocation(ride.driverLocation, ride);
    } else if (!customerP2p) {
      updateDriverTrack(ride);
    }
    const firstActive =
      previousStatus !== "accepted" &&
      previousStatus !== "arrived" &&
      previousStatus !== "in_progress";
    if (firstActive) {
      showActiveRideState(ride.status);
      if (ride.status === "accepted") {
        onToast?.(t("rideAccepted"));
        announce(t("rideAccepted") || "Driver assigned");
      }
    } else if (previousStatus !== ride.status) {
      paintActiveRideDetails(ride);
      updateActiveRideStatusUi(ride.status);
      if (ride.status === "arrived") {
        onToast?.(t("rideDriverArrived"));
        announce(t("rideDriverArrived") || "Driver arrived");
      }
      if (ride.status === "in_progress") {
        onToast?.(t("rideInProgress"));
        announce(t("rideInProgress") || "Ride started");
      }
    } else {
      paintActiveRideDetails(ride);
      updateActiveRideStatusUi(ride.status);
    }
  } else if (ride.status === "declined") {
    stopDriverTrack();
    void customerP2p?.stop({ closeRemote: true });
    clearTwoLegRoutes();
    if (previousStatus !== "declined") resetToVehicleSelection("driverDeclined");
  } else if (ride.status === "completed") {
    stopDriverTrack();
    void customerP2p?.stop({ closeRemote: true });
    clearTwoLegRoutes();
    if (previousStatus !== "completed") {
      stopRideWatch();
      showInvoicePanel(ride);
      announce(t("rideCompleted") || "Ride completed");
    }
  } else if (ride.status === "cancelled_by_user" || ride.status === "cancelled_by_customer" || ride.status === "cancelled_by_system") {
    if (previousStatus !== ride.status) {
      announce(t("rideCancelled") || "Booking cancelled", { assertive: true });
    }
    resetToVehicleSelection();
  } else if (ride.status === "no_driver_found" || ride.status === "expired") {
    if (previousStatus !== ride.status) {
      clearSearchTimers();
      stopRideWatch();
      activeRide = null;
      clearActiveRideId();
      document.body.classList.remove("has-active-ride");
      if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
      restoreVehicleState();
      onToast?.(t("noDriverAvailable") || "کوئی ڈرائیور اس وقت میسر نہیں ہے");
      void askNoDriverAvailable().then((choice) => {
        if (choice === "retry") onReset?.();
      });
    }
  } else if (ride.status === "searching_driver") {
    if (previousStatus !== "searching_driver") showSearchingState();
    updateDriverOfferUi(ride);
  }

  maybeFlushCustomerLocationReport(ride, previousStatus);
}

/**
 * Save the ride to Firestore, then flip the sheet into the searching state.
 * Caller (app.js) has already verified sign-in and pickup/destination.
 * @param {ReturnType<import('./sheet.js').getSheetState>} state
 */
export async function startRideRequest(state) {
  if (requesting || activeRide) return null;
  requesting = true;

  const route = getRouteInfo();
  let vehicleKey;
  try {
    vehicleKey = assertCanonicalVehicleTypeKeyForWrite(state.vehicle || "bike");
  } catch (err) {
    console.warn("[SwiftGo] invalid vehicle type for booking", err);
    onToast?.(t("rideRequestFailed") || "Invalid vehicle type");
    requesting = false;
    return null;
  }
  const faresByVehicle = window.SwiftGo?.lastFaresByVehicle || {};
  const liveByVehicle = Number(faresByVehicle[vehicleKey]);
  const liveEstimate = Number(window.SwiftGo?.lastEstimatedFare);
  const estimatedFare =
    Number.isFinite(liveByVehicle) && liveByVehicle >= 0
      ? liveByVehicle
      : Number.isFinite(liveEstimate) && liveEstimate >= 0
        ? liveEstimate
        : state.basePrice ?? state.price ?? 0;

  try {
    if (
      !Number.isFinite(route.pickup?.lat) ||
      !Number.isFinite(route.pickup?.lng) ||
      !Number.isFinite(route.dropoff?.lat) ||
      !Number.isFinite(route.dropoff?.lng)
    ) {
      onToast?.(t("bookingNeedRoute") || "پک اپ اور منزل نقشے پر سیٹ کریں");
      announce(t("bookingNeedRoute") || "Set pickup and destination on the map", {
        assertive: true,
      });
      return null;
    }

    if (!pendingExtraBookingConfirm) {
      const purged = await purgeGhostSearchingRides();
      if (purged > 0) {
        onToast?.(
          t("bookingClearedSearching") ||
            `${purged} stuck booking(s) cleared — continuing with your new ride.`
        );
      }
    }

    const gate = await checkCustomerBookingGate({
      confirmedExtraBooking: pendingExtraBookingConfirm,
    });
    if (!gate.allowed) {
      if (gate.reason === "MAX_ACTIVE_BOOKINGS") {
        // This confirm only clears stale searching rides — it does NOT create a booking.
        const clear = window.confirm(
          `${t("bookingMaxActive")}\n\n${t("bookingClearSearchingAsk") || "پرانی تلاش والی بکنگز منسوخ کریں؟"}`
        );
        if (clear) {
          try {
            const cleared = await cancelAllSearchingBookingsClient();
            const n = Number(cleared?.cancelledCount ?? 0);
            const still = Number(cleared?.activeCount ?? 0);
            const assigned = Array.isArray(cleared?.blockingAssigned)
              ? cleared.blockingAssigned.length
              : 0;
            if (cleared?.failed?.length) {
              onToast?.(
                t("bookingClearFailed") ||
                  `کچھ بکنگز منسوخ نہیں ہو سکیں (${cleared.failed[0]?.reason || "error"})`
              );
            } else if (still > 0 && assigned > 0) {
              onToast?.(
                t("bookingStillAssigned") ||
                  `تلاش والی بکنگز صاف ہو گئیں، لیکن ${assigned} تفویض شدہ بکنگ ابھی فعال ہے`
              );
            } else if (still > 0) {
              onToast?.(t("bookingMaxActive"));
            } else {
              onToast?.(
                t("bookingClearedSearching") ||
                  (n
                    ? `${n} پرانی بکنگز منسوخ ہو گئیں — دوبارہ بکنگ کریں۔`
                    : "سلاٹ صاف ہو گئے — دوبارہ بکنگ کریں۔")
              );
            }
          } catch (clearErr) {
            console.warn("[SwiftGo] clear searching", clearErr);
            const reason = String(clearErr?.message || clearErr?.code || "");
            onToast?.(
              `${t("bookingClearFailed") || "پرانی بکنگز منسوخ نہیں ہو سکیں"}${
                reason ? ` (${reason})` : ""
              }`
            );
          }
        } else {
          onToast?.(t("bookingMaxActive"));
        }
        announce(t("bookingMaxActive") || "Booking limit reached", { assertive: true });
        // Explicit null — caller must not show booking success.
        return null;
      }
      if (gate.needsConfirmation || gate.reason === "CONFIRM_EXTRA_BOOKING") {
        const choice = await askExtraBookingConfirm();
        if (choice !== "confirm") {
          onToast?.(t("bookingExtraCancelled"));
          announce(t("bookingExtraCancelled") || "Extra booking cancelled");
          if (choice === "view") {
            try {
              window.SwiftGo?.navigate?.("history");
            } catch {
              /* ignore */
            }
          }
          return null;
        }
        pendingExtraBookingConfirm = true;
        const gate2 = await checkCustomerBookingGate({ confirmedExtraBooking: true });
        if (!gate2.allowed) {
          onToast?.(t("bookingMaxActive"));
          announce(t("bookingMaxActive") || "Booking limit reached", { assertive: true });
          return null;
        }
      } else {
        onToast?.(t("rideRequestFailed"));
        return null;
      }
    }
    pendingExtraBookingConfirm = false;

    const bookT0 = performance.now();
    const created = await createCustomerBookingClient({
      confirmedExtraBooking: true,
      pickupLocation: {
        lat: route.pickup?.lat,
        lng: route.pickup?.lng,
        address: state.pickup || "",
      },
      dropoffLocation: {
        lat: route.dropoff?.lat,
        lng: route.dropoff?.lng,
        address: state.destination || "",
      },
      vehicleType: t(VEHICLE_NAME_KEYS[vehicleKey] || "vehBike"),
      vehicleTypeKey: vehicleKey,
      distanceKm: route.totalDistance ?? 0,
      timeMins: route.totalTime ?? state.eta ?? 0,
      farePkr: estimatedFare,
      estimatedFare,
      promoCode: state.promoCode || "",
      discountAmount: state.discount || 0,
      paymentMethod: getPaymentMethod(),
    });

    const rideId = String(created?.id || "").trim();
    if (!rideId) {
      console.warn("[SwiftGo] createCustomerBooking returned no ride id", created);
      onToast?.(t("rideRequestFailed"));
      announce(t("rideRequestFailed") || "Booking failed", { assertive: true });
      throw new Error("MISSING_RIDE_ID");
    }

    startDispatchSession(rideId);
    markT1RideCreated(rideId, {
      cfMs: Math.round(performance.now() - bookT0),
      serverLatencyMs: created.latencyMs ?? null,
    });
    markT2MatchFromCreate(rideId, {
      candidateCount: created.candidateCount ?? 0,
      matchingStatus: created.matchingStatus ?? null,
    });

    const ride = {
      id: rideId,
      status: "searching_driver",
      farePkr: estimatedFare,
      estimatedFare,
      vehicleTypeKey: vehicleKey,
      promoCode: state.promoCode || "",
      paymentMethod: getPaymentMethod(),
    };

    activeRide = ride;
    document.body.classList.add("has-active-ride");
    if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = activeRide;
    announce(t("bookingCreated") || "Booking created");
    stopRideWatch();
    persistActiveRideId(ride.id);
    showSearchingState();
    startSearchTimers(ride.id);
    attachRideWatch(ride.id);
    if (!created.candidateCount && created.matchingStatus !== "candidates_ready") {
      await matchCandidatesForRide(ride.id);
    }
    const invited = created.matchingStatus === "candidates_ready" || Number(created.candidateCount) > 0;
    if (invited) {
      onToast?.(
        t("bookingDriversInvited") ||
          `${created.candidateCount || ""} قریبی ڈرائیور کو دعوت بھیج دی`.trim()
      );
    } else if (created.matchingStatus === "match_failed") {
      onToast?.(
        t("bookingMatchRetrying") ||
          "ڈرائیور میچنگ میں مسئلہ — تلاش جاری، دوبارہ کوشش ہو رہی ہے"
      );
    } else {
      onToast?.(
        t("bookingSearchPending") ||
          "بکنگ بن گئی — قریبی ڈرائیور تلاش ہو رہے ہیں"
      );
    }
    return ride;
  } finally {
    requesting = false;
  }
}

async function cancelActiveRide() {
  const ride = activeRide;
  if (!ride?.id) {
    restoreVehicleState();
    return;
  }
  const status = String(ride.status || "searching_driver");
  if (!CANCELLABLE_RIDE_STATUSES.includes(status)) {
    onToast?.(t("cancelRideNotAllowed") || "یہ سواری کینسل نہیں ہو سکتی");
    return;
  }

  let farePreview = null;
  if (status === "in_progress") {
    try {
      farePreview = await previewCancellationFareClient(ride.id);
    } catch (err) {
      console.warn("[SwiftGo] cancellation fare preview", err);
      onToast?.(t("cancelRidePreviewFailed") || "کرایہ دیکھنے میں مسئلہ — دوبارہ کوشش کریں");
      return;
    }
  }

  const reason = await askCancelRideReason(farePreview);
  if (!reason) return;

  try {
    const result = await cancelCustomerBookingClient(ride.id, reason);
    stopRideWatch();
    stopDriverTrack();
    activeRide = null;
    clearActiveRideId();
    document.body.classList.remove("has-active-ride");
    if (typeof window !== "undefined") window.__SWIFTGO_ACTIVE_RIDE__ = null;
    restoreVehicleState();
    if (result?.partialFareApplies && Number(result.cancellationFare) > 0) {
      onToast?.(
        (t("rideCancelledWithFare") || "بکنگ منسوخ — واجب الادا: Rs. {amount}").replace(
          "{amount}",
          Math.round(Number(result.cancellationFare) || 0).toLocaleString("en-PK")
        )
      );
    } else {
      onToast?.(t("rideCancelled") || "بکنگ منسوخ ہو گئی");
    }
    announce(t("rideCancelled") || "Booking cancelled", { assertive: true });
  } catch (err) {
    console.warn("[SwiftGo] cancel ride", err);
    const code = String(err?.message || err?.code || "");
    onToast?.(
      `${t("rideRequestFailed") || "کینسل نہیں ہو سکی"}${code ? ` (${code})` : ""}`
    );
  }
}

/**
 * Restore live ride UI after reload if a non-terminal booking exists.
 * @param {string} customerUid
 */
export async function resumeActiveRideWatch(customerUid) {
  if (!customerUid || activeRide || requesting) return;

  let rideId = "";
  try {
    rideId = localStorage.getItem(ACTIVE_RIDE_STORAGE_KEY) || "";
  } catch {
    rideId = "";
  }

  let ride = null;
  if (rideId) {
    try {
      ride = await fetchRideById(rideId);
    } catch (err) {
      console.warn("[SwiftGo] resume active ride fetch", err);
    }
  }

  if (!ride || ride.userId !== customerUid || !isCustomerActiveRideStatus(ride.status)) {
    try {
      const active = await listActiveCustomerBookings();
      ride = pickLatestActiveRide(active);
      rideId = ride?.id || "";
    } catch (err) {
      console.warn("[SwiftGo] resume active ride list", err);
    }
  }

  if (!ride || ride.userId !== customerUid || !isCustomerActiveRideStatus(ride.status)) {
    clearActiveRideId();
    return;
  }

  mountActiveRideUi(ride, rideId);
}
