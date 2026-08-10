/**
 * Super Admin settings — trusted Cloud Functions (Admin SDK writes)
 * with forced ID-token refresh before every callable.
 */

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js?v=dispatch_dynamic_1";

function wrapCallableError(name, error) {
  const code = String(error?.code || "unknown");
  const message = String(error?.message || "FAILED");
  console.error("[Financial Settings Error]:", code, message, { callable: name, error });
  const wrapped = new Error(message);
  wrapped.code = code;
  wrapped.cause = error;
  wrapped.callable = name;
  return wrapped;
}

/** Force-refresh Auth ID token so callables receive request.auth. */
export async function ensureFreshAuthUser() {
  const { ready, auth } = getFirebase();
  if (!ready || !auth) {
    const err = new Error("AUTH_UNAVAILABLE");
    err.code = "unauthenticated";
    throw err;
  }
  const user = auth.currentUser;
  if (!user) {
    const err = new Error("AUTH_REQUIRED");
    err.code = "unauthenticated";
    console.error("[Financial Settings Error]:", err.code, "No auth.currentUser");
    throw err;
  }
  await user.getIdToken(true);
  return user;
}

export async function callAdmin(name, data = {}) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) {
    const err = new Error("FUNCTIONS_UNAVAILABLE");
    err.code = "functions/unavailable";
    console.error("[Financial Settings Error]:", err.code, err.message);
    throw err;
  }
  await ensureFreshAuthUser();
  try {
    const result = await httpsCallable(functions, name)(data);
    return result?.data ?? result;
  } catch (error) {
    throw wrapCallableError(name, error);
  }
}

/** Persist settings/pricing via Admin SDK (bypasses client rule edge cases). */
export function saveAdminPricingSettings(payload) {
  return callAdmin("saveAdminPricingSettings", payload);
}

/** Dispatch settings — candidate limit + search radius. */
export function saveAdminDispatchSettings(payload) {
  return callAdmin("setCandidateDriverLimit", payload);
}

/** Location reporting config — settings/locationReporting (diagnostic only). */
export function saveAdminLocationReportingSettings(payload) {
  return callAdmin("saveAdminLocationReportingSettings", payload);
}

/** @deprecated Use saveAdminDispatchSettings */
export function saveAdminDispatchLimit(candidateDriverLimit) {
  return saveAdminDispatchSettings({ candidateDriverLimit: Number(candidateDriverLimit) });
}

/** One-time grant admin: true claim when bootstrap is enabled. */
export function bootstrapAdminClaim() {
  return callAdmin("bootstrapAdminClaim", {});
}

/** First owner login: enable bootstrap + admin claim + users.role. */
export function initSuperAdminAccess() {
  return callAdmin("initSuperAdminAccess", {});
}
