/**
 * P2P voice-call controller — renegotiate audio on existing RTCPeerConnection.
 * Signaling via DataChannel (comm_call_*), STUN/TURN from existing ICE config.
 * No video. No Firebase call signaling.
 *
 * Uses parent conversation session `send` so seq stays ordered with chat/voice.
 */

import { COMM_MESSAGE_TYPE } from "./p2p-comm-protocol.mjs";

export const CALL_STATE = Object.freeze({
  IDLE: "idle",
  OUTGOING: "outgoing",
  INCOMING: "incoming",
  ACTIVE: "active",
  ENDED: "ended",
});

function newCallId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @typedef {{
 *   isReady?: () => boolean,
 *   ensureLocalAudio?: () => Promise<{ ok: boolean, reason?: string }>,
 *   setMuted?: (muted: boolean) => void,
 *   createOfferSdp?: () => Promise<{ ok: boolean, sdp?: string, reason?: string }>,
 *   acceptOfferSdp?: (sdp: string) => Promise<{ ok: boolean, sdp?: string, reason?: string }>,
 *   applyAnswerSdp?: (sdp: string) => Promise<{ ok: boolean, reason?: string }>,
 *   onRemoteTrack?: (handler: (stream: MediaStream, track?: MediaStreamTrack) => void) => void,
 *   stopLocalAudio?: () => void,
 *   addIceCandidate?: (init: object) => Promise<boolean>,
 * }} CommMediaBridge
 */

/**
 * @param {{
 *   send: (type: string, payload?: object, extra?: object) => { ok: boolean, reason?: string, message?: object },
 *   mediaBridge?: CommMediaBridge | null,
 *   getMediaBridge?: () => CommMediaBridge | null,
 *   onState?: (state: string, detail?: object) => void,
 *   onRemoteStream?: (stream: MediaStream | null) => void,
 *   onDiag?: (code: string, detail?: object) => void,
 *   isTransportReady?: () => boolean,
 * }} opts
 */
export function createCallController(opts) {
  const send = opts.send;
  const onState = opts.onState || (() => {});
  const onRemoteStream = opts.onRemoteStream || (() => {});
  const diag = opts.onDiag || (() => {});
  const isTransportReady = opts.isTransportReady || (() => true);

  let state = CALL_STATE.IDLE;
  let callId = "";
  let muted = false;
  let speakerOn = true;
  let closed = false;
  /** @type {string} */
  let pendingRemoteOffer = "";
  /** @type {HTMLAudioElement | null} */
  let remoteAudioEl = null;
  /** @type {MediaStream | null} */
  let remoteStream = null;

  function bridge() {
    if (typeof opts.getMediaBridge === "function") {
      return opts.getMediaBridge() || opts.mediaBridge || null;
    }
    return opts.mediaBridge || null;
  }

  function setCallState(next, detail = {}) {
    state = next;
    onState(next, { callId, muted, speakerOn, ...detail });
  }

  function sendCall(type, payload = {}) {
    if (closed) return { ok: false, reason: "closed" };
    if (!isTransportReady()) return { ok: false, reason: "transport_not_ready" };
    return send(type, payload, { skipPending: true });
  }

  function ensureRemoteAudioEl() {
    if (typeof document === "undefined") return null;
    if (remoteAudioEl) return remoteAudioEl;
    remoteAudioEl = document.createElement("audio");
    remoteAudioEl.autoplay = true;
    remoteAudioEl.playsInline = true;
    remoteAudioEl.setAttribute("data-swiftgo-call-audio", "1");
    remoteAudioEl.style.display = "none";
    document.body.appendChild(remoteAudioEl);
    return remoteAudioEl;
  }

  function attachRemoteStream(stream) {
    remoteStream = stream || null;
    onRemoteStream(remoteStream);
    const el = ensureRemoteAudioEl();
    if (el && stream) {
      el.srcObject = stream;
      el.muted = false;
      el.volume = speakerOn ? 1 : 0;
      void el.play?.().catch?.(() => {});
    }
  }

  function wireRemoteTrack() {
    bridge()?.onRemoteTrack?.((stream) => {
      attachRemoteStream(stream);
    });
  }

  function cleanupMedia() {
    bridge()?.stopLocalAudio?.();
    if (remoteAudioEl) {
      try {
        remoteAudioEl.srcObject = null;
        remoteAudioEl.remove();
      } catch {
        /* ignore */
      }
      remoteAudioEl = null;
    }
    remoteStream = null;
    onRemoteStream(null);
  }

  async function startCall() {
    if (state !== CALL_STATE.IDLE && state !== CALL_STATE.ENDED) {
      return { ok: false, reason: "busy" };
    }
    const mb = bridge();
    if (!mb?.isReady?.()) return { ok: false, reason: "media_not_ready" };
    callId = newCallId();
    muted = false;
    setCallState(CALL_STATE.OUTGOING);
    wireRemoteTrack();
    const mic = await mb.ensureLocalAudio?.();
    if (!mic?.ok) {
      setCallState(CALL_STATE.ENDED, { reason: mic?.reason || "mic_failed" });
      setCallState(CALL_STATE.IDLE);
      return { ok: false, reason: mic?.reason || "mic_failed" };
    }
    mb.setMuted?.(false);
    const offer = await mb.createOfferSdp?.();
    if (!offer?.ok || !offer.sdp) {
      mb.stopLocalAudio?.();
      setCallState(CALL_STATE.ENDED, { reason: offer?.reason || "offer_failed" });
      setCallState(CALL_STATE.IDLE);
      return { ok: false, reason: offer?.reason || "offer_failed" };
    }
    const sent = sendCall(COMM_MESSAGE_TYPE.CALL_OFFER, {
      callId,
      sdp: offer.sdp,
      media: "audio",
    });
    if (!sent.ok) {
      mb.stopLocalAudio?.();
      setCallState(CALL_STATE.IDLE);
      return sent;
    }
    diag("call_outgoing", { callId });
    return { ok: true, callId };
  }

  async function acceptCall() {
    if (state !== CALL_STATE.INCOMING || !callId) {
      return { ok: false, reason: "no_incoming" };
    }
    const mb = bridge();
    if (!mb?.isReady?.()) return { ok: false, reason: "media_not_ready" };
    wireRemoteTrack();
    const mic = await mb.ensureLocalAudio?.();
    if (!mic?.ok) {
      rejectCall();
      return { ok: false, reason: mic?.reason || "mic_failed" };
    }
    if (!pendingRemoteOffer) {
      rejectCall();
      return { ok: false, reason: "missing_offer" };
    }
    const ans = await mb.acceptOfferSdp?.(pendingRemoteOffer);
    pendingRemoteOffer = "";
    if (!ans?.ok || !ans.sdp) {
      mb.stopLocalAudio?.();
      rejectCall();
      return { ok: false, reason: ans?.reason || "answer_failed" };
    }
    const sent = sendCall(COMM_MESSAGE_TYPE.CALL_ANSWER, {
      callId,
      sdp: ans.sdp,
      media: "audio",
    });
    if (!sent.ok) {
      mb.stopLocalAudio?.();
      setCallState(CALL_STATE.IDLE);
      return sent;
    }
    muted = false;
    mb.setMuted?.(false);
    setCallState(CALL_STATE.ACTIVE);
    diag("call_active", { callId });
    return { ok: true, callId };
  }

  function rejectCall() {
    if (state !== CALL_STATE.INCOMING && state !== CALL_STATE.OUTGOING) {
      return { ok: false, reason: "not_ringing" };
    }
    const id = callId;
    sendCall(COMM_MESSAGE_TYPE.CALL_REJECT, { callId: id });
    cleanupMedia();
    pendingRemoteOffer = "";
    setCallState(CALL_STATE.ENDED, { reason: "rejected" });
    setCallState(CALL_STATE.IDLE);
    callId = "";
    return { ok: true };
  }

  function endCall({ remote = false } = {}) {
    if (state === CALL_STATE.IDLE) return { ok: true };
    const id = callId;
    if (!remote && id) sendCall(COMM_MESSAGE_TYPE.CALL_END, { callId: id });
    cleanupMedia();
    pendingRemoteOffer = "";
    setCallState(CALL_STATE.ENDED, { reason: remote ? "remote_end" : "local_end" });
    setCallState(CALL_STATE.IDLE);
    callId = "";
    diag("call_ended", { callId: id, remote });
    return { ok: true };
  }

  function setMuted(next) {
    muted = Boolean(next);
    bridge()?.setMuted?.(muted);
    onState(state, { callId, muted, speakerOn });
    return { ok: true, muted };
  }

  function setSpeaker(next) {
    speakerOn = Boolean(next);
    if (remoteAudioEl) remoteAudioEl.volume = speakerOn ? 1 : 0;
    onState(state, { callId, muted, speakerOn });
    return { ok: true, speakerOn };
  }

  /**
   * @param {object} msg validated envelope
   * @param {string} type
   */
  async function handleCallMessage(msg, type) {
    if (closed) return;
    const payload = msg.payload || {};
    const remoteCallId = String(payload.callId || "");

    if (type === COMM_MESSAGE_TYPE.CALL_OFFER) {
      if (state !== CALL_STATE.IDLE && state !== CALL_STATE.ENDED) {
        sendCall(COMM_MESSAGE_TYPE.CALL_REJECT, { callId: remoteCallId, reason: "busy" });
        return;
      }
      callId = remoteCallId || newCallId();
      pendingRemoteOffer = String(payload.sdp || "");
      setCallState(CALL_STATE.INCOMING, { sdpReady: Boolean(pendingRemoteOffer) });
      diag("call_incoming", { callId });
      return;
    }

    if (type === COMM_MESSAGE_TYPE.CALL_ANSWER) {
      if (state !== CALL_STATE.OUTGOING) return;
      if (remoteCallId && callId && remoteCallId !== callId) return;
      const sdp = String(payload.sdp || "");
      const applied = await bridge()?.applyAnswerSdp?.(sdp);
      if (!applied?.ok) {
        endCall();
        return;
      }
      setCallState(CALL_STATE.ACTIVE);
      diag("call_active", { callId });
      return;
    }

    if (type === COMM_MESSAGE_TYPE.CALL_REJECT) {
      if (state === CALL_STATE.OUTGOING || state === CALL_STATE.INCOMING) {
        cleanupMedia();
        pendingRemoteOffer = "";
        setCallState(CALL_STATE.ENDED, { reason: "rejected" });
        setCallState(CALL_STATE.IDLE);
        callId = "";
      }
      return;
    }

    if (type === COMM_MESSAGE_TYPE.CALL_END) {
      if (callId && remoteCallId && remoteCallId !== callId) return;
      endCall({ remote: true });
      return;
    }

    if (type === COMM_MESSAGE_TYPE.CALL_ICE && payload?.candidate) {
      void bridge()?.addIceCandidate?.(payload.candidate);
    }
  }

  function noteTransportLost() {
    if (state === CALL_STATE.IDLE) return;
    cleanupMedia();
    pendingRemoteOffer = "";
    setCallState(CALL_STATE.ENDED, { reason: "transport_lost" });
    setCallState(CALL_STATE.IDLE);
    callId = "";
    diag("call_recover_idle", {});
  }

  function getState() {
    return {
      state,
      callId,
      muted,
      speakerOn,
      hasRemote: Boolean(remoteStream),
      mediaReady: Boolean(bridge()?.isReady?.()),
    };
  }

  function close() {
    closed = true;
    endCall();
  }

  return {
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    setMuted,
    setSpeaker,
    noteTransportLost,
    handleCallMessage,
    getState,
    close,
    CALL_STATE,
  };
}

/**
 * In-memory media bridge for unit tests (no real WebRTC).
 */
export function createFakeMediaBridge(opts = {}) {
  let ready = opts.ready !== false;
  let muted = false;
  let localOn = false;
  /** @type {((stream: any) => void) | null} */
  let remoteHandler = null;
  const offerSdp =
    opts.offerSdp ||
    "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
  const answerSdp =
    opts.answerSdp ||
    "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
  let remoteApplied = "";
  const candidates = [];

  return {
    isReady: () => ready,
    setReady: (v) => {
      ready = Boolean(v);
    },
    ensureLocalAudio: async () => {
      if (!ready) return { ok: false, reason: "media_not_ready" };
      localOn = true;
      return { ok: true };
    },
    setMuted: (m) => {
      muted = Boolean(m);
    },
    createOfferSdp: async () => {
      if (!localOn) return { ok: false, reason: "no_local" };
      return { ok: true, sdp: offerSdp };
    },
    acceptOfferSdp: async (sdp) => {
      remoteApplied = String(sdp || "");
      if (!localOn) return { ok: false, reason: "no_local" };
      return { ok: true, sdp: answerSdp };
    },
    applyAnswerSdp: async (sdp) => {
      remoteApplied = String(sdp || "");
      remoteHandler?.({ id: "fake-remote" });
      return { ok: true };
    },
    onRemoteTrack: (handler) => {
      remoteHandler = handler;
    },
    stopLocalAudio: () => {
      localOn = false;
    },
    addIceCandidate: async (c) => {
      candidates.push(c);
      return true;
    },
    _get: () => ({ muted, localOn, remoteApplied, candidates }),
  };
}
