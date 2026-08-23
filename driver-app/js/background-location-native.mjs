/**
 * Capacitor DriverLocation bridge — native foreground GPS for active rides.
 * Safe no-op on plain web hosting.
 */

import { isNativeShell, getNativePlatform } from "./native-shell.js";
import {
  credentialCacheMatches,
  resolveRefreshUrl,
  DEFAULT_UPLOAD_BASE,
} from "./background-location-credential-policy.mjs";

export { credentialCacheMatches, resolveRefreshUrl };

const DEFAULT_UPLOAD_BASE_LOCAL = DEFAULT_UPLOAD_BASE;

function resolveUploadUrl(explicit) {
  const raw = String(explicit || "").trim();
  if (raw) return raw;
  try {
    if (typeof window !== "undefined" && window.__SWIFTGO_BG_LOCATION_UPLOAD_URL__) {
      return String(window.__SWIFTGO_BG_LOCATION_UPLOAD_URL__).trim();
    }
  } catch {
    /* ignore */
  }
  return `${DEFAULT_UPLOAD_BASE_LOCAL}/ingestBackgroundDriverLocation`;
}

/** @param {string} uploadUrl @param {string} [explicit] */
export function resolveRefreshUrlFromUpload(uploadUrl, explicit) {
  return resolveRefreshUrl(uploadUrl, explicit);
}

function getPlugin() {
  if (!isNativeShell()) return null;
  try {
    const Cap = window.Capacitor;
    if (!Cap) return null;
    if (typeof Cap.Plugins?.DriverLocation !== "undefined") {
      return Cap.Plugins.DriverLocation;
    }
    if (typeof Cap.registerPlugin === "function") {
      return Cap.registerPlugin("DriverLocation");
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {{
 *   httpsCallable?: (name: string) => (data: object) => Promise<{ data?: object }>,
 *   onNativeFix?: (fix: object) => void,
 *   onServiceState?: (state: object) => void,
 *   getLastSequence?: () => number,
 *   nowMs?: () => number,
 * }} [opts]
 */
export function createBackgroundLocationNativeController(opts = {}) {
  const nowMs = typeof opts.nowMs === "function" ? opts.nowMs : () => Date.now();
  let started = false;
  let handle = null;
  let fixListener = null;
  let stateListener = null;
  let aliveTimer = 0;
  let refreshTimer = 0;
  let lastCredential = null;
  let lastBinding = null;
  let lastNativeDiagnostics = null;

  function clearTimers() {
    if (aliveTimer) {
      clearInterval(aliveTimer);
      aliveTimer = 0;
    }
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = 0;
    }
  }

  async function callIssueCredential(binding) {
    if (typeof opts.httpsCallable !== "function") {
      throw new Error("HTTPS_CALLABLE_UNAVAILABLE");
    }
    const fn = opts.httpsCallable("issueBackgroundLocationCredential");
    const res = await fn({
      rideId: binding.rideId,
      vehicleId: binding.vehicleId,
      trackingSessionId: binding.trackingSessionId,
      assignmentSessionToken: binding.assignmentSessionToken,
    });
    return res?.data || res;
  }

  async function ensureCredential(binding) {
    const now = nowMs();
    if (credentialCacheMatches(lastCredential, binding, now)) {
      return lastCredential;
    }
    const issued = await callIssueCredential(binding);
    if (!issued?.ok || !issued?.token) {
      throw new Error(issued?.reason || "CREDENTIAL_ISSUE_FAILED");
    }
    const uploadUrl = resolveUploadUrl(
      issued.uploadUrl ||
        (issued.uploadPath ? `${DEFAULT_UPLOAD_BASE_LOCAL}${issued.uploadPath}` : "")
    );
    lastCredential = {
      token: issued.token,
      expiresAtMs: Number(issued.expiresAtMs) || now + 15 * 60_000,
      ttlMs: Number(issued.ttlMs) || 15 * 60_000,
      rideId: binding.rideId,
      vehicleId: binding.vehicleId,
      trackingSessionId: binding.trackingSessionId,
      assignmentSessionToken: binding.assignmentSessionToken,
      driverUid: binding.driverUid || "",
      uploadUrl,
      refreshUrl: resolveRefreshUrl(
        uploadUrl,
        issued.refreshPath ? `${DEFAULT_UPLOAD_BASE_LOCAL}${issued.refreshPath}` : ""
      ),
    };
    return lastCredential;
  }

  async function attachListeners(plugin) {
    if (fixListener) {
      try {
        await fixListener.remove?.();
      } catch {
        /* ignore */
      }
      fixListener = null;
    }
    if (stateListener) {
      try {
        await stateListener.remove?.();
      } catch {
        /* ignore */
      }
      stateListener = null;
    }
    if (typeof plugin.addListener === "function") {
      fixListener = await plugin.addListener("locationFix", (fix) => {
        try {
          opts.onNativeFix?.(fix || {});
        } catch {
          /* ignore */
        }
      });
      stateListener = await plugin.addListener("serviceState", (state) => {
        try {
          const serviceState = String(state?.state || "");
          if (serviceState === "permission_denied" || serviceState.startsWith("stopped")) {
            started = false;
          } else if (serviceState === "started" || serviceState === "restored_sticky") {
            started = true;
          }
          const upload = state?.upload || {};
          lastNativeDiagnostics = {
            fixCount: Number(state?.fixCount) || 0,
            queued: Number(upload.queued) || 0,
            uploaded: Number(upload.uploaded) || 0,
            rejected: Number(upload.rejected) || 0,
            lastReason: String(upload.lastReason || state?.state || ""),
            hasCredential: Boolean(upload.hasCredential),
          };
          opts.onServiceState?.(state || {});
        } catch {
          /* ignore */
        }
      });
    }
  }

  function startAlivePulse(plugin) {
    clearTimers();
    const pulse = () => {
      try {
        const seq =
          typeof opts.getLastSequence === "function" ? opts.getLastSequence() : 0;
        void plugin.noteWebAlive?.({ lastSequence: Number(seq) || 0 });
      } catch {
        /* ignore */
      }
    };
    pulse();
    aliveTimer = setInterval(pulse, 5_000);
    refreshTimer = setInterval(() => {
      if (!lastBinding || !started) return;
      void ensureCredential(lastBinding)
        .then((cred) =>
          plugin.updateCredential?.({
            token: cred.token,
            tokenExpiresAtMs: cred.expiresAtMs,
            refreshUrl: cred.refreshUrl || resolveRefreshUrl(cred.uploadUrl),
          })
        )
        .catch(() => {});
    }, 8 * 60_000);
  }

  /**
   * Start or refresh native foreground tracking for an active ride.
   * @param {{
   *   rideId: string,
   *   vehicleId: string,
   *   driverUid: string,
   *   trackingSessionId: string,
   *   assignmentSessionToken: string,
   *   rideStatus?: string,
   *   intervalMs?: number,
   *   lastSequence?: number,
   * }} binding
   */
  async function start(binding) {
    if (!isNativeShell() || getNativePlatform() !== "android") {
      return { ok: false, reason: "not_android_native" };
    }
    const plugin = getPlugin();
    if (!plugin?.start) return { ok: false, reason: "plugin_unavailable" };

    const rideId = String(binding?.rideId || "").trim();
    const vehicleId = String(binding?.vehicleId || "").trim();
    const trackingSessionId = String(binding?.trackingSessionId || "").trim();
    if (!rideId || !vehicleId || !trackingSessionId) {
      return { ok: false, reason: "invalid_binding" };
    }

    lastBinding = {
      rideId,
      vehicleId,
      driverUid: String(binding.driverUid || "").trim(),
      trackingSessionId,
      assignmentSessionToken: String(binding.assignmentSessionToken || "").trim(),
      rideStatus: String(binding.rideStatus || ""),
      intervalMs: Math.max(2000, Number(binding.intervalMs) || 4000),
      lastSequence: Math.max(0, Math.floor(Number(binding.lastSequence) || 0)),
    };

    let cred = null;
    try {
      cred = await ensureCredential(lastBinding);
    } catch (err) {
      // Still start native GPS for P2P-first while WebView is alive; HTTPS fallback needs credential.
      console.warn(
        "[SwiftGo Partner] background credential",
        String(err?.message || err).slice(0, 80)
      );
      cred = {
        token: "",
        expiresAtMs: 0,
        uploadUrl: resolveUploadUrl(""),
        refreshUrl: resolveRefreshUrl(""),
      };
    }

    await attachListeners(plugin);
    const result = await plugin.start({
      rideId: lastBinding.rideId,
      vehicleId: lastBinding.vehicleId,
      driverUid: lastBinding.driverUid,
      trackingSessionId: lastBinding.trackingSessionId,
      assignmentSessionToken: lastBinding.assignmentSessionToken,
      rideStatus: lastBinding.rideStatus,
      intervalMs: lastBinding.intervalMs,
      lastSequence: lastBinding.lastSequence,
      uploadUrl: cred.uploadUrl || "",
      refreshUrl: cred.refreshUrl || resolveRefreshUrl(cred.uploadUrl || ""),
      token: cred.token || "",
      tokenExpiresAtMs: cred.expiresAtMs || 0,
    });
    if (result?.ok === false || result?.running === false) {
      started = false;
      clearTimers();
      return {
        ok: false,
        reason: String(result?.reason || "native_start_rejected").slice(0, 80),
      };
    }
    handle = plugin;
    started = true;
    startAlivePulse(plugin);
    return {
      ok: true,
      result,
      credentialExpiresAtMs: cred.expiresAtMs || 0,
      credentialReady: Boolean(cred.token),
    };
  }

  async function stop() {
    clearTimers();
    started = false;
    lastBinding = null;
    lastCredential = null;
    const plugin = handle || getPlugin();
    handle = null;
    try {
      if (fixListener) await fixListener.remove?.();
    } catch {
      /* ignore */
    }
    fixListener = null;
    try {
      if (stateListener) await stateListener.remove?.();
    } catch {
      /* ignore */
    }
    stateListener = null;
    if (!plugin?.stop) return { ok: false, reason: "plugin_unavailable" };
    try {
      await plugin.stop();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err).slice(0, 80) };
    }
  }

  async function syncForActiveRide(binding) {
    const status = String(binding?.rideStatus || binding?.status || "");
    const active = ["accepted", "arrived", "in_progress"].includes(status);
    if (!active) return stop();
    return start({
      ...binding,
      rideStatus: status,
    });
  }

  function isStarted() {
    return started;
  }

  function getLastCredentialMeta() {
    if (!lastCredential) return null;
    return {
      expiresAtMs: lastCredential.expiresAtMs,
      rideId: lastCredential.rideId,
      vehicleId: lastCredential.vehicleId,
      trackingSessionId: lastCredential.trackingSessionId,
      assignmentSessionToken: lastCredential.assignmentSessionToken,
      driverUid: lastCredential.driverUid,
    };
  }

  function getDiagnostics() {
    return lastNativeDiagnostics ? { ...lastNativeDiagnostics } : null;
  }

  return {
    start,
    stop,
    syncForActiveRide,
    isStarted,
    getLastCredentialMeta,
    getDiagnostics,
    isAvailable: () => isNativeShell() && getNativePlatform() === "android" && Boolean(getPlugin()),
    /** Test helpers */
    _ensureCredentialForTest: ensureCredential,
    _getLastCredentialForTest: () => (lastCredential ? { ...lastCredential } : null),
  };
}
