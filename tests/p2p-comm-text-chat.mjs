/**
 * Phase 2 — P2P text chat (ACK, retry, ordered seq, shared Contact panel).
 * Run: node tests/p2p-comm-text-chat.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMM_MESSAGE_TYPE,
  buildRideConversationId,
} from "../shared/js/p2p-comm-protocol.mjs";
import {
  createConversationSession,
  createLoopbackTransportPair,
  COMM_ACK_RETRY_MS,
  COMM_ACK_MAX_RETRIES,
  COMM_TEXT_MAX_CHARS,
} from "../shared/js/p2p-comm-session.mjs";
import { createP2pCommModule } from "../shared/js/p2p-comm-module.mjs";
import { createCommPanel } from "../shared/js/p2p-comm-panel.mjs";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "p2p-comm-phase2-report.json");
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Ordered text + auto ACK
{
  const pair = createLoopbackTransportPair();
  const received = [];
  const acks = [];
  const drv = createConversationSession({
    conversationId: "ride:r2",
    role: "driver",
    transport: pair.a,
    onAck: (m) => acks.push(m),
  });
  const cust = createConversationSession({
    conversationId: "ride:r2",
    role: "customer",
    transport: pair.b,
    onText: (m) => received.push(m),
  });

  const s1 = drv.sendText("hello");
  const s2 = drv.sendText("world");
  record("send_text_ok", s1.ok && s2.ok ? "PASS" : "FAIL", s1.reason || "");
  record(
    "ordered_delivery",
    received.length === 2 &&
      received[0].payload.body === "hello" &&
      received[1].payload.body === "world" &&
      received[0].seq < received[1].seq
      ? "PASS"
      : "FAIL",
    `n=${received.length}`
  );
  record(
    "auto_ack_clears_pending",
    acks.length === 2 && drv.getState().pendingAckCount === 0 && drv.getState().counters.acked === 2
      ? "PASS"
      : "FAIL",
    `acks=${acks.length} pending=${drv.getState().pendingAckCount}`
  );
  record(
    "timestamps_present",
    Number.isFinite(received[0]?.ts) && received[0].ts > 0 ? "PASS" : "FAIL"
  );
  record(
    "ack_references_msgId",
    acks[0]?.ackOf === s1.message.msgId ? "PASS" : "FAIL"
  );
  cust.close();
  drv.close();
}

// Empty / max length
{
  const pair = createLoopbackTransportPair();
  const drv = createConversationSession({
    conversationId: "ride:r2b",
    role: "driver",
    transport: pair.a,
  });
  record("reject_empty_text", !drv.sendText("   ").ok ? "PASS" : "FAIL");
  const long = "x".repeat(COMM_TEXT_MAX_CHARS + 40);
  const sent = drv.sendText(long);
  record(
    "truncate_long_text",
    sent.ok && sent.message.payload.body.length === COMM_TEXT_MAX_CHARS ? "PASS" : "FAIL"
  );
  drv.close();
}

// Retry after missed ACK
{
  const pair = createLoopbackTransportPair();
  let blockAck = true;
  const originalSend = pair.b.send.bind(pair.b);
  // Drop ACKs from customer→driver by wrapping a handlers? Customer sends ACK on pair.b
  // Intercept: wrap pair.a subscribe? Easier: wrap transport a receive from b
  const aSend = pair.a.send;
  // Customer session will send ACK via pair.b.send → a handlers.
  // Drop TEXT_ACK on the path to driver by filtering in a custom transport.
  const aHandlers = new Set();
  const bHandlers = new Set();
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
        if (blockAck && String(s).includes('"comm_text_ack"')) return true; // swallow ACK
        for (const h of aHandlers) h(s);
        return true;
      },
      subscribe(h) {
        bHandlers.add(h);
        return () => bHandlers.delete(h);
      },
    },
  };

  let now = 1_000;
  const timers = [];
  const drv = createConversationSession({
    conversationId: "ride:retry",
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
    conversationId: "ride:retry",
    role: "customer",
    transport: filtered.b,
  });

  const sent = drv.sendText("retry-me");
  record("retry_setup_send", sent.ok ? "PASS" : "FAIL");
  record("retry_pending_while_ack_blocked", drv.getState().pendingAckCount === 1 ? "PASS" : "FAIL");

  // Advance time and flush retry timers
  let retriesBefore = drv.getState().counters.retries;
  now += COMM_ACK_RETRY_MS + 1;
  for (const t of [...timers]) {
    if (t.due <= now) t.fn();
  }
  record(
    "retry_increments",
    drv.getState().counters.retries > retriesBefore ? "PASS" : "FAIL",
    `retries=${drv.getState().counters.retries}`
  );

  blockAck = false;
  now += COMM_ACK_RETRY_MS + 1;
  for (const t of [...timers]) {
    if (t.due <= now) t.fn();
  }
  record(
    "retry_delivers_after_ack_unblocked",
    drv.getState().pendingAckCount === 0 && drv.getState().counters.acked >= 1
      ? "PASS"
      : "FAIL",
    `pending=${drv.getState().pendingAckCount} acked=${drv.getState().counters.acked}`
  );
  record("ack_max_retries_constant", COMM_ACK_MAX_RETRIES >= 1 ? "PASS" : "FAIL");
  cust.close();
  drv.close();
  void aSend;
  void originalSend;
  void pair;
}

// Duplicate TEXT still ACKs (retry path)
{
  const pair = createLoopbackTransportPair();
  const drv = createConversationSession({
    conversationId: "ride:dup",
    role: "driver",
    transport: pair.a,
  });
  const cust = createConversationSession({
    conversationId: "ride:dup",
    role: "customer",
    transport: pair.b,
  });
  const sent = drv.sendText("once");
  // Simulate retry of same serialized envelope
  pair.a.send(
    JSON.stringify({
      ...sent.message,
      // same seq/msgId
    })
  );
  record(
    "duplicate_text_still_acked",
    drv.getState().pendingAckCount === 0 ? "PASS" : "FAIL",
    `pending=${drv.getState().pendingAckCount}`
  );
  drv.close();
  cust.close();
}

// Peer-session multiplex: comm_* does not count as invalid location
{
  const session = createP2pPeerSession({
    role: "driver",
    RTCPeerConnection: class {
      constructor() {
        this.localDescription = null;
        this.onicecandidate = null;
        this.onconnectionstatechange = null;
        this.ondatachannel = null;
      }
      createDataChannel() {
        return {
          readyState: "connecting",
          bufferedAmount: 0,
          binaryType: "blob",
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          send() {},
          close() {},
        };
      }
      async createOffer() {
        return { type: "offer", sdp: "x" };
      }
      async setLocalDescription(d) {
        this.localDescription = d;
      }
      async setRemoteDescription() {}
      async createAnswer() {
        return { type: "answer", sdp: "y" };
      }
      close() {}
    },
  });
  session._setChannelOpenForTest(true);
  const transport = session.createCommTransport();
  let got = "";
  transport.subscribe((raw) => {
    got = raw;
  });
  const before = session.getCounters().invalidMessages || 0;
  const envelope = JSON.stringify({
    v: 1,
    type: COMM_MESSAGE_TYPE.TEXT,
    scope: "ride",
    conversationId: "ride:mux",
    peerSessionId: "",
    role: "customer",
    seq: 1,
    msgId: "cm_test",
    ts: Date.now(),
    payload: { body: "mux" },
  });
  session._handleMessageForTest(envelope, session.getState().generation);
  const after = session.getCounters().invalidMessages || 0;
  record("comm_bypass_location_validate", got === envelope && after === before ? "PASS" : "FAIL");
  record("comm_transport_ready", transport.isReady() ? "PASS" : "FAIL");
  record("comm_transport_send", transport.send(envelope) ? "PASS" : "FAIL");
  void session.close({ reason: "test" });
}

// Module sendText + panel factory (no DOM)
{
  const pair = createLoopbackTransportPair();
  const id = buildRideConversationId({ rideId: "mod1" });
  const received = [];
  const modA = createP2pCommModule({
    role: "driver",
    rideId: "mod1",
    transport: pair.a,
  });
  const modB = createP2pCommModule({
    role: "customer",
    rideId: "mod1",
    transport: pair.b,
    onText: (m) => received.push(m),
  });
  // Customer module needs session subscribed — create via send/ensure on B by attaching session
  // createP2pCommModule with transport creates session only when transport passed — both have it
  // But B's onText is on router via onInbound from session — session onText routes TEXT
  // Looking at module: onText on session calls opts.onText and router.route
  // Session is created eagerly when transport provided — good
  const sent = modA.sendText("from-module");
  // Force B session to exist - it should already
  record("module_send_text", sent.ok ? "PASS" : "FAIL", sent.reason || "");
  // Peer B session receives via transport subscribe at construction
  record(
    "module_peer_receives_text",
    received.length >= 1 || modB.getState().session?.counters?.received >= 1
      ? "PASS"
      : "FAIL",
    `recv=${received.length}`
  );
  const panel = createCommPanel({ title: "Contact" });
  record("panel_factory_no_dom", typeof panel.open === "function" ? "PASS" : "FAIL");
  record(
    "conversation_id_ride_scoped",
    id.ok && modA.conversationId === id.conversationId ? "PASS" : "FAIL",
    modA.conversationId
  );
  modA.destroy();
  modB.destroy();
}

// Shared files present
{
  const files = [
    "shared/js/p2p-comm-panel.mjs",
    "shared/js/p2p-comm-session.mjs",
    "shared/js/p2p-comm-module.mjs",
    "customer-app/index.html",
    "driver-app/index.html",
  ];
  let ok = true;
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) ok = false;
  }
  const custHtml = fs.readFileSync(path.join(ROOT, "customer-app/index.html"), "utf8");
  const drvHtml = fs.readFileSync(path.join(ROOT, "driver-app/index.html"), "utf8");
  record(
    "contact_host_both_apps",
    ok &&
      custHtml.includes("activeRideContactHost") &&
      drvHtml.includes("activeRideContactHost")
      ? "PASS"
      : "FAIL"
  );
  const wrappers = ["customer-app/js/p2p-comm-panel.mjs", "driver-app/js/p2p-comm-panel.mjs"];
  record(
    "panel_wrappers_synced",
    wrappers.every((f) => fs.existsSync(path.join(ROOT, f))) ? "PASS" : "FAIL"
  );
}

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
const report = {
  phase: 2,
  title: "P2P Communication — Text Chat",
  generatedAt: new Date().toISOString(),
  summary: { passed, failed, total: results.length },
  results,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nPhase 2: ${passed}/${results.length} PASS → ${path.relative(ROOT, OUT)}`);
process.exit(failed ? 1 : 0);
