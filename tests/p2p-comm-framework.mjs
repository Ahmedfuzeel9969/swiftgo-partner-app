/**
 * Phase 1 — P2P communication framework tests (no UI / voice / chat product).
 * Run: node tests/p2p-comm-framework.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMM_MESSAGE_TYPE,
  COMM_SCOPE,
  COMM_ROLE,
  buildCommEnvelope,
  validateCommEnvelope,
  buildRideConversationId,
  buildContactConversationId,
  classifyCommMessageType,
  isCommMessageType,
} from "../shared/js/p2p-comm-protocol.mjs";
import {
  createConversationSession,
  createLoopbackTransportPair,
} from "../shared/js/p2p-comm-session.mjs";
import { createCommRouter } from "../shared/js/p2p-comm-router.mjs";
import { createP2pCommModule } from "../shared/js/p2p-comm-module.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "p2p-comm-phase1-report.json");
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// Protocol
{
  const id = buildRideConversationId({ rideId: "ride_1", peerSessionId: "ps_abc" });
  record("ride_conversation_id", id.ok && id.scope === COMM_SCOPE.RIDE ? "PASS" : "FAIL", id.conversationId);

  const contact = buildContactConversationId({ localUid: "u2", contactId: "u1" });
  record(
    "contact_conversation_id_future_ready",
    contact.ok && contact.conversationId.startsWith("contact:") ? "PASS" : "FAIL",
    contact.conversationId
  );

  record("loc_type_not_comm", !isCommMessageType("loc") ? "PASS" : "FAIL");
  record("text_is_comm", isCommMessageType(COMM_MESSAGE_TYPE.TEXT) ? "PASS" : "FAIL");
  record(
    "classify_families",
    classifyCommMessageType(COMM_MESSAGE_TYPE.TEXT) === "text" &&
      classifyCommMessageType(COMM_MESSAGE_TYPE.VOICE_CHUNK) === "voice" &&
      classifyCommMessageType(COMM_MESSAGE_TYPE.CALL_OFFER) === "call"
      ? "PASS"
      : "FAIL"
  );

  const built = buildCommEnvelope({
    type: COMM_MESSAGE_TYPE.TEXT,
    conversationId: id.conversationId,
    scope: COMM_SCOPE.RIDE,
    role: COMM_ROLE.DRIVER,
    seq: 1,
    payload: { body: "hello" },
  });
  record("build_envelope", built.ok ? "PASS" : "FAIL", built.reason || "");
  const val = validateCommEnvelope(built.serialized, {
    conversationId: id.conversationId,
    expectRole: COMM_ROLE.DRIVER,
  });
  record("validate_envelope", val.ok && val.family === "text" ? "PASS" : "FAIL", val.reason || "");
  record(
    "reject_wrong_conversation",
    !validateCommEnvelope(built.serialized, { conversationId: "ride:other" }).ok
      ? "PASS"
      : "FAIL"
  );
}

// Session + routing over loopback (no WebRTC required for Phase 1)
{
  const pair = createLoopbackTransportPair();
  const inbox = [];
  const drv = createConversationSession({
    conversationId: "ride:r1:ps1",
    role: "driver",
    peerSessionId: "ps1",
    transport: pair.a,
  });
  const cust = createConversationSession({
    conversationId: "ride:r1:ps1",
    role: "customer",
    peerSessionId: "ps1",
    transport: pair.b,
    onInbound: (msg, meta) => inbox.push({ msg, meta }),
  });

  const sent = drv.send(COMM_MESSAGE_TYPE.PING, { n: 1 });
  record("session_send_ping", sent.ok ? "PASS" : "FAIL", sent.reason || "");
  record(
    "session_receive_on_peer",
    inbox.length === 1 && inbox[0].meta.family === "control" ? "PASS" : "FAIL",
    `n=${inbox.length}`
  );

  const families = { text: 0, voice: 0, call: 0 };
  const router = createCommRouter({
    conversationId: "ride:r1:ps1",
    onText: () => {
      families.text += 1;
    },
    onVoice: () => {
      families.voice += 1;
    },
    onCall: () => {
      families.call += 1;
    },
  });
  router.route(
    buildCommEnvelope({
      type: COMM_MESSAGE_TYPE.TEXT,
      conversationId: "ride:r1:ps1",
      role: COMM_ROLE.DRIVER,
      seq: 2,
      payload: { body: "x" },
    }).message
  );
  router.route(
    buildCommEnvelope({
      type: COMM_MESSAGE_TYPE.CALL_OFFER,
      conversationId: "ride:r1:ps1",
      role: COMM_ROLE.DRIVER,
      seq: 3,
      payload: {},
    }).message
  );
  record(
    "router_demux",
    families.text === 1 && families.call === 1 ? "PASS" : "FAIL",
    JSON.stringify(families)
  );

  drv.close();
  cust.close();
}

// Module + hidden placeholder
{
  const pair = createLoopbackTransportPair();
  const mod = createP2pCommModule({
    role: "driver",
    rideId: "ride_99",
    peerSessionId: "ps_99",
    transport: pair.a,
  });
  record("module_ok", mod.ok ? "PASS" : "FAIL", mod.reason || mod.conversationId);

  const host = {
    children: [],
    querySelector(sel) {
      return this.children.find((c) => c.matches?.(sel)) || null;
    },
    appendChild(el) {
      this.children.push(el);
      return el;
    },
  };
  // minimal Element-like
  mod.attachPlaceholder({
    querySelector: (s) => (s.includes("swiftgo-comm-placeholder") ? null : null),
    appendChild(el) {
      host.children.push(el);
      el.matches = (sel) => sel.includes("swiftgo-comm-placeholder") && el.hidden === true;
      return el;
    },
  });
  record(
    "placeholder_hidden_only",
    host.children.length === 1 && host.children[0].hidden === true ? "PASS" : "FAIL"
  );
  mod.destroy();
}

// Isolation: location protocol untouched
{
  const locProto = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-protocol.mjs"), "utf8");
  const peer = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8");
  record(
    "location_protocol_untouched_no_comm_types",
    !locProto.includes("comm_text") && locProto.includes('LOC: "loc"') ? "PASS" : "FAIL"
  );
  record(
    "peer_session_untouched_no_comm_import",
    !peer.includes("p2p-comm-") ? "PASS" : "FAIL"
  );
}

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const report = {
  suite: "p2p-comm-framework",
  phase: 1,
  title: "P2P Communication Framework — Phase 1",
  generatedAt: new Date().toISOString(),
  pass,
  fail,
  results,
  filesAdded: [
    "shared/js/p2p-comm-protocol.mjs",
    "shared/js/p2p-comm-session.mjs",
    "shared/js/p2p-comm-router.mjs",
    "shared/js/p2p-comm-module.mjs",
  ],
  notImplemented: ["text chat UI", "voice messages", "voice calls", "DataChannel wiring"],
  status: fail ? "FAIL" : "PASS — awaiting approval for Phase 2",
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nPhase 1: ${pass} PASS / ${fail} FAIL → ${OUT}`);
process.exit(fail ? 1 : 0);
