/**
 * Driver home — map stage + floating summary cards (side-drawer shell).
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
    <div class="driver-home-hub__stage">
      <div id="driverMap" class="driver-map driver-home-hub__map" role="application" aria-label="ڈرائیور کا نقشہ"></div>
      <div class="driver-home-hub__cards" aria-label="آج کا خلاصہ">
        <article class="driver-home-hub__card driver-home-hub__card--bargain" aria-live="polite">
          <h2 class="driver-home-hub__card-title">سودے بازی</h2>
          <p class="driver-home-hub__metric">
            <span class="driver-home-hub__label">کھلی پیشکشیں</span>
            <strong data-home-bargain-count>0 / 10</strong>
          </p>
          <p class="driver-home-hub__hint">ایک وقت میں زیادہ سے زیادہ 10 بکنگز کے ساتھ سودے بازی</p>
        </article>
        <article class="driver-home-hub__card">
          <h2 class="driver-home-hub__card-title">آج کا خلاصہ</h2>
          <p class="driver-home-hub__metric">
            <span class="driver-home-hub__label">آج کی کمائی</span>
            <strong data-home-today-earnings>Rs. 0</strong>
          </p>
          <p class="driver-home-hub__submetric">
            <span class="driver-home-hub__label">آج کی سواریاں</span>
            <span data-home-today-rides>0</span>
          </p>
          <p class="driver-home-hub__sync" data-home-sync hidden aria-live="polite">اپ ڈیٹ ہو رہا ہے…</p>
        </article>
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
    todayEarnings: root.querySelector("[data-home-today-earnings]"),
    todayRides: root.querySelector("[data-home-today-rides]"),
    bargainCount: root.querySelector("[data-home-bargain-count]"),
    syncHint: root.querySelector("[data-home-sync]"),
    walletCard: root.querySelector("[data-home-wallet-card]"),
    walletBalance: root.querySelector("[data-home-wallet-balance]"),
    walletCta: root.querySelector("[data-home-wallet-cta]"),
    map: root.querySelector("#driverMap"),
  };

  els.walletCta?.addEventListener("click", () => onOpenWallet());

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

  return { activate, deactivate, destroy, invalidateMap, getMapElement: () => els.map };
}
