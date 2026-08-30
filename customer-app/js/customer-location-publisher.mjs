import { rideLocationAssignmentVersion, validateRideLocationFix } from "../../shared/js/ride-location-contract.mjs";
import { normalizeRuntimeDeliveryPolicy, resolveLocationDeliveryPolicy } from "../../shared/js/location-delivery-policy.mjs";

/** One consented GPS watch, latest-only buffering, P2P first, bounded Firebase fallback. */
export function createCustomerLocationPublisher(opts = {}) {
  const nowMs = opts.nowMs || Date.now;
  const setTimer = opts.setIntervalFn || setInterval;
  const clearTimer = opts.clearIntervalFn || clearInterval;
  let generation = 0, watchId = null, timer = null, binding = null;
  let deniedIdentity = "";
  let latest = null, sequence = 0, startedAt = 0, lastAttempt = null, lastPublished = 0, pending = false;
  // Do not publish until the application has obtained the super-admin policy.
  let policy = { ...resolveLocationDeliveryPolicy(), firebaseFallbackEnabled: false };
  const geo = () => opts.geolocation || globalThis.navigator?.geolocation;
  const status = (reason) => opts.onStatus?.(reason); // No coordinates or identifiers in diagnostics.

  function stop() {
    generation += 1;
    if (watchId != null) geo()?.clearWatch(watchId);
    if (timer != null) clearTimer(timer);
    watchId = timer = null;
    binding = latest = null;
    sequence = 0; lastAttempt = null; lastPublished = 0; pending = false;
  }

  async function tick() {
    if (!binding || !latest || pending || !policy.firebaseFallbackEnabled) return;
    if (opts.isP2pHealthy?.() === true) return;
    const now = nowMs();
    if (now - startedAt < policy.p2pFirstGraceMs) return;
    if (lastAttempt != null && now - lastAttempt < policy.firebaseWriteIntervalMs) return;
    if (latest.observedAt <= lastPublished || !validateRideLocationFix(latest, { nowMs: now }).ok) return;
    const gen = generation, target = binding, fix = latest;
    pending = true; lastAttempt = now;
    try {
      const result = await opts.publishFallback?.({ rideId: target.rideId, assignmentSessionToken: target.assignmentId, location: fix });
      if (gen !== generation) return;
      if (result?.ok) { lastPublished = fix.observedAt; status("firebase_acknowledged"); }
      else status(result?.reason || "firebase_not_accepted");
    } catch { if (gen === generation) status("firebase_failed"); }
    finally { if (gen === generation) pending = false; }
  }

  async function syncForRide(ride) {
    const active = ride?.id && ride?.driverId && ride?.vehicleId && ride?.assignmentSessionToken &&
      ["accepted", "arrived", "in_progress"].includes(ride.status);
    if (!active) { stop(); return; }
    // The key includes the server-minted assignment identity,
    // not status, so accepted -> arrived -> in_progress keeps one watch.
    const identity = `${ride.id}|${ride.driverId}|${ride.vehicleId}|${ride.assignmentSessionToken}`;
    if (deniedIdentity === identity) return;
    if (binding?.identity === identity) return;
    stop();
    const gen = generation;
    const randomId = opts.createSessionId?.() || globalThis.crypto?.randomUUID?.();
    if (!randomId || !geo()) { status("gps_unavailable"); return; }
    binding = { identity, rideId: ride.id, assignmentId: ride.assignmentSessionToken,
      assignmentVersion: rideLocationAssignmentVersion(ride), trackingSessionId: `cu_${randomId}` };
    startedAt = nowMs();
    try {
      if (opts.ensurePermission && !(await opts.ensurePermission())) {
        if (gen === generation) { deniedIdentity = identity; stop(); status("permission_denied"); }
        return;
      }
      if (gen !== generation) return;
      watchId = geo().watchPosition((position) => {
        if (gen !== generation || !binding) return;
        const coords = position?.coords || {};
        const checked = validateRideLocationFix({
          lat: coords.latitude, lng: coords.longitude, observedAt: position.timestamp,
          accuracyM: coords.accuracy, headingDeg: coords.heading, speedMps: coords.speed,
          sequence: sequence + 1, role: "customer", ...binding,
        }, { nowMs: nowMs(), previous: latest });
        if (!checked.ok) { status(checked.reason); return; }
        sequence += 1; latest = checked.fix;
        opts.onP2pFix?.(latest);
        void tick();
      }, (error) => {
        if (gen !== generation) return;
        if (error?.code === 1) { deniedIdentity = identity; stop(); status("permission_denied"); }
        else status("gps_temporarily_unavailable");
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
      timer = setTimer(() => void tick(), 1_000);
    } catch { if (gen === generation) { stop(); status("gps_unavailable"); } }
  }

  return {
    syncForRide, stop, tick,
    configureDeliveryPolicy(next = {}) {
      policy = normalizeRuntimeDeliveryPolicy(next, policy);
    },
    getState: () => ({ active: Boolean(binding), watching: watchId != null, pending, generation }),
  };
}
