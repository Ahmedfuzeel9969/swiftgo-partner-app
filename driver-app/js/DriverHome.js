/**
 * Driver home — EasyPaisa-style dashboard + map (UI only; same data hooks).
 */

import { readCachedHome, subscribeHomeMetrics } from "./home-service.js";
import { formatBargainCapacity, subscribeOpenBargainCount } from "./bargain-capacity.js";

const money = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-PK")}`;

/**
 * @param {HTMLElement | null} root
 * @param {{
 *   getDriverUid: () => string | null,
 *   getWalletThreshold: () => number,
 *   onOpenWallet?: () => void,
 *   onMapMount?: () => void,
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

  let unsub = () => {};
  let bargainSub = null;
  let active = false;

  root.innerHTML = `
    <div class="ep-home driver-home-hub ep-layout">
      <div class="ep-home__inner">
        <article class="ep-account-card" aria-label="ڈرائیور اکاؤنٹ">
          <div>
            <p class="ep-account-card__eyebrow">
              <span aria-hidden="true">👛</span>
              <span>سوئفٹ گو ڈرائیور اکاؤنٹ</span>
            </p>
            <h2 class="ep-account-card__name" data-home-driver-name>ڈرائیور</h2>
            <p class="ep-account-card__meta" data-home-driver-meta>SwiftGo Partner</p>
            <p class="ep-account-card__hint">آن لائن ہوں اور سواریاں حاصل کریں</p>
          </div>
          <button type="button" class="ep-account-card__cta" data-home-open-menu>مینو</button>
        </article>

        <div class="ep-quick-row" aria-label="فوری اختیارات">
          <button type="button" class="ep-quick-card" data-proxy-click="openRideRadarBtn">
            <span class="ep-quick-card__icon" aria-hidden="true">🛺</span>
            <span class="ep-quick-card__label">دستیاب سواریاں</span>
          </button>
          <button type="button" class="ep-quick-card" data-view="rides">
            <span class="ep-quick-card__icon" aria-hidden="true">📋</span>
            <span class="ep-quick-card__label">میری سواریاں</span>
          </button>
          <button type="button" class="ep-quick-card" data-view="earnings">
            <span class="ep-quick-card__icon" aria-hidden="true">💰</span>
            <span class="ep-quick-card__label">آج کی کمائی</span>
          </button>
        </div>

        <h3 class="ep-section-title">SwiftGo کے ساتھ مزید</h3>
        <div class="ep-service-grid" aria-label="مزید سروسز">
          <button type="button" class="ep-service-tile" data-view="dashboard">
            <span class="ep-service-tile__icon" aria-hidden="true">📊</span>
            <span class="ep-service-tile__label">ڈیش بورڈ</span>
          </button>
          <button type="button" class="ep-service-tile" data-view="wallet">
            <span class="ep-service-tile__icon" aria-hidden="true">👛</span>
            <span class="ep-service-tile__label">والٹ</span>
          </button>
          <button type="button" class="ep-service-tile" data-proxy-click="openRateDetailsBtn">
            <span class="ep-service-tile__icon" aria-hidden="true">📈</span>
            <span class="ep-service-tile__label">کرائے کی تفصیل</span>
          </button>
          <button type="button" class="ep-service-tile" data-proxy-click="openNotificationSettingsBtn">
            <span class="ep-service-tile__icon" aria-hidden="true">🔔</span>
            <span class="ep-service-tile__label">رائڈ کی آواز</span>
          </button>
          <button type="button" class="ep-service-tile" data-proxy-click="changeVehicleBtn">
            <span class="ep-service-tile__icon" aria-hidden="true">🔑</span>
            <span class="ep-service-tile__label">گاڑی تبدیل</span>
          </button>
          <button type="button" class="ep-service-tile" data-view="rides">
            <span class="ep-service-tile__icon" aria-hidden="true">🗺️</span>
            <span class="ep-service-tile__label">سفر کی تاریخ</span>
          </button>
          <button type="button" class="ep-service-tile" data-proxy-click="mobileNavRail">
            <span class="ep-service-tile__icon" aria-hidden="true">☰</span>
            <span class="ep-service-tile__label">سب دیکھیں</span>
          </button>
          <button type="button" class="ep-service-tile" data-view="home">
            <span class="ep-service-tile__icon" aria-hidden="true">📍</span>
            <span class="ep-service-tile__label">نقشہ</span>
          </button>
        </div>

        <div class="ep-summary-grid" aria-label="آج کا خلاصہ">
          <article class="ep-summary-card">
            <h4 class="ep-summary-card__title">آج کی کمائی</h4>
            <p class="ep-summary-card__value" data-home-today-earnings>Rs. 0</p>
          </article>
          <article class="ep-summary-card">
            <h4 class="ep-summary-card__title">آج کی سواریاں</h4>
            <p class="ep-summary-card__value" data-home-today-rides>0</p>
          </article>
          <article class="ep-summary-card ep-summary-card--wide driver-home-hub__card--bargain" aria-live="polite">
            <h4 class="ep-summary-card__title">سودے بازی · کھلی پیشکشیں</h4>
            <p class="ep-summary-card__value" data-home-bargain-count>0 / 10</p>
            <p class="ep-summary-card__sub">ایک وقت میں زیادہ سے زیادہ 10 بکنگز</p>
          </article>
          <article class="ep-summary-card ep-summary-card--wide" data-home-wallet-card hidden>
            <h4 class="ep-summary-card__title">والٹ کی صورتحال</h4>
            <p class="ep-summary-card__value" data-home-wallet-balance>Rs. 0</p>
            <p class="ep-summary-card__sub">والٹ ریچارج کریں تاکہ آن لائن رہ سکیں۔</p>
            <button type="button" class="ep-account-card__cta" data-home-wallet-cta>والٹ کھولیں</button>
          </article>
          <p class="ep-summary-card__sub" data-home-sync hidden aria-live="polite">اپ ڈیٹ ہو رہا ہے…</p>
        </div>

        <div class="ep-map-panel driver-home-hub__stage">
          <div id="driverMap" class="driver-map driver-home-hub__map" role="application" aria-label="ڈرائیور کا نقشہ"></div>
        </div>
      </div>
    </div>
  `;

  const els = {
    todayEarnings: root.querySelector("[data-home-today-earnings]"),
    todayRides: root.querySelector("[data-home-today-rides]"),
    bargainCount: root.querySelector("[data-home-bargain-count]"),
    syncHint: root.querySelector("[data-home-sync]"),
    walletCard: root.querySelector("[data-home-wallet-card]"),
    walletBalance: root.querySelector("[data-home-wallet-balance]"),
    walletCta: root.querySelector("[data-home-wallet-cta]"),
    driverName: root.querySelector("[data-home-driver-name]"),
    driverMeta: root.querySelector("[data-home-driver-meta]"),
    openMenu: root.querySelector("[data-home-open-menu]"),
    map: root.querySelector("#driverMap"),
  };

  els.walletCta?.addEventListener("click", () => onOpenWallet());
  els.openMenu?.addEventListener("click", () => {
    document.getElementById("mobileNavRail")?.click();
  });

  function paintBargain({ count, max }) {
    if (els.bargainCount) els.bargainCount.textContent = formatBargainCapacity(count, max);
  }

  function paint(snap) {
    if (els.todayEarnings) els.todayEarnings.textContent = money(snap.todayEarnings);
    if (els.todayRides) els.todayRides.textContent = String(snap.todayRides ?? 0);
    if (els.syncHint) els.syncHint.hidden = !snap.syncing;

    const balance = Number(snap.walletBalance) || 0;
    const threshold = getWalletThreshold();
    const warn = balance <= threshold;
    if (els.walletBalance) els.walletBalance.textContent = money(balance);
    if (els.walletCard) els.walletCard.hidden = !warn;
  }

  function setProfileDisplay({ name, meta }) {
    if (name && els.driverName) els.driverName.textContent = name;
    if (meta && els.driverMeta) els.driverMeta.textContent = meta;
  }

  function activate() {
    if (active) return;
    active = true;
    unsub();
    unsub = () => {};
    bargainSub?.stop();

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
    paintBargain({ count: 0, max: 10 });

    if (!uid) return;
    unsub = subscribeHomeMetrics(uid, paint);
    bargainSub = subscribeOpenBargainCount({
      getDriverUid,
      onChange: paintBargain,
    });
    bargainSub.start();
  }

  function deactivate() {
    unsub();
    unsub = () => {};
    bargainSub?.stop();
    bargainSub = null;
    active = false;
  }

  function invalidateMap() {
    if (!active) return;
    onMapMount();
  }

  function destroy() {
    deactivate();
    root.replaceChildren();
  }

  return {
    activate,
    deactivate,
    destroy,
    invalidateMap,
    getMapElement: () => els.map,
    setProfileDisplay,
  };
}
