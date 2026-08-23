/**
 * Phase 3 — P2P push-to-talk voice messages (chunk, ACK, progress).
 * Run: node tests/p2p-comm-voice.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMM_MESSAGE_TYPE,
  COMM_MAX_ENVELOPE_BYTES,
} from "../shared/js/p2p-comm-protocol.mjs";
import {
  createConversationSession,
  createLoopbackTransportPair,
  COMM_ACK_RETRY_MS,
  COMM_VOICE_CHUNK_CHARS,
} from "../shared/js/p2p-comm-session.mjs";
import {
  buildVoicePayloads,
  chunkBase64,
  assembleBase64Chunks,
  bytesToBase64,
  base64ToBytes,
  createVoiceAssembler,
  COMM_VOICE_MAX_BYTES,
} from "../shared/js/p2p-comm-voice.mjs";
import { createP2pCommModule } from "../shared/js/p2p-comm-module.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "p2p-comm-phase3-report.json");
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// Chunk helpers
{
  const raw = new Uint8Array(12_000).map((_, i) => i % 256);
  const b64 = bytesToBase64(raw);
  const parts = chunkBase64(b64, 1000);
  record("chunk_splits", parts.length > 1 ? "PASS" : "FAIL", `n=${parts.length}`);
  record(
    "assemble_roundtrip",
    assembleBase64Chunks(parts) === b64 && base64ToBytes(b64).length === raw.length
      ? "PASS"
      : "FAIL"
  );
  const built = buildVoicePayloads({
    bytes: raw,
    mimeType: "audio/webm",
    durationMs: 1500,
  });
  record(
    "build_voice_payloads",
    built.ok && built.chunks.length >= 1 && built.voiceId ? "PASS" : "FAIL",
    built.reason || `chunks=${built.chunks?.length}`
  );
  record(
    "chunk_under_envelope_cap",
    built.ok &&
      built.chunks.every((c) => {
        const probe = JSON.stringify({
          v: 1,
          type: COMM_MESSAGE_TYPE.VOICE_CHUNK,
          scope: "ride",
          conversationId: "ride:x",
          peerSessionId: "",
          role: "driver",
          seq: 1,
          msgId: "cm_xxxxxxxxxxxxxxxx",
          ts: Date.now(),
          payload: c,
        });
        return probe.length <= COMM_MAX_ENVELOPE_BYTES;
      })
      ? "PASS"
      : "FAIL"
  );
  record("reject_empty_voice", !buildVoicePayloads({ base64: "" }).ok ? "PASS" : "FAIL");
  const huge = bytesToBase64(new Uint8Array(COMM_VOICE_MAX_BYTES + 50_000));
  record("reject_oversized_voice", !buildVoicePayloads({ base64: huge }).ok ? "PASS" : "FAIL");
  record("chunk_chars_constant", COMM_VOICE_CHUNK_CHARS >= 1000 ? "PASS" : "FAIL");
}

// Assembler progress
{
  const a = createVoiceAssembler();
  const voiceId = "vv_test1";
  a.acceptMeta({ voiceId, totalChunks: 3, mimeType: "audio/webm", durationMs: 900 });
  const c1 = a.acceptChunk({ voiceId, index: 0, total: 3, data: "AA" });
  const c2 = a.acceptChunk({ voiceId, index: 1, total: 3, data: "BB" });
  record("progress_partial", c1.ok && !c1.complete && c2.progress < 1 ? "PASS" : "FAIL");
  const c3 = a.acceptChunk({ voiceId, index: 2, total: 3, data: "CC" });
  record("progress_complete_flag", c3.complete ? "PASS" : "FAIL");
  const fin = a.finalize(voiceId);
  record(
    "finalize_assembles",
    fin.ok && fin.base64 === "AABBCC" ? "PASS" : "FAIL",
    fin.reason || ""
  );
}

// End-to-end voice over loopback
{
  const pair = createLoopbackTransportPair();
  const notes = [];
  const progress = [];
  const acks = [];
  const drv = createConversationSession({
    conversationId: "ride:voice1",
    role: "driver",
    transport: pair.a,
    onAck: (m) => acks.push(m),
    onVoiceProgress: (p) => {
      if (p.direction === "out") progress.push(p);
    },
  });
  const cust = createConversationSession({
    conversationId: "ride:voice1",
    role: "customer",
    transport: pair.b,
    onVoice: (n) => notes.push(n),
    onVoiceProgress: (p) => {
      if (p.direction === "in") progress.push(p);
    },
  });

  // Force multi-chunk with small payload but many chars via repeated base64
  const sample = bytesToBase64(new Uint8Array(8_000).fill(7));
  const sent = drv.sendVoiceNote({
    base64: sample,
    mimeType: "audio/webm;codecs=opus",
    durationMs: 2200,
  });
  record("send_voice_ok", sent.ok ? "PASS" : "FAIL", sent.reason || `chunks=${sent.totalChunks}`);
  record(
    "voice_received_once",
    notes.length === 1 && notes[0].base64 === sample ? "PASS" : "FAIL",
    `n=${notes.length}`
  );
  record(
    "voice_ack_clears_pending",
    acks.some((a) => a.type === COMM_MESSAGE_TYPE.VOICE_ACK && a.ackOf === sent.voiceId) &&
      drv.getState().pendingAckCount === 0
      ? "PASS"
      : "FAIL",
    `pending=${drv.getState().pendingAckCount} acks=${acks.length}`
  );
  record(
    "outbound_progress_seen",
    progress.some((p) => p.direction === "out" && p.progress > 0) ? "PASS" : "FAIL"
  );
  record(
    "inbound_progress_seen",
    progress.some((p) => p.direction === "in") ? "PASS" : "FAIL"
  );
  record(
    "counters_voice",
    drv.getState().counters.voiceSent === 1 && cust.getState().counters.voiceReceived === 1
      ? "PASS"
      : "FAIL"
  );
  drv.close();
  cust.close();
}

// Voice retry when ACK blocked
{
  const aHandlers = new Set();
  const bHandlers = new Set();
  let blockAck = true;
  let ready = true;
  const filtered = {
    a: {
      isReady: () => ready,
      send(s) {
        if (!ready) return false;
        for (const h of bHandlers) h(s);
        return true;
      },
      subscribe(h) {
        aHandlers.add(h);
        return () => aHandlers.delete(h);
      },
    },
    b: {
      isReady: () => ready,
      send(s) {
        if (!ready) return false;
        if (blockAck && String(s).includes('"comm_voice_ack"')) return true;
        for (const h of aHandlers) h(s);
        return true;
      },
      subscribe(h) {
        bHandlers.add(h);
        return () => bHandlers.delete(h);
      },
    },
  };
  let now = 5_000;
  const timers = [];
  const drv = createConversationSession({
    conversationId: "ride:vretry",
    role: "driver",
    transport: filtered.a,
    nowMs: () => now,
    setTimeoutFn: (fn, ms) => {
      const id = { fn, due: now + ms };
      timers.push(id);
      return id;
    },
    clearTimeoutFn: (id) => {
      const i = timers.indexOf(id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const cust = createConversationSession({
    conversationId: "ride:vretry",
    role: "customer",
    transport: filtered.b,
  });
  const sent = drv.sendVoiceNote({
    base64: bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    mimeType: "audio/webm",
    durationMs: 400,
  });
  record("voice_retry_pending", sent.ok && drv.getState().pendingAckCount === 1 ? "PASS" : "FAIL");
  const before = drv.getState().counters.retries;
  now += COMM_ACK_RETRY_MS + 1;
  for (const t of [...timers]) if (t.due <= now) t.fn();
  record(
    "voice_retry_fires",
    drv.getState().counters.retries > before ? "PASS" : "FAIL",
    `retries=${drv.getState().counters.retries}`
  );
  blockAck = false;
  now += COMM_ACK_RETRY_MS + 1;
  for (const t of [...timers]) if (t.due <= now) t.fn();
  record(
    "voice_retry_ack_clears",
    drv.getState().pendingAckCount === 0 ? "PASS" : "FAIL",
    `pending=${drv.getState().pendingAckCount}`
  );
  drv.close();
  cust.close();
}

// Module API
{
  const pair = createLoopbackTransportPair();
  const got = [];
  const modA = createP2pCommModule({ role: "driver", rideId: "vr1", transport: pair.a });
  const modB = createP2pCommModule({
    role: "customer",
    rideId: "vr1",
    transport: pair.b,
    onVoice: (n) => got.push(n),
  });
  const sent = modA.sendVoiceNote({
    base64: bytesToBase64(Uint8Array.from([9, 8, 7, 6])),
    mimeType: "audio/webm",
    durationMs: 500,
  });
  record("module_send_voice", sent.ok ? "PASS" : "FAIL", sent.reason || "");
  record("module_onVoice", got.length === 1 ? "PASS" : "FAIL", `n=${got.length}`);
  modA.destroy();
  modB.destroy();
}

// Files / UI markers
{
  const panel = fs.readFileSync(path.join(ROOT, "shared/js/p2p-comm-panel.mjs"), "utf8");
  record(
    "panel_has_ptt_and_playback",
    panel.includes("data-comm-ptt") && panel.includes("appendVoiceMessage") && panel.includes("data-comm-play")
      ? "PASS"
      : "FAIL"
  );
  record(
    "no_firebase_media_in_voice_module",
    !fs.readFileSync(path.join(ROOT, "shared/js/p2p-comm-voice.mjs"), "utf8").includes("firebase") &&
      !fs.readFileSync(path.join(ROOT, "shared/js/p2p-comm-session.mjs"), "utf8").includes("uploadBytes")
      ? "PASS"
      : "FAIL"
  );
  const wrappersOk = ["customer-app/js/p2p-comm-voice.mjs", "driver-app/js/p2p-comm-voice.mjs"].every((f) =>
    fs.existsSync(path.join(ROOT, f))
  );
  record("voice_wrappers_synced", wrappersOk ? "PASS" : "FAIL");
}

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      phase: 3,
      title: "P2P Communication — Voice Messages",
      generatedAt: new Date().toISOString(),
      summary: { passed, failed, total: results.length },
      results,
    },
    null,
    2
  )
);

console.log(`\nPhase 3: ${passed}/${results.length} PASS → ${path.relative(ROOT, OUT)}`);
process.exit(failed ? 1 : 0);
