import {
  initFleetMapModule,
  showLiveFleetMap,
  stopFleetMap,
} from "./fleet-map.js";
import {
  AudioService,
  initAudioService,
  initNotificationSettingsUI,
} from "./audio-service.js";

import { firebaseConfig } from "./firebase-config.js";
import { getFirebase, isFirebaseConfigured } from "./firebase.js?v=dispatch_dynamic_1";
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  deleteDoc,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  serverTimestamp,
  writeBatch,
  getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { applyReducedMotionClass, initKeyboardInset, trapFocus } from "./a11y.js";
import {
  bootstrapAdminClaim as bootstrapAdminClaimClient,
  ensureFreshAuthUser,
  initSuperAdminAccess,
  saveAdminDispatchSettings,
  saveAdminPricingSettings as saveAdminPricingSettingsClient,
} from "./admin-settings-client.js?v=dispatch_dynamic_1";

/** Sole authorized Super Admin (Owner). No driver may enter Command Center. */
const SUPER_ADMIN_EMAIL = "fuzail1158@gmail.com";

/**
 * Hard lock: only this Owner email may access /admin/.
 * Drivers / fleet owners / customers are always denied.
 */
function isAuthorizedAdmin(user) {
  if (!user) return false;
  // Phase 2B: custom claim is primary. Email bootstrap remains until disabled in settings/security.
  if (user.admin === true) return true;
  try {
    const token = user.stsTokenManager && user;
    // Prefer getIdTokenResult when available (async path handled by callers).
  } catch {
    /* ignore */
  }
  if (user?.reloadUserInfo?.customAttributes) {
    try {
      const attrs = JSON.parse(user.reloadUserInfo.customAttributes);
      if (attrs?.admin === true) return true;
    } catch {
      /* ignore */
    }
  }
  const email = (user.email || "").trim().toLowerCase();
  if (!email || email !== SUPER_ADMIN_EMAIL) return false;
  if (user.emailVerified === false) return false;
  return true;
}

/** Async claim check (token refresh aware). */
async function isAuthorizedAdminAsync(user) {
  if (!user) return false;
  try {
    const token = await user.getIdTokenResult(true);
    if (token?.claims?.admin === true) return true;
  } catch {
    /* fall through to bootstrap email */
  }
  return isAuthorizedAdmin(user);
}

const DEFAULT_VEHICLE_RATES = Object.freeze({
  bike: Object.freeze({ baseFare: 40, perKmRate: 15, commissionPercent: 10 }),
  go: Object.freeze({ baseFare: 100, perKmRate: 35, commissionPercent: 10 }),
  "go-plus": Object.freeze({ baseFare: 130, perKmRate: 40, commissionPercent: 10 }),
  business: Object.freeze({ baseFare: 200, perKmRate: 60, commissionPercent: 10 }),
  "bike-cargo": Object.freeze({ baseFare: 60, perKmRate: 20, commissionPercent: 10 }),
  suzuki: Object.freeze({ baseFare: 250, perKmRate: 50, commissionPercent: 10 }),
  truck: Object.freeze({ baseFare: 500, perKmRate: 80, commissionPercent: 10 }),
});

const DEFAULT_PRICING = Object.freeze({
  baseFare: DEFAULT_VEHICLE_RATES.go.baseFare,
  perKmRate: DEFAULT_VEHICLE_RATES.go.perKmRate,
  commissionPercent: DEFAULT_VEHICLE_RATES.go.commissionPercent,
  walletThreshold: -500,
  vehicles: DEFAULT_VEHICLE_RATES,
});

const VEHICLE_RATE_KEYS = Object.freeze(Object.keys(DEFAULT_VEHICLE_RATES));

const VIEW_TITLES = {
  dashboard: "ڈیش بورڈ",
  "all-rides": "تمام سواریاں",
  approvals: "ڈرائیورز کی منظوری",
  users: "صارفین اور گاڑیاں",
  finance: "مالی کنٹرول",
  "recharge-requests": "ریچارج درخواستیں",
  "live-map": "لائیو نقشہ",
};

const RIDE_STATUS_URDU = {
  completed: "مکمل",
  cancelled_by_user: "منسوخ (کسٹمر)",
  cancelled: "منسوخ",
  searching_driver: "ڈرائیور تلاش",
  accepted: "قبول شدہ",
  arrived: "پہنچ گئے",
  in_progress: "سواری جاری ہے",
  declined: "مسترد",
};

const els = {
  loginScreen: document.getElementById("adminLoginScreen"),
  dashboard: document.getElementById("adminDashboard"),
  loginBtn: document.getElementById("adminGoogleLoginBtn"),
  status: document.getElementById("adminAuthStatus"),
  accessDenied: document.getElementById("accessDeniedOverlay"),
  accessDeniedDismiss: document.getElementById("accessDeniedDismissBtn"),
  logoutBtn: document.getElementById("adminLogoutBtn"),
  displayName: document.getElementById("adminDisplayName"),
  displayEmail: document.getElementById("adminDisplayEmail"),
  viewTitle: document.getElementById("adminViewTitle"),
  content: document.getElementById("adminContent"),
  statTotalRides: document.getElementById("statTotalRides"),
  statActiveDrivers: document.getElementById("statActiveDrivers"),
  statTotalRevenue: document.getElementById("statTotalRevenue"),
  statsLiveNote: document.getElementById("statsLiveNote"),
  driversTableBody: document.getElementById("driversTableBody"),
  driversTableCount: document.getElementById("driversTableCount"),
  driversLiveNote: document.getElementById("driversLiveNote"),
  pricingForm: document.getElementById("pricingSettingsForm"),
  vehicleRateGrid: document.getElementById("vehicleRateGrid"),
  pricingWalletThreshold: document.getElementById("pricingWalletThreshold"),
  pricingSaveBtn: document.getElementById("pricingSaveBtn"),
  pricingSuccessMessage: document.getElementById("pricingSuccessMessage"),
  pricingStatusNote: document.getElementById("pricingStatusNote"),
  dispatchForm: document.getElementById("dispatchSettingsForm"),
  candidateDriverLimitInput: document.getElementById("candidateDriverLimit"),
  dispatchRadiusKmInput: document.getElementById("dispatchRadiusKm"),
  dispatchRadiusMetersInput: document.getElementById("dispatchRadiusMeters"),
  dispatchRadiusPreview: document.getElementById("dispatchRadiusPreview"),
  dispatchSaveBtn: document.getElementById("dispatchSaveBtn"),
  dispatchStatusNote: document.getElementById("dispatchStatusNote"),
  promoCodeForm: document.getElementById("promoCodeForm"),
  promoCodeInput: document.getElementById("promoCodeInput"),
  promoTypeInput: document.getElementById("promoTypeInput"),
  promoValueInput: document.getElementById("promoValueInput"),
  promoMaxUsesInput: document.getElementById("promoMaxUsesInput"),
  promoSaveBtn: document.getElementById("promoSaveBtn"),
  promoCodesTableBody: document.getElementById("promoCodesTableBody"),
  promoCodesLiveNote: document.getElementById("promoCodesLiveNote"),
  allRidesSection: document.getElementById("allRidesSection"),
  allRidesTableBody: document.getElementById("allRidesTableBody"),
  allRidesTableCount: document.getElementById("allRidesTableCount"),
  allRidesLiveNote: document.getElementById("allRidesLiveNote"),
  rechargeRequestsSection: document.getElementById("rechargeRequestsSection"),
  rechargeRequestsTableBody: document.getElementById("rechargeRequestsTableBody"),
  rechargeRequestsCount: document.getElementById("rechargeRequestsCount"),
  rechargeRequestsLiveNote: document.getElementById("rechargeRequestsLiveNote"),
  adminToast: document.getElementById("adminToast"),
  vehiclesTableBody: document.getElementById("vehiclesTableBody"),
  vehiclesTableCount: document.getElementById("vehiclesTableCount"),
  vehiclesLiveNote: document.getElementById("vehiclesLiveNote"),
  btnGlobalTakeControl: document.getElementById("btnGlobalTakeControl"),
  btnDashboardTakeControl: document.getElementById("btnDashboardTakeControl"),
  vehicleSelectionModal: document.getElementById("vehicleSelectionModal"),
  vehicleSelectionBackdrop: document.getElementById("vehicleSelectionBackdrop"),
  vehicleSelectionCloseBtn: document.getElementById("vehicleSelectionCloseBtn"),
  takeControlVehicleList: document.getElementById("takeControlVehicleList"),
  takeControlModalNote: document.getElementById("takeControlModalNote"),
};

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

let denyingUnauthorized = false;
/** @type {Array<() => void>} */
let liveUnsubscribers = [];
/** @type {Map<string, { name?: string, email?: string }>} */
let driverProfilesById = new Map();
/** @type {Array<Record<string, unknown>>} */
let partnerDriversCache = [];
/** @type {Array<Record<string, unknown>>} */
let allRidesCache = [];
/** @type {Array<Record<string, unknown>>} */
let pendingRechargeCache = [];
let pricingLoaded = false;
let pricingSuccessTimer = 0;
let cachedWalletThreshold = DEFAULT_PRICING.walletThreshold;
/** @type {boolean | null} null = checking */
let adminCanWriteSettings = null;
let rechargeListenerPrimed = false;
let allRidesListenerPrimed = false;
/** @type {Array<Record<string, unknown>>} */
let promoCodesCache = [];
let promoCodesListenerPrimed = false;
/** @type {import('firebase/auth').User | null} */
let currentAdminUser = null;
/** @type {Array<Record<string, unknown>>} */
let vehiclesFleetCache = [];

function setStatus(message = "") {
  if (els.status) els.status.textContent = message;
}

function setBusy(busy) {
  if (!els.loginBtn) return;
  els.loginBtn.disabled = busy;
  const label = els.loginBtn.querySelector("span");
  if (label) label.textContent = busy ? "Signing in..." : "Login via Google";
}

function showAccessDenied() {
  if (els.accessDenied) els.accessDenied.hidden = false;
}

function hideAccessDenied() {
  if (els.accessDenied) els.accessDenied.hidden = true;
}

/** @type {null | (() => void)} */
let releaseLoginTrap = null;

function showLogin() {
  stopLiveData();
  pricingLoaded = false;
  hidePricingSuccess();
  currentAdminUser = null;
  if (els.loginScreen) els.loginScreen.hidden = false;
  if (els.dashboard) els.dashboard.hidden = true;
  releaseLoginTrap?.();
  if (els.loginScreen && !els.loginScreen.hidden) {
    releaseLoginTrap = trapFocus(els.loginScreen, {
      dismissible: false,
      initialFocus: els.loginBtn || document.getElementById("adminGoogleLoginBtn"),
    });
  }
}

function showDashboard(user) {
  // Never unhide Command Center for anyone except the Owner.
  if (!isAuthorizedAdmin(user)) {
    showLogin();
    showAccessDenied();
    return;
  }

  releaseLoginTrap?.();
  releaseLoginTrap = null;

  if (els.loginScreen) els.loginScreen.hidden = true;
  if (els.dashboard) els.dashboard.hidden = false;
  hideAccessDenied();

  if (els.displayName) {
    els.displayName.textContent = user.displayName || "Super Admin";
  }
  if (els.displayEmail) {
    els.displayEmail.textContent = user.email || SUPER_ADMIN_EMAIL;
  }
  void ensureAdminWriteAccess(user);
}

async function ensureAdminWriteAccess(user) {
  adminCanWriteSettings = null;
  updateFinanceWriteUi();
  if (!user) {
    adminCanWriteSettings = false;
    updateFinanceWriteUi();
    return false;
  }

  try {
    const token = await user.getIdTokenResult(true);
    if (token?.claims?.admin === true) {
      adminCanWriteSettings = true;
      updateFinanceWriteUi();
      return true;
    }
  } catch {
    /* try bootstrap below */
  }

  if (isAuthorizedAdmin(user)) {
    try {
      const { db } = getFirebase();
      if (db) {
        const snap = await getDoc(doc(db, "settings", "security"));
        if (snap.exists() && snap.data()?.adminBootstrapEnabled === true) {
          adminCanWriteSettings = true;
          updateFinanceWriteUi();
          return true;
        }
      }
    } catch {
      /* continue */
    }
  }

  try {
    await initSuperAdminAccess();
    await user.getIdToken(true);
    adminCanWriteSettings = true;
    showAdminToast("Super Admin access فعال — ترتیبات محفوظ ہوں گی");
    updateFinanceWriteUi();
    return true;
  } catch (error) {
    console.warn("[SwiftGo Admin] initSuperAdminAccess", error);
  }

  try {
    await bootstrapAdminClaimClient();
    await user.getIdToken(true);
    adminCanWriteSettings = true;
    showAdminToast("Admin claim فعال — ترتیبات اب محفوظ ہوں گی");
    updateFinanceWriteUi();
    return true;
  } catch (error) {
    console.warn("[SwiftGo Admin] bootstrapAdminClaim", error);
  }

  adminCanWriteSettings = false;
  updateFinanceWriteUi();
  if (els.pricingStatusNote) {
    els.pricingStatusNote.textContent =
      "محفوظ نہیں ہو سکتا — Firebase Console میں settings/security → adminBootstrapEnabled: true کریں، پھر دوبارہ لاگ اِن کریں۔";
  }
  return false;
}

/**
 * Resolve live auth.currentUser (not a stale snapshot), force-refresh ID token,
 * bootstrap super_admin role/claim, then allow finance writes.
 */
async function prepareAdminSaveForWrite(_userHint) {
  const { functions, auth } = getFirebase();
  if (!functions) {
    const err = new Error("FUNCTIONS_UNAVAILABLE");
    err.code = "functions/unavailable";
    throw err;
  }

  let user;
  try {
    user = await ensureFreshAuthUser();
  } catch (error) {
    console.error("[Financial Settings Error]:", error?.code, error?.message);
    throw error;
  }
  currentAdminUser = user;

  if (!isAuthorizedAdmin(user) && !(await isAuthorizedAdminAsync(user))) {
    adminCanWriteSettings = false;
    updateFinanceWriteUi();
    const err = new Error("NOT_SUPER_ADMIN");
    err.code = "permission-denied";
    throw err;
  }

  // Self-heal: claim + users/{uid}.role = super_admin (Admin SDK via CF).
  try {
    await initSuperAdminAccess();
    await user.getIdToken(true);
    adminCanWriteSettings = true;
    updateFinanceWriteUi();
    return true;
  } catch (error) {
    console.warn("[SwiftGo Admin] prepareAdminSaveForWrite init", error?.code, error?.message);
    // Claim may already exist; saveAdminPricingSettings can still grant access.
    if (
      String(error?.code || "").includes("unauthenticated") ||
      String(error?.message || "").includes("AUTH_REQUIRED")
    ) {
      // One more hard refresh, then continue — final save will re-check auth.
      try {
        await auth?.currentUser?.getIdToken?.(true);
      } catch {
        /* ignore */
      }
    }
  }

  if (adminCanWriteSettings !== true) {
    await ensureAdminWriteAccess(user);
  }
  return adminCanWriteSettings === true || isAuthorizedAdmin(user);
}

function adminSaveErrorMessage(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || "");
  const lower = msg.toLowerCase();

  if (
    code === "functions/unavailable" ||
    code === "unavailable" ||
    msg === "FUNCTIONS_UNAVAILABLE"
  ) {
    return "Network Error — Cloud Functions دستیاب نہیں؛ صفحہ refresh کریں";
  }
  if (code === "functions/not-found" || code === "not-found") {
    return "Network Error — save function deploy نہیں ہوئی";
  }

  // Logged in but lacking Super Admin rights (do not say "sign in").
  if (
    code === "permission-denied" ||
    code === "functions/permission-denied" ||
    msg === "NOT_SUPER_ADMIN" ||
    msg.includes("ADMIN_ONLY") ||
    msg.includes("NOT_BOOTSTRAP_ADMIN") ||
    lower.includes("missing or insufficient permissions")
  ) {
    return "آپ کے اکاؤنٹ کے پاس سوپر ایڈمن کے حقوق نہیں ہیں";
  }

  // Truly not signed in / auth token missing on callable.
  if (
    code === "functions/unauthenticated" ||
    code === "unauthenticated" ||
    code === "auth/user-token-expired" ||
    msg === "AUTH_REQUIRED" ||
    msg === "NOT_SIGNED_IN" ||
    msg === "AUTH_UNAVAILABLE" ||
    lower.includes("please sign in") ||
    lower.includes("سائن ان")
  ) {
    return "براہ کرم دوبارہ لاگ اِن کریں — سیشن / ٹوکن کی تجدید درکار ہے";
  }

  if (
    code === "invalid-argument" ||
    code === "functions/invalid-argument" ||
    msg.includes("INVALID_") ||
    msg.includes("NaN")
  ) {
    return `Invalid Number Format — ${msg || "اعداد درست درج کریں"}`;
  }
  return `محفوظ نہیں: ${msg || code || "unknown error"}`;
}

/** Client Firestore write — after token refresh; rules use claim / role / bootstrap. */
async function savePricingViaFirestore(values) {
  const { db } = getFirebase();
  if (!db) {
    const err = new Error("FIRESTORE_UNAVAILABLE");
    err.code = "unavailable";
    throw err;
  }
  const user = await ensureFreshAuthUser();
  currentAdminUser = user;
  await setDoc(
    doc(db, "settings", "pricing"),
    {
      walletThreshold: Number(values.walletThreshold),
      baseFare: Number(values.baseFare),
      perKmRate: Number(values.perKmRate),
      commissionPercent: Number(values.commissionPercent),
      vehicles: values.vehicles,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    },
    { merge: true }
  );
}

async function persistPricingSettings(values) {
  try {
    await saveAdminPricingSettingsClient(values);
    return "callable";
  } catch (callableError) {
    console.error(
      "[Financial Settings Error]:",
      callableError?.code,
      callableError?.message
    );
    try {
      if (isAuthorizedAdmin(currentAdminUser) || getFirebase().auth?.currentUser) {
        try {
          await initSuperAdminAccess();
          await ensureFreshAuthUser();
        } catch (initErr) {
          console.warn("[SwiftGo Admin] init before Firestore fallback", initErr);
        }
      }
      await savePricingViaFirestore(values);
      console.info("[SwiftGo Admin] pricing saved via Firestore fallback");
      return "firestore";
    } catch (firestoreError) {
      console.error(
        "[Financial Settings Error]:",
        firestoreError?.code,
        firestoreError?.message
      );
      // Prefer the more specific permission/auth signal from either path.
      if (
        String(firestoreError?.code || "").includes("permission-denied") ||
        String(callableError?.code || "").includes("permission-denied")
      ) {
        const err = new Error("NOT_SUPER_ADMIN");
        err.code = "permission-denied";
        throw err;
      }
      throw callableError;
    }
  }
}

function updateFinanceWriteUi() {
  // Save buttons stay clickable — errors show on submit. Avoid disabled+wait cursor (Windows spinning circle on hover).
  const blocked = adminCanWriteSettings === false;
  for (const btn of [els.pricingSaveBtn, els.dispatchSaveBtn]) {
    if (!btn || btn.classList.contains("is-saving")) continue;
    btn.disabled = false;
    btn.classList.toggle("finance-save-btn--blocked", blocked);
    btn.title = blocked
      ? "Admin write access درکار — محفوظ کرنے پر ہدایت دکھائی جائے گی"
      : "";
  }
}

function setFinanceSaveBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = Boolean(busy);
  btn.classList.toggle("is-saving", Boolean(busy));
}

async function denyAndSignOut(auth) {
  denyingUnauthorized = true;
  stopLiveData();
  currentAdminUser = null;
  showLogin();
  showAccessDenied();
  setStatus("Access Denied: صرف مالک (Owner) مرکزی کنٹرول میں داخل ہو سکتا ہے۔ ڈرائیورز کو اجازت نہیں۔");
  try {
    await signOut(auth);
  } catch (error) {
    console.warn("[SwiftGo Admin] Forced sign-out failed", error);
  } finally {
    denyingUnauthorized = false;
    setBusy(false);
    // Kick non-owners off /admin/ so they cannot linger on the login shell.
    window.setTimeout(() => {
      if (!isAuthorizedAdmin(auth.currentUser)) {
        window.location.replace("/partner/");
      }
    }, 1800);
  }
}

async function signInWithGoogle() {
  const { auth } = getFirebase();
  if (!auth) {
    setStatus("Firebase is not configured.");
    return;
  }

  setBusy(true);
  setStatus("");
  hideAccessDenied();
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    if (error?.code === "auth/popup-blocked") {
      await signInWithRedirect(auth, googleProvider);
      return;
    }
    console.warn("[SwiftGo Admin] Google login", error);
    setBusy(false);
    setStatus("Google sign-in failed. Please try again.");
  }
}

async function handleLogout() {
  const { auth } = getFirebase();
  if (!auth) return;
  setBusy(true);
  stopLiveData();
  try {
    await signOut(auth);
  } catch (error) {
    console.warn("[SwiftGo Admin] Logout failed", error);
    setBusy(false);
  }
}

/** Phase 28.1 — SPA section routing via strict [hidden]. */
function setActiveView(viewKey) {
  const key = VIEW_TITLES[viewKey] ? viewKey : "dashboard";

  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    const active = btn.dataset.view === key;
    btn.classList.toggle("is-active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });

  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const match = panel.dataset.viewPanel === key;
    panel.hidden = !match;
    panel.classList.toggle("is-active", match);
  });

  if (els.viewTitle) els.viewTitle.textContent = VIEW_TITLES[key];
  if (els.content) els.content.dataset.activeView = key;

  if (key === "finance") {
    loadPricingSettings();
    loadDispatchSettings();
    fetchAndRenderPromoCodes();
  }

  if (key === "all-rides") {
    fetchAndRenderAllRides();
  }

  if (key === "recharge-requests") {
    fetchAndRenderRechargeRequests();
  }

  if (key === "live-map") {
    // Defer so the panel is laid out (not 0×0) before Leaflet measures it.
    window.requestAnimationFrame(() => {
      showLiveFleetMap();
      window.setTimeout(() => showLiveFleetMap(), 200);
    });
  } else {
    // Approved model: live fleet listener only while map view is open.
    stopFleetMap();
  }

  if (key === "users") {
    renderVehiclesTable(vehiclesFleetCache);
  }
}

function setAdminNavOpen(open) {
  const layout = document.getElementById("adminDashboard");
  const backdrop = document.getElementById("adminNavBackdrop");
  const menuBtn = document.getElementById("adminMenuBtn");
  const on = Boolean(open);
  layout?.classList.toggle("nav-open", on);
  if (backdrop) backdrop.hidden = !on;
  menuBtn?.setAttribute("aria-expanded", on ? "true" : "false");
  document.body.style.overflow = on ? "hidden" : "";
}

function closeAdminNav() {
  setAdminNavOpen(false);
}

function wireNavigation() {
  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "take-control") {
        openVehicleSelectionModal();
        closeAdminNav();
        return;
      }
      setActiveView(btn.dataset.view);
      closeAdminNav();
    });
  });

  document.getElementById("adminMenuBtn")?.addEventListener("click", () => {
    const layout = document.getElementById("adminDashboard");
    setAdminNavOpen(!layout?.classList.contains("nav-open"));
  });
  document.getElementById("adminSidebarClose")?.addEventListener("click", closeAdminNav);
  document.getElementById("adminNavBackdrop")?.addEventListener("click", closeAdminNav);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAdminNav();
  });
}

function wireRechargeTableActions() {
  els.rechargeRequestsTableBody?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-recharge-approve]");
    if (!btn) return;
    const requestId = btn.getAttribute("data-recharge-approve");
    const amount = Number(btn.getAttribute("data-recharge-amount"));
    const driverId = btn.getAttribute("data-recharge-driver");
    if (!requestId || !driverId) return;
    approveRechargeRequest(requestId, { driverId, amount }, btn);
  });
}

/* ── Phase 40: Owner Drive Mode · vehicle takeover ── */

function vehicleStatusLabel(status) {
  const labels = {
    online: "Online",
    offline: "Offline",
    in_ride: "In ride",
  };
  return labels[status] || status || "—";
}

function isVehicleTakenOver(vehicle) {
  return Boolean(vehicle?.previousDriverId);
}

function resolveDriverNameForVehicle(driverId) {
  const partner = partnerDriversCache.find((item) => item.id === driverId);
  if (partner?.name || partner?.displayName) {
    return partner.name || partner.displayName;
  }
  const profile = driverProfilesById.get(driverId);
  if (profile?.name) return profile.name;
  return String(driverId).slice(0, 8) + "…";
}

function renderVehiclesTable(vehicles = vehiclesFleetCache) {
  if (!els.vehiclesTableBody) return;

  if (!vehicles.length) {
    els.vehiclesTableBody.innerHTML = `
      <tr class="vehicles-table__empty">
        <td colspan="5">ابھی کوئی گاڑی نہیں ملی۔</td>
      </tr>`;
  } else {
    els.vehiclesTableBody.innerHTML = vehicles
      .map((vehicle) => {
        const vehicleId = escapeHtml(vehicle.id || "");
        const model = escapeHtml(vehicle.model || "—");
        const plate = escapeHtml(vehicle.plate || "—");
        const driverName = escapeHtml(
          vehicle.driverName ||
            (vehicle.driverId ? resolveDriverNameForVehicle(vehicle.driverId) : "—")
        );
        const status = escapeHtml(vehicleStatusLabel(vehicle.status));
        const takenOver = isVehicleTakenOver(vehicle);
        const actionCell = takenOver
          ? `<button
              type="button"
              class="account-action-btn btn-unblock"
              data-restore-vehicle="${vehicleId}"
              data-previous-driver-id="${escapeHtml(vehicle.previousDriverId || "")}"
              data-previous-driver-name="${escapeHtml(vehicle.previousDriverName || "")}"
            >ڈرائیور بحال کریں</button>`
          : `<span class="muted">—</span>`;
        return `
          <tr data-vehicle-id="${vehicleId}">
            <td><strong>${model}</strong></td>
            <td><code class="vehicle-id">${plate}</code></td>
            <td>${driverName}${takenOver ? ' <span class="pill pill--role">Takeover</span>' : ""}</td>
            <td><span class="pill pill--role">${status}</span></td>
            <td>${actionCell}</td>
          </tr>`;
      })
      .join("");
  }

  if (els.vehiclesTableCount) {
    els.vehiclesTableCount.textContent = `${vehicles.length} vehicle${vehicles.length === 1 ? "" : "s"}`;
  }
}

async function ensureAdminPartnerProfile(adminUser) {
  // Driver/owner mode switching removed — admin stays in /admin/ only.
  void adminUser;
}

async function takeControlOfVehicle() {
  showAdminToast("ڈرائیور موڈ بند کر دیا گیا ہے۔ الگ ڈرائیور ایپ استعمال کریں۔");
}

async function restoreOriginalDriver(vehicleId, previousDriverId, previousDriverName) {
  const adminUser = currentAdminUser;
  const { db } = getFirebase();
  if (!db || !vehicleId) return;

  const btn = els.vehiclesTableBody?.querySelector(
    `[data-restore-vehicle="${CSS.escape(vehicleId)}"]`
  );
  if (btn) {
    btn.disabled = true;
    btn.textContent = "بحال…";
  }

  try {
    /** @type {Record<string, unknown>} */
    const updates = {
      previousDriverId: deleteField(),
      previousDriverName: deleteField(),
      status: "offline",
    };

    if (previousDriverId) {
      updates.driverId = previousDriverId;
      updates.driverName = previousDriverName || "Driver";
    } else {
      updates.driverId = deleteField();
      updates.driverName = deleteField();
    }

    await updateDoc(doc(db, "vehicles", vehicleId), updates);

    if (adminUser?.uid) {
      await setDoc(
        doc(db, "partners", adminUser.uid),
        {
          currentVehicleId: null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    showAdminToast("اصل ڈرائیور بحال کر دیا گیا ہے");
    if (els.vehiclesLiveNote) {
      els.vehiclesLiveNote.textContent = `Driver restored · vehicle ${vehicleId}`;
    }
  } catch (error) {
    console.warn("[SwiftGo Admin] restoreOriginalDriver", error);
    showAdminToast(
      error?.code === "permission-denied"
        ? "Permission denied — check Firestore rules for restore."
        : "ڈرائیور بحال نہیں ہو سکا۔"
    );
    if (els.vehiclesLiveNote) {
      els.vehiclesLiveNote.textContent = error?.message || "Restore failed.";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "ڈرائیور بحال کریں";
    }
  }
}

function wireVehiclesTableActions() {
  els.vehiclesTableBody?.addEventListener("click", (event) => {
    const restoreBtn = event.target.closest("[data-restore-vehicle]");
    if (restoreBtn) {
      restoreOriginalDriver(
        restoreBtn.getAttribute("data-restore-vehicle"),
        restoreBtn.getAttribute("data-previous-driver-id") || "",
        restoreBtn.getAttribute("data-previous-driver-name") || ""
      );
    }
  });
}

function wireGlobalTakeControl() {
  // Driver ↔ owner mode switching removed.
}

/** Phase 3A — one aggregation read instead of listening to every ride doc. */
async function refreshTotalRidesStat() {
  const { db } = getFirebase();
  if (!db || !els.statTotalRides) return;
  try {
    const agg = await getCountFromServer(collection(db, "rides"));
    setStat(els.statTotalRides, agg.data().count);
    if (els.statsLiveNote) {
      els.statsLiveNote.textContent = "Ride total via count query · refreshed periodically.";
    }
  } catch (error) {
    console.warn("[SwiftGo Admin] rides count", error);
    setStat(els.statTotalRides, allRidesCache.length || null);
    if (els.statsLiveNote) els.statsLiveNote.textContent = permissionHint(error);
  }
}

function startVehiclesFleetMonitor() {
  const { db } = getFirebase();
  if (!db) return;

  liveUnsubscribers.push(
    onSnapshot(
      collection(db, "vehicles"),
      (snapshot) => {
        vehiclesFleetCache = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
        renderVehiclesTable(vehiclesFleetCache);
        if (els.vehicleSelectionModal && !els.vehicleSelectionModal.hidden) {
          renderTakeControlVehicleList(vehiclesFleetCache);
        }
        if (els.vehiclesLiveNote) {
          els.vehiclesLiveNote.textContent = `${vehiclesFleetCache.length} vehicles · live`;
        }
      },
      (error) => {
        console.warn("[SwiftGo Admin] vehicles fleet", error);
        vehiclesFleetCache = [];
        if (els.vehiclesTableBody) {
          els.vehiclesTableBody.innerHTML = `
            <tr class="vehicles-table__empty">
              <td colspan="5">${escapeHtml(permissionHint(error))}</td>
            </tr>`;
        }
        if (els.vehiclesLiveNote) {
          els.vehiclesLiveNote.textContent = permissionHint(error);
        }
      }
    )
  );
}

function showAdminToast(message = "") {
  if (!els.adminToast) return;
  els.adminToast.textContent = message;
  els.adminToast.classList.add("is-visible");
  window.clearTimeout(showAdminToast._timer);
  showAdminToast._timer = window.setTimeout(() => {
    els.adminToast?.classList.remove("is-visible");
  }, 2800);
}

function rechargeMethodLabel(method) {
  if (method === "easypaisa") return "EasyPaisa";
  if (method === "jazzcash") return "JazzCash";
  return method || "—";
}

function renderRechargeRequestsTable(requests = pendingRechargeCache) {
  if (!els.rechargeRequestsTableBody) return;

  if (!requests.length) {
    els.rechargeRequestsTableBody.innerHTML = `
      <tr class="recharge-table__empty">
        <td colspan="6">کوئی زیر التواء درخواست نہیں۔</td>
      </tr>`;
  } else {
    els.rechargeRequestsTableBody.innerHTML = requests
      .map((request) => {
        const date = escapeHtml(formatAdminRideDate(request.createdAt));
        const driver = escapeHtml(request.driverName || request.driverId || "—");
        const method = escapeHtml(rechargeMethodLabel(request.method));
        const tid = escapeHtml(request.tid || "—");
        const amount = Number(request.amount ?? 0);
        const amountLabel = escapeHtml(
          formatAdminMoney(Number.isFinite(amount) && amount > 0 ? amount : null)
        );
        const requestId = escapeHtml(request.id || "");
        const driverId = escapeHtml(request.driverId || "");
        return `
          <tr data-request-id="${requestId}">
            <td><time class="rides-table__date">${date}</time></td>
            <td>${driver}</td>
            <td><span class="pill pill--role">${method}</span></td>
            <td><code class="rides-table__id">${tid}</code></td>
            <td><strong class="rides-table__money">${amountLabel}</strong></td>
            <td>
              <button
                type="button"
                class="account-action-btn btn-unblock"
                data-recharge-approve="${requestId}"
                data-recharge-driver="${driverId}"
                data-recharge-amount="${Math.round(amount)}"
              >منظور کریں</button>
            </td>
          </tr>`;
      })
      .join("");
  }

  if (els.rechargeRequestsCount) {
    els.rechargeRequestsCount.textContent = `${requests.length} pending`;
  }
}

function warnRechargeIndexError(error) {
  console.warn("[SwiftGo Admin] recharge requests", error);
  if (error?.code === "failed-precondition" || /index/i.test(error?.message || "")) {
    console.warn(
      "[SwiftGo Admin] Firestore index required for rechargeRequests (status + createdAt). " +
        "Open the link in this error message in Firebase Console to create it:",
      error.message
    );
  }
}

function fetchAndRenderRechargeRequests() {
  renderRechargeRequestsTable(pendingRechargeCache.length ? pendingRechargeCache : []);
  if (!pendingRechargeCache.length && els.rechargeRequestsTableBody) {
    els.rechargeRequestsTableBody.innerHTML = `
      <tr class="recharge-table__empty">
        <td colspan="6">لوڈ ہو رہا ہے...</td>
      </tr>`;
  }
  if (els.rechargeRequestsLiveNote && !pendingRechargeCache.length) {
    els.rechargeRequestsLiveNote.textContent = "Connecting pending recharge feed…";
  }
}

async function approveRechargeRequest(requestId, request, button) {
  const { db } = getFirebase();
  if (!db || !requestId || !request?.driverId) return;

  const amount = Number(request.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    showAdminToast("درست رقم نہیں ملی۔");
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "منظوری…";
  }

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "rechargeRequests", requestId), {
      status: "approved",
      approvedAt: serverTimestamp(),
    });
    batch.set(
      doc(db, "partners", request.driverId),
      { walletBalance: increment(amount) },
      { merge: true }
    );
    await batch.commit();

    pendingRechargeCache = pendingRechargeCache.filter((item) => item.id !== requestId);
    renderRechargeRequestsTable(pendingRechargeCache);
    showAdminToast(`ریچارج منظور — Rs. ${Math.round(amount).toLocaleString("en-PK")}`);
    if (els.rechargeRequestsLiveNote) {
      els.rechargeRequestsLiveNote.textContent = "Request approved · wallet credited";
    }
  } catch (error) {
    console.warn("[SwiftGo Admin] approveRechargeRequest", error);
    if (button) {
      button.disabled = false;
      button.textContent = "منظور کریں";
    }
    showAdminToast(
      error?.code === "permission-denied"
        ? "Permission denied — check Firestore rules."
        : "منظوری ناکام۔ دوبارہ کوشش کریں۔"
    );
    if (els.rechargeRequestsLiveNote) {
      els.rechargeRequestsLiveNote.textContent = permissionHint(error);
    }
  }
}

function startRechargeRequestsMonitor() {
  const { db } = getFirebase();
  if (!db) return;

  const pendingQuery = query(
    collection(db, "rechargeRequests"),
    where("status", "==", "pending"),
    orderBy("createdAt", "desc")
  );

  liveUnsubscribers.push(
    onSnapshot(
      pendingQuery,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added" && rechargeListenerPrimed) {
            const data = change.doc.data();
            AudioService.playAlert();
            AudioService.showNotification(
              "نئی ریچارج درخواست!",
              `${data.driverName || "ڈرائیور"} · Rs. ${Math.round(Number(data.amount || 0))}`
            );
          }
        });
        rechargeListenerPrimed = true;

        pendingRechargeCache = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
        renderRechargeRequestsTable(pendingRechargeCache);
        if (els.rechargeRequestsLiveNote) {
          els.rechargeRequestsLiveNote.textContent = `${pendingRechargeCache.length} pending · live`;
        }
      },
      (error) => {
        warnRechargeIndexError(error);
        pendingRechargeCache = [];
        if (els.rechargeRequestsTableBody) {
          els.rechargeRequestsTableBody.innerHTML = `
            <tr class="recharge-table__empty">
              <td colspan="6">${escapeHtml(permissionHint(error))}</td>
            </tr>`;
        }
        if (els.rechargeRequestsLiveNote) {
          els.rechargeRequestsLiveNote.textContent = permissionHint(error);
        }
      }
    )
  );
}

function wireDriversTableActions() {
  els.driversTableBody?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-account-action][data-partner-id]");
    if (!btn) return;
    const partnerId = btn.getAttribute("data-partner-id");
    const nextStatus = btn.getAttribute("data-account-action");
    if (!partnerId || !nextStatus) return;
    setDriverAccountStatus(partnerId, nextStatus);
  });
}

function setStat(el, value) {
  if (!el) return;
  el.textContent = typeof value === "number" ? String(value) : "—";
}

function setRevenueStat(value) {
  if (!els.statTotalRevenue) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    els.statTotalRevenue.textContent = "—";
    return;
  }
  els.statTotalRevenue.textContent = `Rs. ${Math.round(value).toLocaleString("en-PK")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function partnerDisplayName(data, id) {
  return data.name || data.displayName || data.fullName || "Driver";
}

function partnerDisplayEmail(data, id) {
  return data.email || data.uid || id;
}

function normalizeAccountStatus(value) {
  return value === "blocked" ? "blocked" : "active";
}

/** Phase 29 — Block / Unblock partner driver docs. */
async function setDriverAccountStatus(partnerId, accountStatus) {
  const { db } = getFirebase();
  if (!db || !partnerId) return;

  const nextStatus = normalizeAccountStatus(accountStatus);
  const btn = els.driversTableBody?.querySelector(
    `[data-account-action][data-partner-id="${CSS.escape(partnerId)}"]`
  );
  if (btn) {
    btn.disabled = true;
    btn.textContent = nextStatus === "blocked" ? "Blocking…" : "Unblocking…";
  }

  try {
    await updateDoc(doc(db, "partners", partnerId), {
      accountStatus: nextStatus,
    });
    // Optimistic local mirror; live onSnapshot will confirm instantly.
    partnerDriversCache = partnerDriversCache.map((partner) =>
      partner.id === partnerId ? { ...partner, accountStatus: nextStatus } : partner
    );
    refreshDriversUi();
    if (els.driversLiveNote) {
      els.driversLiveNote.textContent =
        nextStatus === "blocked"
          ? `Driver blocked · ${partnerId}`
          : `Driver unblocked · ${partnerId}`;
    }
  } catch (error) {
    console.warn("[SwiftGo Admin] setDriverAccountStatus", error);
    if (els.driversLiveNote) {
      els.driversLiveNote.textContent =
        error?.code === "permission-denied"
          ? "Permission denied — Super Admin cannot update partners (check Firestore rules)."
          : `Status update failed: ${error?.message || "unknown error"}`;
    }
    refreshDriversUi();
  }
}

function renderDriversTable(drivers) {
  if (!els.driversTableBody) return;

  if (!drivers.length) {
    els.driversTableBody.innerHTML = `
      <tr class="drivers-table__empty">
        <td colspan="5">ابھی کوئی ڈرائیور پارٹنر نہیں ملا۔</td>
      </tr>`;
  } else {
    els.driversTableBody.innerHTML = drivers
      .map((driver) => {
        const name = escapeHtml(partnerDisplayName(driver, driver.id));
        const email = escapeHtml(partnerDisplayEmail(driver, driver.id));
        const role = escapeHtml(driver.role || "driver");
        const vehicle = escapeHtml(driver.currentVehicleId || "—");
        const walletBalance = Number(driver.walletBalance ?? 0);
        const walletDisplay = Number.isFinite(walletBalance) ? walletBalance : 0;
        const walletOverLimit = walletDisplay <= cachedWalletThreshold;
        const walletClass = walletOverLimit ? "wallet-balance wallet-balance--danger" : "wallet-balance";
        const walletLabel = `Rs. ${Math.round(walletDisplay).toLocaleString("en-PK")}`;
        const accountStatus = normalizeAccountStatus(driver.accountStatus);
        const isBlocked = accountStatus === "blocked";
        const statusLabel = isBlocked ? "Blocked" : "Active";
        const statusClass = isBlocked ? "pill--blocked" : "pill--active";
        const actionLabel = isBlocked ? "Unblock" : "Block";
        const actionClass = isBlocked ? "btn-unblock" : "btn-block";
        const nextStatus = isBlocked ? "active" : "blocked";
        const partnerId = escapeHtml(driver.id);
        return `
          <tr data-partner-id="${partnerId}">
            <td>
              <div class="drivers-table__identity">
                <strong>${name}</strong>
                <span>${email}</span>
              </div>
            </td>
            <td><span class="pill pill--role">${role}</span></td>
            <td><code class="vehicle-id">${vehicle}</code></td>
            <td><span class="${walletClass}">${walletLabel}</span></td>
            <td>
              <div class="drivers-table__actions">
                <span class="pill ${statusClass}">${statusLabel}</span>
                <button
                  type="button"
                  class="account-action-btn ${actionClass}"
                  data-account-action="${nextStatus}"
                  data-partner-id="${partnerId}"
                >${actionLabel}</button>
              </div>
            </td>
          </tr>`;
      })
      .join("");
  }

  if (els.driversTableCount) {
    els.driversTableCount.textContent = `${drivers.length} driver${drivers.length === 1 ? "" : "s"}`;
  }
}

function refreshDriversUi() {
  const drivers = partnerDriversCache.map((partner) => {
    const profile = driverProfilesById.get(partner.id) || {};
    return {
      ...partner,
      name: partner.name || partner.displayName || profile.name,
      email: partner.email || profile.email,
    };
  });
  setStat(els.statActiveDrivers, drivers.length);
  renderDriversTable(drivers);
}

function stopLiveData() {
  liveUnsubscribers.forEach((unsub) => {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  });
  liveUnsubscribers = [];
  stopFleetMap();
  rechargeListenerPrimed = false;
  allRidesListenerPrimed = false;
  driverProfilesById = new Map();
  partnerDriversCache = [];
  allRidesCache = [];
  pendingRechargeCache = [];
  vehiclesFleetCache = [];
  currentAdminUser = null;
}

function permissionHint(error) {
  if (error?.code === "permission-denied") {
    return "Firestore permission denied — Super Admin read rules required for rides/partners.";
  }
  return error?.message || "Live data unavailable.";
}

function rideStatusLabelUrdu(status) {
  return RIDE_STATUS_URDU[status] || status || "نامعلوم";
}

function formatAdminRideDate(createdAt) {
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

function formatAdminMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "—";
  return `Rs. ${Math.round(amount).toLocaleString("en-PK")}`;
}

function rideFareAmount(ride) {
  const value = Number(ride?.estimatedFare ?? ride?.farePkr ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function rideCommissionAmount(ride) {
  const value = Number(ride?.commissionAmount);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function customerDisplay(ride) {
  const userId = ride?.userId;
  if (!userId) return "—";
  return String(userId).slice(0, 10) + "…";
}

function driverDisplay(ride) {
  if (ride?.driverName) return ride.driverName;
  if (ride?.driverId) {
    const partner = partnerDriversCache.find((item) => item.id === ride.driverId);
    if (partner?.name || partner?.displayName) {
      return partner.name || partner.displayName;
    }
    const profile = driverProfilesById.get(ride.driverId);
    if (profile?.name) return profile.name;
    return String(ride.driverId).slice(0, 10) + "…";
  }
  if (ride?.status === "searching_driver") return "تلاش جاری…";
  return "N/A";
}

function statusPillClass(status) {
  if (status === "completed") return "pill--active";
  if (status === "in_progress" || status === "accepted" || status === "arrived") {
    return "pill--role";
  }
  if (status === "searching_driver") return "pill--pending";
  return "pill--blocked";
}

function renderAllRidesTable(rides = allRidesCache) {
  if (!els.allRidesTableBody) return;

  if (!rides.length) {
    els.allRidesTableBody.innerHTML = `
      <tr class="rides-table__empty">
        <td colspan="7">ابھی کوئی سواری نہیں ملی۔</td>
      </tr>`;
  } else {
    els.allRidesTableBody.innerHTML = rides
      .map((ride) => {
        const date = escapeHtml(formatAdminRideDate(ride.createdAt));
        const customer = escapeHtml(customerDisplay(ride));
        const driver = escapeHtml(driverDisplay(ride));
        const status = escapeHtml(rideStatusLabelUrdu(ride.status));
        const statusClass = statusPillClass(ride.status);
        const fare = escapeHtml(formatAdminMoney(rideFareAmount(ride)));
        const commissionValue = rideCommissionAmount(ride);
        const commission =
          commissionValue == null
            ? "—"
            : escapeHtml(formatAdminMoney(commissionValue));
        const rating =
          ride.customerRating != null
            ? `${escapeHtml(String(ride.customerRating))} ★`
            : "—";
        const rideId = escapeHtml(ride.id || "");
        return `
          <tr data-ride-id="${rideId}">
            <td><time class="rides-table__date">${date}</time></td>
            <td><code class="rides-table__id" title="${escapeHtml(ride.userId || "")}">${customer}</code></td>
            <td>${driver}</td>
            <td><span class="pill ${statusClass}">${status}</span></td>
            <td><strong class="rides-table__money">${fare}</strong></td>
            <td><strong class="rides-table__money rides-table__money--cut">${commission}</strong></td>
            <td>${rating}</td>
          </tr>`;
      })
      .join("");
  }

  if (els.allRidesTableCount) {
    els.allRidesTableCount.textContent = `${rides.length} ride${rides.length === 1 ? "" : "s"}`;
  }
}

function warnAllRidesIndexError(error) {
  console.warn("[SwiftGo Admin] all rides monitor", error);
  if (error?.code === "failed-precondition" || /index/i.test(error?.message || "")) {
    console.warn(
      "[SwiftGo Admin] Firestore index required for rides orderBy(createdAt, desc). " +
        "Open the link in this error message in Firebase Console to create it:",
      error.message
    );
  }
}

/** Phase 36 — real-time global rides monitor (latest 100). */
function fetchAndRenderAllRides() {
  const { db } = getFirebase();
  if (!db) {
    if (els.allRidesLiveNote) {
      els.allRidesLiveNote.textContent = "Firestore is not configured.";
    }
    return;
  }

  renderAllRidesTable(allRidesCache.length ? allRidesCache : []);

  if (!allRidesCache.length && els.allRidesTableBody) {
    els.allRidesTableBody.innerHTML = `
      <tr class="rides-table__empty">
        <td colspan="7">لوڈ ہو رہا ہے...</td>
      </tr>`;
  }

  if (els.allRidesLiveNote && !allRidesCache.length) {
    els.allRidesLiveNote.textContent = "Connecting live ride feed…";
  }
}

function startAllRidesMonitor() {
  const { db } = getFirebase();
  if (!db) return;

  const ridesQuery = query(
    collection(db, "rides"),
    orderBy("createdAt", "desc"),
    limit(100)
  );

  liveUnsubscribers.push(
    onSnapshot(
      ridesQuery,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added" && allRidesListenerPrimed) {
            const data = change.doc.data();
            AudioService.playAlert();
            AudioService.showNotification(
              "نئی سواری!",
              data.status === "searching_driver"
                ? "نیا ride request · ڈرائیور تلاش جاری"
                : `نئی ride ریکارڈ · ${data.status || "—"}`
            );
          }
        });
        allRidesListenerPrimed = true;

        allRidesCache = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
        renderAllRidesTable(allRidesCache);
        if (els.allRidesLiveNote) {
          els.allRidesLiveNote.textContent = `${allRidesCache.length} rides · live monitoring`;
        }
      },
      (error) => {
        warnAllRidesIndexError(error);
        allRidesCache = [];
        if (els.allRidesTableBody) {
          els.allRidesTableBody.innerHTML = `
            <tr class="rides-table__empty">
              <td colspan="7">${escapeHtml(permissionHint(error))}</td>
            </tr>`;
        }
        if (els.allRidesLiveNote) {
          els.allRidesLiveNote.textContent = permissionHint(error);
        }
      }
    )
  );
}

/* ── Phase 30 / 46: Financial Controls · per-vehicle settings/pricing ── */

function hidePricingSuccess() {
  window.clearTimeout(pricingSuccessTimer);
  if (els.pricingSuccessMessage) els.pricingSuccessMessage.hidden = true;
}

function showPricingSuccess() {
  hidePricingSuccess();
  if (!els.pricingSuccessMessage) return;
  els.pricingSuccessMessage.hidden = false;
  pricingSuccessTimer = window.setTimeout(() => {
    if (els.pricingSuccessMessage) els.pricingSuccessMessage.hidden = true;
  }, 3000);
}

function normalizeVehicleRate(raw, fallback) {
  const base = fallback || DEFAULT_VEHICLE_RATES.go;
  const baseFare = Number(raw?.baseFare);
  const perKmRate = Number(raw?.perKmRate);
  const commissionPercent = Number(raw?.commissionPercent);

  const distanceTiers = normalizeDistanceTiers(raw?.distanceTiers);
  const paceTiers = normalizePaceTiers(raw?.paceTiers);

  return {
    baseFare: Number.isFinite(baseFare) && baseFare >= 0 ? baseFare : base.baseFare,
    perKmRate: Number.isFinite(perKmRate) && perKmRate >= 0 ? perKmRate : base.perKmRate,
    commissionPercent:
      Number.isFinite(commissionPercent) && commissionPercent >= 0 && commissionPercent <= 100
        ? commissionPercent
        : base.commissionPercent,
    distanceTiers,
    paceTiers,
  };
}

function normalizeDistanceTiers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => {
      const upToRaw = row?.upToKm;
      const upToKm =
        upToRaw === null || upToRaw === undefined || upToRaw === ""
          ? null
          : Number(upToRaw);
      const baseFare = Number(row?.baseFare);
      const perKmRate = Number(row?.perKmRate);
      if (!Number.isFinite(baseFare) || baseFare < 0) return null;
      if (!Number.isFinite(perKmRate) || perKmRate < 0) return null;
      if (upToKm !== null && (!Number.isFinite(upToKm) || upToKm <= 0)) return null;
      return { upToKm, baseFare, perKmRate };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const av = a.upToKm == null ? Number.POSITIVE_INFINITY : a.upToKm;
      const bv = b.upToKm == null ? Number.POSITIVE_INFINITY : b.upToKm;
      return av - bv;
    });
}

function normalizePaceTiers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => {
      const maxRaw = row?.maxMinPerKm;
      const maxMinPerKm =
        maxRaw === null || maxRaw === undefined || maxRaw === ""
          ? null
          : Number(maxRaw);
      const baseFare = Number(row?.baseFare);
      const perKmRate = Number(row?.perKmRate);
      if (!Number.isFinite(baseFare) || baseFare < 0) return null;
      if (!Number.isFinite(perKmRate) || perKmRate < 0) return null;
      if (maxMinPerKm !== null && (!Number.isFinite(maxMinPerKm) || maxMinPerKm <= 0)) {
        return null;
      }
      return { maxMinPerKm, baseFare, perKmRate };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const av = a.maxMinPerKm == null ? Number.POSITIVE_INFINITY : a.maxMinPerKm;
      const bv = b.maxMinPerKm == null ? Number.POSITIVE_INFINITY : b.maxMinPerKm;
      return av - bv;
    });
}

function distanceTierRowHtml(tier = {}) {
  const upTo = tier.upToKm == null ? "" : String(tier.upToKm);
  return `
    <div class="tier-row" data-tier-row="distance">
      <label>
        <span>تک کلومیٹر (خالی = ∞)</span>
        <input type="number" data-tier-field="upToKm" min="0.1" step="0.1" inputmode="decimal" value="${upTo}" placeholder="مثلاً 10" />
      </label>
      <label>
        <span>بیس فیئر</span>
        <input type="number" data-tier-field="baseFare" min="0" step="1" inputmode="numeric" value="${Number(tier.baseFare) || 0}" required />
      </label>
      <label>
        <span>فی کلومیٹر</span>
        <input type="number" data-tier-field="perKmRate" min="0" step="1" inputmode="numeric" value="${Number(tier.perKmRate) || 0}" required />
      </label>
      <button type="button" class="tier-remove-btn" data-remove-tier>ہٹائیں</button>
    </div>`;
}

function paceTierRowHtml(tier = {}) {
  const maxPace = tier.maxMinPerKm == null ? "" : String(tier.maxMinPerKm);
  return `
    <div class="tier-row" data-tier-row="pace">
      <label>
        <span>زیادہ سے زیادہ منٹ/کلومیٹر</span>
        <input type="number" data-tier-field="maxMinPerKm" min="0.1" step="0.1" inputmode="decimal" value="${maxPace}" placeholder="مثلاً 1" />
      </label>
      <label>
        <span>بیس فیئر</span>
        <input type="number" data-tier-field="baseFare" min="0" step="1" inputmode="numeric" value="${Number(tier.baseFare) || 0}" required />
      </label>
      <label>
        <span>فی کلومیٹر</span>
        <input type="number" data-tier-field="perKmRate" min="0" step="1" inputmode="numeric" value="${Number(tier.perKmRate) || 0}" required />
      </label>
      <button type="button" class="tier-remove-btn" data-remove-tier>ہٹائیں</button>
    </div>`;
}

function ensureVehicleTierUi() {
  const grid = els.vehicleRateGrid || document.getElementById("vehicleRateGrid");
  if (!grid) return;

  grid.querySelectorAll(".vehicle-rate-card").forEach((card) => {
    if (card.querySelector("[data-tier-kind]")) return;
    card.insertAdjacentHTML(
      "beforeend",
      `
      <div class="tier-section" data-tier-kind="distance">
        <div class="tier-section__bar">
          <strong>فاصلہ رینج (کلومیٹر)</strong>
          <button type="button" class="tier-add-btn" data-add-tier="distance">+ رینج</button>
        </div>
        <p class="tier-section__hint">مثال: 10 تک، 15 تک، خالی = اس سے آگے · سفر جس رینج میں ہو وہی بیس/فی‌کلومیٹر</p>
        <div class="tier-rows" data-tier-rows="distance"></div>
      </div>
      <div class="tier-section" data-tier-kind="pace">
        <div class="tier-section__bar">
          <strong>وقت / رفتار (منٹ فی کلومیٹر)</strong>
          <button type="button" class="tier-add-btn" data-add-tier="pace">+ رینج</button>
        </div>
        <p class="tier-section__hint">مثال: ≤1 منٹ/کلومیٹر تیز · زیادہ منٹ = سست · فاصلہ ریٹ کے بعد یہ لاگو ہوتا ہے</p>
        <div class="tier-rows" data-tier-rows="pace"></div>
      </div>`
    );
  });

  if (grid.dataset.tierBound === "1") return;
  grid.dataset.tierBound = "1";

  grid.addEventListener("click", (event) => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el) return;

    const addBtn = el.closest("[data-add-tier]");
    if (addBtn) {
      const kind = addBtn.getAttribute("data-add-tier");
      const card = addBtn.closest(".vehicle-rate-card");
      const rows = card?.querySelector(`[data-tier-rows="${kind}"]`);
      if (!rows) return;
      const defaults = {
        baseFare: Number(card.querySelector('[data-rate-field="baseFare"]')?.value) || 0,
        perKmRate: Number(card.querySelector('[data-rate-field="perKmRate"]')?.value) || 0,
      };
      rows.insertAdjacentHTML(
        "beforeend",
        kind === "pace" ? paceTierRowHtml(defaults) : distanceTierRowHtml(defaults)
      );
      return;
    }

    const removeBtn = el.closest("[data-remove-tier]");
    if (removeBtn) {
      removeBtn.closest(".tier-row")?.remove();
    }
  });
}

function renderTierRows(card, rates) {
  const distanceHost = card.querySelector('[data-tier-rows="distance"]');
  const paceHost = card.querySelector('[data-tier-rows="pace"]');
  if (distanceHost) {
    const tiers = Array.isArray(rates?.distanceTiers) ? rates.distanceTiers : [];
    distanceHost.innerHTML = tiers.map((tier) => distanceTierRowHtml(tier)).join("");
  }
  if (paceHost) {
    const tiers = Array.isArray(rates?.paceTiers) ? rates.paceTiers : [];
    paceHost.innerHTML = tiers.map((tier) => paceTierRowHtml(tier)).join("");
  }
}

function readTierFromCard(card, kind) {
  const rows = card.querySelectorAll(`[data-tier-row="${kind}"]`);
  const list = [];
  rows.forEach((row) => {
    if (kind === "distance") {
      const upToRaw = row.querySelector('[data-tier-field="upToKm"]')?.value?.trim();
      const baseFare = Number(row.querySelector('[data-tier-field="baseFare"]')?.value);
      const perKmRate = Number(row.querySelector('[data-tier-field="perKmRate"]')?.value);
      const upToKm = upToRaw === "" ? null : Number(upToRaw);
      if (!Number.isFinite(baseFare) || baseFare < 0) {
        throw new Error("فاصلہ رینج: بیس فیئر درست نہیں۔");
      }
      if (!Number.isFinite(perKmRate) || perKmRate < 0) {
        throw new Error("فاصلہ رینج: فی کلومیٹر درست نہیں۔");
      }
      if (upToKm !== null && (!Number.isFinite(upToKm) || upToKm <= 0)) {
        throw new Error("فاصلہ رینج: کلومیٹر حد درست نہیں۔");
      }
      list.push({ upToKm, baseFare, perKmRate });
      return;
    }

    const maxRaw = row.querySelector('[data-tier-field="maxMinPerKm"]')?.value?.trim();
    const baseFare = Number(row.querySelector('[data-tier-field="baseFare"]')?.value);
    const perKmRate = Number(row.querySelector('[data-tier-field="perKmRate"]')?.value);
    const maxMinPerKm = maxRaw === "" ? null : Number(maxRaw);
    if (!Number.isFinite(baseFare) || baseFare < 0) {
      throw new Error("وقت رینج: بیس فیئر درست نہیں۔");
    }
    if (!Number.isFinite(perKmRate) || perKmRate < 0) {
      throw new Error("وقت رینج: فی کلومیٹر درست نہیں۔");
    }
    if (maxMinPerKm !== null && (!Number.isFinite(maxMinPerKm) || maxMinPerKm <= 0)) {
      throw new Error("وقت رینج: منٹ/کلومیٹر درست نہیں۔");
    }
    list.push({ maxMinPerKm, baseFare, perKmRate });
  });
  return kind === "distance" ? normalizeDistanceTiers(list) : normalizePaceTiers(list);
}

function fillPricingForm(pricing) {
  ensureVehicleTierUi();
  const normalized = normalizePricingDocument(pricing || DEFAULT_PRICING);
  if (els.pricingWalletThreshold) {
    els.pricingWalletThreshold.value = String(normalized.walletThreshold);
  }

  const grid = els.vehicleRateGrid || document.getElementById("vehicleRateGrid");
  grid?.querySelectorAll("[data-vehicle-key]").forEach((card) => {
    const key = card.getAttribute("data-vehicle-key");
    const rates = normalized.vehicles[key] || DEFAULT_VEHICLE_RATES[key];
    if (!rates) return;
    card.querySelectorAll("[data-rate-field]").forEach((input) => {
      const field = input.getAttribute("data-rate-field");
      if (field && rates[field] != null) input.value = String(rates[field]);
    });
    renderTierRows(card, rates);
  });
}

function readPricingFormValues() {
  ensureVehicleTierUi();
  const walletThreshold = Number(els.pricingWalletThreshold?.value);
  if (!Number.isFinite(walletThreshold) || walletThreshold > 0) {
    throw new Error("والٹ حد صفر یا منفی ہونی چاہیے (مثلاً -500)۔");
  }

  /** @type {Record<string, Record<string, unknown>>} */
  const vehicles = {};
  const grid = els.vehicleRateGrid || document.getElementById("vehicleRateGrid");

  VEHICLE_RATE_KEYS.forEach((key) => {
    const card = grid?.querySelector(`[data-vehicle-key="${key}"]`);
    if (!card) {
      vehicles[key] = {
        ...DEFAULT_VEHICLE_RATES[key],
        distanceTiers: [],
        paceTiers: [],
      };
      return;
    }
    const baseFare = Number(card.querySelector('[data-rate-field="baseFare"]')?.value);
    const perKmRate = Number(card.querySelector('[data-rate-field="perKmRate"]')?.value);
    const commissionPercent = Number(
      card.querySelector('[data-rate-field="commissionPercent"]')?.value
    );

    if (!Number.isFinite(baseFare) || baseFare < 0) {
      throw new Error(`${key}: بیس فیئر درست درج کریں۔`);
    }
    if (!Number.isFinite(perKmRate) || perKmRate < 0) {
      throw new Error(`${key}: فی کلومیٹر ریٹ درست درج کریں۔`);
    }
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
      throw new Error(`${key}: کمیشن 0 سے 100 کے درمیان ہونا چاہیے۔`);
    }

    vehicles[key] = {
      baseFare,
      perKmRate,
      commissionPercent,
      distanceTiers: readTierFromCard(card, "distance"),
      paceTiers: readTierFromCard(card, "pace"),
    };
  });

  const go = vehicles.go;
  return {
    walletThreshold,
    baseFare: go.baseFare,
    perKmRate: go.perKmRate,
    commissionPercent: go.commissionPercent,
    vehicles,
  };
}

/** Merge legacy flat pricing + nested vehicles map into a full rate table. */
function normalizePricingDocument(data) {
  const walletThreshold = Number(data?.walletThreshold);
  const legacy = {
    baseFare: Number(data?.baseFare),
    perKmRate: Number(data?.perKmRate),
    commissionPercent: Number(data?.commissionPercent),
  };
  const hasLegacy =
    Number.isFinite(legacy.baseFare) ||
    Number.isFinite(legacy.perKmRate) ||
    Number.isFinite(legacy.commissionPercent);

  const legacyRate = hasLegacy
    ? normalizeVehicleRate(
        {
          baseFare: Number.isFinite(legacy.baseFare) ? legacy.baseFare : DEFAULT_VEHICLE_RATES.go.baseFare,
          perKmRate: Number.isFinite(legacy.perKmRate)
            ? legacy.perKmRate
            : DEFAULT_VEHICLE_RATES.go.perKmRate,
          commissionPercent: Number.isFinite(legacy.commissionPercent)
            ? legacy.commissionPercent
            : DEFAULT_VEHICLE_RATES.go.commissionPercent,
        },
        DEFAULT_VEHICLE_RATES.go
      )
    : null;

  /** @type {Record<string, { baseFare: number, perKmRate: number, commissionPercent: number }>} */
  const vehicles = {};
  VEHICLE_RATE_KEYS.forEach((key) => {
    const fromDoc = data?.vehicles?.[key];
    vehicles[key] = normalizeVehicleRate(
      fromDoc || legacyRate || DEFAULT_VEHICLE_RATES[key],
      DEFAULT_VEHICLE_RATES[key]
    );
  });

  const go = vehicles.go;
  return {
    walletThreshold: Number.isFinite(walletThreshold)
      ? walletThreshold
      : DEFAULT_PRICING.walletThreshold,
    // Legacy flat fields kept in sync with Go for older clients.
    baseFare: go.baseFare,
    perKmRate: go.perKmRate,
    commissionPercent: go.commissionPercent,
    vehicles,
  };
}

async function loadDispatchSettings() {
  const { db } = getFirebase();
  if (!db || !els.candidateDriverLimitInput) return;
  try {
    const snapshot = await getDoc(doc(db, "settings", "dispatch"));
    const data = snapshot.exists() ? snapshot.data() || {} : {};
    const limit = Number(data.candidateDriverLimit);
    els.candidateDriverLimitInput.value =
      Number.isInteger(limit) && limit >= 1 && limit <= 100 ? String(limit) : "10";

    const totalMeters =
      data.maxSearchRadiusMeters != null && Number.isFinite(Number(data.maxSearchRadiusMeters))
        ? Math.max(0, Math.round(Number(data.maxSearchRadiusMeters)))
        : Math.round(Number(data.maxSearchRadiusKm || 3) * 1000);
    const km = Math.floor(totalMeters / 1000);
    const meters = totalMeters % 1000;
    if (els.dispatchRadiusKmInput) els.dispatchRadiusKmInput.value = String(km);
    if (els.dispatchRadiusMetersInput) els.dispatchRadiusMetersInput.value = String(meters);
    updateDispatchRadiusPreview();

    if (els.dispatchStatusNote) {
      els.dispatchStatusNote.textContent = snapshot.exists()
        ? `موجودہ: ${els.candidateDriverLimitInput.value} ڈرائیور · ${formatDispatchRadiusPreview(totalMeters)} · settings/dispatch`
        : "Default 10 drivers · 3 km — document not found yet.";
    }
  } catch (error) {
    console.warn("[SwiftGo Admin] loadDispatchSettings", error);
    if (els.dispatchStatusNote) {
      els.dispatchStatusNote.textContent = `Could not load dispatch: ${error?.message || "unknown"}`;
    }
  }
}

function parseDispatchRadiusInputs() {
  const km = Math.max(0, Math.floor(Number(els.dispatchRadiusKmInput?.value) || 0));
  const meters = Math.max(0, Math.floor(Number(els.dispatchRadiusMetersInput?.value) || 0));
  const totalMeters = km * 1000 + meters;
  const totalKm = totalMeters / 1000;
  return { km, meters, totalMeters, totalKm };
}

function formatDispatchRadiusPreview(totalMeters) {
  const totalKm = totalMeters / 1000;
  const kmLabel = totalKm.toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const metersLabel = totalMeters.toLocaleString("en-PK");
  return `کل فاصلہ: ${kmLabel} کلومیٹر / ${metersLabel} میٹر`;
}

function updateDispatchRadiusPreview() {
  const { totalMeters } = parseDispatchRadiusInputs();
  if (!els.dispatchRadiusPreview) return;
  els.dispatchRadiusPreview.textContent =
    totalMeters > 0 ? formatDispatchRadiusPreview(totalMeters) : "کل فاصلہ: —";
}

async function saveDispatchSettings(event) {
  event.preventDefault();
  const limit = Number(els.candidateDriverLimitInput?.value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    if (els.dispatchStatusNote) {
      els.dispatchStatusNote.textContent = "امیدوار حد 1 سے 100 کے درمیان ہونی چاہیے۔";
    }
    return;
  }

  const { km, meters, totalMeters, totalKm } = parseDispatchRadiusInputs();
  if (totalMeters <= 0) {
    if (els.dispatchStatusNote) {
      els.dispatchStatusNote.textContent = "تلاش حلقہ کم از کم 1 میٹر ہونا چاہیے۔";
    }
    return;
  }
  if (km > 50 || meters > 999 || totalKm > 50.999) {
    if (els.dispatchStatusNote) {
      els.dispatchStatusNote.textContent = "تلاش حلقہ زیادہ سے زیادہ 50 کلومیٹر + 999 میٹر ہو سکتا ہے۔";
    }
    return;
  }

  const liveUser = getFirebase().auth?.currentUser || currentAdminUser;
  if (!liveUser) {
    showAdminToast("براہ کرم دوبارہ لاگ اِن کریں — سیشن / ٹوکن کی تجدید درکار ہے");
    return;
  }

  try {
    const ready = await prepareAdminSaveForWrite(liveUser);
    if (!ready && !isAuthorizedAdmin(getFirebase().auth?.currentUser || currentAdminUser)) {
      showAdminToast("آپ کے اکاؤنٹ کے پاس سوپر ایڈمن کے حقوق نہیں ہیں");
      return;
    }
  } catch (error) {
    console.error("[Financial Settings Error]:", error?.code, error?.message);
    showAdminToast(adminSaveErrorMessage(error));
    return;
  }

  setFinanceSaveBusy(els.dispatchSaveBtn, true);
  if (els.dispatchStatusNote) els.dispatchStatusNote.textContent = "محفوظ ہو رہا ہے…";
  try {
    await saveAdminDispatchSettings({
      candidateDriverLimit: limit,
      dispatchRadiusKm: km,
      dispatchRadiusMeters: meters,
      maxSearchRadiusKm: totalKm,
      maxSearchRadiusMeters: totalMeters,
    });
    if (els.dispatchStatusNote) {
      els.dispatchStatusNote.textContent = `محفوظ: ${limit} ڈرائیور · ${formatDispatchRadiusPreview(totalMeters)}`;
    }
    showAdminToast("ڈسپیچ سیٹنگ محفوظ ہو گئی");
  } catch (error) {
    console.error("[Financial Settings Error]:", error?.code, error?.message);
    const msg = adminSaveErrorMessage(error);
    if (els.dispatchStatusNote) els.dispatchStatusNote.textContent = msg;
    showAdminToast(msg);
  } finally {
    setFinanceSaveBusy(els.dispatchSaveBtn, false);
    updateFinanceWriteUi();
  }
}

async function loadPricingSettings() {
  const { db } = getFirebase();
  if (!db) {
    if (els.pricingStatusNote) els.pricingStatusNote.textContent = "Firestore is not configured.";
    fillPricingForm(DEFAULT_PRICING);
    return;
  }

  if (els.pricingStatusNote) {
    els.pricingStatusNote.textContent = pricingLoaded ? "" : "Pricing settings لوڈ ہو رہے ہیں…";
  }

  try {
    const snapshot = await getDoc(doc(db, "settings", "pricing"));
    const data = snapshot.exists() ? snapshot.data() : null;
    const normalized = normalizePricingDocument(data || {});
    fillPricingForm(normalized);
    cachedWalletThreshold = normalized.walletThreshold;
    pricingLoaded = true;
    if (els.pricingStatusNote) {
      els.pricingStatusNote.textContent = snapshot.exists()
        ? "ہر گاڑی کے ریٹس لوڈ ہو گئے · settings/pricing"
        : "Defaults loaded — document not found yet.";
    }
  } catch (error) {
    console.warn("[SwiftGo Admin] loadPricingSettings", error);
    fillPricingForm(DEFAULT_PRICING);
    if (els.pricingStatusNote) {
      els.pricingStatusNote.textContent =
        error?.code === "permission-denied"
          ? "Permission denied reading settings/pricing."
          : `Could not load pricing: ${error?.message || "unknown error"}`;
    }
  }
}

async function savePricingSettings(event) {
  event.preventDefault();
  hidePricingSuccess();

  const liveUser = getFirebase().auth?.currentUser || currentAdminUser;
  if (!liveUser) {
    const msg = "براہ کرم دوبارہ لاگ اِن کریں — سیشن / ٹوکن کی تجدید درکار ہے";
    console.error("[Financial Settings Error]:", "unauthenticated", msg);
    showAdminToast(msg);
    if (els.pricingStatusNote) els.pricingStatusNote.textContent = msg;
    return;
  }

  try {
    const ready = await prepareAdminSaveForWrite(liveUser);
    if (!ready && !isAuthorizedAdmin(getFirebase().auth?.currentUser || currentAdminUser)) {
      const msg = "آپ کے اکاؤنٹ کے پاس سوپر ایڈمن کے حقوق نہیں ہیں";
      console.error("[Financial Settings Error]:", "permission-denied", msg);
      showAdminToast(msg);
      if (els.pricingStatusNote) els.pricingStatusNote.textContent = msg;
      return;
    }
  } catch (error) {
    console.error("[Financial Settings Error]:", error?.code, error?.message);
    const msg = adminSaveErrorMessage(error);
    showAdminToast(msg);
    if (els.pricingStatusNote) els.pricingStatusNote.textContent = msg;
    return;
  }

  let values;
  try {
    values = readPricingFormValues();
  } catch (error) {
    console.error("[Financial Settings Error]:", "invalid-argument", error?.message);
    const msg = `Invalid Number Format — ${error.message}`;
    if (els.pricingStatusNote) els.pricingStatusNote.textContent = msg;
    showAdminToast(msg);
    return;
  }

  setFinanceSaveBusy(els.pricingSaveBtn, true);
  if (els.pricingStatusNote) els.pricingStatusNote.textContent = "محفوظ ہو رہا ہے…";

  try {
    const via = await persistPricingSettings(values);
    pricingLoaded = true;
    cachedWalletThreshold = values.walletThreshold;
    refreshDriversUi();
    if (els.pricingStatusNote) {
      els.pricingStatusNote.textContent =
        via === "firestore"
          ? "Firestore settings/pricing میں محفوظ ہو گیا (direct)"
          : "Firestore settings/pricing میں محفوظ ہو گیا";
    }
    showPricingSuccess();
    showAdminToast("مالی ترتیبات محفوظ ہو گئیں");
  } catch (error) {
    console.error("[Financial Settings Error]:", error?.code, error?.message);
    const msg = adminSaveErrorMessage(error);
    if (els.pricingStatusNote) els.pricingStatusNote.textContent = msg;
    showAdminToast(msg);
  } finally {
    setFinanceSaveBusy(els.pricingSaveBtn, false);
    updateFinanceWriteUi();
  }
}

async function loadWalletThresholdForAdmin() {
  const { db } = getFirebase();
  if (!db) {
    cachedWalletThreshold = DEFAULT_PRICING.walletThreshold;
    return;
  }
  try {
    const snap = await getDoc(doc(db, "settings", "pricing"));
    if (!snap.exists()) {
      cachedWalletThreshold = DEFAULT_PRICING.walletThreshold;
      return;
    }
    const value = Number(snap.data()?.walletThreshold);
    cachedWalletThreshold = Number.isFinite(value) ? value : DEFAULT_PRICING.walletThreshold;
  } catch (error) {
    console.warn("[SwiftGo Admin] wallet threshold", error);
    cachedWalletThreshold = DEFAULT_PRICING.walletThreshold;
  }
}

/* ── Phase 42: Promo codes ── */

function renderPromoCodesTable(promos = promoCodesCache) {
  if (!els.promoCodesTableBody) return;

  if (!promos.length) {
    els.promoCodesTableBody.innerHTML = `
      <tr class="promo-table__empty">
        <td colspan="6">کوئی پرومو کوڈ نہیں۔ Admin سے نیا کوڈ شامل کریں۔</td>
      </tr>`;
    return;
  }

  els.promoCodesTableBody.innerHTML = promos
    .map((promo) => {
      const code = escapeHtml(String(promo.code || promo.id || ""));
      const typeLabel = promo.type === "fixed" ? "Fixed PKR" : "Percent %";
      const value = escapeHtml(String(promo.value ?? "—"));
      const used = Number(promo.usedCount) || 0;
      const maxUses = Number(promo.maxUses);
      const usage = Number.isFinite(maxUses) && maxUses > 0 ? `${used}/${maxUses}` : String(used);
      const active = promo.active !== false;
      const statusClass = active ? "pill--approved" : "pill--blocked";
      const statusLabel = active ? "فعال" : "غیر فعال";
      const toggleLabel = active ? "بند کریں" : "فعال کریں";
      return `
        <tr data-promo-code="${code}">
          <td><code>${code}</code></td>
          <td>${typeLabel}</td>
          <td>${value}</td>
          <td>${usage}</td>
          <td><span class="pill ${statusClass}">${statusLabel}</span></td>
          <td>
            <button type="button" class="promo-action-btn" data-promo-toggle="${code}" data-promo-active="${active ? "0" : "1"}">${toggleLabel}</button>
            <button type="button" class="promo-action-btn promo-action-btn--danger" data-promo-delete="${code}">حذف</button>
          </td>
        </tr>`;
    })
    .join("");
}

function fetchAndRenderPromoCodes() {
  renderPromoCodesTable(promoCodesCache.length ? promoCodesCache : []);

  if (!promoCodesCache.length && els.promoCodesTableBody) {
    els.promoCodesTableBody.innerHTML = `
      <tr class="promo-table__empty">
        <td colspan="6">لوڈ ہو رہا ہے...</td>
      </tr>`;
  }
}

function startPromoCodesMonitor() {
  const { db } = getFirebase();
  if (!db) return;

  const promoQuery = query(collection(db, "promoCodes"), orderBy("createdAt", "desc"));

  liveUnsubscribers.push(
    onSnapshot(
      promoQuery,
      (snapshot) => {
        promoCodesCache = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
        promoCodesListenerPrimed = true;
        if (els.content?.dataset.activeView === "finance") {
          renderPromoCodesTable(promoCodesCache);
        }
        if (els.promoCodesLiveNote) {
          els.promoCodesLiveNote.textContent = `${promoCodesCache.length} promo code${promoCodesCache.length === 1 ? "" : "s"}`;
        }
      },
      (error) => {
        console.warn("[SwiftGo Admin] promo codes monitor", error);
        if (els.promoCodesLiveNote) {
          els.promoCodesLiveNote.textContent = error.message || "Promo feed error";
        }
      }
    )
  );
}

async function createPromoCode(event) {
  event.preventDefault();

  const { db } = getFirebase();
  if (!db) {
    showAdminToast("Firestore is not configured.");
    return;
  }

  const code = String(els.promoCodeInput?.value || "")
    .trim()
    .toUpperCase();
  const type = els.promoTypeInput?.value === "fixed" ? "fixed" : "percent";
  const value = Number(els.promoValueInput?.value);
  const maxUsesRaw = Number(els.promoMaxUsesInput?.value);

  if (!code || code.length > 32) {
    showAdminToast("Valid promo code required.");
    return;
  }
  if (!Number.isFinite(value) || value <= 0) {
    showAdminToast("Promo value must be greater than zero.");
    return;
  }

  const payload = {
    code,
    type,
    value,
    active: true,
    usedCount: 0,
    createdAt: serverTimestamp(),
  };
  if (Number.isFinite(maxUsesRaw) && maxUsesRaw > 0) {
    payload.maxUses = Math.round(maxUsesRaw);
  }

  if (els.promoSaveBtn) els.promoSaveBtn.disabled = true;

  try {
    await setDoc(doc(db, "promoCodes", code), payload);
    if (els.promoCodeForm) els.promoCodeForm.reset();
    showAdminToast(`Promo ${code} created.`);
  } catch (error) {
    console.warn("[SwiftGo Admin] createPromoCode", error);
    showAdminToast(error?.message || "Could not create promo code.");
  } finally {
    if (els.promoSaveBtn) els.promoSaveBtn.disabled = false;
  }
}

async function togglePromoCodeActive(code, makeActive) {
  const { db } = getFirebase();
  if (!db || !code) return;

  try {
    await updateDoc(doc(db, "promoCodes", code), { active: makeActive });
    showAdminToast(makeActive ? `${code} activated.` : `${code} deactivated.`);
  } catch (error) {
    console.warn("[SwiftGo Admin] togglePromoCode", error);
    showAdminToast(error?.message || "Update failed.");
  }
}

async function deletePromoCode(code) {
  const { db } = getFirebase();
  if (!db || !code) return;
  if (!window.confirm(`Delete promo code ${code}?`)) return;

  try {
    await deleteDoc(doc(db, "promoCodes", code));
    showAdminToast(`${code} deleted.`);
  } catch (error) {
    console.warn("[SwiftGo Admin] deletePromoCode", error);
    showAdminToast(error?.message || "Delete failed.");
  }
}

function wirePromoTableActions() {
  els.promoCodesTableBody?.addEventListener("click", (event) => {
    const toggleBtn = event.target.closest("[data-promo-toggle]");
    if (toggleBtn) {
      const code = toggleBtn.getAttribute("data-promo-toggle");
      const makeActive = toggleBtn.getAttribute("data-promo-active") === "1";
      togglePromoCodeActive(code, makeActive);
      return;
    }

    const deleteBtn = event.target.closest("[data-promo-delete]");
    if (deleteBtn) {
      deletePromoCode(deleteBtn.getAttribute("data-promo-delete"));
    }
  });
}

/** Phase 28.2 + 28.3 — real-time Firestore listeners after auth. */
function startLiveData() {
  const { db } = getFirebase();
  if (!db) {
    if (els.statsLiveNote) els.statsLiveNote.textContent = "Firestore is not configured.";
    return;
  }

  stopLiveData();
  loadWalletThresholdForAdmin()
    .then(() => refreshDriversUi())
    .catch(() => {});
  loadPricingSettings().catch(() => {});
  loadDispatchSettings().catch(() => {});
  setStat(els.statTotalRides, null);
  setStat(els.statActiveDrivers, null);
  setRevenueStat(null);
  renderDriversTable([]);
  if (els.driversTableBody) {
    els.driversTableBody.innerHTML = `
      <tr class="drivers-table__empty">
        <td colspan="5">لوڈ ہو رہا ہے...</td>
      </tr>`;
  }
  if (els.statsLiveNote) els.statsLiveNote.textContent = "Connecting live metrics…";
  if (els.driversLiveNote) els.driversLiveNote.textContent = "";

  startAllRidesMonitor();
  startRechargeRequestsMonitor();
  startVehiclesFleetMonitor();
  startPromoCodesMonitor();
  if (els.allRidesTableBody) {
    els.allRidesTableBody.innerHTML = `
      <tr class="rides-table__empty">
        <td colspan="7">لوڈ ہو رہا ہے...</td>
      </tr>`;
  }
  if (els.allRidesLiveNote) els.allRidesLiveNote.textContent = "";
  if (els.rechargeRequestsTableBody) {
    els.rechargeRequestsTableBody.innerHTML = `
      <tr class="recharge-table__empty">
        <td colspan="6">لوڈ ہو رہا ہے...</td>
      </tr>`;
  }
  if (els.rechargeRequestsLiveNote) els.rechargeRequestsLiveNote.textContent = "";
  if (els.vehiclesTableBody) {
    els.vehiclesTableBody.innerHTML = `
      <tr class="vehicles-table__empty">
        <td colspan="5">لوڈ ہو رہا ہے...</td>
      </tr>`;
  }
  if (els.vehiclesLiveNote) els.vehiclesLiveNote.textContent = "";

  // Total rides — Phase 3A: aggregation count (not unbounded collection listener).
  refreshTotalRidesStat();
  // Refresh occasionally from all-rides monitor updates (capped feed already live).
  const ridesStatRefresh = window.setInterval(() => {
    refreshTotalRidesStat();
  }, 60_000);
  liveUnsubscribers.push(() => window.clearInterval(ridesStatRefresh));

  // Drivers: partners where role == 'driver' (feeds card + table)
  const driversQuery = query(collection(db, "partners"), where("role", "==", "driver"));
  liveUnsubscribers.push(
    onSnapshot(
      driversQuery,
      (snapshot) => {
        partnerDriversCache = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
        refreshDriversUi();
        if (allRidesCache.length) renderAllRidesTable(allRidesCache);
        if (els.driversLiveNote) {
          els.driversLiveNote.textContent = "Drivers table synced live.";
        }
      },
      (error) => {
        console.warn("[SwiftGo Admin] partners drivers", error);
        partnerDriversCache = [];
        setStat(els.statActiveDrivers, null);
        renderDriversTable([]);
        if (els.driversTableBody) {
          els.driversTableBody.innerHTML = `
            <tr class="drivers-table__empty">
              <td colspan="5">${escapeHtml(permissionHint(error))}</td>
            </tr>`;
        }
        if (els.driversLiveNote) els.driversLiveNote.textContent = permissionHint(error);
      }
    )
  );

  // Enrich name/email from drivers/{uid} profiles when available
  liveUnsubscribers.push(
    onSnapshot(
      collection(db, "drivers"),
      (snapshot) => {
        driverProfilesById = new Map(
          snapshot.docs.map((docSnap) => {
            const data = docSnap.data();
            return [docSnap.id, { name: data.name, email: data.email }];
          })
        );
        refreshDriversUi();
        if (allRidesCache.length) renderAllRidesTable(allRidesCache);
      },
      (error) => {
        console.warn("[SwiftGo Admin] drivers profiles", error);
      }
    )
  );

  // Phase 33: Total Revenue = sum of commissionAmount on completed rides
  const completedRidesQuery = query(
    collection(db, "rides"),
    where("status", "==", "completed")
  );
  liveUnsubscribers.push(
    onSnapshot(
      completedRidesQuery,
      (snapshot) => {
        let revenue = 0;
        snapshot.forEach((docSnap) => {
          const amount = Number(docSnap.data()?.commissionAmount ?? 0);
          if (Number.isFinite(amount) && amount > 0) revenue += amount;
        });
        setRevenueStat(revenue);
      },
      (error) => {
        console.warn("[SwiftGo Admin] revenue sum", error);
        setRevenueStat(null);
        if (els.statsLiveNote) els.statsLiveNote.textContent = permissionHint(error);
      }
    )
  );
}

function boot() {
  applyReducedMotionClass();
  initKeyboardInset();
  const firebase = getFirebase();
  showLogin();
  wireNavigation();
  initFleetMapModule({
    resolveDriverName: (driverId) => {
      const partner = partnerDriversCache.find((item) => item.id === driverId);
      if (partner?.name || partner?.displayName) {
        return partner.name || partner.displayName;
      }
      const profile = driverProfilesById.get(driverId);
      if (profile?.name) return profile.name;
      return `ڈرائیور ${String(driverId).slice(0, 6)}`;
    },
  });
  initAudioService({ storagePrefix: "swiftgo_admin_" });
  initNotificationSettingsUI();
  AudioService.requestBrowserNotificationPermission().catch(() => {});
  setActiveView("dashboard");

  els.loginBtn?.addEventListener("click", signInWithGoogle);
  els.logoutBtn?.addEventListener("click", handleLogout);
  els.accessDeniedDismiss?.addEventListener("click", hideAccessDenied);
  wireDriversTableActions();
  wireRechargeTableActions();
  wireVehiclesTableActions();
  wireGlobalTakeControl();
  wirePromoTableActions();
  els.pricingForm?.addEventListener("submit", savePricingSettings);
  els.dispatchForm?.addEventListener("submit", saveDispatchSettings);
  for (const input of [els.dispatchRadiusKmInput, els.dispatchRadiusMetersInput]) {
    input?.addEventListener("input", updateDispatchRadiusPreview);
    input?.addEventListener("change", updateDispatchRadiusPreview);
  }
  els.promoCodeForm?.addEventListener("submit", createPromoCode);
  if (els.pricingStatusNote) {
    els.pricingStatusNote.textContent = "لاگ اِن کے بعد Firestore سے ریٹس لوڈ ہوں گے…";
  }

  if (!firebase.auth) {
    setStatus("Firebase is not configured.");
    return;
  }

  getRedirectResult(firebase.auth).catch((error) => {
    console.warn("[SwiftGo Admin] Google redirect", error);
    setStatus("Google redirect sign-in failed.");
  });

  onAuthStateChanged(firebase.auth, async (user) => {
    if (denyingUnauthorized) return;

    setBusy(false);

    if (!user) {
      currentAdminUser = null;
      stopLiveData();
      showLogin();
      return;
    }

    // Hard gate: drivers / fleet owners / any non-Owner account → deny + redirect.
    if (!isAuthorizedAdmin(user)) {
      currentAdminUser = null;
      stopLiveData();
      await denyAndSignOut(firebase.auth);
      return;
    }

    currentAdminUser = user;
    showDashboard(user);
    setStatus("");
    startLiveData();
  });

  console.info(
    `[SwiftGo Admin] Phase 41 notification engine ready · project=${firebaseConfig.projectId} · firebase=${
      isFirebaseConfigured() && firebase.ready
    }`
  );
}

boot();
