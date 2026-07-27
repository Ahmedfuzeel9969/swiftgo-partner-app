/**
 * Phase 2A — customer booking gate + trusted create (when Functions available).
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

const NON_TERMINAL = ["searching_driver", "accepted", "arrived", "in_progress"];

async function listActiveBookingsLocal() {
  const { ready, db, auth } = getFirebase();
  const user = auth?.currentUser;
  if (!ready || !user) throw new Error("NOT_SIGNED_IN");
  const q = query(
    collection(db, "rides"),
    where("userId", "==", user.uid),
    where("status", "in", NON_TERMINAL)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * @param {{ confirmedExtraBooking?: boolean }} opts
 */
export async function checkCustomerBookingGate(opts = {}) {
  const { ready, functions, auth } = getFirebase();
  if (!ready || !auth?.currentUser) throw new Error("NOT_SIGNED_IN");

  if (functions) {
    try {
      const fn = httpsCallable(functions, "checkCustomerBookingGate");
      const result = await fn({
        confirmedExtraBooking: Boolean(opts.confirmedExtraBooking),
      });
      return result?.data || result;
    } catch (err) {
      // Functions not deployed yet — fall back to local count.
      console.warn("[SwiftGo] booking gate CF fallback", err?.code || err?.message);
    }
  }

  const active = await listActiveBookingsLocal();
  if (active.length >= 4) {
    return {
      allowed: false,
      reason: "MAX_ACTIVE_BOOKINGS",
      activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
    };
  }
  if (active.length >= 1 && !opts.confirmedExtraBooking) {
    return {
      allowed: false,
      needsConfirmation: true,
      reason: "CONFIRM_EXTRA_BOOKING",
      activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
    };
  }
  return {
    allowed: true,
    activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
  };
}

export async function listActiveCustomerBookings() {
  return listActiveBookingsLocal();
}
