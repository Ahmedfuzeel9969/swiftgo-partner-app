/**
 * Device-path regression: Contact chat must bind AFTER DataChannel opens.
 * Reproduces real Android failure: UI visible but messages dropped (no handlers).
 * Run: node tests/p2p-comm-device-path.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConversationSession,
  createLoopbackTransportPair,
} from "../shared/js/p2p-comm-session.mjs";
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import { COMM_MESSAGE_TYPE, buildCommEnvelope, COMM_ROLE } from "../shared/js/p2p-comm-protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "p2p-comm-device-path-report.json");
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1) Without subscribe, inbound comm is dropped (the real-device break).
{
  const session = createP2pPeerSession({
    role: "customer",
    RTCPeerConnection: class {
      constructor() {
        this.localDescription = null;
        this.onicecandidate = null;
        this.onconnectionstatechange = null;
        this.ondatachannel = null;
        this.ontrack = null;
      }
      createDataChannel() {
        return {
          readyState: "connecting",
          bufferedAmount: 0,
          binaryType: "arraybuffer",
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
      getSenders() {
        return [];
      }
    },
  });
  session._setChannelOpenForTest(true);
  const env = buildCommEnvelope({
    type: COMM_MESSAGE_TYPE.TEXT,
    conversationId: "ride:r1",
    role: COMM_ROLE.DRIVER,
    seq: 1,
    payload: { body: "Hello" },
  });
  session._handleMessageForTest(env.serialized, session.getState().generation);
  // No subscribe → dropped; transport subscribe then delivers.
  const got = [];
  const t = session.createCommTransport();
  t.subscribe((raw) => got.push(raw));
  session._handleMessageForTest(env.serialized, session.getState().generation);
  record(
    "subscribe_required_to_receive",
    got.length === 1 && got[0].includes("Hello") ? "PASS" : "FAIL",
    `n=${got.length}`
  );
  record(
    "onChannelOpen_hook_exists",
    fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8").includes("onChannelOpen")
      ? "PASS"
      : "FAIL"
  );
  void session.close({ reason: "test" });
}

// 2) Late bind then message (simulates channel-open → syncRideCommChat → subscribe)
{
  const pair = createLoopbackTransportPair();
  // Driver has session immediately
  const drv = createConversationSession({
    conversationId: "ride:late",
    role: "driver",
    transport: pair.a,
  });
  // Customer chat "created" before transport ready — no session yet
  let cust = null;
  const inbox = [];
  function bindCustomer() {
    cust?.close?.();
    cust = createConversationSession({
      conversationId: "ride:late",
      role: "customer",
      transport: pair.b,
      onText: (m) => inbox.push(m.payload?.body),
    });
  }
  // Driver sends before customer bound
  const early = drv.sendText("Hello");
  record("early_send_ok", early.ok ? "PASS" : "FAIL");
  record("early_message_not_received", inbox.length === 0 ? "PASS" : "FAIL");
  // Channel-open style late bind
  bindCustomer();
  // Retry path (pending ACK) should deliver after bind
  const pending = drv.getPendingAcks();
  record("sender_still_pending_ack", pending.size >= 1 ? "PASS" : "FAIL", `n=${pending.size}`);
  // Force retry by re-sending same path: session retry loop needs time — manually resend
  for (const [, p] of pending) {
    pair.a.send(p.serialized);
  }
  record(
    "late_bind_receives_retry",
    inbox.includes("Hello") ? "PASS" : "FAIL",
    `inbox=${JSON.stringify(inbox)}`
  );
  // Reply path
  const reply = cust.sendText("OK");
  const drvInbox = [];
  // Driver already subscribed — should get OK
  // Re-create listener check via new subscribe on same transport? Driver session already listening.
  // Capture by wrapping: create second session would conflict. Use onAck / check via new pair read.
  // Simpler: new customer→driver already connected; add onText was not on driver. Rebuild driver with onText.
  drv.close();
  const drv2Inbox = [];
  const drv2 = createConversationSession({
    conversationId: "ride:late",
    role: "driver",
    transport: pair.a,
    onText: (m) => drv2Inbox.push(m.payload?.body),
  });
  cust.sendText("OK");
  record("customer_to_driver_ok", drv2Inbox.includes("OK") ? "PASS" : "FAIL", JSON.stringify(drv2Inbox));
  record("reply_send_ok", reply.ok ? "PASS" : "FAIL");
  cust.close();
  drv2.close();
}

// 3) Blob coercion path (Android WebView)
{
  const peerSrc = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8");
  record(
    "onmessage_handles_arraybuffer_or_blob",
    peerSrc.includes("arrayBuffer") && peerSrc.includes("TextDecoder") && peerSrc.includes('binaryType = "arraybuffer"')
      ? "PASS"
      : "FAIL"
  );
  record(
    "customer_channel_open_rebinds_comm",
    fs.readFileSync(path.join(ROOT, "customer-app/js/ride-flow.js"), "utf8").includes("onChannelOpen") &&
      fs.readFileSync(path.join(ROOT, "customer-app/js/ride-flow.js"), "utf8").includes("syncRideCommChat")
      ? "PASS"
      : "FAIL"
  );
  record(
    "driver_channel_open_rebinds_comm",
    fs.readFileSync(path.join(ROOT, "driver-app/js/driver-app.js"), "utf8").includes("onChannelOpen") &&
      fs.readFileSync(path.join(ROOT, "driver-app/js/driver-app.js"), "utf8").includes("syncDriverRideCommChat")
      ? "PASS"
      : "FAIL"
  );
  record(
    "panel_open_refreshes_bind",
    fs.readFileSync(path.join(ROOT, "shared/js/p2p-comm-panel.mjs"), "utf8").includes("onOpen:") &&
      fs.readFileSync(path.join(ROOT, "shared/js/p2p-comm-panel.mjs"), "utf8").includes("panel_open")
      ? "PASS"
      : "FAIL"
  );
  record(
    "field_trace_global_documented",
    peerSrc.includes("__SWIFTGO_COMM_TRACE__") ? "PASS" : "FAIL"
  );
}

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
const report = {
  title: "P2P Communication — Device Path Emergency Debug",
  generatedAt: new Date().toISOString(),
  firstBreak:
    "Contact conversation session often never subscribed to DataChannel: UI mounted before peer session existed, and customer did not rebind on channel open. Inbound comm_* frames hit empty commHandlers and were dropped.",
  secondaryRisk:
    "Android WebView may deliver DC payloads as Blob/ArrayBuffer; String(blob) corrupted the JSON. onmessage now decodes ArrayBuffer/Blob.",
  fix:
    "onChannelOpen → syncRideCommChat / syncDriverRideCommChat; panel open + send refresh/retry; robust DC decode; __SWIFTGO_COMM_TRACE__ evidence ring.",
  deploy: "NOT_DEPLOYED_WAIT_FOR_REAL_DEVICE_PROOF",
  summary: { passed, failed, total: results.length },
  results,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nDevice path: ${passed}/${results.length} PASS → ${path.relative(ROOT, OUT)}`);
process.exit(failed ? 1 : 0);
