/**
 * Regression: a frozen customer can leave WebRTC readyState="open" while LOC
 * acknowledgements have stopped. Outbound driver sends must not keep that
 * zombie channel healthy forever.
 * Run: node tests/p2p-screen-off-reconnect.mjs
 */
import { createP2pPeerSession } from "../driver-app/js/p2p-peer-session.mjs";
import {
  P2P_FALLBACK_AFTER_MS,
  P2P_STATE,
} from "../driver-app/js/p2p-protocol.mjs";

let now = 1;

function MockRTCPeerConnection() {
  const peer = {
    iceGatheringState: "complete",
    localDescription: null,
    createDataChannel() {
      return {
        readyState: "connecting",
        bufferedAmount: 0,
        send() {},
        close() {},
      };
    },
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=- offer\r\n" };
    },
    async setLocalDescription(desc) {
      peer.localDescription = desc;
    },
    async setRemoteDescription() {},
    addEventListener() {},
    removeEventListener() {},
    close() {},
  };
  return peer;
}

let reconnectRequests = 0;
const sent = [];
const session = createP2pPeerSession({
  role: "driver",
  RTCPeerConnection: MockRTCPeerConnection,
  nowMs: () => now,
  setTimeoutFn: () => 1,
  clearTimeoutFn: () => {},
  onNeedReconnect: () => {
    reconnectRequests += 1;
  },
});

await session.startAsDriver({
  trackingSessionId: "trk_screen_off",
  assignmentVersion: 7,
});
session._setChannelOpenForTest(true, (payload) => sent.push(JSON.parse(payload)));
session.enqueueLocationFix({ lat: 24.86, lng: 67.01, observedAt: now });

const ids = session.getState();
session._handleMessageForTest(
  JSON.stringify({
    v: 1,
    type: "ack",
    peerSessionId: ids.peerSessionId,
    trackingSessionId: ids.trackingSessionId,
    assignmentVersion: ids.assignmentVersion,
    seq: 1,
    ackKind: "loc",
    observedAt: now,
    role: "customer",
  }),
  ids.generation
);

if (session.getState().state !== P2P_STATE.P2P_HEALTHY) {
  throw new Error(`expected initial healthy state, got ${session.getState().state}`);
}

now += P2P_FALLBACK_AFTER_MS + 1;
session.enqueueLocationFix({ lat: 24.861, lng: 67.011, observedAt: now });
session.evaluateHealth();

if (sent.filter((message) => message.type === "loc").length !== 2) {
  throw new Error("expected a newer unacknowledged location frame");
}
if (session.getState().state !== P2P_STATE.FIREBASE_FALLBACK) {
  throw new Error(`zombie channel did not enter fallback: ${session.getState().state}`);
}
if (reconnectRequests !== 1) {
  throw new Error(`expected one fresh-offer request, got ${reconnectRequests}`);
}

console.log("p2p-screen-off-reconnect: 3 PASS / 0 FAIL");
