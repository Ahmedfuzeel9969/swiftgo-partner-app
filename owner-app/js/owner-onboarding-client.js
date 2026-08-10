/**
 * Task 3B — Owner onboarding callables (request + admin grant is server-side only).
 */
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";

function call(name, data) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  return httpsCallable(functions, name)(data).then((r) => r?.data || r);
}

export async function requestOwnerAccessClient({ fullName = "", businessName = "" } = {}) {
  return call("requestOwnerAccess", { fullName, businessName });
}
