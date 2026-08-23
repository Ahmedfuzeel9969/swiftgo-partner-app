/**
 * Field-test diagnostics ring — GPS / publish / receive / Firebase / P2P / routing / errors.
 * Built for two-phone motorcycle tests without DevTools.
 * Coordinates are included intentionally for field reports (tester-controlled copy).
 *
 * Phase 1/2/3 report builders are loaded on demand via ensureFieldDiagnosticReports()
 * so Home/booking startup does not pull the report subgraph.
 */

const MAX_EVENTS_DEFAULT = 800;
const MAX_ERRORS_DEFAULT = 40;

/** @type {ReturnType<typeof createFieldDiagnostics>|null} */
let singleton = null;

/** @type {Promise<ReturnType<typeof createFieldDiagnostics>>|null} */
let reportsLoadPromise = null;

function roundCoord(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 1e5) / 1e5;
}

function safeStr(v, max = 240) {
  try {
    return String(v ?? "").slice(0, max);
  } catch {
    return "";
  }
}

/**
 * @param {{
 *   role?: "customer"|"driver"|"unknown",
 *   maxEvents?: number,
 *   maxErrors?: number,
 *   nowMs?: () => number,
 * }} [opts]
 */
export function createFieldDiagnostics(opts = {}) {
  const nowMs = typeof opts.nowMs === "function" ? opts.nowMs : () => Date.now();
  const maxEvents = Math.max(50, Number(opts.maxEvents) || MAX_EVENTS_DEFAULT);
  const maxErrors = Math.max(10, Number(opts.maxErrors) || MAX_ERRORS_DEFAULT);

  /** @type {object[]} */
  const events = [];
  /** @type {object[]} */
  const errors = [];

  const state = {
    role: opts.role || "unknown",
    startedAt: nowMs(),
    rideEndedAt: null,
    rideId: "",
    rideStatus: "",
    firebase: {
      configured: null,
      authUidPresent: false,
      lastSnapshotAt: null,
      lastWriteAt: null,
      lastError: "",
    },
    p2p: {
      state: "unknown",
      lastDiag: "",
      lastSendAt: null,
      lastRecvAt: null,
      healthy: null,
    },
    gps: {
      lastAt: null,
      lastLat: null,
      lastLng: null,
      lastAccuracyM: null,
      lastHeadingDeg: null,
      lastSpeedMps: null,
      intervalMs: null,
      errorCode: "",
      fixesAccepted: 0,
      fixesRejected: 0,
    },
    receive: {
      lastAt: null,
      lastSource: "",
      lastLat: null,
      lastLng: null,
      lastObservedAt: null,
      intervalMs: null,
      p2pCount: 0,
      firebaseCount: 0,
    },
    publish: {
      lastAt: null,
      lastChannel: "",
      intervalMs: null,
      firebaseCount: 0,
      p2pCount: 0,
    },
    freshness: {
      lastAgeMs: null,
      lastClass: "",
      lastUiMessage: "",
    },
    routing: {
      lastDiag: null,
      lastAt: null,
    },
    counters: {
      events: 0,
      errors: 0,
    },
  };

  function pushRing(arr, item, max) {
    arr.push(item);
    while (arr.length > max) arr.shift();
  }

  function noteInterval(prevAt, nextAt) {
    if (!Number.isFinite(prevAt) || !Number.isFinite(nextAt) || nextAt < prevAt) return null;
    return nextAt - prevAt;
  }

  /**
   * @param {string} type
   * @param {object} [data]
   * @param {{ level?: "info"|"warn"|"error" }} [meta]
   */
  function record(type, data = {}, meta = {}) {
    const ts = nowMs();
    const level = meta.level || (type.includes("error") || type.endsWith("_error") ? "error" : "info");
    const entry = {
      ts,
      iso: new Date(ts).toISOString(),
      type: safeStr(type, 64),
      level,
      data: data && typeof data === "object" ? { ...data } : { value: data },
    };
    // Normalize coords if present
    if (entry.data.lat != null) entry.data.lat = roundCoord(entry.data.lat);
    if (entry.data.lng != null) entry.data.lng = roundCoord(entry.data.lng);

    pushRing(events, entry, maxEvents);
    state.counters.events += 1;

    if (level === "error") {
      pushRing(errors, entry, maxErrors);
      state.counters.errors += 1;
    }

    applySideEffects(entry);
    return entry;
  }

  function applySideEffects(entry) {
    const t = entry.type;
    const d = entry.data || {};

    if (t === "ride_meta") {
      if (d.rideId != null) state.rideId = safeStr(d.rideId, 80);
      if (d.status != null) state.rideStatus = safeStr(d.status, 40);
    }

    if (t === "gps_fix" || t === "gps_update") {
      const prev = state.gps.lastAt;
      state.gps.intervalMs = noteInterval(prev, entry.ts);
      state.gps.lastAt = entry.ts;
      if (d.lat != null) state.gps.lastLat = d.lat;
      if (d.lng != null) state.gps.lastLng = d.lng;
      if (d.accuracyM != null) state.gps.lastAccuracyM = d.accuracyM;
      if (d.headingDeg != null) state.gps.lastHeadingDeg = d.headingDeg;
      if (d.speedMps != null) state.gps.lastSpeedMps = d.speedMps;
      if (d.accepted === false) state.gps.fixesRejected += 1;
      else state.gps.fixesAccepted += 1;
      if (d.errorCode) state.gps.errorCode = safeStr(d.errorCode, 64);
    }

    if (t === "gps_error") {
      state.gps.errorCode = safeStr(d.code || d.errorCode || d.message, 64);
      state.gps.lastAt = entry.ts;
    }

    if (t === "publish_firebase" || t === "publish_p2p" || t === "publish_success" || t === "firebase_write_detail") {
      const prev = state.publish.lastAt;
      state.publish.intervalMs = noteInterval(prev, entry.ts);
      state.publish.lastAt = entry.ts;
      state.publish.lastChannel =
        t === "publish_p2p" || d.channel === "p2p" ? "p2p" : "firebase";
      // p2pCount owned by p2p_send (avoid double-count with publish_p2p)
      if (t === "publish_firebase" || t === "firebase_write_detail") state.publish.firebaseCount += 1;
      // publish_success: timing only (paired with firebase_write_detail — avoid double-count)
      if (d.lat != null || d.latitude != null) {
        state.gps.lastLat = d.lat ?? d.latitude;
        state.gps.lastLng = d.lng ?? d.longitude;
      }
      if (t !== "publish_p2p") state.firebase.lastWriteAt = entry.ts;
    }

    if (t === "p2p_send") {
      state.publish.p2pCount += 1;
      state.p2p.lastSendAt = entry.ts;
      state.publish.lastChannel = "p2p";
    }

    if (t === "p2p_receive") {
      state.receive.p2pCount += 1;
      state.p2p.lastRecvAt = entry.ts;
      state.receive.lastSource = "p2p";
      state.receive.lastAt = entry.ts;
      if (d.lat != null) state.receive.lastLat = d.lat;
      if (d.lng != null) state.receive.lastLng = d.lng;
      if (d.observedAt != null) state.receive.lastObservedAt = d.observedAt;
    }

    if (t === "firebase_receive_detail") {
      const prev = state.receive.lastAt;
      state.receive.intervalMs = noteInterval(prev, entry.ts);
      state.receive.lastAt = entry.ts;
      state.receive.lastSource = "firebase";
      state.receive.firebaseCount += 1;
      if (d.lat != null) state.receive.lastLat = d.lat;
      if (d.lng != null) state.receive.lastLng = d.lng;
      if (d.gpsTimestamp != null) state.receive.lastObservedAt = d.gpsTimestamp;
      state.firebase.lastSnapshotAt = entry.ts;
    }

    if (t === "receive_p2p" || t === "receive_firebase" || t === "receive_render") {
      // Legacy receive_* events: update last coords/source only.
      // Counters are owned by firebase_receive_detail / p2p_receive to avoid double-count.
      const prev = state.receive.lastAt;
      state.receive.intervalMs = noteInterval(prev, entry.ts);
      state.receive.lastAt = entry.ts;
      state.receive.lastSource = safeStr(d.source || (t.includes("p2p") ? "p2p" : "firebase"), 24);
      if (d.lat != null) state.receive.lastLat = d.lat;
      if (d.lng != null) state.receive.lastLng = d.lng;
      if (d.observedAt != null) state.receive.lastObservedAt = d.observedAt;
      if (t === "receive_p2p") state.p2p.lastRecvAt = entry.ts;
    }

    if (t === "firebase_status" || t === "firebase_snapshot" || t === "firebase_write" || t === "firebase_error") {
      if (d.configured != null) state.firebase.configured = Boolean(d.configured);
      if (d.authUidPresent != null) state.firebase.authUidPresent = Boolean(d.authUidPresent);
      if (t === "firebase_snapshot") state.firebase.lastSnapshotAt = entry.ts;
      if (t === "firebase_write") state.firebase.lastWriteAt = entry.ts;
      if (t === "firebase_error" || d.error) {
        state.firebase.lastError = safeStr(d.error || d.message || d.code, 160);
      }
    }

    if (t === "p2p_status" || t === "p2p_diag") {
      if (d.state != null) state.p2p.state = safeStr(d.state, 40);
      if (d.healthy != null) state.p2p.healthy = Boolean(d.healthy);
      state.p2p.lastDiag = safeStr(d.reason || d.code || d.state || t, 80);
      if (d.send) state.p2p.lastSendAt = entry.ts;
    }

    if (t === "freshness") {
      if (d.ageMs != null) state.freshness.lastAgeMs = d.ageMs;
      if (d.class != null) state.freshness.lastClass = safeStr(d.class, 24);
      if (d.uiMessage != null) state.freshness.lastUiMessage = safeStr(d.uiMessage, 120);
    }

    if (t === "route_diag" || t === "routing") {
      state.routing.lastAt = entry.ts;
      state.routing.lastDiag = {
        reason: safeStr(d.reason || d.code, 80),
        detail: d.detail && typeof d.detail === "object" ? d.detail : d,
      };
    }
  }

  function setMeta(patch = {}) {
    if (patch.role) state.role = safeStr(patch.role, 24);
    if (patch.rideId != null) state.rideId = safeStr(patch.rideId, 80);
    if (patch.rideStatus != null) state.rideStatus = safeStr(patch.rideStatus, 40);
    if (patch.rideEndedAt != null && Number.isFinite(Number(patch.rideEndedAt))) {
      state.rideEndedAt = Number(patch.rideEndedAt);
    }
    if (patch.firebase && typeof patch.firebase === "object") {
      Object.assign(state.firebase, patch.firebase);
    }
    if (patch.p2p && typeof patch.p2p === "object") {
      Object.assign(state.p2p, patch.p2p);
    }
  }

  function getSnapshot() {
    return {
      role: state.role,
      startedAt: state.startedAt,
      rideEndedAt: state.rideEndedAt || null,
      reportedAt: nowMs(),
      rideId: state.rideId,
      rideStatus: state.rideStatus,
      firebase: { ...state.firebase },
      p2p: { ...state.p2p },
      gps: { ...state.gps },
      receive: { ...state.receive },
      publish: { ...state.publish },
      freshness: { ...state.freshness },
      routing: state.routing.lastDiag
        ? { lastAt: state.routing.lastAt, lastDiag: state.routing.lastDiag }
        : { lastAt: state.routing.lastAt, lastDiag: null },
      counters: { ...state.counters },
      recentEvents: events.slice(-80),
      recentErrors: errors.slice(-maxErrors),
    };
  }

  function buildReport() {
    const snap = getSnapshot();
    return [
      "SwiftGo Field Diagnostic Report",
      `generatedAt=${new Date(snap.reportedAt).toISOString()}`,
      `role=${snap.role}`,
      `rideId=${snap.rideId || "-"}`,
      `rideStatus=${snap.rideStatus || "-"}`,
      "",
      "=== Summary ===",
      JSON.stringify(
        {
          firebase: snap.firebase,
          p2p: snap.p2p,
          gps: snap.gps,
          publish: snap.publish,
          receive: snap.receive,
          freshness: snap.freshness,
          routing: snap.routing,
          counters: snap.counters,
        },
        null,
        2
      ),
      "",
      "=== Recent errors ===",
      JSON.stringify(snap.recentErrors, null, 2),
      "",
      "=== Recent events (last 80) ===",
      JSON.stringify(snap.recentEvents, null, 2),
      "",
    ].join("\n");
  }

  async function copyReport() {
    const text = buildReport();
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard", bytes: text.length };
    }
    // Fallback: select a temporary textarea
    if (typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.("copy");
      document.body.removeChild(ta);
      if (ok) return { ok: true, method: "execCommand", bytes: text.length };
    }
    return { ok: false, method: "none", text, bytes: text.length };
  }

  function clear() {
    events.length = 0;
    errors.length = 0;
    state.counters.events = 0;
    state.counters.errors = 0;
    record("diag_cleared", {});
  }

  return {
    record,
    setMeta,
    getSnapshot,
    buildReport,
    copyReport,
    clear,
    getEvents: () => events.slice(),
    getErrors: () => errors.slice(),
  };
}

/**
 * Install (or reuse) the process-wide field diagnostics singleton.
 * Does not load Phase 1/2/3 report builders — call ensureFieldDiagnosticReports() for those.
 * @param {{ role?: string }} [opts]
 */
export function installFieldDiagnostics(opts = {}) {
  if (!singleton) {
    singleton = createFieldDiagnostics(opts);
  } else if (opts.role) {
    singleton.setMeta({ role: opts.role });
  }
  if (typeof globalThis !== "undefined") {
    globalThis.__SWIFTGO_FIELD_DIAG__ = singleton;
    globalThis.__SWIFTGO_COPY_FIELD_DIAG__ = () => singleton.copyReport();
  }
  return singleton;
}

export function getFieldDiagnostics() {
  return singleton || installFieldDiagnostics();
}

/**
 * Idempotently dynamic-import Phase 1/2/3 report modules and attach them once.
 * Safe across Diagnostics reopen, auth restore, and customer/driver init.
 * @param {{ role?: string }} [opts]
 * @returns {Promise<ReturnType<typeof createFieldDiagnostics>>}
 */
export async function ensureFieldDiagnosticReports(opts = {}) {
  const diag = installFieldDiagnostics(opts);
  if (diag.__phase1Attached && diag.__phase2Attached && diag.__phase3Attached) {
    return diag;
  }
  if (!reportsLoadPromise) {
    reportsLoadPromise = (async () => {
      const [{ attachPhase1Reports }, { attachPhase2Reports }, { attachPhase3Reports }] =
        await Promise.all([
          import("./phase1-billing-reports.mjs"),
          import("./phase2-runtime-reports.mjs"),
          import("./phase3-billing-reports.mjs"),
        ]);
      attachPhase1Reports(diag);
      attachPhase2Reports(diag);
      attachPhase3Reports(diag);
      return diag;
    })().catch((err) => {
      reportsLoadPromise = null;
      throw err;
    });
  }
  return reportsLoadPromise;
}
