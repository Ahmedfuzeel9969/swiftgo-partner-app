/**
 * Phase 4G — thin native bridge helpers for Capacitor shells.
 * Safe no-ops on plain web Hosting; used when window.Capacitor is present.
 */
export function isNativeShell() {
  return Boolean(typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.());
}

export function getNativePlatform() {
  try {
    return window.Capacitor?.getPlatform?.() || "web";
  } catch {
    return "web";
  }
}

/** Open Play / OEM battery optimization settings when available (Partner). */
export async function openBatteryOptimizationSettings() {
  if (!isNativeShell()) return { ok: false, reason: "web" };
  try {
    // Prefer generic app settings; OEMs vary for exact battery intents.
    const { App } = await import("https://cdn.jsdelivr.net/npm/@capacitor/app@6.0.2/+esm").catch(() => ({}));
    if (App?.openUrl) {
      await App.openUrl({ url: "package:" + (window.__SWIFTGO_ANDROID_PACKAGE__ || "") });
    }
    return { ok: true };
  } catch (err) {
    console.warn("[SwiftGo] battery settings", err);
    return { ok: false, reason: String(err?.message || err) };
  }
}

export async function getNetworkStatus() {
  if (!isNativeShell()) {
    return { connected: typeof navigator !== "undefined" ? navigator.onLine : true, connectionType: "unknown" };
  }
  try {
    const mod = await import("@capacitor/network");
    return await mod.Network.getStatus();
  } catch {
    return { connected: navigator.onLine, connectionType: "unknown" };
  }
}
