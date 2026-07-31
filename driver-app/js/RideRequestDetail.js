/**
 * Screen 2 — Ride detail map + bid sheet.
 */

import { fetchRideRoute } from "./ride-radar-routing.js";
import { submitDriverOffer, acceptRideWithBid, acceptCustomerInitialFare, declineRideCandidateClient, withdrawRideOfferClient } from "./ride-radar-actions.js";
import { openRateDetails } from "./rate-details-modal.js";
import { resolveVehicleKeyFromLabel } from "./pricing-client.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

const money = (n) => `Rs. ${Math.round(Math.max(0, Number(n) || 0)).toLocaleString("en-PK")}`;

/**
 * @param {HTMLElement | null} root
 * @param {{
 *   getDriver: () => { uid: string, displayName?: string } | null,
 *   getLinkedVehicle: () => { id: string, plate?: string, ownerId?: string } | null,
 *   getDriverPosition?: () => { lat: number, lng: number } | null,
 *   getOfferForRide?: (rideId: string) => object | null,
 *   onBack: () => void,
 *   onAccepted: (result: { rideId: string, bidFare: number }) => void,
 *   onOfferSent?: (result: { rideId: string, bidFare: number }) => void,
 *   onError: (message: string) => void,
 * }} opts
 */
export function initRideRequestDetail(root, opts) {
  if (!root) return { show: () => {}, hide: () => {}, destroy: () => {} };

  const getDriver = opts.getDriver || (() => null);
  const getLinkedVehicle = opts.getLinkedVehicle || (() => null);
  const getDriverPosition = opts.getDriverPosition || (() => null);
  const getOfferForRide = opts.getOfferForRide || (() => null);
  const onBack = opts.onBack || (() => {});
  const onAccepted = opts.onAccepted || (() => {});
  const onOfferSent = opts.onOfferSent || (() => {});
  const onError = opts.onError || (() => {});

  /** @type {import("leaflet").Map | null} */
  let map = null;
  /** @type {import("leaflet").LayerGroup | null} */
  let layerGroup = null;
  /** @type {object | null} */
  let currentRide = null;
  let tripDurationMin = null;
  let routeSeq = 0;
  let sheetExpanded = true;

  root.innerHTML = `
    <section class="radar-detail" aria-label="رائٹ کی تفصیل">
      <header class="radar-detail__header">
        <button type="button" class="radar-detail__back" data-back aria-label="رائٹس کی فہرست">←</button>
        <h2>رائٹ کی تفصیل</h2>
      </header>
      <div class="radar-detail__map-wrap">
        <div class="radar-detail__map" id="radarDetailMap" role="application" aria-label="پک اپ اور ڈراپ آف کا نقشہ"></div>
        <div class="radar-detail__map-legend" aria-hidden="true">
          <span class="radar-detail__legend-item"><i class="radar-detail__legend-dot radar-detail__legend-dot--a"></i> پک اپ (A)</span>
          <span class="radar-detail__legend-item"><i class="radar-detail__legend-dot radar-detail__legend-dot--b"></i> ڈراپ آف (B)</span>
          <span class="radar-detail__legend-item radar-detail__legend-item--driver" data-driver-legend hidden><i class="radar-detail__legend-dot radar-detail__legend-dot--driver"></i> آپ</span>
        </div>
      </div>
      <div class="radar-detail__sheet" data-detail-sheet>
        <button
          type="button"
          class="radar-detail__sheet-handle"
          data-sheet-toggle
          aria-expanded="true"
          aria-controls="radarDetailSheetBody"
        >
          <span class="radar-detail__sheet-handle-bar" aria-hidden="true"></span>
          <span class="radar-detail__sheet-handle-arrow" data-sheet-arrow aria-hidden="true">▼</span>
          <span class="radar-detail__sheet-handle-label">نیچے والی تفصیل · اوپر/نیچے کھولیں</span>
        </button>
        <div class="radar-detail__sheet-body" id="radarDetailSheetBody">
          <div class="radar-detail__sheet-inner">
          <div class="radar-detail__summary">
            <div><span>فاصلہ</span><strong data-trip-km>— km</strong></div>
            <div><span>تخمینہ کرایہ</span><strong data-base-fare>—</strong></div>
          </div>
          <button type="button" class="radar-detail__rate-btn" data-rate-details-btn>
            ریٹ کی مکمل تفصیل دیکھیں
          </button>
          <div class="radar-detail__rating">
            <span>مسافر کی درجہ بندی</span>
            <strong data-rating>4.8 ★</strong>
          </div>
          <div class="radar-detail__addresses">
            <p><span class="radar-detail__tag radar-detail__tag--a">A</span> <span class="radar-detail__addr-label">پک اپ:</span> <span data-pickup-text>—</span></p>
            <p><span class="radar-detail__tag radar-detail__tag--b">B</span> <span class="radar-detail__addr-label">ڈراپ آف:</span> <span data-dropoff-text>—</span></p>
          </div>
          <div class="radar-detail__customer-offer" data-customer-offer-panel>
            <p class="radar-detail__customer-offer-label">مسافر کی پہلی پیشکش</p>
            <p class="radar-detail__customer-offer-fare" data-customer-offer-fare>—</p>
            <button type="button" class="radar-detail__accept-customer-offer" data-accept-customer-offer>
              مسافر کی پیشکش قبول کریں
            </button>
          </div>
          <p class="radar-detail__bid-label">یا اپنا کرایہ (Rs.) درج کریں یا تیز اختیار منتخب کریں</p>
          <div class="radar-detail__custom-bid">
            <input
              type="number"
              class="radar-detail__custom-bid-input"
              data-custom-fare
              min="0"
              step="50"
              inputmode="numeric"
              placeholder="مثلاً 450"
              aria-label="اپنا کرایہ"
            />
            <button type="button" class="radar-detail__custom-bid-send" data-send-custom-offer>پیشکش بھیجیں</button>
          </div>
          <p class="radar-detail__offer-status" data-offer-status hidden></p>
          <div class="radar-detail__actions-row">
            <button type="button" class="radar-detail__decline" data-decline-candidate>مسترد کریں</button>
            <button type="button" class="radar-detail__withdraw" data-withdraw-offer>پیشکش واپس</button>
          </div>
          <div class="radar-detail__counter" data-counter-panel hidden>
            <p class="radar-detail__counter-text" data-counter-text></p>
            <button type="button" class="radar-detail__counter-accept" data-accept-counter>کاؤنٹر قبول کریں</button>
          </div>
          <div class="radar-detail__bids" data-bids></div>
          </div>
        </div>
      </div>
    </section>
  `;

  const mapEl = root.querySelector("#radarDetailMap");
  const bidsEl = root.querySelector("[data-bids]");
  const customFareInput = root.querySelector("[data-custom-fare]");
  const sendCustomBtn = root.querySelector("[data-send-custom-offer]");
  const acceptCustomerOfferBtn = root.querySelector("[data-accept-customer-offer]");
  const customerOfferFareEl = root.querySelector("[data-customer-offer-fare]");
  const customerOfferPanel = root.querySelector("[data-customer-offer-panel]");
  const offerStatusEl = root.querySelector("[data-offer-status]");
  const counterPanel = root.querySelector("[data-counter-panel]");
  const counterTextEl = root.querySelector("[data-counter-text]");
  const acceptCounterBtn = root.querySelector("[data-accept-counter]");
  const ratingEl = root.querySelector("[data-rating]");
  const pickupEl = root.querySelector("[data-pickup-text]");
  const dropoffEl = root.querySelector("[data-dropoff-text]");
  const tripKmEl = root.querySelector("[data-trip-km]");
  const baseFareEl = root.querySelector("[data-base-fare]");
  const detailSection = root.querySelector(".radar-detail");
  const driverLegendEl = root.querySelector("[data-driver-legend]");
  const sheetToggleBtn = root.querySelector("[data-sheet-toggle]");
  const sheetArrowEl = root.querySelector("[data-sheet-arrow]");

  root.querySelector("[data-back]")?.addEventListener("click", () => onBack());

  root.querySelector("[data-rate-details-btn]")?.addEventListener("click", () => {
    const ride = currentRide;
    if (!ride) return;
    void openRateDetails({
      vehicleTypeKey: ride.vehicleTypeKey || resolveVehicleKeyFromLabel(ride.vehicleType),
      vehicleTypeLabel: ride.vehicleType,
      distanceKm: ride.tripDistanceKm ?? ride.tripKm,
      durationMin: tripDurationMin,
      estimatedFare: ride.estimatedFare,
      mode: "ride",
    });
  });

  root.querySelector("[data-decline-candidate]")?.addEventListener("click", async () => {
    const ride = currentRide;
    if (!ride?.id) return;
    try {
      await declineRideCandidateClient(ride.id);
      onError("درخواست مسترد کر دی گئی");
      onBack();
    } catch (err) {
      onError(String(err?.message || err || "مسترد نہیں ہو سکی"));
    }
  });

  root.querySelector("[data-withdraw-offer]")?.addEventListener("click", async () => {
    const ride = currentRide;
    const driver = getDriver();
    if (!ride?.id || !driver?.uid) return;
    try {
      await withdrawRideOfferClient(ride.id, driver.uid);
      if (offerStatusEl) {
        offerStatusEl.hidden = false;
        offerStatusEl.textContent = "پیشکش واپس لے لی گئی";
      }
    } catch (err) {
      onError(String(err?.message || err || "واپسی نہیں ہو سکی"));
    }
  });

  function setSheetExpanded(expanded) {
    sheetExpanded = expanded;
    detailSection?.classList.toggle("is-sheet-collapsed", !expanded);
    if (sheetToggleBtn) {
      sheetToggleBtn.setAttribute("aria-expanded", String(expanded));
      sheetToggleBtn.setAttribute(
        "aria-label",
        expanded ? "تفصیل نیچے سمیٹیں" : "تفصیل اوپر کھولیں"
      );
    }
    if (sheetArrowEl) sheetArrowEl.textContent = expanded ? "▼" : "▲";
    invalidateMapSoon();
  }

  sheetToggleBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    setSheetExpanded(!sheetExpanded);
  });

  function ensureMap() {
    if (map || typeof L === "undefined" || !mapEl) return;
    map = L.map(mapEl, { zoomControl: false, attributionControl: true }).setView([24.8607, 67.0011], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    layerGroup = L.layerGroup().addTo(map);
  }

  function clearMapLayers() {
    layerGroup?.clearLayers();
  }

  function invalidateMapSoon() {
    requestAnimationFrame(() => {
      map?.invalidateSize();
      window.setTimeout(() => map?.invalidateSize(), 120);
    });
  }

  async function drawRoute(ride) {
    ensureMap();
    if (!map || !layerGroup) return;
    clearMapLayers();
    const pickup = ride.pickup;
    const dropoff = ride.dropoff;
    if (pickup.lat == null || pickup.lng == null || dropoff.lat == null || dropoff.lng == null) {
      onError("اس رائٹ کے لیے مقام مکمل نہیں");
      invalidateMapSoon();
      return;
    }

    const seq = ++routeSeq;
    const route = await fetchRideRoute(pickup, dropoff);
    if (seq !== routeSeq) return;
    tripDurationMin = route?.durationMin ?? null;
    if (currentRide && route?.distanceKm != null && tripKmEl) {
      tripKmEl.textContent = `${route.distanceKm} km`;
    }

    const a = L.marker([pickup.lat, pickup.lng], {
      icon: L.divIcon({
        className: "radar-map-pin radar-map-pin--a",
        html: "A",
        iconSize: [28, 28],
      }),
    });
    const b = L.marker([dropoff.lat, dropoff.lng], {
      icon: L.divIcon({
        className: "radar-map-pin radar-map-pin--b",
        html: "B",
        iconSize: [28, 28],
      }),
    });
    layerGroup.addLayer(a);
    layerGroup.addLayer(b);

    const driverPos = getDriverPosition();
    const boundsPoints = [
      [pickup.lat, pickup.lng],
      [dropoff.lat, dropoff.lng],
    ];
    if (driverPos?.lat != null && driverPos?.lng != null) {
      const d = L.marker([driverPos.lat, driverPos.lng], {
        icon: L.divIcon({
          className: "radar-map-pin radar-map-pin--driver",
          html: "●",
          iconSize: [22, 22],
        }),
      });
      layerGroup.addLayer(d);
      boundsPoints.push([driverPos.lat, driverPos.lng]);
      if (driverLegendEl) driverLegendEl.hidden = false;
    } else if (driverLegendEl) {
      driverLegendEl.hidden = true;
    }

    if (route?.latlngs?.length) {
      const line = L.polyline(route.latlngs, { color: "#0b7a4b", weight: 5, opacity: 0.9 });
      layerGroup.addLayer(line);
      map.fitBounds(line.getBounds(), { padding: [48, 48] });
    } else {
      map.fitBounds(L.latLngBounds(boundsPoints), { padding: [48, 48] });
    }
    invalidateMapSoon();
  }

  let rideUnsub = () => {};
  let offerUnsub = () => {};
  let myOfferState = null;

  acceptCustomerOfferBtn?.addEventListener("click", () => acceptCustomerOffer());

  sendCustomBtn?.addEventListener("click", () => {
    if (!currentRide) return;
    const raw = customFareInput?.value ?? "";
    const amount = Math.round(Number(raw) || 0);
    if (amount <= 0) {
      onError("درست کرایہ درج کریں");
      return;
    }
    submitBid(currentRide, amount, sendCustomBtn);
  });

  acceptCounterBtn?.addEventListener("click", () => acceptCounterOffer());

  function stopRideWatch() {
    rideUnsub();
    rideUnsub = () => {};
    offerUnsub();
    offerUnsub = () => {};
    myOfferState = null;
  }

  function collectionNameFor(ride) {
    return ride?.sourceCollection === "ride_requests" ? "ride_requests" : "rides";
  }

  function startRideWatch(ride) {
    stopRideWatch();
    const driver = getDriver();
    const { db } = getFirebase();
    if (!db || !ride?.id) return;

    rideUnsub = onSnapshot(
      doc(db, collectionNameFor(ride), ride.id),
      (snap) => {
        if (!snap.exists() || !currentRide || snap.id !== currentRide.id) return;
        const data = { id: snap.id, ...snap.data(), sourceCollection: collectionNameFor(ride) };
        syncOfferUi(data, driver?.uid);

        if (data.status === "accepted" && data.driverId === driver?.uid) {
          stopRideWatch();
          onAccepted({ rideId: data.id, bidFare: Number(data.farePkr) || 0 });
        }
      },
      (err) => console.warn("[SwiftGo Radar] Firestore listen retry... detail watch", err)
    );

    if (driver?.uid) {
      offerUnsub = onSnapshot(
        doc(db, "ride_offers", `${ride.id}_${driver.uid}`),
        (snap) => {
          myOfferState = snap.exists() ? { id: snap.id, ...snap.data() } : null;
          if (currentRide) syncOfferUi(currentRide, getDriver()?.uid || driver.uid);
        },
        (err) => console.warn("[SwiftGo Radar] Firestore listen retry... offer watch", err)
      );
    }
  }

  function syncFromInbox() {
    if (!currentRide?.id) return;
    const cached = getOfferForRide(currentRide.id);
    if (cached) {
      myOfferState = cached;
      syncOfferUi(currentRide, getDriver()?.uid);
    }
  }

  function syncOfferUi(ride, driverUid) {
    const offer = myOfferState;
    const offerBelongsToDriver =
      offer &&
      driverUid &&
      (offer.driverId === driverUid ||
        String(offer.id || "") === `${ride?.id}_${driverUid}` ||
        String(offer.id || "").endsWith(`_${driverUid}`));
    const myOffer =
      offerBelongsToDriver &&
      ["open", "countered"].includes(offer.status) &&
      ride?.status !== "accepted";
    const counter = Math.round(Number(offer?.customerCounterFare) || 0);
    const fare = Math.round(Number(offer?.fare) || 0);

    if (offerStatusEl) {
      if (myOffer && counter <= 0) {
        offerStatusEl.hidden = false;
        offerStatusEl.textContent = `پیشکش بھیج دی گئی: ${money(fare)} — مسافر کا جواب انتظار`;
      } else if (myOffer && counter > 0) {
        offerStatusEl.hidden = false;
        offerStatusEl.textContent = `مسافر نے ${money(counter)} تجویز کی`;
      } else {
        offerStatusEl.hidden = true;
        offerStatusEl.textContent = "";
      }
    }

    if (counterPanel && acceptCounterBtn) {
      const showCounter = myOffer && counter > 0;
      counterPanel.hidden = !showCounter;
      if (showCounter && counterTextEl) {
        counterTextEl.textContent = `مسافر ${money(counter)} پر راضی ہے۔ قبول کریں یا نئی پیشکش بھیجیں۔`;
      }
      acceptCounterBtn.disabled = false;
      if (showCounter) {
        setSheetExpanded(true);
        counterPanel.classList.add("is-highlight");
        window.setTimeout(() => counterPanel?.classList.remove("is-highlight"), 2400);
      }
    }

    const showAcceptInitial =
      ride.status === "searching_driver" &&
      !myOffer &&
      Math.round(Number(ride.estimatedFare ?? ride.farePkr ?? 0)) > 0;
    if (customerOfferPanel) customerOfferPanel.hidden = !showAcceptInitial;
    if (acceptCustomerOfferBtn) acceptCustomerOfferBtn.disabled = !showAcceptInitial;
  }

  async function acceptCustomerOffer() {
    const ride = currentRide;
    const driver = getDriver();
    const vehicle = getLinkedVehicle();
    if (!ride?.id || !driver?.uid || !vehicle?.id) return;
    if (acceptCustomerOfferBtn) acceptCustomerOfferBtn.disabled = true;
    try {
      const result = await acceptCustomerInitialFare({
        rideId: ride.id,
        driver,
        linkedVehicle: vehicle,
      });
      onAccepted({ rideId: ride.id, bidFare: Number(result?.bidFare) || 0 });
    } catch (err) {
      const code = err?.message || "";
      if (code === "RIDE_NOT_AVAILABLE" || code.includes("NOT_NEGOTIATING")) {
        onError("یہ رائٹ اب دستیاب نہیں");
      } else if (code === "VEHICLE_NOT_LINKED") onError("گاڑی کی تصدیق نہیں ہو سکی");
      else if (code === "DRIVER_HAS_ACTIVE_RIDE" || String(code).includes("DRIVER_HAS_ACTIVE_RIDE")) {
        onError("پہلے فعال سواری مکمل کریں");
      } else if (code === "NOT_A_CANDIDATE") onError("یہ رائٹ آپ کے لیے دستیاب نہیں");
      else onError("قبول نہیں ہو سکی، دوبارہ کوشش کریں");
      if (acceptCustomerOfferBtn) acceptCustomerOfferBtn.disabled = false;
    }
  }

  async function acceptCounterOffer() {
    const ride = currentRide;
    const driver = getDriver();
    const vehicle = getLinkedVehicle();
    if (!ride?.id || !driver?.uid || !vehicle?.id) return;
    acceptCounterBtn.disabled = true;
    try {
      await acceptRideWithBid({
        rideId: ride.id,
        sourceCollection: ride.sourceCollection,
        useCustomerCounter: true,
        driver,
        linkedVehicle: vehicle,
      });
    } catch (err) {
      const code = err?.message || "";
      if (code === "RIDE_NOT_AVAILABLE") onError("یہ رائٹ اب دستیاب نہیں");
      else if (code === "NO_COUNTER_OFFER") onError("کاؤنٹر پیشکش نہیں ملی");
      else onError("قبول نہیں ہو سکی");
      acceptCounterBtn.disabled = false;
    }
  }

  function renderBids(ride) {
    if (!bidsEl) return;
    bidsEl.replaceChildren();
    const options = ride.bidOptions || [];
    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "radar-bid-btn";
      btn.innerHTML = `
        <span class="radar-bid-btn__label">${escapeHtml(opt.label)}</span>
        <strong class="radar-bid-btn__amount">${money(opt.amount)}</strong>
        <span class="radar-bid-btn__rate">Rs. ${Math.round(opt.perKm)}/km</span>
      `;
      btn.addEventListener("click", () => submitBid(ride, opt.amount, btn));
      bidsEl.append(btn);
    });
  }

  async function submitBid(ride, amount, btn) {
    const driver = getDriver();
    const vehicle = getLinkedVehicle();
    if (!driver?.uid) {
      onError("پہلے لاگ اِن کریں");
      return;
    }
    if (!vehicle?.id) {
      onError("گاڑی منسلک نہیں — PIN درج کریں");
      return;
    }
    btn.disabled = true;
    try {
      const result = await submitDriverOffer({
        rideId: ride.id,
        sourceCollection: ride.sourceCollection,
        bidFare: amount,
        driver,
        linkedVehicle: vehicle,
      });
      myOfferState = {
        id: result.offerId || `${ride.id}_${driver.uid}`,
        driverId: driver.uid,
        fare: amount,
        status: "open",
        customerCounterFare: null,
      };
      syncOfferUi(ride, driver.uid);
      onOfferSent(result);
      btn.disabled = false;
    } catch (err) {
      const code = err?.message || err?.code || "";
      if (code === "RIDE_NOT_AVAILABLE" || code.includes("NOT_NEGOTIATING")) {
        onError("یہ رائٹ اب دستیاب نہیں");
      } else if (code === "VEHICLE_NOT_LINKED") onError("گاڑی کی تصدیق نہیں ہو سکی");
      else if (code === "MAX_OPEN_BARGAINS" || String(code).includes("MAX_OPEN_BARGAINS")) {
        onError("آپ کی 10 کھلی پیشکشیں مکمل ہیں");
      } else if (code === "DRIVER_HAS_ACTIVE_RIDE" || String(code).includes("DRIVER_HAS_ACTIVE_RIDE")) {
        onError("پہلے فعال سواری مکمل کریں");
      } else onError("پیشکش نہیں بھیج سکی، دوبارہ کوشش کریں");
      btn.disabled = false;
    }
  }

  function show(ride) {
    currentRide = ride;
    tripDurationMin = null;
    root.hidden = false;
    setSheetExpanded(true);
    requestAnimationFrame(() => {
      detailSection?.classList.add("is-visible");
      ensureMap();
      drawRoute(ride);
    });

    if (ratingEl) ratingEl.textContent = `${ride.riderRatingDisplay || "4.8"} ★`;
    if (pickupEl) pickupEl.textContent = ride.pickup?.address || "—";
    if (dropoffEl) dropoffEl.textContent = ride.dropoff?.address || "—";
    if (tripKmEl) {
      tripKmEl.textContent =
        ride.tripDistanceKm != null ? `${ride.tripDistanceKm} km` : ride.tripKm != null ? `${ride.tripKm} km` : "— km";
    }
    if (baseFareEl) baseFareEl.textContent = money(ride.estimatedFare);
    if (customerOfferFareEl) {
      customerOfferFareEl.textContent = money(ride.estimatedFare);
    }
    if (customFareInput && !customFareInput.value) {
      customFareInput.placeholder = String(Math.round(Number(ride.estimatedFare) || 0) || "450");
    }
    renderBids(ride);
    const cachedOffer = getOfferForRide(ride.id);
    if (cachedOffer) myOfferState = cachedOffer;
    syncOfferUi(ride, getDriver()?.uid);
    startRideWatch(ride);
  }

  function hide() {
    stopRideWatch();
    detailSection?.classList.remove("is-visible");
    root.hidden = true;
    routeSeq++;
    currentRide = null;
  }

  function destroy() {
    hide();
    map?.remove();
    map = null;
    layerGroup = null;
    root.replaceChildren();
  }

  return { show, hide, destroy, syncFromInbox };
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
