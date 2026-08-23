/**
 * P2P Communication module — Driver↔Customer (Phase 3: text + voice notes).
 * Reuses existing WebRTC DataChannel via CommTransport from peer session.
 * No Firebase message/media storage.
 */

import {
  COMM_SCOPE,
  COMM_ROLE,
  COMM_MESSAGE_TYPE,
  buildRideConversationId,
} from "./p2p-comm-protocol.mjs";
import { createConversationSession } from "./p2p-comm-session.mjs";
import { createCommRouter } from "./p2p-comm-router.mjs";
import { createRideCommChat, createCommPanel } from "./p2p-comm-panel.mjs";

/**
 * @param {{
 *   role: "driver"|"customer",
 *   rideId?: string,
 *   peerSessionId?: string,
 *   transport?: import("./p2p-comm-session.mjs").CommTransport,
 *   getTransport?: () => import("./p2p-comm-session.mjs").CommTransport | null,
 *   scope?: string,
 *   conversationId?: string,
 *   contactHost?: HTMLElement | null,
 *   mountHost?: HTMLElement | null,
 *   onText?: (msg: object) => void,
 *   onVoice?: (msg: object) => void,
 *   onCall?: (msg: object) => void,
 *   onDiag?: (code: string, detail?: object) => void,
 * }} opts
 */
export function createP2pCommModule(opts) {
  const role = opts.role === "customer" ? COMM_ROLE.CUSTOMER : COMM_ROLE.DRIVER;
  const scope = opts.scope || COMM_SCOPE.RIDE;
  let conversationId = String(opts.conversationId || "").trim();
  if (!conversationId && opts.rideId) {
    const built = buildRideConversationId({
      rideId: opts.rideId,
      peerSessionId: opts.peerSessionId,
    });
    if (built.ok) conversationId = built.conversationId;
  }
  if (!conversationId) {
    return {
      ok: false,
      reason: "missing_conversation_id",
      attachPlaceholder() {},
      attachContactUi() {},
      sendText: () => ({ ok: false, reason: "missing_conversation_id" }),
      sendVoiceNote: () => ({ ok: false, reason: "missing_conversation_id" }),
      destroy() {},
      getState: () => ({ ok: false }),
    };
  }

  const router = createCommRouter({
    conversationId,
    expectRole: role === COMM_ROLE.CUSTOMER ? COMM_ROLE.DRIVER : COMM_ROLE.CUSTOMER,
    onText: opts.onText,
    onVoice: opts.onVoice,
    onCall: opts.onCall,
  });

  function resolveTransport() {
    if (typeof opts.getTransport === "function") return opts.getTransport() || null;
    return opts.transport || null;
  }

  let session = null;
  let chat = null;

  function ensureSession() {
    const transport = resolveTransport();
    if (!transport) return null;
    if (session && !session.getState().closed) return session;
    session?.close?.();
    session = createConversationSession({
      conversationId,
      scope,
      role,
      peerSessionId: opts.peerSessionId,
      transport,
      onDiag: opts.onDiag,
      onText: (msg) => {
        router.route(msg);
      },
      onVoice: (note) => {
        opts.onVoice?.(note);
      },
      onInbound: (msg) => {
        if (
          msg.type === COMM_MESSAGE_TYPE.TEXT ||
          msg.type === COMM_MESSAGE_TYPE.TEXT_ACK ||
          msg.type === COMM_MESSAGE_TYPE.VOICE_META ||
          msg.type === COMM_MESSAGE_TYPE.VOICE_CHUNK ||
          msg.type === COMM_MESSAGE_TYPE.VOICE_ACK
        ) {
          return;
        }
        router.route(msg);
      },
    });
    return session;
  }

  ensureSession();

  function attachContactUi({ contactHost, mountHost } = {}) {
    if (chat) {
      chat.destroy();
      chat = null;
    }
    const rideId = String(opts.rideId || conversationId.replace(/^ride:/, "").split(":")[0] || "");
    chat = createRideCommChat({
      role,
      rideId,
      peerSessionId: opts.peerSessionId,
      getTransport: resolveTransport,
      contactHost: contactHost || opts.contactHost || null,
      mountHost: mountHost || opts.mountHost || null,
    });
    return chat;
  }

  function attachPlaceholder(host) {
    if (!host || typeof host.appendChild !== "function") return;
    if (host.querySelector?.("[data-swiftgo-comm-placeholder]")) return;
    const doc = typeof document !== "undefined" ? document : null;
    const el = doc?.createElement?.("div") || {
      hidden: true,
      setAttribute(k, v) {
        this[k] = v;
      },
    };
    el.hidden = true;
    el.setAttribute("data-swiftgo-comm-placeholder", "1");
    el.setAttribute("data-conversation-id", conversationId);
    el.setAttribute("aria-hidden", "true");
    host.appendChild(el);
  }

  function sendText(body) {
    const s = ensureSession();
    if (!s) return { ok: false, reason: "no_transport" };
    return s.sendText(body);
  }

  function sendVoiceNote(input) {
    const s = ensureSession();
    if (!s) return { ok: false, reason: "no_transport" };
    return s.sendVoiceNote(input);
  }

  function getState() {
    return {
      ok: true,
      conversationId,
      scope,
      role,
      hasTransport: Boolean(resolveTransport()),
      session: session?.getState?.() || chat?.ensureSession?.()?.getState?.() || null,
      hasUi: Boolean(chat),
    };
  }

  function destroy() {
    chat?.destroy?.();
    chat = null;
    session?.close?.();
    session = null;
  }

  return {
    ok: true,
    conversationId,
    get session() {
      return session || chat?.ensureSession?.() || null;
    },
    router,
    COMM_MESSAGE_TYPE,
    attachPlaceholder,
    attachContactUi,
    sendText,
    sendVoiceNote,
    refresh: () => {
      ensureSession();
      chat?.refresh?.();
    },
    getState,
    destroy,
  };
}

export {
  COMM_SCOPE,
  COMM_ROLE,
  COMM_MESSAGE_TYPE,
  buildRideConversationId,
} from "./p2p-comm-protocol.mjs";
export {
  createConversationSession,
  createLoopbackTransportPair,
  COMM_TEXT_MAX_CHARS,
  COMM_ACK_RETRY_MS,
  COMM_ACK_MAX_RETRIES,
  COMM_VOICE_MAX_MS,
  COMM_VOICE_MAX_BYTES,
  COMM_VOICE_CHUNK_CHARS,
} from "./p2p-comm-session.mjs";
export {
  buildVoicePayloads,
  chunkBase64,
  assembleBase64Chunks,
  createVoiceAssembler,
  bytesToBase64,
  base64ToBytes,
} from "./p2p-comm-voice.mjs";
export {
  createCallController,
  createFakeMediaBridge,
  CALL_STATE,
} from "./p2p-comm-call.mjs";
export { createCommRouter } from "./p2p-comm-router.mjs";
export { createCommPanel, createRideCommChat } from "./p2p-comm-panel.mjs";
