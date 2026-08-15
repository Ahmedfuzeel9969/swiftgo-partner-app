/**
 * P2P voice-note helpers — chunk / assemble base64 audio for DataChannel.
 * No Firebase media transfer.
 */

import { COMM_MAX_ENVELOPE_BYTES } from "./p2p-comm-protocol.mjs";

/** Max recorded note length. */
export const COMM_VOICE_MAX_MS = 60_000;
/** Soft cap on decoded audio bytes (~200 KB). */
export const COMM_VOICE_MAX_BYTES = 200_000;
/**
 * Base64 payload chars per chunk (leave headroom for envelope JSON).
 * Keep well under COMM_MAX_ENVELOPE_BYTES.
 */
export const COMM_VOICE_CHUNK_CHARS = 6_000;

function newVoiceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `vv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }
  return `vv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {ArrayBuffer | Uint8Array | string} input
 * @returns {string} base64
 */
export function bytesToBase64(input) {
  if (typeof input === "string") return input;
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : null;
  if (!bytes) return "";
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  const s = String(b64 || "");
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Split base64 into DC-safe chunks.
 * @param {string} base64
 * @param {number} [chunkChars]
 */
export function chunkBase64(base64, chunkChars = COMM_VOICE_CHUNK_CHARS) {
  const s = String(base64 || "");
  const size = Math.max(256, Math.floor(Number(chunkChars) || COMM_VOICE_CHUNK_CHARS));
  /** @type {string[]} */
  const parts = [];
  for (let i = 0; i < s.length; i += size) {
    parts.push(s.slice(i, i + size));
  }
  return parts.length ? parts : [""];
}

/**
 * @param {string[]} chunks
 */
export function assembleBase64Chunks(chunks) {
  return (chunks || []).map((c) => String(c || "")).join("");
}

/**
 * Build META + CHUNK payloads for a voice note (does not send).
 * @param {{
 *   bytes?: ArrayBuffer | Uint8Array,
 *   base64?: string,
 *   mimeType?: string,
 *   durationMs?: number,
 *   voiceId?: string,
 * }} input
 */
export function buildVoicePayloads(input) {
  const mimeType = String(input?.mimeType || "audio/webm").slice(0, 64);
  const durationMs = Math.max(0, Math.min(COMM_VOICE_MAX_MS, Math.round(Number(input?.durationMs) || 0)));
  const base64 = input?.base64 != null ? String(input.base64) : bytesToBase64(input?.bytes || new Uint8Array());
  if (!base64) return { ok: false, reason: "empty_audio" };
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > COMM_VOICE_MAX_BYTES) return { ok: false, reason: "too_large" };

  const parts = chunkBase64(base64);
  // Ensure a single chunk envelope would still fit (sanity for custom chunk sizes).
  const probe = JSON.stringify({
    type: "comm_voice_chunk",
    payload: { voiceId: "x".repeat(24), index: 0, total: parts.length, data: parts[0] },
  });
  if (probe.length > COMM_MAX_ENVELOPE_BYTES - 400) {
    return { ok: false, reason: "chunk_too_large" };
  }

  const voiceId = String(input?.voiceId || newVoiceId());
  const meta = {
    voiceId,
    mimeType,
    durationMs,
    totalChunks: parts.length,
    totalBytes: approxBytes,
  };
  const chunks = parts.map((data, index) => ({
    voiceId,
    index,
    total: parts.length,
    data,
  }));
  return { ok: true, voiceId, meta, chunks, base64 };
}

/**
 * In-memory assembler for inbound voice chunks.
 */
export function createVoiceAssembler() {
  /** @type {Map<string, { meta: object|null, chunks: Map<number, string>, total: number }>} */
  const pending = new Map();

  function ensure(voiceId) {
    let row = pending.get(voiceId);
    if (!row) {
      row = { meta: null, chunks: new Map(), total: 0 };
      pending.set(voiceId, row);
    }
    return row;
  }

  /**
   * @param {object} metaPayload
   */
  function acceptMeta(metaPayload) {
    const voiceId = String(metaPayload?.voiceId || "");
    if (!voiceId) return { ok: false, reason: "missing_voice_id" };
    const total = Math.floor(Number(metaPayload.totalChunks) || 0);
    if (total < 1 || total > 500) return { ok: false, reason: "invalid_total" };
    const row = ensure(voiceId);
    row.meta = { ...metaPayload, voiceId, totalChunks: total };
    row.total = total;
    return { ok: true, voiceId, complete: row.chunks.size >= total && total > 0 };
  }

  /**
   * @param {object} chunkPayload
   */
  function acceptChunk(chunkPayload) {
    const voiceId = String(chunkPayload?.voiceId || "");
    if (!voiceId) return { ok: false, reason: "missing_voice_id" };
    const index = Math.floor(Number(chunkPayload.index));
    const total = Math.floor(Number(chunkPayload.total) || 0);
    if (!Number.isFinite(index) || index < 0) return { ok: false, reason: "invalid_index" };
    const row = ensure(voiceId);
    if (total > 0) row.total = total;
    if (!row.meta) {
      row.meta = {
        voiceId,
        mimeType: "audio/webm",
        durationMs: 0,
        totalChunks: total,
        totalBytes: 0,
      };
    }
    row.chunks.set(index, String(chunkPayload.data || ""));
    const have = row.chunks.size;
    const need = row.total || total;
    return {
      ok: true,
      voiceId,
      have,
      total: need,
      progress: need > 0 ? have / need : 0,
      complete: need > 0 && have >= need,
    };
  }

  /**
   * @param {string} voiceId
   */
  function finalize(voiceId) {
    const row = pending.get(voiceId);
    if (!row) return { ok: false, reason: "unknown_voice" };
    const total = row.total || Number(row.meta?.totalChunks) || 0;
    if (total < 1 || row.chunks.size < total) {
      return { ok: false, reason: "incomplete", have: row.chunks.size, total };
    }
    /** @type {string[]} */
    const ordered = [];
    for (let i = 0; i < total; i += 1) {
      if (!row.chunks.has(i)) return { ok: false, reason: "missing_chunk", index: i };
      ordered.push(row.chunks.get(i) || "");
    }
    const base64 = assembleBase64Chunks(ordered);
    const mimeType = String(row.meta?.mimeType || "audio/webm");
    const durationMs = Math.round(Number(row.meta?.durationMs) || 0);
    pending.delete(voiceId);
    return {
      ok: true,
      voiceId,
      mimeType,
      durationMs,
      base64,
      bytes: base64ToBytes(base64),
      totalChunks: total,
    };
  }

  function getProgress(voiceId) {
    const row = pending.get(voiceId);
    if (!row) return null;
    const total = row.total || Number(row.meta?.totalChunks) || 0;
    return { have: row.chunks.size, total, progress: total > 0 ? row.chunks.size / total : 0 };
  }

  function clear(voiceId) {
    if (voiceId) pending.delete(String(voiceId));
    else pending.clear();
  }

  return { acceptMeta, acceptChunk, finalize, getProgress, clear };
}
