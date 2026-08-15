/**
 * Message router — demux validated comm envelopes by family for future handlers.
 */

import { classifyCommMessageType, validateCommEnvelope } from "./p2p-comm-protocol.mjs";

/**
 * @param {{
 *   onText?: (msg: object) => void,
 *   onVoice?: (msg: object) => void,
 *   onCall?: (msg: object) => void,
 *   onControl?: (msg: object) => void,
 *   onUnknown?: (msg: object, family: string) => void,
 *   conversationId?: string,
 *   expectRole?: string,
 * }} [opts]
 */
export function createCommRouter(opts = {}) {
  const onText = opts.onText || (() => {});
  const onVoice = opts.onVoice || (() => {});
  const onCall = opts.onCall || (() => {});
  const onControl = opts.onControl || (() => {});
  const onUnknown = opts.onUnknown || (() => {});

  /**
   * @param {string|object} raw
   */
  function route(raw) {
    const validated = validateCommEnvelope(raw, {
      conversationId: opts.conversationId,
      expectRole: opts.expectRole,
    });
    if (!validated.ok) return { ok: false, reason: validated.reason };
    const family = validated.family || classifyCommMessageType(validated.type);
    const msg = validated.message;
    if (family === "text") onText(msg);
    else if (family === "voice") onVoice(msg);
    else if (family === "call") onCall(msg);
    else if (family === "control") onControl(msg);
    else onUnknown(msg, family);
    return { ok: true, family, type: validated.type, message: msg };
  }

  return { route };
}
