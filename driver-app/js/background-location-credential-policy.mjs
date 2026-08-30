/** Pure validation shared by the native bridge and its tests. */
export const DEFAULT_UPLOAD_BASE = "https://us-central1-swiftgo-ride-app.cloudfunctions.net";
export function resolveUploadUrl(explicit) {
  const expected = DEFAULT_UPLOAD_BASE + "/ingestBackgroundDriverLocation";
  if (!explicit) return expected;
  if (String(explicit) !== expected) throw new Error("UNTRUSTED_NATIVE_ENDPOINT");
  return expected;
}
export function resolveRefreshUrl(uploadUrl, explicit) {
  resolveUploadUrl(uploadUrl);
  const expected = DEFAULT_UPLOAD_BASE + "/refreshBackgroundDriverLocationCredential";
  if (explicit && String(explicit) !== expected) throw new Error("UNTRUSTED_NATIVE_ENDPOINT");
  return expected;
}
export function credentialCacheMatches(cached, binding, now, skewMs = 60_000) {
  if (!cached?.token || !Number.isFinite(Number(cached.expiresAtMs)) ||
      Number(cached.expiresAtMs) <= now + skewMs) return false;
  return ["rideId", "vehicleId", "trackingSessionId", "assignmentSessionToken", "driverUid"]
    .every(key => Boolean(binding?.[key]) && cached[key] === binding[key]);
}
export function normalizeNativeBinding(binding) {
  const b = {};
  for (const key of ["rideId", "vehicleId", "trackingSessionId", "assignmentSessionToken", "driverUid"]) {
    b[key] = String(binding?.[key] || "").trim();
    if (!b[key] || b[key].length > 256) throw new Error("INVALID_BINDING");
  }
  b.rideStatus = String(binding.rideStatus || binding.status || "");
  if (!["accepted", "arrived", "in_progress"].includes(b.rideStatus)) throw new Error("INACTIVE_RIDE");
  b.intervalMs = Math.min(60_000, Math.max(2000, Number(binding.intervalMs) || 4000));
  b.lastSequence = Math.max(0, Math.min(2147483646, Math.floor(Number(binding.lastSequence) || 0)));
  b.assignmentVersion = Math.max(0, Math.floor(Number(binding.assignmentVersion) || 0));
  b.p2pFallbackAfterMs = Math.min(60_000, Math.max(5_000, Number(binding.p2pFallbackAfterMs) || 12_000));
  b.firebaseWriteIntervalMs = Math.min(60_000, Math.max(2_000, Number(binding.firebaseWriteIntervalMs) || 4_000));
  b.firebaseFallbackEnabled = binding.firebaseFallbackEnabled === true;
  return b;
}
