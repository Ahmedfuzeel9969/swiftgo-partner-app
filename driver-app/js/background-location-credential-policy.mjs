/**
 * Pure credential cache / URL helpers for native background location.
 * No Capacitor or window dependencies — safe for Node tests.
 */

const DEFAULT_UPLOAD_BASE = "https://us-central1-swiftgo-ride-app.cloudfunctions.net";

/** @param {string} uploadUrl @param {string} [explicit] */
export function resolveRefreshUrl(uploadUrl, explicit) {
  const raw = String(explicit || "").trim();
  if (raw) return raw;
  const upload = String(uploadUrl || `${DEFAULT_UPLOAD_BASE}/ingestBackgroundDriverLocation`).trim();
  if (upload.includes("ingestBackgroundDriverLocation")) {
    return upload.replace(
      "ingestBackgroundDriverLocation",
      "refreshBackgroundDriverLocationCredential"
    );
  }
  return `${DEFAULT_UPLOAD_BASE}/refreshBackgroundDriverLocationCredential`;
}

/**
 * @param {object|null|undefined} cached
 * @param {object} binding
 * @param {number} now
 * @param {number} [skewMs]
 */
export function credentialCacheMatches(cached, binding, now, skewMs = 60_000) {
  if (!cached?.token || Number(cached.expiresAtMs) <= now + skewMs) return false;
  if (cached.rideId !== binding.rideId) return false;
  if (cached.trackingSessionId !== binding.trackingSessionId) return false;
  if (cached.vehicleId !== binding.vehicleId) return false;
  if (cached.assignmentSessionToken !== binding.assignmentSessionToken) return false;
  if (binding.driverUid && cached.driverUid !== binding.driverUid) return false;
  return true;
}

export { DEFAULT_UPLOAD_BASE };
