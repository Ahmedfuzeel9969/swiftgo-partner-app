/** Demand-driven location-only listener. Ride/signaling listeners are not owned here. */
export function createFallbackLocationWatch(opts = {}) {
  const setT = opts.setTimeoutFn || setTimeout, clearT = opts.clearTimeoutFn || clearTimeout;
  let binding = null, needed = false, generation = 0, unsubscribe = null, retry = null, attempts = 0;
  function detach() {
    generation++;
    if (retry != null) clearT(retry);
    retry = null;
    const close = unsubscribe; unsubscribe = null;
    close?.();
  }
  function attach() {
    if (!binding || !needed || unsubscribe || retry != null || !opts.subscribe) return;
    const gen = ++generation, target = binding;
    let failed = false;
    const onError = () => {
      if (gen !== generation) return;
      failed = true; detach(); opts.onError?.();
      const retryGen = generation;
      retry = setT(() => { retry = null; if (retryGen === generation) attach(); }, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)));
    };
    try {
      const close = opts.subscribe(target, (data) => {
        if (gen !== generation || !needed || binding !== target) return;
        attempts = 0; opts.onData?.(data);
      }, onError) || (() => {});
      // Synchronous callbacks may disable/switch/error the subscription before it returns.
      if (failed || gen !== generation) close();
      else unsubscribe = close;
    } catch { onError(); }
  }
  return {
    setBinding(next) {
      if (binding?.key === next?.key) return;
      detach(); attempts = 0; binding = next; attach();
    },
    setNeeded(next) {
      needed = next === true;
      if (!needed) { detach(); attempts = 0; } else attach();
    },
    stop() { needed = false; detach(); binding = null; attempts = 0; },
    getState: () => ({ attached: Boolean(unsubscribe), retrying: retry != null, needed, generation }),
  };
}
