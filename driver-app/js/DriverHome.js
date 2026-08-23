/**
 * Driver home — map stage + floating wallet warning (side-drawer shell).
 */

import { readCachedHome, subscribeHomeMetrics } from "./home-service.js";

const money = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-PK")}`;

/**
 * @param {HTMLElement | null} root
 * @param {{
 *   getDriverUid: () => string | null,
 *   getWalletThreshold: () => number,
 *   onOpenWallet?: () => void,
 *   onMapMount?: () => void,
 *   onLocate?: () => void,
 *   onMapLayer?: (layer: "streets"|"satellite"|"traffic") => void,
 * }} config
 */
export function initDriverHome(root, config) {
  if (!root) {
    return { activate: () => {}, deactivate: () => {}, destroy: () => {}, invalidateMap: () => {} };
  }

  const getDriverUid = config.getDriverUid || (() => null);
  const getWalletThreshold = config.getWalletThreshold || (() => -500);
  const onOpenWallet = config.onOpenWallet || (() => {});
  const onMapMount = config.onMapMount || (() => {});
  const onLocate = config.onLocate || (() => {});
  const onMapLayer = config.onMapLayer || (() => {});

  let unsub = () => {};
  let active = false;
  let unbindControls = () => {};

  root.innerHTML = `
    <div class="driver-home-hub__stage">
      <div id="driverMap" class="driver-map driver-home-hub__map" role="application" aria-label="ڈرائیور کا نقشہ"></div>
      <div class="map-layers-fab" id="mapLayersFab">
        <button type="button" class="map-layers-fab__btn" id="btnLayersFab" aria-expanded="false" aria-controls="mapLayers" aria-label="میپ لیئرز" title="Layers">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M12 3 3 8l9 5 9-5-9-5Z"/>
            <path d="m3 12 9 5 9-5"/>
            <path d="m3 16 9 5 9-5"/>
          </svg>
        </button>
        <div class="map-layers map-layers--menu" id="mapLayers" role="group" aria-label="میپ لیئرز" hidden>
          <button type="button" class="map-layer-btn is-active" id="btnLayerStreets" data-map-layer="streets" aria-pressed="true" aria-label="عام میپ" title="Map">
            <span class="map-layer-btn__preview map-layer-btn__preview--streets" aria-hidden="true"></span>
            <span class="map-layer-btn__label">عام میپ</span>
          </button>
          <button type="button" class="map-layer-btn" id="btnLayerSatellite" data-map-layer="satellite" aria-pressed="false" aria-label="سیٹلائٹ" title="Satellite">
            <span class="map-layer-btn__preview map-layer-btn__preview--satellite" aria-hidden="true"></span>
            <span class="map-layer-btn__label">سیٹلائٹ</span>
          </button>
          <button type="button" class="map-layer-btn" id="btnLayerTraffic" data-map-layer="traffic" data-traffic-kind="sample_not_live" aria-pressed="false" aria-label="نمونہ ٹریفک — حقیقی ٹریفک نہیں" title="نمونہ ٹریفک — حقیقی ٹریفک نہیں">
            <span class="map-layer-btn__preview map-layer-btn__preview--traffic" aria-hidden="true">
              <span class="map-layer-btn__traffic-line map-layer-btn__traffic-line--green"></span>
              <span class="map-layer-btn__traffic-line map-layer-btn__traffic-line--yellow"></span>
              <span class="map-layer-btn__traffic-line map-layer-btn__traffic-line--red"></span>
            </span>
            <span class="map-layer-btn__label">ٹریفک</span>
          </button>
        </div>
      </div>
      <button type="button" class="fab-locate" id="fabLocate" aria-label="میری لوکیشن" title="My location">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      </button>
      <div class="driver-home-hub__cards" aria-label="والٹ">
        <article class="driver-home-hub__card driver-home-hub__card--wallet" data-home-wallet-card hidden>
          <h2 class="driver-home-hub__card-title">والٹ کی صورتحال</h2>
          <p class="driver-home-hub__wallet-balance">
            <span class="driver-home-hub__label">موجودہ بیلنس</span>
            <strong data-home-wallet-balance>Rs. 0</strong>
          </p>
          <p class="driver-home-hub__wallet-hint">والٹ ریچارج کریں تاکہ آن لائن رہ سکیں۔</p>
          <button type="button" class="driver-home-hub__wallet-cta" data-home-wallet-cta>والٹ کھولیں</button>
        </article>
      </div>
    </div>
  `;

  const els = {
    walletCard: root.querySelector("[data-home-wallet-card]"),
    walletBalance: root.querySelector("[data-home-wallet-balance]"),
    walletCta: root.querySelector("[data-home-wallet-cta]"),
    map: root.querySelector("#driverMap"),
    layersFab: root.querySelector("#mapLayersFab"),
    layersBtn: root.querySelector("#btnLayersFab"),
    layersMenu: root.querySelector("#mapLayers"),
    locateBtn: root.querySelector("#fabLocate"),
  };

  function setLayersMenuOpen(open) {
    if (!els.layersMenu || !els.layersBtn) return;
    els.layersMenu.hidden = !open;
    els.layersBtn.setAttribute("aria-expanded", String(open));
    els.layersFab?.classList.toggle("is-open", open);
  }

  function bindMapControls() {
    unbindControls();
    const onLocateClick = (event) => {
      event.preventDefault();
      onLocate();
    };
    const onLayersToggle = (event) => {
      event.stopPropagation();
      setLayersMenuOpen(els.layersMenu?.hidden !== false);
    };
    const onLayerPick = (event) => {
      const btn = event.target.closest?.("[data-map-layer]");
      if (!btn) return;
      const layer = String(btn.dataset.mapLayer || "");
      if (layer === "streets" || layer === "satellite" || layer === "traffic") {
        onMapLayer(layer);
      }
      window.setTimeout(() => setLayersMenuOpen(false), 160);
    };
    const onDocClick = (event) => {
      if (!els.layersFab?.contains(event.target)) setLayersMenuOpen(false);
    };

    els.walletCta?.addEventListener("click", () => onOpenWallet());
    els.locateBtn?.addEventListener("click", onLocateClick);
    els.layersBtn?.addEventListener("click", onLayersToggle);
    els.layersMenu?.addEventListener("click", onLayerPick);
    document.addEventListener("click", onDocClick);

    unbindControls = () => {
      els.locateBtn?.removeEventListener("click", onLocateClick);
      els.layersBtn?.removeEventListener("click", onLayersToggle);
      els.layersMenu?.removeEventListener("click", onLayerPick);
      document.removeEventListener("click", onDocClick);
      unbindControls = () => {};
    };
  }

  bindMapControls();

  function paint(snap) {
    const balance = Number(snap.walletBalance) || 0;
    const threshold = getWalletThreshold();
    const warn = balance <= threshold;
    if (els.walletBalance) els.walletBalance.textContent = money(balance);
    if (els.walletCard) els.walletCard.hidden = !warn;
  }

  function activate() {
    if (active) return;
    active = true;
    unsub();
    unsub = () => {};

    onMapMount();

    const uid = getDriverUid();
    const cached = uid ? readCachedHome(uid) : null;
    paint(
      cached || {
        todayEarnings: 0,
        todayRides: 0,
        walletBalance: 0,
        syncing: false,
      }
    );

    if (!uid) return;
    unsub = subscribeHomeMetrics(uid, paint);
  }

  function deactivate() {
    unsub();
    unsub = () => {};
    active = false;
  }

  function invalidateMap() {
    if (!active) return;
    onMapMount();
  }

  function destroy() {
    deactivate();
    unbindControls();
    setLayersMenuOpen(false);
    root.replaceChildren();
  }

  return {
    activate,
    deactivate,
    destroy,
    invalidateMap,
    getMapElement: () => els.map,
    getMapControlsRoot: () => root,
  };
}
