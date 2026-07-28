/**
 * Phase 4C — driver open-bargain capacity (max 10).
 */
import { collection, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

const OPEN_STATUSES = ["open", "countered"];
const MAX = 10;

/**
 * @param {{ getDriverUid: () => string | null, onChange?: (snap: { count: number, max: number }) => void }} config
 */
export function subscribeOpenBargainCount(config) {
  const getDriverUid = config.getDriverUid || (() => null);
  const onChange = config.onChange || (() => {});
  let unsub = () => {};

  const start = () => {
    unsub();
    const uid = getDriverUid();
    if (!uid) {
      onChange({ count: 0, max: MAX });
      return;
    }
    const { db } = getFirebase();
    if (!db) {
      onChange({ count: 0, max: MAX });
      return;
    }
    const q = query(
      collection(db, "ride_offers"),
      where("driverId", "==", uid),
      where("status", "in", OPEN_STATUSES)
    );
    unsub = onSnapshot(
      q,
      (snap) => onChange({ count: snap.size, max: MAX }),
      () => onChange({ count: 0, max: MAX })
    );
  };

  return {
    start,
    stop() {
      unsub();
      unsub = () => {};
    },
  };
}

export function formatBargainCapacity(count, max = MAX) {
  const safe = Math.max(0, Math.min(max, Number(count) || 0));
  return `${safe} / ${max}`;
}
