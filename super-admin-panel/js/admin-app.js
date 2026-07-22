/**
 * Phase 27 — Super Admin strict access + dashboard shell.
 * Independent Firebase bootstrap; no customer/partner imports.
 */

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

/** Sole authorized Super Admin email (case-insensitive). */
const SUPER_ADMIN_EMAIL = "fuzail1158@gmail.com";

const VIEW_TITLES = {
  dashboard: "ڈیش بورڈ",
  approvals: "ڈرائیورز کی منظوری",
  users: "صارفین اور گاڑیاں",
  finance: "مالی کنٹرول",
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
};

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

let denyingUnauthorized = false;

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

function isAuthorizedAdmin(user) {
  const email = (user?.email || "").trim().toLowerCase();
  return email === SUPER_ADMIN_EMAIL;
}

function showLogin() {
  if (els.loginScreen) els.loginScreen.hidden = false;
  if (els.dashboard) els.dashboard.hidden = true;
}

function showDashboard(user) {
  if (els.loginScreen) els.loginScreen.hidden = true;
  if (els.dashboard) els.dashboard.hidden = false;
  hideAccessDenied();

  if (els.displayName) {
    els.displayName.textContent = user.displayName || "Super Admin";
  }
  if (els.displayEmail) {
    els.displayEmail.textContent = user.email || SUPER_ADMIN_EMAIL;
  }
}

async function denyAndSignOut(auth) {
  denyingUnauthorized = true;
  showLogin();
  showAccessDenied();
  setStatus("Access Denied: You are not authorized as a Super Admin.");
  try {
    await signOut(auth);
  } catch (error) {
    console.warn("[SwiftGo Admin] Forced sign-out failed", error);
  } finally {
    denyingUnauthorized = false;
    setBusy(false);
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
  try {
    await signOut(auth);
  } catch (error) {
    console.warn("[SwiftGo Admin] Logout failed", error);
    setBusy(false);
  }
}

function setActiveView(viewKey) {
  const key = VIEW_TITLES[viewKey] ? viewKey : "dashboard";

  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === key);
  });

  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const match = panel.dataset.viewPanel === key;
    panel.hidden = !match;
    panel.classList.toggle("is-active", match);
  });

  if (els.viewTitle) els.viewTitle.textContent = VIEW_TITLES[key];
  if (els.content) els.content.dataset.activeView = key;
}

function wireNavigation() {
  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setActiveView(btn.dataset.view));
  });
}

function boot() {
  const firebase = getFirebase();
  showLogin();
  wireNavigation();
  setActiveView("dashboard");

  els.loginBtn?.addEventListener("click", signInWithGoogle);
  els.logoutBtn?.addEventListener("click", handleLogout);
  els.accessDeniedDismiss?.addEventListener("click", hideAccessDenied);

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
      showLogin();
      return;
    }

    if (!isAuthorizedAdmin(user)) {
      await denyAndSignOut(firebase.auth);
      return;
    }

    showDashboard(user);
    setStatus("");
  });

  console.info(
    `[SwiftGo Admin] Phase 27 ready · project=${firebaseConfig.projectId} · firebase=${
      isFirebaseConfigured() && firebase.ready
    }`
  );
}

boot();
