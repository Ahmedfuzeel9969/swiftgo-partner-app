/**
 * Phase 2B/2C — link vehicle via trusted PIN callable.
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";

async function callPin(name, data) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  const fn = httpsCallable(functions, name);
  const result = await fn(data);
  return result?.data || result;
}

export async function linkVehicleByPinClient(pin) {
  return callPin("linkVehicleByPin", { pin: String(pin || "").trim() });
}

export async function releaseVehicleDriverClient(vehicleId) {
  return callPin("releaseVehicleDriver", { vehicleId: String(vehicleId || "").trim() });
}

export async function rotateVehiclePinClient(vehicleId) {
  return callPin("rotateVehiclePin", { vehicleId: String(vehicleId || "").trim() });
}
