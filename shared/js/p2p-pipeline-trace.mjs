/**
 * P2P pipeline diagnostic recorder (Offer→ICE→DC→Healthy).
 * Evidence only — no behavior changes. Never stores SDP bodies, IPs, or auth tokens.
 */

export const P2P_PIPELINE_RING_MAX = 240;

export const P2P_PIPELINE_STAGES = Object.freeze([
  "offer_created",
  "offer_uploaded",
  "offer_downloaded",
  "answer_created",
  "answer_uploaded",
  "answer_downloaded",
  "driver_answer_applied",
  "customer_remote_offer_applied",
  "ice_candidate_generated",
  "ice_candidates_uploaded_bundled",
  "ice_candidates_received_bundled",
  "ice_candidates_applied_bundled",
  "ice_gathering_state",
  "ice_connection_state",
  "peer_connection_state",
  "signaling_state",
  "datachannel_created",
  "datachannel_open",
  "first_packet_out",
  "first_packet_in",
  "healthy",
]);

/** Stages this side is expected to emit (for Q8 inference). */
const ROLE_EXPECTED = Object.freeze({
  driver: [
    "offer_created",
    "offer_uploaded",
    "answer_downloaded",
    "driver_answer_applied",
    "ice_candidate_generated",
    "ice_candidates_uploaded_bundled",
    "ice_candidates_received_bundled",
    "ice_candidates_applied_bundled",
    "datachannel_created",
    "datachannel_open",
    "first_packet_out",
    "first_packet_in",
    "healthy",
  ],
  customer: [
    "offer_downloaded",
    "customer_remote_offer_applied",
    "answer_created",
    "answer_uploaded",
    "ice_candidate_generated",
    "ice_candidates_uploaded_bundled",
    "ice_candidates_received_bundled",
    "ice_candidates_applied_bundled",
    "datachannel_created",
    "datachannel_open",
    "first_packet_out",
    "first_packet_in",
    "healthy",
  ],
});

export function countSdpCandidates(sdp) {
  const lines = String(sdp || "").split(/\r?\n/);
  let host = 0;
  let srflx = 0;
  let relay = 0;
  let other = 0;
  const protocols = { udp: 0, tcp: 0, other: 0 };
  for (const line of lines) {
    if (!line.startsWith("a=candidate:")) continue;
    if (/\btyp host\b/.test(line)) host += 1;
    else if (/\btyp srflx\b/.test(line)) srflx += 1;
    else if (/\btyp relay\b/.test(line)) relay += 1;
    else other += 1;
    if (/\budp\b/i.test(line)) protocols.udp += 1;
    else if (/\btcp\b/i.test(line)) protocols.tcp += 1;
    else protocols.other += 1;
  }
  return {
    host,
    srflx,
    relay,
    other,
    total: host + srflx + relay + other,
    protocols,
  };
}

/** Privacy-safe ICE candidate summary (no address / foundation / ufrag). */
export function summarizeIceCandidate(cand) {
  if (!cand) return null;
  const proto = String(cand.protocol || "").toLowerCase() || null;
  const typ = String(cand.type || cand.candidateType || "").toLowerCase() || null;
  let fromLine = null;
  const line = String(cand.candidate || "");
  if (line) {
    const m = line.match(/\btyp\s+(\w+)/i);
    fromLine = m ? m[1].toLowerCase() : null;
  }
  return {
    type: typ || fromLine || "unknown",
    protocol: proto || (/\budp\b/i.test(line) ? "udp" : /\btcp\b/i.test(line) ? "tcp" : null),
  };
}

export function pcSnapshot(pc, channel) {
  if (!pc) {
    return {
      connectionState: "none",
      iceConnectionState: "none",
      iceGatheringState: "none",
      signalingState: "none",
      dcReadyState: channel ? String(channel.readyState || "") : "none",
    };
  }
  return {
    connectionState: String(pc.connectionState || ""),
    iceConnectionState: String(pc.iceConnectionState || ""),
    iceGatheringState: String(pc.iceGatheringState || ""),
    signalingState: String(pc.signalingState || ""),
    dcReadyState: channel ? String(channel.readyState || "") : "none",
  };
}

/**
 * Extract selected pair + local/remote candidate types from RTCStats (no IPs).
 */
export async function readSelectedPairSummary(pc) {
  if (!pc || typeof pc.getStats !== "function") return null;
  try {
    const stats = await pc.getStats();
    /** @type {Map<string, object>} */
    const byId = new Map();
    stats.forEach((r) => {
      if (r && r.id) byId.set(r.id, r);
    });
    let selected = null;
    stats.forEach((r) => {
      if (!r || r.type !== "candidate-pair") return;
      const isSel = r.selected === true || r.nominated === true;
      if (!isSel && selected) return;
      if (isSel || (!selected && String(r.state || "") === "succeeded")) {
        selected = r;
      }
    });
    if (!selected) return { found: false };
    const local = byId.get(selected.localCandidateId) || null;
    const remote = byId.get(selected.remoteCandidateId) || null;
    return {
      found: true,
      pairState: String(selected.state || ""),
      nominated: Boolean(selected.nominated),
      writable: selected.writable == null ? null : Boolean(selected.writable),
      local: local
        ? {
            candidateType: String(local.candidateType || ""),
            protocol: String(local.protocol || ""),
            relayProtocol: local.relayProtocol ? String(local.relayProtocol) : null,
          }
        : null,
      remote: remote
        ? {
            candidateType: String(remote.candidateType || ""),
            protocol: String(remote.protocol || ""),
          }
        : null,
    };
  } catch {
    return { found: false, error: "getStats_failed" };
  }
}

function emptyCandCounters() {
  return {
    generated: 0,
    uploaded: 0,
    received: 0,
    applied: 0,
    byType: { host: 0, srflx: 0, relay: 0, other: 0 },
    protocols: { udp: 0, tcp: 0, other: 0 },
  };
}

/**
 * @param {{
 *   role: "driver"|"customer",
 *   nowMs?: () => number,
 *   getPc?: () => RTCPeerConnection|null,
 *   getChannel?: () => RTCDataChannel|null,
 *   getIceMeta?: () => object,
 * }} opts
 */
export function createPipelineRecorder(opts) {
  const role = opts.role === "customer" ? "customer" : "driver";
  const nowMs = opts.nowMs || (() => Date.now());
  /** @type {object[]} */
  const events = [];
  const cand = emptyCandCounters();
  let iceMode = "bundled_sdp_non_trickle";
  let iceMeta = { hasStun: null, hasTurn: null, iceServerCount: null };
  let lastSelectedPair = null;
  let rideId = "";

  function syncWindow() {
    try {
      const g = typeof globalThis !== "undefined" ? globalThis : null;
      if (!g) return;
      g.__SWIFTGO_P2P_PIPELINE__ = events.slice();
      g.__SWIFTGO_P2P_PIPELINE_REPORT__ = buildReport();
    } catch {
      /* ignore */
    }
  }

  function snapshot() {
    const pc = typeof opts.getPc === "function" ? opts.getPc() : null;
    const ch = typeof opts.getChannel === "function" ? opts.getChannel() : null;
    const extra = typeof opts.getIceMeta === "function" ? opts.getIceMeta() || {} : {};
    return {
      ...pcSnapshot(pc, ch),
      ice: { ...iceMeta, ...extra, mode: iceMode },
      candidateCounts: { ...cand, byType: { ...cand.byType }, protocols: { ...cand.protocols } },
      selectedCandidatePair: lastSelectedPair,
      rideId: rideId || null,
    };
  }

  function record(stage, detail = {}) {
    const entry = {
      t: nowMs(),
      side: role,
      stage: String(stage || ""),
      ...snapshot(),
      ...detail,
    };
    events.push(entry);
    if (events.length > P2P_PIPELINE_RING_MAX) events.shift();
    syncWindow();
    return entry;
  }

  function setRideId(id) {
    rideId = String(id || "").trim();
  }

  function setIceMeta(meta = {}) {
    iceMeta = {
      hasStun: meta.hasStun == null ? iceMeta.hasStun : Boolean(meta.hasStun),
      hasTurn: meta.hasTurn == null ? iceMeta.hasTurn : Boolean(meta.hasTurn),
      iceServerCount:
        meta.iceServerCount == null ? iceMeta.iceServerCount : Number(meta.iceServerCount) || 0,
    };
  }

  function noteCandidateGenerated(candLike) {
    const sum = summarizeIceCandidate(candLike);
    cand.generated += 1;
    const typ = sum?.type || "other";
    if (typ === "host" || typ === "srflx" || typ === "relay") cand.byType[typ] += 1;
    else cand.byType.other += 1;
    const proto = sum?.protocol || "other";
    if (proto === "udp" || proto === "tcp") cand.protocols[proto] += 1;
    else cand.protocols.other += 1;
    record("ice_candidate_generated", {
      candidate: sum,
      transportProtocol: sum?.protocol || null,
    });
  }

  function noteCandidatesUploadedBundled(sdp) {
    const counts = countSdpCandidates(sdp);
    cand.uploaded += counts.total;
    record("ice_candidates_uploaded_bundled", {
      sdpCandidateCounts: counts,
      transportProtocol: counts.protocols,
      note: "non_trickle_bundled_in_sdp",
    });
  }

  function noteCandidatesReceivedAppliedBundled(sdp, kind = "remote") {
    const counts = countSdpCandidates(sdp);
    cand.received += counts.total;
    cand.applied += counts.total;
    record("ice_candidates_received_bundled", {
      kind,
      sdpCandidateCounts: counts,
      transportProtocol: counts.protocols,
      note: "applied_via_setRemoteDescription",
    });
    record("ice_candidates_applied_bundled", {
      kind,
      sdpCandidateCounts: counts,
      note: "bundled_with_remote_description",
    });
  }

  function noteTrickleApplied() {
    cand.received += 1;
    cand.applied += 1;
    iceMode = "mixed_or_trickle";
    record("ice_candidate_trickle_applied", {});
  }

  async function captureSelectedPair(label = "") {
    const pc = typeof opts.getPc === "function" ? opts.getPc() : null;
    const summary = await readSelectedPairSummary(pc);
    lastSelectedPair = summary;
    record("selected_candidate_pair", {
      label: String(label || ""),
      pair: summary,
    });
    return summary;
  }

  function hasStage(name) {
    return events.some((e) => e.stage === name);
  }

  function iceEverConnected() {
    return events.some((e) => {
      if (e.stage !== "ice_connection_state" && e.stage !== "peer_connection_state") return false;
      const ice = String(e.iceConnectionState || "");
      const conn = String(e.connectionState || "");
      return ice === "connected" || ice === "completed" || conn === "connected";
    });
  }

  function firstFailedStage() {
    const expected = ROLE_EXPECTED[role] || ROLE_EXPECTED.driver;
    let lastSeen = null;
    for (const stage of expected) {
      if (hasStage(stage)) {
        lastSeen = stage;
        continue;
      }
      // Only declare failure once a prior expected stage succeeded (or signaling started).
      if (lastSeen != null || events.length > 0) {
        return {
          stage,
          after: lastSeen,
          note: "first_expected_stage_missing_on_this_device",
        };
      }
    }
    if (hasStage("fallback") || hasStage("ice_connection_state")) {
      const iceFail = [...events].reverse().find((e) => {
        return (
          (e.stage === "ice_connection_state" && e.iceConnectionState === "failed") ||
          (e.stage === "peer_connection_state" && e.connectionState === "failed") ||
          e.stage === "fallback"
        );
      });
      if (iceFail) {
        return {
          stage: iceFail.stage === "fallback" ? "fallback" : iceFail.stage,
          after: lastSeen,
          reason: iceFail.reason || iceFail.iceConnectionState || iceFail.connectionState || null,
          note: "terminal_failure_event",
        };
      }
    }
    return {
      stage: lastSeen ? "none_incomplete_trace" : "no_pipeline_events",
      after: lastSeen,
      note: "insufficient_evidence_on_this_device",
    };
  }

  function yn(cond, unknown = false) {
    if (unknown) return "UNKNOWN";
    return cond ? "YES" : "NO";
  }

  function buildReport() {
    const failed = firstFailedStage();
    const q1 =
      role === "driver"
        ? {
            value: yn(hasStage("driver_answer_applied")),
            evidence: hasStage("driver_answer_applied")
              ? "driver_answer_applied"
              : hasStage("answer_downloaded")
                ? "answer_downloaded_but_not_applied"
                : "answer_not_downloaded_on_this_device",
          }
        : {
            value: "UNKNOWN",
            evidence: "customer_cannot_observe_driver_setRemoteDescription",
          };

    const localCands = cand.generated > 0 || cand.uploaded > 0;
    const remoteCands = cand.received > 0;
    const q2 = {
      value: yn(localCands && remoteCands),
      evidence: {
        generated: cand.generated,
        uploaded: cand.uploaded,
        received: cand.received,
        applied: cand.applied,
        mode: iceMode,
      },
    };

    const q3 = { value: yn(iceEverConnected()), evidence: "ice_or_connection_state_events" };
    const q4 = {
      value: yn(hasStage("datachannel_created")),
      evidence: "datachannel_created",
    };
    const q5 = { value: yn(hasStage("datachannel_open")), evidence: "datachannel_open" };
    const q6 = { value: yn(hasStage("first_packet_out")), evidence: "first_packet_out" };
    const q7 = { value: yn(hasStage("first_packet_in")), evidence: "first_packet_in" };
    const q8 = {
      value: failed.stage,
      after: failed.after || null,
      reason: failed.reason || null,
      note: failed.note || null,
    };

    return {
      generatedAt: nowMs(),
      side: role,
      rideId: rideId || null,
      iceMode,
      ice: { ...iceMeta },
      candidateCounts: { ...cand, byType: { ...cand.byType }, protocols: { ...cand.protocols } },
      selectedCandidatePair: lastSelectedPair,
      eventCount: events.length,
      answers: { Q1: q1, Q2: q2, Q3: q3, Q4: q4, Q5: q5, Q6: q6, Q7: q7, Q8: q8 },
      captureHint:
        "copy(JSON.stringify({report: window.__SWIFTGO_P2P_PIPELINE_REPORT__, events: window.__SWIFTGO_P2P_PIPELINE__}, null, 2))",
    };
  }

  function reset() {
    events.length = 0;
    Object.assign(cand, emptyCandCounters());
    cand.byType = { host: 0, srflx: 0, relay: 0, other: 0 };
    cand.protocols = { udp: 0, tcp: 0, other: 0 };
    lastSelectedPair = null;
    syncWindow();
  }

  function getEvents() {
    return events.slice();
  }

  // Seed empty report for field consoles.
  syncWindow();

  return {
    record,
    setRideId,
    setIceMeta,
    noteCandidateGenerated,
    noteCandidatesUploadedBundled,
    noteCandidatesReceivedAppliedBundled,
    noteTrickleApplied,
    captureSelectedPair,
    buildReport,
    getEvents,
    reset,
    hasStage,
  };
}
