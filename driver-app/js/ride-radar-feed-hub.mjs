/**
 * Small in-memory fan-out for the driver's ride radar.
 *
 * One Firestore listener publishes here; the background badge and the visible
 * list consume the same immutable snapshot instead of opening parallel feeds.
 */
export function createRideRadarFeedHub() {
  let currentState = null;
  const listeners = new Set();

  function publish(nextState) {
    currentState = nextState || { rides: [], source: "remote", syncing: false };
    for (const listener of [...listeners]) {
      try {
        listener(currentState);
      } catch (error) {
        console.warn("[SwiftGo Radar] state consumer", error);
      }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    if (currentState) listener(currentState);
    return () => listeners.delete(listener);
  }

  return {
    publish,
    subscribe,
    clear() {
      currentState = null;
    },
    getState() {
      return currentState;
    },
    listenerCount() {
      return listeners.size;
    },
  };
}
