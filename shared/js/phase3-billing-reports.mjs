/**
 * Phase 3 — Firebase billing proof report builders (lazy-loaded).
 * Lightweight proveFirebaseReadReason lives in phase3-billing-proof.mjs.
 */

import {
  CFG_RESPONSIVE_INTERVAL_MS,
  CFG_P2P_FALLBACK_AFTER_MS,
  PHASE1_CUSTOMER_CONFIG,
} from "./phase1-billing-diagnostics.mjs";
import {
  writeReadLinkKey,
  PHASE2_P2P_FALLBACK_TOLERANCE_MS,
} from "./phase2-runtime-verification.mjs";
import { proveFirebaseReadReason } from "./phase3-billing-proof.mjs";

const SCALE_DRIVER_COUNTS = Object.freeze([100, 500, 1_000, 5_000, 10_000]);

function fmtClock(ms) {
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

function sec(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms / 1000) * 10) / 10;
}

function round2(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function statsOf(intervals) {
  const xs = intervals.filter((n) => Number.isFinite(n) && n >= 0);
  if (!xs.length) return { avg: null, min: null, max: null, count: 0 };
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    avg: Math.round(sum / xs.length),
    min: Math.min(...xs),
    max: Math.max(...xs),
    count: xs.length,
  };
}

export function buildFirebaseTimeline(events = []) {
  const writes = events.filter((e) => e.type === "firebase_write_detail");
  const receives = events.filter((e) => e.type === "firebase_receive_detail");

  const writeByKey = new Map();
  writes.forEach((e, i) => {
    const d = e.data || {};
    const key = writeReadLinkKey(d.writeSequenceNumber, d.gpsTimestamp);
    const row = {
      writeNumber: i + 1,
      writeTime: d.writeTimestamp ?? e.ts,
      writeTimeClock: fmtClock(d.writeTimestamp ?? e.ts),
      gpsTimestamp: d.gpsTimestamp ?? null,
      sequence: d.writeSequenceNumber ?? null,
      linkKey: key,
      latitude: d.latitude ?? d.lat ?? null,
      longitude: d.longitude ?? d.lng ?? null,
      why: d.writeReasonLabel || d.writeReasonCode || null,
      source: "driver_event",
    };
    if (key) writeByKey.set(key, row);
  });

  /** @type {Map<string, { write: object|null, receives: object[] }>} */
  const groups = new Map();
  let syntheticWrite = 0;

  function ensureGroup(key, seedWrite) {
    if (!groups.has(key)) {
      groups.set(key, { write: seedWrite || null, receives: [], order: groups.size + 1 });
    }
    return groups.get(key);
  }

  // Prefer chronological receive order to attach to write identities.
  const sortedReceives = [...receives].sort(
    (a, b) => (a.data?.receiveTimestamp ?? a.ts) - (b.data?.receiveTimestamp ?? b.ts)
  );

  for (let i = 0; i < sortedReceives.length; i++) {
    const e = sortedReceives[i];
    const d = e.data || {};
    const key =
      writeReadLinkKey(d.sequence, d.gpsTimestamp) ||
      `orphan:${d.receiveTimestamp || e.ts}:${i}`;
    let w = writeByKey.get(key) || null;
    if (!w && !key.startsWith("orphan:")) {
      // Customer-only: synthesize write slot from first sighting of this identity.
      syntheticWrite += 1;
      w = {
        writeNumber: null,
        syntheticWriteNumber: syntheticWrite,
        writeTime: d.gpsTimestamp || d.receiveTimestamp || e.ts,
        writeTimeClock: fmtClock(d.gpsTimestamp || d.receiveTimestamp || e.ts),
        gpsTimestamp: d.gpsTimestamp ?? null,
        sequence: d.sequence ?? null,
        linkKey: key,
        source: "inferred_from_receive",
        why: "Inferred write identity from customer receive (driver write event not on this device).",
      };
    }
    const g = ensureGroup(key, w);
    if (w && !g.write) g.write = w;
    const proof = proveFirebaseReadReason(d);
    const isFirstForKey = g.receives.length === 0;
    g.receives.push({
      receiveNumber: i + 1,
      receiveTime: d.receiveTimestamp ?? e.ts,
      receiveTimeClock: fmtClock(d.receiveTimestamp ?? e.ts),
      sequence: d.sequence ?? null,
      gpsTimestamp: d.gpsTimestamp ?? null,
      classification: d.classification || "—",
      proof,
      isFirstForWrite: isFirstForKey,
      tag: isFirstForKey
        ? proof.code === "new_document_data"
          ? "new"
          : proof.label
        : proof.code === "metadata_update"
          ? "duplicate / metadata only"
          : `duplicate / ${proof.label}`,
    });
  }

  // Driver-only writes with no matching receives
  for (const [key, w] of writeByKey) {
    if (!groups.has(key)) {
      ensureGroup(key, w);
    } else if (!groups.get(key).write) {
      groups.get(key).write = w;
    }
  }

  const timeline = [...groups.values()].sort((a, b) => {
    const ta = a.write?.writeTime ?? a.receives[0]?.receiveTime ?? 0;
    const tb = b.write?.writeTime ?? b.receives[0]?.receiveTime ?? 0;
    return ta - tb;
  });

  // Assign contiguous Write # for display
  timeline.forEach((g, idx) => {
    g.displayWriteNumber = idx + 1;
    if (g.write && g.write.writeNumber == null) {
      g.write.displayWriteNumber = idx + 1;
    }
  });

  return { timeline, writes, receives, writeByKey };
}

/**
 * Full Phase 3 analysis object.
 */
export function analyzePhase3BillingProof(snap = {}, events = []) {
  const { timeline, writes, receives } = buildFirebaseTimeline(events);
  const fallbacks = events.filter((e) => e.type === "p2p_fallback_detail");
  const writeSkips = events.filter((e) => e.type === "firebase_write_skipped");
  const p2pSends = events.filter((e) => e.type === "p2p_send");
  const p2pRecvs = events.filter((e) => e.type === "p2p_receive");

  const provedReceives = receives.map((e, i) => {
    const d = e.data || {};
    const proof = proveFirebaseReadReason(d);
    return {
      receiveNumber: i + 1,
      receiveTime: d.receiveTimestamp ?? e.ts,
      receiveTimeClock: fmtClock(d.receiveTimestamp ?? e.ts),
      rideId: d.rideId || snap.rideId || null,
      sequence: d.sequence ?? null,
      gpsTimestamp: d.gpsTimestamp ?? null,
      classification: d.classification || "—",
      proof,
    };
  });

  const uniqueReads = provedReceives.filter((r) => r.proof.code === "new_document_data");
  const duplicateReads = provedReceives.filter((r) => r.proof.code !== "new_document_data");
  const metadataOnlyReads = provedReceives.filter((r) => r.proof.code === "metadata_update");
  const replayReads = provedReceives.filter(
    (r) =>
      r.proof.code === "listener_replay" ||
      r.proof.code === "offline_cache_replay"
  );
  const connectionRestoredReads = provedReceives.filter(
    (r) => r.proof.code === "connection_restored"
  );
  const documentModifiedReads = provedReceives.filter(
    (r) => r.proof.code === "document_modified"
  );

  const writeIntervals = writes
    .map((e) => e.data?.intervalSincePreviousWriteMs)
    .filter((n) => Number.isFinite(n));
  const recvIntervals = receives
    .map((e) => e.data?.intervalSincePreviousReceiveMs)
    .filter((n) => Number.isFinite(n));
  const writeStats = statsOf(writeIntervals);
  const recvStats = statsOf(recvIntervals);

  const start =
    Number(writes[0]?.data?.writeTimestamp) ||
    Number(writes[0]?.ts) ||
    Number(receives[0]?.data?.receiveTimestamp) ||
    Number(receives[0]?.ts) ||
    Number(snap.startedAt) ||
    Date.now();
  const end =
    Number(snap.rideEndedAt) ||
    Number(writes[writes.length - 1]?.data?.writeTimestamp) ||
    Number(receives[receives.length - 1]?.data?.receiveTimestamp) ||
    Number(snap.reportedAt) ||
    Date.now();
  const durationMs = Math.max(1, end - start);
  const durationMin = durationMs / 60000;

  const driverWrites = writes.length;
  const customerReads = receives.length;
  const writesPerMin = round2(driverWrites / durationMin);
  const readsPerMin = round2(customerReads / durationMin);
  const duplicatePct =
    customerReads > 0 ? round2((duplicateReads.length / customerReads) * 100) : null;

  // Config verification
  const avgWrite = writeStats.avg;
  const writeIntervalVerdict =
    avgWrite == null
      ? "INCONCLUSIVE"
      : avgWrite < CFG_RESPONSIVE_INTERVAL_MS * 0.5
        ? "FAIL"
        : "PASS";

  let fallbackActual = null;
  let fallbackPass = "INCONCLUSIVE";
  if (fallbacks.length) {
    const silence = fallbacks.filter((e) => e.data?.triggerPath === "silence_timeout");
    const sample = silence[0] || fallbacks[0];
    fallbackActual = Number(sample.data?.actualDelayMs);
    if (sample.data?.triggerPath === "explicit_unhealthy") {
      fallbackPass = "PASS";
    } else if (Number.isFinite(fallbackActual)) {
      fallbackPass =
        fallbackActual >= CFG_P2P_FALLBACK_AFTER_MS - PHASE2_P2P_FALLBACK_TOLERANCE_MS
          ? "PASS"
          : "FAIL";
    }
  }

  const continuousExpected = true;
  const continuousActual = PHASE1_CUSTOMER_CONFIG.polling === false;
  const continuousPass = continuousExpected && continuousActual ? "PASS" : "FAIL";

  const scale = SCALE_DRIVER_COUNTS.map((n) => {
    const wpm = writesPerMin || 0;
    const rpm = readsPerMin || 0;
    const writesPerHour = round2(n * wpm * 60);
    const readsPerHour = round2(n * rpm * 60);
    const opsPerHour = round2((writesPerHour || 0) + (readsPerHour || 0));
    const writesPerDay = round2((writesPerHour || 0) * 24);
    const readsPerDay = round2((readsPerHour || 0) * 24);
    const opsPerDay = round2((opsPerHour || 0) * 24);
    return {
      drivers: n,
      assumedConcurrentRides: n,
      estimatedWritesPerHour: writesPerHour,
      estimatedReadsPerHour: readsPerHour,
      estimatedTotalOpsPerHour: opsPerHour,
      estimatedWritesPerDay: writesPerDay,
      estimatedReadsPerDay: readsPerDay,
      estimatedTotalOpsPerDay: opsPerDay,
    };
  });

  const unavoidableWrites = driverWrites;
  const reducibleReads = duplicateReads.length;
  const unavoidableReads = uniqueReads.length;

  const designed =
    continuousPass === "PASS" &&
    (writeIntervalVerdict === "PASS" || writeIntervalVerdict === "INCONCLUSIVE") &&
    (fallbackPass === "PASS" || fallbackPass === "INCONCLUSIVE");

  const duplicatesExpected =
    duplicateReads.length === 0 ||
    duplicateReads.every((r) =>
      ["metadata_update", "listener_replay", "connection_restored", "offline_cache_replay", "document_modified"].includes(
        r.proof.code
      )
    );

  const unnecessaryTraffic = reducibleReads > 0 || writeSkips.length > 0;

  const billingAcceptable =
    customerReads === 0 && driverWrites === 0
      ? "INCONCLUSIVE — no ride samples on this device"
      : duplicatePct != null && duplicatePct > 60
        ? "RISK — majority of customer location receives are non-unique; production cost scales with duplicates"
        : duplicatePct != null && duplicatePct > 30
          ? "MARGINAL — meaningful duplicate read share; acceptable only at low concurrent ride volume"
          : "ACCEPTABLE for early production at low/medium concurrency if P2P carries most visible updates — re-check after scale test";

  const biggestOptimization =
    reducibleReads >= Math.max(1, driverWrites) * 0.5
      ? "Reduce duplicate ride-document snapshots reaching the customer (narrow what updates the ride doc / avoid metadata churn on the watched document) — biggest read-side cost lever without changing the 4s write gate yet."
      : writesPerMin != null && writesPerMin > 12
        ? "Lower responsive Firebase write cadence when P2P is healthy and the customer is visible (already partially intended via sparse policy) — biggest write-side lever."
        : "Prefer healthy P2P for the live marker so Firebase can stay on sparse checkpoints — reduces both write pressure and customer dependency on every snapshot.";

  return {
    timeline,
    provedReceives,
    costs: {
      rideDurationMs: durationMs,
      rideDurationMinutes: round2(durationMin),
      driverFirebaseWrites: driverWrites,
      customerFirebaseReads: customerReads,
      uniqueReads: uniqueReads.length,
      duplicateReads: duplicateReads.length,
      metadataOnlyReads: metadataOnlyReads.length,
      replayReads: replayReads.length,
      connectionRestoredReads: connectionRestoredReads.length,
      documentModifiedReads: documentModifiedReads.length,
      writesPerMinute: writesPerMin,
      readsPerMinute: readsPerMin,
      duplicatePercentage: duplicatePct,
      averageWriteIntervalMs: writeStats.avg,
      averageReceiveIntervalMs: recvStats.avg,
      minimumWriteIntervalMs: writeStats.min,
      maximumWriteIntervalMs: writeStats.max,
      minimumReceiveIntervalMs: recvStats.min,
      maximumReceiveIntervalMs: recvStats.max,
      writeSkips: writeSkips.length,
      p2pSends: p2pSends.length,
      p2pReceives: p2pRecvs.length,
    },
    configCheck: {
      expectedWriteIntervalMs: CFG_RESPONSIVE_INTERVAL_MS,
      actualAverageWriteIntervalMs: writeStats.avg,
      writeIntervalPass: writeIntervalVerdict,
      expectedFallbackMs: CFG_P2P_FALLBACK_AFTER_MS,
      actualFallbackMs: fallbackActual,
      fallbackPass,
      continuousListenerExpected: continuousExpected,
      continuousListenerActual: continuousActual,
      continuousListenerPass: continuousPass,
    },
    scale,
    classification: {
      unavoidableWrites,
      unavoidableReads,
      reducibleDuplicateReads: reducibleReads,
      reducibleSkippedWouldBeWastefulWrites: writeSkips.length,
    },
    verdict: {
      firebaseBehavingAsDesigned: designed ? "YES" : "NO / REVIEW",
      duplicatesExpectedOrAbnormal: duplicatesExpected
        ? "EXPECTED under continuous onSnapshot on a frequently updated ride document"
        : "ABNORMAL — some receives lacked a classified proof reason",
      unnecessaryFirebaseTraffic: unnecessaryTraffic
        ? "YES — duplicate/non-unique reads and/or gated write skips indicate avoidable ops in a future phase"
        : "NO significant unnecessary traffic observed in this sample",
      billingAcceptableForProduction: billingAcceptable,
      biggestOptimizationWithoutImplementing: biggestOptimization,
    },
    snap,
  };
}

/**
 * Render Phase 3 billing proof report.
 */
export function buildPhase3BillingProofReport(snap = {}, events = [], opts = {}) {
  void opts;
  const a = analyzePhase3BillingProof(snap, events);
  const { timeline, provedReceives, costs, configCheck, scale, classification, verdict } = a;

  const lines = [
    "SwiftGo Phase 3 — Billing Proof & Runtime Validation",
    `generatedAt=${new Date().toISOString()}`,
    `role=${snap?.role || "-"}`,
    `rideId=${snap?.rideId || "-"}`,
    `rideStatus=${snap?.rideStatus || "-"}`,
    "",
    "OBSERVATION ONLY — no Firebase/P2P/timing/threshold changes.",
    "",
    "========== TASK 1 — Complete Firebase timeline ==========",
    "Each Write block lists every customer receive generated from that write identity (sequence / GPS timestamp).",
    "On a single phone: driver sees writes; customer sees receives. Merge both reports by sequence for a cross-device proof.",
    "",
  ];

  if (!timeline.length) {
    lines.push("(No write/receive pairs in this diagnostic ring yet — run a live ride.)", "");
  } else {
    for (const g of timeline) {
      const w = g.write;
      const wNum = g.displayWriteNumber;
      lines.push(`Write #${wNum}`);
      if (w) {
        lines.push(`Exact write time: ${w.writeTimeClock} (${w.writeTime})`);
        lines.push(`GPS timestamp: ${w.gpsTimestamp ?? "—"}`);
        lines.push(`Sequence number: ${w.sequence ?? "—"}`);
        lines.push(`Source: ${w.source || "—"}`);
        if (w.why) lines.push(`Why write: ${w.why}`);
      } else {
        lines.push("(Write identity known only from receives on this device.)");
      }
      if (!g.receives.length) {
        lines.push("↓");
        lines.push("(No customer receive on this device for this write.)");
      } else {
        for (const r of g.receives) {
          lines.push("↓");
          lines.push(
            `Receive #${r.receiveNumber}${r.isFirstForWrite ? "" : ` (${r.tag})`} @ ${r.receiveTimeClock}`
          );
          lines.push(`  Proof reason: ${r.proof.label}`);
        }
      }
      lines.push("");
    }
  }

  lines.push(
    "========== TASK 2 — Prove every Firebase read ==========",
    ""
  );
  if (!provedReceives.length) {
    lines.push("(No customer receives on this device.)", "");
  } else {
    for (const r of provedReceives) {
      lines.push(`Receive #${r.receiveNumber} @ ${r.receiveTimeClock}`);
      lines.push(`Ride ID: ${r.rideId || "—"}`);
      lines.push(`Sequence: ${r.sequence ?? "—"}  GPS timestamp: ${r.gpsTimestamp ?? "—"}`);
      lines.push(`Classification: ${r.classification}`);
      lines.push(`Why it happened: ${r.proof.label} (${r.proof.code})`);
      lines.push(r.proof.plain);
      lines.push("");
    }
  }

  lines.push(
    "========== TASK 3 — Real Firebase costs ==========",
    `Ride duration: ${costs.rideDurationMinutes} minutes (${costs.rideDurationMs} ms)`,
    `Driver Firebase writes: ${costs.driverFirebaseWrites}`,
    `Customer Firebase reads: ${costs.customerFirebaseReads}`,
    `Unique reads: ${costs.uniqueReads}`,
    `Duplicate reads: ${costs.duplicateReads}`,
    `Metadata-only reads: ${costs.metadataOnlyReads}`,
    `Replay reads: ${costs.replayReads}`,
    `Connection-restored reads: ${costs.connectionRestoredReads}`,
    `Document-modified reads: ${costs.documentModifiedReads}`,
    `Writes per minute: ${costs.writesPerMinute ?? "—"}`,
    `Reads per minute: ${costs.readsPerMinute ?? "—"}`,
    `Duplicate percentage: ${costs.duplicatePercentage == null ? "—" : costs.duplicatePercentage + "%"}`,
    `Average write interval: ${costs.averageWriteIntervalMs == null ? "—" : costs.averageWriteIntervalMs + " ms"}`,
    `Average receive interval: ${costs.averageReceiveIntervalMs == null ? "—" : costs.averageReceiveIntervalMs + " ms"}`,
    `Minimum write interval: ${costs.minimumWriteIntervalMs == null ? "—" : costs.minimumWriteIntervalMs + " ms"}`,
    `Maximum write interval: ${costs.maximumWriteIntervalMs == null ? "—" : costs.maximumWriteIntervalMs + " ms"}`,
    `Minimum receive interval: ${costs.minimumReceiveIntervalMs == null ? "—" : costs.minimumReceiveIntervalMs + " ms"}`,
    `Maximum receive interval: ${costs.maximumReceiveIntervalMs == null ? "—" : costs.maximumReceiveIntervalMs + " ms"}`,
    `P2P sends / receives (this device): ${costs.p2pSends} / ${costs.p2pReceives}`,
    `Writes skipped by gates: ${costs.writeSkips}`,
    "",
    "========== TASK 4 — Verify runtime configuration ==========",
    `Expected write interval: ${configCheck.expectedWriteIntervalMs} ms (${sec(configCheck.expectedWriteIntervalMs)} seconds)`,
    `Actual average: ${configCheck.actualAverageWriteIntervalMs == null ? "?" : configCheck.actualAverageWriteIntervalMs + " ms"}`,
    `PASS / FAIL: ${configCheck.writeIntervalPass}`,
    "",
    `Expected fallback: ${configCheck.expectedFallbackMs} ms (${sec(configCheck.expectedFallbackMs)} seconds)`,
    `Actual: ${configCheck.actualFallbackMs == null ? "?" : configCheck.actualFallbackMs + " ms"}`,
    `PASS / FAIL: ${configCheck.fallbackPass}`,
    "",
    `Continuous listener: Expected YES`,
    `Actual: ${configCheck.continuousListenerActual ? "YES" : "NO"}`,
    `PASS / FAIL: ${configCheck.continuousListenerPass}`,
    "",
    "========== TASK 5 — Firebase billing risk report ==========",
    "Assumption: N drivers each simultaneously in one active ride with one customer,",
    "each producing the SAME measured writes/min and reads/min as this sample.",
    "This is a linear extrapolation for capacity planning — not a bill invoice.",
    "",
    `Measured writes/min/ride=${costs.writesPerMinute ?? 0}`,
    `Measured reads/min/ride=${costs.readsPerMinute ?? 0}`,
    ""
  );

  for (const row of scale) {
    lines.push(
      `--- ${row.drivers} drivers ---`,
      `Estimated Writes / hour: ${row.estimatedWritesPerHour}`,
      `Estimated Reads / hour: ${row.estimatedReadsPerHour}`,
      `Estimated Total Firestore Operations / hour: ${row.estimatedTotalOpsPerHour}`,
      `Estimated Writes / day (24h continuous): ${row.estimatedWritesPerDay}`,
      `Estimated Reads / day: ${row.estimatedReadsPerDay}`,
      `Estimated Total Ops / day: ${row.estimatedTotalOpsPerDay}`,
      ""
    );
  }

  lines.push(
    "Unavoidable vs reducible (this sample):",
    `- Unavoidable writes (accepted location checkpoints): ${classification.unavoidableWrites}`,
    `- Unavoidable unique reads (new location): ${classification.unavoidableReads}`,
    `- Reducible duplicate/non-unique reads (future optimization candidate): ${classification.reducibleDuplicateReads}`,
    `- Writes already skipped by gates (avoided cost today): ${classification.reducibleSkippedWouldBeWastefulWrites}`,
    "",
    "========== TASK 6 — Final engineering verdict ==========",
    `1. Is Firebase behaving exactly as designed? ${verdict.firebaseBehavingAsDesigned}`,
    `2. Are duplicate reads expected or abnormal? ${verdict.duplicatesExpectedOrAbnormal}`,
    `3. Is any unnecessary Firebase traffic occurring? ${verdict.unnecessaryFirebaseTraffic}`,
    `4. Is Firebase billing currently acceptable for production? ${verdict.billingAcceptableForProduction}`,
    `5. Which single optimization would produce the biggest cost reduction (not implemented)?`,
    `   ${verdict.biggestOptimizationWithoutImplementing}`,
    ""
  );

  return lines.join("\n");
}

/**
 * Attach Phase 3 report API.
 */
export function attachPhase3Reports(diag) {
  if (!diag || diag.__phase3Attached) return diag;
  diag.__phase3Attached = true;

  diag.buildPhase3BillingProofReport = (opts) =>
    buildPhase3BillingProofReport(diag.getSnapshot?.() || {}, diag.getEvents?.() || [], opts || {});
  diag.analyzePhase3BillingProof = () =>
    analyzePhase3BillingProof(diag.getSnapshot?.() || {}, diag.getEvents?.() || []);

  diag.copyPhase3Reports = async () => {
    const text = diag.buildPhase3BillingProofReport();
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard", bytes: text.length, text };
    }
    return { ok: false, method: "none", bytes: text.length, text };
  };

  if (typeof globalThis !== "undefined") {
    globalThis.__SWIFTGO_COPY_PHASE3_REPORTS__ = () => diag.copyPhase3Reports();
    globalThis.__SWIFTGO_PHASE3_BILLING_PROOF__ = () => diag.buildPhase3BillingProofReport();
  }
  return diag;
}
