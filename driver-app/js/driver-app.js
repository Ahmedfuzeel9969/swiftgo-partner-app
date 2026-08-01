/** SwiftGo Driver app — map, rides, wallet, PIN linking. No owner/driver mode switching. */

import { firebaseConfig } from "./firebase-config.js";
import { getFirebase, isFirebaseConfigured } from "./firebase.js";
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { initWalletRecharge } from "./wallet.js";
import { initEarningsDetail } from "./EarningsDetail.js";
import { initRideRadarFlow } from "./ride-radar-controller.js";
import { initRateDetailsModal, openRateDetails } from "./rate-details-modal.js";
import { resolveVehicleKeyFromLabel } from "./pricing-client.js";
import { initDriverDashboard } from "./driver-dashboard.js";
import { initDriverHome } from "./DriverHome.js";
import { subscribePendingRadarRides, normalizeRadarDoc } from "./ride-radar-service.js";
import { clearLocalCacheNamespace } from "./local-first-cache.js";
import { createDriverOfferInbox } from "./driver-offer-inbox.js";
import { requestRideSettlement } from "./settlement-client.js";
import {
  ACTIVE_EXECUTION_STATUSES,
  ACTIVE_RIDE_RECOVERY_URDU,
  ORPHANED_RIDE_COMPLETE_URDU,
  clearActiveRideCache,
  classifySettlementFailure,
  collectActiveRideCandidateIds,
  persistActiveRideCache,
  readActiveRideCache,
  STALE_POINTER_RECOVERY_URDU,
  validateRideForDriverRestore,
} from "./active-ride-reconcile.mjs";
import {
  freshLocationService,
  LOCATION_FAILURE,
  LOCATION_FAILURE_URDU,
} from "./fresh-location.mjs";
import {
  createLocationDiagCounters,
  evaluateFixAgainstPrevious,
  LOCATION_DIAG,
  normalizeLocationFix,
  toVehicleLocationField,
} from "./location-envelope.mjs";
import { createLocationWriteSerializer } from "./location-write-queue.mjs";
import {
  MIN_LOCATION_MOVE_M,
  RESPONSIVE_INTERVAL_MS,
  VIEWER_LEASE,
  createCheckpointPolicyController,
  presenceDocId,
} from "./location-checkpoint-policy.mjs";
import { createViewerPresenceConsumer } from "./viewer-presence-consumer.mjs";
import { logOnlineReadinessEvent } from "./online-readiness-diag.mjs";
import { linkVehicleByPinClient } from "./pin-link-client.js";
import { cancelAssignedRideByDriverClient } from "./ride-radar-actions.js";
import { hashVehiclePin } from "./pin-hash.js";
import {
  AudioService,
  initAudioService,
  initNotificationSettingsUI,
} from "./audio-service.js";
import { shouldUseEmulators } from "./firebase.js";
import { announce, applyReducedMotionClass, initKeyboardInset, trapFocus } from "./a11y.js";
import { initI18n, t, subscribe as subscribeLang } from "./i18n.js";
import { wireLegalLinks, requestAccountDeletionClient } from "./trust.js";
import { isNativeShell, getNativePlatform, getNetworkStatus } from "./native-shell.js";

window.__swiftgoNative = { isNativeShell, getNativePlatform, getNetworkStatus };
window.__SWIFTGO_ANDROID_PACKAGE__ = "com.swiftgo.partner";

const KARACHI = [24.8607, 67.0011];

const PARTNER_VIEW_TITLES = {
  home: "ہوم",
  dashboard: "ڈیش بورڈ",
  fleet: "میری گاڑیاں",
  rides: "میری سواریاں",
  earnings: "کمائی",
  wallet: "والٹ",
};

const PARTNER_VIEWS = new Set(["home", "dashboard", "fleet", "rides", "earnings", "wallet"]);

const els = {
  app: document.getElementById("partnerShell"),
  partnerShell: document.getElementById("partnerShell"),
  partnerSidebar: document.getElementById("partnerSidebar"),
  mobileNavRail: document.getElementById("mobileNavRail"),
  mobileNavBackdrop: document.getElementById("mobileNavBackdrop"),
  mobileNavDrawerTab: document.getElementById("mobileNavDrawerTab"),
  partnerContent: document.getElementById("partnerContent"),
  viewTitle: document.getElementById("partnerViewTitle"),
  topbarActions: document.getElementById("partnerTopbarActions"),
  navDashboard: document.getElementById("navDashboard"),
  navHome: document.getElementById("navHome"),
  sidebarName: document.getElementById("driverSidebarName"),
  sidebarMeta: document.getElementById("driverSidebarMeta"),
  navFleet: document.getElementById("navFleet"),
  navWallet: document.getElementById("navWallet"),
  dashboardSection: document.getElementById("dashboardSection"),
  fleetSection: document.getElementById("fleetSection"),
  walletSection: document.getElementById("walletSection"),
  dashboardWalletBalance: document.getElementById("dashboardWalletBalance"),
  dashboardTotalEarnings: document.getElementById("dashboardTotalEarnings"),
  dashboardTotalRides: document.getElementById("dashboardTotalRides"),
  sidebarLogoutBtn: document.getElementById("partnerSidebarLogoutBtn"),
  btnReturnToOwner: document.getElementById("btnReturnToOwner"),
  authOverlay: document.getElementById("driverAuthOverlay"),
  googleLoginBtn: document.getElementById("driverGoogleLoginBtn"),
  authStatus: document.getElementById("driverAuthStatus"),
  header: document.getElementById("partnerHeader"),
  mapElement: null,
  statusToggle: document.getElementById("driverStatusToggle"),
  statusText: document.getElementById("driverStatusText"),
  availDiag: document.getElementById("driverAvailDiag"),
  earningsCard: document.getElementById("driverEarningsCard"),
  driverWalletBalance: document.getElementById("driverWalletBalance"),
  driverWalletWarning: document.getElementById("driverWalletWarning"),
  driverTotalEarnings: document.getElementById("driverTotalEarnings"),
  driverTotalRides: document.getElementById("driverTotalRides"),
  requestSheet: document.getElementById("incomingRideSheet"),
  pickup: document.getElementById("incomingPickup"),
  dropoff: document.getElementById("incomingDropoff"),
  distance: document.getElementById("incomingDistance"),
  time: document.getElementById("incomingTime"),
  fare: document.getElementById("incomingFare"),
  acceptBtn: document.getElementById("acceptRideBtn"),
  declineBtn: document.getElementById("declineRideBtn"),
  activeRideSheet: document.getElementById("activeRideSheet"),
  activeRideStatusTitle: document.getElementById("activeRideStatusTitle"),
  activeRidePickup: document.getElementById("activeRidePickup"),
  activeRideDropoff: document.getElementById("activeRideDropoff"),
  activeRideFare: document.getElementById("activeRideFare"),
  activeRideRateBtn: document.getElementById("activeRideRateBtn"),
  activeRideActionBtn: document.getElementById("activeRideActionBtn"),
  activeRideCancelBtn: document.getElementById("activeRideCancelBtn"),
  rideCompleteSheet: document.getElementById("rideCompleteSheet"),
  rideCompleteFare: document.getElementById("rideCompleteFare"),
  findNewRideBtn: document.getElementById("findNewRideBtn"),
  ownerDashboard: document.getElementById("ownerDashboard"),
  ownerVehicleGrid: document.getElementById("ownerVehicleGrid"),
  ownerVehicleEmpty: document.getElementById("ownerVehicleEmpty"),
  ownerVehicleCount: document.getElementById("ownerVehicleCount"),
  ownerOnlineCount: document.getElementById("ownerOnlineCount"),
  ownerOfflineCount: document.getElementById("ownerOfflineCount"),
  ownerMessage: document.getElementById("ownerDashboardMessage"),
  ownerRideList: document.getElementById("ownerRideList"),
  ownerRideEmpty: document.getElementById("ownerRideEmpty"),
  ownerRideCount: document.getElementById("ownerRideCount"),
  ownerRideMessage: document.getElementById("ownerRideHistoryMessage"),
  addVehicleBtn: document.getElementById("addVehicleBtn"),
  vehicleModal: document.getElementById("vehicleModal"),
  vehicleModalBackdrop: document.getElementById("vehicleModalBackdrop"),
  vehicleModalClose: document.getElementById("vehicleModalClose"),
  vehicleForm: document.getElementById("vehicleForm"),
  vehicleModelInput: document.getElementById("vehicleModelInput"),
  vehiclePlateInput: document.getElementById("vehiclePlateInput"),
  vehicleFormMessage: document.getElementById("vehicleFormMessage"),
  vehicleSaveBtn: document.getElementById("vehicleSaveBtn"),
  pinGate: document.getElementById("vehiclePinGate"),
  pinForm: document.getElementById("vehiclePinForm"),
  pinInput: document.getElementById("vehiclePinInput"),
  pinMessage: document.getElementById("vehiclePinMessage"),
  pinVerifyBtn: document.getElementById("vehiclePinVerifyBtn"),
  roleOverlay: document.getElementById("roleSelectionOverlay"),
  roleMessage: document.getElementById("roleSelectionMessage"),
  selectDriverRoleBtn: document.getElementById("selectDriverRoleBtn"),
  selectOwnerRoleBtn: document.getElementById("selectOwnerRoleBtn"),
  roleLogoutBtn: document.getElementById("roleSelectionLogoutBtn"),
  pinLogoutBtn: document.getElementById("pinGateLogoutBtn"),
  blockedOverlay: document.getElementById("accountBlockedOverlay"),
  blockedLogoutBtn: document.getElementById("accountBlockedLogoutBtn"),
  rideHistorySection: document.getElementById("rideHistorySection"),
  driverRideHistoryList: document.getElementById("driverRideHistoryList"),
  driverRideHistoryEmpty: document.getElementById("driverRideHistoryEmpty"),
  openRideRadarBtn: document.getElementById("openRideRadarBtn"),
  rideRadarRoot: document.getElementById("rideRadarRoot"),
  driverToastEl: document.getElementById("driverToast"),
  connectingOverlay: document.getElementById("driverConnectingOverlay"),
  connectingOverlayText: document.getElementById("driverConnectingOverlayText"),
};

let map = null;
let locationMarker = null;
let accuracyCircle = null;
let watchId = null;
let online = false;
/** OFFLINE → LOCATING → WRITING_GEO → ONLINE_READY (matchable only at ONLINE_READY). */
const ONLINE_READINESS = Object.freeze({
  OFFLINE: "offline",
  LOCATING: "locating",
  WRITING_GEO: "writing_geo",
  ONLINE_READY: "online_ready",
});
let onlineReadiness = ONLINE_READINESS.OFFLINE;
/** @type {Promise<boolean> | null} */
let onlineActivationPromise = null;
/** @type {AbortController | null} */
let onlineActivationAbort = null;
/** Dedupe radar listener restarts when eligibility unchanged. */
let lastRadarListenKey = "";
let hasCenteredOnDriver = false;
let currentDriver = null;
let activeRequest = null;
let hideSheetTimer = null;
let unsubscribeRides = () => {};
let unsubscribeVehicles = () => {};
let unsubscribeOwnerRides = () => {};
let unsubscribePartnerDoc = () => {};
let unsubscribeActiveRide = () => {};
let authSequence = 0;
let partnerMode = null;
let ownerVehicles = [];
let ownerRides = [];
let linkedVehicle = null;
let partnerAccountBlocked = false;
/** @type {null | { id: string, status?: string, [key: string]: unknown }} */
let activeExecutionRide = null;
let activeRideCompletionInFlight = false;
let activeRideRecoveryPending = false;
let cachedWalletThreshold = -500;
let walletLocked = false;
let partnerView = "home";
let lastVehicleLocationWrite = 0;
let lastVehicleLocationLatLng = null;
let lastVehicleStatusWritten = "";
/** Idle / dispatch ONLINE_READY location interval (unchanged by presence). */
const VEHICLE_LOCATION_WRITE_MS = RESPONSIVE_INTERVAL_MS;
/** @deprecated use checkpoint policy — kept as alias for diagnostics/tests */
const ACTIVE_RIDE_LOCATION_WRITE_MS = RESPONSIVE_INTERVAL_MS;
void ACTIVE_RIDE_LOCATION_WRITE_MS;
/** Skip Firestore write until driver moves at least this far (meters) — owned by policy module. */
void MIN_LOCATION_MOVE_M;
/** Phase 1 tracking session — new id on each ONLINE_READY / watch start. */
let locationTrackingSessionId = "";
let locationTrackingSequence = 0;
/** When true, next vehicle write stamps server-controlled trackingSessionStartedAt. */
let locationTrackingSessionStartPending = false;
/** Generation token — late GPS callbacks after stop are ignored. */
let locationTrackingGeneration = 0;
/** @type {object|null} */
let lastAcceptedLocationEnvelope = null;
const locationDiagCounters = createLocationDiagCounters();

function checkpointDiag(code) {
  try {
    console.info(JSON.stringify({ type: "checkpoint_policy_diag", reason: String(code || "") }));
  } catch {
    /* ignore */
  }
}

const checkpointPolicy = createCheckpointPolicyController({
  diag: checkpointDiag,
});

const viewerPresenceConsumer = createViewerPresenceConsumer({
  subscribeDoc: ({ collection: col, id }, onNext, onError) => {
    try {
      const { db } = getFirebase();
      return onSnapshot(
        doc(db, col, id),
        (snap) => {
          onNext({
            exists: snap.exists(),
            data: snap.exists() ? snap.data() : null,
          });
        },
        (err) => onError(err)
      );
    } catch (err) {
      onError(err);
      return () => {};
    }
  },
  onLeaseChange: (lease) => {
    checkpointPolicy.setViewerLease(lease, { fromPresenceEvent: true });
    maybeFlushImmediateCheckpoint();
  },
  onDiag: checkpointDiag,
  isCurrentGeneration: (gen) => checkpointPolicy.isCurrentGeneration(gen),
});

if (typeof window !== "undefined") {
  window.__SWIFTGO_CHECKPOINT_COUNTERS__ = () => checkpointPolicy.getCounters();
  window.addEventListener("online", () => {
    if (activeExecutionRide?.id && isOnlineReady()) {
      checkpointPolicy.requestImmediate("network_online");
      maybeFlushImmediateCheckpoint();
    }
  });
}

function syncCheckpointPresenceForActiveRide() {
  const ride = activeExecutionRide;
  const status = String(ride?.status || "");
  if (!ride?.id || !ACTIVE_EXECUTION_STATUSES.has(status)) {
    viewerPresenceConsumer.unbind();
    checkpointPolicy.setActiveRide({ active: false });
    return;
  }
  const result = checkpointPolicy.setActiveRide({
    rideId: ride.id,
    status,
    active: true,
  });
  const customerUid = String(ride.userId || "").trim();
  if (!customerUid) {
    viewerPresenceConsumer.unbind();
    checkpointPolicy.setViewerLease(VIEWER_LEASE.UNKNOWN);
    return;
  }
  viewerPresenceConsumer.bind({
    rideId: ride.id,
    customerUid,
    generation: result.generation,
  });
  void presenceDocId; // available for tests / diagnostics without logging IDs
  maybeFlushImmediateCheckpoint();
}

function detachCheckpointPresence(reason = "") {
  void reason;
  viewerPresenceConsumer.unbind();
  checkpointPolicy.setActiveRide({ active: false });
}

function maybeFlushImmediateCheckpoint() {
  if (!checkpointPolicy.hasImmediatePending()) return;
  if (!isOnlineReady() || !linkedVehicle?.id || !lastDriverPosition) return;
  void syncVehicleLocationToFirestore(lastDriverPosition.lat, lastDriverPosition.lng, {
    force: true,
  });
}

/** Single in-flight vehicle location write; newest pending fix coalesced. */
const locationWriteSerializer = createLocationWriteSerializer({
  isCancelled: (generation) =>
    generation !== locationTrackingGeneration || !locationTrackingSessionId,
  writeFn: async (job) => {
    await commitVehicleLocationJob(job);
  },
});

function beginLocationTrackingSession() {
  locationTrackingSessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  locationTrackingSequence = 0;
  lastAcceptedLocationEnvelope = null;
  locationTrackingSessionStartPending = true;
  locationTrackingGeneration += 1;
  locationWriteSerializer.cancelAll();
  locationWriteSerializer.resetSessionStartGate();
  if (activeExecutionRide?.id) {
    checkpointPolicy.requestImmediate("session_change");
  }
}

function endLocationTrackingSession() {
  locationTrackingSessionId = "";
  locationTrackingSequence = 0;
  lastAcceptedLocationEnvelope = null;
  locationTrackingSessionStartPending = false;
  locationTrackingGeneration += 1;
  locationWriteSerializer.cancelAll();
}

function nextLocationSequence() {
  locationTrackingSequence += 1;
  return locationTrackingSequence;
}
/** Last successful browser GPS fix (ms) — diagnostic only, never shown as exact coords. */
let lastGpsFixAtMs = 0;
let lastGpsErrorCode = "";
let locationPermissionState = "unknown";
/** Last match-geoCell written to Firestore (force write when this changes). */
let lastMatchGeoCell = null;
/** Last vehicle location sync error message (diag only). */
let lastLocationSyncError = "";
/** Soft GPS: consecutive transient failures before forcing offline. */
let transientGpsFailCount = 0;
const TRANSIENT_GPS_FAIL_LIMIT = 3;
const FRESH_GPS_MS = 2 * 60 * 1000;
/** ~1 km Karachi grid cell for zone-change writes (approved model). */
const LOCATION_GRID_DEG = 0.009;
/** ~400 m matching cell (Phase 3B geo-scoped dispatch). */
const MATCH_GEO_DEG = 0.0036;
const GOLDEN_HOTSPOTS = Object.freeze([
  { id: "hs_clifton", lat: 24.8138, lng: 67.0225 },
  { id: "hs_saddar", lat: 24.86, lng: 67.0011 },
  { id: "hs_gulshan", lat: 24.9056, lng: 67.0822 },
  { id: "hs_defence", lat: 24.805, lng: 67.065 },
  { id: "hs_north_nazimabad", lat: 24.935, lng: 67.035 },
  { id: "hs_airport", lat: 24.9065, lng: 67.1608 },
  { id: "hs_tariq_road", lat: 24.873, lng: 67.06 },
  { id: "hs_bahadurabad", lat: 24.882, lng: 67.07 },
]);
function isValidCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function matchGeoCellId(lat, lng) {
  if (!isValidCoord(lat, lng)) return null;
  return `g_${Math.floor(Number(lat) / MATCH_GEO_DEG)}_${Math.floor(Number(lng) / MATCH_GEO_DEG)}`;
}
function matchHotspotId(lat, lng) {
  if (!isValidCoord(lat, lng)) return null;
  const R = 6371;
  let best = null;
  let bestKm = Infinity;
  for (const hs of GOLDEN_HOTSPOTS) {
    const dLat = ((hs.lat - lat) * Math.PI) / 180;
    const dLng = ((hs.lng - lng) * Math.PI) / 180;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat * Math.PI) / 180) * Math.cos((hs.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(s));
    if (km < bestKm) {
      bestKm = km;
      best = hs;
    }
  }
  return best && bestKm <= 0.5 ? best.id : null;
}
let lastLocationGridCell = null;
let unsubscribeDriverRideHistory = () => {};
let driverRidesCache = [];
/** @type {ReturnType<typeof initEarningsDetail> | null} */
let earningsUi = null;
/** @type {ReturnType<typeof initDriverDashboard> | null} */
let dashboardUi = null;
/** @type {ReturnType<typeof initDriverHome> | null} */
let homeUi = null;
/** @type {ReturnType<typeof initRideRadarFlow> | null} */
let rideRadarUi = null;
/** @type {ReturnType<typeof createDriverOfferInbox> | null} */
let driverOfferInbox = null;
let radarFeedUnsub = () => {};
let availableRadarCount = 0;
let radarListenerMeta = {
  invitedCandidateCount: 0,
  rideFetchErrors: 0,
  listenerError: "",
};
let radarFeedPrimed = false;
let lastRadarFeedCount = 0;
/** @type {{ lat: number, lng: number } | null} */
let lastDriverPosition = null;

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

function isOnlineReady() {
  return online && onlineReadiness === ONLINE_READINESS.ONLINE_READY;
}

function syncOnlineToggleUi(value, connectingPhase = "") {
  const btn = els.statusToggle;
  const connecting = Boolean(connectingPhase);
  if (btn) {
    btn.classList.remove("is-online");
    btn.classList.toggle("is-online", value && !connecting);
    btn.classList.toggle("is-connecting", connecting);
    btn.setAttribute("aria-checked", String(value && !connecting));
    btn.setAttribute(
      "aria-label",
      connecting
        ? "لوکیشن/sync جاری ہے"
        : value
          ? t("statusToggleAriaOffline")
          : t("statusToggleAria")
    );
    btn.disabled = connecting;
  }
  let label = value ? t("statusOnline") : t("statusOffline");
  if (connectingPhase === ONLINE_READINESS.LOCATING) {
    label = "لوکیشن حاصل ہو رہی ہے…";
  } else if (connectingPhase === ONLINE_READINESS.WRITING_GEO) {
    label = "مقام سرور پر محفوظ ہو رہا ہے…";
  }
  if (els.statusText) els.statusText.textContent = label;
}

function showConnectingOverlay(phase = ONLINE_READINESS.LOCATING) {
  const root = els.connectingOverlay;
  if (!root) return;
  const text =
    phase === ONLINE_READINESS.WRITING_GEO
      ? "مقام سرور پر محفوظ ہو رہا ہے…"
      : "لوکیشن حاصل ہو رہی ہے…";
  if (els.connectingOverlayText) els.connectingOverlayText.textContent = text;
  root.hidden = false;
  els.app?.classList.add("is-connecting-online");
}

function hideConnectingOverlay() {
  if (els.connectingOverlay) els.connectingOverlay.hidden = true;
  els.app?.classList.remove("is-connecting-online");
}

function cancelOnlineActivation({ silent = true } = {}) {
  onlineActivationAbort?.abort();
  onlineActivationAbort = null;
  freshLocationService.invalidate();
  hideConnectingOverlay();
  if (!silent) {
    logOnlineReadinessEvent("locating_cancelled", { state: "offline" });
  }
}

function failOnlineActivation(error, { silent = false } = {}) {
  const category = String(error?.category || error?.message || "unknown");
  onlineReadiness = ONLINE_READINESS.OFFLINE;
  online = false;
  hideConnectingOverlay();
  syncOnlineToggleUi(false);
  paintDriverAvailabilityDiag();
  if (silent || category === LOCATION_FAILURE.CANCELLED) return;
  const msg =
    LOCATION_FAILURE_URDU[category] ||
    (category.includes("sync") || category.includes("GEO")
      ? "مقام سرور پر محفوظ نہیں ہو سکا — دوبارہ کوشش کریں"
      : "آن لائن نہیں ہو سکے — دوبارہ کوشش کریں");
  setLocationMessage(msg);
  driverToast(msg);
}

function readinessOnEvent(event, meta = {}) {
  logOnlineReadinessEvent(event, {
    ...meta,
    state: onlineReadiness,
  });
}

function setConnectingUi(phase) {
  online = false;
  onlineReadiness = phase;
  syncOnlineToggleUi(false, phase);
  showConnectingOverlay(phase);
  paintDriverAvailabilityDiag();
}

function setOnlineUi(value) {
  online = value;
  onlineReadiness = value ? ONLINE_READINESS.ONLINE_READY : ONLINE_READINESS.OFFLINE;
  if (!value) lastRadarListenKey = "";
  syncOnlineToggleUi(value);
  syncRideRadarFab();
  paintDriverAvailabilityDiag();
}

/**
 * Small readiness strip — no exact coordinates exposed.
 */
function paintDriverAvailabilityDiag() {
  const el = els.availDiag;
  if (!el) return;
  const matchingReady =
    isOnlineReady() &&
    linkedVehicle?.id &&
    !activeExecutionRide?.id &&
    lastGpsFixAtMs > 0 &&
    Date.now() - lastGpsFixAtMs <= 10 * 60 * 1000 &&
    lastVehicleLocationWrite > 0 &&
    Boolean(lastMatchGeoCell) &&
    !lastLocationSyncError &&
    Date.now() - lastVehicleLocationWrite <= 2 * 60 * 1000;

  let msg = "";
  if (partnerAccountBlocked) {
    msg = "اکاؤنٹ بلاک/معطل ہے — درخواستیں نہیں ملیں گی";
  } else if (activeRideRecoveryPending) {
    msg = ACTIVE_RIDE_RECOVERY_URDU;
  } else if (!linkedVehicle?.id) {
    msg = "گاڑی منسلک نہیں — پہلے PIN سے لنک کریں";
  } else if (onlineReadiness === ONLINE_READINESS.LOCATING) {
    msg = "لوکیشن حاصل ہو رہی ہے — میچنگ ابھی شروع نہیں ہوئی";
  } else if (onlineReadiness === ONLINE_READINESS.WRITING_GEO) {
    msg = "مقام سرور پر لکھا جا رہا ہے — تھوڑی دیر انتظار کریں";
  } else if (!online) {
    msg = "آف لائن — قریبی درخواستوں کے لیے آن لائن ہوں";
  } else if (activeExecutionRide?.id) {
    msg = "آپ ایک فعال سواری پر مصروف ہیں";
  } else if (lastGpsErrorCode === "permission_denied") {
    msg = "لوکیشن کی اجازت درکار ہے";
  } else if (lastLocationSyncError) {
    msg = "سرور پر لوکیشن نہیں لکھی جا سکی — نیٹ ورک/اجازت چیک کریں";
  } else if (!lastGpsFixAtMs) {
    msg = "لوکیشن نہیں ملی — GPS چیک کریں";
  } else if (Date.now() - lastGpsFixAtMs > 10 * 60 * 1000) {
    msg = "لوکیشن پرانی ہے — مقام تازہ کریں";
  } else if (!lastVehicleLocationWrite || !lastMatchGeoCell) {
    msg = "میچنگ کے لیے لوکیشن سنک ہو رہی ہے…";
  } else if (Date.now() - lastVehicleLocationWrite > 2 * 60 * 1000) {
    msg = "سرور پر لوکیشن سنک رک گئی — دوبارہ آن لائن کریں";
  } else if (radarListenerMeta.listenerError === "permission_denied") {
    msg = "دعوتیں نہیں پڑھ سکتیں — Firestore اجازت مسترد";
  } else if (radarListenerMeta.listenerError === "missing_index") {
    msg = "دعوتیں نہیں پڑھ سکتیں — Firestore index غائب";
  } else if (radarListenerMeta.listenerError === "failed_precondition") {
    msg = "دعوتیں نہیں پڑھ سکتیں — query precondition ناکام";
  } else if (
    radarListenerMeta.invitedCandidateCount > 0 &&
    availableRadarCount === 0 &&
    radarListenerMeta.rideFetchErrors > 0
  ) {
    msg = `دعوت ${radarListenerMeta.invitedCandidateCount} ملی مگر سواری پڑھ نہیں سکی`;
  } else if (matchingReady) {
    msg = "میچنگ تیار — قریبی درخواستیں موصول ہو سکتی ہیں";
  } else {
    msg = "آن لائن اور قریبی درخواستوں کے لیے تیار";
  }
  el.textContent = msg;
  el.hidden = !msg;
  el.dataset.state = partnerAccountBlocked
    ? "blocked"
    : activeRideRecoveryPending
      ? "active_ride_no_vehicle"
      : !linkedVehicle?.id
      ? "no_vehicle"
      : onlineReadiness === ONLINE_READINESS.LOCATING
        ? "locating"
        : onlineReadiness === ONLINE_READINESS.WRITING_GEO
          ? "writing_geo"
          : !online
        ? "offline"
        : activeExecutionRide?.id
          ? "busy"
          : lastGpsErrorCode === "permission_denied"
            ? "need_permission"
            : lastLocationSyncError
              ? "sync_error"
              : !lastGpsFixAtMs
                ? "no_location"
                : !lastVehicleLocationWrite || !lastMatchGeoCell
                  ? "syncing"
                  : matchingReady
                    ? "matching_ready"
                    : "ready";
}

let driverToastTimer = 0;

function driverToast(message) {
  if (!message) return;
  console.info("[SwiftGo Driver]", message);
  if (!els.driverToastEl) return;
  els.driverToastEl.textContent = message;
  els.driverToastEl.hidden = false;
  window.clearTimeout(driverToastTimer);
  driverToastTimer = window.setTimeout(() => {
    if (els.driverToastEl) els.driverToastEl.hidden = true;
  }, 4200);
}

function setLocationMessage(message) {
  driverToast(message);
}

function setAuthStatus(message = "") {
  if (els.authStatus) els.authStatus.textContent = message;
}

function setLoginBusy(busy) {
  if (!els.googleLoginBtn) return;
  els.googleLoginBtn.disabled = busy;
  const label = els.googleLoginBtn.querySelector("span");
  if (label) {
    label.textContent = busy ? "اکاؤنٹ تیار کیا جا رہا ہے..." : "Google سے لاگ ان کریں";
  }
}

/** @type {null | (() => void)} */
let releaseAuthTrap = null;

function showAuthOverlay(message = "") {
  if (!els.authOverlay) return;
  els.authOverlay.hidden = false;
  requestAnimationFrame(() => els.authOverlay?.classList.remove("is-hidden"));
  setAuthStatus(message);
  releaseAuthTrap?.();
  releaseAuthTrap = trapFocus(els.authOverlay, {
    dismissible: false,
    initialFocus: els.googleLoginBtn,
  });
}

function hideAuthOverlay() {
  releaseAuthTrap?.();
  releaseAuthTrap = null;
  els.authOverlay?.classList.add("is-hidden");
  window.setTimeout(() => {
    if (els.authOverlay?.classList.contains("is-hidden")) {
      els.authOverlay.hidden = true;
    }
  }, 340);
}

async function ensureDevDriverProfile(user) {
  const { db } = getFirebase();
  const driverRef = doc(db, "drivers", user.uid);
  const snapshot = await getDoc(driverRef);
  if (snapshot.exists()) return snapshot.data();

  const profile = {
    uid: user.uid,
    name: user.displayName || "SwiftGo Driver",
    email: user.email || "",
    isApproved: true,
    vehicleType: "گو",
    createdAt: serverTimestamp(),
  };
  await setDoc(driverRef, profile);
  return profile;
}

function finishDriverSessionEntry() {
  hideAuthOverlay();
  setLoginBusy(false);
  setAuthStatus("");
}

function isStaleAuthSequence(sequence) {
  return sequence !== authSequence;
}

/** True when at least one entry surface (auth / PIN / shell / blocked) is visible. */
function hasVisibleEntrySurface() {
  const authVisible =
    Boolean(els.authOverlay) &&
    !els.authOverlay.hidden &&
    !els.authOverlay.classList.contains("is-hidden");
  const pinVisible = Boolean(els.pinGate) && !els.pinGate.hidden;
  const shellVisible = Boolean(els.partnerShell) && !els.partnerShell.hidden;
  const blockedVisible = Boolean(els.blockedOverlay) && !els.blockedOverlay.hidden;
  return authVisible || pinVisible || shellVisible || blockedVisible;
}

/**
 * If a superseded route left nothing on screen, recover to auth.
 * Newer activations own the UI; only recover when this sequence is still current.
 */
function recoverEntrySurfaceIfBlank(sequence, message = "") {
  if (isStaleAuthSequence(sequence)) return;
  if (hasVisibleEntrySurface()) return;
  setLoginBusy(false);
  setAuthStatus(message || "سیشن مکمل نہیں ہوا — دوبارہ لاگ اِن کریں۔");
  showAuthOverlay(message || "سیشن مکمل نہیں ہوا — دوبارہ لاگ اِن کریں۔");
}

function markDriverAppSurface() {
  try {
    sessionStorage.setItem("swiftgo_app_surface", "partner");
  } catch {
    /* ignore */
  }
}

/** On /partner/: stay here — do not rewrite role or open Owner app. */
function stayOnDriverSurface(partner) {
  return partner || { role: "driver" };
}

async function activateAuthenticatedDriver(user) {
  const sequence = ++authSequence;
  setLoginBusy(true);
  setAuthStatus("ڈرائیور پروفائل لوڈ کیا جا رہا ہے...");
  currentDriver = user;
  hideAccountBlockedOverlay();
  showAuthOverlay("ڈرائیور پروفائل لوڈ کیا جا رہا ہے...");

  try {
    const { db } = getFirebase();
    startPartnerDocListener(user.uid, sequence);

    let partnerSnapshot = await getDoc(doc(db, "partners", user.uid));
    if (isStaleAuthSequence(sequence)) return;

    // First visit only — never overwrite an existing owner/driver role (same Gmail multi-app).
    if (!partnerSnapshot.exists() || !partnerSnapshot.data().role) {
      if (partnerAccountBlocked) {
        showAccountBlockedOverlay();
        return;
      }
      await setDoc(
        doc(db, "partners", user.uid),
        {
          uid: user.uid,
          role: "driver",
          currentVehicleId: null,
          walletBalance: 0,
          email: user.email || "",
          name: user.displayName || "Driver",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      if (isStaleAuthSequence(sequence)) return;
      partnerSnapshot = await getDoc(doc(db, "partners", user.uid));
      if (isStaleAuthSequence(sequence)) return;
    }

    let partner = stayOnDriverSurface(
      partnerSnapshot.exists() ? partnerSnapshot.data() : { role: "driver" }
    );
    console.log(
      "Current User Role:",
      partner.role,
      "Status:",
      partner.status || partner.accountStatus || "unknown"
    );

    if (partner.accountStatus === "blocked") {
      partnerAccountBlocked = true;
      showAccountBlockedOverlay();
      return;
    }

    // Legacy God Mode / mode-switch roles → normalize to driver.
    if (partner.role === "admin_driver") {
      try {
        await setDoc(
          doc(db, "partners", user.uid),
          {
            role: "driver",
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        if (isStaleAuthSequence(sequence)) return;
        partner = { ...partner, role: "driver" };
      } catch (stripError) {
        console.warn("[SwiftGo Driver] could not clear admin_driver", stripError);
        partner = { ...partner, role: "driver" };
      }
    }

    // Driver and Owner surfaces share the same Google account — allow driver flow on /partner/
    // without forcing a role rewrite that would bounce /owner/ away later.
    if (partner.role === "driver" || partner.role === "owner") {
      await routeDriver(partner.currentVehicleId || null, sequence, partner);
      recoverEntrySurfaceIfBlank(sequence);
      return;
    }

    finishDriverSessionEntry();
    setAuthStatus("یہ اکاؤنٹ ڈرائیور ایپ کے لیے نہیں ہے۔");
    showAuthOverlay("یہ اکاؤنٹ ڈرائیور ایپ کے لیے نہیں ہے۔");
  } catch (error) {
    console.warn("[SwiftGo Driver] auth routing", error);
    if (isStaleAuthSequence(sequence)) return;
    setLoginBusy(false);
    setAuthStatus("پروفائل لوڈ نہیں ہو سکا، دوبارہ کوشش کریں۔");
    showAuthOverlay("پروفائل لوڈ نہیں ہو سکا، دوبارہ کوشش کریں۔");
  }
}

/* ── Phase 29: Super Admin block / unblock enforcement ── */

function isPartnerBlocked(partner) {
  return partner?.accountStatus === "blocked";
}

function showAccountBlockedOverlay() {
  hideProtectedUi();
  hideAuthOverlay();
  hideIncomingRide();
  closeVehicleModal?.();
  if (els.blockedOverlay) els.blockedOverlay.hidden = false;
}

function hideAccountBlockedOverlay() {
  if (els.blockedOverlay) els.blockedOverlay.hidden = true;
}

function stopPartnerDocListener() {
  unsubscribePartnerDoc();
  unsubscribePartnerDoc = () => {};
}

function updateDriverEarningsUi(partner) {
  const earnings = Number(partner?.totalEarnings ?? 0);
  const rides = Number(partner?.totalRidesCompleted ?? 0);
  const earningsText = `Rs. ${Math.round(
    Number.isFinite(earnings) && earnings >= 0 ? earnings : 0
  ).toLocaleString("en-PK")}`;
  const ridesText = String(Number.isFinite(rides) && rides >= 0 ? Math.round(rides) : 0);

  if (els.driverTotalEarnings) els.driverTotalEarnings.textContent = earningsText;
  if (els.dashboardTotalEarnings) els.dashboardTotalEarnings.textContent = earningsText;
  if (els.driverTotalRides) els.driverTotalRides.textContent = ridesText;
  if (els.dashboardTotalRides) els.dashboardTotalRides.textContent = ridesText;
}

function normalizeWalletBalance(partner) {
  const value = Number(partner?.walletBalance ?? 0);
  return Number.isFinite(value) ? value : 0;
}

async function loadWalletThreshold() {
  try {
    const { db } = getFirebase();
    const snap = await getDoc(doc(db, "settings", "pricing"));
    if (!snap.exists()) {
      cachedWalletThreshold = -500;
      return cachedWalletThreshold;
    }
    const value = Number(snap.data()?.walletThreshold ?? -500);
    cachedWalletThreshold = Number.isFinite(value) ? value : -500;
    return cachedWalletThreshold;
  } catch (error) {
    console.warn("[SwiftGo Partner] wallet threshold", error);
    cachedWalletThreshold = -500;
    return cachedWalletThreshold;
  }
}

function setOnlineToggleLocked(locked, message = "") {
  walletLocked = locked;
  if (els.statusToggle) {
    els.statusToggle.disabled = locked;
    els.statusToggle.classList.toggle("is-wallet-locked", locked);
    els.statusToggle.setAttribute("aria-disabled", String(locked));
  }
  if (locked && message) {
    setLocationMessage(message);
  }
}

function updateDriverWalletUi(partner) {
  const balance = normalizeWalletBalance(partner);
  const threshold = cachedWalletThreshold;
  const overLimit = balance <= threshold;
  const balanceText = `Rs. ${Math.round(balance).toLocaleString("en-PK")}`;

  if (els.driverWalletBalance) {
    els.driverWalletBalance.textContent = balanceText;
    els.driverWalletBalance.classList.toggle("is-danger", overLimit);
  }
  if (els.dashboardWalletBalance) {
    els.dashboardWalletBalance.textContent = balanceText;
    els.dashboardWalletBalance.classList.toggle("is-danger", overLimit);
  }
  if (els.driverWalletWarning) {
    els.driverWalletWarning.hidden = !overLimit;
  }

  if (overLimit) {
    setOnlineToggleLocked(
      true,
      "والٹ بیلنس حد سے تجاوز — آن لائن جانے سے پہلے ریچارج کریں"
    );
    if (online) {
      setDriverOffline("والٹ بیلنس حد سے تجاوز — آپ آف لائن کر دیے گئے ہیں");
    }
  } else if (!partnerAccountBlocked) {
    setOnlineToggleLocked(false);
  }
}

function startPartnerDocListener(uid, sequence) {
  stopPartnerDocListener();
  const { db } = getFirebase();
  if (!db || !uid) return;

  loadWalletThreshold().catch(() => {});

  unsubscribePartnerDoc = onSnapshot(
    doc(db, "partners", uid),
    (snapshot) => {
      if (isStaleAuthSequence(sequence)) return;
      if (!currentDriver || currentDriver.uid !== uid) return;

      const partner = snapshot.exists() ? snapshot.data() : null;
      updateDriverEarningsUi(partner || {});
      updateDriverWalletUi(partner || {});

      if (isPartnerBlocked(partner)) {
        const wasAlreadyBlocked = partnerAccountBlocked;
        partnerAccountBlocked = true;
        showAccountBlockedOverlay();
        if (!wasAlreadyBlocked) {
          console.info("[SwiftGo Partner] account blocked by Super Admin");
        }
        return;
      }

      if (partnerAccountBlocked) {
        partnerAccountBlocked = false;
        hideAccountBlockedOverlay();
        // Resume with same sequence — do NOT call activateAuthenticatedDriver
        // (that bumps authSequence and cancels in-flight routeDriver → blank screen).
        void routeDriver(partner?.currentVehicleId || null, authSequence, partner || {});
        return;
      }

      if (
        partner?.activeRideId &&
        !activeExecutionRide?.id &&
        linkedVehicle?.id &&
        currentDriver?.uid
      ) {
        void restoreActiveExecutionRide(partner);
      }
    },
    (error) => {
      console.warn("[SwiftGo Partner] Firestore listen retry... partners", error);
    }
  );
}

/* ── Phase 41.5: sidebar SPA routing ── */

function setActiveView(view = "home") {
  const prev = partnerView;
  const key = PARTNER_VIEWS.has(view) ? view : "home";
  partnerView = key;

  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const match = panel.dataset.viewPanel === key;
    panel.hidden = !match;
    panel.classList.toggle("is-active", match);
  });

  document.querySelectorAll(".partner-nav-item[data-view]").forEach((btn) => {
    const active = btn.dataset.view === key;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-current", active ? "page" : "false");
  });

  if (els.viewTitle) els.viewTitle.textContent = PARTNER_VIEW_TITLES[key] || key;
  if (els.partnerContent) {
    els.partnerContent.dataset.activeView = key;
    els.partnerContent.classList.toggle("is-earnings-view", key === "earnings");
  }

  if (els.topbarActions) {
    els.topbarActions.hidden = key === "earnings";
  }

  if (prev === "earnings" && key !== "earnings") {
    earningsUi?.deactivate();
  }
  if (key === "earnings") {
    earningsUi?.activate();
  }

  if (key === "dashboard") {
    dashboardUi?.activate();
    requestAnimationFrame(() => {
      try {
        if (dashboardUi && typeof dashboardUi.resize === "function") {
          dashboardUi.resize();
        }
      } catch (error) {
        console.warn("[SwiftGo Driver] dashboard resize", error);
      }
    });
  } else if (prev === "dashboard" && key !== "dashboard") {
    dashboardUi?.deactivate();
  }

  if (prev === "home" && key !== "home") {
    homeUi?.deactivate();
  }
  if (key === "home") {
    homeUi?.activate();
    ensureDriverMap();
    requestAnimationFrame(() => {
      try {
        map?.invalidateSize?.();
        homeUi?.invalidateMap?.();
      } catch (error) {
        console.warn("[SwiftGo Driver] home map resize", error);
      }
    });
  }

  if (key !== "home") {
    rideRadarUi?.close();
  }
  syncRideRadarFab();
}

function configureNavForMode() {
  if (els.navFleet) els.navFleet.hidden = true;
  if (els.navDashboard) els.navDashboard.hidden = false;
  if (els.navWallet) els.navWallet.hidden = false;
  if (els.topbarActions) els.topbarActions.hidden = partnerView === "earnings";

  document.querySelectorAll('.partner-nav-item[data-view="rides"]').forEach((btn) => {
    btn.hidden = false;
  });
}

function showPartnerShell() {
  hidePinGate();
  if (els.partnerShell) els.partnerShell.hidden = false;
  syncMobileNavRailVisibility();
}

function hidePartnerShell() {
  if (els.partnerShell) els.partnerShell.hidden = true;
  closeMobileNavDrawer();
  syncMobileNavRailVisibility();
}

let mobileNavDrag = null;

function usesDriverSlideNav() {
  return Boolean(els.partnerShell?.classList.contains("driver-app") && !els.partnerShell.hidden);
}

function syncMobileNavRailVisibility() {
  const show = usesDriverSlideNav();
  if (els.mobileNavRail) els.mobileNavRail.hidden = !show;
  if (!show) closeMobileNavDrawer();
}

function closeMobileNavDrawer() {
  if (!els.partnerShell) return;
  els.partnerShell.classList.remove("is-nav-drawer-open", "is-nav-drawer-dragging");
  if (els.mobileNavRail) {
    els.mobileNavRail.setAttribute("aria-expanded", "false");
    els.mobileNavRail.setAttribute("aria-label", "مینو کھولیں");
  }
  if (els.mobileNavBackdrop) els.mobileNavBackdrop.hidden = true;
  if (els.partnerSidebar) els.partnerSidebar.style.transform = "";
  invalidateHomeMapIfActive();
}

function openMobileNavDrawer() {
  if (!usesDriverSlideNav()) return;
  els.partnerShell.classList.add("is-nav-drawer-open");
  els.partnerShell.classList.remove("is-nav-drawer-dragging");
  if (els.mobileNavRail) {
    els.mobileNavRail.setAttribute("aria-expanded", "true");
    els.mobileNavRail.setAttribute("aria-label", "مینو بند کریں");
  }
  if (els.mobileNavBackdrop) els.mobileNavBackdrop.hidden = false;
  if (els.partnerSidebar) els.partnerSidebar.style.transform = "";
  invalidateHomeMapIfActive();
}

function toggleMobileNavDrawer() {
  if (els.partnerShell?.classList.contains("is-nav-drawer-open")) {
    closeMobileNavDrawer();
  } else {
    openMobileNavDrawer();
  }
}

function getMobileNavPanelWidth() {
  return els.partnerSidebar?.offsetWidth || Math.min(window.innerWidth * 0.86, 280);
}

function readMobileNavTranslateX() {
  const raw = els.partnerSidebar?.style.transform || "";
  const match = raw.match(/translate3d\(([-\d.]+)px/);
  if (match) return Number(match[1]);
  return els.partnerShell?.classList.contains("is-nav-drawer-open") ? 0 : getMobileNavPanelWidth();
}

function setMobileNavTranslateX(px) {
  if (!els.partnerSidebar) return;
  const w = getMobileNavPanelWidth();
  const clamped = Math.max(0, Math.min(w, px));
  els.partnerSidebar.style.transform = `translate3d(${clamped}px, 0, 0)`;
}

function initMobileNavDrawer() {
  if (!els.partnerShell || !els.partnerSidebar || !els.mobileNavRail) return;

  const openThreshold = 0.38;

  function beginDrag(clientX, allowWhenClosed) {
    if (!usesDriverSlideNav()) return false;
    const open = els.partnerShell.classList.contains("is-nav-drawer-open");
    if (!open && !allowWhenClosed) return false;

    mobileNavDrag = {
      startX: clientX,
      startTx: open ? 0 : getMobileNavPanelWidth(),
      moved: false,
    };
    els.partnerShell.classList.add("is-nav-drawer-dragging");
    if (!open && els.mobileNavBackdrop) els.mobileNavBackdrop.hidden = false;
    return true;
  }

  function moveDrag(clientX) {
    if (!mobileNavDrag) return;
    const dx = clientX - mobileNavDrag.startX;
    if (Math.abs(dx) > 6) mobileNavDrag.moved = true;
    setMobileNavTranslateX(mobileNavDrag.startTx + dx);
  }

  function endDrag() {
    if (!mobileNavDrag) return;
    const w = getMobileNavPanelWidth();
    const tx = readMobileNavTranslateX();
    const open = tx < w * (1 - openThreshold);
    const didMove = mobileNavDrag.moved;
    els.partnerShell.classList.remove("is-nav-drawer-dragging");
    els.partnerSidebar.style.transform = "";
    mobileNavDrag = null;
    if (open) openMobileNavDrawer();
    else closeMobileNavDrawer();
    if (didMove && els.mobileNavRail) {
      els.mobileNavRail.dataset.suppressClick = "1";
      window.setTimeout(() => {
        delete els.mobileNavRail?.dataset.suppressClick;
      }, 320);
    }
  }

  els.mobileNavRail.addEventListener("click", () => {
    if (els.mobileNavRail?.dataset.suppressClick) return;
    if (mobileNavDrag?.moved) return;
    toggleMobileNavDrawer();
  });

  els.mobileNavRail.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (beginDrag(event.clientX, true)) {
      els.mobileNavRail.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  });

  els.partnerSidebar.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (!els.partnerShell.classList.contains("is-nav-drawer-open")) return;
    if (event.target.closest("button, a, input, select, textarea, .partner-sidebar__drawer-tab"))
      return;
    if (beginDrag(event.clientX, false)) {
      els.partnerSidebar.setPointerCapture(event.pointerId);
    }
  });

  window.addEventListener(
    "pointermove",
    (event) => {
      if (!mobileNavDrag) return;
      moveDrag(event.clientX);
    },
    { passive: true }
  );

  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  els.mobileNavBackdrop?.addEventListener("click", closeMobileNavDrawer);
  els.mobileNavDrawerTab?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeMobileNavDrawer();
  });

  document.querySelectorAll(".partner-nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (usesDriverSlideNav()) closeMobileNavDrawer();
    });
  });
  els.sidebarLogoutBtn?.addEventListener("click", () => {
    if (usesDriverSlideNav()) closeMobileNavDrawer();
  });

  syncMobileNavRailVisibility();
}

function wirePartnerNavigation() {
  document.querySelectorAll(".partner-nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveView(btn.dataset.view);
      if (usesDriverSlideNav()) closeMobileNavDrawer();
    });
  });
}

/* ── Phase 25: real vehicle PIN verification ── */

function hideProtectedUi() {
  setDriverOffline("");
  homeUi?.deactivate();
  dashboardUi?.deactivate();
  earningsUi?.deactivate();
  stopVehiclesListener();
  stopOwnerRidesListener();
  stopDriverRideHistory();
  stopActiveRideWatch();
  hideActiveRideSheet();
  hideRideCompleteSheet();
  hidePinGate();
  hidePartnerShell();
  partnerView = "home";
  els.app?.classList.remove("is-owner-mode");
  els.app?.classList.remove("has-active-ride");
  els.app?.classList.remove("has-incoming-ride");
}

function showDriverMap() {
  if (partnerAccountBlocked) {
    showAccountBlockedOverlay();
    return;
  }
  partnerMode = "driver";
  els.app?.classList.remove("is-owner-mode");
  showPartnerShell();
  finishDriverSessionEntry();
  configureNavForMode();
  syncSidebarProfile();
  setActiveView("home");
  loadWalletThreshold().catch(() => {});
  startDriverRideHistory(currentDriver?.uid);
}

async function routeDriver(vehicleId, sequence = authSequence, partner = null) {
  partnerMode = "driver";
  linkedVehicle = null;

  const userRole = partner?.role || "unknown";
  const userStatus = partner?.status || partner?.accountStatus || "unknown";
  console.log("Current User Role:", userRole, "Status:", userStatus);

  try {
    if (partnerAccountBlocked) {
      showAccountBlockedOverlay();
      return;
    }

    if (!vehicleId) {
      const hasOrphanedActiveRide = await probeOrphanedActiveRide(partner);
      if (hasOrphanedActiveRide) {
        showDriverMap();
        await restoreActiveExecutionRide(partner);
        paintDriverAvailabilityDiag();
        setLocationMessage(ACTIVE_RIDE_RECOVERY_URDU);
        return;
      }
      showPinGate("");
      return;
    }

    const { db } = getFirebase();
    const vehicleSnapshot = await getDoc(doc(db, "vehicles", vehicleId));
    if (isStaleAuthSequence(sequence)) {
      // Newer auth/route owns the UI — do not leave a blank screen from this call.
      return;
    }

    if (!vehicleSnapshot.exists()) {
      try {
        if (currentDriver?.uid) {
          await setDoc(
            doc(db, "partners", currentDriver.uid),
            { currentVehicleId: null, updatedAt: serverTimestamp() },
            { merge: true }
          );
        }
      } catch {
        /* ignore */
      }
      showPinGate("منسلک گاڑی دستیاب نہیں، نیا PIN درج کریں۔");
      return;
    }

    linkedVehicle = { id: vehicleSnapshot.id, ...vehicleSnapshot.data() };
    syncSidebarProfile();

    if (
      !linkedVehicle.driverId ||
      (currentDriver?.uid && linkedVehicle.driverId !== currentDriver.uid)
    ) {
      try {
        if (currentDriver?.uid) {
          await setDoc(
            doc(db, "partners", currentDriver.uid),
            { currentVehicleId: null, updatedAt: serverTimestamp() },
            { merge: true }
          );
        }
      } catch {
        /* ignore */
      }
      showPinGate(
        linkedVehicle.driverId
          ? "یہ گاڑی کسی اور ڈرائیور سے منسلک ہے۔"
          : "مالک نے گاڑی کا لنک ختم کر دیا۔ نیا PIN درج کریں۔"
      );
      linkedVehicle = null;
      return;
    }

    showDriverMap();
    syncRideRadarFab();
    await restoreActiveExecutionRide(partner);
  } catch (error) {
    console.warn("[SwiftGo Driver] routeDriver", error);
    if (isStaleAuthSequence(sequence)) return;
    const code = String(error?.code || "");
    if (code.includes("permission-denied")) {
      try {
        const { db } = getFirebase();
        if (currentDriver?.uid) {
          await setDoc(
            doc(db, "partners", currentDriver.uid),
            { currentVehicleId: null, updatedAt: serverTimestamp() },
            { merge: true }
          );
        }
      } catch {
        /* ignore */
      }
      showPinGate("مالک نے گاڑی کا لنک ختم کر دیا۔ نیا PIN درج کریں۔");
      return;
    }
    finishDriverSessionEntry();
    setAuthStatus("گاڑی کی معلومات لوڈ نہیں ہو سکیں — دوبارہ کوشش کریں۔");
    showAuthOverlay("گاڑی کی معلومات لوڈ نہیں ہو سکیں — دوبارہ کوشش کریں۔");
  }
}

async function logoutPartner() {
  const { auth } = getFirebase();
  if (!auth) return;
  try {
    await signOut(auth);
  } catch (error) {
    console.warn("[SwiftGo Driver] logout", error);
    setAuthStatus("لاگ آؤٹ نہیں ہو سکا، دوبارہ کوشش کریں۔");
    setPinMessage("لاگ آؤٹ نہیں ہو سکا، دوبارہ کوشش کریں۔");
  }
}

function setPinMessage(message = "", isSuccess = false) {
  if (!els.pinMessage) return;
  els.pinMessage.textContent = message;
  els.pinMessage.classList.toggle("is-success", isSuccess);
}

function setPinBusy(busy) {
  if (els.pinVerifyBtn) {
    els.pinVerifyBtn.disabled = busy;
    els.pinVerifyBtn.textContent = busy ? "تصدیق ہو رہی ہے..." : "تصدیق کریں";
  }
  if (els.pinInput) els.pinInput.disabled = busy;
}

function showPinGate(message = "") {
  if (partnerAccountBlocked) {
    showAccountBlockedOverlay();
    return;
  }
  // Hide shell/history without the full logout teardown racing the PIN panel.
  setDriverOffline("");
  stopActiveRideWatch();
  detachCheckpointPresence("pin_gate");
  activeExecutionRide = null;
  hideActiveRideSheet();
  hideRideCompleteSheet();
  hidePartnerShell();
  partnerMode = "driver";
  if (!els.pinGate) {
    recoverEntrySurfaceIfBlank(authSequence, "PIN اسکرین دستیاب نہیں۔");
    return;
  }
  els.pinGate.hidden = false;
  finishDriverSessionEntry();
  setPinMessage(message || (activeRideRecoveryPending ? ACTIVE_RIDE_RECOVERY_URDU : ""));
  requestAnimationFrame(() => els.pinInput?.focus());
}

function hidePinGate() {
  if (els.pinGate) els.pinGate.hidden = true;
}

async function verifyVehiclePin(event) {
  event.preventDefault();
  const driver = currentDriver;
  const enteredPin = (els.pinInput?.value || "").trim();

  if (!driver) {
    setPinMessage("پہلے لاگ اِن کریں");
    return;
  }
  if (!/^\d{4}$/.test(enteredPin)) {
    setPinMessage("درست 4 ہندسوں کا PIN درج کریں");
    return;
  }

  setPinBusy(true);
  setPinMessage("");

  try {
    const result = await linkVehicleByPinClient(enteredPin);
    linkedVehicle = {
      id: result.vehicleId,
      plate: result.plate,
      ownerId: result.ownerId,
      driverId: driver.uid,
      status: "offline",
    };
    hidePinGate();
    showDriverMap();
    const ready = await activateDriverOnlineMode();
    if (!ready) {
      setPinMessage(
        "گاڑی منسلک ہو گئی مگر آن لائن نہیں — لوکیشن/نیٹ ورک چیک کریں اور دوبارہ آن لائن کریں"
      );
      driverToast("گاڑی منسلک — آن لائن کے لیے مقام درکار ہے");
      els.pinForm?.reset();
      window.setTimeout(() => showDriverMap(), 600);
      return;
    }
    setPinMessage("گاڑی کامیابی سے منسلک ہو گئی!", true);
    driverToast("گاڑی منسلک — آپ آن لائن ہیں");
    els.pinForm?.reset();
    window.setTimeout(() => {
      showDriverMap();
      syncRideRadarFab();
    }, 900);
  } catch (error) {
    const code = String(error?.code || "");
    const message = String(error?.message || error?.details || "");
    const blob = `${code} ${message}`;
    console.warn("[SwiftGo Driver] linkVehicleByPin failed", {
      code,
      message,
      pinLength: enteredPin.length,
    });

    let userMsg = "تصدیق مکمل نہیں ہو سکی۔ دوبارہ کوشش کریں۔";
    if (blob.includes("PIN_LOCKED") || blob.includes("resource-exhausted")) {
      userMsg = "زیادہ غلط کوششیں — کچھ دیر بعد دوبارہ کوشش کریں";
    } else if (blob.includes("DRIVER_BLOCKED") || blob.includes("DRIVER_SUSPENDED")) {
      userMsg = "آپ کا اکاؤنٹ بلاک/معطل ہے";
    } else if (blob.includes("VEHICLE_IN_USE")) {
      userMsg = "یہ گاڑی پہلے ہی زیر استعمال ہے";
    } else if (blob.includes("PIN_NOT_FOUND") || blob.includes("not-found")) {
      userMsg = "غلط پن کوڈ! دوبارہ کوشش کریں";
    } else if (blob.includes("FUNCTIONS_UNAVAILABLE")) {
      userMsg = "PIN سروس دستیاب نہیں — بعد میں کوشش کریں";
    } else if (blob.includes("failed-precondition")) {
      userMsg =
        "گاڑی کا PIN درست نہیں یا ڈرائیور اکاؤنٹ منظوری/حالت درست نہیں۔ دوبارہ کوشش کریں۔";
      console.warn(
        "[SwiftGo Driver] linkVehicleByPin failed-precondition — check vehicle free, PIN, partner accountStatus"
      );
    } else if (blob.includes("permission-denied")) {
      userMsg = "اجازت نہیں — اکاؤنٹ کی حیثیت چیک کریں";
    }

    setPinMessage(userMsg);
    driverToast(userMsg);
  } finally {
    setPinBusy(false);
  }
}

async function signInDriverWithGoogle() {
  const { auth } = getFirebase();
  if (!auth) {
    setAuthStatus("فائر بیس دستیاب نہیں ہے");
    return;
  }

  setLoginBusy(true);
  setAuthStatus("");
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    if (error?.code === "auth/popup-blocked") {
      await signInWithRedirect(auth, googleProvider);
      return;
    }
    console.warn("[SwiftGo Driver] Google login", error);
    setLoginBusy(false);
    setAuthStatus("Google لاگ اِن نہیں ہو سکا، دوبارہ کوشش کریں");
  }
}

function setOwnerMessage(message = "") {
  if (els.ownerMessage) els.ownerMessage.textContent = message;
}

function stopVehiclesListener() {
  unsubscribeVehicles();
  unsubscribeVehicles = () => {};
}

function stopOwnerRidesListener() {
  unsubscribeOwnerRides();
  unsubscribeOwnerRides = () => {};
}

/* ── Phase 35: driver ride history ── */

const DRIVER_RIDE_STATUS = {
  completed: { label: "مکمل", className: "is-completed" },
  cancelled_by_user: { label: "منسوخ", className: "is-cancelled" },
  cancelled: { label: "منسوخ", className: "is-cancelled" },
  searching_driver: { label: "تلاش", className: "" },
  accepted: { label: "قبول شدہ", className: "is-accepted" },
  arrived: { label: "پہنچ گئے", className: "is-accepted" },
  in_progress: { label: "جاری", className: "is-accepted" },
  declined: { label: "مسترد", className: "is-cancelled" },
};

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function driverRideHistoryDate(createdAt) {
  if (!createdAt) return "—";
  const date =
    typeof createdAt?.toDate === "function"
      ? createdAt.toDate()
      : createdAt?.seconds
        ? new Date(createdAt.seconds * 1000)
        : null;
  if (!date || Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ur-PK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function driverRideFare(ride) {
  const value = Number(ride?.estimatedFare ?? ride?.farePkr ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function warnDriverHistoryIndexError(error) {
  console.warn("[SwiftGo] Firestore listen retry... driver ride history", error);
  if (error?.code === "failed-precondition" || /index/i.test(error?.message || "")) {
    console.warn(
      "[SwiftGo] Firestore composite index required for rides (driverId + createdAt). " +
        "Open the link in this error message in Firebase Console to create it:",
      error.message
    );
  }
}

function renderDriverRideHistory(rides = driverRidesCache) {
  if (!els.driverRideHistoryList || !els.driverRideHistoryEmpty) return;

  if (!rides.length) {
    els.driverRideHistoryList.hidden = true;
    els.driverRideHistoryList.innerHTML = "";
    els.driverRideHistoryEmpty.hidden = false;
    return;
  }

  els.driverRideHistoryEmpty.hidden = true;
  els.driverRideHistoryList.hidden = false;
  els.driverRideHistoryList.innerHTML = rides
    .map((ride) => {
      const status = DRIVER_RIDE_STATUS[ride.status] || {
        label: ride.status || "نامعلوم",
        className: "",
      };
      const pickup = escapeHtml(
        ride.pickupLocation?.address || ride.pickup || "—"
      );
      const dropoff = escapeHtml(
        ride.dropoffLocation?.address || ride.destination || "—"
      );
      const fare = driverRideFare(ride);
      const commission = Math.round(Number(ride.commissionAmount ?? 0));
      const safeCommission =
        Number.isFinite(commission) && commission >= 0 ? commission : 0;
      const date = escapeHtml(driverRideHistoryDate(ride.createdAt));
      const statusClass = status.className
        ? ` driver-ride-card__status ${status.className}`
        : " driver-ride-card__status";
      return `<article class="driver-ride-card">
        <div class="driver-ride-card__top">
          <time class="driver-ride-card__date">${date}</time>
          <span class="${statusClass.trim()}">${escapeHtml(status.label)}</span>
        </div>
        <p class="driver-ride-card__route"><span>اٹھانا</span><strong>${pickup}</strong></p>
        <p class="driver-ride-card__route"><span>منزل</span><strong>${dropoff}</strong></p>
        <div class="driver-ride-card__money">
          <div><span>کل کرایہ</span><strong>Rs. ${fare.toLocaleString("en-PK")}</strong></div>
          <div><span>کمیشن</span><strong class="is-cut">Rs. ${safeCommission.toLocaleString("en-PK")}</strong></div>
        </div>
      </article>`;
    })
    .join("");
}

function stopDriverRideHistory() {
  unsubscribeDriverRideHistory();
  unsubscribeDriverRideHistory = () => {};
  driverRidesCache = [];
  renderDriverRideHistory([]);
}

function startDriverRideHistory(uid) {
  stopDriverRideHistory();
  if (!uid) return;

  const { ready, db } = getFirebase();
  if (!ready || !db) return;

  const ridesQuery = query(
    collection(db, "rides"),
    where("driverId", "==", uid),
    orderBy("createdAt", "desc")
  );

  unsubscribeDriverRideHistory = onSnapshot(
    ridesQuery,
    (snapshot) => {
      driverRidesCache = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      }));
      renderDriverRideHistory(driverRidesCache);
    },
    warnDriverHistoryIndexError
  );
}

function ownerRideStatus(status) {
  const statuses = {
    accepted: { label: "قبول شدہ", className: "is-accepted" },
    completed: { label: "مکمل", className: "is-completed" },
    cancelled: { label: "منسوخ", className: "is-cancelled" },
    cancelled_by_user: { label: "کسٹمر نے منسوخ کی", className: "is-cancelled" },
  };
  return statuses[status] || { label: status || "نامعلوم", className: "" };
}

function ownerRideTime(timestamp) {
  if (!timestamp?.toDate) return "—";
  return new Intl.DateTimeFormat("ur-PK", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp.toDate());
}

function createRideHistoryCell(label, value, options = {}) {
  const cell = document.createElement("div");
  cell.className = `owner-ride-card__cell${options.status ? " owner-ride-card__cell--status" : ""}`;

  const cellLabel = document.createElement("span");
  cellLabel.className = "owner-ride-card__label";
  cellLabel.textContent = label;

  if (options.status) {
    const badge = document.createElement("span");
    badge.className = `owner-ride-status ${options.status.className}`.trim();
    badge.textContent = options.status.label;
    cell.append(cellLabel, badge);
    return cell;
  }

  const cellValue = document.createElement("strong");
  cellValue.className = `owner-ride-card__value${options.ltr ? " owner-ride-card__value--ltr" : ""}`;
  cellValue.textContent = value;
  cell.append(cellLabel, cellValue);
  return cell;
}

function renderOwnerRides() {
  if (!els.ownerRideList) return;
  els.ownerRideList.replaceChildren();
  if (els.ownerRideCount) els.ownerRideCount.textContent = `${ownerRides.length} سواریاں`;
  if (els.ownerRideEmpty) els.ownerRideEmpty.hidden = ownerRides.length > 0;

  ownerRides.forEach((ride) => {
    const vehicle = ownerVehicles.find((item) => item.id === ride.vehicleId);
    const driverName =
      ride.driverName ||
      (ride.driverId ? `ڈرائیور ${String(ride.driverId).slice(0, 6)}` : "—");
    const vehiclePlate = ride.vehiclePlate || vehicle?.plate || "—";
    const distanceFare = `${Number(ride.distanceKm || 0).toFixed(1)} km · Rs. ${Math.round(
      Number(ride.farePkr || 0)
    )}`;

    const card = document.createElement("article");
    card.className = "owner-ride-card";
    card.append(
      createRideHistoryCell("وقت", ownerRideTime(ride.createdAt)),
      createRideHistoryCell("ڈرائیور", driverName),
      createRideHistoryCell("گاڑی", vehiclePlate, { ltr: true }),
      createRideHistoryCell("فاصلہ / کرایہ", distanceFare, { ltr: true }),
      createRideHistoryCell("اسٹیٹس", "", { status: ownerRideStatus(ride.status) })
    );
    els.ownerRideList.appendChild(card);
  });
}

function startOwnerRidesListener() {
  stopOwnerRidesListener();
  if (els.ownerRideMessage) els.ownerRideMessage.textContent = "";
  if (!currentDriver || partnerMode !== "owner") return;

  const { db } = getFirebase();
  // Keep this query single-indexed; sort snapshots by createdAt client-side
  // so Phase 26 does not require a new composite Firestore index.
  const ownerRidesQuery = query(
    collection(db, "rides"),
    where("ownerId", "==", currentDriver.uid)
  );

  unsubscribeOwnerRides = onSnapshot(
    ownerRidesQuery,
    (snapshot) => {
      ownerRides = snapshot.docs
        .map((rideDoc) => ({ id: rideDoc.id, ...rideDoc.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      renderOwnerRides();
    },
    (error) => {
      console.warn("[SwiftGo Partner] Firestore listen retry... owner rides", error);
      if (els.ownerRideMessage) {
        els.ownerRideMessage.textContent = "سواریوں کی ہسٹری لوڈ نہیں ہو سکی۔";
      }
    }
  );
}

function renderOwnerVehicles() {
  if (!els.ownerVehicleGrid) return;
  els.ownerVehicleGrid.replaceChildren();

  const onlineCount = ownerVehicles.filter((vehicle) => vehicle.status === "online").length;
  if (els.ownerVehicleCount) els.ownerVehicleCount.textContent = String(ownerVehicles.length);
  if (els.ownerOnlineCount) els.ownerOnlineCount.textContent = String(onlineCount);
  if (els.ownerOfflineCount) {
    els.ownerOfflineCount.textContent = String(ownerVehicles.length - onlineCount);
  }
  if (els.ownerVehicleEmpty) els.ownerVehicleEmpty.hidden = ownerVehicles.length > 0;

  ownerVehicles.forEach((vehicle) => {
    const card = document.createElement("article");
    card.className = "fleet-vehicle-card";

    const top = document.createElement("div");
    top.className = "fleet-vehicle-card__top";

    const details = document.createElement("div");
    const model = document.createElement("h3");
    model.textContent = vehicle.model || "SwiftGo Vehicle";
    const plate = document.createElement("p");
    plate.className = "fleet-vehicle-card__plate";
    plate.textContent = vehicle.plate || "—";
    details.append(model, plate);

    const badge = document.createElement("span");
    badge.className = "vehicle-status-badge";
    const isOnline = vehicle.status === "online";
    badge.classList.toggle("is-online", isOnline);
    badge.textContent = isOnline ? "آن لائن" : "آف لائن";
    top.append(details, badge);

    const pinRow = document.createElement("div");
    pinRow.className = "fleet-vehicle-card__pin";
    const pinLabel = document.createElement("span");
    pinLabel.textContent = "ڈرائیور PIN";
    const pin = document.createElement("strong");
    pin.textContent = vehicle.pin
      ? `PIN: ${vehicle.pin}`
      : vehicle.pinHash
        ? "PIN محفوظ (ہیش)"
        : "PIN: —";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-pin-btn";
    copyBtn.textContent = "کاپی";
    copyBtn.disabled = !vehicle.pin;
    copyBtn.addEventListener("click", async () => {
      if (!vehicle.pin) {
        setOwnerMessage("PIN صرف تخلیق کے وقت دکھایا جاتا ہے");
        return;
      }
      try {
        await navigator.clipboard.writeText(String(vehicle.pin || ""));
        copyBtn.textContent = "کاپی ہو گیا";
        window.setTimeout(() => {
          copyBtn.textContent = "کاپی";
        }, 1400);
      } catch {
        setOwnerMessage(`PIN: ${vehicle.pin || "—"}`);
      }
    });
    pinRow.append(pinLabel, pin, copyBtn);

    card.append(top, pinRow);
    els.ownerVehicleGrid.appendChild(card);
  });
  renderOwnerRides();
}

function startVehiclesListener() {
  stopVehiclesListener();
  setOwnerMessage("");
  if (!currentDriver || partnerMode !== "owner") return;

  const { db } = getFirebase();
  const ownerVehiclesQuery = query(
    collection(db, "vehicles"),
    where("ownerId", "==", currentDriver.uid)
  );

  unsubscribeVehicles = onSnapshot(
    ownerVehiclesQuery,
    (snapshot) => {
      ownerVehicles = snapshot.docs
        .map((vehicleDoc) => ({ id: vehicleDoc.id, ...vehicleDoc.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      renderOwnerVehicles();
    },
    (error) => {
      console.warn("[SwiftGo Partner] Firestore listen retry... owner vehicles", error);
      setOwnerMessage("گاڑیوں کی فہرست لوڈ نہیں ہو سکی۔ Firestore rules deploy کریں۔");
    }
  );
}

function openVehicleModal() {
  if (!currentDriver) {
    setOwnerMessage("گاڑی شامل کرنے کے لیے پہلے لاگ اِن کریں۔");
    return;
  }
  if (!els.vehicleModal) return;
  els.vehicleModal.hidden = false;
  els.vehicleModal.setAttribute("aria-hidden", "false");
  if (els.vehicleFormMessage) els.vehicleFormMessage.textContent = "";
  requestAnimationFrame(() => els.vehicleModelInput?.focus());
}

function closeVehicleModal() {
  if (!els.vehicleModal) return;
  els.vehicleModal.hidden = true;
  els.vehicleModal.setAttribute("aria-hidden", "true");
  els.vehicleForm?.reset();
  if (els.vehicleFormMessage) els.vehicleFormMessage.textContent = "";
}

function generateUniqueVehiclePin() {
  const usedPins = new Set(ownerVehicles.map((vehicle) => String(vehicle.pin || "")));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const pin = String(1000 + (random[0] % 9000));
    if (!usedPins.has(pin)) return pin;
  }
  throw new Error("PIN_GENERATION_FAILED");
}

async function submitVehicle(event) {
  event.preventDefault();
  const owner = currentDriver;
  const model = (els.vehicleModelInput?.value || "").trim();
  const plate = (els.vehiclePlateInput?.value || "").trim().toUpperCase();
  if (!owner || !model || !plate) {
    if (els.vehicleFormMessage) {
      els.vehicleFormMessage.textContent = "ماڈل اور نمبر پلیٹ دونوں درج کریں۔";
    }
    return;
  }

  if (els.vehicleSaveBtn) els.vehicleSaveBtn.disabled = true;
  if (els.vehicleFormMessage) els.vehicleFormMessage.textContent = "";

  try {
    const pin = generateUniqueVehiclePin();
    const pinHash = await hashVehiclePin(pin);
    const { db } = getFirebase();
    await addDoc(collection(db, "vehicles"), {
      ownerId: owner.uid,
      model,
      plate,
      pinHash,
      status: "offline",
      driverId: null,
      createdAt: serverTimestamp(),
    });
    closeVehicleModal();
    setOwnerMessage(`گاڑی شامل ہو گئی۔ ڈرائیور PIN: ${pin} (ایک بار دکھایا گیا)`);
  } catch (error) {
    console.warn("[SwiftGo Partner] add vehicle", error);
    if (els.vehicleFormMessage) {
      els.vehicleFormMessage.textContent =
        "گاڑی محفوظ نہیں ہو سکی۔ Firestore rules چیک کریں۔";
    }
  } finally {
    if (els.vehicleSaveBtn) els.vehicleSaveBtn.disabled = false;
  }
}

function toggleDriverStatusFromUi() {
  if (walletLocked) return;
  toggleDriverStatus();
}

function updateRideRadarButtonLabel() {
  if (!els.openRideRadarBtn) return;
  const n = availableRadarCount;
  els.openRideRadarBtn.textContent =
    n > 0 ? `دستیاب سواریاں (${n})` : "دستیاب سواریاں";
}

function stopRadarBackgroundFeed() {
  radarFeedUnsub();
  radarFeedUnsub = () => {};
  availableRadarCount = 0;
  radarFeedPrimed = false;
  lastRadarFeedCount = 0;
  lastRadarListenKey = "";
  updateRideRadarButtonLabel();
}

function startRadarBackgroundFeed() {
  const uid = currentDriver?.uid;
  if (!uid || !isOnlineReady() || !linkedVehicle?.id || activeExecutionRide?.id) return;
  const listenKey = `${uid}|${linkedVehicle.id}|${activeExecutionRide?.id || ""}`;
  if (listenKey === lastRadarListenKey) return;
  stopRadarBackgroundFeed();
  lastRadarListenKey = listenKey;
  radarFeedUnsub = subscribePendingRadarRides(
    uid,
    (state) => {
      radarListenerMeta = {
        invitedCandidateCount: Number(state?.invitedCandidateCount || 0),
        rideFetchErrors: Number(state?.rideFetchErrors || 0),
        listenerError: String(state?.listenerError || ""),
      };
      paintDriverAvailabilityDiag();
      const count = state?.rides?.length ?? 0;
      const dropped = Number(state?.rideFetchErrors || 0);
      if (radarFeedPrimed && count > lastRadarFeedCount) {
        AudioService.playAlert();
        AudioService.showNotification(
          "نئی رائٹ",
          "«رائٹ حاصل کریں» دبائیں اور فہرست میں دیکھیں۔"
        );
        driverToast("نئی رائٹ آ گئی — «رائٹ حاصل کریں» دبائیں");
      } else if (dropped > 0 && count === 0 && (state?.invitedCandidateCount || 0) > 0) {
        driverToast("دعوت ملی مگر سواری پڑھ نہیں سکی — دوبارہ کوشش کریں");
      }
      radarFeedPrimed = true;
      lastRadarFeedCount = count;
      availableRadarCount = count;
      updateRideRadarButtonLabel();
    },
    () => lastDriverPosition,
    () => Boolean(activeExecutionRide?.id)
  );
}

function stopDriverOfferInbox() {
  driverOfferInbox?.stop();
}

async function handleCustomerCounterOffer(offer) {
  const counter = Math.round(Number(offer?.customerCounterFare) || 0);
  if (!offer?.rideId || counter <= 0) return;

  const msg = `مسافر نے ${counter.toLocaleString("en-PK")} روپے کی پیشکش کی`;
  driverToast(msg);
  AudioService.playAlert();
  AudioService.showNotification("مسافر کی پیشکش", msg);

  rideRadarUi?.refreshList?.();

  try {
    const { db } = getFirebase();
    const snap = await getDoc(doc(db, "rides", offer.rideId));
    if (!snap.exists()) return;
    const ride = normalizeRadarDoc("rides", snap.id, snap.data());
    rideRadarUi?.openRideDetail?.(ride);
  } catch (err) {
    console.warn("[SwiftGo Driver] open counter ride", err);
  }
}

function syncDriverOfferInbox() {
  if (!driverOfferInbox) return;
  const canListen =
    Boolean(currentDriver?.uid) &&
    Boolean(linkedVehicle?.id) &&
    isOnlineReady() &&
    !activeExecutionRide?.id;
  if (canListen) driverOfferInbox.start();
  else stopDriverOfferInbox();
}

function clearRadarPendingCache() {
  const uid = currentDriver?.uid;
  if (uid) clearLocalCacheNamespace(uid, "ride_radar");
}

function syncRideRadarFab() {
  const canListen =
    Boolean(currentDriver?.uid) &&
    Boolean(linkedVehicle?.id) &&
    isOnlineReady() &&
    !activeExecutionRide?.id;
  const showFab = canListen && partnerView === "home";
  if (els.openRideRadarBtn) els.openRideRadarBtn.hidden = !showFab;
  if (canListen) startRadarBackgroundFeed();
  else stopRadarBackgroundFeed();
  syncDriverOfferInbox();
  updateRideRadarButtonLabel();
}

function driverIcon() {
  return L.divIcon({
    className: "",
    html: '<div class="driver-location-marker"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function syncSidebarProfile() {
  const name =
    currentDriver?.displayName ||
    currentDriver?.email?.split("@")[0] ||
    "ڈرائیور";
  if (els.sidebarName) els.sidebarName.textContent = name;
  const meta = linkedVehicle?.plate
    ? `گاڑی ${linkedVehicle.plate}`
    : "SwiftGo Partner";
  if (els.sidebarMeta) els.sidebarMeta.textContent = meta;
}

function paintLastDriverPositionOnMap(options = {}) {
  if (!map || !lastDriverPosition || typeof L === "undefined") return;
  const { lat, lng } = lastDriverPosition;
  if (!isValidCoord(lat, lng)) return;
  const { flyTo = false } = options;
  const latlng = [lat, lng];

  if (!locationMarker) {
    locationMarker = L.marker(latlng, {
      icon: driverIcon(),
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    locationMarker.setLatLng(latlng);
  }

  if (flyTo && !hasCenteredOnDriver) {
    map.flyTo(latlng, 16, { duration: 0.8 });
    hasCenteredOnDriver = true;
  }
}

function ensureDriverMap() {
  const mapEl = homeUi?.getMapElement?.() || document.getElementById("driverMap");
  if (!mapEl || typeof L === "undefined") return;

  if (map && map.getContainer() !== mapEl) {
    try {
      map.remove();
    } catch {
      /* ignore */
    }
    map = null;
    locationMarker = null;
    accuracyCircle = null;
  }

  if (!map) {
    map = L.map(mapEl, {
      zoomControl: true,
      attributionControl: true,
    }).setView(KARACHI, 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
  }

  paintLastDriverPositionOnMap({ flyTo: true });
  requestAnimationFrame(() => map?.invalidateSize());
}

function invalidateHomeMapIfActive() {
  if (partnerView !== "home") return;
  requestAnimationFrame(() => {
    map?.invalidateSize();
    homeUi?.invalidateMap();
  });
}

function updateDriverLocation(position) {
  const { latitude, longitude, accuracy, speed, heading } = position.coords;
  if (!isValidCoord(latitude, longitude)) {
    console.warn("[SwiftGo Partner] GPS fix ignored — invalid coordinates");
    locationDiagCounters.fixesRejected += 1;
    return;
  }
  lastDriverPosition = { lat: latitude, lng: longitude };
  lastGpsFixAtMs = Date.now();
  lastGpsErrorCode = "";
  locationPermissionState = "granted";
  transientGpsFailCount = 0;

  // Matching must receive server location only after ONLINE_READY.
  if (isOnlineReady() && linkedVehicle?.id) {
    const headingDeg = Number.isFinite(heading) ? heading : null;
    const speedMps = Number.isFinite(speed) && speed >= 0 ? speed : null;
    const observedAt = Number(position.timestamp) || Date.now();
    syncVehicleLocationToFirestore(latitude, longitude, {
      force: !lastVehicleLocationWrite,
      heading: headingDeg,
      accuracy,
      speed: speedMps,
      observedAt,
    });
  }
  paintDriverAvailabilityDiag();

  if (!map) {
    if (partnerView === "home") ensureDriverMap();
    if (!map) return;
  }
  if (!online) {
    paintLastDriverPositionOnMap();
    return;
  }

  const latlng = [latitude, longitude];

  if (!locationMarker) {
    locationMarker = L.marker(latlng, {
      icon: driverIcon(),
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    locationMarker.setLatLng(latlng);
  }

  if (!accuracyCircle) {
    accuracyCircle = L.circle(latlng, {
      radius: accuracy || 20,
      color: "#087747",
      weight: 1,
      opacity: 0.35,
      fillColor: "#12a862",
      fillOpacity: 0.1,
      interactive: false,
    }).addTo(map);
  } else {
    accuracyCircle.setLatLng(latlng).setRadius(accuracy || 20);
  }

  if (!hasCenteredOnDriver) {
    map.flyTo(latlng, 16, { duration: 0.8 });
    hasCenteredOnDriver = true;
  }
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Commit one serialized vehicle location job (called only by locationWriteSerializer).
 * trackingSessionStartedAt is stamped at most once per session (job.stampSessionStart).
 */
async function commitVehicleLocationJob(job) {
  if (!linkedVehicle?.id || !currentDriver?.uid) return;
  if (job.generation !== locationTrackingGeneration || !locationTrackingSessionId) return;
  if (job.sessionId !== locationTrackingSessionId) return;

  const { db } = getFirebase();
  const payload = { ...job.payload };
  // Exactly one session-start stamp per session — serializer clears stampSessionStart after.
  if (job.stampSessionStart) {
    payload.trackingSessionStartedAt = serverTimestamp();
  } else {
    delete payload.trackingSessionStartedAt;
  }

  locationDiagCounters.vehicleWritesAttempted += 1;
  await updateDoc(doc(db, "vehicles", linkedVehicle.id), payload);

  if (job.stampSessionStart || locationTrackingSessionStartPending) {
    locationTrackingSessionStartPending = false;
    if (job.envelope) job.envelope._sessionStartedMs = Date.now();
  }
  lastAcceptedLocationEnvelope = job.envelope;
  lastVehicleLocationWrite = Date.now();
  lastVehicleLocationLatLng = { lat: job.envelope.lat, lng: job.envelope.lng };
  if (payload.locationGridCell) lastLocationGridCell = payload.locationGridCell;
  if (payload.geoCell) lastMatchGeoCell = payload.geoCell;
  if (payload.status) lastVehicleStatusWritten = payload.status;
  lastLocationSyncError = "";
  checkpointPolicy.noteWriteCommitted();
  locationDiagCounters.vehicleWritesCompleted += 1;
  // Intentionally no client ride.driverLocation write — CF mirror is authoritative.
  locationDiagCounters.duplicateRideWritesPrevented += 1;
  paintDriverAvailabilityDiag();
}

/**
 * Phase 1: driver writes only vehicles.location (envelope).
 * Cloud Function mirrorDriverLocationToRide is the sole ride.driverLocation writer.
 * Writes are single-flight: only one in-flight update; later GPS callbacks coalesce to newest.
 */
async function syncVehicleLocationToFirestore(
  lat,
  lng,
  { force = false, heading = null, accuracy = null, speed = null, observedAt = null } = {}
) {
  if (!linkedVehicle?.id || !isOnlineReady() || !currentDriver?.uid) return;
  if (!isValidCoord(lat, lng)) {
    console.warn("[SwiftGo Partner] skip vehicle location sync — invalid lat/lng");
    locationDiagCounters.fixesRejected += 1;
    return;
  }

  if (!locationTrackingSessionId) beginLocationTrackingSession();
  const trackingGen = locationTrackingGeneration;
  const sessionIdAtEnqueue = locationTrackingSessionId;
  locationDiagCounters.gpsFixesReceived += 1;

  const normalized = normalizeLocationFix(
    {
      lat,
      lng,
      headingDeg: heading,
      accuracyM: accuracy,
      speedMps: speed,
      observedAt: observedAt || Date.now(),
      source: "gps",
    },
    {
      sessionId: sessionIdAtEnqueue,
      sequence: nextLocationSequence(),
      nowMs: Date.now(),
    }
  );
  if (!normalized.ok || !normalized.envelope) {
    locationDiagCounters.fixesRejected += 1;
    try {
      console.info(
        JSON.stringify({ type: "live_location_diag", reason: normalized.reason || LOCATION_DIAG.INVALID })
      );
    } catch {
      /* ignore */
    }
    return;
  }

  const gate = evaluateFixAgainstPrevious(lastAcceptedLocationEnvelope, normalized.envelope, {
    enforceSessionConsistency: true,
    vehicleSessionId: sessionIdAtEnqueue,
    vehicleSessionStartedMs: locationTrackingSessionStartPending
      ? Date.now()
      : lastAcceptedLocationEnvelope
        ? Number(lastAcceptedLocationEnvelope.observedAt) || Date.now()
        : Date.now(),
    previousSessionStartedMs: lastAcceptedLocationEnvelope
      ? Number(lastAcceptedLocationEnvelope._sessionStartedMs) || 0
      : 0,
  });
  if (!gate.accept) {
    locationDiagCounters.fixesRejected += 1;
    if (gate.reason === LOCATION_DIAG.DUPLICATE) {
      locationDiagCounters.duplicateRideWritesPrevented += 1;
    }
    try {
      console.info(JSON.stringify({ type: "live_location_diag", reason: gate.reason }));
    } catch {
      /* ignore */
    }
    return;
  }

  const now = Date.now();
  const cell = `${Math.floor(Number(lat) / LOCATION_GRID_DEG)}_${Math.floor(Number(lng) / LOCATION_GRID_DEG)}`;
  const geoCell = matchGeoCellId(lat, lng);
  const zoneChanged = cell !== lastLocationGridCell;
  const matchCellChanged = geoCell !== lastMatchGeoCell;
  checkpointPolicy.noteRawGps();
  let movedEnough = true;
  if (lastVehicleLocationLatLng && Number.isFinite(lat) && Number.isFinite(lng)) {
    const movedKm = haversineKm(lastVehicleLocationLatLng, { lat, lng });
    movedEnough = movedKm == null || movedKm * 1000 >= MIN_LOCATION_MOVE_M;
  }
  const nextStatus = activeExecutionRide?.id ? "in_ride" : "online";
  const statusChanged = nextStatus !== lastVehicleStatusWritten;

  // Presence throttling applies only while executing an assigned ride.
  if (!activeExecutionRide?.id) {
    checkpointPolicy.setActiveRide({ active: false });
  }

  const writeGate = checkpointPolicy.evaluateWriteGate({
    force,
    nowMs: now,
    lastWriteMs: lastVehicleLocationWrite,
    movedEnough,
    zoneChanged,
    matchCellChanged,
    statusChanged,
  });
  if (!writeGate.allow) {
    return;
  }
  if (writeGate.forceUsed) {
    checkpointPolicy.consumeImmediate();
  }
  checkpointPolicy.noteWriteAttempted();

  const hotspotId = matchHotspotId(lat, lng);
  const location = toVehicleLocationField(normalized.envelope);
  const payload = {
    location,
    locationUpdatedAt: serverTimestamp(),
    locationGridCell: cell,
    trackingSessionId: sessionIdAtEnqueue,
  };
  if (geoCell) payload.geoCell = geoCell;
  payload.hotspotId = hotspotId || null;
  if (statusChanged) {
    payload.status = nextStatus;
  }

  try {
    await locationWriteSerializer.enqueue({
      generation: trackingGen,
      sessionId: sessionIdAtEnqueue,
      stampSessionStart: locationTrackingSessionStartPending,
      envelope: normalized.envelope,
      payload,
    });
  } catch (error) {
    console.warn("[SwiftGo Partner] vehicle location sync", error);
    lastLocationSyncError = String(error?.code || error?.message || "sync_failed").slice(0, 80);
    paintDriverAvailabilityDiag();
  }
}

async function markVehicleOfflineInFirestore() {
  if (!linkedVehicle?.id) return;
  locationWriteSerializer.cancelAll();
  try {
    const { db } = getFirebase();
    await updateDoc(doc(db, "vehicles", linkedVehicle.id), {
      status: "offline",
    });
    lastVehicleStatusWritten = "offline";
  } catch (error) {
    console.warn("[SwiftGo Partner] vehicle offline sync", error);
  }
}

/** Milliseconds since Firestore Timestamp-like value. */
function timestampToMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return null;
}

/** Reuse a recent in-session browser fix only (never vehicle doc / cache for ONLINE_READY). */
function resolveInSessionFreshGpsFix() {
  if (
    lastDriverPosition &&
    lastGpsFixAtMs > 0 &&
    Date.now() - lastGpsFixAtMs <= FRESH_GPS_MS &&
    isValidCoord(lastDriverPosition.lat, lastDriverPosition.lng)
  ) {
    return { lat: lastDriverPosition.lat, lng: lastDriverPosition.lng };
  }
  return null;
}

function buildOnlineReadyVehiclePayload(lat, lng) {
  const cell = `${Math.floor(lat / LOCATION_GRID_DEG)}_${Math.floor(lng / LOCATION_GRID_DEG)}`;
  const geoCell = matchGeoCellId(lat, lng);
  const hotspotId = matchHotspotId(lat, lng);
  if (!geoCell) throw new Error("INVALID_GEO_CELL");
  if (!locationTrackingSessionId) beginLocationTrackingSession();
  const envelope = normalizeLocationFix(
    { lat, lng, observedAt: Date.now(), source: "gps" },
    { sessionId: locationTrackingSessionId, sequence: nextLocationSequence(), nowMs: Date.now() }
  );
  const location = envelope.ok
    ? toVehicleLocationField(envelope.envelope)
    : { lat, lng };
  const payload = {
    driverId: currentDriver.uid,
    status: activeExecutionRide?.id ? "in_ride" : "online",
    driverName:
      currentDriver.displayName ||
      currentDriver.email?.split("@")[0] ||
      "SwiftGo Driver",
    location,
    locationUpdatedAt: serverTimestamp(),
    locationGridCell: cell,
    geoCell,
    hotspotId: hotspotId || null,
    activeRideId: activeExecutionRide?.id || null,
    trackingSessionId: locationTrackingSessionId,
  };
  if (locationTrackingSessionStartPending) {
    payload.trackingSessionStartedAt = serverTimestamp();
  }
  return payload;
}

/** Single coherent Firestore write — driver is matchable only after this succeeds. */
async function writeOnlineReadyVehicle(lat, lng) {
  if (!linkedVehicle?.id || !currentDriver?.uid) throw new Error("NOT_LINKED");
  // Serialize against GPS location writes so session-start is stamped once.
  locationWriteSerializer.cancelAll();
  const payload = buildOnlineReadyVehiclePayload(lat, lng);
  const { db } = getFirebase();
  await updateDoc(doc(db, "vehicles", linkedVehicle.id), payload);
  if (locationTrackingSessionStartPending) {
    locationTrackingSessionStartPending = false;
  }
  locationWriteSerializer.markSessionStartComplete();
  lastLocationGridCell = payload.locationGridCell;
  lastMatchGeoCell = payload.geoCell;
  lastVehicleLocationWrite = Date.now();
  lastVehicleLocationLatLng = { lat, lng };
  lastVehicleStatusWritten = payload.status;
  lastLocationSyncError = "";
  linkedVehicle = { ...linkedVehicle, ...payload, id: linkedVehicle.id };
  paintDriverAvailabilityDiag();
}

async function activateDriverOnlineMode() {
  if (onlineActivationPromise) return onlineActivationPromise;
  if (isOnlineReady()) return true;
  if (!currentDriver?.uid) {
    setLocationMessage("پہلے سائن اِن کریں");
    return false;
  }
  if (!linkedVehicle?.id) {
    setLocationMessage("آن لائن ہونے کے لیے پہلے گاڑی کا PIN درج کریں");
    return false;
  }
  if (partnerAccountBlocked) {
    showAccountBlockedOverlay();
    return false;
  }
  if (walletLocked) {
    setLocationMessage(
      "کمپنی کا واجب الادا بیلنس زیادہ ہو گیا ہے۔ براہ کرم والٹ ریچارج کریں۔"
    );
    return false;
  }
  if (activeExecutionRide?.id) return false;

  onlineActivationAbort = new AbortController();
  onlineActivationPromise = (async () => {
    try {
      setConnectingUi(ONLINE_READINESS.LOCATING);
      setLocationMessage("لوکیشن حاصل ہو رہی ہے…");
      lastVehicleLocationWrite = 0;
      lastLocationGridCell = null;
      lastMatchGeoCell = null;
      lastLocationSyncError = "";
      transientGpsFailCount = 0;
      stopRadarBackgroundFeed();
      stopDriverOfferInbox();

      let lat;
      let lng;
      const inSession = resolveInSessionFreshGpsFix();
      if (inSession) {
        lat = inSession.lat;
        lng = inSession.lng;
        readinessOnEvent("locating_success", {
          durationMs: 0,
          category: "in_session_reuse",
        });
      } else {
        const fix = await freshLocationService.requestFreshLocation({
          signal: onlineActivationAbort.signal,
          onEvent: readinessOnEvent,
        });
        lat = fix.lat;
        lng = fix.lng;
        lastDriverPosition = { lat, lng };
        lastGpsFixAtMs = Date.now();
        lastGpsErrorCode = "";
        locationPermissionState = "granted";
      }

      if (onlineActivationAbort.signal.aborted) {
        failOnlineActivation({ category: LOCATION_FAILURE.CANCELLED }, { silent: true });
        return false;
      }

      setConnectingUi(ONLINE_READINESS.WRITING_GEO);
      setLocationMessage("مقام سرور پر محفوظ ہو رہا ہے…");
      readinessOnEvent("geo_write_started", { state: ONLINE_READINESS.WRITING_GEO });
      try {
        await writeOnlineReadyVehicle(lat, lng);
      } catch (error) {
        console.warn("[SwiftGo Partner] vehicle online sync", error);
        readinessOnEvent("geo_write_failed", {
          category: String(error?.code || error?.message || "sync_failed").slice(0, 40),
        });
        lastLocationSyncError = String(error?.code || error?.message || "sync_failed").slice(
          0,
          80
        );
        failOnlineActivation({ category: "geo_write_failed" });
        setLocationMessage("مقام سرور پر محفوظ نہیں ہو سکا — دوبارہ کوشش کریں");
        return false;
      }

      if (onlineActivationAbort.signal.aborted) {
        failOnlineActivation({ category: LOCATION_FAILURE.CANCELLED }, { silent: true });
        return false;
      }

      hideConnectingOverlay();
      readinessOnEvent("geo_write_success", { state: ONLINE_READINESS.WRITING_GEO });
      setOnlineUi(true);
      readinessOnEvent("online_ready", { state: ONLINE_READINESS.ONLINE_READY });
      startLocationWatch();
      syncRideRadarFab();
      hideIncomingRide();
      setLocationMessage("آن لائن — قریبی درخواستیں موصول ہو سکتی ہیں");
      driverToast("آپ آن لائن ہیں");
      return true;
    } catch (error) {
      if (error?.category === LOCATION_FAILURE.PERMISSION_DENIED) {
        lastGpsErrorCode = "permission_denied";
        locationPermissionState = "denied";
      } else if (error?.category === LOCATION_FAILURE.UNAVAILABLE) {
        lastGpsErrorCode = "unavailable";
      } else if (error?.category === LOCATION_FAILURE.TIMEOUT) {
        lastGpsErrorCode = "timeout";
      }
      console.warn("[SwiftGo Partner] activate online", {
        category: error?.category || error?.message,
      });
      failOnlineActivation(error, {
        silent: error?.category === LOCATION_FAILURE.CANCELLED,
      });
      return false;
    } finally {
      hideConnectingOverlay();
      onlineActivationPromise = null;
      onlineActivationAbort = null;
      if (!isOnlineReady()) {
        syncOnlineToggleUi(false);
      }
    }
  })();

  return onlineActivationPromise;
}

async function reactivateOnlineAfterRideEnd() {
  onlineReadiness = ONLINE_READINESS.OFFLINE;
  setOnlineUi(false);
  return activateDriverOnlineMode();
}

/** @deprecated — use writeOnlineReadyVehicle via activateDriverOnlineMode */
async function markVehicleOnlineInFirestore() {
  if (!isOnlineReady()) return;
  const lat = Number(lastDriverPosition?.lat);
  const lng = Number(lastDriverPosition?.lng);
  if (!isValidCoord(lat, lng)) return;
  await writeOnlineReadyVehicle(lat, lng);
}

/** Leave current vehicle and open PIN gate for another vehicle. */
async function changeLinkedVehicle() {
  if (partnerAccountBlocked) {
    showAccountBlockedOverlay();
    return;
  }
  if (activeExecutionRide?.id) {
    window.alert(t("changeVehicleBlockedRide"));
    return;
  }
  if (!currentDriver?.uid) {
    showAuthOverlay();
    return;
  }

  const confirmed = window.confirm(t("changeVehicleConfirm"));
  if (!confirmed) return;

  closeMobileNavDrawer?.();
  setDriverOffline("");

  const { db } = getFirebase();
  const vehicleId = linkedVehicle?.id || null;
  const release = {
    status: "offline",
    driverId: deleteField(),
    driverName: deleteField(),
  };
  if (linkedVehicle?.activeRideId) {
    release.activeRideId = deleteField();
  }

  try {
    if (vehicleId) {
      await updateDoc(doc(db, "vehicles", vehicleId), release);
    }
    await setDoc(
      doc(db, "partners", currentDriver.uid),
      {
        currentVehicleId: null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    console.warn("[SwiftGo Driver] change vehicle", error);
    window.alert(t("changeVehicleFailed"));
    return;
  }

  linkedVehicle = null;
  rideRadarUi?.close?.();
  stopRadarBackgroundFeed?.();
  hideProtectedUi();
  showPinGate(t("changeVehiclePinPrompt"));
  if (els.pinInput) {
    els.pinInput.value = "";
    els.pinInput.focus?.();
  }
}


function handleLocationError(error) {
  const denied = error?.code === 1;
  lastGpsErrorCode = denied ? "permission_denied" : "unavailable";
  locationPermissionState = denied ? "denied" : "error";
  paintDriverAvailabilityDiag();

  if (denied) {
    transientGpsFailCount = 0;
    setDriverOffline("لائیو مقام کے لیے براؤزر میں لوکیشن کی اجازت دیں");
    return;
  }

  // Transient GPS blip: keep online + radar if last fix is still fresh.
  const fresh = lastGpsFixAtMs > 0 && Date.now() - lastGpsFixAtMs < FRESH_GPS_MS;
  if (fresh) {
    transientGpsFailCount += 1;
    setLocationMessage("مقام عارضی طور پر نہیں ملا — آخری مقام استعمال ہو رہا ہے");
    if (transientGpsFailCount < TRANSIENT_GPS_FAIL_LIMIT) return;
  }

  setDriverOffline("موجودہ مقام حاصل نہیں ہو سکا، دوبارہ کوشش کریں");
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    setLocationMessage("یہ براؤزر لائیو لوکیشن سپورٹ نہیں کرتا");
    setOnlineUi(false);
    return;
  }

  hasCenteredOnDriver = false;
  if (!locationTrackingSessionId) beginLocationTrackingSession();
  setLocationMessage("آپ کا موجودہ مقام تلاش کیا جا رہا ہے...");

  // Immediate fix for matching — don't wait for watchPosition throttle.
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      updateDriverLocation(pos);
      syncVehicleLocationToFirestore(pos.coords.latitude, pos.coords.longitude, {
        force: true,
        heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
        accuracy: pos.coords.accuracy,
        speed: Number.isFinite(pos.coords.speed) && pos.coords.speed >= 0 ? pos.coords.speed : null,
        observedAt: Number(pos.timestamp) || Date.now(),
      });
    },
    () => {
      /* watchPosition will surface errors */
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
  );

  watchId = navigator.geolocation.watchPosition(
    updateDriverLocation,
    handleLocationError,
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    }
  );
}

function stopLocationWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  endLocationTrackingSession();
}

function stopRideListener() {
  unsubscribeRides();
  unsubscribeRides = () => {};
}

/** @deprecated Incoming sheet disabled — rides only via «رائٹ حاصل کریں». */
function startRideListener() {
  stopRideListener();
  hideIncomingRide();
}

function hideIncomingRide() {
  activeRequest = null;
  window.clearTimeout(hideSheetTimer);
  if (els.requestSheet) {
    els.requestSheet.classList.remove("is-visible");
    els.requestSheet.hidden = true;
    els.requestSheet.setAttribute("aria-hidden", "true");
    els.requestSheet.style.display = "none";
  }
  els.app?.classList.remove("has-incoming-ride");
}

/** @deprecated Phase 4C — isolated; never show legacy incoming sheet. */
function showIncomingRide(_request) {
  hideIncomingRide();
}

function setDriverOffline(message = "آپ آف لائن ہیں") {
  cancelOnlineActivation({ silent: true });
  onlineReadiness = ONLINE_READINESS.OFFLINE;
  stopLocationWatch();
  stopRideListener();
  stopRadarBackgroundFeed();
  stopDriverOfferInbox();
  hideIncomingRide();
  hideConnectingOverlay();
  setOnlineUi(false);
  markVehicleOfflineInFirestore();
  setLocationMessage(message);
  paintDriverAvailabilityDiag();
}

function toggleDriverStatus() {
  if (partnerAccountBlocked) {
    showAccountBlockedOverlay();
    return;
  }

  if (walletLocked) {
    setLocationMessage(
      "کمپنی کا واجب الادا بیلنس زیادہ ہو گیا ہے۔ براہ کرم والٹ ریچارج کریں۔"
    );
    if (els.driverWalletWarning) els.driverWalletWarning.hidden = false;
    return;
  }

  if (
    onlineReadiness === ONLINE_READINESS.LOCATING ||
    onlineReadiness === ONLINE_READINESS.WRITING_GEO
  ) {
    logOnlineReadinessEvent("offline_during_locating", {
      state: onlineReadiness,
    });
    setDriverOffline();
    return;
  }

  if (online) {
    setDriverOffline();
    return;
  }

  if (!currentDriver) {
    setLocationMessage("پہلے کسٹمر ایپ میں اپنے اکاؤنٹ سے سائن اِن کریں");
    return;
  }

  if (!linkedVehicle) {
    setLocationMessage("آن لائن ہونے کے لیے پہلے گاڑی کا PIN درج کریں");
    showPinGate();
    return;
  }

  void activateDriverOnlineMode();
}

function setRequestButtonsBusy(busy) {
  if (els.acceptBtn) els.acceptBtn.disabled = busy;
  if (els.declineBtn) els.declineBtn.disabled = busy;
}

/* ── Phase 32: active ride execution cycle ── */

async function refreshLinkedVehicleAndPartner() {
  if (!currentDriver?.uid) return;
  const { db } = getFirebase();
  if (linkedVehicle?.id) {
    try {
      const vSnap = await getDoc(doc(db, "vehicles", linkedVehicle.id));
      if (vSnap.exists()) {
        linkedVehicle = { id: vSnap.id, ...vSnap.data() };
      }
    } catch (error) {
      console.warn("[SwiftGo Driver] refresh linked vehicle", error);
    }
  }
  try {
    await getDoc(doc(db, "partners", currentDriver.uid));
  } catch (error) {
    console.warn("[SwiftGo Driver] refresh partner doc", error);
  }
}

async function dismissStaleActiveRide() {
  stopActiveRideWatch();
  detachCheckpointPresence("stale_or_terminal");
  activeExecutionRide = null;
  clearActiveRideCache();
  hideActiveRideSheet();
  hideRideCompleteSheet();
  syncRideRadarFab();
  paintDriverAvailabilityDiag();
}

async function probeOrphanedActiveRide(partner = null) {
  activeRideRecoveryPending = false;
  if (!currentDriver?.uid) return false;

  const cached = readActiveRideCache();
  const candidateIds = collectActiveRideCandidateIds(partner, linkedVehicle, cached);
  const { db } = getFirebase();

  if (!candidateIds.length) {
    try {
      const snap = await getDocs(
        query(
          collection(db, "rides"),
          where("driverId", "==", currentDriver.uid),
          where("status", "in", ["accepted", "arrived", "in_progress"]),
          limit(1)
        )
      );
      if (!snap.empty) candidateIds.push(snap.docs[0].id);
    } catch (error) {
      console.warn("[SwiftGo Driver] probe orphaned active ride query", error);
    }
  }

  for (const rideId of candidateIds) {
    try {
      const snap = await getDoc(doc(db, "rides", rideId));
      if (!snap.exists()) {
        if (cached?.rideId === rideId) clearActiveRideCache();
        continue;
      }
      const validation = validateRideForDriverRestore(snap.data(), currentDriver.uid);
      if (!validation.ok) {
        if (cached?.rideId === rideId) clearActiveRideCache();
        continue;
      }
      if (!partner?.currentVehicleId && !linkedVehicle?.id) {
        activeRideRecoveryPending = true;
        return true;
      }
    } catch (error) {
      console.warn("[SwiftGo Driver] probe orphaned active ride doc", error);
    }
  }
  return false;
}

async function finalizeSuccessfulRideCompletion(ride, settlementResult) {
  stopActiveRideWatch();
  clearActiveRideCache();
  hideActiveRideSheet();

  const completedRide = {
    ...ride,
    status: "completed",
    commissionAmount:
      Number(settlementResult?.commissionAmount) || Number(ride.commissionAmount) || 0,
    driverEarnings: Number(settlementResult?.driverEarnings) || Number(ride.driverEarnings) || 0,
    estimatedFare:
      Number(settlementResult?.estimatedFare) ||
      Number(settlementResult?.grossFare) ||
      rideFareAmount(ride),
  };

  activeExecutionRide = null;
  activeRideRecoveryPending = false;
  detachCheckpointPresence("ride_completed");

  const orphanedCompletion = !linkedVehicle?.id;

  if (orphanedCompletion) {
    hideRideCompleteSheet();
    setDriverOffline("");
    driverToast(ORPHANED_RIDE_COMPLETE_URDU);
    setLocationMessage(ORPHANED_RIDE_COMPLETE_URDU);
    announce("سواری مکمل ہو گئی / Ride completed");
    showPinGate(ORPHANED_RIDE_COMPLETE_URDU);
    paintDriverAvailabilityDiag();
    return;
  }

  activeExecutionRide = completedRide;
  showRideCompleteSheet(completedRide);
  activeExecutionRide = null;

  try {
    await markVehicleRideId(null);
    await refreshLinkedVehicleAndPartner();
  } catch (error) {
    console.warn("[SwiftGo Driver] post-completion vehicle refresh", error);
  }

  const ready = await reactivateOnlineAfterRideEnd();
  paintDriverAvailabilityDiag();
  setLocationMessage(
    ready
      ? "سواری مکمل — آپ دوبارہ آن لائن ہیں"
      : "سواری مکمل — آن لائن کے لیے مقام/اجازت چیک کریں"
  );
  announce("سواری مکمل ہو گئی / Ride completed");
}

function askDriverCancelConfirm(message) {
  const root = document.getElementById("driverCancelConfirmDialog");
  const msgEl = document.getElementById("driverCancelConfirmMessage");
  const yesBtn = document.getElementById("driverCancelConfirmYes");
  const noBtn = document.getElementById("driverCancelConfirmNo");
  const backdrop = root?.querySelector("[data-driver-cancel-backdrop]");

  if (!root || !yesBtn || !noBtn) {
    return Promise.resolve(window.confirm(message));
  }

  if (msgEl) msgEl.textContent = message;
  root.hidden = false;
  requestAnimationFrame(() => root.classList.add("is-visible"));

  return new Promise((resolve) => {
    const cleanup = (value) => {
      root.classList.remove("is-visible");
      root.hidden = true;
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      backdrop?.removeEventListener("click", onNo);
      resolve(value);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    backdrop?.addEventListener("click", onNo);
  });
}

async function resumeActiveRideFromDoc(rideId, data, collectionName = "rides") {
  const validation = validateRideForDriverRestore(data, currentDriver?.uid);
  if (!validation.ok) {
    clearActiveRideCache();
    return false;
  }

  activeExecutionRide = { id: rideId, ...data, sourceCollection: collectionName };
  if (!linkedVehicle?.id) {
    activeRideRecoveryPending = true;
  } else {
    activeRideRecoveryPending = false;
  }
  persistActiveRideCache(rideId, collectionName);
  await markVehicleRideId(rideId);
  startActiveRideWatch(rideId, collectionName);
  syncCheckpointPresenceForActiveRide();
  renderActiveRideControls(activeExecutionRide);
  setLocationMessage(
    linkedVehicle?.id
      ? "فعال سواری بحال ہو گئی — جاری رکھیں"
      : ACTIVE_RIDE_RECOVERY_URDU
  );
  syncRideRadarFab();
  return true;
}

async function restoreActiveExecutionRide(partner = null) {
  if (!currentDriver?.uid || activeExecutionRide?.id) return;

  const cached = readActiveRideCache();
  const candidateIds = collectActiveRideCandidateIds(partner, linkedVehicle, cached);
  const collectionName = cached?.collectionName || "rides";

  for (const rideId of candidateIds) {
    try {
      const { db } = getFirebase();
      const snap = await getDoc(doc(db, collectionName, rideId));
      if (!snap.exists()) {
        if (cached?.rideId === rideId) clearActiveRideCache();
        continue;
      }
      const validation = validateRideForDriverRestore(snap.data(), currentDriver.uid);
      if (!validation.ok) {
        if (cached?.rideId === rideId) clearActiveRideCache();
        if (
          validation.reason === "terminal_or_inactive" &&
          (partner?.activeRideId === rideId || linkedVehicle?.activeRideId === rideId)
        ) {
          console.info("[SwiftGo Partner readiness]", {
            event: "stale_pointer_detected_client",
            category: validation.reason,
          });
          setLocationMessage(STALE_POINTER_RECOVERY_URDU);
        }
        continue;
      }
      const ok = await resumeActiveRideFromDoc(snap.id, snap.data(), collectionName);
      if (ok) return;
    } catch (error) {
      console.warn("[SwiftGo Driver] restore active ride doc", error);
    }
  }

  if (!linkedVehicle?.id) return;

  try {
    const { db } = getFirebase();
    const snap = await getDocs(
      query(
        collection(db, "rides"),
        where("driverId", "==", currentDriver.uid),
        where("status", "in", ["accepted", "arrived", "in_progress"]),
        limit(1)
      )
    );
    if (snap.empty) return;
    const docSnap = snap.docs[0];
    await resumeActiveRideFromDoc(docSnap.id, docSnap.data(), "rides");
  } catch (error) {
    console.warn("[SwiftGo Driver] restore active ride query", error);
  }
}

const ACTIVE_RIDE_ACTIONS = {
  accepted: {
    title: "ڈرائیور راستے میں ہے — پک اپ پر جائیں",
    button: "میں پہنچ گیا ہوں",
    nextStatus: "arrived",
  },
  arrived: {
    title: "آپ پک اپ پر پہنچ گئے",
    button: "سواری شروع کریں",
    nextStatus: "in_progress",
  },
  in_progress: {
    title: "سواری جاری ہے",
    button: "سواری ختم کریں",
    nextStatus: "completed",
  },
};

function rideFareAmount(ride) {
  const value = Number(ride?.estimatedFare ?? ride?.farePkr ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function stopActiveRideWatch() {
  unsubscribeActiveRide();
  unsubscribeActiveRide = () => {};
}

function hideActiveRideSheet() {
  els.activeRideSheet?.classList.remove("is-visible");
  els.app?.classList.remove("has-active-ride");
  if (els.activeRideSheet) els.activeRideSheet.hidden = true;
}

function hideRideCompleteSheet() {
  els.rideCompleteSheet?.classList.remove("is-visible");
  if (els.rideCompleteSheet) els.rideCompleteSheet.hidden = true;
}

function showRideCompleteSheet(ride) {
  hideActiveRideSheet();
  const fare = rideFareAmount(ride);
  const earnings = Number(ride?.driverEarnings);
  const commission = Number(ride?.commissionAmount);
  if (els.rideCompleteFare) {
    els.rideCompleteFare.textContent = `Rs. ${fare}`;
  }
  let earningsLine = document.getElementById("rideCompleteEarnings");
  if (!earningsLine && els.rideCompleteFare) {
    earningsLine = document.createElement("p");
    earningsLine.id = "rideCompleteEarnings";
    earningsLine.className = "ride-complete-sheet__earnings";
    els.rideCompleteFare.insertAdjacentElement("afterend", earningsLine);
  }
  if (earningsLine) {
    const driverPay = Number.isFinite(earnings) ? Math.round(earnings) : fare;
    const cut = Number.isFinite(commission) ? Math.round(commission) : 0;
    earningsLine.textContent = `آپ کی کمائی: Rs. ${driverPay} · کمیشن: Rs. ${cut}`;
  }
  if (!els.rideCompleteSheet) return;
  els.rideCompleteSheet.hidden = false;
  requestAnimationFrame(() => els.rideCompleteSheet?.classList.add("is-visible"));
}

function renderActiveRideControls(ride) {
  if (!ride || ride.status === "completed") {
    if (ride?.status === "completed") showRideCompleteSheet(ride);
    else hideActiveRideSheet();
    return;
  }

  const action = ACTIVE_RIDE_ACTIONS[ride.status];
  if (!action) {
    hideActiveRideSheet();
    return;
  }

  hideRideCompleteSheet();
  if (els.activeRideStatusTitle) els.activeRideStatusTitle.textContent = action.title;
  if (els.activeRidePickup) {
    els.activeRidePickup.textContent =
      ride.pickupLocation?.address || "پک اپ مقام دستیاب نہیں";
  }
  if (els.activeRideDropoff) {
    els.activeRideDropoff.textContent =
      ride.dropoffLocation?.address || "ڈراپ آف مقام دستیاب نہیں";
  }
  if (els.activeRideFare) {
    els.activeRideFare.textContent = `Rs. ${rideFareAmount(ride)}`;
  }
  if (els.activeRideActionBtn) {
    els.activeRideActionBtn.textContent = action.button;
    els.activeRideActionBtn.dataset.nextStatus = action.nextStatus;
    els.activeRideActionBtn.disabled = false;
  }
  if (els.activeRideCancelBtn) {
    const canCancel = ride.status === "accepted" || ride.status === "arrived";
    els.activeRideCancelBtn.hidden = !canCancel;
    els.activeRideCancelBtn.disabled = !canCancel;
  }

  if (els.activeRideSheet) els.activeRideSheet.hidden = false;
  els.app?.classList.add("has-active-ride");
  requestAnimationFrame(() => els.activeRideSheet?.classList.add("is-visible"));
  rideRadarUi?.close();
  clearRadarPendingCache();
  if (ride.status === "accepted") {
    announce("سواری تفویض / Ride assigned");
  }
  syncRideRadarFab();
}

function startActiveRideWatch(rideId, collectionName = "rides") {
  stopActiveRideWatch();
  if (!rideId) return;

  persistActiveRideCache(rideId, collectionName);

  const { db } = getFirebase();
  unsubscribeActiveRide = onSnapshot(
    doc(db, collectionName, rideId),
    (snapshot) => {
      if (!snapshot.exists()) {
        void dismissStaleActiveRide();
        return;
      }
      activeExecutionRide = { id: snapshot.id, ...snapshot.data(), sourceCollection: collectionName };
      if (ACTIVE_EXECUTION_STATUSES.has(String(activeExecutionRide.status || ""))) {
        persistActiveRideCache(snapshot.id, collectionName);
        syncCheckpointPresenceForActiveRide();
      } else {
        clearActiveRideCache();
        detachCheckpointPresence("terminal_status");
      }
      renderActiveRideControls(activeExecutionRide);
    },
    (error) => {
      console.warn("[SwiftGo Partner] Firestore listen retry... active ride", error);
      setLocationMessage("فعال سواری کی صورتحال لوڈ نہیں ہو سکی");
    }
  );
}

async function markVehicleRideId(rideId) {
  if (!linkedVehicle?.id) return;
  try {
    const { db } = getFirebase();
    await updateDoc(doc(db, "vehicles", linkedVehicle.id), {
      status: rideId ? "in_ride" : "online",
      activeRideId: rideId || null,
    });
    if (rideId && lastDriverPosition) {
      await syncVehicleLocationToFirestore(lastDriverPosition.lat, lastDriverPosition.lng, {
        force: true,
      });
    }
  } catch (error) {
    console.warn("[SwiftGo Partner] vehicle activeRideId", error);
  }
}

async function fetchSystemCommissionPercent(ride = null) {
  try {
    const { db } = getFirebase();
    const snap = await getDoc(doc(db, "settings", "pricing"));
    if (!snap.exists()) return 10;
    const data = snap.data() || {};

    const vehicleKey =
      ride?.vehicleTypeKey ||
      resolveVehicleKeyFromLabel(ride?.vehicleType) ||
      "";
    const fromVehicle = Number(data.vehicles?.[vehicleKey]?.commissionPercent);
    if (Number.isFinite(fromVehicle) && fromVehicle >= 0 && fromVehicle <= 100) {
      return fromVehicle;
    }

    const value = Number(data.commissionPercent ?? data.systemCommission ?? 10);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 10;
  } catch (error) {
    console.warn("[SwiftGo Partner] pricing commission", error);
    return 10;
  }
}

/** Phase 2A — settlement via trusted Cloud Function only (no client wallet/commission writes). */
async function completeRideWithEarnings(ride) {
  const driver = currentDriver;
  if (!ride?.id || !driver?.uid) {
    throw new Error("NO_ACTIVE_RIDE");
  }

  const result = await requestRideSettlement({
    rideId: ride.id,
    collectionName: ride.sourceCollection || "rides",
  });

  return {
    commissionAmount: Number(result?.commissionAmount) || 0,
    driverEarnings: Number(result?.driverEarnings) || 0,
    estimatedFare: Number(result?.grossFare) || rideFareAmount(ride),
    alreadySettled: Boolean(result?.alreadySettled),
  };
}

async function cancelAssignedActiveRideByDriver() {
  const ride = activeExecutionRide;
  if (!ride?.id) return;
  if (ride.status !== "accepted" && ride.status !== "arrived") {
    driverToast("سواری شروع ہونے کے بعد یہاں سے منسوخ نہیں ہو سکتی");
    return;
  }
  const ok = await askDriverCancelConfirm(
    "کیا آپ واقعی یہ سواری منسوخ کرنا چاہتے ہیں؟ منسوخ کرنے پر بکنگ دوبارہ تلاش میں چلی جائے گی۔"
  );
  if (!ok) return;
  if (els.activeRideCancelBtn) els.activeRideCancelBtn.disabled = true;
  try {
    const result = await cancelAssignedRideByDriverClient(ride.id, {
      cancelReasonKey: "other",
      cancelReason: "driver_cancelled_before_start",
    });
    stopActiveRideWatch();
    detachCheckpointPresence("driver_cancelled");
    activeExecutionRide = null;
    clearActiveRideCache();
    hideActiveRideSheet();
    await markVehicleRideId(null);
    await reactivateOnlineAfterRideEnd();
    paintDriverAvailabilityDiag();
    driverToast(
      result?.candidateCount
        ? `سواری دوبارہ تلاش میں ہے (${result.candidateCount} امیدوار)`
        : "سواری دوبارہ تلاش میں ہے"
    );
  } catch (err) {
    console.warn("[SwiftGo Driver] cancel assigned", err);
    driverToast(String(err?.message || "منسوخ نہیں ہو سکی"));
  } finally {
    if (els.activeRideCancelBtn) els.activeRideCancelBtn.disabled = false;
  }
}

async function advanceActiveRideStatus() {
  const ride = activeExecutionRide;
  const nextStatus = els.activeRideActionBtn?.dataset.nextStatus;
  if (!ride?.id || !nextStatus) return;
  if (activeRideCompletionInFlight) return;

  if (els.activeRideActionBtn) els.activeRideActionBtn.disabled = true;
  try {
    const { db } = getFirebase();

    if (nextStatus === "completed") {
      activeRideCompletionInFlight = true;
      const rideCollection = ride.sourceCollection || "rides";
      const liveSnap = await getDoc(doc(db, rideCollection, ride.id));
      if (!liveSnap.exists()) {
        await dismissStaleActiveRide();
        setLocationMessage("سواری سرور پر نہیں ملی — کیش صاف کر دی گئی");
        if (els.activeRideActionBtn) els.activeRideActionBtn.disabled = false;
        return;
      }
      const live = liveSnap.data() || {};
      const validation = validateRideForDriverRestore(live, currentDriver?.uid);
      if (!validation.ok) {
        if (String(live.status || "") === "completed") {
          await finalizeSuccessfulRideCompletion(
            { ...ride, ...live, id: ride.id, sourceCollection: rideCollection },
            {
              commissionAmount: live.commissionAmount,
              driverEarnings: live.driverEarnings,
              grossFare: live.estimatedFare ?? live.farePkr,
              alreadySettled: true,
            }
          );
          return;
        }
        await dismissStaleActiveRide();
        setLocationMessage("فعال سواری اب درست نہیں — ریفریش کریں");
        if (els.activeRideActionBtn) els.activeRideActionBtn.disabled = false;
        return;
      }
      const settlementResult = await completeRideWithEarnings({ ...ride, ...live });
      await finalizeSuccessfulRideCompletion(
        { ...ride, ...live, id: ride.id, sourceCollection: rideCollection },
        settlementResult
      );
      return;
    }

    const rideCollection = ride.sourceCollection || "rides";
    await updateDoc(doc(db, rideCollection, ride.id), { status: nextStatus });
    if (nextStatus === "arrived") {
      setLocationMessage("پک اپ پر پہنچنے کی اطلاع بھیج دی گئی");
      announce("ڈرائیور پہنچ گئے / Driver arrived");
    } else if (nextStatus === "in_progress") {
      setLocationMessage("سواری شروع کر دی گئی");
      announce("سواری شروع / Ride started");
    } else {
      setLocationMessage("اسٹیٹس اپڈیٹ ہو گئی");
    }
  } catch (error) {
    const { category, userMessageUrdu } = classifySettlementFailure(error);
    console.error("[SwiftGo Driver] advance ride status failed", {
      category,
      rideId: ride?.id,
      nextStatus,
      error,
    });
    setLocationMessage(userMessageUrdu);
    driverToast(userMessageUrdu);
    if (els.activeRideActionBtn) els.activeRideActionBtn.disabled = false;
  } finally {
    if (nextStatus === "completed") {
      activeRideCompletionInFlight = false;
    }
  }
}

async function findNewRideAfterCompletion() {
  if (els.findNewRideBtn) els.findNewRideBtn.disabled = true;
  try {
    hideRideCompleteSheet();
    hideActiveRideSheet();
    if (!online) {
      const ready = await reactivateOnlineAfterRideEnd();
      setLocationMessage(
        ready
          ? "نئی سواری تلاش کے لیے تیار — آپ آن لائن ہیں"
          : "سواری مکمل — آن لائن کے لیے مقام/اجازت چیک کریں"
      );
    } else {
      setLocationMessage("نئی سواری تلاش کے لیے تیار — آپ آن لائن ہیں");
    }
    paintDriverAvailabilityDiag();
  } finally {
    if (els.findNewRideBtn) els.findNewRideBtn.disabled = false;
  }
}

async function resolveActiveRequest(nextStatus) {
  const request = activeRequest;
  const driver = currentDriver;
  if (!request?.id || !driver) return;

  setRequestButtonsBusy(true);
  const { db } = getFirebase();
  const rideRef = doc(db, "rides", request.id);
  const vehicleRef =
    nextStatus === "accepted" && linkedVehicle?.id
      ? doc(db, "vehicles", linkedVehicle.id)
      : null;

  try {
    await runTransaction(db, async (transaction) => {
      if (nextStatus === "accepted" && !vehicleRef) {
        throw new Error("VEHICLE_NOT_LINKED");
      }

      const [rideSnapshot, vehicleSnapshot] = await Promise.all([
        transaction.get(rideRef),
        vehicleRef ? transaction.get(vehicleRef) : Promise.resolve(null),
      ]);

      if (!rideSnapshot.exists() || rideSnapshot.data().status !== "searching_driver") {
        throw new Error("RIDE_NOT_AVAILABLE");
      }

      const update = {
        status: nextStatus,
        driverId: driver.uid,
      };

      if (nextStatus === "accepted") {
        if (
          !vehicleSnapshot?.exists() ||
          vehicleSnapshot.data().driverId !== driver.uid ||
          !vehicleSnapshot.data().ownerId
        ) {
          throw new Error("VEHICLE_NOT_LINKED");
        }

        const rideData = rideSnapshot.data() || {};
        const acceptedFare = Math.max(
          0,
          Math.round(
            Number(
              rideData.customerCounterFare > 0
                ? rideData.customerCounterFare
                : rideData.farePkr ?? rideData.estimatedFare ?? 0
            ) || 0
          )
        );

        update.vehicleId = vehicleSnapshot.id;
        update.ownerId = vehicleSnapshot.data().ownerId;
        update.vehiclePlate = vehicleSnapshot.data().plate || "—";
        update.driverName = driver.displayName || "SwiftGo Driver";
        update.farePkr = acceptedFare;
        update.estimatedFare = acceptedFare;
        update.driverBidFare = acceptedFare;
      }

      transaction.update(rideRef, update);
    });

    hideIncomingRide();

    if (nextStatus === "accepted") {
      stopRideListener();
      activeExecutionRide = { id: request.id, ...request, status: "accepted", sourceCollection: "rides" };
      await markVehicleRideId(request.id);
      startActiveRideWatch(request.id);
      syncCheckpointPresenceForActiveRide();
      renderActiveRideControls(activeExecutionRide);
      setLocationMessage("سواری قبول کر لی گئی ہے — پک اپ کی طرف جائیں");
    } else {
      setLocationMessage("سواری مسترد کر دی گئی ہے");
    }
  } catch (error) {
    console.warn(`[SwiftGo Driver] ${nextStatus} ride`, error);
    setLocationMessage(
      error?.message === "RIDE_NOT_AVAILABLE"
        ? "یہ سواری اب دستیاب نہیں ہے"
        : error?.message === "VEHICLE_NOT_LINKED"
          ? "منسلک گاڑی کی تصدیق نہیں ہو سکی"
        : "کارروائی مکمل نہیں ہو سکی"
    );
  } finally {
    setRequestButtonsBusy(false);
  }
}

async function handleRadarRideAccepted(result) {
  const rideId = result?.rideId;
  const collectionName = result?.collection || "rides";
  if (!rideId || !currentDriver) return;

  hideIncomingRide();
  stopRideListener();
  rideRadarUi?.close();
  clearRadarPendingCache();

  try {
    const { db } = getFirebase();
    const snap = await getDoc(doc(db, collectionName, rideId));
    if (!snap.exists()) {
      setLocationMessage("سواری لوڈ نہیں ہو سکی");
      syncRideRadarFab();
      return;
    }
    activeExecutionRide = {
      id: rideId,
      ...snap.data(),
      status: "accepted",
      sourceCollection: collectionName,
    };
    await markVehicleRideId(rideId);
    startActiveRideWatch(rideId, collectionName);
    syncCheckpointPresenceForActiveRide();
    renderActiveRideControls(activeExecutionRide);
    setLocationMessage("سواری قبول — پک اپ کی طرف جائیں");
  } catch (error) {
    console.warn("[SwiftGo Radar] post-accept", error);
    setLocationMessage("سواری فعال نہیں ہو سکی");
    syncRideRadarFab();
  }
}

function boot() {
  try {
    markDriverAppSurface();
    applyReducedMotionClass();
    initKeyboardInset();
    initI18n();
    initRateDetailsModal();
    wireLegalLinks();
    document.getElementById("partnerDeleteAccountBtn")?.addEventListener("click", async () => {
      const status = document.getElementById("partnerTrustStatus");
      const confirmed = window.confirm(
        "Request account deletion? Login will be disabled. Financial ledger, settlement, and audit records are retained."
      );
      if (!confirmed) return;
      try {
        await requestAccountDeletionClient({ roleHint: "partner", appId: "partner" });
        if (status) {
          status.textContent =
            "Deletion requested. Ledger/settlement/audit retained. Signing out…";
        }
        await logoutPartner();
      } catch (err) {
        console.warn("[SwiftGo] deletion", err);
        if (status) status.textContent = "Deletion request failed. Contact support.";
      }
    });
    subscribeLang(() => {
      const connecting =
        onlineReadiness === ONLINE_READINESS.LOCATING ||
        onlineReadiness === ONLINE_READINESS.WRITING_GEO
          ? onlineReadiness
          : "";
      syncOnlineToggleUi(online, connecting);
    });
    const devNote = document.getElementById("partnerDevModeNote");
    if (devNote) devNote.hidden = !shouldUseEmulators();
    hideProtectedUi();
    showAuthOverlay();
  els.statusToggle?.addEventListener("click", toggleDriverStatusFromUi);
  els.googleLoginBtn?.addEventListener("click", signInDriverWithGoogle);
  // Phase 4C: legacy incoming accept/decline remain disabled (Ride Radar is canonical)
  els.activeRideActionBtn?.addEventListener("click", advanceActiveRideStatus);
  els.activeRideCancelBtn?.addEventListener("click", cancelAssignedActiveRideByDriver);
  els.activeRideRateBtn?.addEventListener("click", () => {
    const ride = activeExecutionRide;
    if (!ride) return;
    void openRateDetails({
      vehicleTypeKey:
        ride.vehicleTypeKey ||
        resolveVehicleKeyFromLabel(ride.vehicleType || ride.vehicleCategory),
      vehicleTypeLabel: ride.vehicleType || ride.vehicleCategory,
      distanceKm: ride.distanceKm ?? ride.tripDistanceKm,
      durationMin: ride.estimatedDurationMin ?? ride.durationMin,
      estimatedFare: rideFareAmount(ride),
      mode: "ride",
    });
  });
  els.findNewRideBtn?.addEventListener("click", findNewRideAfterCompletion);
  els.pinLogoutBtn?.addEventListener("click", logoutPartner);
  els.blockedLogoutBtn?.addEventListener("click", logoutPartner);
  els.pinForm?.addEventListener("submit", verifyVehiclePin);
  els.pinInput?.addEventListener("input", () => setPinMessage(""));
  wirePartnerNavigation();
  initMobileNavDrawer();
  els.sidebarLogoutBtn?.addEventListener("click", logoutPartner);
  document.getElementById("changeVehicleBtn")?.addEventListener("click", () => {
    void changeLinkedVehicle();
  });
  document.getElementById("openRateDetailsBtn")?.addEventListener("click", () => {
    if (usesDriverSlideNav()) closeMobileNavDrawer();
    void openRateDetails({ mode: "all", title: "تمام گاڑیوں کے ریٹ" });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.vehicleModal?.hidden) closeVehicleModal();
  });

  initWalletRecharge({
    getDriver: () => currentDriver,
    onToast: driverToast,
  });

  earningsUi = initEarningsDetail(document.getElementById("earningsDetailRoot"), {
    getDriverUid: () => currentDriver?.uid ?? null,
    onOpenWallet: () => setActiveView("wallet"),
  });

  dashboardUi = initDriverDashboard({
    getDriverUid: () => currentDriver?.uid ?? null,
    earningsChartEl: document.getElementById("dashboardEarningsChart"),
    ratioChartEl: document.getElementById("dashboardRidesRatioChart"),
  });

  homeUi = initDriverHome(document.getElementById("driverHomeRoot"), {
    getDriverUid: () => currentDriver?.uid ?? null,
    getWalletThreshold: () => cachedWalletThreshold,
    onOpenWallet: () => setActiveView("wallet"),
    onMapMount: () => ensureDriverMap(),
  });

  rideRadarUi = initRideRadarFlow({
    root: document.getElementById("rideRadarRoot"),
    listHost: document.getElementById("rideRadarListHost"),
    detailHost: document.getElementById("rideRadarDetailHost"),
    triggerBtn: document.getElementById("openRideRadarBtn"),
    getDriverUid: () => currentDriver?.uid ?? null,
    getDriver: () => currentDriver,
    getLinkedVehicle: () => linkedVehicle,
    getDriverPosition: () => lastDriverPosition,
    getIsOnline: () => isOnlineReady(),
    getHasActiveRide: () => Boolean(activeExecutionRide?.id),
    getOfferForRide: (rideId) => driverOfferInbox?.getOfferForRide?.(rideId) ?? null,
    getCounterRideIds: () => driverOfferInbox?.rideIdsWithCustomerCounter?.() ?? [],
    onRideAccepted: handleRadarRideAccepted,
    onToast: driverToast,
  });

  driverOfferInbox = createDriverOfferInbox({
    getDriverUid: () => currentDriver?.uid ?? null,
    onOffersChanged: () => {
      rideRadarUi?.refreshList?.();
      rideRadarUi?.syncDetailFromInbox?.();
    },
    onCustomerCounter: handleCustomerCounterOffer,
  });

  initAudioService({ storagePrefix: "swiftgo_driver_" });
  initNotificationSettingsUI();
  AudioService.requestBrowserNotificationPermission().catch(() => {});

  const firebase = getFirebase();
  if (firebase.auth) {
    getRedirectResult(firebase.auth).catch((error) => {
      console.warn("[SwiftGo Driver] Google redirect", error);
      setAuthStatus("Google لاگ اِن مکمل نہیں ہو سکا");
    });
    onAuthStateChanged(firebase.auth, async (user) => {
      if (!user) {
        authSequence += 1;
        cancelOnlineActivation({ silent: true });
        onlineActivationPromise = null;
        online = false;
        onlineReadiness = ONLINE_READINESS.OFFLINE;
        hideConnectingOverlay();
        stopLocationWatch();
        currentDriver = null;
        linkedVehicle = null;
        partnerMode = null;
        partnerAccountBlocked = false;
        activeExecutionRide = null;
        clearActiveRideCache();
        detachCheckpointPresence("sign_out");
        earningsUi?.deactivate();
        dashboardUi?.deactivate();
        homeUi?.deactivate();
        rideRadarUi?.close();
        stopDriverOfferInbox();
        stopPartnerDocListener();
        stopActiveRideWatch();
        hideAccountBlockedOverlay();
        hideActiveRideSheet();
        hideRideCompleteSheet();
        hideProtectedUi();
        setLoginBusy(false);
        showAuthOverlay();
        return;
      }
      await activateAuthenticatedDriver(user);
    });
  } else {
    showAuthOverlay("فائر بیس دستیاب نہیں ہے");
  }
  console.info(
    `[SwiftGo Driver] ready · project=${firebaseConfig.projectId} · firebase=${
      isFirebaseConfigured() && firebase.ready
    }`
  );
  } catch (error) {
    console.error("[SwiftGo Driver] boot failed", error);
    showAuthOverlay("ایپ شروع نہیں ہو سکی — صفحہ ریفریش کریں");
  }
}

boot();
