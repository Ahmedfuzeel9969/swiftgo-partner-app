/**
 * Phase 2B/2C — link vehicle via trusted PIN callable.
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";

export async function linkVehicleByPinClient(pin) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  const fn = httpsCallable(functions, "linkVehicleByPin");
  const result = await fn({ pin: String(pin || "").trim() });
  return result?.data || result;
}
