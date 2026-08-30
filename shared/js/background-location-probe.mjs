import { normalizeRuntimeDeliveryPolicy, resolveLocationDeliveryPolicy } from "./location-delivery-policy.mjs";

/** One bounded hidden-screen recovery read; never overlaps or resurrects an old ride. */
export function createBackgroundLocationProbe(opts = {}) {
  const setT = opts.setTimeoutFn || setTimeout, clearT = opts.clearTimeoutFn || clearTimeout;
  let policy = { ...resolveLocationDeliveryPolicy(), firebaseFallbackEnabled: false };
  let generation = 0, timer = null, active = false;
  let pending = false;
  function stop() { generation++; active = false; if (timer != null) clearT(timer); timer = null; }
  function arm(gen) {
    if (!active || gen !== generation || !policy.firebaseFallbackEnabled || !policy.customerBackgroundReadIntervalMs) return;
    timer = setT(async () => {
      timer = null;
      if (!active || gen !== generation) return;
      const target = opts.getTarget?.();
      if (target && !pending && opts.shouldRead?.() === true) {
        pending = true;
        try {
          const data = await opts.read(target);
          if (gen === generation && active && opts.getTarget?.()?.key === target.key && opts.shouldRead?.() === true) opts.onData?.(data);
        } catch { /* next policy-bounded probe retries */ }
        finally { pending = false; }
      }
      arm(gen);
    }, policy.customerBackgroundReadIntervalMs);
  }
  function start() { stop(); active = true; arm(generation); }
  return {
    start, stop,
    configureDeliveryPolicy(next) {
      const before = policy; policy = normalizeRuntimeDeliveryPolicy(next, policy);
      if (active && (before.firebaseFallbackEnabled !== policy.firebaseFallbackEnabled ||
          before.customerBackgroundReadIntervalMs !== policy.customerBackgroundReadIntervalMs)) start();
    },
  };
}
