import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

/**
 * Initialized eagerly when config is present; null in demo mode.
 * Exported so any module can `import { app, auth, db, storage } from "./firebase.js"`.
 */
let app = null;
let auth = null;
let db = null;
let storage = null;

if (isFirebaseConfigured()) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
}

export { app, auth, db, storage, isFirebaseConfigured };

/** Legacy accessor used across the app. */
export function getFirebase() {
  if (!isFirebaseConfigured()) {
    return { ready: false, app: null, auth: null, db: null, storage: null };
  }
  return { ready: true, app, auth, db, storage };
}
