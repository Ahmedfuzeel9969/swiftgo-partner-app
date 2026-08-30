/**
 * Task 3C — Super Admin owner application approval clients.
 */
// Keep this version aligned with admin-app.js so browsers cannot retain an
// older settings client that predates the exported callAdmin helper.
import { callAdmin } from "./admin-settings-client.js?v=admin_settings_2";

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
