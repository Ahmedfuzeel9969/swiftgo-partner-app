/**
 * Trusted go-online callable — Admin SDK writes GPS + session fields.
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";

export async function setDriverOnlineLocationClient(payload) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  const fn = httpsCallable(functions, "setDriverOnlineLocation");
  try {
    const result = await fn({
      vehicleId: String(payload?.vehicleId || "").trim(),
      lat: Number(payload?.lat),
      lng: Number(payload?.lng),
      trackingSessionId: String(payload?.trackingSessionId || "").trim(),
      driverName: payload?.driverName ? String(payload.driverName) : undefined,
      observedAt: payload?.observedAt,
      sequence: payload?.sequence,
      source: payload?.source,
    });
    return result?.data || result;
  } catch (error) {
    console.warn("[SwiftGo] setDriverOnlineLocation callable error", {
      code: error?.code,
      message: error?.message,
    });
    throw error;
  }
}
