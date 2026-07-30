/**
 * Phase 2B — link vehicle via trusted PIN callable (rate-limited server-side).
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";

export async function linkVehicleByPinClient(pin) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  const fn = httpsCallable(functions, "linkVehicleByPin");
  try {
    const result = await fn({ pin: String(pin || "").trim() });
    return result?.data || result;
  } catch (error) {
    console.warn("[SwiftGo] linkVehicleByPin callable error", {
      code: error?.code,
      message: error?.message,
      details: error?.details,
    });
    throw error;
  }
}
