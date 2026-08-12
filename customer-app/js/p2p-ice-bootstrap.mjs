/**
 * App ICE bootstrap — Firebase callable + hosting-safe local core import.
 * Hosting overlays ./p2p-ice-bootstrap-core.mjs from shared; this wrapper stays.
 */
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { createP2pIceBootstrap } from "./p2p-ice-bootstrap-core.mjs";
import { getFirebase } from "./firebase.js";

export { createP2pIceBootstrap } from "./p2p-ice-bootstrap-core.mjs";

async function fetchTurnCredentials() {
  const { ready, functions, auth } = getFirebase();
  if (!ready || !functions || !auth?.currentUser) {
    return { configured: false, reason: "NOT_SIGNED_IN" };
  }
  const res = await httpsCallable(functions, "getP2pTurnCredentials")({});
  return res?.data || res || { configured: false };
}

const bootstrap = createP2pIceBootstrap({ fetchTurnCredentials });

export const ensureP2pIceConfiguration = () => bootstrap.ensureP2pIceConfiguration();
export const resetP2pIceBootstrapCache = () => bootstrap.resetP2pIceBootstrapCache();
