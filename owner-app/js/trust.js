/**
 * Phase 4E — Owner trust clients.
 */
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { getFirebase } from "./firebase.js";

export const LEGAL = {
  privacy: "/legal/privacy.html",
  terms: "/legal/terms.html",
  dataUse: "/legal/data-use.html",
};

function call(name, data) {
  const { ready, functions } = getFirebase();
  if (!ready || !functions) throw new Error("FUNCTIONS_UNAVAILABLE");
  return httpsCallable(functions, name)(data).then((r) => r?.data || r);
}

export async function requestAccountDeletionClient({ reason = "", roleHint = "owner", appId = "owner" } = {}) {
  return call("requestAccountDeletion", { reason, roleHint, appId });
}

export async function submitSupportReportClient({
  message,
  category = "complaint",
  appId = "owner",
} = {}) {
  return call("submitSupportReport", { message, category, appId });
}

export function wireLegalLinks(root = document) {
  root.querySelectorAll("[data-legal]").forEach((el) => {
    const key = el.getAttribute("data-legal");
    if (key && LEGAL[key]) el.setAttribute("href", LEGAL[key]);
  });
}
