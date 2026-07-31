/**
 * Phase 4D — Partner (Driver) EN/UR language + RTL direction.
 * Lightweight; covers auth, nav, and top chrome. Dynamic strings still use Urdu by default in JS.
 */

const STORAGE_KEY = "swiftgo_partner_lang";

const dictionaries = {
  en: {
    appTitle: "SwiftGo Driver",
    authTitle: "Driver account",
    authCopy: "Sign in to go online and receive ride requests.",
    googleLogin: "Sign in with Google",
    emulatorNote: "Emulator · documents not required",
    blockedTitle: "Account suspended. Please contact support.",
    logout: "Log out",
    pinTitle: "Enter vehicle PIN",
    pinCopy: "Enter the 4-digit PIN from the owner to link a vehicle to your account.",
    pinVerify: "Verify PIN",
    navAria: "Driver navigation",
    navHome: "Home",
    navDashboard: "Analytics",
    navRates: "Fare rates",
    navRatesAria: "View fare rate details",
    navRides: "My Rides",
    navEarnings: "Earnings",
    navWallet: "Wallet",
    navAlerts: "Ride Alert Sound",
    alertsAria: "Ride request sound settings",
    navChangeVehicle: "Switch vehicle",
    changeVehicleConfirm:
      "Leave this vehicle and enter another PIN? You will go offline first.",
    changeVehicleBlockedRide: "Finish the active ride before switching vehicles.",
    changeVehiclePinPrompt: "Enter the PIN for the new vehicle.",
    changeVehicleFailed: "Could not release the current vehicle. Try again.",
    closeMenu: "Close menu",
    openMenu: "Open menu",
    topbarHome: "Home",
    statusOffline: "Offline",
    statusOnline: "Online",
    statusToggleAria: "Go online",
    statusToggleAriaOffline: "Go offline",
    rideRadar: "Available rides",
    language: "Language",
    driverLabel: "Driver",
    deleteAccount: "Delete account",
  },
  ur: {
    appTitle: "سوئفٹ گو ڈرائیور",
    authTitle: "ڈرائیور اکاؤنٹ",
    authCopy: "آن لائن ہونے اور سواری کی درخواستیں حاصل کرنے کے لیے لاگ اِن کریں۔",
    googleLogin: "Google سے لاگ ان کریں",
    emulatorNote: "Emulator · دستاویزات درکار نہیں",
    blockedTitle: "اکاؤنٹ معطل کر دیا گیا ہے۔ براہ کرم سپورٹ سے رابطہ کریں۔",
    logout: "لاگ آؤٹ",
    pinTitle: "گاڑی کا PIN درج کریں",
    pinCopy: "مالک سے ملا ہوا 4 ہندسوں کا PIN درج کریں تاکہ گاڑی آپ کے اکاؤنٹ سے منسلک ہو جائے۔",
    pinVerify: "تصدیق کریں",
    navAria: "ڈرائیور نیویگیشن",
    navHome: "ہوم",
    navDashboard: "ڈیش بورڈ",
    navRates: "کرائے کی تفصیل",
    navRatesAria: "کرائے کی مکمل تفصیل دیکھیں",
    navRides: "میری سواریاں",
    navEarnings: "کمائی",
    navWallet: "والٹ",
    navAlerts: "رائڈ کی آواز",
    alertsAria: "سواری کی آواز کی سیٹنگز",
    navChangeVehicle: "گاڑی تبدیل کریں",
    changeVehicleConfirm:
      "موجودہ گاڑی چھوڑ کر دوسری گاڑی کا PIN درج کریں؟ پہلے آپ آف لائن ہو جائیں گے۔",
    changeVehicleBlockedRide: "گاڑی تبدیل کرنے سے پہلے فعال سواری مکمل کریں۔",
    changeVehiclePinPrompt: "نئی گاڑی کا PIN درج کریں۔",
    changeVehicleFailed: "موجودہ گاڑی نہیں چھوڑی جا سکی۔ دوبارہ کوشش کریں۔",
    closeMenu: "مینو بند کریں",
    openMenu: "مینو کھولیں",
    topbarHome: "ہوم",
    statusOffline: "آف لائن",
    statusOnline: "آن لائن",
    statusToggleAria: "ڈرائیور آن لائن کریں",
    statusToggleAriaOffline: "ڈرائیور آف لائن کریں",
    rideRadar: "دستیاب سواریاں",
    language: "زبان",
    driverLabel: "ڈرائیور",
    deleteAccount: "اکاؤنٹ حذف",
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
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (!key) return;
    el.setAttribute("title", t(key));
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
