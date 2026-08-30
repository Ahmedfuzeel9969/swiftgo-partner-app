/**
 * App ICE bootstrap — Firebase callable + hosting-safe local core import.
 * Hosting overlays ./p2p-ice-bootstrap-core.mjs from shared; this wrapper stays.
 */
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { createP2pIceBootstrap } from "./p2p-ice-bootstrap-core.mjs";
import { getFirebase } from "./firebase.js";

export { createP2pIceBootstrap } from "./p2p-ice-bootstrap-core.mjs";

async function fetchTurnCredentials(context = {}) {
  const { ready, functions, auth } = getFirebase();
  if (!ready || !functions || !auth?.currentUser) {
    return { configured: false, reason: "NOT_SIGNED_IN" };
  }
  if (!context.rideId || !context.assignmentId) return { configured: false, reason: "RIDE_REQUIRED" };
  const res = await httpsCallable(functions, "getP2pTurnCredentials", { timeout: 8000 })(context);
  return res?.data || res || { configured: false };
}

const bootstrap = createP2pIceBootstrap({ fetchTurnCredentials,
  getContextKey: (context) => JSON.stringify([getFirebase().auth?.currentUser?.uid || "", context.rideId || "", context.assignmentId || ""]),
});

let boundAuth = null, lastUid = "", unwatchAuth = () => {};
export const ensureP2pIceConfiguration = (context) => {
  const auth = getFirebase().auth;
  if (auth && auth !== boundAuth) {
    unwatchAuth(); boundAuth = auth; lastUid = auth.currentUser?.uid || "";
    unwatchAuth = onAuthStateChanged(auth, (user) => {
      const uid = user?.uid || "";
      if (uid !== lastUid) { lastUid = uid; bootstrap.resetP2pIceBootstrapCache(); }
    });
  }
  return bootstrap.ensureP2pIceConfiguration(context);
};
export const resetP2pIceBootstrapCache = () => bootstrap.resetP2pIceBootstrapCache();
