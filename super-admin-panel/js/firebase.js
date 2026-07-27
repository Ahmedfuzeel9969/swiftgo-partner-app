import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getStorage,
  connectStorageEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { firebaseConfig as prodConfig, isFirebaseConfigured as isProdConfigured } from "./firebase-config.js";

const EMULATOR_PROJECT = "demo-swiftgo-phase1";

export function shouldUseEmulators() {
  if (typeof location === "undefined") return false;
  const host = location.hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return false;
  if (typeof window !== "undefined" && window.__SWIFTGO_WANT_EMULATORS__ === true) return true;
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("emulators") === "1") {
      try {
        localStorage.setItem("swiftgo_use_emulators", "1");
      } catch {
        /* ignore quota / privacy mode */
      }
      return true;
    }
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem("swiftgo_use_emulators") === "1";
  } catch {
    return false;
  }
}

const useEmulators = shouldUseEmulators();

const firebaseConfig = useEmulators
  ? {
      apiKey: "demo-api-key",
      authDomain: `${EMULATOR_PROJECT}.firebaseapp.com`,
      projectId: EMULATOR_PROJECT,
      storageBucket: `${EMULATOR_PROJECT}.appspot.com`,
      messagingSenderId: "123456789012",
      appId: "1:123456789012:web:phase2e-admin",
    }
  : prodConfig;

export function isFirebaseConfigured() {
  return useEmulators || isProdConfigured();
}

let app = null;
let auth = null;
let db = null;
let storage = null;

if (isFirebaseConfigured()) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  const host = typeof location !== "undefined" ? location.hostname : "";
  if (useEmulators && (host === "localhost" || host === "127.0.0.1")) {
    if (typeof window !== "undefined") {
      window.__SWIFTGO_EMULATORS__ = true;
      window.__SWIFTGO_E2E__ = window.__SWIFTGO_E2E__ || {};
      window.__SWIFTGO_E2E__.projectId = EMULATOR_PROJECT;
      window.__SWIFTGO_E2E__.auth = auth;
      window.__SWIFTGO_E2E__.db = db;
    }
    try {
      connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    } catch (e) {
      console.warn("[SwiftGo Admin] auth emulator", e);
    }
    try {
      connectFirestoreEmulator(db, "127.0.0.1", 8080);
    } catch (e) {
      console.warn("[SwiftGo Admin] firestore emulator", e);
    }
    try {
      connectStorageEmulator(storage, "127.0.0.1", 9199);
    } catch (e) {
      console.warn("[SwiftGo Admin] storage emulator", e);
    }
  }
}

export { app, auth, db, storage, useEmulators };

export function getFirebase() {
  if (!isFirebaseConfigured()) {
    return { ready: false, app: null, auth: null, db: null, storage: null };
  }
  return { ready: true, app, auth, db, storage };
}
