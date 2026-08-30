/** One bounded renewal loop per signaling identity; no location or secrets. */
export function timestampMs(value) {
  if (value?.toMillis) return Number(value.toMillis());
  if (value instanceof Date) return value.getTime();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  return Number(value) || 0;
}

export function createPeerSessionLease(opts = {}) {
  const now = opts.nowMs || Date.now, setT = opts.setTimeoutFn || setTimeout, clearT = opts.clearTimeoutFn || clearTimeout;
  let identity = "", expiresAt = 0, generation = 0, timer = 0, attempts = 0, running = false, expired = false;
  let cancelRequest = null;
  function stop() {
    generation++; clearT(timer); timer = 0; cancelRequest?.(); cancelRequest = null;
    identity = ""; expiresAt = 0; attempts = 0; running = false; expired = false;
  }
  function schedule(delay) {
    clearT(timer); const gen = generation;
    timer = setT(() => { timer = 0; if (gen === generation) void tick(gen); }, Math.max(1, delay));
  }
  function expiredNow() {
    if (now() < expiresAt) return false;
    if (!expired) { expired = true; opts.onExpired?.(); }
    return true;
  }
  async function tick(gen) {
    if (!identity || expiredNow()) return;
    if (!opts.renew) { schedule(expiresAt - now()); return; }
    if (running) return;
    running = true;
    const result = await new Promise((resolve) => {
      let settled = false, timeout;
      const finish = (value) => { if (settled) return; settled = true; clearT(timeout); if (cancelRequest === cancel) cancelRequest = null; resolve(value); };
      const cancel = () => finish(null); cancelRequest = cancel;
      timeout = setT(cancel, Math.min(10000, Math.max(1, expiresAt - now())));
      Promise.resolve().then(() => opts.renew()).then(finish, () => finish(null));
    });
    if (gen !== generation) return;
    running = false;
    if (expiredNow()) return;
    const next = timestampMs(result?.expiresAtMs);
    if (result?.ok && next > expiresAt) { expiresAt = next; attempts = 0; schedule(Math.max(1000, next - now() - 300000)); }
    else { attempts++; schedule(Math.min(expiresAt - now(), 60000, 10000 * 2 ** Math.min(3, attempts - 1))); }
  }
  function observe(key, expiry) {
    const next = timestampMs(expiry);
    if (!key || !Number.isFinite(next) || next <= 0) return;
    if (identity !== key) { stop(); identity = key; }
    if (next <= expiresAt) return;
    expiresAt = next; expired = false;
    if (!running) schedule(opts.renew ? Math.max(1000, next - now() - 300000) : next - now());
  }
  return { observe, stop, getState: () => ({ expiresAt, attempts, running, expired }) };
}
