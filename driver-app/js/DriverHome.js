/**
 * Driver home — EasyPaisa-style launcher grid (UI only; same data hooks).
 */

import { readCachedHome, subscribeHomeMetrics } from "./home-service.js";

/**
 * @param {HTMLElement | null} root
 * @param {{
 *   getDriverUid: () => string | null,
 *   getWalletThreshold: () => number,
 * }} config
 */
export function initDriverHome(root, config) {
  if (!root) {
    return { activate: () => {}, deactivate: () => {}, destroy: () => {}, invalidateMap: () => {} };
  }

  const getDriverUid = config.getDriverUid || (() => null);
  const getWalletThreshold = config.getWalletThreshold || (() => -500);

  let unsub = () => {};
  let active = false;

  root.innerHTML = `
    <div class="ep-home driver-home-hub ep-layout">
      <div class="ep-home__inner">
        <article class="ep-status-panel" id="driverHomeStatusCard" aria-label="ڈرائیور کنٹرول">
          <div class="ep-status-panel__actions">
            <div class="ep-status-panel__status" data-ep-status-mount></div>
            <button type="button" class="ep-hero-btn ep-hero-btn--rides" data-proxy-click="openRideRadarBtn">
              <span class="ep-hero-btn__icon ep-hero-btn__icon--rides" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-2-3-2-3 2-3 2-4.5.6-6.5 1.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2"></path>
                  <circle cx="7" cy="17" r="2"></circle>
                  <circle cx="17" cy="17" r="2"></circle>
                  <path d="M5 17H3v-3"></path>
                  <path d="M19 17h2v-3"></path>
                  <path d="M9 9l1-3h4l1 3"></path>
                </svg>
              </span>
              <span class="ep-hero-btn__text" data-i18n="getRideBtn">سواری حاصل کریں</span>
            </button>
          </div>
          <p class="ep-status-panel__wallet-hint" data-home-wallet-hint hidden>والٹ کم ہے — ریچارج کریں</p>
        </article>

        <div class="ep-quick-row" aria-label="فوری اختیارات">
          <button type="button" class="ep-quick-card" data-proxy-click="openRideRadarBtn">
            <span class="ep-quick-card__icon" aria-hidden="true">🛺</span>
            <span class="ep-quick-card__label">دستیاب سواریاں</span>
          </button>
          <button type="button" class="ep-quick-card" data-view="map">
            <span class="ep-quick-card__icon" aria-hidden="true">📍</span>
            <span class="ep-quick-card__label">نقشہ</span>
          </button>
          <button type="button" class="ep-quick-card" data-view="wallet">
            <span class="ep-quick-card__icon" aria-hidden="true">👛</span>
            <span class="ep-quick-card__label">والٹ</span>
          </button>
        </div>

        <section class="ep-services-sheet" aria-labelledby="epServicesTitle">
          <h3 class="ep-section-title" id="epServicesTitle">SwiftGo کے ساتھ مزید</h3>
          <div class="ep-service-grid" aria-label="تمام آپشنز">
            <button type="button" class="ep-service-tile" data-view="dashboard">
              <span class="ep-service-tile__icon" aria-hidden="true">📊</span>
              <span class="ep-service-tile__label">ڈیش بورڈ</span>
            </button>
            <button type="button" class="ep-service-tile" data-view="rates">
              <span class="ep-service-tile__icon" aria-hidden="true">💰</span>
              <span class="ep-service-tile__label">کرائے کی تفصیل</span>
            </button>
            <button type="button" class="ep-service-tile" data-view="rides">
              <span class="ep-service-tile__icon" aria-hidden="true">📋</span>
              <span class="ep-service-tile__label">میری سواریاں</span>
            </button>
            <button type="button" class="ep-service-tile" data-view="earnings">
              <span class="ep-service-tile__icon" aria-hidden="true">💵</span>
              <span class="ep-service-tile__label">کمائی</span>
            </button>
            <button type="button" class="ep-service-tile" data-view="wallet">
              <span class="ep-service-tile__icon" aria-hidden="true">👛</span>
              <span class="ep-service-tile__label">والٹ</span>
            </button>
            <button type="button" class="ep-service-tile" data-view="alerts">
              <span class="ep-service-tile__icon" aria-hidden="true">🔔</span>
              <span class="ep-service-tile__label">رائڈ کی آواز</span>
            </button>
            <button type="button" class="ep-service-tile" data-view="vehicle">
              <span class="ep-service-tile__icon" aria-hidden="true">🔑</span>
              <span class="ep-service-tile__label">گاڑی تبدیل</span>
            </button>
            <button type="button" class="ep-service-tile" data-view="settings">
              <span class="ep-service-tile__icon" aria-hidden="true">⚙️</span>
              <span class="ep-service-tile__label">سیٹنگز</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  `;

  const els = {
    walletHint: root.querySelector("[data-home-wallet-hint]"),
  };

  function paint(snap) {
    const balance = Number(snap.walletBalance) || 0;
    const threshold = getWalletThreshold();
    const warn = balance <= threshold;
    if (els.walletHint) els.walletHint.hidden = !warn;
  }

  function activate() {
    if (active) return;
    active = true;
    unsub();
    unsub = () => {};

    const uid = getDriverUid();
    const cached = uid ? readCachedHome(uid) : null;
    paint(cached || { walletBalance: 0 });

    if (!uid) return;
    unsub = subscribeHomeMetrics(uid, paint);
  }

  function deactivate() {
    unsub();
    unsub = () => {};
    active = false;
  }

  function destroy() {
    deactivate();
    root.replaceChildren();
  }

  return {
    activate,
    deactivate,
    destroy,
    invalidateMap: () => {},
    getMapElement: () => document.getElementById("driverMap"),
    getStatusMount: () => root.querySelector("[data-ep-status-mount]"),
    getStatusCard: () => root.querySelector("#driverHomeStatusCard"),
  };
}
