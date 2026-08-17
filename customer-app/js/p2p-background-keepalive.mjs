/**
 * Android-only foreground-service bridge for an active customer P2P session.
 *
 * It raises process priority while the customer hides the app. The existing
 * WebRTC session/signaling stays in JavaScript; this module deliberately does
 * not attach Firebase listeners or alter the foreground Firebase policy.
 */

import { getNativePlatform, isNativeShell } from "./native-shell.js";

function getPlugin() {
  if (!isNativeShell() || getNativePlatform() !== "android") return null;
  try {
    const cap = window.Capacitor;
    return cap?.Plugins?.CustomerP2pKeepAlive || cap?.registerPlugin?.("CustomerP2pKeepAlive") || null;
  } catch {
    return null;
  }
}

export function createCustomerP2pBackgroundKeepalive() {
  let startedRideId = "";

  async function syncForRide(ride) {
    const status = String(ride?.status || "");
    const rideId = String(ride?.id || "").trim();
    if (!rideId || !["accepted", "arrived", "in_progress"].includes(status)) {
      return stop();
    }
    const plugin = getPlugin();
    if (!plugin?.start) return { ok: false, reason: "plugin_unavailable" };
    try {
      await plugin.start({ rideId, rideStatus: status });
      startedRideId = rideId;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err).slice(0, 80) };
    }
  }

  async function stop() {
    const plugin = getPlugin();
    startedRideId = "";
    if (!plugin?.stop) return { ok: false, reason: "plugin_unavailable" };
    try {
      await plugin.stop();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err).slice(0, 80) };
    }
  }

  return {
    syncForRide,
    stop,
    isStarted: () => Boolean(startedRideId),
    isAvailable: () => Boolean(getPlugin()),
  };
}
