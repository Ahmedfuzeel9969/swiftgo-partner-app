/**
 * A bounded process-priority lease, NOT a native WebRTC engine.
 * No Firebase listeners or policy changes. WebView death expires the lease.
 */
import { getNativePlatform, getNativePlugin, newNativeSessionId } from "../../shared/js/native-bridge.mjs";
import { resolveIceConfiguration } from "./p2p-protocol.mjs";
const SIGNAL_URL = "https://us-central1-swiftgo-ride-app.cloudfunctions.net/nativeRidePeerTransport";
export function createCustomerP2pBackgroundKeepalive(opts = {}) {
  const getPlugin = opts.getPlugin || (() => getNativePlatform() === "android" ? getNativePlugin("CustomerP2pKeepAlive") : null);
  const now = opts.nowMs || Date.now;
  const setTimer = opts.setInterval || setInterval, clearTimer = opts.clearInterval || clearInterval;
  let epoch = 0, started = false, timer = null, operations = Promise.resolve(), listener = null, credential = null, activeKey = "";
  const serial = fn => { const r = operations.then(fn); operations = r.catch(() => {}); return r; };
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; started = false; };
  async function stop() {
    ++epoch; clear(); activeKey = ""; credential = null;
    const oldListener = listener; listener = null;
    const stopping = Promise.resolve().then(async () => { await oldListener?.remove?.(); return getPlugin()?.stop?.(); });
    stopping.catch(() => {});
    return serial(async () => {
      try { await stopping; return { ok: true }; }
      catch { return { ok: false, reason: "native_stop_failed" }; }
    });
  }
  async function syncForRide(ride, policy = {}) {
    policy = opts.getPolicy?.() || policy || {};
    const rideId = String(ride?.id || "").trim(), rideStatus = String(ride?.status || "");
    if (!rideId || !["accepted", "arrived", "in_progress"].includes(rideStatus)) return stop();
    const plugin = getPlugin();
    if (!plugin?.start) return { ok: false, reason: "plugin_unavailable" };
    if (!ride?.vehicleId || !ride?.driverId || !ride?.assignmentSessionToken) return stop();
    const nextKey = [rideId, ride.assignmentSessionToken, Number(policy.p2pFallbackAfterMs) || 12_000,
      Number(policy.firebaseWriteIntervalMs) || 4_000, policy.firebaseFallbackEnabled === true].join("|");
    if (started && activeKey === nextKey) return { ok: true, reused: true };
    const id = ++epoch, bridgeSessionId = (opts.newSessionId || newNativeSessionId)();
    const customerTrackingSessionId = `cu_native_${bridgeSessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(-40)}`;
    const previousListener = listener, wasStarted = started; listener = null;
    clear();
    return serial(async () => {
      if (id !== epoch) return { ok: false, reason: "superseded" };
      try {
        try { await previousListener?.remove?.(); } catch { /* ignore */ }
        if (wasStarted) await plugin.stop().catch(() => {});
        const data = await opts.issueCredential?.({ role: "customer", rideId,
          vehicleId: ride.vehicleId, assignmentId: ride.assignmentSessionToken });
        const expiresAtMs = Number(data?.expiresAtMs);
        if (!data?.ok || !data.token || data.signalPath !== "/nativeRidePeerTransport" ||
            !Number.isFinite(expiresAtMs) || expiresAtMs <= now() + 5000 ||
            expiresAtMs > now() + 31 * 60_000 || Number(data.assignmentVersion) < 1) {
          throw new Error("invalid_native_credential");
        }
        credential = { token: data.token, expiresAtMs, rideId, assignmentId: ride.assignmentSessionToken };
        const result = await plugin.start({ rideId, rideStatus, bridgeSessionId,
          vehicleId: ride.vehicleId, assignmentSessionToken: ride.assignmentSessionToken,
          assignmentVersion: Number(data.assignmentVersion), customerTrackingSessionId,
          p2pToken: data.token, p2pTokenExpiresAtMs: expiresAtMs, signalUrl: SIGNAL_URL,
          iceServers: resolveIceConfiguration(globalThis).iceServers,
          p2pFallbackAfterMs: Number(policy.p2pFallbackAfterMs) || 12_000,
          firebaseWriteIntervalMs: Number(policy.firebaseWriteIntervalMs) || 4_000,
          firebaseFallbackEnabled: policy.firebaseFallbackEnabled === true,
          locationIntervalMs: 4_000 });
        if (id !== epoch) return { ok: false, reason: "superseded" };
        if (result?.ok !== true || result?.running !== true) throw new Error("rejected");
        started = true;
        activeKey = nextKey;
        if (plugin.addListener) listener = await plugin.addListener("peerLocationFix", (fix) => {
          if (id === epoch && started) opts.onPeerLocationFix?.(fix);
        });
        timer = setTimer(() => {
          if (id !== epoch) return;
          Promise.resolve().then(async () => {
            if (credential && credential.expiresAtMs <= now() + 60_000) {
              const renewed = await opts.issueCredential?.({ role: "customer", rideId,
                vehicleId: ride.vehicleId, assignmentId: ride.assignmentSessionToken });
              if (renewed?.ok && renewed.token && Number(renewed.expiresAtMs) > now() + 5000) {
                credential = { token: renewed.token, expiresAtMs: Number(renewed.expiresAtMs), rideId,
                  assignmentId: ride.assignmentSessionToken };
                await plugin.updateCredential?.({ bridgeSessionId, token: credential.token,
                  tokenExpiresAtMs: credential.expiresAtMs });
              }
            }
            return plugin.noteWebAlive({ bridgeSessionId });
          })
            .then(r => { if (id === epoch && r?.ok !== true) clear(); })
            .catch(() => { if (id === epoch) clear(); });
        }, 5000);
        return { ok: true };
      } catch {
        if (id === epoch) {
          clear(); activeKey = ""; credential = null;
          try { await listener?.remove?.(); } catch { /* ignore */ }
          listener = null; await plugin.stop().catch(() => {});
        }
        return { ok: false, reason: "native_start_failed" };
      }
    });
  }
  return { syncForRide, stop, isStarted: () => started, isAvailable: () => Boolean(getPlugin()) };
}
