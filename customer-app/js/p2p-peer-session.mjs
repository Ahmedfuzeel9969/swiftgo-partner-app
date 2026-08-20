/**
 * Phase 3 — injectable WebRTC peer session (driver or customer role).
 * Uses bundled non-trickle ICE: wait for gathering complete before publishing SDP.
 * Reliability: default STUN, heartbeat, scheduleReconnect + ICE restart on failure.
 */

import {
  P2P_BACKPRESSURE_FLUSH_MS,
  P2P_BUFFERED_AMOUNT_HIGH,
  P2P_CHANNEL_OPEN_TIMEOUT_MS,
  P2P_DATA_CHANNEL_LABEL,
  P2P_DIAG,
  P2P_DEGRADED_AFTER_MS,
  P2P_FALLBACK_AFTER_MS,
  P2P_FIRST_ACK_TIMEOUT_MS,
  P2P_HEARTBEAT_INTERVAL_MS,
  P2P_MAX_SENT_SEQUENCES_RETAINED,
  P2P_MAX_SDP_CHARS,
  P2P_RECONNECT_MAX_ATTEMPTS,
  P2P_SEND_FAILURE_RETRY_MS,
  P2P_SEND_INTERVAL_MS,
  P2P_STATE,
  createPeerSessionId,
  isValidPeerSessionId,
  nextReconnectDelayMs,
  resolveIceConfiguration,
} from "./p2p-protocol.mjs";
import {
  buildP2pAckMessage,
  buildP2pHbMessage,
  buildP2pLocationMessage,
  validateP2pMessage,
} from "./p2p-location-envelope.mjs";
import { createPipelineRecorder, countSdpCandidates } from "./p2p-pipeline-trace.mjs";

/**
 * @param {{
 *   role: "driver"|"customer",
 *   RTCPeerConnection?: typeof RTCPeerConnection,
 *   iceConfig?: object,
 *   onState?: (state: string) => void,
 *   onDiag?: (code: string) => void,
 *   onLocalDescription?: (kind: "offer"|"answer", sdp: string, meta: object) => void|Promise<void>,
 *   onLocationFix?: (fix: object) => void,
 *   onAck?: (msg: object) => void,
 *   onNeedReconnect?: () => void,
 *   onChannelOpen?: () => void,
 *   isCurrentGeneration?: (gen: number) => boolean,
 *   nowMs?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} deps
 */
export function createP2pPeerSession(deps) {
  const role = deps.role === "customer" ? "customer" : "driver";
  const Peer =
    deps.RTCPeerConnection ||
    (typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : null);
  const nowMs = deps.nowMs || (() => Date.now());
  const setT = deps.setTimeoutFn || setTimeout;
  const clearT = deps.clearTimeoutFn || clearTimeout;
  const diag = deps.onDiag || (() => {});
  const onState = deps.onState || (() => {});

  let state = P2P_STATE.DISABLED;
  let generation = 0;
  let pc = null;
  let channel = null;
  let peerSessionId = "";
  let trackingSessionId = "";
  let assignmentVersion = 0;
  let lastSequenceSent = 0;
  let lastSequenceRecv = 0;
  let lastValidFixAt = null;
  let lastAckAt = null;
  let lastHbAt = null;
  let lastAckSequence = 0;
  let lastOutboundAt = null;
  let healthTimer = 0;
  let heartbeatTimer = 0;
  let reconnectTimer = 0;
  let channelOpenTimer = 0;
  let firstAckTimer = 0;
  let backpressureFlushTimer = 0;
  let cadenceFlushTimer = 0;
  let reconnectAttempt = 0;
  let pendingLoc = null;
  let pendingLocGen = 0;
  let sendTimer = 0;
  let closed = false;
  let firstValidEmitted = false;
  let iceRestartAttempted = false;
  let channelEverOpened = false;
  /** @type {Set<number>} */
  const sentSequences = new Set();
  let sessionMeta = null;
  let resumeFn = null;
  let suppressingCloseReconnect = false;
  /** @type {MediaStream | null} */
  let callLocalStream = null;
  /** @type {((stream: MediaStream, track?: MediaStreamTrack) => void) | null} */
  let remoteTrackHandler = null;

  const counters = {
    sessionsStarted: 0,
    offers: 0,
    answers: 0,
    channelsOpened: 0,
    channelsClosed: 0,
    validMessages: 0,
    invalidMessages: 0,
    fixesSent: 0,
    fixesReceived: 0,
    acks: 0,
    heartbeatsSent: 0,
    heartbeatsReceived: 0,
    fallbackTransitions: 0,
    reconnectAttempts: 0,
    iceRestarts: 0,
    backpressureCoalesces: 0,
    sendFailures: 0,
    pendingCoalesces: 0,
    acknowledgementsReceived: 0,
  };

  let firstPacketOut = false;
  let firstPacketIn = false;
  let lastFallbackReason = "";
  let lastSignalingState = "";

  const pipe = createPipelineRecorder({
    role,
    nowMs,
    getPc: () => pc,
    getChannel: () => channel,
  });

  function pushPipeline(stage, detail = {}, diagCode = "") {
    pipe.record(stage, detail);
    if (diagCode) diag(diagCode);
  }

  function setState(next, fallbackReason = "") {
    if (state === next) return;
    state = next;
    onState(next);
    if (next === P2P_STATE.P2P_HEALTHY) {
      pushPipeline("healthy", {}, P2P_DIAG.HEALTHY);
    }
    if (next === P2P_STATE.P2P_DEGRADED) diag(P2P_DIAG.DEGRADED);
    if (next === P2P_STATE.FIREBASE_FALLBACK) {
      counters.fallbackTransitions += 1;
      lastFallbackReason = String(fallbackReason || lastFallbackReason || "unspecified");
      pushPipeline(
        "fallback",
        { reason: lastFallbackReason, failureReason: lastFallbackReason },
        P2P_DIAG.PIPELINE_FALLBACK_REASON
      );
      diag(P2P_DIAG.FIREBASE_FALLBACK);
      void pipe.captureSelectedPair("fallback");
    }
    if (next === P2P_STATE.CLOSED) diag(P2P_DIAG.SESSION_CLOSED);
  }

  function isCurrent(gen = generation) {
    return !closed && (typeof deps.isCurrentGeneration !== "function" || deps.isCurrentGeneration(gen));
  }

  function clearTimers() {
    if (healthTimer) {
      clearT(healthTimer);
      healthTimer = 0;
    }
    if (heartbeatTimer) {
      clearT(heartbeatTimer);
      heartbeatTimer = 0;
    }
    if (reconnectTimer) {
      clearT(reconnectTimer);
      reconnectTimer = 0;
    }
    if (sendTimer) {
      clearT(sendTimer);
      sendTimer = 0;
    }
    if (channelOpenTimer) {
      clearT(channelOpenTimer);
      channelOpenTimer = 0;
    }
    if (firstAckTimer) {
      clearT(firstAckTimer);
      firstAckTimer = 0;
    }
    if (backpressureFlushTimer) {
      clearT(backpressureFlushTimer);
      backpressureFlushTimer = 0;
    }
    if (cadenceFlushTimer) {
      clearT(cadenceFlushTimer);
      cadenceFlushTimer = 0;
    }
  }

  function clearPendingDeliveryState() {
    pendingLoc = null;
    pendingLocGen = 0;
    sentSequences.clear();
    lastAckSequence = 0;
  }

  function validateDriverAck(msg) {
    const seq = Math.floor(Number(msg?.seq) || 0);
    if (seq < 1) return { ok: false, reason: "invalid_sequence" };
    if (seq > lastSequenceSent) return { ok: false, reason: "future_sequence" };
    if (!sentSequences.has(seq)) return { ok: false, reason: "unsent_sequence" };
    if (seq <= lastAckSequence) return { ok: false, reason: "duplicate_ack" };
    return { ok: true, seq };
  }

  function pruneSentSequences() {
    while (sentSequences.size > P2P_MAX_SENT_SEQUENCES_RETAINED) {
      const oldest = Math.min(...sentSequences);
      sentSequences.delete(oldest);
    }
  }

  function trackSentSequence(seq) {
    sentSequences.add(seq);
    pruneSentSequences();
  }

  function releaseSentSequence(seq) {
    sentSequences.delete(seq);
  }

  function isTransportAliveNow() {
    if (channel?.readyState !== "open") return false;
    const vals = [lastAckAt, lastHbAt, lastValidFixAt, lastOutboundAt]
      .filter((v) => v != null && Number.isFinite(Number(v)))
      .map((v) => Number(v));
    if (!vals.length) return false;
    return nowMs() - Math.max(...vals) <= P2P_FALLBACK_AFTER_MS;
  }

  function isLocDeliveryHealthyNow() {
    if (assignmentVersion < 1) return false;
    if (role === "customer") {
      const fixAge = lastValidFixAt != null ? nowMs() - lastValidFixAt : Infinity;
      return fixAge <= P2P_DEGRADED_AFTER_MS;
    }
    const ackAge = lastAckAt != null ? nowMs() - lastAckAt : Infinity;
    return (
      channel?.readyState === "open" &&
      lastSequenceSent > 0 &&
      lastValidFixAt != null &&
      ackAge <= P2P_DEGRADED_AFTER_MS
    );
  }

  function scheduleChannelOpenTimeout(gen) {
    clearT(channelOpenTimer);
    channelOpenTimer = setT(() => {
      channelOpenTimer = 0;
      if (!isCurrent(gen) || channelEverOpened) return;
      diag(P2P_DIAG.CHANNEL_OPEN_TIMEOUT);
      setState(P2P_STATE.FIREBASE_FALLBACK, "channel_open_timeout");
    }, P2P_CHANNEL_OPEN_TIMEOUT_MS);
  }

  function scheduleFirstAckTimeout(gen) {
    if (firstAckTimer || role !== "driver") return;
    firstAckTimer = setT(() => {
      firstAckTimer = 0;
      if (!isCurrent(gen) || lastAckSequence > 0) return;
      diag(P2P_DIAG.ACK_TIMEOUT);
      setState(P2P_STATE.FIREBASE_FALLBACK, "first_ack_timeout");
    }, P2P_FIRST_ACK_TIMEOUT_MS);
  }

  function scheduleBackpressureFlush(gen) {
    if (backpressureFlushTimer) return;
    backpressureFlushTimer = setT(() => {
      backpressureFlushTimer = 0;
      if (!isCurrent(gen)) return;
      flushPendingLoc(gen);
    }, P2P_BACKPRESSURE_FLUSH_MS);
  }

  function scheduleCadenceFlush(gen, delayMs) {
    if (cadenceFlushTimer) return;
    const delay = Math.max(1, Math.ceil(Number(delayMs) || 0));
    cadenceFlushTimer = setT(() => {
      cadenceFlushTimer = 0;
      if (!isCurrent(gen)) return;
      flushPendingLoc(gen);
    }, delay);
  }

  function scheduleSendFailureRetry(gen) {
    if (sendTimer) return;
    sendTimer = setT(() => {
      sendTimer = 0;
      if (!isCurrent(gen)) return;
      flushPendingLoc(gen);
    }, P2P_SEND_FAILURE_RETRY_MS);
  }

  function offerLocationFix(fix, gen) {
    if (!isCurrent(gen)) return false;
    if (pendingLoc != null && pendingLocGen === gen) {
      counters.pendingCoalesces += 1;
      diag(P2P_DIAG.PENDING_COALESCED);
    }
    pendingLoc = fix;
    pendingLocGen = gen;
    return true;
  }

  function tearDownPc() {
    suppressingCloseReconnect = true;
    try {
      callLocalStream?.getTracks?.().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    callLocalStream = null;
    try {
      channel?.close?.();
    } catch {
      /* ignore */
    }
    try {
      pc?.close?.();
    } catch {
      /* ignore */
    }
    channel = null;
    pc = null;
    suppressingCloseReconnect = false;
  }

  function authContext() {
    return {
      peerSessionId,
      trackingSessionId,
      assignmentVersion,
      lastSequence: lastSequenceRecv,
      expectRole: role === "customer" ? "driver" : "customer",
      nowMs: nowMs(),
      closed,
    };
  }

  function lastPeerActivityAt() {
    // Treat null as absent; allow timestamp 0 (fake clocks / epoch) as real activity.
    const vals = [lastValidFixAt, lastAckAt, lastHbAt]
      .filter((v) => v != null && Number.isFinite(Number(v)))
      .map((v) => Number(v));
    return vals.length ? Math.max(...vals) : null;
  }

  function lastInboundProofAt() {
    const vals = [lastAckAt, lastHbAt]
      .filter((v) => v != null && Number.isFinite(Number(v)))
      .map((v) => Number(v));
    return vals.length ? Math.max(...vals) : null;
  }

  function evaluateHealth() {
    if (!isCurrent() || state === P2P_STATE.CLOSED || state === P2P_STATE.DISABLED) return;
    if (state === P2P_STATE.SIGNALING) return;
    if (state === P2P_STATE.RECONNECTING && channel?.readyState !== "open") return;
    const now = nowMs();
    if (role === "customer") {
      const fixAge = lastValidFixAt != null ? now - lastValidFixAt : Infinity;
      if (fixAge <= P2P_DEGRADED_AFTER_MS) {
        setState(P2P_STATE.P2P_HEALTHY);
      } else if (fixAge <= P2P_FALLBACK_AFTER_MS) {
        setState(P2P_STATE.P2P_DEGRADED);
      } else {
        setState(P2P_STATE.FIREBASE_FALLBACK, "customer_activity_timeout");
      }
      return;
    }
    const ackAge = lastAckAt != null ? now - lastAckAt : Infinity;
    const sentLoc = lastSequenceSent > 0 && lastValidFixAt != null;
    if (channel?.readyState === "open" && sentLoc && ackAge <= P2P_DEGRADED_AFTER_MS) {
      setState(P2P_STATE.P2P_HEALTHY);
    } else if (channel?.readyState === "open" && isTransportAliveNow()) {
      setState(P2P_STATE.P2P_DEGRADED);
    } else if (channel?.readyState === "open") {
      setState(P2P_STATE.P2P_DEGRADED);
    } else {
      setState(P2P_STATE.FIREBASE_FALLBACK, "driver_channel_down");
      requestReconnect("channel_down");
    }
  }

  function scheduleHealthPoll(gen) {
    clearT(healthTimer);
    healthTimer = setT(() => {
      healthTimer = 0;
      if (!isCurrent(gen)) return;
      evaluateHealth();
      scheduleHealthPoll(gen);
    }, 2_000);
  }

  function scheduleHeartbeat(gen) {
    clearT(heartbeatTimer);
    heartbeatTimer = setT(() => {
      heartbeatTimer = 0;
      if (!isCurrent(gen)) return;
      maybeSendHeartbeat();
      scheduleHeartbeat(gen);
    }, P2P_HEARTBEAT_INTERVAL_MS);
  }

  function maybeSendHeartbeat() {
    if (!channel || channel.readyState !== "open") return;
    const now = nowMs();
    // Skip when recent LOC/ACK/HB already proved the channel (avoid unnecessary traffic).
    if (lastOutboundAt != null && now - lastOutboundAt < P2P_HEARTBEAT_INTERVAL_MS) return;
    const peerAt = lastPeerActivityAt();
    if (peerAt != null && now - peerAt < P2P_HEARTBEAT_INTERVAL_MS * 0.75) {
      return;
    }
    const built = buildP2pHbMessage({
      peerSessionId,
      trackingSessionId,
      assignmentVersion,
      sequence: lastSequenceSent,
      role,
    });
    if (!built.ok) return;
    if (trySend(built.serialized)) {
      counters.heartbeatsSent += 1;
      lastOutboundAt = now;
      diag(P2P_DIAG.HEARTBEAT_SENT);
    }
  }

  /** @type {Set<(raw: string) => void>} */
  let commHandlers = new Set();

  function peekCommType(raw) {
    if (typeof raw !== "string" || raw.length < 12 || !raw.includes('"comm_')) return "";
    try {
      const obj = JSON.parse(raw);
      const t = String(obj?.type || "");
      return t.startsWith("comm_") ? t : "";
    } catch {
      return "";
    }
  }

  function handleMessage(raw, gen) {
    if (!isCurrent(gen)) {
      diag(P2P_DIAG.STALE_GENERATION);
      return;
    }
    // Multiplex: forward communication envelopes without touching location validate path.
    if (peekCommType(raw)) {
      try {
        if (typeof window !== "undefined") {
          const ring = (window.__SWIFTGO_COMM_TRACE__ = window.__SWIFTGO_COMM_TRACE__ || []);
          ring.push({
            t: Date.now(),
            role,
            stage: "dc_in",
            type: peekCommType(raw),
            handlers: commHandlers.size,
            peerSessionId,
          });
          if (ring.length > 120) ring.splice(0, ring.length - 120);
        }
      } catch {
        /* ignore */
      }
      if (commHandlers.size === 0) {
        try {
          if (typeof window !== "undefined") {
            const ring = (window.__SWIFTGO_COMM_TRACE__ = window.__SWIFTGO_COMM_TRACE__ || []);
            ring.push({
              t: Date.now(),
              role,
              stage: "dc_in_dropped_no_handler",
              type: peekCommType(raw),
            });
          }
        } catch {
          /* ignore */
        }
      }
      for (const h of commHandlers) {
        try {
          h(raw);
        } catch {
          /* ignore handler errors */
        }
      }
      return;
    }
    const validated = validateP2pMessage(raw, authContext());
    if (!validated.ok) {
      counters.invalidMessages += 1;
      diag(P2P_DIAG.INVALID_MESSAGE);
      return;
    }

    if (validated.type === "ack" && role === "driver") {
      const ackCheck = validateDriverAck(validated.message);
      if (!ackCheck.ok) {
        counters.invalidMessages += 1;
        if (ackCheck.reason === "duplicate_ack") diag(P2P_DIAG.DUPLICATE_ACK_IGNORED);
        else diag(P2P_DIAG.STALE_ACK_IGNORED);
        return;
      }
    }

    counters.validMessages += 1;
    if (!firstPacketIn) {
      firstPacketIn = true;
      pushPipeline(
        "first_packet_in",
        { type: String(validated.type || "") },
        P2P_DIAG.PIPELINE_FIRST_PACKET_IN
      );
    }
    if (validated.type === "loc" && validated.fix) {
      lastSequenceRecv = validated.fix.sequence;
      lastValidFixAt = nowMs();
      counters.fixesReceived += 1;
      if (!firstValidEmitted) {
        firstValidEmitted = true;
        diag(P2P_DIAG.FIRST_VALID_FIX);
      }
      deps.onLocationFix?.(validated.fix);
      if (role === "customer") {
        const ack = buildP2pAckMessage({
          peerSessionId,
          trackingSessionId,
          assignmentVersion,
          sequence: validated.fix.sequence,
        });
        if (trySend(ack.serialized)) {
          lastOutboundAt = nowMs();
          counters.acks += 1;
        }
      }
      evaluateHealth();
    } else if (validated.type === "ack") {
      const seq = Math.floor(Number(validated.message?.seq) || 0);
      lastAckSequence = seq;
      lastAckAt = nowMs();
      if (role === "driver") releaseSentSequence(seq);
      counters.acks += 1;
      counters.acknowledgementsReceived += 1;
      clearT(firstAckTimer);
      firstAckTimer = 0;
      deps.onAck?.(validated.message);
      evaluateHealth();
    } else if (validated.type === "hb") {
      lastHbAt = nowMs();
      counters.heartbeatsReceived += 1;
      if (role === "customer") {
        const ack = buildP2pAckMessage({
          peerSessionId,
          trackingSessionId,
          assignmentVersion,
          sequence: Math.floor(Number(validated.message?.seq) || lastSequenceRecv || 0),
        });
        if (trySend(ack.serialized)) {
          lastOutboundAt = nowMs();
          counters.acks += 1;
        }
      }
      evaluateHealth();
    } else if (validated.type === "close") {
      void close({ reason: "remote_close" });
    }
  }

  function requestReconnect(reason = "") {
    void reason;
    if (closed || state === P2P_STATE.RECONNECTING || state === P2P_STATE.CLOSED) return;
    if (role !== "driver") {
      deps.onNeedReconnect?.();
      return;
    }
    if (typeof deps.onNeedReconnect === "function") {
      deps.onNeedReconnect();
      return;
    }
    if (typeof resumeFn === "function") {
      scheduleReconnect(resumeFn);
    }
  }

  function wireChannel(ch, gen) {
    channel = ch;
    ch.binaryType = "arraybuffer";
    pushPipeline(
      "datachannel_created",
      { readyState: String(ch.readyState || ""), label: String(ch.label || "") },
      P2P_DIAG.PIPELINE_DC_CREATED
    );
    ch.onopen = () => {
      if (!isCurrent(gen)) return;
      channelEverOpened = true;
      clearT(channelOpenTimer);
      channelOpenTimer = 0;
      counters.channelsOpened += 1;
      reconnectAttempt = 0;
      iceRestartAttempted = false;
      pushPipeline(
        "datachannel_open",
        { readyState: String(ch.readyState || "") },
        P2P_DIAG.PIPELINE_DC_STATE
      );
      diag(P2P_DIAG.CHANNEL_OPEN);
      void pipe.captureSelectedPair("dc_open");
      setState(P2P_STATE.CONNECTING);
      scheduleHealthPoll(gen);
      scheduleHeartbeat(gen);
      evaluateHealth();
      flushPendingLoc(gen);
      maybeSendHeartbeat();
      try {
        deps.onChannelOpen?.();
      } catch {
        /* ignore */
      }
    };
    ch.onclose = () => {
      counters.channelsClosed += 1;
      pushPipeline(
        "datachannel_close",
        { readyState: String(ch.readyState || ""), failureReason: "channel_close" },
        P2P_DIAG.PIPELINE_DC_STATE
      );
      if (!isCurrent(gen) || closed || suppressingCloseReconnect) return;
      setState(P2P_STATE.FIREBASE_FALLBACK, "channel_close");
      requestReconnect("channel_close");
    };
    ch.onerror = () => {
      pushPipeline(
        "datachannel_error",
        { readyState: String(ch.readyState || ""), failureReason: "channel_error" },
        P2P_DIAG.PIPELINE_DC_STATE
      );
      if (!isCurrent(gen) || closed) return;
      setState(P2P_STATE.FIREBASE_FALLBACK, "channel_error");
    };
    ch.onmessage = (ev) => {
      const data = ev?.data;
      if (typeof data === "string") {
        handleMessage(data, gen);
        return;
      }
      // Some Android WebViews deliver text frames as Blob/ArrayBuffer.
      if (data instanceof ArrayBuffer) {
        handleMessage(new TextDecoder().decode(data), gen);
        return;
      }
      if (data && typeof data.arrayBuffer === "function") {
        void data.arrayBuffer().then((buf) => {
          if (!isCurrent(gen)) return;
          handleMessage(new TextDecoder().decode(buf), gen);
        });
        return;
      }
      handleMessage(String(data || ""), gen);
    };
  }

  function trySend(serialized, { countBackpressure = true } = {}) {
    if (!channel || channel.readyState !== "open") return false;
    if (channel.bufferedAmount > P2P_BUFFERED_AMOUNT_HIGH) {
      if (countBackpressure) {
        counters.backpressureCoalesces += 1;
        diag(P2P_DIAG.BACKPRESSURE_COALESCED);
      }
      return false;
    }
    try {
      channel.send(serialized);
      if (!firstPacketOut) {
        firstPacketOut = true;
        pushPipeline(
          "first_packet_out",
          { bytes: String(serialized || "").length },
          P2P_DIAG.PIPELINE_FIRST_PACKET_OUT
        );
      }
      return true;
    } catch {
      counters.sendFailures += 1;
      return false;
    }
  }

  async function waitIceComplete(peer) {
    const before = String(peer.iceGatheringState || "");
    pushPipeline(
      "ice_gathering_state",
      { gatheringState: before },
      P2P_DIAG.PIPELINE_ICE_GATHERING
    );
    if (peer.iceGatheringState === "complete") {
      pushPipeline(
        "ice_gather_done",
        {
          gatheringState: "complete",
          timedOut: false,
          candidates: countSdpCandidates(peer.localDescription?.sdp || ""),
        },
        P2P_DIAG.PIPELINE_ICE_GATHER_DONE
      );
      return;
    }
    await new Promise((resolve) => {
      const done = () => {
        if (peer.iceGatheringState === "complete") {
          peer.removeEventListener("icegatheringstatechange", done);
          resolve({ timedOut: false });
        }
      };
      peer.addEventListener("icegatheringstatechange", done);
      setT(() => {
        peer.removeEventListener("icegatheringstatechange", done);
        resolve({ timedOut: true });
      }, 4_000);
    }).then((result) => {
      const timedOut = Boolean(result?.timedOut);
      const gatheringState = String(peer.iceGatheringState || "");
      const candidates = countSdpCandidates(peer.localDescription?.sdp || "");
      if (timedOut && gatheringState !== "complete") {
        pushPipeline(
          "ice_gather_timeout",
          {
            gatheringState,
            timedOut: true,
            candidates,
            failureReason: "ice_gather_timeout_4s",
          },
          P2P_DIAG.PIPELINE_ICE_GATHER_TIMEOUT
        );
      } else {
        pushPipeline(
          "ice_gather_done",
          { gatheringState, timedOut, candidates },
          P2P_DIAG.PIPELINE_ICE_GATHER_DONE
        );
      }
    });
  }

  function wirePcLifecycle(peer, gen) {
    const emitSignaling = () => {
      const sig = String(peer.signalingState || "");
      if (sig === lastSignalingState) return;
      lastSignalingState = sig;
      pushPipeline("signaling_state", { signalingState: sig }, P2P_DIAG.PIPELINE_CONNECTION_STATE);
    };
    peer.onsignalingstatechange = () => {
      if (!isCurrent(gen) || closed) return;
      emitSignaling();
    };
    peer.onconnectionstatechange = () => {
      if (!isCurrent(gen) || closed) return;
      const st = String(peer.connectionState || "");
      pushPipeline(
        "peer_connection_state",
        {
          connectionState: st,
          failureReason: st === "failed" ? "pc_connection_failed" : null,
        },
        P2P_DIAG.PIPELINE_CONNECTION_STATE
      );
      emitSignaling();
      if (st === "connected") void pipe.captureSelectedPair("pc_connected");
      if (st === "failed") {
        void pipe.captureSelectedPair("pc_failed");
        setState(P2P_STATE.FIREBASE_FALLBACK, "pc_connection_failed");
        requestReconnect("ice_failed");
      } else if (st === "disconnected") {
        void attemptIceRestart(gen);
      }
    };
    peer.oniceconnectionstatechange = () => {
      if (!isCurrent(gen) || closed) return;
      const st = String(peer.iceConnectionState || "");
      pushPipeline(
        "ice_connection_state",
        {
          iceConnectionState: st,
          failureReason: st === "failed" ? "ice_connection_failed" : null,
        },
        P2P_DIAG.PIPELINE_ICE_CONNECTION
      );
      emitSignaling();
      if (st === "connected" || st === "completed") {
        void pipe.captureSelectedPair("ice_" + st);
      }
      if (st === "failed") {
        void pipe.captureSelectedPair("ice_failed");
        setState(P2P_STATE.FIREBASE_FALLBACK, "ice_connection_failed");
        requestReconnect("ice_conn_failed");
      }
    };
    peer.onicegatheringstatechange = () => {
      if (!isCurrent(gen) || closed) return;
      pushPipeline(
        "ice_gathering_state",
        { gatheringState: String(peer.iceGatheringState || "") },
        P2P_DIAG.PIPELINE_ICE_GATHERING
      );
    };
  }

  async function attemptIceRestart(gen) {
    if (!isCurrent(gen) || closed || role !== "driver" || !pc) return false;
    if (iceRestartAttempted) {
      requestReconnect("ice_disconnected");
      return false;
    }
    iceRestartAttempted = true;
    counters.iceRestarts += 1;
    diag(P2P_DIAG.ICE_RESTART);
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await waitIceComplete(pc);
      if (!isCurrent(gen)) return false;
      const sdp = pc.localDescription?.sdp || "";
      if (!sdp || sdp.length > P2P_MAX_SDP_CHARS) {
        requestReconnect("ice_restart_sdp");
        return false;
      }
      await deps.onLocalDescription?.("offer", sdp, {
        peerSessionId,
        trackingSessionId,
        assignmentVersion,
        generation: gen,
        iceRestart: true,
      });
      return true;
    } catch {
      requestReconnect("ice_restart_error");
      return false;
    }
  }

  function createPc(gen) {
    if (!Peer) throw new Error("RTC_UNAVAILABLE");
    const ice = deps.iceConfig || resolveIceConfiguration();
    pipe.setIceMeta({
      hasStun: Boolean(ice.hasStun),
      hasTurn: Boolean(ice.hasTurn),
      iceServerCount: Array.isArray(ice.iceServers) ? ice.iceServers.length : 0,
    });
    pushPipeline(
      "ice_config",
      {
        hasStun: Boolean(ice.hasStun),
        hasTurn: Boolean(ice.hasTurn),
        iceServerCount: Array.isArray(ice.iceServers) ? ice.iceServers.length : 0,
      },
      P2P_DIAG.PIPELINE_ICE_CONFIG
    );
    const peer = new Peer({
      iceServers: ice.iceServers || [],
      iceCandidatePoolSize: ice.iceCandidatePoolSize || 0,
    });
    pc = peer;
    lastSignalingState = String(peer.signalingState || "");
    peer.onicecandidate = (ev) => {
      if (!isCurrent(gen) || closed) return;
      if (!ev?.candidate) {
        pushPipeline("ice_candidate_gathering_complete_null", {});
        return;
      }
      pipe.noteCandidateGenerated(ev.candidate);
    };
    peer.onicecandidateerror = (ev) => {
      /* privacy: do not log candidate addresses; record error code only */
      pushPipeline("ice_candidate_error", {
        failureReason: "ice_candidate_error",
        errorCode: ev?.errorCode ?? null,
        errorText: ev?.errorText ? String(ev.errorText).slice(0, 80) : null,
        urlHost: (() => {
          try {
            const u = String(ev?.url || "");
            if (!u) return null;
            return new URL(u).host || null;
          } catch {
            return null;
          }
        })(),
      });
    };
    peer.ontrack = (ev) => {
      const stream =
        ev.streams?.[0] ||
        (ev.track ? new MediaStream([ev.track]) : null);
      if (stream) remoteTrackHandler?.(stream, ev.track);
    };
    wirePcLifecycle(peer, gen);
    return peer;
  }

  function rememberSession(meta = {}) {
    const rawAv = Math.floor(Number(meta.assignmentVersion) || assignmentVersion || 0);
    sessionMeta = {
      trackingSessionId: String(meta.trackingSessionId || trackingSessionId || "").trim(),
      assignmentVersion: rawAv >= 1 ? rawAv : 0,
    };
    resumeFn = () =>
      startAsDriver({
        ...sessionMeta,
        reconnect: true,
      });
  }

  /** Adopt server-authoritative assignmentVersion after offer upload or signaling refresh. */
  function syncAssignmentVersion(nextAv) {
    if (closed) return false;
    const raw = Number(nextAv);
    if (!Number.isFinite(raw) || raw < 1) return false;
    const av = Math.floor(raw);
    assignmentVersion = av;
    if (sessionMeta) {
      sessionMeta = { ...sessionMeta, assignmentVersion: av };
    }
    if (pendingLoc && channel?.readyState === "open") {
      flushPendingLoc(generation);
    }
    return true;
  }

  /**
   * Driver: create offer session.
   */
  async function startAsDriver(meta = {}) {
    if (closed) return null;
    if (!Peer) {
      setState(P2P_STATE.FIREBASE_FALLBACK, "rtc_unavailable");
      return null;
    }
    const isReconnect = Boolean(meta.reconnect);
    generation += 1;
    const gen = generation;
    counters.sessionsStarted += 1;
    firstPacketOut = false;
    firstPacketIn = false;
    lastFallbackReason = "";
    lastSignalingState = "";
    pipe.reset();
    tearDownPc();
    clearTimers();
    clearPendingDeliveryState();
    channelEverOpened = false;
    peerSessionId = isValidPeerSessionId(meta.peerSessionId)
      ? meta.peerSessionId
      : createPeerSessionId();
    trackingSessionId = String(meta.trackingSessionId || "").trim();
    assignmentVersion = Math.max(0, Math.floor(Number(meta.assignmentVersion) || 0));
    lastSequenceSent = 0;
    lastSequenceRecv = 0;
    lastValidFixAt = null;
    lastAckAt = null;
    lastHbAt = null;
    lastOutboundAt = null;
    firstValidEmitted = false;
    iceRestartAttempted = false;
    if (!isReconnect) reconnectAttempt = 0;
    rememberSession(meta);
    setState(isReconnect ? P2P_STATE.RECONNECTING : P2P_STATE.SIGNALING);
    diag(P2P_DIAG.SIGNALING_STARTED);
    pushPipeline("offer_start", { reconnect: isReconnect });

    if (typeof deps.ensureIceConfiguration === "function") {
      try {
        await deps.ensureIceConfiguration();
      } catch {
        /* STUN-only fallback */
      }
    }

    const peer = createPc(gen);
    const ch = peer.createDataChannel(P2P_DATA_CHANNEL_LABEL, { ordered: true });
    wireChannel(ch, gen);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    pushPipeline(
      "offer_created",
      {
        type: "offer",
        sdpChars: String(peer.localDescription?.sdp || "").length,
        candidates: countSdpCandidates(peer.localDescription?.sdp || ""),
      },
      P2P_DIAG.PIPELINE_LOCAL_DESC
    );
    await waitIceComplete(peer);
    if (!isCurrent(gen)) return null;
    const sdp = peer.localDescription?.sdp || "";
    if (!sdp || sdp.length > P2P_MAX_SDP_CHARS) {
      setState(P2P_STATE.FIREBASE_FALLBACK, "offer_sdp_invalid");
      return null;
    }
    counters.offers += 1;
    diag(P2P_DIAG.OFFER_READY);
    pushPipeline("offer_ready", {
      sdpChars: sdp.length,
      candidates: countSdpCandidates(sdp),
    });
    await deps.onLocalDescription?.("offer", sdp, {
      peerSessionId,
      trackingSessionId,
      assignmentVersion,
      generation: gen,
      reconnect: isReconnect,
    });
    setState(P2P_STATE.CONNECTING);
    scheduleChannelOpenTimeout(gen);
    return { peerSessionId, generation: gen, sdp };
  }

  async function acceptRemoteAnswer(sdp, gen = generation) {
    if (!isCurrent(gen) || !pc) {
      pushPipeline(
        "driver_answer_apply_skipped",
        { reason: !pc ? "no_pc" : "stale_gen", failureReason: !pc ? "no_pc" : "stale_gen" },
        P2P_DIAG.PIPELINE_ANSWER_APPLIED
      );
      return false;
    }
    const text = String(sdp || "");
    if (!text || text.length > P2P_MAX_SDP_CHARS) {
      pushPipeline(
        "driver_answer_apply_skipped",
        { reason: "bad_sdp", sdpChars: text.length, failureReason: "bad_sdp" },
        P2P_DIAG.PIPELINE_ANSWER_APPLIED
      );
      return false;
    }
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: text });
      pipe.noteCandidatesReceivedAppliedBundled(text, "answer");
      pushPipeline(
        "driver_answer_applied",
        {
          sdpChars: text.length,
          candidates: countSdpCandidates(text),
        },
        P2P_DIAG.PIPELINE_ANSWER_APPLIED
      );
      diag(P2P_DIAG.PIPELINE_REMOTE_DESC);
      return true;
    } catch (err) {
      pushPipeline(
        "driver_answer_apply_error",
        {
          sdpChars: text.length,
          failureReason: err?.name ? String(err.name) : "apply_error",
        },
        P2P_DIAG.PIPELINE_ANSWER_APPLIED
      );
      return false;
    }
  }

  /**
   * Customer: apply remote offer and publish answer.
   */
  async function startAsCustomer(meta = {}) {
    if (closed) return null;
    if (!Peer) {
      setState(P2P_STATE.FIREBASE_FALLBACK, "rtc_unavailable");
      return null;
    }
    generation += 1;
    const gen = generation;
    counters.sessionsStarted += 1;
    firstPacketOut = false;
    firstPacketIn = false;
    lastFallbackReason = "";
    lastSignalingState = "";
    pipe.reset();
    tearDownPc();
    clearTimers();
    clearPendingDeliveryState();
    channelEverOpened = false;
    peerSessionId = String(meta.peerSessionId || "");
    trackingSessionId = String(meta.trackingSessionId || "").trim();
    assignmentVersion = Math.max(1, Math.floor(Number(meta.assignmentVersion) || 1));
    lastValidFixAt = null;
    lastAckAt = null;
    lastHbAt = null;
    lastOutboundAt = null;
    iceRestartAttempted = false;
    if (!isValidPeerSessionId(peerSessionId)) {
      setState(P2P_STATE.FIREBASE_FALLBACK, "bad_peer_session_id");
      return null;
    }
    setState(P2P_STATE.SIGNALING);
    diag(P2P_DIAG.SIGNALING_STARTED);
    pushPipeline("answer_start", {});

    if (typeof deps.ensureIceConfiguration === "function") {
      try {
        await deps.ensureIceConfiguration();
      } catch {
        /* STUN-only fallback */
      }
    }

    const peer = createPc(gen);
    peer.ondatachannel = (ev) => {
      pushPipeline(
        "datachannel_ondatachannel",
        {
          hasChannel: Boolean(ev.channel),
          readyState: String(ev.channel?.readyState || ""),
          label: String(ev.channel?.label || ""),
        },
        P2P_DIAG.PIPELINE_DC_CREATED
      );
      if (ev.channel) wireChannel(ev.channel, gen);
    };
    const offerSdp = String(meta.offerSdp || "");
    if (!offerSdp || offerSdp.length > P2P_MAX_SDP_CHARS) {
      setState(P2P_STATE.FIREBASE_FALLBACK, "offer_sdp_invalid");
      return null;
    }
    pushPipeline("offer_downloaded", {
      sdpChars: offerSdp.length,
      candidates: countSdpCandidates(offerSdp),
    });
    await peer.setRemoteDescription({ type: "offer", sdp: offerSdp });
    pipe.noteCandidatesReceivedAppliedBundled(offerSdp, "offer");
    pushPipeline(
      "customer_remote_offer_applied",
      {
        type: "offer",
        sdpChars: offerSdp.length,
        candidates: countSdpCandidates(offerSdp),
      },
      P2P_DIAG.PIPELINE_REMOTE_DESC
    );
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    pushPipeline(
      "answer_created",
      {
        type: "answer",
        sdpChars: String(peer.localDescription?.sdp || "").length,
        candidates: countSdpCandidates(peer.localDescription?.sdp || ""),
      },
      P2P_DIAG.PIPELINE_LOCAL_DESC
    );
    await waitIceComplete(peer);
    if (!isCurrent(gen)) return null;
    const sdp = peer.localDescription?.sdp || "";
    if (!sdp || sdp.length > P2P_MAX_SDP_CHARS) {
      setState(P2P_STATE.FIREBASE_FALLBACK, "answer_sdp_invalid");
      return null;
    }
    counters.answers += 1;
    diag(P2P_DIAG.ANSWER_READY);
    pushPipeline("answer_ready", {
      sdpChars: sdp.length,
      candidates: countSdpCandidates(sdp),
    });
    await deps.onLocalDescription?.("answer", sdp, {
      peerSessionId,
      trackingSessionId,
      assignmentVersion,
      generation: gen,
    });
    setState(P2P_STATE.CONNECTING);
    scheduleChannelOpenTimeout(gen);
    return { peerSessionId, generation: gen, sdp };
  }

  function enqueueLocationFix(fix) {
    if (closed || role !== "driver") return;
    if (state === P2P_STATE.CLOSED || state === P2P_STATE.DISABLED) return;
    const gen = generation;
    if (!channel || channel.readyState !== "open") {
      offerLocationFix(fix, gen);
      return;
    }
    if (channel.bufferedAmount > P2P_BUFFERED_AMOUNT_HIGH) {
      if (pendingLoc != null) {
        counters.backpressureCoalesces += 1;
        diag(P2P_DIAG.BACKPRESSURE_COALESCED);
      }
      offerLocationFix(fix, gen);
      scheduleBackpressureFlush(gen);
      return;
    }
    offerLocationFix(fix, gen);
    flushPendingLoc(gen);
  }

  function flushPendingLoc(gen = generation) {
    if (!pendingLoc || role !== "driver") return;
    if (assignmentVersion < 1) return;
    if (!isCurrent(gen)) {
      pendingLoc = null;
      pendingLocGen = 0;
      return;
    }
    if (pendingLocGen !== gen) {
      pendingLoc = null;
      pendingLocGen = 0;
      return;
    }
    if (channel?.readyState !== "open") return;
    if (channel.bufferedAmount > P2P_BUFFERED_AMOUNT_HIGH) {
      scheduleBackpressureFlush(gen);
      return;
    }

    const now = nowMs();
    const minGapMs = P2P_SEND_INTERVAL_MS * 0.5;
    if (lastValidFixAt != null && now - lastValidFixAt < minGapMs && lastSequenceSent > 0) {
      scheduleCadenceFlush(gen, minGapMs - (now - lastValidFixAt));
      return;
    }

    const nextSeq = lastSequenceSent + 1;
    if (sentSequences.has(nextSeq)) return;

    const built = buildP2pLocationMessage(pendingLoc, {
      peerSessionId,
      trackingSessionId,
      assignmentVersion,
      sequence: nextSeq,
      role: "driver",
    });
    if (!built.ok) {
      pendingLoc = null;
      pendingLocGen = 0;
      return;
    }

    const prevSequenceSent = lastSequenceSent;
    lastSequenceSent = nextSeq;
    trackSentSequence(nextSeq);
    if (trySend(built.serialized, { countBackpressure: false })) {
      if (cadenceFlushTimer) {
        clearT(cadenceFlushTimer);
        cadenceFlushTimer = 0;
      }
      counters.fixesSent += 1;
      lastValidFixAt = now;
      lastOutboundAt = now;
      pendingLoc = null;
      pendingLocGen = 0;
      if (counters.fixesSent === 1) {
        scheduleFirstAckTimeout(gen);
      }
    } else {
      lastSequenceSent = prevSequenceSent;
      releaseSentSequence(nextSeq);
      if (channel.bufferedAmount > P2P_BUFFERED_AMOUNT_HIGH) {
        scheduleBackpressureFlush(gen);
      } else {
        scheduleSendFailureRetry(gen);
      }
    }
  }

  function scheduleReconnect(startFn) {
    if (closed || reconnectAttempt >= P2P_RECONNECT_MAX_ATTEMPTS) {
      setState(P2P_STATE.FIREBASE_FALLBACK, "reconnect_exhausted");
      return;
    }
    if (reconnectTimer) return;
    const delay = nextReconnectDelayMs(reconnectAttempt);
    reconnectAttempt += 1;
    counters.reconnectAttempts += 1;
    setState(P2P_STATE.RECONNECTING);
    diag(P2P_DIAG.RECONNECT_SCHEDULED);
    const fn = typeof startFn === "function" ? startFn : resumeFn;
    reconnectTimer = setT(() => {
      reconnectTimer = 0;
      if (closed || typeof fn !== "function") return;
      void fn();
    }, delay);
  }

  async function close({ reason = "" } = {}) {
    void reason;
    closed = true;
    generation += 1;
    clearTimers();
    tearDownPc();
    clearPendingDeliveryState();
    resumeFn = null;
    setState(P2P_STATE.CLOSED);
  }

  function suspend() {
    // Hidden customer / no viewer: tear down PC for battery; keep ids for later resume.
    // Do not mark closed — controller may restart without full destroy.
    clearTimers();
    tearDownPc();
    clearPendingDeliveryState();
    setState(P2P_STATE.FIREBASE_FALLBACK, "suspend");
  }

  function getState() {
    return {
      state,
      generation,
      peerSessionId,
      trackingSessionId,
      assignmentVersion,
      lastValidFixAt,
      lastAckAt,
      lastHbAt,
      reconnectAttempt,
      counters: { ...counters },
      isHealthy: state === P2P_STATE.P2P_HEALTHY,
      isLocDeliveryHealthy: isLocDeliveryHealthyNow(),
      isTransportAlive: isTransportAliveNow(),
      lastFallbackReason,
      firstPacketOut,
      firstPacketIn,
      pipelineTail: pipe.getEvents().slice(-12),
      pipelineReport: pipe.buildReport(),
    };
  }

  function createCommTransport() {
    return {
      isReady: () => Boolean(channel && channel.readyState === "open"),
      send: (serialized) => {
        const text = String(serialized || "");
        const ok = trySend(text);
        try {
          if (typeof window !== "undefined" && text.includes('"comm_')) {
            const ring = (window.__SWIFTGO_COMM_TRACE__ = window.__SWIFTGO_COMM_TRACE__ || []);
            ring.push({
              t: Date.now(),
              role,
              stage: ok ? "dc_out" : "dc_out_fail",
              ready: Boolean(channel && channel.readyState === "open"),
              buffered: channel?.bufferedAmount ?? null,
            });
            if (ring.length > 120) ring.splice(0, ring.length - 120);
          }
        } catch {
          /* ignore */
        }
        return ok;
      },
      subscribe: (handler) => {
        if (typeof handler !== "function") return () => {};
        commHandlers.add(handler);
        try {
          if (typeof window !== "undefined") {
            const ring = (window.__SWIFTGO_COMM_TRACE__ = window.__SWIFTGO_COMM_TRACE__ || []);
            ring.push({
              t: Date.now(),
              role,
              stage: "comm_subscribe",
              handlers: commHandlers.size,
            });
          }
        } catch {
          /* ignore */
        }
        return () => commHandlers.delete(handler);
      },
    };
  }

  /**
   * Phase 4 — audio renegotiation on the existing PeerConnection (location DC stays).
   * STUN/TURN already applied via resolveIceConfiguration().
   */
  function createMediaBridge() {
    return {
      isReady: () => Boolean(pc && channel && channel.readyState === "open"),
      ensureLocalAudio: async () => {
        if (!pc) return { ok: false, reason: "no_pc" };
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          return { ok: false, reason: "no_media" };
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
          callLocalStream = stream;
          const track = stream.getAudioTracks()[0];
          if (!track) return { ok: false, reason: "no_track" };
          pc.addTrack(track, stream);
          return { ok: true };
        } catch {
          return { ok: false, reason: "mic_denied" };
        }
      },
      setMuted: (muted) => {
        callLocalStream?.getAudioTracks?.().forEach((t) => {
          t.enabled = !muted;
        });
      },
      createOfferSdp: async () => {
        if (!pc) return { ok: false, reason: "no_pc" };
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await waitIceComplete(pc);
          const sdp = pc.localDescription?.sdp || "";
          if (!sdp || sdp.length > P2P_MAX_SDP_CHARS) return { ok: false, reason: "bad_sdp" };
          return { ok: true, sdp };
        } catch {
          return { ok: false, reason: "offer_error" };
        }
      },
      acceptOfferSdp: async (sdp) => {
        if (!pc) return { ok: false, reason: "no_pc" };
        const text = String(sdp || "");
        if (!text || text.length > P2P_MAX_SDP_CHARS) return { ok: false, reason: "bad_sdp" };
        try {
          await pc.setRemoteDescription({ type: "offer", sdp: text });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await waitIceComplete(pc);
          const out = pc.localDescription?.sdp || "";
          if (!out || out.length > P2P_MAX_SDP_CHARS) return { ok: false, reason: "bad_sdp" };
          return { ok: true, sdp: out };
        } catch {
          return { ok: false, reason: "answer_error" };
        }
      },
      applyAnswerSdp: async (sdp) => {
        if (!pc) return { ok: false, reason: "no_pc" };
        const text = String(sdp || "");
        if (!text || text.length > P2P_MAX_SDP_CHARS) return { ok: false, reason: "bad_sdp" };
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: text });
          return { ok: true };
        } catch {
          return { ok: false, reason: "apply_error" };
        }
      },
      onRemoteTrack: (handler) => {
        remoteTrackHandler = typeof handler === "function" ? handler : null;
      },
      stopLocalAudio: () => {
        try {
          callLocalStream?.getTracks?.().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        callLocalStream = null;
        if (pc && typeof pc.getSenders === "function") {
          for (const sender of pc.getSenders()) {
            if (sender.track?.kind === "audio") {
              try {
                pc.removeTrack(sender);
              } catch {
                /* ignore */
              }
            }
          }
        }
      },
      addIceCandidate: async (init) => {
        if (!pc || !init) return false;
        try {
          await pc.addIceCandidate(init);
          pipe.noteTrickleApplied();
          return true;
        } catch {
          pushPipeline("ice_candidate_apply_error", { failureReason: "addIceCandidate_failed" });
          return false;
        }
      },
    };
  }

  return {
    startAsDriver,
    startAsCustomer,
    acceptRemoteAnswer,
    enqueueLocationFix,
    scheduleReconnect,
    close,
    suspend,
    getState,
    syncAssignmentVersion,
    getCounters: () => ({ ...counters }),
    getPipeline: () => pipe.getEvents(),
    getPipelineReport: () => pipe.buildReport(),
    setPipelineRideId: (id) => pipe.setRideId(id),
    notePipelineStage: (stage, detail = {}) => pushPipeline(stage, detail),
    noteOfferUploaded: (sdp) => {
      pipe.noteCandidatesUploadedBundled(sdp);
      pushPipeline("offer_uploaded", {
        sdpChars: String(sdp || "").length,
        candidates: countSdpCandidates(sdp),
      });
    },
    noteAnswerUploaded: (sdp) => {
      pipe.noteCandidatesUploadedBundled(sdp);
      pushPipeline("answer_uploaded", {
        sdpChars: String(sdp || "").length,
        candidates: countSdpCandidates(sdp),
      });
    },
    noteOfferDownloaded: (sdp) => {
      pushPipeline("offer_downloaded", {
        sdpChars: String(sdp || "").length,
        candidates: countSdpCandidates(sdp),
      });
    },
    noteAnswerDownloaded: (sdp) => {
      pushPipeline("answer_downloaded", {
        sdpChars: String(sdp || "").length,
        candidates: countSdpCandidates(sdp),
      });
    },
    evaluateHealth,
    createCommTransport,
    createMediaBridge,
    /** Test helpers */
    _handleMessageForTest: handleMessage,
    _setChannelOpenForTest: (open, sendFn, opts = {}) => {
      if (open) {
        channel = {
          readyState: "open",
          bufferedAmount: Math.max(0, Math.floor(Number(opts.bufferedAmount) || 0)),
          send: typeof sendFn === "function" ? sendFn : () => {},
          close: () => {},
        };
        channelEverOpened = true;
        setState(P2P_STATE.CONNECTING);
      }
    },
    _flushPendingForTest: (gen = generation) => flushPendingLoc(gen),
    _getPendingGenForTest: () => pendingLocGen,
    _getSentSequencesForTest: () => new Set(sentSequences),
    _scheduleChannelOpenTimeoutForTest: (gen = generation) => scheduleChannelOpenTimeout(gen),
  };
}
