/**
 * P2P Communication protocol — Driver↔Customer (ride) + future Contacts.
 * Transport-agnostic envelope; Phase 2+ bind to existing WebRTC DataChannel.
 * Does not alter location LOC/ACK/HB envelopes.
 */

export const COMM_PROTOCOL_VERSION = 1;

/** Who the conversation belongs to. */
export const COMM_SCOPE = Object.freeze({
  RIDE: "ride",
  CONTACT: "contact",
});

/**
 * Message types reserved for chat / voice / call (Phase 2–4).
 * Prefixed so they never collide with location types (loc/ack/hb/close).
 */
export const COMM_MESSAGE_TYPE = Object.freeze({
  TEXT: "comm_text",
  TEXT_ACK: "comm_text_ack",
  VOICE_META: "comm_voice_meta",
  VOICE_CHUNK: "comm_voice_chunk",
  VOICE_ACK: "comm_voice_ack",
  CALL_OFFER: "comm_call_offer",
  CALL_ANSWER: "comm_call_answer",
  CALL_REJECT: "comm_call_reject",
  CALL_END: "comm_call_end",
  CALL_ICE: "comm_call_ice",
  PING: "comm_ping",
  PONG: "comm_pong",
});

export const COMM_ROLE = Object.freeze({
  DRIVER: "driver",
  CUSTOMER: "customer",
});

/** Soft cap for a single JSON envelope (location channel uses 2048; comm may chunk). */
export const COMM_MAX_ENVELOPE_BYTES = 12_000;
/** Call renegotiation SDP envelopes need more room (still P2P-only, no Firebase). */
export const COMM_MAX_CALL_ENVELOPE_BYTES = 24_000;

const TYPE_SET = new Set(Object.values(COMM_MESSAGE_TYPE));
const SCOPE_SET = new Set(Object.values(COMM_SCOPE));

function maxBytesForType(type) {
  const t = String(type || "");
  if (t.startsWith("comm_call_")) return COMM_MAX_CALL_ENVELOPE_BYTES;
  return COMM_MAX_ENVELOPE_BYTES;
}

/**
 * @param {string} type
 */
export function isCommMessageType(type) {
  return TYPE_SET.has(String(type || ""));
}

/**
 * @param {string} type
 * @returns {"text"|"voice"|"call"|"control"|"unknown"}
 */
export function classifyCommMessageType(type) {
  const t = String(type || "");
  if (t === COMM_MESSAGE_TYPE.TEXT || t === COMM_MESSAGE_TYPE.TEXT_ACK) return "text";
  if (
    t === COMM_MESSAGE_TYPE.VOICE_META ||
    t === COMM_MESSAGE_TYPE.VOICE_CHUNK ||
    t === COMM_MESSAGE_TYPE.VOICE_ACK
  ) {
    return "voice";
  }
  if (
    t === COMM_MESSAGE_TYPE.CALL_OFFER ||
    t === COMM_MESSAGE_TYPE.CALL_ANSWER ||
    t === COMM_MESSAGE_TYPE.CALL_REJECT ||
    t === COMM_MESSAGE_TYPE.CALL_END ||
    t === COMM_MESSAGE_TYPE.CALL_ICE
  ) {
    return "call";
  }
  if (t === COMM_MESSAGE_TYPE.PING || t === COMM_MESSAGE_TYPE.PONG) return "control";
  return "unknown";
}

/**
 * Build a conversation id for ride-scoped Driver↔Customer chat.
 * @param {{ rideId: string, peerSessionId?: string }} input
 */
export function buildRideConversationId(input) {
  const rideId = String(input?.rideId || "").trim();
  if (!rideId) return { ok: false, reason: "missing_ride_id" };
  const peer = String(input?.peerSessionId || "").trim();
  const id = peer ? `ride:${rideId}:${peer}` : `ride:${rideId}`;
  return { ok: true, conversationId: id, scope: COMM_SCOPE.RIDE };
}

/**
 * Future Contacts conversation id (not used in Phase 1 UI).
 * @param {{ contactId: string, localUid: string }} input
 */
export function buildContactConversationId(input) {
  const a = String(input?.localUid || "").trim();
  const b = String(input?.contactId || "").trim();
  if (!a || !b) return { ok: false, reason: "missing_ids" };
  const [x, y] = [a, b].sort();
  return { ok: true, conversationId: `contact:${x}:${y}`, scope: COMM_SCOPE.CONTACT };
}

function newMsgId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `cm_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }
  return `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {{
 *   type: string,
 *   conversationId: string,
 *   scope?: string,
 *   peerSessionId?: string,
 *   role: string,
 *   seq: number,
 *   payload?: object,
 *   msgId?: string,
 *   ts?: number,
 *   ackOf?: string,
 * }} input
 */
export function buildCommEnvelope(input) {
  const type = String(input?.type || "");
  if (!isCommMessageType(type)) return { ok: false, reason: "unknown_type" };
  const conversationId = String(input?.conversationId || "").trim();
  if (conversationId.length < 4 || conversationId.length > 160) {
    return { ok: false, reason: "invalid_conversation_id" };
  }
  const scope = String(input?.scope || COMM_SCOPE.RIDE);
  if (!SCOPE_SET.has(scope)) return { ok: false, reason: "invalid_scope" };
  const role = String(input?.role || "");
  if (role !== COMM_ROLE.DRIVER && role !== COMM_ROLE.CUSTOMER) {
    return { ok: false, reason: "invalid_role" };
  }
  const seq = Math.floor(Number(input?.seq));
  if (!Number.isFinite(seq) || seq < 1) return { ok: false, reason: "invalid_seq" };
  const ts = Number.isFinite(Number(input?.ts)) ? Number(input.ts) : Date.now();
  const msgId = String(input?.msgId || newMsgId());
  const envelope = {
    v: COMM_PROTOCOL_VERSION,
    type,
    scope,
    conversationId,
    peerSessionId: String(input?.peerSessionId || ""),
    role,
    seq,
    msgId,
    ts,
    payload: input?.payload && typeof input.payload === "object" ? input.payload : {},
  };
  if (input?.ackOf) envelope.ackOf = String(input.ackOf);
  const serialized = JSON.stringify(envelope);
  if (serialized.length > maxBytesForType(type)) {
    return { ok: false, reason: "oversized" };
  }
  return { ok: true, message: envelope, serialized };
}

/**
 * @param {string|object} raw
 * @param {{ conversationId?: string, expectRole?: string, closed?: boolean }} [auth]
 */
export function validateCommEnvelope(raw, auth = {}) {
  if (auth.closed) return { ok: false, reason: "session_closed" };
  let obj = raw;
  if (typeof raw === "string") {
    const typeHint = raw.includes('"comm_call_') ? COMM_MAX_CALL_ENVELOPE_BYTES : COMM_MAX_ENVELOPE_BYTES;
    if (raw.length > typeHint) return { ok: false, reason: "oversized" };
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "json_parse" };
    }
  }
  if (!obj || typeof obj !== "object") return { ok: false, reason: "not_object" };
  if (Number(obj.v) !== COMM_PROTOCOL_VERSION) return { ok: false, reason: "unknown_protocol" };
  if (!isCommMessageType(obj.type)) return { ok: false, reason: "unknown_type" };
  if (!SCOPE_SET.has(String(obj.scope || ""))) return { ok: false, reason: "invalid_scope" };
  const conversationId = String(obj.conversationId || "");
  if (conversationId.length < 4) return { ok: false, reason: "invalid_conversation_id" };
  if (auth.conversationId && conversationId !== String(auth.conversationId)) {
    return { ok: false, reason: "wrong_conversation" };
  }
  if (auth.expectRole && String(obj.role || "") !== auth.expectRole) {
    return { ok: false, reason: "unexpected_role" };
  }
  const seq = Math.floor(Number(obj.seq));
  if (!Number.isFinite(seq) || seq < 1) return { ok: false, reason: "invalid_seq" };
  const ts = Number(obj.ts);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_ts" };
  const msgId = String(obj.msgId || "");
  if (!msgId) return { ok: false, reason: "missing_msg_id" };
  return {
    ok: true,
    type: String(obj.type),
    family: classifyCommMessageType(obj.type),
    message: obj,
  };
}
