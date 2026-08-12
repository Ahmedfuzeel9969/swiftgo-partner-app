/** Auto-wrapper: canonical implementation in shared/js. */
export { createP2pIceBootstrap } from "../../shared/js/p2p-ice-bootstrap.mjs";

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { createP2pIceBootstrap } from "../../shared/js/p2p-ice-bootstrap.mjs";
import { getFirebase } from "./firebase.js";

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
