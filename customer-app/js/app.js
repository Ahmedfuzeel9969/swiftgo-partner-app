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
import { initStepUi, refreshStepUiLabels } from "./step-ui.js";

import {
  initScreens,
  refreshScreens,
  setWalletBalanceUi,
} from "./screens.js";
import { initAuth, onUserChange, openAuthModal, getCurrentUser } from "./auth.js";
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
  initDriverOnboarding,
  refreshDriverOnboardingLabels,
} from "./driver-onboarding.js";
import {
  initUtilityDrawer,
  closeUtilityDrawer,
  refreshUtilityDrawerLabels,
  isUtilityDrawerOpen,
} from "./utility-drawer.js";
import { getRouteInfo, initRoutingUi } from "./routing.js";
import { initFareCalculation } from "./fare.js";
import { initRideFlow, startRideRequest } from "./ride-flow.js";
import { applyReducedMotionClass } from "./a11y.js";
import {
  initRideHistory,
  refreshRideHistory,
  startCustomerRideHistory,
  stopCustomerRideHistory,
} from "./history.js";

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
};

let drawerOpen = false;
let mapReady = false;
let unsubProfile = () => {};

function openDrawer() {
  closeUtilityDrawer();
  drawerOpen = true;
  els.sidebar.classList.add("is-open");
  els.sidebar.setAttribute("aria-hidden", "false");
  els.overlay.hidden = false;
  requestAnimationFrame(() => els.overlay.classList.add("is-visible"));
  els.menuBtn.setAttribute("aria-label", t("closeMenu"));
  els.menuBtn.setAttribute("aria-expanded", "true");
  document.body.classList.add("drawer-open");
}

function closeDrawer() {
  drawerOpen = false;
  els.sidebar.classList.remove("is-open");
  els.sidebar.setAttribute("aria-hidden", "true");
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

function navigate(route) {
  document.querySelectorAll(".screen").forEach((screen) => {
    const match = screen.dataset.screen === route;
    screen.classList.toggle("is-active", match);
    if (match) screen.removeAttribute("hidden");
    else screen.setAttribute("hidden", "");
  });

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.route === route);
  });

  const onHome = route === "home";
  setSheetVisible(onHome);
  els.shell.classList.toggle("on-home", onHome);

  if (onHome) {
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
}

function bookNow() {
  navigate("home");
  requestAnimationFrame(() => {
    expandSheet();
    document.getElementById("destInput")?.focus();
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
    await startRideRequest(state);
    showToast(`${t("bookingCreated")} · ${paymentMethodLabel(getPaymentMethod())}`);
  } catch (err) {
    console.warn("[SwiftGo] ride request", err);
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
      return;
    }

    updateProfileUi(user, null);
    unsubProfile = watchUserProfile(user.uid, (profile) => {
      updateProfileUi(user, profile);
    });
    startCustomerRideHistory(user.uid);
  });
}

function bindEvents() {
  els.menuBtn.addEventListener("click", toggleDrawer);
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
      const route = btn.dataset.route;
      if (route) navigate(route);
    });
  });

  document.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lang = btn.getAttribute("data-lang");
      if (lang === "en" || lang === "ur") {
        setLang(lang);
        syncLangButtons();
        refreshSheetLabels();
        refreshScreens();
        refreshDashboardLabels();
        refreshDriverOnboardingLabels();
        refreshLocationLabels();
        refreshUtilityDrawerLabels();
        refreshRideHistory();
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
    refreshDriverOnboardingLabels();
    refreshLocationLabels();
    refreshStepUiLabels();
    refreshUtilityDrawerLabels();
    refreshRideHistory();
  });
}

async function boot() {
  applyReducedMotionClass();
  initI18n();
  initDriverOnboarding({ onToast: showToast });
  initUtilityDrawer({
    onToast: showToast,
    onNavClose: closeDrawer,
  });
  initSheet({ onBookRide: handleBookRide });
  initFareCalculation();
  initRideFlow({
    onToast: showToast,
    onReset: resetSheetForNewRide,
  });
  initRideHistory();
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
  els.menuBtn.setAttribute("aria-expanded", "false");
  els.shell.classList.add("on-home");
  navigate("home");
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
