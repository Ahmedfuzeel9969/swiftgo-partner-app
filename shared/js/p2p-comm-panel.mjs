/**
 * Shared Contact chat panel — identical Driver / Customer interface.
 * Phase 2 text + Phase 3 push-to-talk voice. No Firebase storage.
 */

import {
  COMM_TEXT_MAX_CHARS,
  COMM_VOICE_MAX_MS,
  createConversationSession,
} from "./p2p-comm-session.mjs";
import { buildRideConversationId } from "./p2p-comm-protocol.mjs";
import { base64ToBytes } from "./p2p-comm-voice.mjs";

/**
 * @param {{
 *   root?: HTMLElement | null,
 *   title?: string,
 *   onSend?: (text: string) => void,
 *   onVoiceRecorded?: (note: { base64: string, mimeType: string, durationMs: number, bytes: Uint8Array }) => void,
 *   onStartCall?: () => void,
 *   onAcceptCall?: () => void,
 *   onRejectCall?: () => void,
 *   onEndCall?: () => void,
 *   onToggleMute?: () => void,
 *   onToggleSpeaker?: () => void,
 *   onOpen?: () => void,
 *   onClose?: () => void,
 * }} opts
 */
export function createCommPanel(opts = {}) {
  const doc = typeof document !== "undefined" ? document : null;
  if (!doc) {
    return {
      mount() {},
      mountContactInto() {},
      open() {},
      close() {},
      toggle() {},
      appendMessage() {},
      appendVoiceMessage() {},
      updateMessageStatus() {},
      updateVoiceProgress() {},
      setCallUi() {},
      setStatus() {},
      setContactVisible() {},
      setTitle() {},
      destroy() {},
      getContactButton: () => null,
      getRoot: () => null,
    };
  }

  const title = opts.title || "Contact";
  let openState = false;
  /** @type {MediaRecorder | null} */
  let recorder = null;
  /** @type {MediaStream | null} */
  let mediaStream = null;
  /** @type {Blob[]} */
  let recChunks = [];
  let recStartedAt = 0;
  let recTimer = 0;

  const wrap = doc.createElement("div");
  wrap.className = "swiftgo-comm";
  wrap.innerHTML = `
    <button type="button" class="swiftgo-comm__contact-btn" data-comm-contact hidden>Contact</button>
    <div class="swiftgo-comm__panel" data-comm-panel hidden>
      <header class="swiftgo-comm__head">
        <strong data-comm-title>${title}</strong>
        <button type="button" class="swiftgo-comm__close" data-comm-close aria-label="Close">×</button>
      </header>
      <p class="swiftgo-comm__status" data-comm-status>P2P</p>
      <div class="swiftgo-comm__callbar" data-comm-callbar hidden>
        <span data-comm-call-label>Call</span>
        <div class="swiftgo-comm__call-actions">
          <button type="button" data-comm-call-accept hidden>Accept</button>
          <button type="button" data-comm-call-reject hidden>Reject</button>
          <button type="button" data-comm-call-mute hidden>Mute</button>
          <button type="button" data-comm-call-speaker hidden>Speaker</button>
          <button type="button" data-comm-call-end hidden>End</button>
        </div>
      </div>
      <div class="swiftgo-comm__list" data-comm-list role="log" aria-live="polite"></div>
      <form class="swiftgo-comm__form" data-comm-form>
        <input type="text" class="swiftgo-comm__input" data-comm-input maxlength="${COMM_TEXT_MAX_CHARS}" placeholder="Message…" autocomplete="off" />
        <button type="submit" class="swiftgo-comm__send">Send</button>
        <button type="button" class="swiftgo-comm__ptt" data-comm-ptt aria-label="Hold to talk">🎙</button>
        <button type="button" class="swiftgo-comm__call" data-comm-call aria-label="Voice call">📞</button>
      </form>
      <p class="swiftgo-comm__rec" data-comm-rec hidden>Recording…</p>
    </div>
  `;

  const contactBtn = /** @type {HTMLButtonElement | null} */ (wrap.querySelector("[data-comm-contact]"));
  const panel = /** @type {HTMLElement | null} */ (wrap.querySelector("[data-comm-panel]"));
  const list = /** @type {HTMLElement | null} */ (wrap.querySelector("[data-comm-list]"));
  const form = /** @type {HTMLFormElement | null} */ (wrap.querySelector("[data-comm-form]"));
  const input = /** @type {HTMLInputElement | null} */ (wrap.querySelector("[data-comm-input]"));
  const statusEl = /** @type {HTMLElement | null} */ (wrap.querySelector("[data-comm-status]"));
  const titleEl = /** @type {HTMLElement | null} */ (wrap.querySelector("[data-comm-title]"));
  const pttBtn = /** @type {HTMLButtonElement | null} */ (wrap.querySelector("[data-comm-ptt]"));
  const callBtn = /** @type {HTMLButtonElement | null} */ (wrap.querySelector("[data-comm-call]"));
  const callBar = /** @type {HTMLElement | null} */ (wrap.querySelector("[data-comm-callbar]"));
  const callLabel = /** @type {HTMLElement | null} */ (wrap.querySelector("[data-comm-call-label]"));
  const btnAccept = /** @type {HTMLButtonElement | null} */ (wrap.querySelector("[data-comm-call-accept]"));
  const btnReject = /** @type {HTMLButtonElement | null} */ (wrap.querySelector("[data-comm-call-reject]"));
  const btnMute = /** @type {HTMLButtonElement | null} */ (wrap.querySelector("[data-comm-call-mute]"));
  const btnSpeaker = /** @type {HTMLButtonElement | null} */ (wrap.querySelector("[data-comm-call-speaker]"));
  const btnEnd = /** @type {HTMLButtonElement | null} */ (wrap.querySelector("[data-comm-call-end]"));
  const recEl = /** @type {HTMLElement | null} */ (wrap.querySelector("[data-comm-rec]"));

  function ensureStyles() {
    if (doc.getElementById("swiftgo-comm-styles")) return;
    const style = doc.createElement("style");
    style.id = "swiftgo-comm-styles";
    style.textContent = `
      .swiftgo-comm__contact-btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:.55rem 1rem;border:0;border-radius:12px;background:#0b7a4b;color:#fff;font-weight:700;cursor:pointer}
      .swiftgo-comm__panel{position:fixed;z-index:12000;left:0;right:0;bottom:0;max-height:min(70vh,520px);display:flex;flex-direction:column;background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -8px 28px rgba(0,0,0,.18)}
      .swiftgo-comm__panel[hidden]{display:none!important}
      .swiftgo-comm__head{display:flex;align-items:center;justify-content:space-between;padding:.85rem 1rem;border-bottom:1px solid #e5ebe8}
      .swiftgo-comm__close{border:0;background:transparent;font-size:1.4rem;line-height:1;cursor:pointer}
      .swiftgo-comm__status{margin:0;padding:.35rem 1rem;font-size:.75rem;color:#64748b}
      .swiftgo-comm__list{flex:1;overflow:auto;padding:.5rem 1rem;display:flex;flex-direction:column;gap:.45rem}
      .swiftgo-comm__bubble{max-width:85%;padding:.55rem .7rem;border-radius:12px;font-size:.9rem;line-height:1.35;word-break:break-word}
      .swiftgo-comm__bubble--mine{align-self:flex-end;background:#dcf8c6}
      .swiftgo-comm__bubble--theirs{align-self:flex-start;background:#f1f5f9}
      .swiftgo-comm__meta{display:block;margin-top:.25rem;font-size:.65rem;opacity:.7}
      .swiftgo-comm__form{display:flex;gap:.45rem;padding:.75rem 1rem .35rem;border-top:1px solid #e5ebe8;align-items:center}
      .swiftgo-comm__input{flex:1;min-width:0;border:1px solid #cbd5e1;border-radius:10px;padding:.55rem .7rem}
      .swiftgo-comm__send{border:0;border-radius:10px;padding:.55rem .9rem;background:#0b7a4b;color:#fff;font-weight:700;cursor:pointer}
      .swiftgo-comm__ptt{border:0;border-radius:10px;min-width:44px;min-height:42px;background:#0f172a;color:#fff;cursor:pointer;font-size:1.1rem;touch-action:none;user-select:none}
      .swiftgo-comm__ptt.is-recording{background:#b91c1c}
      .swiftgo-comm__rec{margin:0;padding:0 1rem calc(.65rem + env(safe-area-inset-bottom,0px));font-size:.75rem;color:#b91c1c;font-weight:700}
      .swiftgo-comm__voice{display:flex;flex-direction:column;gap:.35rem;min-width:160px}
      .swiftgo-comm__voice-row{display:flex;align-items:center;gap:.45rem}
      .swiftgo-comm__play{border:0;border-radius:999px;width:34px;height:34px;background:#0b7a4b;color:#fff;cursor:pointer;font-size:.85rem}
      .swiftgo-comm__bar{flex:1;height:6px;border-radius:999px;background:#cbd5e1;overflow:hidden}
      .swiftgo-comm__bar>i{display:block;height:100%;width:0;background:#0b7a4b;border-radius:999px}
      .swiftgo-comm__dur{font-size:.7rem;opacity:.75;min-width:2.5rem;text-align:end}
      .swiftgo-comm__call{border:0;border-radius:10px;min-width:44px;min-height:42px;background:#0369a1;color:#fff;cursor:pointer;font-size:1.05rem}
      .swiftgo-comm__callbar{display:flex;flex-direction:column;gap:.45rem;padding:.55rem 1rem;background:#0f172a;color:#fff}
      .swiftgo-comm__callbar[hidden]{display:none!important}
      .swiftgo-comm__call-actions{display:flex;flex-wrap:wrap;gap:.4rem}
      .swiftgo-comm__call-actions button{border:0;border-radius:8px;padding:.4rem .7rem;font-weight:700;cursor:pointer;background:#e2e8f0;color:#0f172a}
      .swiftgo-comm__call-actions [data-comm-call-end],.swiftgo-comm__call-actions [data-comm-call-reject]{background:#b91c1c;color:#fff}
      .swiftgo-comm__call-actions [data-comm-call-accept]{background:#0b7a4b;color:#fff}
    `;
    doc.head.appendChild(style);
  }

  function open() {
    openState = true;
    if (panel) panel.hidden = false;
    opts.onOpen?.();
    input?.focus?.();
  }
  function close() {
    openState = false;
    if (panel) panel.hidden = true;
    void stopRecording({ cancel: true });
    opts.onClose?.();
  }
  function toggle() {
    if (openState) close();
    else open();
  }

  function appendMessage({ body, mine, ts, status, id }) {
    if (!list) return;
    const row = doc.createElement("div");
    row.className = `swiftgo-comm__bubble ${mine ? "swiftgo-comm__bubble--mine" : "swiftgo-comm__bubble--theirs"}`;
    if (id) row.dataset.msgId = String(id);
    const time = Number.isFinite(ts) ? new Date(ts).toLocaleTimeString() : "";
    row.innerHTML = `<span data-comm-body>${escapeHtml(String(body || ""))}</span><span class="swiftgo-comm__meta" data-comm-meta>${escapeHtml(time)}${status ? ` · ${escapeHtml(status)}` : ""}</span>`;
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
    return row;
  }

  /**
   * @param {{
   *   voiceId: string,
   *   mine?: boolean,
   *   ts?: number,
   *   status?: string,
   *   durationMs?: number,
   *   mimeType?: string,
   *   base64?: string,
   *   progress?: number,
   * }} info
   */
  function appendVoiceMessage(info) {
    if (!list) return null;
    const id = String(info.voiceId || "");
    let row = id ? list.querySelector(`[data-msg-id="${CSS.escape(id)}"]`) : null;
    if (!row) {
      row = doc.createElement("div");
      row.className = `swiftgo-comm__bubble ${info.mine ? "swiftgo-comm__bubble--mine" : "swiftgo-comm__bubble--theirs"}`;
      if (id) row.dataset.msgId = id;
      row.innerHTML = `
        <div class="swiftgo-comm__voice" data-comm-voice>
          <div class="swiftgo-comm__voice-row">
            <button type="button" class="swiftgo-comm__play" data-comm-play aria-label="Play">▶</button>
            <div class="swiftgo-comm__bar" data-comm-bar><i data-comm-fill></i></div>
            <span class="swiftgo-comm__dur" data-comm-dur>0:00</span>
          </div>
        </div>
        <span class="swiftgo-comm__meta" data-comm-meta></span>`;
      list.appendChild(row);
      const playBtn = row.querySelector("[data-comm-play]");
      playBtn?.addEventListener("click", () => playVoiceRow(/** @type {HTMLElement} */ (row)));
    }
    if (info.base64) row.dataset.base64 = info.base64;
    if (info.mimeType) row.dataset.mime = info.mimeType;
    if (Number.isFinite(info.durationMs)) row.dataset.durationMs = String(info.durationMs);
    const durEl = row.querySelector("[data-comm-dur]");
    if (durEl) durEl.textContent = formatDur(Number(info.durationMs) || 0);
    updateMessageStatus(id, info.status || "", info.ts);
    if (Number.isFinite(info.progress)) updateVoiceProgress(id, Number(info.progress));
    list.scrollTop = list.scrollHeight;
    return row;
  }

  function updateMessageStatus(id, status, ts) {
    if (!list || !id) return;
    const row = list.querySelector(`[data-msg-id="${CSS.escape(String(id))}"]`);
    if (!row) return;
    const meta = row.querySelector("[data-comm-meta]");
    if (!meta) return;
    const time = Number.isFinite(ts) ? new Date(ts).toLocaleTimeString() : "";
    meta.textContent = `${time}${status ? ` · ${status}` : ""}`;
  }

  function updateVoiceProgress(id, progress) {
    if (!list || !id) return;
    const row = list.querySelector(`[data-msg-id="${CSS.escape(String(id))}"]`);
    const fill = row?.querySelector("[data-comm-fill]");
    if (!fill) return;
    const pct = Math.max(0, Math.min(1, Number(progress) || 0)) * 100;
    /** @type {HTMLElement} */ (fill).style.width = `${pct}%`;
  }

  function playVoiceRow(row) {
    const b64 = row.dataset.base64;
    const mime = row.dataset.mime || "audio/webm";
    if (!b64) {
      setStatus("Voice not ready");
      return;
    }
    try {
      const bytes = base64ToBytes(b64);
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      const fill = row.querySelector("[data-comm-fill]");
      audio.addEventListener("timeupdate", () => {
        if (!fill || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
        /** @type {HTMLElement} */ (fill).style.width = `${(audio.currentTime / audio.duration) * 100}%`;
      });
      audio.addEventListener("ended", () => {
        if (fill) /** @type {HTMLElement} */ (fill).style.width = "100%";
        URL.revokeObjectURL(url);
      });
      void audio.play();
    } catch {
      setStatus("Playback failed");
    }
  }

  function setCallUi(info = {}) {
    const st = String(info.state || "idle");
    const showBar = st === "outgoing" || st === "incoming" || st === "active";
    if (callBar) callBar.hidden = !showBar;
    if (callLabel) {
      if (st === "outgoing") callLabel.textContent = "Calling…";
      else if (st === "incoming") callLabel.textContent = "Incoming call";
      else if (st === "active") callLabel.textContent = info.muted ? "In call (muted)" : "In call";
      else callLabel.textContent = "Call";
    }
    if (btnAccept) btnAccept.hidden = st !== "incoming";
    if (btnReject) btnReject.hidden = st !== "incoming" && st !== "outgoing";
    if (btnMute) {
      btnMute.hidden = st !== "active";
      btnMute.textContent = info.muted ? "Unmute" : "Mute";
    }
    if (btnSpeaker) {
      btnSpeaker.hidden = st !== "active";
      btnSpeaker.textContent = info.speakerOn === false ? "Earpiece" : "Speaker";
    }
    if (btnEnd) btnEnd.hidden = st !== "active";
    if (callBtn) callBtn.disabled = st === "outgoing" || st === "active" || st === "incoming";
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = String(text || "");
  }

  function setContactVisible(visible) {
    if (contactBtn) contactBtn.hidden = !visible;
  }

  function mount(host) {
    ensureStyles();
    const target = host || opts.root || doc.body;
    if (!wrap.isConnected) target.appendChild(wrap);
  }

  function mountContactInto(host) {
    ensureStyles();
    if (!host || !contactBtn) return;
    if (contactBtn.parentElement !== host) host.appendChild(contactBtn);
    contactBtn.hidden = false;
  }

  async function startRecording() {
    if (recorder) return;
    if (!navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStatus("Mic not available");
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recChunks = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      recorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
      };
      recorder.start(250);
      recStartedAt = Date.now();
      pttBtn?.classList.add("is-recording");
      if (recEl) {
        recEl.hidden = false;
        recEl.textContent = "Recording… release to send";
      }
      recTimer = window.setTimeout(() => {
        void stopRecording({ cancel: false });
      }, COMM_VOICE_MAX_MS);
    } catch {
      setStatus("Mic permission denied");
      cleanupMic();
    }
  }

  async function stopRecording({ cancel = false } = {}) {
    if (recTimer) {
      clearTimeout(recTimer);
      recTimer = 0;
    }
    pttBtn?.classList.remove("is-recording");
    if (recEl) recEl.hidden = true;
    const rec = recorder;
    recorder = null;
    if (!rec) {
      cleanupMic();
      return;
    }
    const durationMs = Math.max(0, Date.now() - recStartedAt);
    const mimeType = rec.mimeType || "audio/webm";
    await new Promise((resolve) => {
      rec.onstop = () => resolve(undefined);
      try {
        if (rec.state !== "inactive") rec.stop();
        else resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
    cleanupMic();
    if (cancel || !recChunks.length || durationMs < 300) return;
    const blob = new Blob(recChunks, { type: mimeType });
    recChunks = [];
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const base64 = bytesToBase64Browser(bytes);
    opts.onVoiceRecorded?.({ base64, mimeType, durationMs, bytes });
  }

  function cleanupMic() {
    mediaStream?.getTracks?.().forEach((t) => t.stop());
    mediaStream = null;
  }

  function bytesToBase64Browser(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  contactBtn?.addEventListener("click", () => toggle());
  wrap.querySelector("[data-comm-close]")?.addEventListener("click", () => close());
  form?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = String(input?.value || "").trim();
    if (!text) return;
    opts.onSend?.(text);
    if (input) input.value = "";
  });

  const onPttDown = (ev) => {
    ev.preventDefault();
    void startRecording();
  };
  const onPttUp = (ev) => {
    ev.preventDefault();
    void stopRecording({ cancel: false });
  };
  pttBtn?.addEventListener("pointerdown", onPttDown);
  pttBtn?.addEventListener("pointerup", onPttUp);
  pttBtn?.addEventListener("pointercancel", () => void stopRecording({ cancel: true }));
  pttBtn?.addEventListener("pointerleave", () => {
    if (recorder) void stopRecording({ cancel: false });
  });
  callBtn?.addEventListener("click", () => opts.onStartCall?.());
  btnAccept?.addEventListener("click", () => opts.onAcceptCall?.());
  btnReject?.addEventListener("click", () => opts.onRejectCall?.());
  btnMute?.addEventListener("click", () => opts.onToggleMute?.());
  btnSpeaker?.addEventListener("click", () => opts.onToggleSpeaker?.());
  btnEnd?.addEventListener("click", () => opts.onEndCall?.());

  function destroy() {
    void stopRecording({ cancel: true });
    wrap.remove();
  }

  return {
    mount,
    mountContactInto,
    open,
    close,
    toggle,
    appendMessage,
    appendVoiceMessage,
    updateMessageStatus,
    updateVoiceProgress,
    setCallUi,
    setStatus,
    setContactVisible,
    setTitle: (t) => {
      if (titleEl) titleEl.textContent = String(t || title);
    },
    getContactButton: () => contactBtn,
    getRoot: () => wrap,
    destroy,
  };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDur(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * Bind conversation session + shared Contact panel for a ride.
 * @param {{
 *   role: "driver"|"customer",
 *   rideId: string,
 *   peerSessionId?: string,
 *   getTransport: () => import("./p2p-comm-session.mjs").CommTransport | null | undefined,
 *   getMediaBridge?: () => import("./p2p-comm-call.mjs").CommMediaBridge | null | undefined,
 *   getPeerSessionId?: () => string,
 *   mountHost?: HTMLElement | null,
 *   contactHost?: HTMLElement | null,
 * }} opts
 */
export function createRideCommChat(opts) {
  /** @type {ReturnType<typeof createConversationSession> | null} */
  let session = null;
  /** @type {Map<string, HTMLElement>} */
  const pendingUi = new Map();
  let boundPeerSessionId = "";
  let speakerOn = true;

  async function ensureCall() {
    const s = ensureSession();
    if (!s) return null;
    let call = s.getCall?.();
    if (call) return call;
    call = s.enableCall({
      getMediaBridge: () => opts.getMediaBridge?.() || null,
      onState: (st, detail) => {
        panel.setCallUi({
          state: st,
          muted: detail?.muted,
          speakerOn: detail?.speakerOn ?? speakerOn,
        });
        if (st === "incoming") {
          panel.open();
          panel.setStatus("Incoming call");
        } else if (st === "active") {
          panel.setStatus("Call active");
        } else if (st === "idle") {
          panel.setStatus(
            opts.getTransport?.()?.isReady?.() ? "P2P connected" : "Waiting for P2P…"
          );
        }
      },
    });
    return call;
  }

  const panel = createCommPanel({
    title: "Contact",
    onOpen: () => {
      refresh();
      try {
        if (typeof window !== "undefined") {
          const ring = (window.__SWIFTGO_COMM_TRACE__ = window.__SWIFTGO_COMM_TRACE__ || []);
          ring.push({
            t: Date.now(),
            role: opts.role,
            stage: "panel_open",
            transportReady: Boolean(opts.getTransport?.()?.isReady?.()),
            hasSession: Boolean(session && !session.getState?.().closed),
          });
        }
      } catch {
        /* ignore */
      }
    },
    onSend: (text) => {
      let s = ensureSession();
      if (!s || !s.getState?.().transportReady) {
        refresh();
        s = ensureSession();
      }
      if (!s) {
        panel.setStatus("Waiting for P2P…");
        return;
      }
      let res = s.sendText(text);
      if (!res?.ok && res?.reason === "transport_not_ready") {
        refresh();
        s = ensureSession();
        res = s?.sendText?.(text);
      }
      if (res?.ok && res.message) {
        const msgId = res.message.msgId;
        const row = panel.appendMessage({
          body: res.message.payload?.body,
          mine: true,
          ts: res.message.ts,
          status: "sending",
          id: msgId,
        });
        if (row && msgId) pendingUi.set(msgId, row);
        try {
          if (typeof window !== "undefined") {
            const ring = (window.__SWIFTGO_COMM_TRACE__ = window.__SWIFTGO_COMM_TRACE__ || []);
            ring.push({ t: Date.now(), role: opts.role, stage: "ui_send_ok", msgId });
          }
        } catch {
          /* ignore */
        }
      } else {
        panel.setStatus(res?.reason === "transport_not_ready" ? "Waiting for P2P…" : "Send failed");
        try {
          if (typeof window !== "undefined") {
            const ring = (window.__SWIFTGO_COMM_TRACE__ = window.__SWIFTGO_COMM_TRACE__ || []);
            ring.push({
              t: Date.now(),
              role: opts.role,
              stage: "ui_send_fail",
              reason: res?.reason || "unknown",
            });
          }
        } catch {
          /* ignore */
        }
      }
    },
    onVoiceRecorded: (note) => {
      let s = ensureSession();
      if (!s || !s.getState?.().transportReady) {
        refresh();
        s = ensureSession();
      }
      if (!s) {
        panel.setStatus("Waiting for P2P…");
        return;
      }
      let res = s.sendVoiceNote(note);
      if (!res?.ok && res?.reason === "transport_not_ready") {
        refresh();
        s = ensureSession();
        res = s?.sendVoiceNote?.(note);
      }
      if (res?.ok && res.voiceId) {
        panel.appendVoiceMessage({
          voiceId: res.voiceId,
          mine: true,
          ts: Date.now(),
          status: "sending",
          durationMs: res.durationMs,
          mimeType: res.mimeType,
          base64: note.base64,
          progress: 1,
        });
        pendingUi.set(res.voiceId, /** @type {any} */ ({}));
      } else {
        panel.setStatus(res?.reason === "transport_not_ready" ? "Waiting for P2P…" : "Voice send failed");
      }
    },
    onStartCall: () => {
      void (async () => {
        refresh();
        const call = await ensureCall();
        const res = await call?.startCall?.();
        if (!res?.ok) {
          panel.setStatus(
            res?.reason === "media_not_ready" || res?.reason === "transport_not_ready"
              ? "Waiting for P2P…"
              : `Call failed (${res?.reason || "error"})`
          );
        }
      })();
    },
    onAcceptCall: () => {
      void (async () => {
        refresh();
        const call = await ensureCall();
        const res = await call?.acceptCall?.();
        if (!res?.ok) panel.setStatus(`Accept failed (${res?.reason || "error"})`);
      })();
    },
    onRejectCall: () => {
      void (async () => {
        const call = await ensureCall();
        call?.rejectCall?.();
      })();
    },
    onEndCall: () => {
      void (async () => {
        const call = await ensureCall();
        call?.endCall?.();
      })();
    },
    onToggleMute: () => {
      void (async () => {
        const call = await ensureCall();
        const st = call?.getState?.();
        call?.setMuted?.(!st?.muted);
      })();
    },
    onToggleSpeaker: () => {
      void (async () => {
        const call = await ensureCall();
        speakerOn = !speakerOn;
        call?.setSpeaker?.(speakerOn);
      })();
    },
  });

  if (opts.mountHost) panel.mount(opts.mountHost);
  else panel.mount();
  if (opts.contactHost) panel.mountContactInto(opts.contactHost);

  function currentPeerSessionId() {
    if (typeof opts.getPeerSessionId === "function") {
      return String(opts.getPeerSessionId() || "");
    }
    return String(opts.peerSessionId || "");
  }

  function bindSession(transport) {
    if (!transport) return null;
    const built = buildRideConversationId({ rideId: opts.rideId });
    if (!built.ok) return null;
    session?.close?.();
    boundPeerSessionId = currentPeerSessionId();
    session = createConversationSession({
      conversationId: built.conversationId,
      role: opts.role,
      peerSessionId: boundPeerSessionId || opts.peerSessionId,
      transport,
      onText: (msg) => {
        panel.appendMessage({
          body: msg.payload?.body,
          mine: false,
          ts: msg.ts,
        });
        panel.setStatus("P2P connected");
        try {
          if (typeof window !== "undefined") {
            const ring = (window.__SWIFTGO_COMM_TRACE__ = window.__SWIFTGO_COMM_TRACE__ || []);
            ring.push({
              t: Date.now(),
              role: opts.role,
              stage: "ui_recv_text",
              body: String(msg.payload?.body || "").slice(0, 80),
            });
          }
        } catch {
          /* ignore */
        }
      },
      onVoice: (note) => {
        panel.appendVoiceMessage({
          voiceId: note.voiceId,
          mine: false,
          ts: note.ts,
          status: "received",
          durationMs: note.durationMs,
          mimeType: note.mimeType,
          base64: note.base64,
          progress: 1,
        });
        panel.setStatus("P2P connected");
      },
      onVoiceProgress: (info) => {
        if (info.direction === "in") {
          panel.appendVoiceMessage({
            voiceId: info.voiceId,
            mine: false,
            status: "receiving",
            progress: info.progress,
          });
        } else {
          panel.updateVoiceProgress(info.voiceId, info.progress);
          panel.updateMessageStatus(info.voiceId, `sending ${Math.round(info.progress * 100)}%`);
        }
      },
      onAck: (ack) => {
        const targetId = ack?.ackOf;
        if (targetId) panel.updateMessageStatus(targetId, "delivered", ack.ts);
        pendingUi.delete(String(targetId || ""));
      },
    });
    // Eager call controller so inbound CALL_OFFER is handled.
    void session.enableCall({
      getMediaBridge: () => opts.getMediaBridge?.() || null,
      onState: (st, detail) => {
        panel.setCallUi({
          state: st,
          muted: detail?.muted,
          speakerOn: detail?.speakerOn ?? speakerOn,
        });
        if (st === "incoming") {
          panel.open();
          panel.setStatus("Incoming call");
        } else if (st === "active") {
          panel.setStatus("Call active");
        }
      },
    });
    panel.setStatus(transport.isReady?.() ? "P2P connected" : "Waiting for P2P…");
    return session;
  }

  function ensureSession() {
    if (session && !session.getState().closed) return session;
    return bindSession(opts.getTransport?.());
  }

  function refresh() {
    const transport = opts.getTransport?.();
    const peerId = currentPeerSessionId();
    if (!transport) {
      panel.setStatus("Waiting for P2P…");
      session?.getCall?.()?.noteTransportLost?.();
      return session;
    }
    const st = session?.getState?.();
    const needRebind =
      !session ||
      Boolean(st?.closed) ||
      (peerId && peerId !== boundPeerSessionId) ||
      (Boolean(transport.isReady?.()) && st && !st.transportReady);
    if (needRebind) {
      session?.getCall?.()?.noteTransportLost?.();
      return bindSession(transport);
    }
    panel.setStatus(transport.isReady?.() ? "P2P connected" : "Waiting for P2P…");
    return session;
  }

  ensureSession();

  return {
    panel,
    ensureSession,
    refresh,
    destroy: () => {
      session?.close?.();
      session = null;
      boundPeerSessionId = "";
      panel.destroy();
    },
  };
}
