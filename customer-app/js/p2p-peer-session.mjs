/**
 * Phase 3 — injectable WebRTC peer session (driver or customer role).
 * Uses bundled non-trickle ICE: wait for gathering complete before publishing SDP.
 */

import {
  P2P_BUFFERED_AMOUNT_HIGH,
  P2P_DATA_CHANNEL_LABEL,
  P2P_DIAG,
  P2P_DEGRADED_AFTER_MS,
  P2P_FALLBACK_AFTER_MS,
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
  let healthTimer = 0;
  let reconnectTimer = 0;
  let reconnectAttempt = 0;
  let pendingLoc = null;
  let sendTimer = 0;
  let closed = false;
  let firstValidEmitted = false;

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
    fallbackTransitions: 0,
    reconnectAttempts: 0,
    backpressureCoalesces: 0,
  };

  function setState(next) {
    if (state === next) return;
    state = next;
    onState(next);
    if (next === P2P_STATE.P2P_HEALTHY) diag(P2P_DIAG.HEALTHY);
    if (next === P2P_STATE.P2P_DEGRADED) diag(P2P_DIAG.DEGRADED);
    if (next === P2P_STATE.FIREBASE_FALLBACK) {
      counters.fallbackTransitions += 1;
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
    if (sendTimer) {
      clearT(sendTimer);
      sendTimer = 0;
    }
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
    counters.validMessages += 1;
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
        trySend(ack.serialized);
        counters.acks += 1;
      }
      evaluateHealth();
    } else if (validated.type === "ack") {
      lastAckAt = nowMs();
      counters.acks += 1;
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
      if (!isCurrent(gen)) return;
      counters.channelsOpened += 1;
      diag(P2P_DIAG.CHANNEL_OPEN);
      setState(P2P_STATE.CONNECTING);
      // Channel open alone is NOT healthy — wait for fix/ack.
      scheduleHealthPoll(gen);
      evaluateHealth();
      // Deliver any queued location immediately so customer marker does not wait
      // for the next GPS callback after ICE/datachannel setup.
      flushPendingLoc();
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

  function trySend(serialized) {
    if (!channel || channel.readyState !== "open") return false;
    if (channel.bufferedAmount > P2P_BUFFERED_AMOUNT_HIGH) {
      counters.backpressureCoalesces += 1;
      diag(P2P_DIAG.BACKPRESSURE_COALESCED);
      return false;
    }
    try {
      channel.send(serialized);
      return true;
    } catch {
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
      // Safety timeout — still publish whatever we have.
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

  /**
   * Driver: create offer session.
   */
  async function startAsDriver(meta = {}) {
    if (closed) return null;
    if (!Peer) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return null;
    }
    generation += 1;
    const gen = generation;
    counters.sessionsStarted += 1;
    tearDownPc();
    clearTimers();
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
    return { peerSessionId, generation: gen, sdp };
  }

  async function acceptRemoteAnswer(sdp, gen = generation) {
    if (!isCurrent(gen) || !pc) return false;
    const text = String(sdp || "");
    if (!text || text.length > P2P_MAX_SDP_CHARS) return false;
    await pc.setRemoteDescription({ type: "answer", sdp: text });
    return true;
  }

  /**
   * Customer: apply remote offer and publish answer.
   */
  async function startAsCustomer(meta = {}) {
    if (closed) return null;
    if (!Peer) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return null;
    }
    generation += 1;
    const gen = generation;
    counters.sessionsStarted += 1;
    tearDownPc();
    clearTimers();
    peerSessionId = String(meta.peerSessionId || "");
    trackingSessionId = String(meta.trackingSessionId || "").trim();
    assignmentVersion = Math.max(1, Math.floor(Number(meta.assignmentVersion) || 1));
    if (!isValidPeerSessionId(peerSessionId)) {
      setState(P2P_STATE.FIREBASE_FALLBACK);
      return null;
    }
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
    return { peerSessionId, generation: gen, sdp };
  }

  function enqueueLocationFix(fix) {
    if (closed || role !== "driver") return;
    if (state === P2P_STATE.CLOSED || state === P2P_STATE.DISABLED) return;
    pendingLoc = fix;
    flushPendingLoc();
  }

  function flushPendingLoc() {
    if (!pendingLoc || role !== "driver") return;
    if (channel?.readyState !== "open") return;
    if (channel.bufferedAmount > P2P_BUFFERED_AMOUNT_HIGH) {
      counters.backpressureCoalesces += 1;
      diag(P2P_DIAG.BACKPRESSURE_COALESCED);
      return;
    }
    const now = nowMs();
    if (lastValidFixAt != null && now - lastValidFixAt < P2P_SEND_INTERVAL_MS * 0.5 && lastSequenceSent > 0) {
      // Coalesce bursts; still keep newest pending until interval.
    }
    lastSequenceSent += 1;
    const built = buildP2pLocationMessage(pendingLoc, {
      peerSessionId,
      trackingSessionId,
      assignmentVersion,
      sequence: lastSequenceSent,
      role: "driver",
    });
    pendingLoc = null;
    if (!built.ok) return;
    if (trySend(built.serialized)) {
      counters.fixesSent += 1;
      lastValidFixAt = now;
    }
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
    pendingLoc = null;
    setState(P2P_STATE.CLOSED);
  }

  function suspend() {
    // Hidden customer: stop sending / treat as fallback without full destroy of ids.
    clearTimers();
    tearDownPc();
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
    _setChannelOpenForTest: (open) => {
      if (open) {
        channel = {
          readyState: "open",
          bufferedAmount: 0,
          send: () => {},
          close: () => {},
        };
        setState(P2P_STATE.CONNECTING);
      }
    },
  };
}
