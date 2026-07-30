/**
 * Phase 2A — customer booking gate via trusted Cloud Function.
 * Live non-terminal `rides` for the signed-in UID are the only count source of truth.
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";
import {
  MAX_CUSTOMER_ACTIVE_BOOKINGS,
  NON_TERMINAL_RIDE_STATUSES,
} from "./ride-status.js";

async function listActiveBookingsLocal() {
  const { ready, db, auth } = getFirebase();
  const user = auth?.currentUser;
  if (!ready || !user) throw new Error("NOT_SIGNED_IN");
  const q = query(
    collection(db, "rides"),
    where("userId", "==", user.uid),
    where("status", "in", [...NON_TERMINAL_RIDE_STATUSES])
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, status: d.data()?.status, ...d.data() }));
}

function evaluateLocalGate(active, confirmedExtraBooking) {
  const count = active.length;
  if (count >= MAX_CUSTOMER_ACTIVE_BOOKINGS) {
    return {
      allowed: false,
      reason: "MAX_ACTIVE_BOOKINGS",
      count,
      activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
    };
  }
  if (count >= 1 && !confirmedExtraBooking) {
    return {
      allowed: false,
      needsConfirmation: true,
      reason: "CONFIRM_EXTRA_BOOKING",
      count,
      activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
    };
  }
  return {
    allowed: true,
    count,
    activeBookings: active.map((r) => ({ id: r.id, status: r.status })),
  };
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
      const data = result?.data || result;
      if (data && typeof data.allowed === "boolean") {
        return data;
      }
      console.warn("[SwiftGo] booking gate CF returned invalid payload", data);
    } catch (err) {
      const code = String(err?.code || "");
      // Only fall back when Functions are unreachable; never invent MAX from cache.
      if (
        code.includes("unavailable") ||
        code.includes("not-found") ||
        code.includes("FUNCTIONS_UNAVAILABLE") ||
        /internal/i.test(String(err?.message || ""))
      ) {
        console.warn("[SwiftGo] booking gate CF fallback to live rides query", code || err?.message);
      } else {
        throw err;
      }
    }
  }

  const active = await listActiveBookingsLocal();
  return evaluateLocalGate(active, Boolean(opts.confirmedExtraBooking));
}

export async function listActiveCustomerBookings() {
  return listActiveBookingsLocal();
}
