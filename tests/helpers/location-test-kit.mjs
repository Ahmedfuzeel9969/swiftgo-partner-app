export function clock(start = 1_000_000) {
  let now = start, id = 0;
  const timers = new Map();
  const set = (fn, delay, repeat = false) => { const key = ++id; timers.set(key, { fn, due: now + Math.max(1, delay), delay, repeat }); return key; };
  return {
    now: () => now,
    setTimeout: (fn, delay) => set(fn, delay), clearTimeout: (key) => timers.delete(key),
    setInterval: (fn, delay) => set(fn, delay, true), clearInterval: (key) => timers.delete(key),
    advance(ms) {
      const target = now + ms;
      for (let n = 0; n < 10_000; n++) {
        const first = [...timers].filter(([, v]) => v.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!first) break;
        const [key, item] = first; now = item.due; timers.delete(key);
        if (item.repeat) timers.set(key, { ...item, due: now + item.delay });
        item.fn();
      }
      now = target;
    },
    count: () => timers.size,
  };
}

export class Channel {
  readyState = "connecting"; bufferedAmount = 0; sent = []; remote = null; label = "swiftgo-loc-v1";
  send(raw) { this.sent.push(JSON.parse(raw)); this.remote?.onmessage?.({ data: raw }); }
  close() { this.readyState = "closed"; }
  open() { this.readyState = "open"; this.onopen?.(); }
  addEventListener() {} removeEventListener() {}
}

export function rtcFactory() {
  const instances = [];
  class Peer {
    iceGatheringState = "complete"; iceConnectionState = "connected"; connectionState = "connected";
    localDescription = null; remoteDescription = null;
    constructor() { instances.push(this); }
    createDataChannel() { this.channel = new Channel(); return this.channel; }
    async createOffer() { return { type: "offer", sdp: "v=0\r\no=- test offer\r\n" }; }
    async createAnswer() { return { type: "answer", sdp: "v=0\r\no=- test answer\r\n" }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async getStats() { return new Map(); }
    addEventListener() {} removeEventListener() {} close() {}
  }
  return { Peer, instances };
}

export async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
export const ride = { id: "ride-phase-two", userId: "customer", driverId: "driver", vehicleId: "car", status: "accepted", assignmentSessionToken: "assignment_one_123" };
