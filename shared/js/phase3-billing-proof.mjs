/**
 * Phase 3 — Firebase billing proof helpers (lightweight facade).
 * Report builders live in phase3-billing-reports.mjs (lazy-loaded).
 */

import { classifyDuplicateReceiveReason } from "./phase2-runtime-verification.mjs";

export function proveFirebaseReadReason(recvData = {}) {
  const classification = recvData.classification || "";
  if (classification === "new_location" || classification === "empty") {
    if (classification === "empty") {
      return {
        code: "other",
        label: "Other (empty location snapshot)",
        plain:
          "Firebase snapshot received without driver location fields. Exact reason: ride document update without a usable driverLocation payload.",
      };
    }
    return {
      code: "new_document_data",
      label: "New document data",
      plain:
        "New document data — driverLocation identity (coordinates and/or GPS timestamp and/or sequence) changed vs the previous receive.",
    };
  }

  const dup =
    recvData.duplicateReason ||
    classifyDuplicateReceiveReason({
      classification,
      intervalSincePreviousReceiveMs: recvData.intervalSincePreviousReceiveMs,
      rideStatusChanged: recvData.rideStatusChanged === true,
      sameSequence: recvData.sameSequence === true,
      sameGpsTimestamp: recvData.sameGpsTimestamp === true,
      sameCoordinates: recvData.sameCoordinates === true,
    });

  const codeMap = {
    metadata_update: "metadata_update",
    listener_replay: "listener_replay",
    snapshot_replay: "listener_replay",
    connection_restored: "connection_restored",
    offline_cache_replay: "offline_cache_replay",
    document_modified: "document_modified",
    other: "other",
  };
  const code = codeMap[dup.code] || "document_modified";
  const labels = {
    metadata_update: "Metadata update",
    listener_replay: "Listener replay",
    connection_restored: "Connection restored",
    offline_cache_replay: "Offline cache replay",
    document_modified: "Document modified",
    other: "Other",
  };

  return {
    code,
    label: labels[code] || "Document modified",
    plain:
      dup.plain ||
      recvData.plainText ||
      `Exact reason: ${code} — continuous Firestore onSnapshot delivered a ride-document callback with unchanged driver location identity.`,
  };
}
