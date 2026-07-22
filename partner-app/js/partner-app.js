/** Phase 18–25 — Partner app location, auth, incoming rides, and vehicle PIN linking. */

import { firebaseConfig } from "./firebase-config.js";
import { getFirebase, isFirebaseConfigured } from "./firebase.js";
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const KARACHI = [24.8607, 67.0011];

const els = {
  app: document.querySelector(".driver-app"),
  authOverlay: document.getElementById("driverAuthOverlay"),
  googleLoginBtn: document.getElementById("driverGoogleLoginBtn"),
  authStatus: document.getElementById("driverAuthStatus"),
  header: document.getElementById("partnerHeader"),
  modeSwitch: document.getElementById("partnerModeSwitch"),
  mapElement: document.getElementById("driverMap"),
  statusToggle: document.getElementById("driverStatusToggle"),
  statusText: document.getElementById("driverStatusText"),
  locationState: document.getElementById("locationState"),
  requestSheet: document.getElementById("incomingRideSheet"),
  pickup: document.getElementById("incomingPickup"),
  dropoff: document.getElementById("incomingDropoff"),
  distance: document.getElementById("incomingDistance"),
  time: document.getElementById("incomingTime"),
  fare: document.getElementById("incomingFare"),
  acceptBtn: document.getElementById("acceptRideBtn"),
  declineBtn: document.getElementById("declineRideBtn"),
  ownerDashboard: document.getElementById("ownerDashboard"),
  ownerVehicleGrid: document.getElementById("ownerVehicleGrid"),
  ownerVehicleEmpty: document.getElementById("ownerVehicleEmpty"),
  ownerVehicleCount: document.getElementById("ownerVehicleCount"),
  ownerOnlineCount: document.getElementById("ownerOnlineCount"),
  ownerOfflineCount: document.getElementById("ownerOfflineCount"),
  ownerMessage: document.getElementById("ownerDashboardMessage"),
  ownerRideList: document.getElementById("ownerRideList"),
  ownerRideEmpty: document.getElementById("ownerRideEmpty"),
  ownerRideCount: document.getElementById("ownerRideCount"),
  ownerRideMessage: document.getElementById("ownerRideHistoryMessage"),
  addVehicleBtn: document.getElementById("addVehicleBtn"),
  vehicleModal: document.getElementById("vehicleModal"),
  vehicleModalBackdrop: document.getElementById("vehicleModalBackdrop"),
  vehicleModalClose: document.getElementById("vehicleModalClose"),
  vehicleForm: document.getElementById("vehicleForm"),
  vehicleModelInput: document.getElementById("vehicleModelInput"),
  vehiclePlateInput: document.getElementById("vehiclePlateInput"),
  vehicleFormMessage: document.getElementById("vehicleFormMessage"),
  vehicleSaveBtn: document.getElementById("vehicleSaveBtn"),
  pinGate: document.getElementById("vehiclePinGate"),
  pinForm: document.getElementById("vehiclePinForm"),
  pinInput: document.getElementById("vehiclePinInput"),
  pinMessage: document.getElementById("vehiclePinMessage"),
  pinVerifyBtn: document.getElementById("vehiclePinVerifyBtn"),
  roleOverlay: document.getElementById("roleSelectionOverlay"),
  roleMessage: document.getElementById("roleSelectionMessage"),
  selectDriverRoleBtn: document.getElementById("selectDriverRoleBtn"),
  selectOwnerRoleBtn: document.getElementById("selectOwnerRoleBtn"),
  roleLogoutBtn: document.getElementById("roleSelectionLogoutBtn"),
  pinLogoutBtn: document.getElementById("pinGateLogoutBtn"),
};

let map = null;
let locationMarker = null;
let accuracyCircle = null;
let watchId = null;
let online = false;
let hasCenteredOnDriver = false;
let currentDriver = null;
let activeRequest = null;
let hideSheetTimer = null;
let unsubscribeRides = () => {};
let unsubscribeVehicles = () => {};
let unsubscribeOwnerRides = () => {};
let authSequence = 0;
let partnerMode = null;
let ownerVehicles = [];
let ownerRides = [];
let linkedVehicle = null;

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

function initMap() {
  if (typeof L === "undefined") {
    setLocationMessage("نقشہ لوڈ نہیں ہو سکا");
    return;
  }

  map = L.map("driverMap", {
    zoomControl: false,
    attributionControl: true,
  }).setView(KARACHI, 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  L.control.zoom({ position: "bottomleft" }).addTo(map);
}

function setLocationMessage(message) {
  if (els.locationState) els.locationState.textContent = message;
}

function setAuthStatus(message = "") {
  if (els.authStatus) els.authStatus.textContent = message;
}

function setLoginBusy(busy) {
  if (!els.googleLoginBtn) return;
  els.googleLoginBtn.disabled = busy;
  const label = els.googleLoginBtn.querySelector("span");
  if (label) {
    label.textContent = busy ? "اکاؤنٹ تیار کیا جا رہا ہے..." : "Google سے لاگ ان کریں";
  }
}

function showAuthOverlay(message = "") {
  if (!els.authOverlay) return;
  els.authOverlay.hidden = false;
  requestAnimationFrame(() => els.authOverlay?.classList.remove("is-hidden"));
  setAuthStatus(message);
}

function hideAuthOverlay() {
  els.authOverlay?.classList.add("is-hidden");
  window.setTimeout(() => {
    if (els.authOverlay?.classList.contains("is-hidden")) {
      els.authOverlay.hidden = true;
    }
  }, 340);
}

async function ensureDevDriverProfile(user) {
  const { db } = getFirebase();
  const driverRef = doc(db, "drivers", user.uid);
  const snapshot = await getDoc(driverRef);
  if (snapshot.exists()) return snapshot.data();

  const profile = {
    uid: user.uid,
    name: user.displayName || "SwiftGo Driver",
    email: user.email || "",
    isApproved: true,
    vehicleType: "گو",
    createdAt: serverTimestamp(),
  };
  await setDoc(driverRef, profile);
  return profile;
}

async function activateAuthenticatedDriver(user) {
  const sequence = ++authSequence;
  setLoginBusy(true);
  setAuthStatus("پارٹنر پروفائل لوڈ کیا جا رہا ہے...");
  currentDriver = user;
  hideProtectedUi();

  try {
    const { db } = getFirebase();
    const partnerSnapshot = await getDoc(doc(db, "partners", user.uid));
    if (sequence !== authSequence) return;

    hideAuthOverlay();
    setLoginBusy(false);
    setAuthStatus("");

    if (!partnerSnapshot.exists() || !partnerSnapshot.data().role) {
      showRoleSelection();
      return;
    }

    const partner = partnerSnapshot.data();
    if (partner.role === "owner") {
      showOwnerDashboard();
      return;
    }

    if (partner.role === "driver") {
      await routeDriver(partner.currentVehicleId || null, sequence);
      return;
    }

    showRoleSelection("محفوظ کردار درست نہیں ہے، دوبارہ منتخب کریں۔");
  } catch (error) {
    console.warn("[SwiftGo Partner] auth routing", error);
    if (sequence !== authSequence) return;
    hideAuthOverlay();
    setLoginBusy(false);
    showRoleSelection("پروفائل لوڈ نہیں ہو سکا، دوبارہ کوشش کریں۔");
  }
}

/* ── Phase 25: real vehicle PIN verification ── */

function hideProtectedUi() {
  setDriverOffline("");
  stopVehiclesListener();
  stopOwnerRidesListener();
  hidePinGate();
  hideRoleSelection();
  if (els.header) els.header.hidden = true;
  if (els.modeSwitch) els.modeSwitch.hidden = true;
  if (els.mapElement) els.mapElement.hidden = true;
  if (els.locationState) els.locationState.hidden = true;
  if (els.ownerDashboard) els.ownerDashboard.hidden = true;
  els.app?.classList.remove("is-owner-mode");
}

function setRoleMessage(message = "") {
  if (els.roleMessage) els.roleMessage.textContent = message;
}

function showRoleSelection(message = "") {
  hideProtectedUi();
  if (!els.roleOverlay) return;
  els.roleOverlay.hidden = false;
  requestAnimationFrame(() => els.roleOverlay?.classList.remove("is-hidden"));
  setRoleMessage(message);
}

function hideRoleSelection() {
  els.roleOverlay?.classList.add("is-hidden");
  if (els.roleOverlay) els.roleOverlay.hidden = true;
}

function showOwnerDashboard() {
  hideProtectedUi();
  partnerMode = "owner";
  els.app?.classList.add("is-owner-mode");
  if (els.header) els.header.hidden = false;
  if (els.ownerDashboard) els.ownerDashboard.hidden = false;
  startVehiclesListener();
  startOwnerRidesListener();
}

function showDriverMap() {
  hideProtectedUi();
  partnerMode = "driver";
  if (els.header) els.header.hidden = false;
  if (els.mapElement) els.mapElement.hidden = false;
  if (els.locationState) els.locationState.hidden = false;
  setLocationMessage(
    `گاڑی منسلک ہے: ${linkedVehicle?.model || ""} (${linkedVehicle?.plate || "—"}) — آن لائن ہو کر سواری حاصل کریں`
  );
  requestAnimationFrame(() => map?.invalidateSize());
}

async function routeDriver(vehicleId, sequence = authSequence) {
  partnerMode = "driver";
  linkedVehicle = null;
  if (!vehicleId) {
    showPinGate();
    return;
  }

  const { db } = getFirebase();
  const vehicleSnapshot = await getDoc(doc(db, "vehicles", vehicleId));
  if (sequence !== authSequence) return;

  if (!vehicleSnapshot.exists()) {
    showPinGate("منسلک گاڑی دستیاب نہیں، نیا PIN درج کریں۔");
    return;
  }

  linkedVehicle = { id: vehicleSnapshot.id, ...vehicleSnapshot.data() };
  showDriverMap();
}

async function selectPartnerRole(role) {
  const user = currentDriver;
  if (!user || !["owner", "driver"].includes(role)) return;

  setRoleMessage("");
  if (els.selectDriverRoleBtn) els.selectDriverRoleBtn.disabled = true;
  if (els.selectOwnerRoleBtn) els.selectOwnerRoleBtn.disabled = true;
  try {
    const { db } = getFirebase();
    await setDoc(
      doc(db, "partners", user.uid),
      {
        uid: user.uid,
        role,
        currentVehicleId: null,
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );
    hideRoleSelection();
    if (role === "owner") showOwnerDashboard();
    else showPinGate();
  } catch (error) {
    console.warn("[SwiftGo Partner] save role", error);
    setRoleMessage("کردار محفوظ نہیں ہو سکا، دوبارہ کوشش کریں۔");
  } finally {
    if (els.selectDriverRoleBtn) els.selectDriverRoleBtn.disabled = false;
    if (els.selectOwnerRoleBtn) els.selectOwnerRoleBtn.disabled = false;
  }
}

async function logoutPartner() {
  const { auth } = getFirebase();
  if (!auth) return;
  try {
    await signOut(auth);
  } catch (error) {
    console.warn("[SwiftGo Partner] logout", error);
    setRoleMessage("لاگ آؤٹ نہیں ہو سکا، دوبارہ کوشش کریں۔");
    setPinMessage("لاگ آؤٹ نہیں ہو سکا، دوبارہ کوشش کریں۔");
  }
}

function setPinMessage(message = "", isSuccess = false) {
  if (!els.pinMessage) return;
  els.pinMessage.textContent = message;
  els.pinMessage.classList.toggle("is-success", isSuccess);
}

function setPinBusy(busy) {
  if (els.pinVerifyBtn) {
    els.pinVerifyBtn.disabled = busy;
    els.pinVerifyBtn.textContent = busy ? "تصدیق ہو رہی ہے..." : "تصدیق کریں";
  }
  if (els.pinInput) els.pinInput.disabled = busy;
}

function showPinGate(message = "") {
  hideProtectedUi();
  partnerMode = "driver";
  if (!els.pinGate) return;
  els.pinGate.hidden = false;
  setPinMessage(message);
  requestAnimationFrame(() => els.pinInput?.focus());
}

function hidePinGate() {
  if (els.pinGate) els.pinGate.hidden = true;
}

async function verifyVehiclePin(event) {
  event.preventDefault();
  const driver = currentDriver;
  const enteredPin = (els.pinInput?.value || "").trim();

  if (!driver) {
    setPinMessage("پہلے لاگ اِن کریں");
    return;
  }
  if (!/^\d{4}$/.test(enteredPin)) {
    setPinMessage("درست 4 ہندسوں کا PIN درج کریں");
    return;
  }

  setPinBusy(true);
  setPinMessage("");

  try {
    const { db } = getFirebase();
    const pinQuery = query(
      collection(db, "vehicles"),
      where("pin", "==", enteredPin),
      limit(1)
    );
    const snapshot = await getDocs(pinQuery);

    if (snapshot.empty) {
      setPinMessage("غلط پن کوڈ! دوبارہ کوشش کریں");
      return;
    }

    const vehicleDoc = snapshot.docs[0];
    const vehicle = vehicleDoc.data();

    if (vehicle.status === "online" && vehicle.driverId !== driver.uid) {
      setPinMessage("یہ گاڑی پہلے ہی زیر استعمال ہے");
      return;
    }

    await updateDoc(doc(db, "vehicles", vehicleDoc.id), {
      driverId: driver.uid,
      status: "online",
    });
    await setDoc(
      doc(db, "partners", driver.uid),
      {
        uid: driver.uid,
        role: "driver",
        currentVehicleId: vehicleDoc.id,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    linkedVehicle = { id: vehicleDoc.id, ...vehicle, driverId: driver.uid, status: "online" };
    setPinMessage("گاڑی کامیابی سے منسلک ہو گئی!", true);
    els.pinForm?.reset();
    window.setTimeout(() => {
      showDriverMap();
    }, 900);
  } catch (error) {
    console.warn("[SwiftGo Partner] verify vehicle PIN", error);
    setPinMessage("تصدیق مکمل نہیں ہو سکی۔ انٹرنیٹ یا Firestore rules چیک کریں۔");
  } finally {
    setPinBusy(false);
  }
}

async function signInDriverWithGoogle() {
  const { auth } = getFirebase();
  if (!auth) {
    setAuthStatus("فائر بیس دستیاب نہیں ہے");
    return;
  }

  setLoginBusy(true);
  setAuthStatus("");
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    if (error?.code === "auth/popup-blocked") {
      await signInWithRedirect(auth, googleProvider);
      return;
    }
    console.warn("[SwiftGo Driver] Google login", error);
    setLoginBusy(false);
    setAuthStatus("Google لاگ اِن نہیں ہو سکا، دوبارہ کوشش کریں");
  }
}

function setOwnerMessage(message = "") {
  if (els.ownerMessage) els.ownerMessage.textContent = message;
}

function stopVehiclesListener() {
  unsubscribeVehicles();
  unsubscribeVehicles = () => {};
}

function stopOwnerRidesListener() {
  unsubscribeOwnerRides();
  unsubscribeOwnerRides = () => {};
}

function ownerRideStatus(status) {
  const statuses = {
    accepted: { label: "قبول شدہ", className: "is-accepted" },
    completed: { label: "مکمل", className: "is-completed" },
    cancelled: { label: "منسوخ", className: "is-cancelled" },
    cancelled_by_user: { label: "کسٹمر نے منسوخ کی", className: "is-cancelled" },
  };
  return statuses[status] || { label: status || "نامعلوم", className: "" };
}

function ownerRideTime(timestamp) {
  if (!timestamp?.toDate) return "—";
  return new Intl.DateTimeFormat("ur-PK", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp.toDate());
}

function createRideHistoryCell(label, value, options = {}) {
  const cell = document.createElement("div");
  cell.className = `owner-ride-card__cell${options.status ? " owner-ride-card__cell--status" : ""}`;

  const cellLabel = document.createElement("span");
  cellLabel.className = "owner-ride-card__label";
  cellLabel.textContent = label;

  if (options.status) {
    const badge = document.createElement("span");
    badge.className = `owner-ride-status ${options.status.className}`.trim();
    badge.textContent = options.status.label;
    cell.append(cellLabel, badge);
    return cell;
  }

  const cellValue = document.createElement("strong");
  cellValue.className = `owner-ride-card__value${options.ltr ? " owner-ride-card__value--ltr" : ""}`;
  cellValue.textContent = value;
  cell.append(cellLabel, cellValue);
  return cell;
}

function renderOwnerRides() {
  if (!els.ownerRideList) return;
  els.ownerRideList.replaceChildren();
  if (els.ownerRideCount) els.ownerRideCount.textContent = `${ownerRides.length} سواریاں`;
  if (els.ownerRideEmpty) els.ownerRideEmpty.hidden = ownerRides.length > 0;

  ownerRides.forEach((ride) => {
    const vehicle = ownerVehicles.find((item) => item.id === ride.vehicleId);
    const driverName =
      ride.driverName ||
      (ride.driverId ? `ڈرائیور ${String(ride.driverId).slice(0, 6)}` : "—");
    const vehiclePlate = ride.vehiclePlate || vehicle?.plate || "—";
    const distanceFare = `${Number(ride.distanceKm || 0).toFixed(1)} km · Rs. ${Math.round(
      Number(ride.farePkr || 0)
    )}`;

    const card = document.createElement("article");
    card.className = "owner-ride-card";
    card.append(
      createRideHistoryCell("وقت", ownerRideTime(ride.createdAt)),
      createRideHistoryCell("ڈرائیور", driverName),
      createRideHistoryCell("گاڑی", vehiclePlate, { ltr: true }),
      createRideHistoryCell("فاصلہ / کرایہ", distanceFare, { ltr: true }),
      createRideHistoryCell("اسٹیٹس", "", { status: ownerRideStatus(ride.status) })
    );
    els.ownerRideList.appendChild(card);
  });
}

function startOwnerRidesListener() {
  stopOwnerRidesListener();
  if (els.ownerRideMessage) els.ownerRideMessage.textContent = "";
  if (!currentDriver || partnerMode !== "owner") return;

  const { db } = getFirebase();
  // Keep this query single-indexed; sort snapshots by createdAt client-side
  // so Phase 26 does not require a new composite Firestore index.
  const ownerRidesQuery = query(
    collection(db, "rides"),
    where("ownerId", "==", currentDriver.uid)
  );

  unsubscribeOwnerRides = onSnapshot(
    ownerRidesQuery,
    (snapshot) => {
      ownerRides = snapshot.docs
        .map((rideDoc) => ({ id: rideDoc.id, ...rideDoc.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      renderOwnerRides();
    },
    (error) => {
      console.warn("[SwiftGo Partner] owner ride history", error);
      if (els.ownerRideMessage) {
        els.ownerRideMessage.textContent = "سواریوں کی ہسٹری لوڈ نہیں ہو سکی۔";
      }
    }
  );
}

function renderOwnerVehicles() {
  if (!els.ownerVehicleGrid) return;
  els.ownerVehicleGrid.replaceChildren();

  const onlineCount = ownerVehicles.filter((vehicle) => vehicle.status === "online").length;
  if (els.ownerVehicleCount) els.ownerVehicleCount.textContent = String(ownerVehicles.length);
  if (els.ownerOnlineCount) els.ownerOnlineCount.textContent = String(onlineCount);
  if (els.ownerOfflineCount) {
    els.ownerOfflineCount.textContent = String(ownerVehicles.length - onlineCount);
  }
  if (els.ownerVehicleEmpty) els.ownerVehicleEmpty.hidden = ownerVehicles.length > 0;

  ownerVehicles.forEach((vehicle) => {
    const card = document.createElement("article");
    card.className = "fleet-vehicle-card";

    const top = document.createElement("div");
    top.className = "fleet-vehicle-card__top";

    const details = document.createElement("div");
    const model = document.createElement("h3");
    model.textContent = vehicle.model || "SwiftGo Vehicle";
    const plate = document.createElement("p");
    plate.className = "fleet-vehicle-card__plate";
    plate.textContent = vehicle.plate || "—";
    details.append(model, plate);

    const badge = document.createElement("span");
    badge.className = "vehicle-status-badge";
    const isOnline = vehicle.status === "online";
    badge.classList.toggle("is-online", isOnline);
    badge.textContent = isOnline ? "آن لائن" : "آف لائن";
    top.append(details, badge);

    const pinRow = document.createElement("div");
    pinRow.className = "fleet-vehicle-card__pin";
    const pinLabel = document.createElement("span");
    pinLabel.textContent = "ڈرائیور PIN";
    const pin = document.createElement("strong");
    pin.textContent = `PIN: ${vehicle.pin || "—"}`;
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-pin-btn";
    copyBtn.textContent = "کاپی";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(vehicle.pin || ""));
        copyBtn.textContent = "کاپی ہو گیا";
        window.setTimeout(() => {
          copyBtn.textContent = "کاپی";
        }, 1400);
      } catch {
        setOwnerMessage(`PIN: ${vehicle.pin || "—"}`);
      }
    });
    pinRow.append(pinLabel, pin, copyBtn);

    card.append(top, pinRow);
    els.ownerVehicleGrid.appendChild(card);
  });
  renderOwnerRides();
}

function startVehiclesListener() {
  stopVehiclesListener();
  setOwnerMessage("");
  if (!currentDriver || partnerMode !== "owner") return;

  const { db } = getFirebase();
  const ownerVehiclesQuery = query(
    collection(db, "vehicles"),
    where("ownerId", "==", currentDriver.uid)
  );

  unsubscribeVehicles = onSnapshot(
    ownerVehiclesQuery,
    (snapshot) => {
      ownerVehicles = snapshot.docs
        .map((vehicleDoc) => ({ id: vehicleDoc.id, ...vehicleDoc.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      renderOwnerVehicles();
    },
    (error) => {
      console.warn("[SwiftGo Partner] owner vehicles", error);
      setOwnerMessage("گاڑیوں کی فہرست لوڈ نہیں ہو سکی۔ Firestore rules deploy کریں۔");
    }
  );
}

function openVehicleModal() {
  if (!currentDriver) {
    setOwnerMessage("گاڑی شامل کرنے کے لیے پہلے لاگ اِن کریں۔");
    return;
  }
  if (!els.vehicleModal) return;
  els.vehicleModal.hidden = false;
  els.vehicleModal.setAttribute("aria-hidden", "false");
  if (els.vehicleFormMessage) els.vehicleFormMessage.textContent = "";
  requestAnimationFrame(() => els.vehicleModelInput?.focus());
}

function closeVehicleModal() {
  if (!els.vehicleModal) return;
  els.vehicleModal.hidden = true;
  els.vehicleModal.setAttribute("aria-hidden", "true");
  els.vehicleForm?.reset();
  if (els.vehicleFormMessage) els.vehicleFormMessage.textContent = "";
}

function generateUniqueVehiclePin() {
  const usedPins = new Set(ownerVehicles.map((vehicle) => String(vehicle.pin || "")));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const pin = String(1000 + (random[0] % 9000));
    if (!usedPins.has(pin)) return pin;
  }
  throw new Error("PIN_GENERATION_FAILED");
}

async function submitVehicle(event) {
  event.preventDefault();
  const owner = currentDriver;
  const model = (els.vehicleModelInput?.value || "").trim();
  const plate = (els.vehiclePlateInput?.value || "").trim().toUpperCase();
  if (!owner || !model || !plate) {
    if (els.vehicleFormMessage) {
      els.vehicleFormMessage.textContent = "ماڈل اور نمبر پلیٹ دونوں درج کریں۔";
    }
    return;
  }

  if (els.vehicleSaveBtn) els.vehicleSaveBtn.disabled = true;
  if (els.vehicleFormMessage) els.vehicleFormMessage.textContent = "";

  try {
    const pin = generateUniqueVehiclePin();
    const { db } = getFirebase();
    await addDoc(collection(db, "vehicles"), {
      ownerId: owner.uid,
      model,
      plate,
      pin,
      status: "offline",
      driverId: null,
      createdAt: serverTimestamp(),
    });
    closeVehicleModal();
    setOwnerMessage(`گاڑی شامل ہو گئی۔ ڈرائیور PIN: ${pin}`);
  } catch (error) {
    console.warn("[SwiftGo Partner] add vehicle", error);
    if (els.vehicleFormMessage) {
      els.vehicleFormMessage.textContent =
        "گاڑی محفوظ نہیں ہو سکی۔ Firestore rules چیک کریں۔";
    }
  } finally {
    if (els.vehicleSaveBtn) els.vehicleSaveBtn.disabled = false;
  }
}

function setOnlineUi(value) {
  online = value;
  els.statusToggle?.classList.toggle("is-online", value);
  els.statusToggle?.setAttribute("aria-checked", String(value));
  els.statusToggle?.setAttribute(
    "aria-label",
    value ? "ڈرائیور آف لائن کریں" : "ڈرائیور آن لائن کریں"
  );
  if (els.statusText) els.statusText.textContent = value ? "آن لائن" : "آف لائن";
}

function driverIcon() {
  return L.divIcon({
    className: "",
    html: '<div class="driver-location-marker"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function updateDriverLocation(position) {
  if (!map || !online) return;

  const { latitude, longitude, accuracy } = position.coords;
  const latlng = [latitude, longitude];

  if (!locationMarker) {
    locationMarker = L.marker(latlng, {
      icon: driverIcon(),
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    locationMarker.setLatLng(latlng);
  }

  if (!accuracyCircle) {
    accuracyCircle = L.circle(latlng, {
      radius: accuracy || 20,
      color: "#087747",
      weight: 1,
      opacity: 0.35,
      fillColor: "#12a862",
      fillOpacity: 0.1,
      interactive: false,
    }).addTo(map);
  } else {
    accuracyCircle.setLatLng(latlng).setRadius(accuracy || 20);
  }

  if (!hasCenteredOnDriver) {
    map.flyTo(latlng, 16, { duration: 0.8 });
    hasCenteredOnDriver = true;
  }

  setLocationMessage("آپ آن لائن ہیں — لائیو مقام فعال ہے");
}

function handleLocationError(error) {
  const denied = error?.code === 1;
  setDriverOffline(
    denied
      ? "لائیو مقام کے لیے براؤزر میں لوکیشن کی اجازت دیں"
      : "موجودہ مقام حاصل نہیں ہو سکا، دوبارہ کوشش کریں"
  );
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    setLocationMessage("یہ براؤزر لائیو لوکیشن سپورٹ نہیں کرتا");
    setOnlineUi(false);
    return;
  }

  hasCenteredOnDriver = false;
  setLocationMessage("آپ کا موجودہ مقام تلاش کیا جا رہا ہے...");
  watchId = navigator.geolocation.watchPosition(
    updateDriverLocation,
    handleLocationError,
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    }
  );
}

function stopLocationWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function stopRideListener() {
  unsubscribeRides();
  unsubscribeRides = () => {};
}

function hideIncomingRide() {
  activeRequest = null;
  window.clearTimeout(hideSheetTimer);
  els.requestSheet?.classList.remove("is-visible");
  els.app?.classList.remove("has-incoming-ride");
  hideSheetTimer = window.setTimeout(() => {
    if (els.requestSheet) els.requestSheet.hidden = true;
  }, 360);
}

function showIncomingRide(request) {
  activeRequest = request;
  window.clearTimeout(hideSheetTimer);

  if (els.pickup) {
    els.pickup.textContent = request.pickupLocation?.address || "پک اپ مقام دستیاب نہیں";
  }
  if (els.dropoff) {
    els.dropoff.textContent = request.dropoffLocation?.address || "ڈراپ آف مقام دستیاب نہیں";
  }
  if (els.distance) {
    els.distance.textContent = `${Number(request.distanceKm || 0).toFixed(1)} km`;
  }
  if (els.time) {
    els.time.textContent = `${Math.round(Number(request.timeMins || 0))} min`;
  }
  if (els.fare) {
    els.fare.textContent = `Rs. ${Math.round(Number(request.farePkr || 0))}`;
  }

  if (els.requestSheet) els.requestSheet.hidden = false;
  els.app?.classList.add("has-incoming-ride");
  requestAnimationFrame(() => els.requestSheet?.classList.add("is-visible"));
}

function startRideListener() {
  stopRideListener();
  if (!online || !currentDriver) return;

  const { db } = getFirebase();
  const incomingQuery = query(
    collection(db, "rides"),
    where("status", "==", "searching_driver"),
    orderBy("createdAt", "desc"),
    limit(1)
  );

  unsubscribeRides = onSnapshot(
    incomingQuery,
    (snapshot) => {
      if (!online) return;
      const latest = snapshot.docs[0];
      if (!latest) {
        hideIncomingRide();
        return;
      }
      showIncomingRide({ id: latest.id, ...latest.data() });
    },
    (error) => {
      console.warn("[SwiftGo Driver] incoming rides", error);
      setDriverOffline("سواری کی درخواستیں حاصل نہیں ہو سکیں");
    }
  );
}

function setDriverOffline(message = "آپ آف لائن ہیں") {
  stopLocationWatch();
  stopRideListener();
  hideIncomingRide();
  setOnlineUi(false);
  setLocationMessage(message);
}

function toggleDriverStatus() {
  if (online) {
    setDriverOffline();
    return;
  }

  if (!currentDriver) {
    setLocationMessage("پہلے کسٹمر ایپ میں اپنے اکاؤنٹ سے سائن اِن کریں");
    return;
  }

  if (!linkedVehicle) {
    setLocationMessage("آن لائن ہونے کے لیے پہلے گاڑی کا PIN درج کریں");
    showPinGate();
    return;
  }

  setOnlineUi(true);
  startLocationWatch();
  startRideListener();
}

function setRequestButtonsBusy(busy) {
  if (els.acceptBtn) els.acceptBtn.disabled = busy;
  if (els.declineBtn) els.declineBtn.disabled = busy;
}

async function resolveActiveRequest(nextStatus) {
  const request = activeRequest;
  const driver = currentDriver;
  if (!request?.id || !driver) return;

  setRequestButtonsBusy(true);
  const { db } = getFirebase();
  const rideRef = doc(db, "rides", request.id);
  const vehicleRef =
    nextStatus === "accepted" && linkedVehicle?.id
      ? doc(db, "vehicles", linkedVehicle.id)
      : null;

  try {
    await runTransaction(db, async (transaction) => {
      if (nextStatus === "accepted" && !vehicleRef) {
        throw new Error("VEHICLE_NOT_LINKED");
      }

      const [rideSnapshot, vehicleSnapshot] = await Promise.all([
        transaction.get(rideRef),
        vehicleRef ? transaction.get(vehicleRef) : Promise.resolve(null),
      ]);

      if (!rideSnapshot.exists() || rideSnapshot.data().status !== "searching_driver") {
        throw new Error("RIDE_NOT_AVAILABLE");
      }

      const update = {
        status: nextStatus,
        driverId: driver.uid,
      };

      if (nextStatus === "accepted") {
        if (
          !vehicleSnapshot?.exists() ||
          vehicleSnapshot.data().driverId !== driver.uid ||
          !vehicleSnapshot.data().ownerId
        ) {
          throw new Error("VEHICLE_NOT_LINKED");
        }

        update.vehicleId = vehicleSnapshot.id;
        update.ownerId = vehicleSnapshot.data().ownerId;
        update.vehiclePlate = vehicleSnapshot.data().plate || "—";
        update.driverName = driver.displayName || "SwiftGo Driver";
      }

      transaction.update(rideRef, update);
    });

    hideIncomingRide();
    setLocationMessage(
      nextStatus === "accepted"
        ? "سواری قبول کر لی گئی ہے"
        : "سواری مسترد کر دی گئی ہے"
    );
  } catch (error) {
    console.warn(`[SwiftGo Driver] ${nextStatus} ride`, error);
    setLocationMessage(
      error?.message === "RIDE_NOT_AVAILABLE"
        ? "یہ سواری اب دستیاب نہیں ہے"
        : error?.message === "VEHICLE_NOT_LINKED"
          ? "منسلک گاڑی کی تصدیق نہیں ہو سکی"
        : "کارروائی مکمل نہیں ہو سکی"
    );
  } finally {
    setRequestButtonsBusy(false);
  }
}

function boot() {
  initMap();
  hideProtectedUi();
  els.statusToggle?.addEventListener("click", toggleDriverStatus);
  els.googleLoginBtn?.addEventListener("click", signInDriverWithGoogle);
  els.acceptBtn?.addEventListener("click", () => resolveActiveRequest("accepted"));
  els.declineBtn?.addEventListener("click", () => resolveActiveRequest("declined"));
  els.selectDriverRoleBtn?.addEventListener("click", () => selectPartnerRole("driver"));
  els.selectOwnerRoleBtn?.addEventListener("click", () => selectPartnerRole("owner"));
  els.roleLogoutBtn?.addEventListener("click", logoutPartner);
  els.pinLogoutBtn?.addEventListener("click", logoutPartner);
  els.addVehicleBtn?.addEventListener("click", openVehicleModal);
  els.vehicleModalBackdrop?.addEventListener("click", closeVehicleModal);
  els.vehicleModalClose?.addEventListener("click", closeVehicleModal);
  els.vehicleForm?.addEventListener("submit", submitVehicle);
  els.pinForm?.addEventListener("submit", verifyVehiclePin);
  els.pinInput?.addEventListener("input", () => setPinMessage(""));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.vehicleModal?.hidden) closeVehicleModal();
  });

  // Initialize the same Firebase singleton/config used by the customer app.
  const firebase = getFirebase();
  if (firebase.auth) {
    getRedirectResult(firebase.auth).catch((error) => {
      console.warn("[SwiftGo Driver] Google redirect", error);
      setAuthStatus("Google لاگ اِن مکمل نہیں ہو سکا");
    });
    onAuthStateChanged(firebase.auth, async (user) => {
      authSequence += 1;
      if (!user) {
        currentDriver = null;
        linkedVehicle = null;
        partnerMode = null;
        hideProtectedUi();
        ownerVehicles = [];
        ownerRides = [];
        renderOwnerVehicles();
        setLoginBusy(false);
        showAuthOverlay();
        return;
      }
      await activateAuthenticatedDriver(user);
    });
  } else {
    showAuthOverlay("فائر بیس دستیاب نہیں ہے");
  }
  console.info(
    `[SwiftGo Partner] Phase 26 owner ride tracking ready · project=${firebaseConfig.projectId} · firebase=${
      isFirebaseConfigured() && firebase.ready
    }`
  );
}

boot();
