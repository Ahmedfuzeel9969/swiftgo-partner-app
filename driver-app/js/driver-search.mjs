/**
 * Driver header search — filter app destinations and open ride radar.
 */

/**
 * @param {{
 *   sheet?: HTMLElement | null,
 *   backdrop?: HTMLElement | null,
 *   closeBtn?: HTMLElement | null,
 *   input?: HTMLInputElement | null,
 *   results?: HTMLElement | null,
 *   onNavigate?: (view: string) => void,
 *   onRideRadar?: () => void,
 * }} config
 */
export function initDriverSearch(config = {}) {
  const sheet = config.sheet || document.getElementById("driverSearchSheet");
  const backdrop = config.backdrop || document.getElementById("driverSearchBackdrop");
  const closeBtn = config.closeBtn || document.getElementById("driverSearchClose");
  const input = config.input || document.getElementById("driverSearchInput");
  const results = config.results || document.getElementById("driverSearchResults");
  const onNavigate = config.onNavigate || (() => {});
  const onRideRadar = config.onRideRadar || (() => {});

  if (!sheet || !input || !results) {
    return { open: () => {}, close: () => {}, destroy: () => {} };
  }

  /** @type {{ id: string, label: string, hint: string, keywords: string, run: () => void }[]} */
  const items = [
    {
      id: "rides-radar",
      label: "دستیاب سواریاں",
      hint: "سواری تلاش کریں",
      keywords: "سواری رائڈ ride radar تلاش search",
      run: () => onRideRadar(),
    },
    {
      id: "map",
      label: "نقشہ",
      hint: "اپنا مقام دیکھیں",
      keywords: "map location نقشہ",
      run: () => onNavigate("map"),
    },
    {
      id: "dashboard",
      label: "ڈیش بورڈ",
      hint: "اعداد و شمار",
      keywords: "dashboard ڈیش بورڈ",
      run: () => onNavigate("dashboard"),
    },
    {
      id: "rates",
      label: "کرائے کی تفصیل",
      hint: "تمام گاڑیوں کے ریٹ",
      keywords: "rate fare کرaya ریٹ",
      run: () => onNavigate("rates"),
    },
    {
      id: "rides",
      label: "میری سواریاں",
      hint: "سفر کی تاریخ",
      keywords: "rides history میری سواریاں",
      run: () => onNavigate("rides"),
    },
    {
      id: "earnings",
      label: "کمائی",
      hint: "آمدنی کی تفصیل",
      keywords: "earnings کمائی",
      run: () => onNavigate("earnings"),
    },
    {
      id: "wallet",
      label: "والٹ",
      hint: "بیلنس اور ریچارج",
      keywords: "wallet والٹ",
      run: () => onNavigate("wallet"),
    },
    {
      id: "alerts",
      label: "رائڈ کی آواز",
      hint: "نوٹیفکیشن سیٹنگز",
      keywords: "alerts sound آواز",
      run: () => onNavigate("alerts"),
    },
    {
      id: "vehicle",
      label: "گاڑی تبدیل",
      hint: "منسلک گاڑی بدلیں",
      keywords: "vehicle گاڑی pin",
      run: () => onNavigate("vehicle"),
    },
    {
      id: "settings",
      label: "سیٹنگز",
      hint: "اکاؤنٹ اور زبان",
      keywords: "settings سیٹنگز",
      run: () => onNavigate("settings"),
    },
  ];

  let releaseFocus = null;

  function normalize(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function filterItems(query) {
    const q = normalize(query);
    if (!q) return items.slice();
    return items.filter((item) => {
      const hay = normalize(`${item.label} ${item.hint} ${item.keywords}`);
      return hay.includes(q) || q.split(" ").every((part) => part && hay.includes(part));
    });
  }

  function render(query = "") {
    const matches = filterItems(query);
    results.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("li");
      empty.className = "ep-search-sheet__empty";
      empty.textContent = "کوئی نتیجہ نہیں ملا";
      results.appendChild(empty);
      return;
    }
    matches.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ep-search-sheet__item";
      btn.dataset.searchItem = item.id;
      btn.innerHTML = `<span class="ep-search-sheet__item-label">${item.label}</span><span class="ep-search-sheet__item-hint">${item.hint}</span>`;
      btn.addEventListener("click", () => {
        close();
        item.run();
      });
      results.appendChild(btn);
    });
  }

  function open() {
    sheet.hidden = false;
    sheet.setAttribute("aria-hidden", "false");
    render("");
    input.value = "";
    requestAnimationFrame(() => {
      sheet.classList.add("is-open");
      input.focus();
    });
  }

  function close() {
    sheet.classList.remove("is-open");
    sheet.hidden = true;
    sheet.setAttribute("aria-hidden", "true");
    input.blur();
    releaseFocus?.();
    releaseFocus = null;
  }

  backdrop?.addEventListener("click", close);
  closeBtn?.addEventListener("click", close);
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter") {
      const first = results.querySelector(".ep-search-sheet__item");
      first?.click();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !sheet.hidden) close();
  });

  return { open, close, destroy: close };
}
