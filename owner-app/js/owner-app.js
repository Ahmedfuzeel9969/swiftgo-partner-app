/** SwiftGo Owner app — fleet vehicles, PIN share, owner ride history. Stays on /owner/. */

import { firebaseConfig } from "./firebase-config.js";
import { getFirebase, isFirebaseConfigured, shouldUseEmulators } from "./firebase.js";
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
import { requestRideSettlement } from "./settlement-client.js";
import { hashVehiclePin } from "./pin-hash.js";
import { linkVehicleByPinClient } from "./pin-link-client.js";
import { applyReducedMotionClass, initKeyboardInset, trapFocus } from "./a11y.js";
import { initI18n, t } from "./i18n.js";
import { wireLegalLinks, requestAccountDeletionClient } from "./trust.js";
import { isNativeShell, getNativePlatform, getNetworkStatus } from "./native-shell.js";

window.__swiftgoNative = { isNativeShell, getNativePlatform, getNetworkStatus };
window.__SWIFTGO_ANDROID_PACKAGE__ = "com.swiftgo.owner";

/** Phase 4C — fleet-only surface; legacy driver-fork ride execution paths stay inert. */
const OWNER_FLEET_ONLY = true;

const KARACHI = [24.8607, 67.0011];

/** Only this Owner may use God Mode (Driver ↔ Admin). Regular drivers never. */
const SUPER_ADMIN_EMAIL = "fuzail1158@gmail.com";

function isSuperAdminUser(user = currentDriver) {
  const email = (user?.email || "").trim().toLowerCase();
  return Boolean(email) && email === SUPER_ADMIN_EMAIL;
}

/**
 * True only when the signed-in Owner is in Driver Mode (admin_driver).
 * Regular drivers must never get return-to-admin or PIN bypass.
 */
function isOwnerInDriverMode(partner, user = currentDriver) {
  return isSuperAdminUser(user) && partner?.role === "admin_driver";
}

const PARTNER_VIEW_TITLES = {
  dashboard: "ڈیش بورڈ",
  fleet: "میری گاڑیاں",
  rides: "میری سواریاں",
  wallet: "والٹ",
};

const els = {
  app: document.getElementById("partnerShell"),
  partnerShell: document.getElementById("partnerShell"),
  partnerContent: document.getElementById("partnerContent"),
  viewTitle: document.getElementById("partnerViewTitle"),
  topbarActions: document.getElementById("partnerTopbarActions"),
  navDashboard: document.getElementById("navDashboard"),
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
  mapElement: document.getElementById("driverMap"),
  statusToggle: document.getElementById("driverStatusToggle"),
  statusText: document.getElementById("driverStatusText"),
  locationState: document.getElementById("locationState"),
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
  activeRideActionBtn: document.getElementById("activeRideActionBtn"),
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
};

let map = null;
let locationMarker = null;
let accuracyCircle = null;
let watchId = null;
let online = false;
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
let cachedWalletThreshold = -500;
let walletLocked = false;
let partnerView = "dashboard";
let lastVehicleLocationWrite = 0;
const VEHICLE_LOCATION_WRITE_MS = 60_000; // Phase 3A: approved 1-minute Firebase snapshot (was 8s accidental waste)
const LOCATION_GRID_DEG = 0.009;
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
function matchGeoCellId(lat, lng) {
  return `g_${Math.floor(Number(lat) / MATCH_GEO_DEG)}_${Math.floor(Number(lng) / MATCH_GEO_DEG)}`;
}
function matchHotspotId(lat, lng) {
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
let rideListenerPrimed = false;
let unsubscribeDriverRideHistory = () => {};
let driverRidesCache = [];

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

function initMap() {
  // Owner app has no live map.
  return;
}

function setLocationMessage(message) {
  if (els.locationState) els.locationState.textContent = message;
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

async function activateAuthenticatedDriver(user) {
  const sequence = ++authSequence;
  setLoginBusy(true);
  setAuthStatus("مالک پروفائل لوڈ کیا جا رہا ہے...");
  currentDriver = user;
  hideProtectedUi();
  hideAccountBlockedOverlay();

  try {
    const { db } = getFirebase();
    startPartnerDocListener(user.uid, sequence);

    let partnerSnapshot = await getDoc(doc(db, "partners", user.uid));
    if (sequence !== authSequence) return;

    hideAuthOverlay();
    setLoginBusy(false);
    setAuthStatus("");

    if (partnerAccountBlocked || partnerSnapshot.data()?.accountStatus === "blocked") {
      partnerAccountBlocked = true;
      showAccountBlockedOverlay();
      return;
    }

    // Stay on Owner URL for any signed-in partner — never bounce to Driver app.
    // Same Gmail may use /partner/, /owner/, and customer independently.
    const existing = partnerSnapshot.exists() ? partnerSnapshot.data() : {};

    if (!partnerSnapshot.exists() || !existing.role) {
      await setDoc(
        doc(db, "partners", user.uid),
        {
          uid: user.uid,
          role: "owner",
          email: user.email || existing.email || "",
          name: user.displayName || existing.name || "Owner",
          walletBalance: Number.isFinite(Number(existing.walletBalance))
            ? Number(existing.walletBalance)
            : 0,
          currentVehicleId: null,
          updatedAt: serverTimestamp(),
          ...(partnerSnapshot.exists() ? {} : { createdAt: serverTimestamp() }),
        },
        { merge: true }
      );
    }

    if (sequence !== authSequence) return;
    showOwnerDashboard();
  } catch (error) {
    console.warn("[SwiftGo Owner] auth routing", error);
    if (sequence !== authSequence) return;
    hideAuthOverlay();
    setLoginBusy(false);
    setAuthStatus("پروفائل لوڈ نہیں ہو سکا، دوبارہ کوشش کریں۔");
    showAuthOverlay();
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
      if (sequence !== authSequence) return;
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
        // Re-enter normal routing after Super Admin unblocks.
        activateAuthenticatedDriver(currentDriver);
      }
    },
    (error) => {
      console.warn("[SwiftGo Partner] partners doc listener", error);
    }
  );
}

/* ── Phase 41.5: sidebar SPA routing ── */

function setActiveView(view = "dashboard") {
  const key =
    view === "fleet" || view === "rides" || view === "wallet" ? view : "dashboard";
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
  if (els.partnerContent) els.partnerContent.dataset.activeView = key;

  if (key === "dashboard") {
    requestAnimationFrame(() => map?.invalidateSize());
  }
}

function configureNavForMode() {
  if (els.navFleet) els.navFleet.hidden = false;
  if (els.navDashboard) els.navDashboard.hidden = true;
  if (els.navWallet) els.navWallet.hidden = true;
  if (els.topbarActions) els.topbarActions.hidden = true;
  document.querySelectorAll('.partner-nav-item[data-view="rides"]').forEach((btn) => {
    btn.hidden = true;
  });
}

function showPartnerShell() {
  hidePinGate();
  if (els.partnerShell) els.partnerShell.hidden = false;
}

function hidePartnerShell() {
  if (els.partnerShell) els.partnerShell.hidden = true;
}

function wirePartnerNavigation() {
  document.querySelectorAll(".partner-nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => setActiveView(btn.dataset.view));
  });
}

function hideProtectedUi() {
  setDriverOffline("");
  stopVehiclesListener();
  stopOwnerRidesListener();
  stopDriverRideHistory();
  stopActiveRideWatch();
  hideActiveRideSheet();
  hideRideCompleteSheet();
  hidePinGate();
  hidePartnerShell();
  partnerView = "fleet";
  els.app?.classList.add("is-owner-mode");
  els.app?.classList.remove("has-active-ride");
  els.app?.classList.remove("has-incoming-ride");
}

function showOwnerDashboard() {
  if (partnerAccountBlocked) {
    showAccountBlockedOverlay();
    return;
  }
  partnerMode = "owner";
  els.app?.classList.add("is-owner-mode");
  showPartnerShell();
  configureNavForMode();
  setActiveView("fleet");
  startVehiclesListener();
  startOwnerRidesListener();
}

function showDriverMap() {
  if (partnerAccountBlocked) {
    showAccountBlockedOverlay();
    return;
  }
  partnerMode = "driver";
  els.app?.classList.remove("is-owner-mode");
  showPartnerShell();
  configureNavForMode("driver");
  setActiveView("dashboard");
  loadWalletThreshold().catch(() => {});
  startDriverRideHistory(currentDriver?.uid);
  setLocationMessage(
    linkedVehicle
      ? `گاڑی منسلک ہے: ${linkedVehicle?.model || ""} (${linkedVehicle?.plate || "—"}) — آن لائن ہو کر سواری حاصل کریں`
      : "گاڑی منسلک نہیں — سپورٹ سے رابطہ کریں"
  );
  requestAnimationFrame(() => map?.invalidateSize());
}

function isApprovedAdminDriver(partner) {
  return isOwnerInDriverMode(partner) &&
    (partner?.status === "approved" || partner?.accountStatus === "active" || !partner?.status);
}

/** Return-to-Owner button — Super Admin in Driver Mode only. Regular drivers NEVER see this. */
function setReturnToOwnerVisibility(visible) {
  const btn = els.btnReturnToOwner || document.getElementById("btnReturnToOwner");
  if (!btn) return;
  // Hard lock: never show unless current user is the Owner.
  const allow = Boolean(visible) && isSuperAdminUser();
  if (allow) {
    btn.hidden = false;
    btn.style.display = "flex";
    btn.classList.add("is-visible");
  } else {
    btn.hidden = true;
    btn.style.display = "none";
    btn.classList.remove("is-visible");
  }
}

/** Bypass PIN / auth overlays and open driver dashboard for Owner Driver Mode only. */
async function hideAllAuthScreensAndShowDashboard(partner, sequence = authSequence) {
  if (!isOwnerInDriverMode(partner)) {
    setReturnToOwnerVisibility(false);
    return;
  }
  hideAuthOverlay();
  hideRoleSelection();
  hidePinGate();
  hideAccountBlockedOverlay();
  setReturnToOwnerVisibility(true);
  await routeDriver(partner?.currentVehicleId || null, sequence, {
    ...partner,
    role: "admin_driver",
    status: partner?.status || "approved",
    accountStatus: partner?.accountStatus || "active",
  });
}

/**
 * Owner only: restore previous driver, clear takeover fields, go to Admin.
 * Regular drivers are never redirected to /admin/.
 */
async function returnToOwnerMode() {
  const user = currentDriver;
  const btn = els.btnReturnToOwner;
  if (!user?.uid) return;

  if (!isSuperAdminUser(user)) {
    setReturnToOwnerVisibility(false);
    setLocationMessage("صرف مالک مرکزی کنٹرول میں واپس جا سکتا ہے");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "واپس جا رہے ہیں…";
  }

  try {
    const { db } = getFirebase();
    if (!db) throw new Error("Firestore unavailable");

    // 1. Read currentVehicleId from partners/{uid}
    const partnerSnap = await getDoc(doc(db, "partners", user.uid));
    const partner = partnerSnap.exists() ? partnerSnap.data() : null;

    if (!isOwnerInDriverMode(partner, user)) {
      setReturnToOwnerVisibility(false);
      throw new Error("NOT_ADMIN_DRIVER");
    }

    const vehicleId = partner.currentVehicleId || linkedVehicle?.id || null;

    // 2–4. Fetch vehicle, restore previous driver, deleteField previous*
    if (vehicleId) {
      const vehicleRef = doc(db, "vehicles", vehicleId);
      const vehicleSnap = await getDoc(vehicleRef);
      if (vehicleSnap.exists()) {
        const vehicle = vehicleSnap.data() || {};
        /** @type {Record<string, unknown>} */
        const updates = {
          previousDriverId: deleteField(),
          previousDriverName: deleteField(),
          status: "offline",
        };

        if (vehicle.previousDriverId) {
          updates.driverId = vehicle.previousDriverId;
          updates.driverName = vehicle.previousDriverName || "Driver";
        } else {
          updates.driverId = deleteField();
          updates.driverName = deleteField();
        }

        await updateDoc(vehicleRef, updates);
      }
    }

    await setDoc(
      doc(db, "partners", user.uid),
      {
        currentVehicleId: null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    setDriverOffline("");
    // 5. Redirect to Super Admin Panel — Owner only (already gated above).
    window.location.href = "/admin/";
  } catch (error) {
    console.warn("[SwiftGo Partner] returnToOwnerMode", error);
    setLocationMessage(
      error?.message === "NOT_ADMIN_DRIVER"
        ? "صرف مالک ڈرائیور موڈ سے واپس جا سکتا ہے"
        : "مالک موڈ میں واپسی ناکام — دوبارہ کوشش کریں"
    );
    if (btn) {
      btn.disabled = false;
      btn.textContent = "مالک موڈ میں واپس جائیں";
    }
  }
}

async function routeDriver(vehicleId, sequence = authSequence, partner = null) {
  partnerMode = "driver";
  linkedVehicle = null;

  const userRole = partner?.role || "unknown";
  const userStatus = partner?.status || partner?.accountStatus || "unknown";
  console.log("Current User Role:", userRole, "Status:", userStatus);

  if (isOwnerInDriverMode(partner) || isApprovedAdminDriver(partner)) {
    hidePinGate();
    setReturnToOwnerVisibility(true);
    let resolvedVehicleId = vehicleId || partner?.currentVehicleId || null;
    const { db } = getFirebase();

    if (resolvedVehicleId) {
      const vehicleSnapshot = await getDoc(doc(db, "vehicles", resolvedVehicleId));
      if (sequence !== authSequence) return;
      if (vehicleSnapshot.exists()) {
        linkedVehicle = { id: vehicleSnapshot.id, ...vehicleSnapshot.data() };
      }
    }

    if (!linkedVehicle && currentDriver?.uid) {
      const vehicleQuery = query(
        collection(db, "vehicles"),
        where("driverId", "==", currentDriver.uid),
        limit(1)
      );
      const ownedVehicleSnap = await getDocs(vehicleQuery);
      if (sequence !== authSequence) return;
      if (!ownedVehicleSnap.empty) {
        const vehicleDoc = ownedVehicleSnap.docs[0];
        linkedVehicle = { id: vehicleDoc.id, ...vehicleDoc.data() };
        resolvedVehicleId = vehicleDoc.id;
      }
    }

    if (resolvedVehicleId && partner?.currentVehicleId !== resolvedVehicleId) {
      await setDoc(
        doc(db, "partners", currentDriver.uid),
        { currentVehicleId: resolvedVehicleId, updatedAt: serverTimestamp() },
        { merge: true }
      );
    }

    showDriverMap();
    if (linkedVehicle) {
      setLocationMessage(
        `Admin Drive Mode · ${linkedVehicle.model || ""} (${linkedVehicle.plate || "—"}) — آن لائن ہو کر سواری حاصل کریں`
      );
    } else {
      setLocationMessage("Admin Drive Mode · گاڑی منسلک نہیں — Super Admin takeover دوبارہ چیک کریں");
    }
    return;
  }

  if (!vehicleId) {
    showPinGate();
    return;
  }

  const { db } = getFirebase();
  const vehicleSnapshot = await getDoc(doc(db, "vehicles", vehicleId));
  if (sequence !== authSequence) return;

  if (!vehicleSnapshot.exists()) {
    showPinGate("منسلک گاڑی دستیاب نہیں، نیا PIN درج کریں۔");
    return;
  }

  linkedVehicle = { id: vehicleSnapshot.id, ...vehicleSnapshot.data() };

  if (
    linkedVehicle.driverId &&
    currentDriver?.uid &&
    linkedVehicle.driverId !== currentDriver.uid
  ) {
    showPinGate("یہ گاڑی کسی اور ڈرائیور سے منسلک ہے۔");
    linkedVehicle = null;
    return;
  }

  showDriverMap();
}

async function selectPartnerRole(role) {
  const user = currentDriver;
  if (!user || !["owner", "driver"].includes(role)) return;

  setRoleMessage("");
  if (els.selectDriverRoleBtn) els.selectDriverRoleBtn.disabled = true;
  if (els.selectOwnerRoleBtn) els.selectOwnerRoleBtn.disabled = true;
  try {
    const { db } = getFirebase();
    await setDoc(
      doc(db, "partners", user.uid),
      {
        uid: user.uid,
        role,
        currentVehicleId: null,
        walletBalance: 0,
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );
    hideRoleSelection();
    if (role === "driver") {
      window.location.assign("/partner/");
      return;
    }
    showOwnerDashboard();
  } catch (error) {
    console.warn("[SwiftGo Owner] save role", error);
    setRoleMessage("کردار محفوظ نہیں ہو سکا، دوبارہ کوشش کریں۔");
  } finally {
    if (els.selectDriverRoleBtn) els.selectDriverRoleBtn.disabled = false;
    if (els.selectOwnerRoleBtn) els.selectOwnerRoleBtn.disabled = false;
  }
}

async function logoutPartner() {
  const { auth } = getFirebase();
  if (!auth) return;
  try {
    await signOut(auth);
  } catch (error) {
    console.warn("[SwiftGo Owner] logout", error);
    setAuthStatus("لاگ آؤٹ نہیں ہو سکا، دوبارہ کوشش کریں۔");
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
  hideProtectedUi();
  partnerMode = "driver";
  if (!els.pinGate) return;
  els.pinGate.hidden = false;
  setPinMessage(message);
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
      status: "online",
    };
    setPinMessage("گاڑی کامیابی سے منسلک ہو گئی!", true);
    els.pinForm?.reset();
    window.setTimeout(() => {
      showDriverMap();
    }, 900);
  } catch (error) {
    console.warn("[SwiftGo Partner] verify vehicle PIN", error?.code || error?.message || error);
    const code = String(error?.code || error?.message || "");
    if (code.includes("PIN_LOCKED") || code.includes("resource-exhausted")) {
      setPinMessage("زیادہ غلط کوششیں — کچھ دیر بعد دوبارہ کوشش کریں");
    } else if (code.includes("DRIVER_BLOCKED") || code.includes("DRIVER_SUSPENDED")) {
      setPinMessage("آپ کا اکاؤنٹ بلاک/معطل ہے");
    } else if (code.includes("VEHICLE_IN_USE")) {
      setPinMessage("یہ گاڑی پہلے ہی زیر استعمال ہے");
    } else if (code.includes("PIN_NOT_FOUND") || code.includes("not-found")) {
      setPinMessage("غلط پن کوڈ! دوبارہ کوشش کریں");
    } else if (code.includes("FUNCTIONS_UNAVAILABLE")) {
      setPinMessage("PIN سروس دستیاب نہیں — بعد میں کوشش کریں");
    } else {
      setPinMessage("تصدیق مکمل نہیں ہو سکی۔ دوبارہ کوشش کریں۔");
    }
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
  console.warn("[SwiftGo] driver ride history", error);
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
      console.warn("[SwiftGo Partner] owner ride history", error);
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
    pin.textContent = `PIN: ${vehicle.pin || "—"}`;
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-pin-btn";
    copyBtn.textContent = "کاپی";
    copyBtn.addEventListener("click", async () => {
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
      console.warn("[SwiftGo Partner] owner vehicles", error);
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

function setOnlineUi(value) {
  online = value;
  els.statusToggle?.classList.toggle("is-online", value);
  els.statusToggle?.setAttribute("aria-checked", String(value));
  els.statusToggle?.setAttribute(
    "aria-label",
    value ? "ڈرائیور آف لائن کریں" : "ڈرائیور آن لائن کریں"
  );
  if (els.statusText) els.statusText.textContent = value ? "آن لائن" : "آف لائن";
}

function driverIcon() {
  return L.divIcon({
    className: "",
    html: '<div class="driver-location-marker"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function updateDriverLocation(position) {
  if (!map || !online) return;

  const { latitude, longitude, accuracy } = position.coords;
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

  syncVehicleLocationToFirestore(latitude, longitude);
  setLocationMessage("آپ آن لائن ہیں — لائیو مقام فعال ہے");
}

async function syncVehicleLocationToFirestore(lat, lng) {
  if (!linkedVehicle?.id || !online || !currentDriver?.uid) return;

  const now = Date.now();
  const cell = `${Math.floor(Number(lat) / LOCATION_GRID_DEG)}_${Math.floor(Number(lng) / LOCATION_GRID_DEG)}`;
  const zoneChanged = cell !== lastLocationGridCell;
  if (!zoneChanged && now - lastVehicleLocationWrite < VEHICLE_LOCATION_WRITE_MS) return;
  lastLocationGridCell = cell;
  lastVehicleLocationWrite = now;

  try {
    const { db } = getFirebase();
    const geoCell = matchGeoCellId(lat, lng);
    const hotspotId = matchHotspotId(lat, lng);
    await updateDoc(doc(db, "vehicles", linkedVehicle.id), {
      location: { lat, lng },
      locationUpdatedAt: serverTimestamp(),
      locationGridCell: cell,
      geoCell,
      hotspotId: hotspotId || null,
      driverName:
        currentDriver.displayName ||
        currentDriver.email?.split("@")[0] ||
        "SwiftGo Driver",
      status: activeExecutionRide?.id ? "in_ride" : "online",
    });
  } catch (error) {
    console.warn("[SwiftGo Owner] vehicle location sync", error);
  }
}

async function markVehicleOfflineInFirestore() {
  if (!linkedVehicle?.id) return;
  try {
    const { db } = getFirebase();
    await updateDoc(doc(db, "vehicles", linkedVehicle.id), {
      status: "offline",
    });
  } catch (error) {
    console.warn("[SwiftGo Partner] vehicle offline sync", error);
  }
}

function handleLocationError(error) {
  const denied = error?.code === 1;
  setDriverOffline(
    denied
      ? "لائیو مقام کے لیے براؤزر میں لوکیشن کی اجازت دیں"
      : "موجودہ مقام حاصل نہیں ہو سکا، دوبارہ کوشش کریں"
  );
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    setLocationMessage("یہ براؤزر لائیو لوکیشن سپورٹ نہیں کرتا");
    setOnlineUi(false);
    return;
  }

  hasCenteredOnDriver = false;
  setLocationMessage("آپ کا موجودہ مقام تلاش کیا جا رہا ہے...");
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
}

function stopRideListener() {
  unsubscribeRides();
  unsubscribeRides = () => {};
}

function hideIncomingRide() {
  activeRequest = null;
  window.clearTimeout(hideSheetTimer);
  els.requestSheet?.classList.remove("is-visible");
  els.app?.classList.remove("has-incoming-ride");
  hideSheetTimer = window.setTimeout(() => {
    if (els.requestSheet) els.requestSheet.hidden = true;
  }, 360);
}

function showIncomingRide(request) {
  if (OWNER_FLEET_ONLY) return;
  activeRequest = request;
  window.clearTimeout(hideSheetTimer);

  if (els.pickup) {
    els.pickup.textContent = request.pickupLocation?.address || "پک اپ مقام دستیاب نہیں";
  }
  if (els.dropoff) {
    els.dropoff.textContent = request.dropoffLocation?.address || "ڈراپ آف مقام دستیاب نہیں";
  }
  if (els.distance) {
    els.distance.textContent = `${Number(request.distanceKm || 0).toFixed(1)} km`;
  }
  if (els.time) {
    els.time.textContent = `${Math.round(Number(request.timeMins || 0))} min`;
  }
  if (els.fare) {
    const fareValue = Number(request.estimatedFare ?? request.farePkr ?? 0);
    els.fare.textContent = `Rs. ${Math.round(fareValue)}`;
  }

  if (els.requestSheet) els.requestSheet.hidden = false;
  els.app?.classList.add("has-incoming-ride");
  requestAnimationFrame(() => els.requestSheet?.classList.add("is-visible"));
}

function startRideListener() {
  if (OWNER_FLEET_ONLY) return;
  stopRideListener();
  if (!online || !currentDriver) return;

  rideListenerPrimed = false;
  const { db } = getFirebase();
  const incomingQuery = query(
    collection(db, "rides"),
    where("status", "==", "searching_driver"),
    orderBy("createdAt", "desc"),
    limit(1)
  );

  unsubscribeRides = onSnapshot(
    incomingQuery,
    (snapshot) => {
      if (!online) return;

      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" && rideListenerPrimed) {
          AudioService.playAlert();
          AudioService.showNotification(
            "نئی سواری!",
            "آپ کے علاقے میں ایک نئی سواری موجود ہے۔"
          );
        }
      });
      rideListenerPrimed = true;

      const latest = snapshot.docs[0];
      if (!latest) {
        hideIncomingRide();
        return;
      }
      showIncomingRide({ id: latest.id, ...latest.data() });
    },
    (error) => {
      console.warn("[SwiftGo Driver] incoming rides", error);
      setDriverOffline("سواری کی درخواستیں حاصل نہیں ہو سکیں");
    }
  );
}

function setDriverOffline(message = "آپ آف لائن ہیں") {
  stopLocationWatch();
  stopRideListener();
  hideIncomingRide();
  setOnlineUi(false);
  markVehicleOfflineInFirestore();
  setLocationMessage(message);
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

  setOnlineUi(true);
  startLocationWatch();
  startRideListener();
}

function setRequestButtonsBusy(busy) {
  if (els.acceptBtn) els.acceptBtn.disabled = busy;
  if (els.declineBtn) els.declineBtn.disabled = busy;
}

/* ── Phase 32: active ride execution cycle ── */

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

  if (els.activeRideSheet) els.activeRideSheet.hidden = false;
  els.app?.classList.add("has-active-ride");
  requestAnimationFrame(() => els.activeRideSheet?.classList.add("is-visible"));
}

function startActiveRideWatch(rideId) {
  stopActiveRideWatch();
  if (!rideId) return;

  const { db } = getFirebase();
  unsubscribeActiveRide = onSnapshot(
    doc(db, "rides", rideId),
    (snapshot) => {
      if (!snapshot.exists()) {
        activeExecutionRide = null;
        hideActiveRideSheet();
        hideRideCompleteSheet();
        return;
      }
      activeExecutionRide = { id: snapshot.id, ...snapshot.data() };
      renderActiveRideControls(activeExecutionRide);
    },
    (error) => {
      console.warn("[SwiftGo Partner] active ride watch", error);
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

function resolveVehicleKeyFromLabel(label) {
  const raw = String(label || "").trim().toLowerCase();
  if (!raw) return "";
  const map = {
    bike: "bike",
    بائیک: "bike",
    go: "go",
    گو: "go",
    "go plus": "go-plus",
    "go-plus": "go-plus",
    "گو پلس": "go-plus",
    business: "business",
    بزنس: "business",
    "bike cargo": "bike-cargo",
    "bike-cargo": "bike-cargo",
    "بائیک کارگو": "bike-cargo",
    suzuki: "suzuki",
    سوزوکی: "suzuki",
    truck: "truck",
    ٹرک: "truck",
  };
  return map[raw] || "";
}

/** Phase 2A — settlement via trusted Cloud Function only. */
async function completeRideWithEarnings(ride) {
  const driver = currentDriver;
  if (!ride?.id || !driver?.uid) {
    throw new Error("NO_ACTIVE_RIDE");
  }

  const result = await requestRideSettlement({
    rideId: ride.id,
    collectionName: "rides",
  });

  return {
    commissionAmount: Number(result?.commissionAmount) || 0,
    driverEarnings: Number(result?.driverEarnings) || 0,
    estimatedFare: Number(result?.grossFare) || rideFareAmount(ride),
    alreadySettled: Boolean(result?.alreadySettled),
  };
}

async function advanceActiveRideStatus() {
  if (OWNER_FLEET_ONLY) return;
  const ride = activeExecutionRide;
  const nextStatus = els.activeRideActionBtn?.dataset.nextStatus;
  if (!ride?.id || !nextStatus) return;

  if (els.activeRideActionBtn) els.activeRideActionBtn.disabled = true;
  try {
    const { db } = getFirebase();

    if (nextStatus === "completed") {
      await completeRideWithEarnings(ride);
      setLocationMessage("سواری مکمل — کمائی اپڈیٹ ہو گئی");
      return;
    }

    await updateDoc(doc(db, "rides", ride.id), { status: nextStatus });
    setLocationMessage(
      nextStatus === "arrived"
        ? "پک اپ پر پہنچنے کی اطلاع بھیج دی گئی"
        : "سواری شروع کر دی گئی"
    );
  } catch (error) {
    console.warn("[SwiftGo Partner] advance ride status", error);
    setLocationMessage("اسٹیٹس اپڈیٹ نہیں ہو سکی۔ دوبارہ کوشش کریں۔");
    if (els.activeRideActionBtn) els.activeRideActionBtn.disabled = false;
  }
}

async function findNewRideAfterCompletion() {
  if (els.findNewRideBtn) els.findNewRideBtn.disabled = true;
  try {
    stopActiveRideWatch();
    activeExecutionRide = null;
    hideRideCompleteSheet();
    hideActiveRideSheet();
    await markVehicleRideId(null);
    setLocationMessage("نئی سواری تلاش کے لیے تیار — آپ آن لائن ہیں");
    if (online && currentDriver && linkedVehicle) {
      startRideListener();
    }
  } finally {
    if (els.findNewRideBtn) els.findNewRideBtn.disabled = false;
  }
}

async function resolveActiveRequest(nextStatus) {
  if (OWNER_FLEET_ONLY) return;
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
      activeExecutionRide = { id: request.id, ...request, status: "accepted" };
      await markVehicleRideId(request.id);
      startActiveRideWatch(request.id);
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

function boot() {
  try {
    sessionStorage.setItem("swiftgo_app_surface", "owner");
  } catch {
    /* ignore */
  }
  applyReducedMotionClass();
  initKeyboardInset();
  initI18n();
  wireLegalLinks();
  document.getElementById("ownerDeleteAccountBtn")?.addEventListener("click", async () => {
    const status = document.getElementById("ownerTrustStatus");
    const confirmed = window.confirm(
      "Request account deletion? Login will be disabled. Financial ledger, settlement, and audit records are retained."
    );
    if (!confirmed) return;
    try {
      await requestAccountDeletionClient({ roleHint: "owner", appId: "owner" });
      if (status) {
        status.textContent =
          "Deletion requested. Ledger/settlement/audit retained. Signing out…";
      }
      await logoutPartner();
    } catch (err) {
      console.warn("[SwiftGo Owner] deletion", err);
      if (status) status.textContent = "Deletion request failed. Contact support.";
    }
  });
  const devNote = document.getElementById("partnerDevModeNote");
  if (devNote) devNote.hidden = !shouldUseEmulators();
  initMap();
  hideProtectedUi();
  showAuthOverlay();
  els.googleLoginBtn?.addEventListener("click", signInDriverWithGoogle);
  els.blockedLogoutBtn?.addEventListener("click", logoutPartner);
  els.addVehicleBtn?.addEventListener("click", openVehicleModal);
  els.vehicleModalBackdrop?.addEventListener("click", closeVehicleModal);
  els.vehicleModalClose?.addEventListener("click", closeVehicleModal);
  els.vehicleForm?.addEventListener("submit", submitVehicle);
  wirePartnerNavigation();
  els.sidebarLogoutBtn?.addEventListener("click", logoutPartner);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.vehicleModal?.hidden) closeVehicleModal();
  });

  const firebase = getFirebase();
  if (firebase.auth) {
    getRedirectResult(firebase.auth).catch((error) => {
      console.warn("[SwiftGo Owner] Google redirect", error);
      setAuthStatus("Google لاگ اِن مکمل نہیں ہو سکا");
    });
    onAuthStateChanged(firebase.auth, async (user) => {
      authSequence += 1;
      if (!user) {
        currentDriver = null;
        linkedVehicle = null;
        partnerMode = null;
        partnerAccountBlocked = false;
        stopPartnerDocListener();
        hideAccountBlockedOverlay();
        hideProtectedUi();
        ownerVehicles = [];
        ownerRides = [];
        renderOwnerVehicles();
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
    `[SwiftGo Owner] ready · project=${firebaseConfig.projectId} · firebase=${
      isFirebaseConfigured() && firebase.ready
    }`
  );
}

boot();
