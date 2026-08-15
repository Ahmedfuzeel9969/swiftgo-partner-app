/**
 * Phase 1 — billing / Firebase diagnostic report builders (lazy-loaded).
 * Runtime classifiers/constants live in phase1-billing-diagnostics.mjs.
 */

import {
  PHASE1_DRIVER_CONFIG,
  PHASE1_CUSTOMER_CONFIG,
  PHASE1_P2P_CONFIG,
} from "./phase1-billing-diagnostics.mjs";

function statsOfIntervals(intervals) {
  const xs = intervals.filter((n) => Number.isFinite(n) && n >= 0);
  if (!xs.length) {
    return { count: 0, avgMs: null, minMs: null, maxMs: null };
  }
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    count: xs.length,
    avgMs: Math.round(sum / xs.length),
    minMs: Math.min(...xs),
    maxMs: Math.max(...xs),
  };
}

/**
 * Build Phase 1 Report 1 — runtime configuration (static discovery).
 * @param {"customer"|"driver"} role
 */
export function buildRuntimeConfigReport(role = "unknown") {
  const lines = [
    "SwiftGo Phase 1 — Report 1: Current Runtime Configuration",
    `role=${role}`,
    `generatedAt=${new Date().toISOString()}`,
    "",
    "=== Driver publish configuration ===",
    JSON.stringify(PHASE1_DRIVER_CONFIG, null, 2),
    "",
    "=== Customer receive configuration ===",
    JSON.stringify(PHASE1_CUSTOMER_CONFIG, null, 2),
    "",
    "=== P2P configuration ===",
    JSON.stringify(PHASE1_P2P_CONFIG, null, 2),
    "",
    "Note: These values are read from the codebase constants. This report does not change any behaviour.",
    "",
  ];
  return lines.join("\n");
}

/**
 * @param {object} snap field-diagnostics snapshot
 * @param {object[]} events
 */
export function buildRideDiagnosticReport(snap, events = []) {
  const writeDetails = events.filter((e) => e.type === "firebase_write_detail");
  const skips = events.filter((e) => e.type === "firebase_write_skipped");
  const receives = events.filter((e) => e.type === "firebase_receive_detail");
  const p2pSend = events.filter((e) => e.type === "p2p_send");
  const p2pRecv = events.filter((e) => e.type === "p2p_receive");
  const p2pSendOk = p2pSend.filter((e) => e.data?.ok !== false);
  const p2pSendFail = p2pSend.filter((e) => e.data?.ok === false);

  const recvIntervals = p2pRecv
    .map((e, i, arr) => (i === 0 ? null : e.ts - arr[i - 1].ts))
    .filter((n) => Number.isFinite(n));
  const avgP2pRecvMs = recvIntervals.length
    ? Math.round(recvIntervals.reduce((a, b) => a + b, 0) / recvIntervals.length)
    : null;

  const seqs = p2pRecv.map((e) => Number(e.data?.sequence)).filter((n) => Number.isFinite(n) && n > 0);
  let missingPackets = null;
  if (seqs.length >= 2) {
    const min = Math.min(...seqs);
    const max = Math.max(...seqs);
    const unique = new Set(seqs);
    missingPackets = Math.max(0, max - min + 1 - unique.size);
  }

  const lines = [
    "SwiftGo Phase 1 — Report 2: Ride Diagnostic Report",
    `generatedAt=${new Date(snap?.reportedAt || Date.now()).toISOString()}`,
    `role=${snap?.role || "-"}`,
    `rideId=${snap?.rideId || "-"}`,
    `rideStatus=${snap?.rideStatus || "-"}`,
    "",
    "=== Plain-language summary ===",
    `Firebase location writes recorded: ${writeDetails.length}`,
    `Firebase writes skipped: ${skips.length}`,
    `Firebase location receives recorded: ${receives.length}`,
    `P2P packets sent (enqueued): ${p2pSend.length} (ok=${p2pSendOk.length}, failed=${p2pSendFail.length})`,
    `P2P packets received: ${p2pRecv.length}`,
    `P2P missing packets (sequence gaps estimate): ${missingPackets == null ? "—" : missingPackets}`,
    `P2P average receive interval ms: ${avgP2pRecvMs == null ? "—" : avgP2pRecvMs}`,
    "",
    "=== Firebase writes (detail) ===",
    JSON.stringify(writeDetails, null, 2),
    "",
    "=== Firebase writes skipped (plain language) ===",
    JSON.stringify(skips, null, 2),
    "",
    "=== Firebase receives (detail) ===",
    JSON.stringify(receives, null, 2),
    "",
    "=== P2P send/receive ===",
    JSON.stringify(
      {
        sends: p2pSend.slice(-100),
        receives: p2pRecv.slice(-100),
        p2pState: snap?.p2p || null,
        missingPacketsEstimate: missingPackets,
        averageReceiveIntervalMs: avgP2pRecvMs,
      },
      null,
      2
    ),
    "",
    "=== Full event ring (truncated) ===",
    JSON.stringify(events.slice(-200), null, 2),
    "",
  ];
  return lines.join("\n");
}

/**
 * @param {object} snap
 * @param {object[]} events
 * @param {{ rideStartedAt?: number, rideEndedAt?: number }} [opts]
 */
export function buildBillingAnalysisReport(snap, events = [], opts = {}) {
  const writeDetails = events.filter((e) => e.type === "firebase_write_detail");
  const writeSkips = events.filter((e) => e.type === "firebase_write_skipped");
  const recvDetails = events.filter((e) => e.type === "firebase_receive_detail");
  const p2pSends = events.filter((e) => e.type === "p2p_send");
  const p2pRecvs = events.filter((e) => e.type === "p2p_receive");
  const p2pSendOk = p2pSends.filter((e) => e.data?.ok !== false).length;
  const p2pSendFail = p2pSends.filter((e) => e.data?.ok === false).length;

  const writeIntervals = writeDetails
    .map((e) => e.data?.intervalSincePreviousWriteMs)
    .filter((n) => Number.isFinite(n));
  const recvIntervals = recvDetails
    .map((e) => e.data?.intervalSincePreviousReceiveMs)
    .filter((n) => Number.isFinite(n));
  const writeStats = statsOfIntervals(writeIntervals);
  const recvStats = statsOfIntervals(recvIntervals);

  const duplicates = recvDetails.filter(
    (e) =>
      e.data?.classification === "duplicate_document" ||
      e.data?.classification === "duplicate_location"
  );
  const uniqueRecvs = recvDetails.filter((e) => e.data?.classification === "new_location");
  const sameCoordRecvs = recvDetails.filter((e) => e.data?.classification === "same_coordinates");

  const p2pRecvIntervals = p2pRecvs
    .map((e, i, arr) => (i === 0 ? null : e.ts - arr[i - 1].ts))
    .filter((n) => Number.isFinite(n));
  const p2pRecvAvg = p2pRecvIntervals.length
    ? Math.round(p2pRecvIntervals.reduce((a, b) => a + b, 0) / p2pRecvIntervals.length)
    : null;
  const seqs = p2pRecvs.map((e) => Number(e.data?.sequence)).filter((n) => Number.isFinite(n) && n > 0);
  let missingPackets = null;
  if (seqs.length >= 2) {
    const min = Math.min(...seqs);
    const max = Math.max(...seqs);
    missingPackets = Math.max(0, max - min + 1 - new Set(seqs).size);
  }

  const start =
    Number(opts.rideStartedAt) ||
    Number(writeDetails[0]?.ts) ||
    Number(recvDetails[0]?.ts) ||
    Number(snap?.startedAt) ||
    Date.now();
  const end =
    Number(opts.rideEndedAt) ||
    Number(snap?.rideEndedAt) ||
    Number(snap?.reportedAt) ||
    Date.now();
  const durationMs = Math.max(1, end - start);
  const durationMin = durationMs / 60000;

  const fbWrites = writeDetails.length;
  const fbReads = recvDetails.length;
  const p2pSent = p2pSends.length;
  const p2pReceived = p2pRecvs.length;
  const totalLocUpdates = Math.max(1, uniqueRecvs.length + p2pReceived);
  const pctP2p = Math.round((p2pReceived / totalLocUpdates) * 1000) / 10;
  const pctFirebase = Math.round((uniqueRecvs.length / totalLocUpdates) * 1000) / 10;
  // Ops "saved" estimate: P2P receives that did not require an extra Firebase write/read pair.
  const estimatedSavedByP2p = p2pReceived;

  const unnecessaryWritesEstimate = writeSkips.length;
  const noBenefitReads = duplicates.length + sameCoordRecvs.length;

  const lines = [
    "SwiftGo Phase 1 — Report 3: Firebase Billing Analysis",
    `generatedAt=${new Date().toISOString()}`,
    `role=${snap?.role || "-"}`,
    `rideId=${snap?.rideId || "-"}`,
    "",
    "=== Ride duration ===",
    `durationMs=${durationMs}`,
    `durationMinutes=${Math.round(durationMin * 100) / 100}`,
    "",
    "=== Operation totals ===",
    `Firebase writes=${fbWrites}`,
    `Firebase reads (location snapshots classified)=${fbReads}`,
    `Duplicate Firebase reads=${duplicates.length}`,
    `Unique Firebase reads (new location)=${uniqueRecvs.length}`,
    `Same-coordinates Firebase reads=${sameCoordRecvs.length}`,
    `Firebase writes skipped=${writeSkips.length}`,
    `P2P packets sent=${p2pSent} (successful=${p2pSendOk}, failed=${p2pSendFail})`,
    `P2P packets received=${p2pReceived}`,
    `P2P missing packets (sequence gaps estimate)=${missingPackets == null ? "—" : missingPackets}`,
    `P2P average receive interval ms=${p2pRecvAvg == null ? "—" : p2pRecvAvg}`,
    "",
    "=== Timing ===",
    `Average Firebase write interval ms=${writeStats.avgMs}`,
    `Minimum Firebase write interval ms=${writeStats.minMs}`,
    `Maximum Firebase write interval ms=${writeStats.maxMs}`,
    `Average Firebase receive interval ms=${recvStats.avgMs}`,
    `Minimum Firebase receive interval ms=${recvStats.minMs}`,
    `Maximum Firebase receive interval ms=${recvStats.maxMs}`,
    `Estimated Firebase writes per minute=${Math.round((fbWrites / durationMin) * 100) / 100}`,
    `Estimated Firebase reads per minute=${Math.round((fbReads / durationMin) * 100) / 100}`,
    "",
    "=== Path mix (location updates) ===",
    `Estimated percentage handled through P2P=${pctP2p}%`,
    `Estimated percentage handled through Firebase=${pctFirebase}%`,
    `Estimated Firebase operations saved because of P2P (receive-side count)=${estimatedSavedByP2p}`,
    "",
    "=== Why writes occurred (counts by reason) ===",
    JSON.stringify(
      writeDetails.reduce((acc, e) => {
        const k = e.data?.writeReasonLabel || e.data?.writeReasonCode || "unknown";
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      null,
      2
    ),
    "",
    "=== Why reads occurred / duplicate analysis ===",
    JSON.stringify(
      {
        byClassification: recvDetails.reduce((acc, e) => {
          const k = e.data?.classification || "unknown";
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {}),
        duplicatePlainLanguage:
          "Duplicate Firebase reads mean the listener delivered a snapshot whose driver location fields did not change. The UI correctly did not need a map move.",
        reconnectionNote:
          "This client uses a continuous onSnapshot listener; reconnect storms would appear as clusters of duplicate_document receives without new observedAt/sequence.",
        estimatedReadsWithNoNewLocation: noBenefitReads,
        estimatedWritesAvoidedByGates: unnecessaryWritesEstimate,
      },
      null,
      2
    ),
    "",
    "=== Safety findings (observe-only) ===",
    `- Skipped writes (${writeSkips.length}) are intentional rate-limits; performing them would increase billing without new value when only interval/movement gates blocked them.`,
    `- Duplicate reads (${duplicates.length}) consumed a listener callback but contained no new driver location.`,
    `- Same-coordinate reads (${sameCoordRecvs.length}) also produced no map move.`,
    `- Writes with no practical customer benefit would be those that never change lat/lng/sequence on the mirrored ride (investigate via customer duplicate receives after a write).`,
    "",
    "=== Recommendations for a FUTURE optimization phase (do not apply now) ===",
    "1. Confirm with driver publish_blocked / firebase_write_skipped reasons which gate dominates (interval vs accuracy vs out_of_order).",
    "2. Prefer healthy P2P for visible customers so Firebase can stay sparse without freezing the marker.",
    "3. Avoid treating client-side receive stamps as proof of a fresh GPS fix when observedAt is old.",
    "4. Only after measurement, consider threshold/policy changes in a separate approved phase.",
    "",
  ];
  return lines.join("\n");
}

/**
 * Record an automatic billing summary when a ride completes (observe-only).
 * @param {object} diag field-diagnostics instance with Phase 1 attached
 * @param {{ rideId?: string }} [opts]
 */
export function attachPhase1Reports(diag) {
  if (!diag || diag.__phase1Attached) return diag;
  diag.__phase1Attached = true;

  diag.buildRuntimeConfigReport = () => buildRuntimeConfigReport(diag.getSnapshot?.()?.role || "unknown");
  diag.buildRideDiagnosticReport = () =>
    buildRideDiagnosticReport(diag.getSnapshot?.() || {}, diag.getEvents?.() || []);
  diag.buildBillingAnalysisReport = (opts) =>
    buildBillingAnalysisReport(diag.getSnapshot?.() || {}, diag.getEvents?.() || [], opts || {});

  diag.copyPhase1Reports = async () => {
    const text = [
      diag.buildRuntimeConfigReport(),
      "",
      "==========",
      "",
      diag.buildRideDiagnosticReport(),
      "",
      "==========",
      "",
      diag.buildBillingAnalysisReport(),
    ].join("\n");
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard", bytes: text.length, text };
    }
    return { ok: false, method: "none", bytes: text.length, text };
  };

  if (typeof globalThis !== "undefined") {
    globalThis.__SWIFTGO_COPY_PHASE1_REPORTS__ = () => diag.copyPhase1Reports();
    globalThis.__SWIFTGO_PHASE1_RUNTIME_CONFIG__ = () => diag.buildRuntimeConfigReport();
    globalThis.__SWIFTGO_PHASE1_RIDE_DIAG__ = () => diag.buildRideDiagnosticReport();
    globalThis.__SWIFTGO_PHASE1_BILLING__ = () => diag.buildBillingAnalysisReport();
  }
  return diag;
}
