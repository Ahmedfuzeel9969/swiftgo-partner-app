/**
 * Earnings full-page view — presentation only (data via earnings-service).
 */

import { readCachedEarnings, subscribeDriverEarnings } from "./earnings-service.js";

const money = (n) =>
  `Rs. ${Math.round(Math.max(0, Number(n) || 0)).toLocaleString("en-PK")}`;

const timeFmt = new Intl.DateTimeFormat("ur-PK", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * @param {HTMLElement | null} root
 * @param {{ getDriverUid: () => string | null, onOpenWallet?: () => void }} options
 */
export function initEarningsDetail(root, options = {}) {
  if (!root) {
    return { activate: () => {}, deactivate: () => {}, destroy: () => {} };
  }

  const getDriverUid = options.getDriverUid || (() => null);
  const onOpenWallet = options.onOpenWallet || (() => {});

  let unsub = () => {};
  let active = false;

  root.innerHTML = `
    <div class="earnings-page" data-earnings-root>
      <header class="earnings-page__hero">
        <p class="earnings-page__eyebrow">SwiftGo Driver · Earnings</p>
        <h2 class="earnings-page__title">میری کمائی</h2>
        <p class="earnings-page__sync" data-sync-note hidden aria-live="polite"></p>
        <div class="earnings-page__balance-card">
          <span class="earnings-page__balance-label">موجودہ والٹ بیلنس</span>
          <strong class="earnings-page__balance-value" data-balance>Rs. 0</strong>
          <span class="earnings-page__balance-hint">کمیشن والٹ سے منہا ہوتا ہے</span>
        </div>
      </header>

      <section class="earnings-page__summary" aria-label="خلاصہ">
        <article class="earnings-stat">
          <span class="earnings-stat__label">آج کی کمائی</span>
          <strong class="earnings-stat__value" data-today>Rs. 0</strong>
        </article>
        <article class="earnings-stat">
          <span class="earnings-stat__label">اس ہفتے</span>
          <strong class="earnings-stat__value" data-week>Rs. 0</strong>
        </article>
        <article class="earnings-stat">
          <span class="earnings-stat__label">کل کمائی</span>
          <strong class="earnings-stat__value" data-lifetime>Rs. 0</strong>
        </article>
        <article class="earnings-stat">
          <span class="earnings-stat__label">مکمل سواریاں</span>
          <strong class="earnings-stat__value" data-rides>0</strong>
        </article>
      </section>

      <section class="earnings-page__section" aria-labelledby="earningsDailyTitle">
        <div class="earnings-page__section-head">
          <h3 id="earningsDailyTitle">7 دن کا خلاصہ</h3>
          <p>روزانہ کمائی</p>
        </div>
        <div class="earnings-daily" data-daily-bars role="list"></div>
      </section>

      <section class="earnings-page__section" aria-labelledby="earningsPayoutsTitle">
        <div class="earnings-page__section-head">
          <h3 id="earningsPayoutsTitle">حالیہ ادائیگیاں</h3>
          <p>مکمل سواریوں کی تفصیل</p>
        </div>
        <ul class="earnings-payouts" data-payout-list></ul>
        <p class="earnings-payouts__empty" data-payout-empty hidden>ابھی کوئی مکمل سواری نہیں۔</p>
      </section>

      <div class="earnings-page__actions">
        <button type="button" class="earnings-page__wallet-btn" data-open-wallet>والٹ ریچارج</button>
      </div>
    </div>
  `;

  const q = (sel) => root.querySelector(sel);

  const els = {
    balance: q("[data-balance]"),
    today: q("[data-today]"),
    week: q("[data-week]"),
    lifetime: q("[data-lifetime]"),
    rides: q("[data-rides]"),
    daily: q("[data-daily-bars]"),
    payouts: q("[data-payout-list]"),
    payoutEmpty: q("[data-payout-empty]"),
    syncNote: q("[data-sync-note]"),
    walletBtn: q("[data-open-wallet]"),
  };

  els.walletBtn?.addEventListener("click", () => onOpenWallet());

  function renderDaily(daily = []) {
    if (!els.daily) return;
    const max = Math.max(1, ...daily.map((d) => d.amount));
    els.daily.replaceChildren(
      ...daily.map((day) => {
        const row = document.createElement("div");
        row.className = "earnings-daily__row";
        row.setAttribute("role", "listitem");

        const meta = document.createElement("div");
        meta.className = "earnings-daily__meta";
        meta.innerHTML = `<span>${day.label}</span><strong>${money(day.amount)}</strong>`;

        const track = document.createElement("div");
        track.className = "earnings-daily__track";
        const fill = document.createElement("div");
        fill.className = "earnings-daily__fill";
        fill.style.width = `${Math.round((day.amount / max) * 100)}%`;
        track.append(fill);

        const count = document.createElement("span");
        count.className = "earnings-daily__count";
        count.textContent = `${day.rideCount} سواری`;

        row.append(meta, track, count);
        return row;
      })
    );
  }

  function renderPayouts(rows = []) {
    if (!els.payouts || !els.payoutEmpty) return;
    if (!rows.length) {
      els.payouts.replaceChildren();
      els.payoutEmpty.hidden = false;
      return;
    }
    els.payoutEmpty.hidden = true;
    els.payouts.replaceChildren(
      ...rows.map((row) => {
        const li = document.createElement("li");
        li.className = "earnings-payout";
        const when = row.completedAtMs ? timeFmt.format(new Date(row.completedAtMs)) : "—";
        li.innerHTML = `
          <div class="earnings-payout__top">
            <strong>${money(row.driverEarnings)}</strong>
            <span class="earnings-payout__time">${when}</span>
          </div>
          <p class="earnings-payout__route">${escapeHtml(row.pickup)} → ${escapeHtml(row.dropoff)}</p>
          <p class="earnings-payout__meta">کرایہ ${money(row.fare)} · کمیشن ${money(row.commissionAmount)}</p>
        `;
        return li;
      })
    );
  }

  function render(snapshot) {
    if (!snapshot) return;

    if (els.balance) els.balance.textContent = money(snapshot.walletBalance);
    if (els.today) els.today.textContent = money(snapshot.todayEarnings);
    if (els.week) els.week.textContent = money(snapshot.weekEarnings);
    if (els.lifetime) els.lifetime.textContent = money(snapshot.totalEarnings);
    if (els.rides) els.rides.textContent = String(snapshot.totalRidesCompleted ?? 0);

    renderDaily(snapshot.daily || []);
    renderPayouts(snapshot.recentPayouts || []);

    if (els.syncNote) {
      if (snapshot.syncing) {
        els.syncNote.hidden = false;
        els.syncNote.textContent = "پس منظر میں اپ ڈیٹ ہو رہا ہے…";
      } else if (snapshot.source === "cache") {
        els.syncNote.hidden = false;
        els.syncNote.textContent = "کیش سے لوڈ — ہم آہنگی جاری…";
      } else {
        els.syncNote.hidden = true;
        els.syncNote.textContent = "";
      }
    }
  }

  function activate() {
    if (active) return;
    active = true;
    const uid = getDriverUid();
    if (!uid) {
      render({
        walletBalance: 0,
        totalEarnings: 0,
        totalRidesCompleted: 0,
        todayEarnings: 0,
        weekEarnings: 0,
        daily: [],
        recentPayouts: [],
        source: "cache",
        syncedAt: null,
        syncing: false,
      });
      return;
    }

    const instant = readCachedEarnings(uid);
    if (instant) render({ ...instant, syncing: true });

    unsub = subscribeDriverEarnings(uid, render);
  }

  function deactivate() {
    active = false;
    unsub();
    unsub = () => {};
  }

  function destroy() {
    deactivate();
    root.replaceChildren();
  }

  return { activate, deactivate, destroy };
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
