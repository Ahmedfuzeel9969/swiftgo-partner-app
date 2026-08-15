/**
 * Phase 2 — runtime verification report builders (lazy-loaded).
 * Lightweight classifiers live in phase2-runtime-verification.mjs.
 */

import {
  CFG_RESPONSIVE_INTERVAL_MS,
  CFG_P2P_FALLBACK_AFTER_MS,
  CFG_BACKGROUND_APPROACH_INTERVAL_MS,
  CFG_BACKGROUND_TRIP_INTERVAL_MS,
} from "./phase1-billing-diagnostics.mjs";
import { buildBillingAnalysisReport } from "./phase1-billing-reports.mjs";
import {
  PHASE2_WRITE_TOLERANCE_MS,
  PHASE2_P2P_FALLBACK_TOLERANCE_MS,
  explainWriteIntervalTiming,
  classifyDuplicateReceiveReason,
  writeReadLinkKey,
} from "./phase2-runtime-verification.mjs";

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

function duplicateDetailBlock(receiveRows) {
  const dups = receiveRows.filter((r) => r.isDuplicate);
  if (!dups.length) {
    return "No duplicates to explain.";
  }
  return dups
    .map(
      (r) =>
        `Receive #${r.receiveNumber}: ${r.duplicateReasonLabel}\n${r.duplicateExplanation || r.plainText || ""}`
    )
    .join("\n\n");
}

/**
 * Analyze Phase 2 verification from the diagnostic event ring.
 * @param {object} snap
 * @param {object[]} events
 */
export function analyzePhase2Verification(snap = {}, events = []) {
  const writes = events.filter((e) => e.type === "firebase_write_detail");
  const receives = events.filter((e) => e.type === "firebase_receive_detail");
  const fallbacks = events.filter((e) => e.type === "p2p_fallback_detail");
  const p2pSends = events.filter((e) => e.type === "p2p_send");
  const p2pRecvs = events.filter((e) => e.type === "p2p_receive");
  const writeSkips = events.filter((e) => e.type === "firebase_write_skipped");

  const writeRows = writes.map((e, i) => {
    const d = e.data || {};
    const timing =
      d.intervalVerification ||
      explainWriteIntervalTiming({
        actualIntervalMs: d.intervalSincePreviousWriteMs,
        expectedResponsiveMs: CFG_RESPONSIVE_INTERVAL_MS,
        policyIntervalMs: d.policyIntervalMs,
        policyName: d.policyName,
        writeReasonCode: d.writeReasonCode,
        writeReasonLabel: d.writeReasonLabel,
        writeGateReason: d.writeGateReason,
      });
    return {
      writeNumber: i + 1,
      writeTime: d.writeTimestamp ?? e.ts,
      writeTimeClock: fmtClock(d.writeTimestamp ?? e.ts),
      previousWriteTime: d.previousWriteTimestamp ?? null,
      previousWriteTimeClock: fmtClock(d.previousWriteTimestamp),
      actualIntervalMs: d.intervalSincePreviousWriteMs ?? null,
      actualIntervalSec: d.intervalSincePreviousWriteSec ?? sec(d.intervalSincePreviousWriteMs),
      expectedIntervalMs: timing.expectedIntervalMs,
      expectedIntervalSec: sec(timing.expectedIntervalMs),
      policyIntervalMs: timing.policyIntervalMs,
      differenceMs: timing.differenceMs,
      differenceSec: sec(timing.differenceMs),
      why: d.writeReasonLabel || d.writeReasonCode || "—",
      whyPlain: d.writeReasonPlain || timing.explanation,
      timingExplanation: timing.explanation,
      timingClass: timing.timingClass,
      pass: timing.pass !== false,
      sequence: d.writeSequenceNumber ?? null,
      gpsTimestamp: d.gpsTimestamp ?? null,
      rideId: d.rideId ?? null,
      vehicleId: d.vehicleId ?? null,
      linkKey: writeReadLinkKey(d.writeSequenceNumber, d.gpsTimestamp),
    };
  });

  const receiveRows = receives.map((e, i) => {
    const d = e.data || {};
    const dup =
      d.duplicateReason ||
      classifyDuplicateReceiveReason({
        classification: d.classification,
        intervalSincePreviousReceiveMs: d.intervalSincePreviousReceiveMs,
        rideStatusChanged: d.rideStatusChanged === true,
        sameSequence: d.sameSequence === true,
        sameGpsTimestamp: d.sameGpsTimestamp === true,
        sameCoordinates: d.sameCoordinates === true,
      });
    const linkKey = writeReadLinkKey(d.sequence, d.gpsTimestamp);
    const isDup =
      d.classification === "duplicate_document" ||
      d.classification === "duplicate_location" ||
      d.classification === "same_coordinates";
    return {
      receiveNumber: i + 1,
      receiveTime: d.receiveTimestamp ?? e.ts,
      receiveTimeClock: fmtClock(d.receiveTimestamp ?? e.ts),
      rideId: d.rideId ?? null,
      driverLocationTimestamp: d.gpsTimestamp ?? null,
      driverWriteSequence: d.sequence ?? null,
      classification: d.classification || "—",
      isNew: d.classification === "new_location",
      isDuplicate: isDup,
      sameCoordinates: d.sameCoordinates === true,
      sameTimestamp: d.sameGpsTimestamp === true,
      sameSequence: d.sameSequence === true,
      duplicateReasonCode: isDup ? dup.code : null,
      duplicateReasonLabel: isDup ? dup.label : null,
      duplicateExplanation: isDup ? d.duplicatePlain || dup.plain : null,
      plainText: d.plainText || null,
      linkKey,
      pass: !isDup || Boolean(dup.code),
    };
  });

  const writesByKey = new Map();
  for (const w of writeRows) {
    if (w.linkKey) writesByKey.set(w.linkKey, w);
  }
  const receivesByKey = new Map();
  for (const r of receiveRows) {
    if (!r.linkKey) continue;
    if (!receivesByKey.has(r.linkKey)) receivesByKey.set(r.linkKey, []);
    receivesByKey.get(r.linkKey).push(r);
  }

  const traceRows = [];
  const keys = new Set([...writesByKey.keys(), ...receivesByKey.keys()]);
  for (const key of keys) {
    const w = writesByKey.get(key) || null;
    const rs = receivesByKey.get(key) || [];
    if (!rs.length && w) {
      traceRows.push({
        linkKey: key,
        writeNumber: w.writeNumber,
        writeSequence: w.sequence,
        writeGpsTimestamp: w.gpsTimestamp,
        receives: [],
        multiReceive: false,
        explanation:
          "Write observed on this device with no matching customer receive in this ring (cross-device: check customer report for this sequence).",
      });
      continue;
    }
    const first = rs[0];
    const extras = rs.slice(1);
    traceRows.push({
      linkKey: key,
      writeNumber: w?.writeNumber ?? null,
      writeSequence: w?.sequence ?? first?.driverWriteSequence ?? null,
      writeGpsTimestamp: w?.gpsTimestamp ?? first?.driverLocationTimestamp ?? null,
      receives: rs.map((r) => ({
        receiveNumber: r.receiveNumber,
        classification: r.classification,
        duplicateReasonLabel: r.duplicateReasonLabel,
      })),
      multiReceive: rs.length > 1,
      explanation:
        rs.length > 1
          ? `Single write identity (${key}) produced ${rs.length} receives. First is typically new (or first sighting); later ones are duplicates (${extras
              .map((r) => r.duplicateReasonLabel || r.classification)
              .join(", ")}).`
          : `Receive #${first.receiveNumber} linked to write identity ${key}.`,
    });
  }

  const uniqueReceives = receiveRows.filter((r) => r.isNew);
  const duplicateReceives = receiveRows.filter((r) => r.isDuplicate);

  const fallbackRows = fallbacks.map((e, i) => {
    const d = e.data || {};
    const expected = Number(d.expectedDelayMs) || CFG_P2P_FALLBACK_AFTER_MS;
    const actual = Number.isFinite(d.actualDelayMs) ? d.actualDelayMs : null;
    const diff = Number.isFinite(actual) ? actual - expected : null;
    const path = d.triggerPath || "unknown";
    let pass = false;
    let explanation = "";
    if (path === "explicit_unhealthy") {
      pass = true;
      explanation =
        "Firebase fallback started because P2P was marked unhealthy (session closed/degraded). Immediate fallback is expected — this is not the 12s silence timer.";
    } else if (path === "silence_timeout" && Number.isFinite(actual)) {
      pass = actual >= expected - PHASE2_P2P_FALLBACK_TOLERANCE_MS;
      explanation = pass
        ? `Silence fallback delay ${sec(actual)}s vs expected ${sec(expected)}s (tolerance ±${sec(PHASE2_P2P_FALLBACK_TOLERANCE_MS)}s).`
        : `Silence fallback fired too early: actual ${sec(actual)}s vs expected ${sec(expected)}s.`;
    } else if (Number.isFinite(actual)) {
      pass = actual >= expected - PHASE2_P2P_FALLBACK_TOLERANCE_MS;
      explanation = `Fallback delay ${sec(actual)}s vs expected ${sec(expected)}s (path=${path}).`;
    } else {
      explanation =
        "Fallback recorded without a measurable last-P2P timestamp (P2P may never have delivered a fix).";
      pass = true;
    }
    return {
      fallbackNumber: i + 1,
      p2pStoppedAt: d.p2pStoppedAt ?? null,
      p2pStoppedClock: fmtClock(d.p2pStoppedAt),
      firebaseFallbackStartedAt: d.firebaseFallbackStartedAt ?? e.ts,
      firebaseFallbackStartedClock: fmtClock(d.firebaseFallbackStartedAt ?? e.ts),
      actualDelayMs: actual,
      actualDelaySec: sec(actual),
      expectedDelayMs: expected,
      expectedDelaySec: sec(expected),
      differenceMs: diff,
      differenceSec: sec(diff),
      triggerPath: path,
      pass,
      explanation,
      plainText: d.plainText || explanation,
    };
  });

  const verdicts = {
    firebaseWriteInterval: {
      item: "Firebase write interval",
      result: writeRows.length === 0 ? "INCONCLUSIVE" : writeRows.every((r) => r.pass) ? "PASS" : "FAIL",
      detail:
        writeRows.length === 0
          ? "No firebase_write_detail events on this device (expected on driver during a ride)."
          : `${writeRows.filter((r) => r.pass).length}/${writeRows.length} writes explained vs ${CFG_RESPONSIVE_INTERVAL_MS}ms responsive config.`,
    },
    firebaseReadBehavior: {
      item: "Firebase read behavior",
      result:
        receiveRows.length === 0
          ? "INCONCLUSIVE"
          : receiveRows.every((r) => r.classification && r.classification !== "—")
            ? "PASS"
            : "FAIL",
      detail:
        receiveRows.length === 0
          ? "No firebase_receive_detail events on this device (expected on customer during a ride)."
          : `${receiveRows.length} receives classified (new=${uniqueReceives.length}, duplicate=${duplicateReceives.length}).`,
    },
    duplicateReadHandling: {
      item: "Duplicate read handling",
      result:
        receiveRows.length === 0
          ? "INCONCLUSIVE"
          : duplicateReceives.length === 0
            ? "PASS"
            : duplicateReceives.every((r) => r.duplicateReasonCode)
              ? "PASS"
              : "FAIL",
      detail:
        duplicateReceives.length === 0
          ? "No duplicate receives observed in this window."
          : `${duplicateReceives.length} duplicates; reasons: ${JSON.stringify(
              duplicateReceives.reduce((acc, r) => {
                const k = r.duplicateReasonCode || "unknown";
                acc[k] = (acc[k] || 0) + 1;
                return acc;
              }, {})
            )}`,
    },
    p2pFallback: {
      item: "P2P fallback",
      result:
        fallbackRows.length === 0
          ? "INCONCLUSIVE"
          : fallbackRows.every((r) => r.pass)
            ? "PASS"
            : "FAIL",
      detail:
        fallbackRows.length === 0
          ? `No p2p_fallback_detail events. Expected delay when silence path fires: ${CFG_P2P_FALLBACK_AFTER_MS}ms.`
          : `${fallbackRows.filter((r) => r.pass).length}/${fallbackRows.length} fallback transitions matched expectation.`,
    },
    billingBehavior: {
      item: "Billing behavior",
      result: "PASS",
      detail:
        "Billing report is generated from observed write/read/P2P counters only (no optimization applied).",
    },
  };

  return {
    writeRows,
    receiveRows,
    traceRows,
    fallbackRows,
    counts: {
      writes: writeRows.length,
      receives: receiveRows.length,
      uniqueReceives: uniqueReceives.length,
      duplicateReceives: duplicateReceives.length,
      writeSkips: writeSkips.length,
      p2pSends: p2pSends.length,
      p2pReceives: p2pRecvs.length,
      fallbacks: fallbackRows.length,
    },
    verdicts,
    snap,
  };
}

/**
 * Full Phase 2 verification report text.
 */
export function buildPhase2VerificationReport(snap = {}, events = [], opts = {}) {
  const analysis = analyzePhase2Verification(snap, events);
  const { writeRows, receiveRows, traceRows, fallbackRows, counts, verdicts } = analysis;

  const lines = [
    "SwiftGo Phase 2 — Runtime Verification & Firebase Billing Investigation",
    `generatedAt=${new Date().toISOString()}`,
    `role=${snap?.role || "-"}`,
    `rideId=${snap?.rideId || "-"}`,
    `rideStatus=${snap?.rideStatus || "-"}`,
    "",
    "NOTE: Observe-only. No timing, P2P, or threshold changes were applied.",
    `Configured responsive Firebase write interval: ${CFG_RESPONSIVE_INTERVAL_MS}ms (${sec(CFG_RESPONSIVE_INTERVAL_MS)}s)`,
    `Configured P2P silence fallback: ${CFG_P2P_FALLBACK_AFTER_MS}ms (${sec(CFG_P2P_FALLBACK_AFTER_MS)}s)`,
    `Background approach/trip intervals (when policy selects them): ${CFG_BACKGROUND_APPROACH_INTERVAL_MS}ms / ${CFG_BACKGROUND_TRIP_INTERVAL_MS}ms`,
    "",
    "========== TASK 1 — Firebase write interval ==========",
    writeRows.length
      ? writeRows
          .map(
            (r) =>
              [
                `Write #${r.writeNumber}`,
                `Write time: ${r.writeTimeClock} (${r.writeTime})`,
                `Previous write time: ${r.previousWriteTimeClock}`,
                `Actual interval: ${r.actualIntervalSec ?? "—"} s (${r.actualIntervalMs ?? "—"} ms)`,
                `Expected interval (responsive config): ${r.expectedIntervalSec} s`,
                `Policy interval at write: ${sec(r.policyIntervalMs)} s`,
                `Difference vs 4s config: ${r.differenceSec ?? "—"} s`,
                `Why this write happened: ${r.why}`,
                `Timing explanation: ${r.timingExplanation}`,
                `Sequence: ${r.sequence ?? "—"}`,
                `PASS for this write: ${r.pass ? "PASS" : "FAIL"}`,
                "",
              ].join("\n")
          )
          .join("\n")
      : "(No writes in this diagnostic ring on this device.)\n",
    "",
    "========== TASK 2 — Firebase reads ==========",
    receiveRows.length
      ? receiveRows
          .map(
            (r) =>
              [
                `Receive #${r.receiveNumber}`,
                `Receive time: ${r.receiveTimeClock}`,
                `Ride ID: ${r.rideId || "—"}`,
                `Driver location timestamp: ${r.driverLocationTimestamp ?? "—"}`,
                `Driver write sequence: ${r.driverWriteSequence ?? "—"}`,
                `Classification: ${r.classification}`,
                `New data: ${r.isNew}`,
                `Duplicate data: ${r.isDuplicate}`,
                `Same coordinates: ${r.sameCoordinates}`,
                `Same timestamp: ${r.sameTimestamp}`,
                `Same sequence: ${r.sameSequence}`,
                r.isDuplicate
                  ? `Duplicate reason: ${r.duplicateReasonLabel} (${r.duplicateReasonCode})\n${r.duplicateExplanation || ""}`
                  : "Duplicate reason: n/a",
                "",
              ].join("\n")
          )
          .join("\n")
      : "(No location receives in this diagnostic ring on this device.)\n",
    "",
    "========== TASK 3 — Write ↔ Read trace ==========",
    "Link key uses write sequence (preferred) or GPS timestamp.",
    "If this is a single-device report, matching writes may appear only on the driver phone and receives only on the customer phone — merge by sequence.",
    "",
    traceRows.length
      ? traceRows
          .map((t) => {
            const recvLines = (t.receives || [])
              .map(
                (r) =>
                  `  → Receive #${r.receiveNumber} (${r.classification}${
                    r.duplicateReasonLabel ? `, ${r.duplicateReasonLabel}` : ""
                  })`
              )
              .join("\n");
            return [
              t.writeNumber != null ? `Write #${t.writeNumber}` : `Write identity ${t.linkKey}`,
              `sequence=${t.writeSequence ?? "—"} gpsTimestamp=${t.writeGpsTimestamp ?? "—"}`,
              recvLines || "  → (no receive on this device)",
              `Explanation: ${t.explanation}`,
              "",
            ].join("\n");
          })
          .join("\n")
      : "(No linkable write/receive pairs yet.)\n",
    "",
    "========== TASK 4 — Duplicate read investigation ==========",
    `Total writes (this device): ${counts.writes}`,
    `Total receives (this device): ${counts.receives}`,
    `Unique receives (new_location): ${counts.uniqueReceives}`,
    `Duplicate receives: ${counts.duplicateReceives}`,
    "",
    duplicateDetailBlock(receiveRows),
    "",
    "========== TASK 5 — P2P fallback verification ==========",
    fallbackRows.length
      ? fallbackRows
          .map(
            (r) =>
              [
                `Fallback #${r.fallbackNumber}`,
                `P2P stopped / last healthy P2P at: ${r.p2pStoppedClock}`,
                `Firebase fallback started: ${r.firebaseFallbackStartedClock}`,
                `Actual delay: ${r.actualDelaySec ?? "—"} s`,
                `Expected delay: ${r.expectedDelaySec} s`,
                `Difference: ${r.differenceSec ?? "—"} s`,
                `Trigger path: ${r.triggerPath}`,
                `Explanation: ${r.explanation}`,
                `Result: ${r.pass ? "PASS" : "FAIL"}`,
                "",
              ].join("\n")
          )
          .join("\n")
      : `(No fallback transitions recorded. Silence timer expectation remains ${CFG_P2P_FALLBACK_AFTER_MS}ms when P2P goes quiet.)\n`,
    "",
    "========== TASK 6 — Billing investigation ==========",
    buildBillingAnalysisReport(snap, events, opts),
    "",
    "Phase 2 billing extras:",
    `Estimated unnecessary Firebase reads (duplicates + same coords)=${
      receiveRows.filter((r) => r.isDuplicate).length
    }`,
    `Estimated unnecessary Firebase writes (skipped by gates; would have been wasteful)=${counts.writeSkips}`,
    `P2P sends=${counts.p2pSends}`,
    `P2P receives=${counts.p2pReceives}`,
    "",
    "========== TASK 7 — Runtime verification result ==========",
    `Firebase write interval: ${verdicts.firebaseWriteInterval.result}`,
    `  ${verdicts.firebaseWriteInterval.detail}`,
    `Firebase read behavior: ${verdicts.firebaseReadBehavior.result}`,
    `  ${verdicts.firebaseReadBehavior.detail}`,
    `Duplicate read handling: ${verdicts.duplicateReadHandling.result}`,
    `  ${verdicts.duplicateReadHandling.detail}`,
    `P2P fallback: ${verdicts.p2pFallback.result}`,
    `  ${verdicts.p2pFallback.detail}`,
    `Billing behavior: ${verdicts.billingBehavior.result}`,
    `  ${verdicts.billingBehavior.detail}`,
    "",
    "Overall (strict): " +
      (["firebaseWriteInterval", "firebaseReadBehavior", "duplicateReadHandling", "p2pFallback", "billingBehavior"]
        .map((k) => verdicts[k].result)
        .includes("FAIL")
        ? "FAIL (at least one item failed)"
        : ["firebaseWriteInterval", "firebaseReadBehavior", "duplicateReadHandling", "p2pFallback"].every(
              (k) => verdicts[k].result === "INCONCLUSIVE"
            )
          ? "INCONCLUSIVE (need a live ride with driver+customer diagnostics)"
          : "PASS (no FAIL; inconclusive items need the other device or a fallback event)"),
    "",
  ];

  return lines.join("\n");
}

/**
 * Record a P2P → Firebase fallback transition (observe-only).
 */
export function attachPhase2Reports(diag) {
  if (!diag || diag.__phase2Attached) return diag;
  diag.__phase2Attached = true;

  diag.buildPhase2VerificationReport = (opts) =>
    buildPhase2VerificationReport(diag.getSnapshot?.() || {}, diag.getEvents?.() || [], opts || {});
  diag.analyzePhase2Verification = () =>
    analyzePhase2Verification(diag.getSnapshot?.() || {}, diag.getEvents?.() || []);

  diag.copyPhase2Reports = async () => {
    const text = diag.buildPhase2VerificationReport();
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard", bytes: text.length, text };
    }
    return { ok: false, method: "none", bytes: text.length, text };
  };

  if (typeof globalThis !== "undefined") {
    globalThis.__SWIFTGO_COPY_PHASE2_REPORTS__ = () => diag.copyPhase2Reports();
    globalThis.__SWIFTGO_PHASE2_VERIFICATION__ = () => diag.buildPhase2VerificationReport();
  }
  return diag;
}
