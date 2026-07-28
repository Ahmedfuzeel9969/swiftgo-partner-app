/**
 * Phase 4D — Owner EN/UR language + RTL direction.
 */

const STORAGE_KEY = "swiftgo_owner_lang";

const dictionaries = {
  en: {
    appTitle: "SwiftGo Owner",
    authTitle: "Owner account",
    authCopy: "Sign in to manage your fleet and share vehicle PINs.",
    googleLogin: "Sign in with Google",
    emulatorNote: "Emulator · documents not required",
    blockedTitle: "Account suspended. Please contact support.",
    logout: "Log out",
    navAria: "Owner navigation",
    navFleet: "My Fleet",
    topbarFleet: "My Fleet",
    language: "Language",
  },
  ur: {
    appTitle: "سوئفٹ گو مالک",
    authTitle: "مالک اکاؤنٹ",
    authCopy: "اپنی گاڑیوں کا بیڑا سنبھالنے اور PIN شیئر کرنے کے لیے لاگ اِن کریں۔",
    googleLogin: "Google سے لاگ ان کریں",
    emulatorNote: "Emulator · دستاویزات درکار نہیں",
    blockedTitle: "اکاؤنٹ معطل کر دیا گیا ہے۔ براہ کرم سپورٹ سے رابطہ کریں۔",
    logout: "لاگ آؤٹ",
    navAria: "مالک نیویگیشن",
    navFleet: "میری گاڑیاں",
    topbarFleet: "میری گاڑیاں",
    language: "زبان",
  },
};

function loadInitialLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ur") return saved;
  } catch {
    /* ignore */
  }
  return "ur";
}

const state = {
  lang: loadInitialLang(),
  listeners: new Set(),
};

export function getLang() {
  return state.lang;
}

export function t(key) {
  const dict = dictionaries[state.lang] || dictionaries.ur;
  return dict[key] ?? dictionaries.ur[key] ?? dictionaries.en[key] ?? key;
}

export function subscribe(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

export function applyDocumentDirection(lang = state.lang) {
  const root = document.documentElement;
  const isUrdu = lang === "ur";
  root.lang = isUrdu ? "ur" : "en";
  root.dir = isUrdu ? "rtl" : "ltr";
  root.dataset.lang = lang;
}

export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    el.textContent = t(key);
  });
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria");
    if (!key) return;
    el.setAttribute("aria-label", t(key));
  });
  if (root === document) {
    const title = t("appTitle");
    if (title) document.title = title;
  }
}

export function syncLangButtons(root = document) {
  root.querySelectorAll("[data-lang]").forEach((btn) => {
    const active = btn.getAttribute("data-lang") === state.lang;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}

export function setLang(lang) {
  if (lang !== "en" && lang !== "ur") return;
  if (state.lang !== lang) {
    state.lang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
  }
  applyDocumentDirection(lang);
  applyTranslations();
  syncLangButtons();
  state.listeners.forEach((fn) => fn(lang));
}

export function initI18n() {
  applyDocumentDirection(state.lang);
  applyTranslations();
  syncLangButtons();
  bindLangSwitchClicks();
}

let langSwitchBound = false;

function bindLangSwitchClicks() {
  if (langSwitchBound) return;
  langSwitchBound = true;
  document.addEventListener(
    "click",
    (event) => {
      const btn = event.target?.closest?.("[data-lang]");
      if (!btn || btn.tagName !== "BUTTON") return;
      event.preventDefault();
      event.stopPropagation();
      const lang = btn.getAttribute("data-lang");
      if (lang === "en" || lang === "ur") setLang(lang);
    },
    true
  );
}
