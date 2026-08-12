/**
 * Customer home hub — EasyPaisa-style launcher grid (UI only).
 */

import { t } from "./i18n.js";

/**
 * @param {HTMLElement | null} root
 * @param {{ onProfileTap?: () => void }} config
 */
export function initCustomerHome(root, config = {}) {
  if (!root) {
    return { activate: () => {}, deactivate: () => {}, destroy: () => {} };
  }

  const onProfileTap = config.onProfileTap || (() => {});

  root.innerHTML = `
    <div class="ep-home customer-home-hub">
      <div class="ep-home__inner">
        <article class="ep-book-panel" aria-label="${t("bookRideBtn")}">
          <button type="button" class="ep-hero-btn ep-hero-btn--book" data-route="home">
            <span class="ep-hero-btn__text" data-i18n="bookRideBtn">${t("bookRideBtn")}</span>
          </button>
        </article>

        <section class="ep-services-sheet" aria-labelledby="epServicesTitle">
          <h3 class="ep-section-title" id="epServicesTitle" data-i18n="epServicesTitle">${t("epServicesTitle")}</h3>
          <div class="ep-service-grid" aria-label="${t("appSectionsAria")}">
            <button type="button" class="ep-service-tile" data-route="history">
              <span class="ep-service-tile__icon" aria-hidden="true">📋</span>
              <span class="ep-service-tile__label" data-i18n="navHistory">${t("navHistory")}</span>
            </button>
            <button type="button" class="ep-service-tile" data-route="wallet">
              <span class="ep-service-tile__icon" aria-hidden="true">👛</span>
              <span class="ep-service-tile__label" data-i18n="navWallet">${t("navWallet")}</span>
            </button>
            <button type="button" class="ep-service-tile" data-route="rates">
              <span class="ep-service-tile__icon" aria-hidden="true">💰</span>
              <span class="ep-service-tile__label" data-i18n="navFareRates">${t("navFareRates")}</span>
            </button>
            <button type="button" class="ep-service-tile" data-route="missed-call">
              <span class="ep-service-tile__icon" aria-hidden="true">📞</span>
              <span class="ep-service-tile__label" data-i18n="navMissedCall">${t("navMissedCall")}</span>
            </button>
            <button type="button" class="ep-service-tile" data-route="contact">
              <span class="ep-service-tile__icon" aria-hidden="true">💬</span>
              <span class="ep-service-tile__label" data-i18n="navContact">${t("navContact")}</span>
            </button>
            <button type="button" class="ep-service-tile" data-route="settings">
              <span class="ep-service-tile__icon" aria-hidden="true">⚙️</span>
              <span class="ep-service-tile__label" data-i18n="navSettings">${t("navSettings")}</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  `;

  root.querySelector(".ep-book-panel")?.addEventListener("dblclick", (e) => e.preventDefault());

  return {
    activate() {},
    deactivate() {},
    destroy() {
      root.replaceChildren();
    },
    refreshLabels() {
      root.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        if (key) el.textContent = t(key);
      });
    },
  };
}
