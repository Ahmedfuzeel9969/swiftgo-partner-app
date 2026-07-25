/** Wallet, Contact, Missed Call helpers */

import { t, applyTranslations, formatMoney } from "./i18n.js";
import { phoneHref, whatsappHref, whatsappEntries } from "./support.js";

let onBookNow = null;

export function initScreens(handlers = {}) {
  onBookNow = handlers.onBookNow || null;

  document.querySelectorAll('[data-action="book-now"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      if (typeof onBookNow === "function") onBookNow();
    });
  });

  const receiptBtn = document.getElementById("receiptBtn");
  receiptBtn?.addEventListener("click", () => {
    window.alert(t("receiptEmpty"));
  });

  bindSupportLinks();
}

function bindSupportLinks() {
  const tel = phoneHref();
  const missed = document.getElementById("missedCallBtn");
  if (missed) missed.setAttribute("href", tel);

  const entries = whatsappEntries();
  entries.forEach((entry, index) => {
    const btn = document.getElementById(`contactWaBtn${index + 1}`);
    if (!btn) return;
    btn.setAttribute("href", whatsappHref("", index));
    const hint = btn.querySelector("[data-wa-label]");
    if (hint) hint.textContent = entry.label;
  });
}

export function setWalletBalanceUi(amount) {
  const el = document.getElementById("walletBalance");
  if (!el) return;
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  el.textContent = formatMoney(value);
}

export function refreshScreens() {
  ["screen-wallet", "screen-contact", "screen-missed-call", "historySection", "authModal"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) applyTranslations(el);
    }
  );
  bindSupportLinks();
}
