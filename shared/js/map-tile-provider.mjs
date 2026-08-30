/** Explicit deployment configuration; no silent switch to a paid/other host. */
export function resolveStreetTileConfig(globalObj = globalThis) {
  const cfg = globalObj.__SWIFTGO_TILE_PROVIDER__;
  const defaultUrl = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  let url = defaultUrl, attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
  if (cfg?.url) {
    const parsed = new URL(String(cfg.url).replace(/\{[zxy]\}/g, "0"));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash ||
        !["{z}", "{x}", "{y}"].every((p) => cfg.url.includes(p)) || !cfg.attribution) throw new Error("INVALID_TILE_PROVIDER");
    url = cfg.url;
    attribution = String(cfg.attribution).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  return { url, options: { maxZoom: 19, attribution, updateWhenIdle: true, keepBuffer: 1 }, previewOnly: url === defaultUrl };
}

export function createStreetTileLayer(leaflet, globalObj = globalThis) {
  let config;
  try { config = resolveStreetTileConfig(globalObj); } catch { return leaflet.layerGroup(); }
  const layer = leaflet.tileLayer(config.url, config.options);
  let notice = null, failures = 0;
  function clearNotice() { notice?.remove?.(); notice = null; }
  layer.on?.("tileerror", () => {
    failures++;
    const container = layer._map?.getContainer?.();
    if (failures < 3 || notice || !container || !globalObj.document) return;
    notice = globalObj.document.createElement("div"); notice.setAttribute("role", "status");
    notice.textContent = "نقشے کی تصویر دستیاب نہیں؛ مقام کا نشان الگ سے جاری رہ سکتا ہے۔";
    Object.assign(notice.style, { position: "absolute", bottom: "28px", left: "10px", right: "10px", zIndex: "650",
      background: "#fff", color: "#713f12", padding: "8px", borderRadius: "6px", pointerEvents: "none", textAlign: "center" });
    container.appendChild(notice);
  });
  layer.on?.("load", () => { if (failures === 0) clearNotice(); failures = 0; });
  layer.on?.("remove", clearNotice);
  return layer;
}
