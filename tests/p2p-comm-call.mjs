/**
 * Phase 4 — P2P voice call (accept/reject/mute/speaker/end + recover).
 * Run: node tests/p2p-comm-call.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMM_MESSAGE_TYPE,
  COMM_MAX_CALL_ENVELOPE_BYTES,
  buildCommEnvelope,
  COMM_ROLE,
} from "../shared/js/p2p-comm-protocol.mjs";
import {
  createConversationSession,
  createLoopbackTransportPair,
} from "../shared/js/p2p-comm-session.mjs";
import {
  CALL_STATE,
  createFakeMediaBridge,
} from "../shared/js/p2p-comm-call.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "p2p-comm-phase4-report.json");
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred, ms = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

// Protocol allows larger call envelopes
{
  const bigSdp = "v=0\r\n" + "a=x:".padEnd(8_000, "x") + "\r\n";
  const built = buildCommEnvelope({
    type: COMM_MESSAGE_TYPE.CALL_OFFER,
    conversationId: "ride:c1",
    role: COMM_ROLE.DRIVER,
    seq: 1,
    payload: { callId: "call_x", sdp: bigSdp, media: "audio" },
  });
  record(
    "call_envelope_fits_large_sdp",
    built.ok && built.serialized.length <= COMM_MAX_CALL_ENVELOPE_BYTES ? "PASS" : "FAIL",
    built.reason || `len=${built.serialized?.length}`
  );
}

// Happy path: offer → accept → active → end
{
  const pair = createLoopbackTransportPair();
  const statesA = [];
  const statesB = [];
  const bridgeA = createFakeMediaBridge();
  const bridgeB = createFakeMediaBridge();

  const drv = createConversationSession({
    conversationId: "ride:call1",
    role: "driver",
    transport: pair.a,
  });
  const cust = createConversationSession({
    conversationId: "ride:call1",
    role: "customer",
    transport: pair.b,
  });

  const callA = drv.enableCall({
    mediaBridge: bridgeA,
    onState: (s) => statesA.push(s),
  });
  const callB = cust.enableCall({
    mediaBridge: bridgeB,
    onState: (s) => statesB.push(s),
  });

  const started = await callA.startCall();
  record("start_call_ok", started.ok ? "PASS" : "FAIL", started.reason || "");
  await waitFor(() => callB.getState().state === CALL_STATE.INCOMING);
  record(
    "incoming_rings",
    callB.getState().state === CALL_STATE.INCOMING ? "PASS" : "FAIL",
    callB.getState().state
  );

  const accepted = await callB.acceptCall();
  record("accept_ok", accepted.ok ? "PASS" : "FAIL", accepted.reason || "");
  await waitFor(() => callA.getState().state === CALL_STATE.ACTIVE);
  record(
    "both_active",
    callA.getState().state === CALL_STATE.ACTIVE && callB.getState().state === CALL_STATE.ACTIVE
      ? "PASS"
      : "FAIL",
    `A=${callA.getState().state} B=${callB.getState().state}`
  );

  callA.setMuted(true);
  record("mute_local", callA.getState().muted === true ? "PASS" : "FAIL");
  callA.setSpeaker(false);
  record("speaker_off", callA.getState().speakerOn === false ? "PASS" : "FAIL");

  callA.endCall();
  await waitFor(() => callB.getState().state === CALL_STATE.IDLE);
  record(
    "end_clears_both",
    callA.getState().state === CALL_STATE.IDLE && callB.getState().state === CALL_STATE.IDLE
      ? "PASS"
      : "FAIL"
  );
  record(
    "state_saw_outgoing_incoming_active",
    statesA.includes(CALL_STATE.OUTGOING) &&
      statesB.includes(CALL_STATE.INCOMING) &&
      statesA.includes(CALL_STATE.ACTIVE)
      ? "PASS"
      : "FAIL"
  );
  drv.close();
  cust.close();
}

// Reject path
{
  const pair = createLoopbackTransportPair();
  const bridgeA = createFakeMediaBridge();
  const bridgeB = createFakeMediaBridge();
  const drv = createConversationSession({
    conversationId: "ride:call2",
    role: "driver",
    transport: pair.a,
  });
  const cust = createConversationSession({
    conversationId: "ride:call2",
    role: "customer",
    transport: pair.b,
  });
  const callA = drv.enableCall({ mediaBridge: bridgeA });
  const callB = cust.enableCall({ mediaBridge: bridgeB });
  await callA.startCall();
  await waitFor(() => callB.getState().state === CALL_STATE.INCOMING);
  callB.rejectCall();
  await waitFor(() => callA.getState().state === CALL_STATE.IDLE);
  record(
    "reject_returns_idle",
    callA.getState().state === CALL_STATE.IDLE && callB.getState().state === CALL_STATE.IDLE
      ? "PASS"
      : "FAIL"
  );
  drv.close();
  cust.close();
}

// Transport lost auto-recover
{
  const pair = createLoopbackTransportPair();
  const bridgeA = createFakeMediaBridge();
  const bridgeB = createFakeMediaBridge();
  const drv = createConversationSession({
    conversationId: "ride:call3",
    role: "driver",
    transport: pair.a,
  });
  const cust = createConversationSession({
    conversationId: "ride:call3",
    role: "customer",
    transport: pair.b,
  });
  const callA = drv.enableCall({ mediaBridge: bridgeA });
  const callB = cust.enableCall({ mediaBridge: bridgeB });
  await callA.startCall();
  await waitFor(() => callB.getState().state === CALL_STATE.INCOMING);
  await callB.acceptCall();
  await waitFor(() => callA.getState().state === CALL_STATE.ACTIVE);
  callA.noteTransportLost();
  record(
    "transport_lost_recovers_idle",
    callA.getState().state === CALL_STATE.IDLE ? "PASS" : "FAIL",
    callA.getState().state
  );
  // Can start again after recover
  const again = await callA.startCall();
  record("restart_after_recover", again.ok ? "PASS" : "FAIL", again.reason || "");
  drv.close();
  cust.close();
}

// Media not ready
{
  const pair = createLoopbackTransportPair();
  const bridge = createFakeMediaBridge({ ready: false });
  const drv = createConversationSession({
    conversationId: "ride:call4",
    role: "driver",
    transport: pair.a,
  });
  const call = drv.enableCall({ mediaBridge: bridge });
  const res = await call.startCall();
  record("blocks_when_media_not_ready", !res.ok && res.reason === "media_not_ready" ? "PASS" : "FAIL");
  drv.close();
}

// Stress: rapid accept/end cycles
{
  const pair = createLoopbackTransportPair();
  const bridgeA = createFakeMediaBridge();
  const bridgeB = createFakeMediaBridge();
  const drv = createConversationSession({
    conversationId: "ride:call5",
    role: "driver",
    transport: pair.a,
  });
  const cust = createConversationSession({
    conversationId: "ride:call5",
    role: "customer",
    transport: pair.b,
  });
  const callA = drv.enableCall({ mediaBridge: bridgeA });
  const callB = cust.enableCall({ mediaBridge: bridgeB });
  let cyclesOk = 0;
  for (let i = 0; i < 8; i += 1) {
    const s = await callA.startCall();
    if (!s.ok) break;
    await waitFor(() => callB.getState().state === CALL_STATE.INCOMING, 300);
    const a = await callB.acceptCall();
    if (!a.ok) break;
    await waitFor(() => callA.getState().state === CALL_STATE.ACTIVE, 300);
    callA.endCall();
    await waitFor(() => callB.getState().state === CALL_STATE.IDLE, 300);
    if (callA.getState().state === CALL_STATE.IDLE) cyclesOk += 1;
  }
  record("stress_8_call_cycles", cyclesOk === 8 ? "PASS" : "FAIL", `ok=${cyclesOk}`);
  drv.close();
  cust.close();
}

// Peer media bridge export + UI markers
{
  const peer = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-peer-session.mjs"), "utf8");
  record(
    "peer_session_has_media_bridge",
    peer.includes("createMediaBridge") && peer.includes("ensureLocalAudio") ? "PASS" : "FAIL"
  );
  const custPeer = fs.readFileSync(path.join(ROOT, "customer-app/js/p2p-peer-session.mjs"), "utf8");
  record(
    "customer_peer_media_bridge_synced",
    custPeer.includes("createMediaBridge") ? "PASS" : "FAIL"
  );
  const panel = fs.readFileSync(path.join(ROOT, "shared/js/p2p-comm-panel.mjs"), "utf8");
  record(
    "panel_call_controls",
    panel.includes("data-comm-call") &&
      panel.includes("data-comm-call-mute") &&
      panel.includes("data-comm-call-speaker") &&
      panel.includes("data-comm-call-end") &&
      panel.includes("data-comm-call-accept")
      ? "PASS"
      : "FAIL"
  );
  record(
    "no_video_in_call_module",
    !fs.readFileSync(path.join(ROOT, "shared/js/p2p-comm-call.mjs"), "utf8").includes("video: true")
      ? "PASS"
      : "FAIL"
  );
  const wrappersOk = ["customer-app/js/p2p-comm-call.mjs", "driver-app/js/p2p-comm-call.mjs"].every(
    (f) => fs.existsSync(path.join(ROOT, f))
  );
  record("call_wrappers_synced", wrappersOk ? "PASS" : "FAIL");
  const ctrlD = fs.readFileSync(path.join(ROOT, "driver-app/js/p2p-ride-controller.mjs"), "utf8");
  const ctrlC = fs.readFileSync(path.join(ROOT, "customer-app/js/p2p-ride-controller.mjs"), "utf8");
  record(
    "controllers_expose_media_bridge",
    ctrlD.includes("createMediaBridge") && ctrlC.includes("createMediaBridge") ? "PASS" : "FAIL"
  );
}

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      phase: 4,
      title: "P2P Communication — Voice Call",
      generatedAt: new Date().toISOString(),
      summary: { passed, failed, total: results.length },
      results,
    },
    null,
    2
  )
);
console.log(`\nPhase 4: ${passed}/${results.length} PASS → ${path.relative(ROOT, OUT)}`);
process.exit(failed ? 1 : 0);
