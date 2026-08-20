/**
 * Task 3C — Super Admin owner application approval clients.
 */
import { callAdmin } from "./admin-settings-client.js?v=owner_apps_1";

export async function approveOwnerAccessClient({ targetUid }) {
  const uid = String(targetUid || "").trim();
  if (!uid) throw new Error("MISSING_TARGET_UID");
  return callAdmin("approveOwnerAccess", { targetUid: uid });
}

export async function rejectOwnerAccessClient({ targetUid, reason }) {
  const uid = String(targetUid || "").trim();
  if (!uid) throw new Error("MISSING_TARGET_UID");
  return callAdmin("rejectOwnerAccess", { targetUid: uid, reason: String(reason || "").trim() });
}
