import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth, isFirebaseConfigured } from "./firebase.js";
import { ensureUserProfile } from "./data.js";
import { t, applyTranslations } from "./i18n.js";
import { trapFocus } from "./a11y.js";

/** @type {import('firebase/auth').User | null} */
let currentUser = null;
const listeners = new Set();
const provider = new GoogleAuthProvider();
/** @type {null | (() => void)} */
let releaseAuthTrap = null;

export function getCurrentUser() {
  return currentUser;
}

export function onUserChange(fn) {
  listeners.add(fn);
  fn(currentUser);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach((fn) => fn(currentUser));
}

export function openAuthModal(mode = "signin") {
  const modal = document.getElementById("authModal");
  if (!modal) return;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add("is-open"));
  setAuthMode(mode);
  releaseAuthTrap?.();
  const card = modal.querySelector(".auth-modal__card") || modal;
  releaseAuthTrap = trapFocus(card, {
    dismissible: true,
    onDismiss: () => closeAuthModal(),
    initialFocus: document.getElementById("authEmail") || document.getElementById("googleSignInBtn"),
  });
}

export function closeAuthModal() {
  const modal = document.getElementById("authModal");
  if (!modal) return;
  releaseAuthTrap?.();
  releaseAuthTrap = null;
  modal.classList.remove("is-open");
  window.setTimeout(() => {
    modal.hidden = true;
  }, 220);
  clearAuthError();
}

function setAuthMode(mode) {
  const form = document.getElementById("authForm");
  const title = document.getElementById("authTitle");
  const submit = document.getElementById("authSubmit");
  const toggle = document.getElementById("authToggleMode");
  const nameWrap = document.getElementById("authNameWrap");
  if (!form) return;

  form.dataset.mode = mode;
  const isSignUp = mode === "signup";
  if (nameWrap) nameWrap.hidden = !isSignUp;
  if (title) title.textContent = isSignUp ? t("authSignUp") : t("authSignIn");
  if (submit) submit.textContent = isSignUp ? t("authCreate") : t("authSignIn");
  if (toggle) {
    toggle.textContent = isSignUp ? t("authHaveAccount") : t("authNeedAccount");
  }
}

function clearAuthError() {
  const err = document.getElementById("authError");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
}

function showAuthError(message) {
  const err = document.getElementById("authError");
  if (!err) return;
  err.hidden = false;
  err.textContent = message;
}

function mapAuthError(code) {
  const keys = {
    "auth/invalid-email": "errInvalidEmail",
    "auth/user-not-found": "errUserNotFound",
    "auth/wrong-password": "errWrongPassword",
    "auth/invalid-credential": "errWrongPassword",
    "auth/email-already-in-use": "errEmailInUse",
    "auth/weak-password": "errWeakPassword",
    "auth/too-many-requests": "errTooMany",
    "auth/operation-not-allowed": "errGoogleDisabled",
    "auth/admin-restricted-operation": "errGoogleDisabled",
    "auth/popup-closed-by-user": "errGooglePopupClosed",
    "auth/cancelled-popup-request": "errGooglePopupClosed",
    "auth/popup-blocked": "errGooglePopupBlocked",
    "auth/unauthorized-domain": "errUnauthorizedDomain",
    "auth/configuration-not-found": "errAuthNotConfigured",
    "auth/account-exists-with-different-credential": "errAccountExistsDifferent",
    "auth/network-request-failed": "errAuthNetwork",
    "auth/internal-error": "errAuthGeneric",
  };
  return t(keys[code] || "errAuthGeneric");
}

async function finishSignedIn(user, extra = {}) {
  try {
    await ensureUserProfile(user, {
      displayName: extra.displayName || user.displayName || user.email?.split("@")[0] || "User",
    });
  } catch (e) {
    console.warn("[SwiftGo] profile sync failed", e);
  }
  closeAuthModal();
}

/**
 * Google sign-in is popup-first on every device. Redirect is used only when
 * the browser blocks the popup or Firebase cancels a competing popup request.
 */
async function signInWithGoogle() {
  if (!auth) {
    throw Object.assign(new Error("Firebase Auth is not initialized"), {
      code: "auth/internal-error",
    });
  }

  try {
    return await signInWithPopup(auth, provider);
  } catch (error) {
    console.error("Firebase Auth Error:", error?.code, error?.message, error);

    if (error?.code === "auth/popup-blocked" || error?.code === "auth/cancelled-popup-request") {
      await signInWithRedirect(auth, provider);
      return null;
    }

    throw error;
  }
}

export async function initAuth() {
  applyTranslations(document.getElementById("authModal") || document);

  const demoBanner = document.getElementById("firebaseDemoBanner");
  if (!isFirebaseConfigured()) {
    if (demoBanner) demoBanner.hidden = false;
    currentUser = null;
    notify();
    bindAuthUi();
    return;
  }

  if (demoBanner) demoBanner.hidden = true;

  if (!auth) {
    console.error(
      "Firebase Auth Error:",
      "auth/internal-error",
      "Firebase Auth instance was not initialized."
    );
    bindAuthUi();
    return;
  }

  // Complete Google redirect return (if any) before UI binds.
  try {
    const redirectCred = await getRedirectResult(auth);
    if (redirectCred?.user) {
      await finishSignedIn(redirectCred.user);
    }
  } catch (error) {
    console.error("Firebase Auth Error:", error?.code, error?.message, error);
    openAuthModal("signin");
    showAuthError(mapAuthError(error?.code));
  }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      try {
        await ensureUserProfile(user);
      } catch (e) {
        console.warn("[SwiftGo] profile sync failed", e);
      }
    }
    notify();
  });

  bindAuthUi();
}

function bindAuthUi() {
  document.getElementById("authClose")?.addEventListener("click", closeAuthModal);
  document.getElementById("authBackdrop")?.addEventListener("click", closeAuthModal);

  document.getElementById("authToggleMode")?.addEventListener("click", () => {
    const form = document.getElementById("authForm");
    const next = form?.dataset.mode === "signup" ? "signin" : "signup";
    setAuthMode(next);
    clearAuthError();
  });

  document.getElementById("googleSignInBtn")?.addEventListener("click", async () => {
    clearAuthError();

    if (!isFirebaseConfigured()) {
      showAuthError(t("errFirebaseConfig"));
      return;
    }

    const btn = document.getElementById("googleSignInBtn");
    if (btn) btn.disabled = true;

    try {
      const cred = await signInWithGoogle();
      if (cred?.user) await finishSignedIn(cred.user);
    } catch (error) {
      console.error("Firebase Auth Error:", error?.code, error?.message, error);
      showAuthError(mapAuthError(error?.code));
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("authForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAuthError();

    if (!isFirebaseConfigured()) {
      showAuthError(t("errFirebaseConfig"));
      return;
    }

    const mode = e.target.dataset.mode || "signin";
    const email = document.getElementById("authEmail")?.value.trim() || "";
    const password = document.getElementById("authPassword")?.value || "";
    const name = document.getElementById("authName")?.value.trim() || "";

    const submit = document.getElementById("authSubmit");
    if (submit) submit.disabled = true;

    try {
      if (mode === "signup") {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        if (name) await updateProfile(cred.user, { displayName: name });
        await finishSignedIn(cred.user, { displayName: name || email.split("@")[0] });
      } else {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        await finishSignedIn(cred.user);
      }
    } catch (err) {
      if (err?.code === "auth/operation-not-allowed" || err?.code === "auth/admin-restricted-operation") {
        showAuthError(t("errAuthDisabled"));
      } else {
        showAuthError(mapAuthError(err?.code));
      }
      console.warn("[SwiftGo] auth error", err);
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  document.getElementById("signOutBtn")?.addEventListener("click", async () => {
    if (!isFirebaseConfigured()) return;
    await signOut(auth);
  });

  document.getElementById("profileTap")?.addEventListener("click", () => {
    if (currentUser) return;
    openAuthModal("signin");
  });
}

export async function logout() {
  if (!isFirebaseConfigured()) return;
  await signOut(auth);
}
