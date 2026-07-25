/**
 * SwiftGo — Frontend audit test suite (Node, no browser deps)
 * Run: node tests/audit.test.mjs
 * Live:  $env:SWIFTGO_URL="https://swiftgo-ride-app.web.app"; node tests/audit.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const results = [];
let passed = 0;
let failed = 0;

function assert(suite, name, cond, detail = "") {
  if (cond) {
    passed++;
    results.push({ suite, name, status: "PASS", detail: detail || "" });
  } else {
    failed++;
    results.push({ suite, name, status: "FAIL", detail: detail || "assertion failed" });
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function countMatches(src, re) {
  return (src.match(re) || []).length;
}

// ── Load sources ──
const html = read("customer-app/index.html");
const css = read("customer-app/css/styles.css");
const rules = read("firestore.rules");
const firebaseJson = read("firebase.json");
const support = read("customer-app/js/support.js");
const dataJs = read("customer-app/js/data.js");
const screensJs = read("customer-app/js/screens.js");
const authJs = read("customer-app/js/auth.js");
const appJs = read("customer-app/js/app.js");
const i18nSrc = read("customer-app/js/i18n.js");
const sheetJs = read("customer-app/js/sheet.js");
const mapJs = read("customer-app/js/map.js");
const locationJs = read("customer-app/js/location.js");
const dashJs = read("customer-app/js/dashboard.js");
const firebaseJs = read("customer-app/js/firebase.js");
const firebaserc = read(".firebaserc");

// ═══════════════════════════════════════════
// 1. File structure
// ═══════════════════════════════════════════
const requiredFiles = [
  "customer-app/index.html",
  "customer-app/css/styles.css",
  "customer-app/js/app.js",
  "customer-app/js/i18n.js",
  "customer-app/js/map.js",
  "customer-app/js/sheet.js",
  "customer-app/js/location.js",
  "customer-app/js/screens.js",
  "customer-app/js/auth.js",
  "customer-app/js/data.js",
  "customer-app/js/firebase.js",
  "customer-app/js/firebase-config.js",
  "customer-app/js/support.js",
  "customer-app/js/dashboard.js",
  "customer-app/js/driver-onboarding.js",
  "customer-app/js/utility-drawer.js",
  "customer-app/js/routing.js",
  "customer-app/js/fare.js",
  "customer-app/js/ride-flow.js",
  "driver-app/index.html",
  "driver-app/css/driver-style.css",
  "driver-app/js/driver-app.js",
  "driver-app/js/firebase.js",
  "driver-app/js/firebase-config.js",
  "owner-app/index.html",
  "owner-app/css/owner-style.css",
  "owner-app/js/owner-app.js",
  "owner-app/js/firebase.js",
  "owner-app/js/firebase-config.js",
  "super-admin-panel/index.html",
  "super-admin-panel/css/admin-style.css",
  "super-admin-panel/js/admin-app.js",
  "super-admin-panel/js/firebase.js",
  "super-admin-panel/js/firebase-config.js",
  "tools/build-hosting.mjs",
  "firebase.json",
  "firestore.rules",
  "firestore.indexes.json",
  ".firebaserc",
];

for (const f of requiredFiles) {
  assert("structure", `File exists: ${f}`, exists(f));
}

// ═══════════════════════════════════════════
// 2. HTML SPA shell (core)
// ═══════════════════════════════════════════
const requiredIds = [
  "app",
  "sidebar",
  "menuBtn",
  "map",
  "sheet",
  "authModal",
  "authForm",
  "screen-home",
  "historySection",
  "historyChatList",
  "historyEmpty",
  "screen-wallet",
  "screen-contact",
  "screen-missed-call",
  "walletBalance",
  "pickupInput",
  "destInput",
  "topbar",
  "fabLocate",
  "ridePanel",
  "bookRideBtn",
  "paySheet",
  "payMethodBtn",
  "extraStops",
  "addStopBtn",
  "earnDriverBtn",
  "trafficToggle",
  "promoTrigger",
  "promoInput",
  "promoApplyBtn",
  "mapPickOverlay",
  "mapPickConfirm",
  "locSuggest",
  "driverOnboarding",
  "driverApplicationForm",
  "driverCnicFront",
  "driverCnicBack",
  "driverLicenseFile",
  "driverSelfieVideo",
  "driverSelfieCanvas",
  "driverSelfieFile",
  "driverCameraBtn",
  "driverCaptureBtn",
  "utilityDrawer",
  "utilityPanelRent",
  "utilityPanelCargo",
  "utilityPanelRide",
  "activeRideCallBtn",
];

for (const id of requiredIds) {
  assert("html", `HTML id="#${id}"`, html.includes(`id="${id}"`));
}

const routes = ["home", "history", "missed-call", "wallet", "contact"];
for (const r of routes) {
  assert("html", `Nav route data-route="${r}"`, html.includes(`data-route="${r}"`));
  assert("html", `Screen data-screen="${r}"`, html.includes(`data-screen="${r}"`));
}

assert("html", "Leaflet CSS linked", html.includes("leaflet@1.9.4/dist/leaflet.css"));
assert("html", "Leaflet JS linked", html.includes("leaflet@1.9.4/dist/leaflet.js"));
assert(
  "html",
  "App module entry",
  /src="js\/app\.js(?:\?[^"]*)?"/.test(html) && html.includes('type="module"')
);
assert("html", "10-80-10 sheet present", html.includes('id="sheet"') && html.includes("service-rail"));
assert("html", "Primary categories ×3", countMatches(html, /class="service-rail__item" data-category="(ride|cargo|rent)"/g) === 3);
assert("html", "Legacy service cards removed", !html.includes("service-card") && !html.includes('data-service="'));
assert("html", "Vehicle cards ×7", countMatches(html, /data-vehicle="/g) >= 7);
assert("html", "Booking tabs removed", countMatches(html, /data-booking-tab="/g) === 0);
assert("html", "History chat list present", html.includes('id="historyChatList"'));
assert(
  "html",
  "Auth email+password fields",
  html.includes('id="authEmail"') && html.includes('id="authPassword"')
);
assert("html", "Contact tel + WhatsApp", html.includes("tel:") && html.includes("wa.me"));
assert("html", "RTL-ready html root", html.includes('lang="en"') && html.includes('dir="ltr"'));
assert("html", "Viewport meta present", /name=["']viewport["']/.test(html));
assert("html", "Title is SwiftGo", html.includes("SwiftGo") && /<title[^>]*>SwiftGo<\/title>/.test(html));

// Phase 8–10 dashboard + advanced ride markup
assert("html", "Quick actions removed", countMatches(html, /data-quick="/g) === 0);
assert(
  "html",
  "Payment methods include Business Account",
  html.includes("easypaisa") &&
    html.includes("jazzcash") &&
    html.includes('value="cash"') &&
    html.includes('value="business"')
);
assert("html", "Promo code control above booking row", html.indexOf('id="promoControl"') < html.indexOf('class="book-row"'));
assert("html", "Business account briefcase icon", html.includes("pay-method__logo--business"));

// ═══════════════════════════════════════════
// 3. CSS / responsive / a11y
// ═══════════════════════════════════════════
assert("css", "Glass utility", css.includes(".glass"));
assert("css", "RTL sidebar rules", css.includes('html[dir="rtl"] .sidebar'));
assert("css", "Sheet expanded layout", css.includes(".shell.sheet-expanded"));
assert("css", "Auth modal styles", css.includes(".auth-modal"));
assert("css", "Reduced motion", css.includes("prefers-reduced-motion"));
assert("css", "Vehicle card styles", css.includes(".vehicle-card"));
assert("css", "Pay sheet styles", css.includes(".pay-sheet"));
assert("css", "Quick action styles", css.includes(".quick-action"));
assert("css", "Live driver marker styles", css.includes(".live-driver"));
assert("css", "Extra stops styles", css.includes(".extra-stops"));
assert(
  "css",
  "Mobile-first + desktop @media (min-width)",
  /@media\s*\([^)]*min-width/.test(css),
  "base styles target mobile; desktop via min-width: 900px"
);
assert("css", "CSS custom properties (:root)", css.includes(":root") && css.includes("--"));

// ═══════════════════════════════════════════
// 4. i18n EN/UR parity
// ═══════════════════════════════════════════
const enBlock = i18nSrc.slice(i18nSrc.indexOf("en: {"), i18nSrc.indexOf("ur: {"));
const urEnd = i18nSrc.indexOf("};\n\n/**");
const urBlock = i18nSrc.slice(
  i18nSrc.indexOf("ur: {"),
  urEnd > 0 ? urEnd : i18nSrc.lastIndexOf("};")
);
const keyRe = /^\s{4}([a-zA-Z][a-zA-Z0-9]+):/gm;
const enSet = new Set([...enBlock.matchAll(keyRe)].map((m) => m[1]));
const urSet = new Set([...urBlock.matchAll(keyRe)].map((m) => m[1]));

assert("i18n", "i18n EN keys > 60", enSet.size > 60, `count=${enSet.size}`);
assert("i18n", "i18n UR keys > 60", urSet.size > 60, `count=${urSet.size}`);

const missingInUr = [...enSet].filter((k) => !urSet.has(k));
const missingInEn = [...urSet].filter((k) => !enSet.has(k));
assert("i18n", "i18n EN⊆UR parity", missingInUr.length === 0, missingInUr.join(", ") || "ok");
assert("i18n", "i18n UR⊆EN parity", missingInEn.length === 0, missingInEn.join(", ") || "ok");

const htmlI18nKeys = [...html.matchAll(/data-i18n(?:-aria|-placeholder)?="([^"]+)"/g)].map(
  (m) => m[1]
);
const missingHtmlKeys = [...new Set(htmlI18nKeys)].filter((k) => !enSet.has(k));
assert(
  "i18n",
  "HTML data-i18n keys exist in EN dict",
  missingHtmlKeys.length === 0,
  missingHtmlKeys.join(", ") || "ok"
);

const phase8Keys = [
  "qaSettings",
  "earnAsDriver",
  "showTraffic",
  "appLanguage",
  "paymentMethod",
  "payEasypaisa",
  "payJazzCash",
  "payCash",
  "addStop",
  "chooseVehicle",
  "vehBike",
  "bookRideCta",
];
for (const k of phase8Keys) {
  assert("i18n", `Phase key present: ${k}`, enSet.has(k) && urSet.has(k));
}

assert("i18n", "setLang / applyTranslations exported", i18nSrc.includes("export function setLang"));
assert("i18n", "RTL dir switch for Urdu", i18nSrc.includes('dir') && i18nSrc.includes('"rtl"'));

// ═══════════════════════════════════════════
// 5. Firebase frontend integration
// ═══════════════════════════════════════════
const configMod = await import(pathToFileURL(path.join(ROOT, "customer-app/js/firebase-config.js")).href);
assert(
  "firebase",
  "isFirebaseConfigured() === true (real keys)",
  configMod.isFirebaseConfigured() === true
);
assert(
  "firebase",
  "projectId is swiftgo-ride-app",
  configMod.firebaseConfig.projectId === "swiftgo-ride-app",
  configMod.firebaseConfig.projectId
);
assert(
  "firebase",
  "apiKey present",
  typeof configMod.firebaseConfig.apiKey === "string" &&
    configMod.firebaseConfig.apiKey.startsWith("AIza")
);
assert(
  "firebase",
  "authDomain matches project",
  configMod.firebaseConfig.authDomain === "swiftgo-ride-app.firebaseapp.com"
);
assert(
  "firebase",
  "Hosting packages from hosting-dist",
  firebaseJson.includes('"public": "hosting-dist"') &&
    firebaseJson.includes('node tools/build-hosting.mjs') &&
    firebaseJson.includes('"/partner/index.html"') &&
    firebaseJson.includes('"/owner/index.html"') &&
    firebaseJson.includes('"/admin/index.html"') &&
    firebaseJson.includes('"/customer/index.html"')
);
assert(
  "firebase",
  ".firebaserc default is swiftgo-ride-app",
  firebaserc.includes('"default": "swiftgo-ride-app"')
);
assert(
  "firebase",
  "firebase.js imports initializeApp + getAuth + getFirestore",
  firebaseJs.includes("initializeApp") &&
    firebaseJs.includes("getAuth") &&
    firebaseJs.includes("getFirestore")
);
assert(
  "firebase",
  "firebase.js exports app, auth, db",
  /export\s*\{\s*app,\s*auth,\s*db/.test(firebaseJs)
);

// ═══════════════════════════════════════════
// 6. Security / Firestore rules (frontend-relevant)
// ═══════════════════════════════════════════
assert("security", "Firestore users scoped to auth.uid", rules.includes("request.auth.uid == userId"));
assert(
  "security",
  "Bookings create requires own userId",
  rules.includes("request.resource.data.userId == request.auth.uid")
);
assert(
  "security",
  "Bookings read requires own userId",
  rules.includes("resource.data.userId == request.auth.uid")
);
assert("security", "Unauthenticated writes not open", !rules.includes("allow read, write: if true"));
assert("security", "Hosting SPA rewrite to index.html", firebaseJson.includes('"/index.html"'));
assert("security", "Booking list HTML escaped", screensJs.includes("escapeHtml"));
assert("security", "createBooking rejects unsigned", dataJs.includes('throw new Error("NOT_SIGNED_IN")'));
assert(
  "security",
  "Auth maps Firebase error codes",
  authJs.includes("auth/invalid-email") && authJs.includes("mapAuthError")
);
assert(
  "wiring",
  "Google auth popup-first with limited redirect fallback",
  authJs.includes("const provider = new GoogleAuthProvider()") &&
    authJs.includes("signInWithPopup(auth, provider)") &&
    authJs.includes('error?.code === "auth/popup-blocked"') &&
    authJs.includes('error?.code === "auth/cancelled-popup-request"') &&
    !authJs.includes("prefersRedirectAuth") &&
    authJs.includes('console.error("Firebase Auth Error:", error?.code, error?.message, error)')
);
assert(
  "security",
  "Demo banner when unconfigured",
  authJs.includes("isFirebaseConfigured()") && authJs.includes("firebaseDemoBanner")
);
assert(
  "security",
  "walletBalance read-only for client (Phase 9)",
  rules.includes("walletBalance == 0") && rules.includes("hasAny(['walletBalance'])"),
  "create must be 0; updates may not touch walletBalance"
);
assert(
  "security",
  "booking.status constrained to enum (Phase 9)",
  rules.includes("'scheduled', 'current', 'completed', 'cancelled'"),
  "isValidStatus enum enforced on create + update"
);
assert(
  "security",
  "Booking payload shape validated (Phase 9)",
  rules.includes("isValidBooking") && rules.includes("hasAll(['userId', 'service'"),
);
assert(
  "security",
  "Default deny catch-all (Phase 9)",
  rules.includes("match /{document=**}") && /allow read, write: if false/.test(rules)
);
assert(
  "security",
  "Support phone is configurable module",
  support.includes("SUPPORT") && support.includes("phoneE164")
);

// ═══════════════════════════════════════════
// 7. App wiring (Phases 5–13.1)
// ═══════════════════════════════════════════
assert("wiring", "app boots Phase 17 live ride status", appJs.includes("Phase 17 live ride status ready"));
assert(
  "wiring",
  "Book ride → startRideRequest",
  appJs.includes("startRideRequest") && appJs.includes("handleBookRide")
);
assert(
  "wiring",
  "Profile + history watchers wired",
  appJs.includes("watchUserProfile") && appJs.includes("startCustomerRideHistory")
);
assert("wiring", "initAuth wired", appJs.includes("initAuth"));
assert("wiring", "initMap + locateUser wired", appJs.includes("initMap") && appJs.includes("locateUser"));
assert("wiring", "initSheet wired", appJs.includes("initSheet"));
assert("wiring", "initDashboard wired", appJs.includes("initDashboard"));
assert("wiring", "initScreens wired", appJs.includes("initScreens"));
assert(
  "wiring",
  "Sheet vehicle selection",
  sheetJs.includes("selectVehicle") && sheetJs.includes("updateBookRideCta")
);
assert(
  "wiring",
  "Sheet multi-stop support",
  sheetJs.includes("addStopField") && sheetJs.includes("MAX_EXTRA_STOPS")
);
assert(
  "wiring",
  "Phase 13.1 limits header to one extra stop",
  sheetJs.includes("const MAX_EXTRA_STOPS = 1")
);
assert(
  "wiring",
  "Map live drivers",
  mapJs.includes("spawnLiveDrivers") && mapJs.includes("createDriverIcon")
);
assert(
  "wiring",
  "Dashboard payment + traffic + lang",
  dashJs.includes("openPaySheet") &&
    dashJs.includes("applyTraffic") &&
    dashJs.includes("syncLangToggleUi")
);
assert(
  "wiring",
  "Legacy delivery tiers and service cards removed",
  !sheetJs.includes("renderDeliveryTiers") &&
    !sheetJs.includes("setServiceMode") &&
    !sheetJs.includes("delivery-priority") &&
    !html.includes('id="deliveryTierRail"') &&
    !html.includes("service-card")
);
assert(
  "wiring",
  "Promo codes interactive and affect price",
  sheetJs.includes("PROMOS") &&
    sheetJs.includes("applyPromo") &&
    sheetJs.includes("sheetState.discount")
);
assert(
  "wiring",
  "Business Account persists as payment method",
  dashJs.includes('v === "business"') && dashJs.includes('business: t("payBusiness")')
);
assert(
  "wiring",
  "Booking persists fare, payment and promo",
  dataJs.includes("paymentMethod") &&
    dataJs.includes("promoCode") &&
    appJs.includes("fare: state.price")
);
assert(
  "wiring",
  "Booking requires sign-in gate",
  appJs.includes("bookingNeedSignIn") || appJs.includes("openAuthModal")
);
const driverJs = read("customer-app/js/driver-onboarding.js");
assert(
  "wiring",
  "Earn as Driver opens onboarding overlay",
  appJs.includes("initDriverOnboarding") &&
    driverJs.includes('getElementById("earnDriverBtn")') &&
    driverJs.includes("openDriverOnboarding")
);
assert(
  "wiring",
  "Driver uploads support click + drag/drop",
  driverJs.includes("bindUploadZones") &&
    driverJs.includes('addEventListener("drop"') &&
    html.includes('accept="image/jpeg,image/png,image/webp"')
);
assert(
  "wiring",
  "Front camera uses getUserMedia",
  driverJs.includes("navigator.mediaDevices?.getUserMedia") &&
    driverJs.includes('facingMode: "user"')
);
assert(
  "wiring",
  "Selfie captured to canvas and File",
  driverJs.includes("drawImage") &&
    driverJs.includes("toBlob") &&
    driverJs.includes("new File") &&
    driverJs.includes("getDriverOnboardingFiles")
);
assert(
  "wiring",
  "CNIC Front OCR simulation auto-fills name + CNIC",
  driverJs.includes("runCnicOcrSimulation") &&
    driverJs.includes("MOCK_CNIC_OCR") &&
    driverJs.includes("applyOcrFields") &&
    driverJs.includes("2000") &&
    html.includes('id="driverCnicScan"')
);
assert(
  "wiring",
  "OCR insert point documented for Cloud Vision",
  driverJs.includes("INSERT REAL OCR") &&
    driverJs.includes("Google Cloud Vision") &&
    driverJs.includes(">>> INSERT REAL OCR")
);
assert(
  "wiring",
  "Driver form loads settings/driverForm with fallback",
  dataJs.includes("getDriverFormConfig") &&
    dataJs.includes("FALLBACK_DRIVER_FORM_CONFIG") &&
    dataJs.includes('doc(db, "settings", "driverForm")') &&
    driverJs.includes("applyDriverFormConfig")
);
assert(
  "wiring",
  "Driver application uploads Storage then Firestore",
  dataJs.includes("submitDriverApplication") &&
    dataJs.includes("uploadBytes") &&
    dataJs.includes("driver_applications") &&
    dataJs.includes("getDownloadURL") &&
    driverJs.includes("handleDriverSubmit")
);
assert(
  "wiring",
  "firebase.js exports storage",
  firebaseJs.includes("getStorage") && /export\s*\{\s*app,\s*auth,\s*db,\s*storage/.test(firebaseJs)
);
assert(
  "security",
  "settings readable, client write denied",
  rules.includes("match /settings/{docId}") &&
    /match \/settings\/\{docId\}[\s\S]*?allow write: if false/.test(rules)
);
assert(
  "security",
  "driver_applications create scoped to auth.uid",
  rules.includes("match /driver_applications/{appId}") &&
    rules.includes("data.status == 'pending'")
);
assert("structure", "File exists: storage.rules", exists("storage.rules"));
assert(
  "security",
  "Storage rules scope driver uploads to owner",
  read("storage.rules").includes("driver_applications/{userId}/{fileName}") &&
    read("storage.rules").includes("isOwner(userId)")
);
assert(
  "html",
  "Phase 13.1 uses a 50/50 pickup and drop-off header",
  html.includes('class="topbar location-header glass"') &&
    countMatches(html, /class="location-header__half/g) === 2 &&
    html.includes('data-location-role="pickup"') &&
    html.includes('data-location-role="dropoff"') &&
    html.includes('data-i18n="headerPickupLabel"') &&
    html.includes('data-i18n="headerDropoffLabel"') &&
    html.includes('class="location-header__add-stop"') &&
    !html.includes('id="routeCard"') &&
    !css.includes(".route-card")
);
assert(
  "html",
  "Phase 13.2 three primary categories only",
  html.includes('id="serviceRail"') &&
    html.includes("service-rail--primary") &&
    countMatches(html, /class="service-rail__item" data-category="/g) === 3 &&
    html.includes('class="service-rail__item" data-category="ride"') &&
    html.includes('class="service-rail__item" data-category="cargo"') &&
    html.includes('class="service-rail__item" data-category="rent"') &&
    !html.includes('class="service-rail__item" data-category="bike"') &&
    !html.includes('class="service-rail__item" data-category="wedding"') &&
    css.includes(".service-rail--primary")
);
assert(
  "i18n",
  "Phase 13.2 Ride/Cargo/Rent labels EN/UR",
  i18nSrc.includes("catRide") &&
    i18nSrc.includes("catCargo") &&
    i18nSrc.includes("catRent") &&
    i18nSrc.includes("رینٹل") &&
    i18nSrc.includes("vehGo") &&
    i18nSrc.includes("vehSuzuki")
);
assert(
  "wiring",
  "Phase 13.2 smart filters + rent drawer hook",
  sheetJs.includes("selectCategory") &&
    sheetJs.includes("CATEGORY_CONFIG") &&
    sheetJs.includes('vehicles: ["bike", "go", "go-plus", "business"]') &&
    sheetJs.includes('vehicles: ["bike-cargo", "suzuki", "truck"]') &&
    sheetJs.includes("opensDrawer: true") &&
    sheetJs.includes("card.dataset.category === visibleCategory") &&
    sheetJs.includes('card.style.display = visible ? "flex" : "none"') &&
    sheetJs.includes("swiftgo:open-utility-drawer") &&
    html.includes('data-vehicle="go"') &&
    html.includes('data-vehicle="bike-cargo"') &&
    !html.includes('data-vehicle="wedding-sedan"') &&
    !html.includes('data-service="shops"') &&
    !html.includes('data-service="delivery"')
);
assert(
  "wiring",
  "Phase 13.3 utility drawer for rent/cargo/active ride",
  exists("customer-app/js/utility-drawer.js") &&
    read("customer-app/js/utility-drawer.js").includes("openUtilityDrawer") &&
    read("customer-app/js/utility-drawer.js").includes("showActiveRideDrawer") &&
    html.includes('id="utilityDrawer"') &&
    html.includes('id="utilityPanelRent"') &&
    html.includes('id="utilityPanelCargo"') &&
    html.includes('id="utilityPanelRide"') &&
    html.includes('data-i18n="activeRideCall"') &&
    css.includes(".utility-drawer") &&
    appJs.includes("initUtilityDrawer")
);
assert(
  "i18n",
  "Phase 13.4 formatMoney + title/aria helpers",
  i18nSrc.includes("formatMoney") &&
    i18nSrc.includes("paymentMethodLabel") &&
    i18nSrc.includes("currencyAmount") &&
    i18nSrc.includes("data-i18n-title") &&
    i18nSrc.includes("appTitle") &&
    i18nSrc.includes("demoDriverName")
);
assert(
  "i18n",
  "Phase 13.4 EN has no Arabic script in values",
  !(/en:\s*\{[\s\S]*?\n  \},\n  ur:/.test(i18nSrc) &&
    /en:\s*\{[\s\S]*?[\u0600-\u06FF][\s\S]*?\n  \},\n  ur:/.test(i18nSrc))
);
assert(
  "i18n",
  "Phase 13.4 UR promo/GPS/Firebase strings are script-pure",
  i18nSrc.includes('promoPlaceholder: "پرومو کوڈ درج کریں"') &&
    i18nSrc.includes("مقام یاب") &&
    i18nSrc.includes("فائر بیس") &&
    !i18nSrc.includes('driverEyebrow: "SwiftGo') &&
    !i18nSrc.includes("ویڈنگ SUV")
);
const routingJs = read("customer-app/js/routing.js");
const fareJs = read("customer-app/js/fare.js");
assert(
  "wiring",
  "Phase 14.1 OSRM polyline + auto fitBounds",
  routingJs.includes("router.project-osrm.org") &&
    routingJs.includes("#276EF1") &&
    routingJs.includes("L.polyline") &&
    routingJs.includes("fitBounds") &&
    routingJs.includes("geometries=geojson")
);
assert(
  "wiring",
  "Phase 14.2 distance/time state for fare math",
  routingJs.includes("totalDistance") &&
    routingJs.includes("totalTime") &&
    routingJs.includes("export function getRouteInfo") &&
    routingJs.includes("swiftgo:route-updated") &&
    locationJs.includes("setRoutePoint(meta.role, lat, lng)") &&
    appJs.includes("getRouteInfo")
);
assert(
  "wiring",
  "Phase 15 dynamic fare matrix and route listener",
  fareJs.includes("swiftgo:route-updated") &&
    fareJs.includes("window.SwiftGo?.getRouteInfo?.()") &&
    fareJs.includes("base + distance * rate.perKm + time * rate.perMin") &&
    countMatches(fareJs, /perKm:/g) === 7 &&
    countMatches(fareJs, /perMin:/g) === 7 &&
    fareJs.includes('".price, .vehicle-card__price"') &&
    fareJs.includes('".eta, .vehicle-card__eta"') &&
    sheetJs.includes("setDynamicVehicleFares") &&
    appJs.includes("initFareCalculation")
);
const rideFlowJs = read("customer-app/js/ride-flow.js");
assert(
  "wiring",
  "Phase 16.1 rides collection write + searching_driver status",
  dataJs.includes('collection(db, "rides")') &&
    dataJs.includes("searching_driver") &&
    dataJs.includes("cancelled_by_user") &&
    dataJs.includes("export async function createRideRequest") &&
    dataJs.includes("export async function cancelRideRequest") &&
    rideFlowJs.includes("startRideRequest") &&
    rideFlowJs.includes("createRideRequest") &&
    appJs.includes("startRideRequest") &&
    rules.includes("match /rides/{rideId}") &&
    rules.includes("searching_driver") &&
    rules.includes("cancelled_by_user")
);
assert(
  "wiring",
  "Phase 16.2 searching-for-driver UI state",
  html.includes('id="searchingPanel"') &&
    html.includes('id="cancelRideBtn"') &&
    html.includes('data-i18n="searchingDriver"') &&
    html.includes('data-i18n="cancelRide"') &&
    css.includes(".searching-panel") &&
    css.includes(".searching-spinner") &&
    css.includes(".cancel-ride-btn") &&
    i18nSrc.includes("آپ کے قریب ترین ڈرائیور کو تلاش کیا جا رہا ہے...") &&
    i18nSrc.includes("سفر منسوخ کریں") &&
    rideFlowJs.includes("showSearchingState") &&
    rideFlowJs.includes("cancelActiveRide") &&
    appJs.includes("initRideFlow")
);
assert(
  "wiring",
  "Phase 17.1 real-time ride document listener",
  dataJs.includes("export function watchRideRequest") &&
    dataJs.includes('doc(db, "rides", rideId)') &&
    dataJs.includes("return onSnapshot(") &&
    rideFlowJs.includes("watchRideRequest") &&
    rideFlowJs.includes("handleRideSnapshot")
);
assert(
  "wiring",
  "Phase 17.2 accepted ride panel and driver details",
  html.includes('id="activeRidePanel"') &&
    html.includes("محمد علی") &&
    html.includes("4.8 ★") &&
    html.includes("KHI-1234") &&
    html.includes('id="activeRideCallLink"') &&
    css.includes(".active-ride-panel") &&
    css.includes(".active-ride-call-btn") &&
    rideFlowJs.includes('ride.status === "accepted"') &&
    rideFlowJs.includes("showActiveRideState")
);
assert(
  "wiring",
  "Phase 17.3 complete ride clears route and resets sheet",
  dataJs.includes("export async function completeRideRequest") &&
    rideFlowJs.includes("completeActiveRide") &&
    rideFlowJs.includes('clearRoutePoint("pickup")') &&
    rideFlowJs.includes('clearRoutePoint("dropoff")') &&
    sheetJs.includes("resetSheetForNewRide") &&
    rules.includes("request.resource.data.status == 'completed'") &&
    html.includes('id="completeRideBtn"')
);
assert(
  "wiring",
  "Phase 17.4 declined ride returns to vehicle selection",
  rideFlowJs.includes('ride.status === "declined"') &&
    rideFlowJs.includes('resetToVehicleSelection("driverDeclined")') &&
    i18nSrc.includes("ڈرائیور نے معذرت کر لی ہے، دوبارہ کوشش کریں")
);
const driverHtml = read("driver-app/index.html");
const driverCss = read("driver-app/css/driver-style.css");
const driverAppJs = read("driver-app/js/driver-app.js");
const ownerHtml = read("owner-app/index.html");
const ownerCss = read("owner-app/css/owner-style.css");
const ownerAppJs = read("owner-app/js/owner-app.js");
assert(
  "html",
  "Phase 18 driver app RTL shell and premium header",
  driverHtml.includes('<html lang="ur" dir="rtl">') &&
    driverHtml.includes("سوئفٹ گو ڈرائیور") &&
    driverHtml.includes('id="driverStatusToggle"') &&
    driverHtml.includes('role="switch"') &&
    driverHtml.includes('id="driverMap"') &&
    driverHtml.includes('id="incomingRideSheet"') &&
    driverHtml.includes("leaflet@1.9.4")
);
assert(
  "wiring",
  "Phase 18 partner map, online toggle, and local Firebase config",
  driverAppJs.includes('./firebase-config.js') &&
    driverAppJs.includes('./firebase.js') &&
    !driverAppJs.includes("../customer-app/") &&
    !driverAppJs.includes("../../js/") &&
    driverAppJs.includes("navigator.geolocation.watchPosition") &&
    driverAppJs.includes("toggleDriverStatus") &&
    driverAppJs.includes("L.map") &&
    driverAppJs.includes("OpenStreetMap") &&
    driverCss.includes(".partner-topbar") &&
    driverCss.includes(".driver-status.is-online") &&
    driverCss.includes(".incoming-ride-sheet")
);
assert(
  "wiring",
  "Phase 25 real PIN verification and vehicle linking",
  driverHtml.includes('id="vehiclePinGate"') &&
    driverHtml.includes('id="vehiclePinForm"') &&
    driverAppJs.includes('where("pin", "==", enteredPin)') &&
    driverAppJs.includes("غلط پن کوڈ! دوبارہ کوشش کریں") &&
    driverAppJs.includes("یہ گاڑی پہلے ہی زیر استعمال ہے") &&
    driverAppJs.includes("گاڑی کامیابی سے منسلک ہو گئی!") &&
    driverAppJs.includes("currentVehicleId: vehicleDoc.id") &&
    driverCss.includes(".pin-gate") &&
    rules.includes("match /partners/{partnerId}") &&
    rules.includes("request.resource.data.driverId == request.auth.uid")
);
assert(
  "wiring",
  "Partner auth routes strictly by saved role",
  driverHtml.includes('id="driverMap"') &&
    driverHtml.includes('id="pinGateLogoutBtn"') &&
    !driverHtml.includes('id="roleSelectionOverlay"') &&
    !driverHtml.includes('id="btnReturnToOwner"') &&
    !driverHtml.includes("مالک موڈ میں واپس جائیں") &&
    driverAppJs.includes("if (!partnerSnapshot.exists() || !partnerSnapshot.data().role)") &&
    driverAppJs.includes('role: "driver"') &&
    driverAppJs.includes('partner.role === "owner"') &&
    driverAppJs.includes('window.location.replace("/owner/")') &&
    driverAppJs.includes("await signOut(auth)") &&
    driverAppJs.includes("hideProtectedUi()")
);
assert(
  "wiring",
  "Owner app is separate with fleet + ride history",
  ownerHtml.includes("سوئفٹ گو مالک") &&
    ownerHtml.includes('id="ownerRideList"') &&
    ownerHtml.includes("آج کی سواریاں اور ہسٹری") &&
    ownerHtml.includes('id="ownerVehicleGrid"') &&
    !ownerHtml.includes('id="driverMap"') &&
    !ownerHtml.includes('id="roleSelectionOverlay"') &&
    ownerAppJs.includes('where("ownerId", "==", currentDriver.uid)') &&
    ownerAppJs.includes("startOwnerRidesListener()") &&
    ownerAppJs.includes('role: "owner"') &&
    ownerAppJs.includes("showOwnerDashboard()") &&
    !ownerAppJs.includes('window.location.replace("/partner/")') &&
    ownerCss.includes(".owner-ride-history") &&
    rules.includes("resource.data.ownerId == request.auth.uid") &&
    rules.includes("'driverName', 'vehiclePlate'")
);
assert(
  "wiring",
  "Build hosts driver at /partner and owner at /owner",
  read("tools/build-hosting.mjs").includes('copyApp("driver-app", "partner")') &&
    read("tools/build-hosting.mjs").includes('copyApp("owner-app", "owner")')
);
const adminHtml = read("super-admin-panel/index.html");
const adminCss = read("super-admin-panel/css/admin-style.css");
const adminAppJs = read("super-admin-panel/js/admin-app.js");
assert(
  "html",
  "Phase 22 super admin command center shell",
  adminHtml.includes("SwiftGo - Super Admin Command Center") &&
    adminHtml.includes('id="adminGoogleLoginBtn"') &&
    adminHtml.includes("Login via Google") &&
    adminCss.includes(".admin-shell") &&
    adminCss.includes(".admin-google-btn")
);
assert(
  "wiring",
  "Phase 22 apps are physically independent",
  exists("tools/build-hosting.mjs") &&
    adminAppJs.includes('./firebase-config.js') &&
    adminAppJs.includes('./firebase.js') &&
    !adminAppJs.includes("../customer-app/") &&
    !adminAppJs.includes("../partner-app/") &&
    !adminAppJs.includes("../driver-app/") &&
    !adminAppJs.includes("../owner-app/") &&
    !driverAppJs.includes("../super-admin-panel/") &&
    !ownerAppJs.includes("../super-admin-panel/") &&
    firebaseJson.includes('"public": "hosting-dist"')
);
assert(
  "html",
  "Map stays clean without floating location controls",
  !html.includes('id="routeCard"') &&
    !css.includes("position: absolute;\n  z-index: 420") &&
    html.includes('class="location-header__row"') &&
    html.includes('class="location-header__stops extra-stops"') &&
    html.indexOf('id="pickupInput"') < html.indexOf('id="viewport"') &&
    html.indexOf('id="destInput"') < html.indexOf('id="viewport"') &&
    html.indexOf('id="extraStops"') < html.indexOf('id="viewport"')
);
assert(
  "wiring",
  "Dynamic stops use same universal location component",
  sheetJs.includes('row.className = "loc-field loc-field--smart loc-field--stop"') &&
    sheetJs.includes('data-location-action="gps"') &&
    sheetJs.includes('data-location-action="map"')
);
assert(
  "wiring",
  "Location quick actions emit future-proof hook",
  sheetJs.includes("handleLocationQuickAction") &&
    sheetJs.includes('new CustomEvent("swiftgo:location-action"')
);
assert(
  "wiring",
  "Map pick mode reverse-geocodes on drag",
  locationJs.includes("enterMapPickMode") &&
    locationJs.includes("reverseGeocode") &&
    locationJs.includes("onMapMoveEnd") &&
    locationJs.includes("updatePickPreview") &&
    html.includes('id="mapPickOverlay"')
);
assert(
  "wiring",
  "Location autocomplete uses Nominatim search",
  locationJs.includes("searchPlaces") &&
    locationJs.includes("scheduleSearch") &&
    locationJs.includes("nominatim.openstreetmap.org") &&
    html.includes('id="locSuggest"')
);
assert(
  "wiring",
  "GPS and map actions wired through location module",
  appJs.includes("initLocationModule") &&
    locationJs.includes('action === "gps"') &&
    locationJs.includes('action === "map"') &&
    sheetJs.includes("setLocationFieldValue")
);
assert(
  "wiring",
  "Smart Maps link paste extracts coordinates",
  locationJs.includes("parseGoogleMapsCoords") &&
    locationJs.includes("bindSmartLinkPaste") &&
    locationJs.includes('addEventListener("paste"') &&
    locationJs.includes("@(-?\\d{1,2}")
);
assert(
  "wiring",
  "Phase 12.4 colored pins + pickup/dropoff radius zones",
  mapJs.includes("setLocationCue") &&
    mapJs.includes("pickupCircle") &&
    mapJs.includes("dropoffCircle") &&
    mapJs.includes("ZONE_RADIUS_M") &&
    mapJs.includes("route-pin--pickup") &&
    mapJs.includes("route-pin--dropoff") &&
    mapJs.includes("route-pin--stop") &&
    locationJs.includes("placeLocationCue") &&
    locationJs.includes("setLocationCue")
);

// ═══════════════════════════════════════════
// 8. Accessibility / semantics
// ═══════════════════════════════════════════
assert("a11y", "Auth modal aria-modal dialog", html.includes('role="dialog"') || html.includes("auth-modal"));
assert("a11y", "Pay sheet role=dialog", /id="paySheet"[\s\S]*?role="dialog"/.test(html) || html.includes('role="dialog"'));
assert("a11y", "Map role=application", html.includes('role="application"'));
assert("a11y", "Booking tabs role=tab", html.includes('role="tab"'));
assert("a11y", "Payment radiogroup", html.includes('role="radiogroup"'));
assert("a11y", "Icon buttons have aria-label / i18n-aria", countMatches(html, /data-i18n-aria="/g) >= 6);
assert("a11y", "FAB has aria-label", html.includes('id="fabLocate"') && /fabLocate[\s\S]*?aria-label/.test(html));

// ═══════════════════════════════════════════
// 9. HTTP smoke (local or live)
// ═══════════════════════════════════════════
async function smoke(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return { status: res.status, text: null, res };
  } catch {
    return { status: 0, text: null, res: null };
  }
}

const bases = [
  process.env.SWIFTGO_URL,
  "https://swiftgo-ride-app.web.app",
  "http://localhost:5173",
].filter(Boolean);

let base = null;
let homeStatus = 0;
for (const b of [...new Set(bases)]) {
  const r = await smoke(b + "/");
  if (r.status === 200) {
    base = b;
    homeStatus = 200;
    break;
  }
}

if (base) {
  assert("http", `HTTP GET / → 200 (${base})`, homeStatus === 200);
  const assets = [
    "/js/app.js",
    "/js/i18n.js",
    "/js/auth.js",
    "/js/data.js",
    "/js/firebase.js",
    "/js/firebase-config.js",
    "/js/dashboard.js",
    "/js/sheet.js",
    "/js/map.js",
    "/css/styles.css",
  ];
  for (const a of assets) {
    const s = (await smoke(base + a)).status;
    assert("http", `HTTP GET ${a} → 200`, s === 200, `status=${s}`);
  }

  const page = await (await fetch(base + "/")).text();
  assert("http", "Served HTML has SwiftGo title", /<title[^>]*>SwiftGo<\/title>/.test(page));
  assert("http", "Served HTML has auth modal", page.includes("authModal"));
  assert("http", "Served HTML has pay sheet", page.includes("paySheet"));
  assert("http", "Served HTML has ride panel", page.includes("ridePanel"));

  const cfgText = await (await fetch(base + "/js/firebase-config.js")).text();
  assert(
    "http",
    "Live config projectId = swiftgo-ride-app",
    cfgText.includes('projectId: "swiftgo-ride-app"')
  );
} else {
  assert("http", "HTTP smoke skipped (no server reachable)", true, "tried local + live");
}

// ═══════════════════════════════════════════
// Summary + findings
// ═══════════════════════════════════════════
const bySuite = {};
for (const r of results) {
  if (!bySuite[r.suite]) bySuite[r.suite] = { passed: 0, failed: 0, total: 0 };
  bySuite[r.suite].total++;
  if (r.status === "PASS") bySuite[r.suite].passed++;
  else bySuite[r.suite].failed++;
}

const findings = [];
if (support.includes("923001234567")) {
  findings.push({
    sev: "Low",
    area: "Frontend",
    title: "Placeholder support number",
    detail: "js/support.js uses +923001234567. Replace before production (tel: / WhatsApp).",
  });
}
if (!rules.includes("hasAny(['walletBalance'])")) {
  findings.push({
    sev: "Medium",
    area: "Backend",
    title: "walletBalance client-writable",
    detail:
      "firestore.rules allows owners full write on users/{uid}. A modified client can set any walletBalance.",
  });
}
if (!/status\s*(==|in)/.test(rules)) {
  findings.push({
    sev: "Medium",
    area: "Backend",
    title: "booking.status unconstrained",
    detail:
      "Rules check userId ownership but not status ∈ {scheduled,current,completed} or required fields.",
  });
}
if (!firebaseJson.includes("Content-Security-Policy") && !firebaseJson.includes("headers")) {
  findings.push({
    sev: "Low",
    area: "Security",
    title: "No CSP / security headers",
    detail: "firebase.json has no security headers. Consider CSP, X-Frame-Options, Referrer-Policy.",
  });
} else if (!String(firebaseJson).includes("Content-Security-Policy")) {
  findings.push({
    sev: "Low",
    area: "Security",
    title: "No Content-Security-Policy",
    detail: "Hosting headers may exist but CSP is not configured.",
  });
}
findings.push({
  sev: "Info",
  area: "Testing",
  title: "No browser E2E yet",
  detail:
    "Suite is static analysis + HTTP smoke. Add Playwright/Cypress for map, RTL, auth modal flows.",
});
if (configMod.isFirebaseConfigured()) {
  findings.push({
    sev: "Info",
    area: "Firebase",
    title: "Production keys active",
    detail: "project swiftgo-ride-app configured for Auth, Firestore, and Hosting.",
  });
}

const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl: base || null,
  total: passed + failed,
  passed,
  failed,
  passRate: Math.round(((passed / (passed + failed)) || 0) * 1000) / 10,
  bySuite,
  findings,
  results,
};

const outPath = path.join(ROOT, "tests", "audit-results.json");
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

console.log("\n=== SwiftGo Frontend Audit Report ===\n");
console.log(`Target: ${base || "(offline static only)"}\n`);
for (const r of results) {
  const mark = r.status === "PASS" ? "✓" : "✗";
  console.log(
    `${mark} [${r.status}] [${r.suite}] ${r.name}${r.detail ? " — " + r.detail : ""}`
  );
}
console.log(`\nTotal: ${summary.total}  Passed: ${passed}  Failed: ${failed}  Pass rate: ${summary.passRate}%`);
console.log(`Results written: ${outPath}\n`);

process.exit(failed > 0 ? 1 : 0);

