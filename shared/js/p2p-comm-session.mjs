/**
 * Conversation session — Driver↔Customer (or future Contact) thread over CommTransport.
 * Phase 2: text · Phase 3: push-to-talk voice notes (chunked). No Firebase storage.
 */

import {
  COMM_SCOPE,
  COMM_MESSAGE_TYPE,
  buildCommEnvelope,
  validateCommEnvelope,
  classifyCommMessageType,
} from "./p2p-comm-protocol.mjs";
import {
  buildVoicePayloads,
  createVoiceAssembler,
  COMM_VOICE_MAX_MS,
} from "./p2p-comm-voice.mjs";
import { createCallController } from "./p2p-comm-call.mjs";

export const COMM_TEXT_MAX_CHARS = 500;
export const COMM_ACK_RETRY_MS = 2_000;
export const COMM_ACK_MAX_RETRIES = 5;
export { COMM_VOICE_MAX_MS, COMM_VOICE_MAX_BYTES, COMM_VOICE_CHUNK_CHARS } from "./p2p-comm-voice.mjs";

/**
 * @typedef {{
 *   send: (serialized: string) => boolean,
 *   subscribe: (handler: (raw: string) => void) => () => void,
 *   isReady?: () => boolean,
 * }} CommTransport
 */

/**
 * @param {{
 *   conversationId: string,
 *   scope?: string,
 *   role: "driver"|"customer",
 *   peerSessionId?: string,
 *   transport: CommTransport,
 *   nowMs?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   onInbound?: (msg: object, meta: { family: string }) => void,
 *   onText?: (msg: object) => void,
 *   onVoice?: (note: object) => void,
 *   onVoiceProgress?: (info: { voiceId: string, progress: number, have: number, total: number, direction: "in"|"out" }) => void,
 *   onAck?: (msg: object) => void,
 *   onDiag?: (code: string, detail?: object) => void,
 * }} opts
 */
export function createConversationSession(opts) {
  const conversationId = String(opts.conversationId || "").trim();
  const scope = String(opts.scope || COMM_SCOPE.RIDE);
  const role = opts.role === "customer" ? "customer" : "driver";
  const peerSessionId = String(opts.peerSessionId || "");
  const transport = opts.transport;
  const nowMs = opts.nowMs || (() => Date.now());
  const setT = opts.setTimeoutFn || setTimeout;
  const clearT = opts.clearTimeoutFn || clearTimeout;
  const onInbound = opts.onInbound || (() => {});
  const onText = opts.onText || (() => {});
  const onVoice = opts.onVoice || (() => {});
  const onVoiceProgress = opts.onVoiceProgress || (() => {});
  const onAck = opts.onAck || (() => {});
  const onCall = opts.onCall || (() => {});
  const diag = opts.onDiag || (() => {});
  const assembler = createVoiceAssembler();
  /** @type {Set<string>} */
  const completedVoices = new Set();
  /** @type {ReturnType<typeof import("./p2p-comm-call.mjs").createCallController> | null} */
  let callController = null;

  let closed = false;
  let outboundSeq = 0;
  let lastInboundSeq = 0;
  let retryTimer = 0;
  /** @type {Map<string, { serialized: string, type: string, attempts: number, at: number, seq: number, voiceId?: string, resend?: () => boolean }>} */
  const pendingAcks = new Map();
  const counters = {
    sent: 0,
    received: 0,
    invalid: 0,
    acked: 0,
    sendFail: 0,
    retries: 0,
    lost: 0,
    voiceSent: 0,
    voiceReceived: 0,
  };

  let unsub = () => {};
  if (transport && typeof transport.subscribe === "function") {
    unsub = transport.subscribe((raw) => {
      handleRaw(raw);
    });
  }

  function auth() {
    return {
      conversationId,
      expectRole: role === "customer" ? "driver" : "customer",
      closed,
    };
  }

  function scheduleRetryLoop() {
    if (retryTimer || closed) return;
    retryTimer = setT(function tick() {
      retryTimer = 0;
      if (closed) return;
      const now = nowMs();
      for (const [id, pending] of [...pendingAcks.entries()]) {
        if (String(pending.type).endsWith("_ack")) continue;
        if (now - pending.at < COMM_ACK_RETRY_MS) continue;
        if (pending.attempts >= COMM_ACK_MAX_RETRIES) {
          pendingAcks.delete(id);
          counters.lost += 1;
          diag("comm_delivery_lost", { msgId: id, voiceId: pending.voiceId });
          continue;
        }
        if (typeof transport.isReady === "function" && !transport.isReady()) continue;
        let ok = false;
        if (typeof pending.resend === "function") {
          ok = pending.resend();
        } else {
          ok = transport.send(pending.serialized);
        }
        if (ok) {
          pending.attempts += 1;
          pending.at = now;
          counters.retries += 1;
          diag("comm_retry", { msgId: id, attempts: pending.attempts, voiceId: pending.voiceId });
        }
      }
      if (pendingAcks.size && !closed) scheduleRetryLoop();
    }, COMM_ACK_RETRY_MS);
  }

  function ackTypesFor(type) {
    if (type === COMM_MESSAGE_TYPE.TEXT) return COMM_MESSAGE_TYPE.TEXT_ACK;
    if (
      type === COMM_MESSAGE_TYPE.VOICE_META ||
      type === COMM_MESSAGE_TYPE.VOICE_CHUNK
    ) {
      return COMM_MESSAGE_TYPE.VOICE_ACK;
    }
    return null;
  }

  function clearPendingAckOf(ackOf) {
    const key = String(ackOf || "");
    if (!key) return false;
    if (pendingAcks.has(key)) {
      pendingAcks.delete(key);
      counters.acked += 1;
      return true;
    }
    // Voice ACK may reference voiceId while pending is keyed by voiceId.
    for (const [id, pending] of pendingAcks.entries()) {
      if (pending.voiceId && pending.voiceId === key) {
        pendingAcks.delete(id);
        counters.acked += 1;
        return true;
      }
    }
    return false;
  }

  function maybeCompleteVoice(voiceId) {
    if (completedVoices.has(voiceId)) {
      send(COMM_MESSAGE_TYPE.VOICE_ACK, { voiceId }, { ackOf: voiceId });
      return;
    }
    const done = assembler.finalize(voiceId);
    if (!done.ok) return;
    completedVoices.add(voiceId);
    send(COMM_MESSAGE_TYPE.VOICE_ACK, { voiceId }, { ackOf: voiceId });
    counters.voiceReceived += 1;
    onVoice({
      voiceId: done.voiceId,
      mimeType: done.mimeType,
      durationMs: done.durationMs,
      base64: done.base64,
      bytes: done.bytes,
      totalChunks: done.totalChunks,
      ts: nowMs(),
    });
    onVoiceProgress({
      voiceId,
      progress: 1,
      have: done.totalChunks,
      total: done.totalChunks,
      direction: "in",
    });
  }

  function handleRaw(raw) {
    if (closed) return;
    const validated = validateCommEnvelope(raw, auth());
    if (!validated.ok) {
      counters.invalid += 1;
      diag("comm_invalid", { reason: validated.reason });
      return;
    }
    const msg = validated.message;
    const seq = Math.floor(Number(msg.seq));
    if (seq <= lastInboundSeq) {
      // Retries reuse envelopes; re-ACK so sender can clear pending.
      if (validated.type === COMM_MESSAGE_TYPE.TEXT) {
        send(COMM_MESSAGE_TYPE.TEXT_ACK, {}, { ackOf: String(msg.msgId || "") });
      } else if (
        validated.type === COMM_MESSAGE_TYPE.VOICE_META ||
        validated.type === COMM_MESSAGE_TYPE.VOICE_CHUNK
      ) {
        const voiceId = String(msg.payload?.voiceId || "");
        if (voiceId) send(COMM_MESSAGE_TYPE.VOICE_ACK, { voiceId }, { ackOf: voiceId });
      }
      diag("comm_duplicate_or_old_seq", { seq, lastInboundSeq });
      return;
    }
    lastInboundSeq = seq;
    counters.received += 1;

    if (
      (validated.type === COMM_MESSAGE_TYPE.TEXT_ACK ||
        validated.type === COMM_MESSAGE_TYPE.VOICE_ACK) &&
      msg.ackOf
    ) {
      clearPendingAckOf(msg.ackOf);
      onAck(msg);
    }

    if (validated.type === COMM_MESSAGE_TYPE.TEXT) {
      send(COMM_MESSAGE_TYPE.TEXT_ACK, {}, { ackOf: String(msg.msgId || "") });
      onText(msg);
    }

    if (validated.type === COMM_MESSAGE_TYPE.VOICE_META) {
      const res = assembler.acceptMeta(msg.payload || {});
      if (res.ok) {
        onVoiceProgress({
          voiceId: res.voiceId,
          progress: assembler.getProgress(res.voiceId)?.progress || 0,
          have: assembler.getProgress(res.voiceId)?.have || 0,
          total: assembler.getProgress(res.voiceId)?.total || 0,
          direction: "in",
        });
        if (res.complete) maybeCompleteVoice(res.voiceId);
      }
    }

    if (validated.type === COMM_MESSAGE_TYPE.VOICE_CHUNK) {
      const res = assembler.acceptChunk(msg.payload || {});
      if (res.ok) {
        onVoiceProgress({
          voiceId: res.voiceId,
          progress: res.progress,
          have: res.have,
          total: res.total,
          direction: "in",
        });
        if (res.complete) maybeCompleteVoice(res.voiceId);
      }
    }

    if (validated.family === "call") {
      void callController?.handleCallMessage?.(msg, validated.type);
      onCall(msg, validated.type);
    }

    onInbound(msg, { family: validated.family || classifyCommMessageType(validated.type) });
  }

  /**
   * @param {string} type
   * @param {object} [payload]
   * @param {{ ackOf?: string, skipPending?: boolean, pendingKey?: string, voiceId?: string, resend?: () => boolean }} [extra]
   */
  function send(type, payload = {}, extra = {}) {
    if (closed) return { ok: false, reason: "closed" };
    if (!transport || typeof transport.send !== "function") {
      return { ok: false, reason: "no_transport" };
    }
    if (typeof transport.isReady === "function" && !transport.isReady()) {
      return { ok: false, reason: "transport_not_ready" };
    }
    outboundSeq += 1;
    const built = buildCommEnvelope({
      type,
      conversationId,
      scope,
      peerSessionId,
      role,
      seq: outboundSeq,
      payload,
      ts: nowMs(),
      ackOf: extra.ackOf,
    });
    if (!built.ok) {
      outboundSeq -= 1;
      return built;
    }
    const needsPending =
      !extra.skipPending &&
      !String(type).endsWith("_ack") &&
      type !== COMM_MESSAGE_TYPE.VOICE_CHUNK;
    if (needsPending) {
      const key = String(extra.pendingKey || built.message.msgId);
      pendingAcks.set(key, {
        serialized: built.serialized,
        type,
        attempts: 0,
        at: nowMs(),
        seq: outboundSeq,
        voiceId: extra.voiceId,
        resend: extra.resend,
      });
      scheduleRetryLoop();
    }
    const ok = Boolean(transport.send(built.serialized));
    if (!ok) {
      counters.sendFail += 1;
      outboundSeq -= 1;
      if (needsPending) pendingAcks.delete(String(extra.pendingKey || built.message.msgId));
      return { ok: false, reason: "send_failed" };
    }
    counters.sent += 1;
    return { ok: true, message: built.message };
  }

  function sendText(body) {
    const text = String(body || "").trim().slice(0, COMM_TEXT_MAX_CHARS);
    if (!text) return { ok: false, reason: "empty" };
    return send(COMM_MESSAGE_TYPE.TEXT, { body: text });
  }

  /**
   * Push-to-talk voice note over P2P (chunked). No Firebase upload.
   * @param {{
   *   bytes?: ArrayBuffer | Uint8Array,
   *   base64?: string,
   *   mimeType?: string,
   *   durationMs?: number,
   * }} input
   */
  function sendVoiceNote(input) {
    const built = buildVoicePayloads(input);
    if (!built.ok) return built;
    if (typeof transport.isReady === "function" && !transport.isReady()) {
      return { ok: false, reason: "transport_not_ready" };
    }

    const { voiceId, meta, chunks } = built;
    const total = chunks.length;

    function emitOutProgress(have) {
      onVoiceProgress({
        voiceId,
        progress: total > 0 ? have / total : 1,
        have,
        total,
        direction: "out",
      });
    }

    function transmitAll() {
      const metaRes = send(COMM_MESSAGE_TYPE.VOICE_META, meta, {
        skipPending: true,
      });
      if (!metaRes.ok) return false;
      for (let i = 0; i < chunks.length; i += 1) {
        const chunkRes = send(COMM_MESSAGE_TYPE.VOICE_CHUNK, chunks[i], {
          skipPending: true,
        });
        if (!chunkRes.ok) return false;
        emitOutProgress(i + 1);
      }
      return true;
    }

    // One pending entry for the whole note (retry resends META+chunks).
    pendingAcks.set(voiceId, {
      serialized: "",
      type: COMM_MESSAGE_TYPE.VOICE_META,
      attempts: 0,
      at: nowMs(),
      seq: outboundSeq + 1,
      voiceId,
      resend: () => transmitAll(),
    });
    scheduleRetryLoop();

    if (!transmitAll()) {
      pendingAcks.delete(voiceId);
      return { ok: false, reason: "send_failed", voiceId };
    }

    counters.voiceSent += 1;
    emitOutProgress(total);
    return {
      ok: true,
      voiceId,
      mimeType: meta.mimeType,
      durationMs: meta.durationMs,
      totalChunks: total,
      totalBytes: meta.totalBytes,
    };
  }

  /**
   * Attach / replace voice-call controller (Phase 4).
   * @param {Parameters<typeof createCallController>[0]} callOpts
   */
  function enableCall(callOpts = {}) {
    callController?.close?.();
    callController = createCallController({
      ...callOpts,
      send: (type, payload, extra) => send(type, payload, { skipPending: true, ...extra }),
      isTransportReady: () =>
        typeof transport?.isReady === "function" ? transport.isReady() : true,
    });
    return callController;
  }

  function getCall() {
    return callController;
  }

  function getState() {
    return {
      conversationId,
      scope,
      role,
      peerSessionId,
      closed,
      outboundSeq,
      lastInboundSeq,
      pendingAckCount: pendingAcks.size,
      counters: { ...counters },
      transportReady: typeof transport?.isReady === "function" ? transport.isReady() : true,
      call: callController?.getState?.() || null,
    };
  }

  function close() {
    closed = true;
    callController?.close?.();
    callController = null;
    unsub();
    unsub = () => {};
    if (retryTimer) clearT(retryTimer);
    retryTimer = 0;
    pendingAcks.clear();
    assembler.clear();
    completedVoices.clear();
  }

  return {
    send,
    sendText,
    sendVoiceNote,
    enableCall,
    getCall,
    handleRaw,
    getState,
    close,
    getPendingAcks: () => new Map(pendingAcks),
    ackTypesFor,
  };
}

/**
 * In-memory loopback transport for unit tests (no WebRTC).
 */
export function createLoopbackTransportPair() {
  /** @type {Set<(raw: string) => void>} */
  const aHandlers = new Set();
  /** @type {Set<(raw: string) => void>} */
  const bHandlers = new Set();
  let ready = true;

  function make(handlers, peerHandlers) {
    return {
      isReady: () => ready,
      setReady: (v) => {
        ready = Boolean(v);
      },
      send(serialized) {
        if (!ready) return false;
        for (const h of peerHandlers) h(String(serialized));
        return true;
      },
      subscribe(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    };
  }

  return {
    a: make(aHandlers, bHandlers),
    b: make(bHandlers, aHandlers),
  };
}
