/** Installed native plugins only: no runtime CDN imports, and safe on plain hosting. */
export function isNativeShell() {
  try { return Boolean(globalThis.window?.Capacitor?.isNativePlatform?.()); } catch { return false; }
}
export function getNativePlatform() {
  try { return globalThis.window?.Capacitor?.getPlatform?.() || "web"; } catch { return "web"; }
}
export function getNativePlugin(name) {
  if (!isNativeShell()) return null;
  try {
    const cap = window.Capacitor;
    return cap.Plugins?.[name] || cap.registerPlugin?.(name) || null;
  } catch { return null; }
}
export async function openBatteryOptimizationSettings() {
  if (!isNativeShell()) return { ok: false, reason: "web" };
  const plugin = getNativePlugin("NativeSettings");
  if (!plugin?.openAppSettings) return { ok: false, reason: "plugin_unavailable" };
  try { return await plugin.openAppSettings(); }
  catch { return { ok: false, reason: "settings_unavailable" }; }
}
export async function getNetworkStatus() {
  const plugin = getNativePlugin("Network");
  try { if (plugin?.getStatus) return await plugin.getStatus(); } catch { /* OS unavailable */ }
  return { connected: globalThis.navigator?.onLine ?? true, connectionType: "unknown" };
}
export function newNativeSessionId() {
  // No insecure session-id fallback. This is an ownership fence, never an auth credential.
  return globalThis.crypto.randomUUID();
}
