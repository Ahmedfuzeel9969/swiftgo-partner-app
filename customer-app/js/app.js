import {
  initI18n,
  setLang,
  getLang,
  syncLangButtons,
  applyTranslations,
  t,
  subscribe,
  paymentMethodLabel,
} from "./i18n.js";
import { initMap, locateUser, resizeMap } from "./map.js";
import {
  initSheet,
  setSheetVisible,
  refreshSheetLabels,
  collapseSheet,
  expandSheet,
  resetSheetForNewRide,
} from "./sheet.js";
import { initLocationModule, refreshLocationLabels } from "./location.js";
import { initStepUi, refreshStepUiLabels, openSearchCard } from "./step-ui.js";

import {
  initScreens,
  refreshScreens,
  setWalletBalanceUi,
} from "./screens.js";
import { initAuth, onUserChange, openAuthModal, getCurrentUser, logout } from "./auth.js";
import { watchUserProfile } from "./data.js";
import { isFirebaseConfigured } from "./firebase.js";
import { installCustomerE2EHooks } from "./e2e-hooks.js";
import {
  initDashboard,
  refreshDashboardLabels,
  getPaymentMethod,
  closePaySheet,
} from "./dashboard.js";
import {
  initUtilityDrawer,
  closeUtilityDrawer,
  refreshUtilityDrawerLabels,
  isUtilityDrawerOpen,
} from "./utility-drawer.js";
import { initRateDetailsModal, openRateDetails, renderRateDetailsPage } from "./rate-details-modal.js";
import { initCustomerHome } from "./CustomerHome.js";
import { getRouteInfo, initRoutingUi } from "./routing.js";
import { initFareCalculation } from "./fare.js";
import { initRideFlow, startRideRequest, resumeActiveRideWatch, clearCustomerRideSession } from "./ride-flow.js";
import { initDriverTrack } from "./driver-track.js";
import { applyReducedMotionClass, initKeyboardInset, setOverlayInert } from "./a11y.js";
import {
  wireLegalLinks,
  complaintWhatsAppHref,
  submitSupportReportClient,
  requestAccountDeletionClient,
  askTrustConfirm,
} from "./trust.js";
import {
  initRideHistory,
  refreshRideHistory,
  startCustomerRideHistory,
  stopCustomerRideHistory,
} from "./history.js";
import { isNativeShell, getNativePlatform, getNetworkStatus } from "./native-shell.js";
import { installDefaultOsrmPreviewRouteProvider } from "./route-provider-bootstrap.mjs";

// Expose thin native helpers for Capacitor shells (no-ops on web).
window.__swiftgoNative = { isNativeShell, getNativePlatform, getNetworkStatus };
window.__SWIFTGO_ANDROID_PACKAGE__ = "com.swiftgo.customer";
// Active-ride two-leg routes: same public OSRM preview booking already uses.
installDefaultOsrmPreviewRouteProvider(window);

const ROUTES = ["hub", "home", "history", "wallet", "rates", "missed-call", "contact", "settings"];

const ROUTE_TITLE_KEYS = {
  hub: "navHome",
  home: "bookRideBtn",
  history: "navHistory",
  wallet: "navWallet",
  rates: "navFareRates",
  "missed-call": "navMissedCall",
  contact: "navContact",
  settings: "navSettings",
};

const els = {
  app: document.getElementById("app"),
  sidebar: document.getElementById("sidebar"),
  overlay: document.getElementById("drawerOverlay"),
  menuBtn: document.getElementById("menuBtn"),
  shell: document.getElementById("shell"),
  locateBtn: document.getElementById("locateBtn"),
  fabLocate: document.getElementById("fabLocate"),
  profileName: document.getElementById("profileName"),
  profileSub: document.getElementById("profileSub"),
  signOutBtn: document.getElementById("signOutBtn"),
  settingsSignOutBtn: document.getElementById("settingsSignOutBtn"),
  viewTitle: document.getElementById("customerViewTitle"),
  headerBrand: document.getElementById("epHeaderBrand"),
  headerBackBtn: document.getElementById("epHeaderBackBtn"),
  headerSettingsBtn: document.getElementById("epHeaderSettingsBtn"),
  bottomBookBtn: document.getElementById("epBottomBookBtn"),
  viewport: document.getElementById("viewport"),
};

let drawerOpen = false;
let mapReady = false;
let unsubProfile = () => {};
let customerHomeUi = null;
let activeRoute = "hub";

function openDrawer() {
  closeUtilityDrawer();
  drawerOpen = true;
  els.sidebar.classList.add("is-open");
  setOverlayInert(els.sidebar, false);
  els.overlay.hidden = false;
  requestAnimationFrame(() => els.overlay.classList.add("is-visible"));
  els.menuBtn.setAttribute("aria-label", t("closeMenu"));
  els.menuBtn.setAttribute("aria-expanded", "true");
  document.body.classList.add("drawer-open");
}

function closeDrawer() {
  drawerOpen = false;
  els.sidebar.classList.remove("is-open");
  setOverlayInert(els.sidebar, true);
  els.menuBtn.setAttribute("aria-label", t("openMenu"));
  els.menuBtn.setAttribute("aria-expanded", "false");
  document.body.classList.remove("drawer-open");
  if (!isUtilityDrawerOpen()) {
    els.overlay.classList.remove("is-visible");
    window.setTimeout(() => {
      if (!drawerOpen && !isUtilityDrawerOpen()) els.overlay.hidden = true;
    }, 280);
  }
}

function toggleDrawer() {
  if (drawerOpen) closeDrawer();
  else openDrawer();
}

function ensureMap() {
  if (mapReady) {
    resizeMap();
    return;
  }
  initMap("map");
  mapReady = true;
  // Layout may still be settling after floating topbar grid fix.
  window.requestAnimationFrame(() => {
    resizeMap();
    window.setTimeout(() => resizeMap(), 120);
  });
}

async function goToMyLocation() {
  ensureMap();
  await locateUser({ fly: true });
}

function syncRouteChrome(route) {
  const onHub = route === "hub";
  const onBook = route === "home";
  const showPageTitle = !onHub && !onBook;

  if (els.viewTitle) {
    const key = ROUTE_TITLE_KEYS[route] || "navHome";
    els.viewTitle.textContent = t(key);
    els.viewTitle.hidden = !showPageTitle;
  }

  if (els.headerBrand) {
    els.headerBrand.hidden = !onHub;
  }

  if (els.headerBackBtn) {
    els.headerBackBtn.hidden = onHub;
  }

  if (els.headerSettingsBtn) {
    els.headerSettingsBtn.hidden = onBook;
  }

  document.querySelectorAll(".ep-bottom-nav__btn[data-route]").forEach((btn) => {
    const match = btn.dataset.route === route;
    btn.classList.toggle("is-active", match);
    if (match) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });

  document.querySelectorAll(".nav-item[data-route]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.route === route || (onHub && btn.dataset.route === "home"));
  });
}

function navigate(route) {
  if (!ROUTES.includes(route)) route = "hub";
  activeRoute = route;

  document.querySelectorAll(".screen").forEach((screen) => {
    const match = screen.dataset.screen === route;
    screen.classList.toggle("is-active", match);
    if (match) screen.removeAttribute("hidden");
    else screen.setAttribute("hidden", "");
  });

  const onBook = route === "home";
  const onHub = route === "hub";
  setSheetVisible(onBook);
  els.shell.classList.toggle("on-home", onBook);
  els.shell.classList.toggle("on-hub", onHub);

  syncRouteChrome(route);

  if (onBook) {
    requestAnimationFrame(() => {
      ensureMap();
      resizeMap();
    });
  }

  closeDrawer();
  closeUtilityDrawer();

  if (route === "history") {
    refreshRideHistory();
  }

  if (route === "rates") {
    void renderRateDetailsPage({ mode: "all" });
  }

  if (onHub) {
    customerHomeUi?.refreshLabels?.();
  }
}

function bookNow() {
  navigate("home");
  requestAnimationFrame(() => {
    expandSheet();
    openSearchCard();
    const pickup = document.getElementById("pickupInput");
    const dest = document.getElementById("destInput");
    if (!pickup?.value.trim()) pickup?.focus({ preventScroll: true });
    else dest?.focus({ preventScroll: true });
  });
}

function showToast(message) {
  let toast = document.getElementById("appToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "appToast";
    toast.className = "app-toast";
    document.getElementById("app")?.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

async function handleBookRide(state) {
  if (!state.pickup?.trim() || !state.destination?.trim()) {
    showToast(t("bookingNeedPickup"));
    return;
  }

  const user = getCurrentUser();
  if (!user || !isFirebaseConfigured()) {
    showToast(t("bookingNeedSignIn"));
    openAuthModal("signin");
    return;
  }

  try {
    const ride = await startRideRequest(state);
    // Success / payment toast only after a real canonical ride ID exists.
    if (ride?.id) {
      showToast(`${t("bookingCreated")} · ${paymentMethodLabel(getPaymentMethod())}`);
    }
  } catch (err) {
    console.warn("[SwiftGo] ride request", err);
    const code = String(err?.code || err?.message || "");
    if (code.includes("unauthenticated") || code.includes("NOT_SIGNED_IN")) {
      showToast(t("bookingNeedSignIn"));
      openAuthModal("signin");
      return;
    }
    if (code.includes("MAX_ACTIVE_BOOKINGS")) {
      showToast(t("bookingMaxActive"));
      return;
    }
    showToast(t("rideRequestFailed"));
  }
}

function updateProfileUi(user, profile) {
  if (user) {
    const name = profile?.displayName || user.displayName || user.email?.split("@")[0] || t("signedInAs");
    if (els.profileName) {
      els.profileName.removeAttribute("data-i18n");
      els.profileName.textContent = name;
    }
    if (els.profileSub) {
      els.profileSub.removeAttribute("data-i18n");
      els.profileSub.textContent = user.email || t("signedInAs");
    }
    if (els.signOutBtn) els.signOutBtn.hidden = false;
    if (els.settingsSignOutBtn) els.settingsSignOutBtn.hidden = false;
    setWalletBalanceUi(profile?.walletBalance ?? 0);
  } else {
    if (els.profileName) {
      els.profileName.setAttribute("data-i18n", "profileName");
      els.profileName.textContent = t("profileName");
    }
    if (els.profileSub) {
      els.profileSub.setAttribute("data-i18n", "profileSub");
      els.profileSub.textContent = t("profileSub");
    }
    if (els.signOutBtn) els.signOutBtn.hidden = true;
    if (els.settingsSignOutBtn) els.settingsSignOutBtn.hidden = true;
    setWalletBalanceUi(0);
    stopCustomerRideHistory();
  }
}

function bindUserData() {
  onUserChange((user) => {
    unsubProfile();
    unsubProfile = () => {};

    if (!user) {
      updateProfileUi(null, null);
      stopCustomerRideHistory();
      clearCustomerRideSession();
      return;
    }

    updateProfileUi(user, null);
    unsubProfile = watchUserProfile(user.uid, (profile) => {
      updateProfileUi(user, profile);
    });
    startCustomerRideHistory(user.uid);
    void resumeActiveRideWatch(user.uid);
  });
}

function wireEpNavigation() {
  els.headerBackBtn?.addEventListener("click", () => navigate("hub"));

  els.headerSettingsBtn?.addEventListener("click", () => navigate("settings"));

  els.bottomBookBtn?.addEventListener("click", () => bookNow());

  document.querySelectorAll(".ep-bottom-nav__btn[data-route]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const route = btn.dataset.route;
      if (route) navigate(route);
    });
  });

  els.viewport?.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-route]");
    if (!trigger || !els.viewport.contains(trigger)) return;
    if (trigger.closest(".ep-bottom-nav")) return;
    const route = trigger.dataset.route;
    if (route === "home") bookNow();
    else if (route) navigate(route);
  });

  els.settingsSignOutBtn?.addEventListener("click", () => {
    void logout();
  });
}

function bindEvents() {
  wireEpNavigation();
  els.menuBtn?.addEventListener("click", toggleDrawer);
  els.overlay.addEventListener("click", closeDrawer);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawerOpen) closeDrawer();
    if (e.key === "Escape") closePaySheet();
  });

  document.getElementById("profileTap")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!getCurrentUser()) openAuthModal("signin");
    }
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "fare-rates") {
        closeDrawer();
        navigate("rates");
        return;
      }
      const route = btn.dataset.route;
      if (route === "home") navigate("hub");
      else if (route) navigate(route);
    });
  });

  document.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const lang = btn.getAttribute("data-lang");
      if (lang === "en" || lang === "ur") {
        setLang(lang);
        syncLangButtons();
        refreshSheetLabels();
        refreshScreens();
        refreshDashboardLabels();
        refreshLocationLabels();
        refreshStepUiLabels();
        refreshUtilityDrawerLabels();
        refreshRideHistory();
        syncRouteChrome(activeRoute);
        customerHomeUi?.refreshLabels?.();
        const user = getCurrentUser();
        if (!user) {
          if (els.profileName) els.profileName.textContent = t("profileName");
          if (els.profileSub) els.profileSub.textContent = t("profileSub");
        }
        els.menuBtn.setAttribute(
          "aria-label",
          drawerOpen ? t("closeMenu") : t("openMenu")
        );
      }
    });
  });

  const locate = () => goToMyLocation();
  els.locateBtn?.addEventListener("click", locate);
  els.fabLocate?.addEventListener("click", locate);

  window.addEventListener("resize", () => {
    if (mapReady) resizeMap();
  });

  const sheet = document.getElementById("sheet");
  if (sheet) {
    const ro = new ResizeObserver(() => {
      if (mapReady) resizeMap();
    });
    ro.observe(sheet);
  }

  subscribe(() => {
    refreshSheetLabels();
    refreshScreens();
    refreshDashboardLabels();
    refreshLocationLabels();
    refreshStepUiLabels();
    refreshUtilityDrawerLabels();
    refreshRideHistory();
    syncRouteChrome(activeRoute);
    customerHomeUi?.refreshLabels?.();
  });
}

function wireTrustActions() {
  document.getElementById("complaintWhatsAppBtn")?.addEventListener("click", () => {
    const text = document.getElementById("complaintMessage")?.value?.trim() || "";
    window.open(complaintWhatsAppHref(`${t("complaintPrefill")}${text}`), "_blank", "noopener,noreferrer");
  });

  document.getElementById("complaintSubmitBtn")?.addEventListener("click", async () => {
    const status = document.getElementById("complaintStatus");
    const message = document.getElementById("complaintMessage")?.value?.trim() || "";
    if (!getCurrentUser()) {
      if (status) status.textContent = t("complaintNeedAuth");
      openAuthModal("signin");
      return;
    }
    if (message.length < 8) {
      if (status) status.textContent = t("complaintPlaceholder");
      return;
    }
    try {
      await submitSupportReportClient({ message, category: "complaint", appId: "customer" });
      if (status) status.textContent = t("complaintSent");
      const box = document.getElementById("complaintMessage");
      if (box) box.value = "";
    } catch (err) {
      console.warn("[SwiftGo] support report", err);
      if (status) status.textContent = t("complaintFailed");
    }
  });

  document.getElementById("deleteAccountBtn")?.addEventListener("click", async () => {
    const status = document.getElementById("deleteAccountStatus");
    if (!getCurrentUser()) {
      if (status) status.textContent = t("deleteAccountNeedAuth");
      openAuthModal("signin");
      return;
    }
    const ok = await askTrustConfirm({
      titleKey: "deleteAccountConfirmTitle",
      bodyKey: "deleteAccountConfirmBody",
      confirmKey: "deleteAccountCta",
      cancelKey: "trustConfirmCancel",
    });
    if (!ok) return;
    try {
      await requestAccountDeletionClient({ roleHint: "customer", appId: "customer" });
      if (status) status.textContent = t("deleteAccountDone");
      await logout();
    } catch (err) {
      console.warn("[SwiftGo] account deletion", err);
      if (status) status.textContent = t("deleteAccountFailed");
    }
  });
}

async function boot() {
  applyReducedMotionClass();
  initKeyboardInset();
  initI18n();
  initRateDetailsModal();
  wireLegalLinks();
  wireTrustActions();
  initUtilityDrawer({
    onToast: showToast,
    onNavClose: closeDrawer,
  });
  initSheet({ onBookRide: handleBookRide });
  initFareCalculation();
  initRideFlow({
    onToast: showToast,
    onReset: resetSheetForNewRide,
    onGoHome: () => {
      navigate("hub");
    },
  });
  initDriverTrack();
  initRideHistory({ onToast: showToast });
  customerHomeUi = initCustomerHome(document.getElementById("customerHomeRoot"), {
    onProfileTap: () => {
      if (!getCurrentUser()) openAuthModal("signin");
      else navigate("settings");
    },
  });
  initLocationModule({
    ensureMap,
    navigateHome: () => navigate("home"),
  });
  initRoutingUi();
  initStepUi();
  initScreens({ onBookNow: bookNow });
  initDashboard({
    onToast: showToast,
  });
  await initAuth();
  bindUserData();
  bindEvents();
  els.menuBtn?.setAttribute("aria-expanded", "false");
  els.shell.classList.add("on-hub");
  navigate("hub");
  closeDrawer();
  installCustomerE2EHooks();
  console.info(
    `[SwiftGo] Phase 17 live ride status ready · firebase=${isFirebaseConfigured()} · lang=${getLang()}`
  );
}

boot();

window.SwiftGo = {
  navigate,
  openDrawer,
  closeDrawer,
  setLang,
  getLang,
  t,
  applyTranslations,
  locateUser: goToMyLocation,
  resizeMap,
  bookNow,
  openAuthModal,
  getRouteInfo,
};
