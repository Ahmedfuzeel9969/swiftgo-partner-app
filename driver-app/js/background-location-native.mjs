/**
 * Native GPS ownership is fenced by a bridge session. Pending credentials,
 * starts and refreshes cannot resurrect a stopped/reassigned ride.
 * P2P stays in the existing JS engine; native HTTPS remains the admin-gated fallback.
 */
import { getNativePlatform, getNativePlugin, newNativeSessionId } from "../../shared/js/native-bridge.mjs";
import { credentialCacheMatches, resolveUploadUrl, resolveRefreshUrl, normalizeNativeBinding, DEFAULT_UPLOAD_BASE } from "./background-location-credential-policy.mjs";
import { resolveIceConfiguration } from "./p2p-protocol.mjs";
export { credentialCacheMatches, resolveRefreshUrl };
export const resolveRefreshUrlFromUpload = resolveRefreshUrl;

export function createBackgroundLocationNativeController(opts = {}) {
  const now = opts.nowMs || Date.now;
  const getPlugin = opts.getPlugin || (() => getNativePlatform() === "android" ? getNativePlugin("DriverLocation") : null);
  const setTimer = opts.setInterval || setInterval, clearTimer = opts.clearInterval || clearInterval;
  let epoch = 0, started = false, binding = null, credential = null, p2pCredential = null, diagnostics = null;
  let listeners = [], timers = [], mutations = Promise.resolve(), pendingStart = false;
  const serial = fn => {
    const result = mutations.then(fn);
    mutations = result.catch(() => {});
    return result;
  };
  const current = id => id === epoch;
  const cancelled = () => ({ ok: false, reason: "superseded" });
  function clearTimers() { for (const t of timers) clearTimer(t); timers = []; }
  async function removeListeners() {
    const old = listeners; listeners = [];
    await Promise.all(old.map(l => Promise.resolve().then(() => l?.remove?.()).catch(() => {})));
  }
  async function issue(b, id) {
    if (credentialCacheMatches(credential, b, now())) return credential;
    if (!opts.httpsCallable) throw new Error("credential_unavailable");
    const result = await opts.httpsCallable("issueBackgroundLocationCredential")({
      rideId: b.rideId, vehicleId: b.vehicleId, trackingSessionId: b.trackingSessionId,
      assignmentSessionToken: b.assignmentSessionToken,
    });
    const data = result?.data || result;
    const expiresAtMs = Number(data?.expiresAtMs);
    if (!data?.ok || !data.token || !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= now() + 5000 || expiresAtMs > now() + 31 * 60_000) {
      throw new Error("invalid_credential");
    }
    const uploadUrl = resolveUploadUrl(data.uploadUrl || (data.uploadPath ? DEFAULT_UPLOAD_BASE + data.uploadPath : ""));
    const refreshUrl = resolveRefreshUrl(uploadUrl, data.refreshUrl || (data.refreshPath ? DEFAULT_UPLOAD_BASE + data.refreshPath : ""));
    const value = { ...b, token: data.token, expiresAtMs, uploadUrl, refreshUrl };
    if (current(id)) credential = value;
    return value;
  }
  async function issueP2p(b, id) {
    if (p2pCredential?.token && p2pCredential.rideId === b.rideId &&
        p2pCredential.assignmentSessionToken === b.assignmentSessionToken &&
        p2pCredential.expiresAtMs > now() + 60_000) return p2pCredential;
    if (!opts.httpsCallable) throw new Error("p2p_credential_unavailable");
    const result = await opts.httpsCallable("issueNativeP2pCredential")({
      role: "driver", rideId: b.rideId, vehicleId: b.vehicleId,
      assignmentId: b.assignmentSessionToken, trackingSessionId: b.trackingSessionId,
    });
    const data = result?.data || result, expiresAtMs = Number(data?.expiresAtMs);
    const signalUrl = DEFAULT_UPLOAD_BASE + "/nativeRidePeerTransport";
    if (!data?.ok || !data.token || data.signalPath !== "/nativeRidePeerTransport" ||
        !Number.isFinite(expiresAtMs) || expiresAtMs <= now() + 5000 || expiresAtMs > now() + 31 * 60_000 ||
        Number(data.assignmentVersion) < 1) throw new Error("invalid_p2p_credential");
    const value = { token: data.token, expiresAtMs, signalUrl, rideId: b.rideId,
      assignmentSessionToken: b.assignmentSessionToken, assignmentVersion: Number(data.assignmentVersion) };
    if (current(id)) p2pCredential = value;
    return value;
  }
  function pulse(plugin, b, id) {
    if (!current(id) || !started) return;
    const lastSequence = Number(opts.getLastSequence?.()) || b.lastSequence;
    Promise.resolve().then(() => plugin.noteWebAlive({ bridgeSessionId: b.bridgeSessionId, lastSequence }))
      .then(result => {
        if (current(id) && result?.ok === false) { started = false; clearTimers(); }
      }).catch(() => { if (current(id)) { started = false; clearTimers(); } });
  }
  async function attach(plugin, b, id) {
    if (!plugin.addListener) throw new Error("listeners_unavailable");
    const accepts = event => current(id) && event?.bridgeSessionId === b.bridgeSessionId && event?.rideId === b.rideId;
    listeners.push(await plugin.addListener("locationFix", fix => {
      if (!accepts(fix) || !started) return;
      // Resume sequence ownership above native's last delivered sequence.
      opts.onNativeFix?.(fix);
    }));
    listeners.push(await plugin.addListener("peerLocationFix", fix => {
      if (!accepts({ ...fix, bridgeSessionId: b.bridgeSessionId, rideId: b.rideId }) || !started) return;
      opts.onPeerLocationFix?.(fix);
    }));
    if (!current(id)) return;
    listeners.push(await plugin.addListener("serviceState", state => {
      if (!accepts(state)) return;
      if (String(state.state).startsWith("stopped")) { started = false; clearTimers(); }
      const u = state.upload || {};
      diagnostics = { fixCount: Number(state.fixCount) || 0, queued: Number(u.queued) || 0,
        uploaded: Number(u.uploaded) || 0, rejected: Number(u.rejected) || 0,
        lastReason: String(u.lastReason || state.state || "").slice(0, 80), hasCredential: Boolean(u.hasCredential) };
      opts.onServiceState?.(state);
    }));
  }
  async function start(input) {
    const plugin = getPlugin();
    if (!plugin?.start) return { ok: false, reason: "plugin_unavailable" };
    let b;
    try { b = normalizeNativeBinding(input); }
    catch { await stop(); return { ok: false, reason: "invalid_binding" }; }
    if (started && binding && ["rideId", "vehicleId", "driverUid", "trackingSessionId", "assignmentSessionToken", "rideStatus", "intervalMs",
      "assignmentVersion", "p2pFallbackAfterMs", "firebaseWriteIntervalMs", "firebaseFallbackEnabled"]
      .every(key => binding[key] === b[key])) {
      pulse(plugin, binding, epoch);
      return { ok: true, reused: true };
    }
    const id = ++epoch;
    if (pendingStart) Promise.resolve().then(() => plugin.stop()).catch(() => {});
    clearTimers(); started = false;
    b.bridgeSessionId = (opts.newSessionId || newNativeSessionId)();
    binding = b;
    let cred, peerCred = null;
    try { cred = await issue(b, id); }
    catch {
      // GPS can still serve JS P2P. A credential-less service may NOT restore after death.
      cred = { token: "", expiresAtMs: 0, uploadUrl: resolveUploadUrl(), refreshUrl: resolveRefreshUrl() };
    }
    try { peerCred = await issueP2p(b, id); } catch { peerCred = null; }
    if (!current(id)) return cancelled();
    return serial(async () => {
      if (!current(id)) return cancelled();
      await removeListeners();
      try {
        await attach(plugin, b, id);
        if (!current(id)) return cancelled();
        let result;
        pendingStart = true;
        try {
          const iceServers = resolveIceConfiguration(globalThis).iceServers;
          result = await plugin.start({ ...b, assignmentVersion: peerCred?.assignmentVersion || b.assignmentVersion,
            uploadUrl: cred.uploadUrl, refreshUrl: cred.refreshUrl,
            token: cred.token, tokenExpiresAtMs: cred.expiresAtMs,
            p2pToken: peerCred?.token || "", p2pTokenExpiresAtMs: peerCred?.expiresAtMs || 0,
            signalUrl: peerCred?.signalUrl || (DEFAULT_UPLOAD_BASE + "/nativeRidePeerTransport"), iceServers });
        } finally { pendingStart = false; }
        if (!current(id)) return cancelled(); // queued stop/new start owns cleanup
        if (result?.ok !== true || result?.running !== true) throw new Error("native_start_rejected");
        started = true;
        opts.onNativeSequence?.(Number(result.lastSequence) || 0);
        pulse(plugin, b, id);
        timers.push(setTimer(() => pulse(plugin, b, id), 5000));
        let refreshing = false;
        timers.push(setTimer(async () => {
          if (!current(id) || !started || refreshing) return;
          refreshing = true;
          try {
            const renewed = await issue(b, id);
            if (current(id) && started) await serial(() => current(id) && plugin.updateCredential({
              bridgeSessionId: b.bridgeSessionId, token: renewed.token,
              tokenExpiresAtMs: renewed.expiresAtMs, refreshUrl: renewed.refreshUrl,
            }));
          } catch { /* native refresh is separately guarded and bounded by token expiry */ }
          finally { refreshing = false; }
        }, 60_000));
        let peerRefreshing = false;
        timers.push(setTimer(async () => {
          if (!current(id) || !started || peerRefreshing) return;
          peerRefreshing = true;
          try {
            const renewed = await issueP2p(b, id);
            if (current(id) && started) await serial(() => current(id) && plugin.updateP2pCredential?.({
              bridgeSessionId: b.bridgeSessionId, token: renewed.token, tokenExpiresAtMs: renewed.expiresAtMs,
            }));
          } catch { /* native engine also rotates while the WebView is absent */ }
          finally { peerRefreshing = false; }
        }, 60_000));
        return { ok: true, credentialReady: Boolean(cred.token), credentialExpiresAtMs: cred.expiresAtMs };
      } catch {
        if (current(id)) { started = false; clearTimers(); await removeListeners(); await plugin.stop().catch(() => {}); }
        return { ok: false, reason: "native_start_failed" };
      }
    });
  }
  async function stop() {
    ++epoch; clearTimers(); started = false; binding = null; credential = null; p2pCredential = null; diagnostics = null;
    // Cancel an OS permission dialog/start immediately; never wait behind that start.
    const stopping = Promise.resolve().then(() => getPlugin()?.stop?.());
    stopping.catch(() => {});
    return serial(async () => {
      await removeListeners();
      try { await stopping; return { ok: true }; }
      catch { return { ok: false, reason: "native_stop_failed" }; }
    });
  }
  return {
    start, stop,
    syncForActiveRide: b => ["accepted", "arrived", "in_progress"].includes(b?.rideStatus || b?.status) ? start(b) : stop(),
    isStarted: () => started,
    isAvailable: () => Boolean(getPlugin()),
    getDiagnostics: () => diagnostics && { ...diagnostics },
    // Never expose tokens, assignment identifiers or personal identifiers in diagnostics.
    getLastCredentialMeta: () => credential ? { expiresAtMs: credential.expiresAtMs, ready: credentialCacheMatches(credential, binding, now(), 0) } : null,
  };
}
