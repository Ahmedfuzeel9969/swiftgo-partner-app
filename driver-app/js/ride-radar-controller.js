/**
 * Ride Radar flow coordinator — dashboard ↔ list ↔ detail.
 */

import { initAvailableRidesList } from "./AvailableRidesList.js";
import { initRideRequestDetail } from "./RideRequestDetail.js";

/**
 * @param {{
 *   root: HTMLElement | null,
 *   listHost: HTMLElement | null,
 *   detailHost: HTMLElement | null,
 *   triggerBtn: HTMLElement | null,
 *   getDriverUid: () => string | null,
 *   getDriver: () => { uid: string, displayName?: string } | null,
 *   getLinkedVehicle: () => object | null,
 *   getDriverPosition: () => { lat: number, lng: number } | null,
 *   onRideAccepted: (result: { rideId: string, bidFare: number }) => void,
 *   onToast: (msg: string) => void,
 *   getIsOnline?: () => boolean,
 *   getHasActiveRide?: () => boolean,
 *   getOfferForRide?: (rideId: string) => object | null,
 *   getCounterRideIds?: () => string[],
 * }} config
 */
export function initRideRadarFlow(config) {
  const root = config.root;
  const onToast = config.onToast || (() => {});

  if (!root) {
    return { open: () => {}, close: () => {}, destroy: () => {} };
  }

  const listUi = initAvailableRidesList(config.listHost, {
    getDriverUid: config.getDriverUid,
    getDriverPosition: config.getDriverPosition,
    getHasActiveRide: config.getHasActiveRide,
    getCounterRideIds: config.getCounterRideIds,
    getOfferForRide: config.getOfferForRide,
    onSelectRide: (ride) => {
      listUi.hide({ keepSubscription: true });
      detailUi.show(ride);
      root.dataset.radarScreen = "detail";
    },
    onBack: () => closeAll(),
  });

  const detailUi = initRideRequestDetail(config.detailHost, {
    getDriver: config.getDriver,
    getLinkedVehicle: config.getLinkedVehicle,
    getDriverPosition: config.getDriverPosition,
    getOfferForRide: config.getOfferForRide,
    onBack: () => {
      detailUi.hide();
      listUi.show({ resume: true });
      root.dataset.radarScreen = "list";
    },
    onOfferSent: (result) => {
      onToast(`پیشکش بھیج دی گئی: Rs. ${Math.round(result.bidFare || 0).toLocaleString("en-PK")}`);
    },
    onAccepted: (result) => {
      onToast("سواری قبول — پک اپ کی طرف جائیں");
      config.onRideAccepted?.(result);
      closeAll();
    },
    onError: (msg) => onToast(msg),
  });

  function openRideDetail(ride) {
    if (!ride?.id) return;
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    root.dataset.radarScreen = "detail";
    document.getElementById("partnerShell")?.classList.add("has-ride-radar");
    requestAnimationFrame(() => {
      root.classList.add("is-open");
      listUi.hide({ keepSubscription: true });
      detailUi.show(ride);
    });
  }

  function openList() {
    if (config.getHasActiveRide?.()) {
      onToast("آپ پہلے سے ایک سواری پر ہیں — نئی رائٹ قبول نہیں کر سکتے");
      return;
    }
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    root.dataset.radarScreen = "list";
    document.getElementById("partnerShell")?.classList.add("has-ride-radar");
    requestAnimationFrame(() => {
      root.classList.add("is-open");
      detailUi.hide();
      listUi.show();
    });
  }

  function closeAll() {
    root.classList.remove("is-open");
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    root.dataset.radarScreen = "";
    document.getElementById("partnerShell")?.classList.remove("has-ride-radar");
    listUi.hide({ keepSubscription: false });
    detailUi.hide();
  }

  config.triggerBtn?.addEventListener("click", () => {
    if (!config.getDriverUid?.()) {
      onToast("پہلے لاگ اِن کریں");
      return;
    }
    if (config.getHasActiveRide?.()) {
      onToast("آپ پہلے سے ایک سواری پر ہیں");
      return;
    }
    if (config.getIsOnline && !config.getIsOnline()) {
      onToast("پہلے آن لائن ہوں");
      return;
    }
    if (!config.getLinkedVehicle?.()) {
      onToast("گاڑی منسلک نہیں — PIN درج کریں");
      return;
    }
    openList();
  });

  return {
    open: openList,
    openRideDetail,
    close: closeAll,
    refreshList: () => listUi.refresh?.(),
    syncDetailFromInbox: () => detailUi.syncFromInbox?.(),
    destroy: () => {
      listUi.destroy();
      detailUi.destroy();
      closeAll();
    },
  };
}
