/**
 * Active-ride restore / completion reconciliation helpers (browser + testable).
 */

export const ACTIVE_RIDE_CACHE_KEY = "swiftgo_driver_active_ride_v1";

export const ACTIVE_EXECUTION_STATUSES = new Set(["accepted", "arrived", "in_progress"]);

export const TERMINAL_RIDE_STATUSES = new Set([
  "completed",
  "cancelled",
  "cancelled_by_user",
  "expired",
  "searching_driver",
]);

export const ACTIVE_RIDE_RECOVERY_URDU =
  "سرور پر آپ کی ایک فعال سواری موجود ہے، مگر گاڑی منسلک نہیں۔ پہلے PIN درج کریں؛ اگر مسئلہ برقرار رہے تو سپورٹ سے رابطہ کریں۔";

export function isActiveExecutionStatus(status) {
  return ACTIVE_EXECUTION_STATUSES.has(String(status || ""));
}

/**
 * @param {Record<string, unknown> | null | undefined} rideData
 * @param {string} driverUid
 */
export function validateRideForDriverRestore(rideData, driverUid) {
  if (!driverUid) return { ok: false, reason: "no_driver" };
  if (!rideData) return { ok: false, reason: "missing_doc" };
  if (String(rideData.driverId || "") !== String(driverUid)) {
    return { ok: false, reason: "wrong_driver" };
  }
  const status = String(rideData.status || "");
  if (!isActiveExecutionStatus(status)) {
    return { ok: false, reason: "terminal_or_inactive", status };
  }
  return { ok: true, status };
}

/**
 * @param {{ activeRideId?: string } | null | undefined} partner
 * @param {{ activeRideId?: string } | null | undefined} linkedVehicle
 * @param {{ rideId?: string } | null | undefined} cached
 */
export function collectActiveRideCandidateIds(partner, linkedVehicle, cached) {
  const ids = [];
  const seen = new Set();
  for (const raw of [partner?.activeRideId, linkedVehicle?.activeRideId, cached?.rideId]) {
    const id = String(raw || "").trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * @param {unknown} error
 */
export function classifySettlementFailure(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error?.details || "");
  const blob = `${code} ${message}`.toLowerCase();

  if (
    blob.includes("firebase_unavailable") ||
    blob.includes("functions/unavailable") ||
    blob.includes("network") ||
    blob.includes("failed to fetch")
  ) {
    return {
      category: "network",
      userMessageUrdu: "نیٹ ورک/سرور دستیاب نہیں — دوبارہ کوشش کریں (نیٹ ورک)",
    };
  }
  if (blob.includes("unauthenticated") || blob.includes("auth_required")) {
    return {
      category: "auth",
      userMessageUrdu: "لاگ اِن ختم ہو گیا — دوبارہ سائن اِن کریں (تصدیق)",
    };
  }
  if (
    blob.includes("permission-denied") ||
    blob.includes("not_assigned_driver") ||
    blob.includes("driver_blocked")
  ) {
    return {
      category: "permission",
      userMessageUrdu: "سواری مکمل کرنے کی اجازت نہیں — اکاؤنٹ/تفویض چیک کریں (اجازت)",
    };
  }
  if (blob.includes("ride_not_found") || blob.includes("not-found")) {
    return {
      category: "missing_ride",
      userMessageUrdu: "سواری سرور پر نہیں ملی — ریفریش کریں (غائب سواری)",
    };
  }
  if (
    blob.includes("invalid_status") ||
    blob.includes("already_completed") ||
    blob.includes("ride_cancelled") ||
    blob.includes("failed-precondition")
  ) {
    return {
      category: "invalid_state",
      userMessageUrdu: "سواری کی حالت مکمل کے لیے درست نہیں — ریفریش کریں (حالت)",
    };
  }
  if (blob.includes("invalid_fare") || blob.includes("invalid_argument")) {
    return {
      category: "invalid_fare",
      userMessageUrdu: "کرایہ درست نہیں — سپورٹ سے رابطہ کریں (کرایہ)",
    };
  }
  if (blob.includes("vehicle_not_linked") || blob.includes("no_driver")) {
    return {
      category: "vehicle_link",
      userMessageUrdu: "گاڑی منسلک نہیں — پہلے PIN درج کریں (گاڑی لنک)",
    };
  }
  return {
    category: "unknown",
    userMessageUrdu: "سواری مکمل نہیں ہو سکی — دوبارہ کوشش کریں (نامعلوم)",
  };
}

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

export function persistActiveRideCache(rideId, collectionName = "rides", storage = null) {
  const store = resolveStorage(storage);
  if (!store || !rideId) return;
  try {
    store.setItem(
      ACTIVE_RIDE_CACHE_KEY,
      JSON.stringify({ rideId, collectionName: collectionName || "rides" })
    );
  } catch {
    /* ignore quota / private mode */
  }
}

export function readActiveRideCache(storage = null) {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(ACTIVE_RIDE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.rideId) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

export function clearActiveRideCache(storage = null) {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(ACTIVE_RIDE_CACHE_KEY);
  } catch {
    /* ignore */
  }
}
