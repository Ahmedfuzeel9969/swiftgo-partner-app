/**
 * Phase 3 — injectable WebRTC peer session (driver or customer role).
 * Uses bundled non-trickle ICE: wait for gathering complete before publishing SDP.
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
  P2P_MAX_SDP_CHARS,
  P2P_RECONNECT_MAX_ATTEMPTS,
  P2P_SEND_INTERVAL_MS,
  P2P_STATE,
  createPeerSessionId,
  isValidPeerSessionId,
  nextReconnectDelayMs,
  resolveIceConfiguration,
} from "./p2p-protocol.mjs";
import {
  buildP2pAckMessage,
  buildP2pLocationMessage,
  validateP2pMessage,
} from "./p2p-location-envelope.mjs";

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
  let assignmentVersion = 1;
  let lastSequenceSent = 0;
  let lastSequenceRecv = 0;
  let lastValidFixAt = null;
  let lastAckAt = null;
  let lastAckSequence = 0;
  let healthTimer = 0;
  let reconnectTimer = 0;
  let reconnectAttempt = 0;
  let channelOpenTimer = 0;
  let firstAckTimer = 0;
  let backpressureFlushTimer = 0;
  let pendingLoc = null;
  let pendingLocGen = 0;
  let closed = false;
  let firstValidEmitted = false;
  let channelEverOpened = false;
  let healthySessionCounted = false;
  let fallbackTransitionCounted = false;
  /** @type {Set<number>} */
  const sentSequences = new Set();

  const counters = {
    sessionsStarted: 0,
    channelsOpened: 0,
    healthySessions: 0,
    fixesAttempted: 0,
    fixesSent: 0,
    fixesReceived: 0,
    acknowledgementsReceived: 0,
    acksSent: 0,
    sendFailures: 0,
    offers: 0,
    answers: 0,
    channelsClosed: 0,
    validMessages: 0,
    invalidMessages: 0,
    fallbackTransitions: 0,
    reconnectAttempts: 0,
    backpressureCoalesces: 0,
    pendingCoalesces: 0,
  };

  function resetSessionLifecycleFlags() {
    channelEverOpened = false;
    healthySessionCounted = false;
    fallbackTransitionCounted = false;
  }

  function clearPendingDeliveryState() {
    pendingLoc = null;
    pendingLocGen = 0;
    sentSequences.clear();
    lastAckSequence = 0;
    if (backpressureFlushTimer) {
      clearT(backpressureFlushTimer);
      backpressureFlushTimer = 0;
    }
    if (channelOpenTimer) {
      clearT(channelOpenTimer);
      channelOpenTimer = 0;
    }
    if (firstAckTimer) {
      clearT(firstAckTimer);
      firstAckTimer = 0;
    }
  }

  function maybeMarkHealthySession() {
    if (healthySessionCounted || !channelEverOpened) return;
    if (role === "driver") {
      if (lastAckAt == null) return;
    } else if (!firstValidEmitted) {
      return;
    }
    healthySessionCounted = true;
    counters.healthySessions += 1;
  }

  function setState(next) {
    if (state === next) return;
    const prev = state;
    state = next;
    onState(next);
    if (next === P2P_STATE.P2P_HEALTHY) diag(P2P_DIAG.HEALTHY);
    if (next === P2P_STATE.P2P_DEGRADED) diag(P2P_DIAG.DEGRADED);
    if (next === P2P_STATE.FIREBASE_FALLBACK && prev !== P2P_STATE.FIREBASE_FALLBACK) {
      if (!fallbackTransitionCounted) {
        counters.fallbackTransitions += 1;
        fallbackTransitionCounted = true;
      }
      diag(P2P_DIAG.FIREBASE_FALLBACK);
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
    if (reconnectTimer) {
      clearT(reconnectTimer);
      reconnectTimer = 0;
    }
    clearPendingDeliveryState();
  }

  function tearDownPc() {
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

  function validateDriverAck(msg) {
    const seq = Math.floor(Number(msg?.seq) || 0);
    if (seq < 1) return { ok: false, reason: "invalid_sequence" };
    if (seq > lastSequenceSent) return { ok: false, reason: "future_sequence" };
    if (!sentSequences.has(seq)) return { ok: false, reason: "unsent_sequence" };
    if (seq <= lastAckSequence) return { ok: false, reason: "duplicate_ack" };
    return { ok: true, seq };
  }

  function evaluateHealth() {
    if (!isCurrent() || state === P2P_STATE.CLOSED || state === P2P_STATE.DISABLED) return;
    const now = nowMs();
    const fixAge = lastValidFixAt != null ? now - lastValidFixAt : Infinity;
    const ackAge = lastAckAt != null ? now - lastAckAt : Infinity;
    if (role === "customer") {
      if (fixAge <= P2P_DEGRADED_AFTER_MS) {
        setState(P2P_STATE.P2P_HEALTHY);
      } else if (fixAge <= P2P_FALLBACK_AFTER_MS) {
        setState(P2P_STATE.P2P_DEGRADED);
      } else {
        setState(P2P_STATE.FIREBASE_FALLBACK);
      }
    } else {
      // Driver: need channel + recent ack evidence for HEALTHY
      if (channel?.readyState === "open" && ackAge <= P2P_DEGRADED_AFTER_MS && lastValidFixAt != null) {
        setState(P2P_STATE.P2P_HEALTHY);
      } else if (channel?.readyState === "open" && ackAge <= P2P_FALLBACK_AFTER_MS) {
        setState(P2P_STATE.P2P_DEGRADED);
      } else if (channel?.readyState === "open") {
        setState(P2P_STATE.P2P_DEGRADED);
      } else {
        setState(P2P_STATE.FIREBASE_FALLBACK);
      }
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

  function scheduleChannelOpenTimeout(gen) {
    clearT(channelOpenTimer);
    channelOpenTimer = setT(() => {
      channelOpenTimer = 0;
      if (!isCurrent(gen) || channelEverOpened) return;
      diag(P2P_DIAG.CHANNEL_OPEN_TIMEOUT);
      setState(P2P_STATE.FIREBASE_FALLBACK);
    }, P2P_CHANNEL_OPEN_TIMEOUT_MS);
  }

  function scheduleFirstAckTimeout(gen) {
    if (firstAckTimer || role !== "driver") return;
    firstAckTimer = setT(() => {
      firstAckTimer = 0;
      if (!isCurrent(gen) || lastAckAt != null) return;
      diag(P2P_DIAG.ACK_TIMEOUT);
      setState(P2P_STATE.FIREBASE_FALLBACK);
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

  function storePendingFix(fix, gen) {
    if (!isCurrent(gen)) return;
    if (pendingLoc != null && pendingLocGen === gen) {
      counters.pendingCoalesces += 1;
      diag(P2P_DIAG.PENDING_COALESCED);
    }
    pendingLoc = fix;
    pendingLocGen = gen;
  }

  function onChannelOpen(gen) {
    if (!isCurrent(gen)) return;
    clearT(channelOpenTimer);
    channelOpenTimer = 0;
    if (!channelEverOpened) {
      channelEverOpened = true;
      counters.channelsOpened += 1;
    }
    diag(P2P_DIAG.CHANNEL_OPEN);
    setState(P2P_STATE.CONNECTING);
    scheduleHealthPoll(gen);
    evaluateHealth();
    flushPendingLoc(gen);
  }

  function handleMessage(raw, gen) {
    if (!isCurrent(gen)) {
      diag(P2P_DIAG.STALE_GENERATION);
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
    if (validated.type === "loc" && validated.fix) {
      lastSequenceRecv = validated.fix.sequence;
      lastValidFixAt = nowMs();
      counters.fixesReceived += 1;
      if (!firstValidEmitted) {
        firstValidEmitted = true;
        diag(P2P_DIAG.FIRST_VALID_FIX);
      }
      maybeMarkHealthySession();
      deps.onLocationFix?.(validated.fix);
      if (role === "customer") {
        const ack = buildP2pAckMessage({
          peerSessionId,
          trackingSessionId,
          assignmentVersion,
          sequence: validated.fix.sequence,
        });
        if (trySend(ack.serialized)) {
          counters.acksSent += 1;
        }
      }
      evaluateHealth();
    } else if (validated.type === "ack") {
      const seq = Math.floor(Number(validated.message.seq) || 0);
      lastAckSequence = seq;
      lastAckAt = nowMs();
      counters.acknowledgementsReceived += 1;
      clearT(firstAckTimer);
      firstAckTimer = 0;
      maybeMarkHealthySession();
      deps.onAck?.(validated.message);
      evaluateHealth();
    } else if (validated.type === "close") {
      void close({ reason: "remote_close" });
    }
  }

  function wireChannel(ch, gen) {
    channel = ch;
    ch.binaryType = "blob";
    ch.onopen = () => {
      onChannelOpen(gen);
    };
    ch.onclose = () => {
      counters.channelsClosed += 1;
      if (!isCurrent(gen)) return;
      setState(P2P_STATE.FIREBASE_FALLBACK);
    };
    ch.onmessage = (ev) => {
      handleMessage(typeof ev.data === "string" ? ev.data : String(ev.data || ""), gen);
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
      return true;
    } catch {
      counters.sendFailures += 1;
      return false;
    }
  }

  async function waitIceComplete(peer) {
    if (peer.iceGatheringState === "complete") return;
    await new Promise((resolve) => {
      const done = () => {
        if (peer.iceGatheringState === "complete") {
          peer.removeEventListener("icegatheringstatechange", done);
          resolve();
        }
      };
      peer.addEventListener("icegatheringstatechange", done);
      setT(() => {
        peer.removeEventListener("icegatheringstatechange", done);
        resolve();
      }, 4_000);
    });
  }

  function createPc(gen) {
    if (!Peer) throw new Error("RTC_UNAVAILABLE");
    const ice = deps.iceConfig || resolveIceConfiguration();
    const peer = new Peer({ iceServers: ice.iceServers || [] });
    pc = peer;
    peer.onicecandidateerror = () => {
      /* privacy: do not log candidate details */
    };
    return peer;
  }

  async function startAsDriver(meta = {}) {
    if (closed) return null;
    if (!Peer) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return null;
    }
    generation += 1;
    const gen = generation;
    counters.sessionsStarted += 1;
    resetSessionLifecycleFlags();
    tearDownPc();
    clearTimers();
    clearPendingDeliveryState();
    peerSessionId = isValidPeerSessionId(meta.peerSessionId)
      ? meta.peerSessionId
      : createPeerSessionId();
    trackingSessionId = String(meta.trackingSessionId || "").trim();
    assignmentVersion = Math.max(1, Math.floor(Number(meta.assignmentVersion) || 1));
    lastSequenceSent = 0;
    lastSequenceRecv = 0;
    lastValidFixAt = null;
    lastAckAt = null;
    firstValidEmitted = false;
    reconnectAttempt = 0;
    setState(P2P_STATE.SIGNALING);
    diag(P2P_DIAG.SIGNALING_STARTED);

    const peer = createPc(gen);
    const ch = peer.createDataChannel(P2P_DATA_CHANNEL_LABEL, { ordered: true });
    wireChannel(ch, gen);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitIceComplete(peer);
    if (!isCurrent(gen)) return null;
    const sdp = peer.localDescription?.sdp || "";
    if (!sdp || sdp.length > P2P_MAX_SDP_CHARS) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return null;
    }
    counters.offers += 1;
    diag(P2P_DIAG.OFFER_READY);
    await deps.onLocalDescription?.("offer", sdp, {
      peerSessionId,
      trackingSessionId,
      assignmentVersion,
      generation: gen,
    });
    setState(P2P_STATE.CONNECTING);
    scheduleChannelOpenTimeout(gen);
    return { peerSessionId, generation: gen, sdp };
  }

  async function acceptRemoteAnswer(sdp, gen = generation) {
    if (!isCurrent(gen) || !pc) return false;
    const text = String(sdp || "");
    if (!text || text.length > P2P_MAX_SDP_CHARS) return false;
    await pc.setRemoteDescription({ type: "answer", sdp: text });
    return true;
  }

  async function startAsCustomer(meta = {}) {
    if (closed) return null;
    if (!Peer) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return null;
    }
    generation += 1;
    const gen = generation;
    counters.sessionsStarted += 1;
    resetSessionLifecycleFlags();
    tearDownPc();
    clearTimers();
    clearPendingDeliveryState();
    peerSessionId = String(meta.peerSessionId || "");
    trackingSessionId = String(meta.trackingSessionId || "").trim();
    assignmentVersion = Math.max(1, Math.floor(Number(meta.assignmentVersion) || 1));
    if (!isValidPeerSessionId(peerSessionId)) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return null;
    }
    lastSequenceSent = 0;
    lastSequenceRecv = 0;
    lastValidFixAt = null;
    lastAckAt = null;
    firstValidEmitted = false;
    setState(P2P_STATE.SIGNALING);
    diag(P2P_DIAG.SIGNALING_STARTED);

    const peer = createPc(gen);
    peer.ondatachannel = (ev) => {
      if (ev.channel) wireChannel(ev.channel, gen);
    };
    const offerSdp = String(meta.offerSdp || "");
    if (!offerSdp || offerSdp.length > P2P_MAX_SDP_CHARS) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return null;
    }
    await peer.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await waitIceComplete(peer);
    if (!isCurrent(gen)) return null;
    const sdp = peer.localDescription?.sdp || "";
    if (!sdp || sdp.length > P2P_MAX_SDP_CHARS) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return null;
    }
    counters.answers += 1;
    diag(P2P_DIAG.ANSWER_READY);
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
      storePendingFix(fix, gen);
      return;
    }
    if (channel.bufferedAmount > P2P_BUFFERED_AMOUNT_HIGH) {
      if (pendingLoc != null) {
        counters.backpressureCoalesces += 1;
        diag(P2P_DIAG.BACKPRESSURE_COALESCED);
      }
      storePendingFix(fix, gen);
      scheduleBackpressureFlush(gen);
      return;
    }
    storePendingFix(fix, gen);
    flushPendingLoc(gen);
  }

  function flushPendingLoc(gen = generation) {
    if (!pendingLoc || role !== "driver") return;
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
    if (lastValidFixAt != null && now - lastValidFixAt < P2P_SEND_INTERVAL_MS * 0.5 && lastSequenceSent > 0) {
      // Coalesce bursts; keep newest pending until interval elapses.
      return;
    }

    counters.fixesAttempted += 1;
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

    if (trySend(built.serialized, { countBackpressure: false })) {
      lastSequenceSent = nextSeq;
      sentSequences.add(nextSeq);
      counters.fixesSent += 1;
      lastValidFixAt = now;
      pendingLoc = null;
      pendingLocGen = 0;
      if (counters.fixesSent === 1) {
        scheduleFirstAckTimeout(gen);
      }
    } else if (channel.bufferedAmount > P2P_BUFFERED_AMOUNT_HIGH) {
      scheduleBackpressureFlush(gen);
    }
    // On throw, pendingLoc retained; sendFailures incremented in trySend.
  }

  function scheduleReconnect(startFn) {
    if (closed || reconnectAttempt >= P2P_RECONNECT_MAX_ATTEMPTS) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return;
    }
    const delay = nextReconnectDelayMs(reconnectAttempt);
    reconnectAttempt += 1;
    counters.reconnectAttempts += 1;
    setState(P2P_STATE.RECONNECTING);
    diag(P2P_DIAG.RECONNECT_SCHEDULED);
    reconnectTimer = setT(() => {
      reconnectTimer = 0;
      void startFn();
    }, delay);
  }

  async function close({ reason = "" } = {}) {
    void reason;
    closed = true;
    generation += 1;
    clearTimers();
    tearDownPc();
    clearPendingDeliveryState();
    setState(P2P_STATE.CLOSED);
  }

  function suspend() {
    clearTimers();
    tearDownPc();
    clearPendingDeliveryState();
    setState(P2P_STATE.FIREBASE_FALLBACK);
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
      counters: { ...counters },
      isHealthy: state === P2P_STATE.P2P_HEALTHY,
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
    getCounters: () => ({ ...counters }),
    evaluateHealth,
    /** Test helpers */
    _handleMessageForTest: handleMessage,
    _flushPendingForTest: (gen = generation) => flushPendingLoc(gen),
    _getPendingForTest: () => pendingLoc,
    _getPendingGenForTest: () => pendingLocGen,
    _setChannelOpenForTest: (open, gen = generation) => {
      if (open) {
        channel = {
          readyState: "open",
          bufferedAmount: 0,
          send: () => {},
          close: () => {},
        };
        onChannelOpen(gen);
      }
    },
    _setChannelForTest: (nextChannel) => {
      channel = nextChannel;
    },
    _scheduleChannelOpenTimeoutForTest: (gen = generation) => scheduleChannelOpenTimeout(gen),
    _scheduleFirstAckTimeoutForTest: (gen = generation) => scheduleFirstAckTimeout(gen),
    _advanceTimersForTest: (ms, gen = generation) => {
      void gen;
      void ms;
    },
  };
}
