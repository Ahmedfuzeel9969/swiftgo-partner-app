/**
 * Phase 22 — Super Admin Command Center skeleton.
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
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const els = {
  loginBtn: document.getElementById("adminGoogleLoginBtn"),
  status: document.getElementById("adminAuthStatus"),
};

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

function setStatus(message = "") {
  if (els.status) els.status.textContent = message;
}

function setBusy(busy) {
  if (!els.loginBtn) return;
  els.loginBtn.disabled = busy;
  const label = els.loginBtn.querySelector("span");
  if (label) label.textContent = busy ? "Signing in..." : "Login via Google";
}

async function signInWithGoogle() {
  const { auth } = getFirebase();
  if (!auth) {
    setStatus("Firebase is not configured.");
    return;
  }

  setBusy(true);
  setStatus("");
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

function boot() {
  const firebase = getFirebase();
  els.loginBtn?.addEventListener("click", signInWithGoogle);

  if (!firebase.auth) {
    setStatus("Firebase is not configured.");
    return;
  }

  getRedirectResult(firebase.auth).catch((error) => {
    console.warn("[SwiftGo Admin] Google redirect", error);
    setStatus("Google redirect sign-in failed.");
  });

  onAuthStateChanged(firebase.auth, (user) => {
    setBusy(false);
    if (user) {
      setStatus(`Signed in as ${user.email || user.displayName || "admin"}`);
      return;
    }
    setStatus("");
  });

  console.info(
    `[SwiftGo Admin] Phase 22 skeleton ready · project=${firebaseConfig.projectId} · firebase=${
      isFirebaseConfigured() && firebase.ready
    }`
  );
}

boot();
