/** Per-client safety budget. Not a fleet-wide provider quota or an SLA. */
export function createRouteRequestGuard(opts = {}) {
  const now = opts.nowMs || Date.now, setT = opts.setTimeoutFn || setTimeout, clearT = opts.clearTimeoutFn || clearTimeout;
  const timeoutMs = Math.max(100, Math.min(30_000, Number(opts.timeoutMs) || 12_000));
  let nextStart = 0, blockedUntil = 0, failures = 0, pending = 0;
  const starts = [];
  const error = (code) => Object.assign(new Error(code.toUpperCase()), { code });
  async function run(task, { signal } = {}) {
    if (signal?.aborted) throw error("aborted");
    while (starts.length && starts[0] <= now() - 60_000) starts.shift();
    if (now() < blockedUntil || starts.length >= 6 || pending >= 2) throw error("provider_cooldown");
    const startAt = Math.max(now(), nextStart); nextStart = startAt + 1000;
    starts.push(startAt); pending++;
    const ctrl = new AbortController(); let deadline, delayTimer, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const cancel = (code) => { ctrl.abort(); rejectAbort(error(code)); };
    const onAbort = () => cancel("aborted"); signal?.addEventListener("abort", onAbort, { once: true });
    deadline = setT(() => cancel("timeout"), timeoutMs);
    try {
      if (startAt > now()) await Promise.race([aborted, new Promise((resolve) => { delayTimer = setT(resolve, startAt - now()); })]);
      if (ctrl.signal.aborted) throw error(signal?.aborted ? "aborted" : "timeout");
      const value = await Promise.race([aborted, Promise.resolve().then(() => task(ctrl.signal))]);
      failures = 0;
      return value;
    } catch (e) {
      if (e?.code !== "aborted") {
        failures++;
        const retryAfter = Math.min(300_000, Math.max(0, Number(e?.retryAfterMs) || 0));
        if (retryAfter || failures >= 3) blockedUntil = Math.max(blockedUntil, now() + (retryAfter || 60_000));
      }
      throw e;
    } finally {
      pending--; clearT(deadline); if (delayTimer != null) clearT(delayTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return { run, getState: () => ({ pending, blockedUntil, failures, requestsInWindow: starts.length }) };
}
