/**
 * Durable per-ride local counter store for location reporting (driver + customer).
 * Persists assignment-bound counters until upload ack (Task 4+) or manual clear.
 * Diagnostic only — never affects ride execution paths.
 */

import {
  createEmptyCustomerCounters,
  createEmptyDriverCounters,
  validateCustomerSubmitSection,
  validateDriverSubmitSection,
  isValidAssignmentSessionTokenHash,
  isValidRideIdForReport,
} from "./ride-location-report-schema.mjs";

export const RIDE_LOCATION_LOCAL_COUNTER_STORE_VERSION = 1;
const STORAGE_PREFIX = "swiftgo_rlcs";

/** @typedef {"driver" | "customer"} RideLocationCounterRole */

/** In-memory storage adapter for unit tests. */
export function createMemoryStorageAdapter() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

/** Browser localStorage adapter with graceful failure. */
export function createBrowserLocalStorageAdapter() {
  const ls = typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
  return {
    getItem(key) {
      if (!ls) return null;
      try {
        return ls.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      if (!ls) return false;
      try {
        ls.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    removeItem(key) {
      if (!ls) return;
      try {
        ls.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

function storageKey(role, rideId, tokenHash) {
  return `${STORAGE_PREFIX}:v${RIDE_LOCATION_LOCAL_COUNTER_STORE_VERSION}:${role}:${rideId}:${tokenHash}`;
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createEmptyState(role) {
  const isDriver = role === "driver";
  return {
    schemaVersion: RIDE_LOCATION_LOCAL_COUNTER_STORE_VERSION,
    role,
    rideId: "",
    assignmentSessionTokenHash: "",
    submitSequence: 0,
    counters: isDriver ? createEmptyDriverCounters() : createEmptyCustomerCounters(),
    firstFixAtMs: null,
    lastFixAtMs: null,
    firstRenderedAtMs: null,
    lastRenderedAtMs: null,
    longestGapMs: null,
    lastEventAtMs: null,
    visibleDurationMs: 0,
    backgroundDurationMs: 0,
    updatedAtMs: Date.now(),
  };
}

function cloneState(state) {
  return {
    ...state,
    counters: { ...state.counters },
  };
}

function allowedCounterKeys(role) {
  return role === "driver"
    ? Object.keys(createEmptyDriverCounters())
    : Object.keys(createEmptyCustomerCounters());
}

/**
 * @param {{
 *   role: RideLocationCounterRole,
 *   storage?: { getItem: Function, setItem: Function, removeItem: Function },
 *   nowMs?: () => number,
 * }} options
 */
export function createRideLocationLocalCounterStore(options) {
  const role = options?.role;
  if (role !== "driver" && role !== "customer") {
    throw new Error("createRideLocationLocalCounterStore requires role driver or customer");
  }

  const storage = options?.storage || createBrowserLocalStorageAdapter();
  const nowMs = typeof options?.nowMs === "function" ? options.nowMs : () => Date.now();
  let state = createEmptyState(role);
  let persistenceEnabled = true;

  function persist() {
    if (!persistenceEnabled) return false;
    if (!state.rideId || !state.assignmentSessionTokenHash) return false;
    const key = storageKey(role, state.rideId, state.assignmentSessionTokenHash);
    state.updatedAtMs = nowMs();
    try {
      storage.setItem(key, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  }

  function loadFromStorage(rideId, tokenHash) {
    const key = storageKey(role, rideId, tokenHash);
    const parsed = safeParse(storage.getItem(key));
    if (
      !parsed ||
      parsed.schemaVersion !== RIDE_LOCATION_LOCAL_COUNTER_STORE_VERSION ||
      parsed.role !== role ||
      parsed.rideId !== rideId ||
      parsed.assignmentSessionTokenHash !== tokenHash
    ) {
      return createEmptyState(role);
    }
    const empty = createEmptyState(role);
    return {
      ...empty,
      ...parsed,
      counters: { ...empty.counters, ...(parsed.counters || {}) },
    };
  }

  function bind(input) {
    const rideId = input?.rideId;
    const tokenHash = input?.assignmentSessionTokenHash;
    if (!isValidRideIdForReport(rideId) || !isValidAssignmentSessionTokenHash(tokenHash)) {
      return { ok: false, reason: "invalid_binding" };
    }

    const sameBinding =
      state.rideId === rideId && state.assignmentSessionTokenHash === tokenHash;
    if (!sameBinding) {
      state = loadFromStorage(rideId, tokenHash);
      if (state.rideId !== rideId) {
        state = createEmptyState(role);
        state.rideId = rideId;
        state.assignmentSessionTokenHash = tokenHash;
        persist();
      }
    }

    return { ok: true, binding: { rideId, assignmentSessionTokenHash: tokenHash } };
  }

  function isBound() {
    return (
      isValidRideIdForReport(state.rideId) &&
      isValidAssignmentSessionTokenHash(state.assignmentSessionTokenHash)
    );
  }

  function incrementCounter(counterKey, delta = 1) {
    if (!isBound()) return { ok: false, reason: "not_bound" };
    if (!allowedCounterKeys(role).includes(counterKey)) {
      return { ok: false, reason: "unknown_counter" };
    }
    if (typeof delta !== "number" || !Number.isFinite(delta) || !Number.isInteger(delta) || delta < 0) {
      return { ok: false, reason: "invalid_delta" };
    }
    state.counters[counterKey] = (state.counters[counterKey] || 0) + delta;
    persist();
    return { ok: true, value: state.counters[counterKey] };
  }

  function recordEventAtMs(eventMs) {
    if (!isBound()) return { ok: false, reason: "not_bound" };
    if (typeof eventMs !== "number" || !Number.isFinite(eventMs) || eventMs <= 0) {
      return { ok: false, reason: "invalid_event_ms" };
    }

    if (role === "driver") {
      if (state.firstFixAtMs == null || eventMs < state.firstFixAtMs) state.firstFixAtMs = eventMs;
      if (state.lastFixAtMs == null || eventMs > state.lastFixAtMs) state.lastFixAtMs = eventMs;
    } else {
      if (state.firstRenderedAtMs == null || eventMs < state.firstRenderedAtMs) {
        state.firstRenderedAtMs = eventMs;
      }
      if (state.lastRenderedAtMs == null || eventMs > state.lastRenderedAtMs) {
        state.lastRenderedAtMs = eventMs;
      }
    }

    if (state.lastEventAtMs != null && eventMs > state.lastEventAtMs) {
      const gap = eventMs - state.lastEventAtMs;
      if (state.longestGapMs == null || gap > state.longestGapMs) state.longestGapMs = gap;
    }
    state.lastEventAtMs = eventMs;
    persist();
    return { ok: true };
  }

  function addVisibleDurationMs(ms) {
    if (role !== "customer") return { ok: false, reason: "driver_role" };
    if (!isBound()) return { ok: false, reason: "not_bound" };
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || !Number.isInteger(ms)) {
      return { ok: false, reason: "invalid_duration" };
    }
    state.visibleDurationMs += ms;
    persist();
    return { ok: true, value: state.visibleDurationMs };
  }

  function addBackgroundDurationMs(ms) {
    if (role !== "customer") return { ok: false, reason: "driver_role" };
    if (!isBound()) return { ok: false, reason: "not_bound" };
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || !Number.isInteger(ms)) {
      return { ok: false, reason: "invalid_duration" };
    }
    state.backgroundDurationMs += ms;
    persist();
    return { ok: true, value: state.backgroundDurationMs };
  }

  function bumpSubmitSequence() {
    if (!isBound()) return { ok: false, reason: "not_bound" };
    state.submitSequence += 1;
    persist();
    return { ok: true, value: state.submitSequence };
  }

  function snapshotSection() {
    if (!isBound()) return null;
    if (role === "driver") {
      return {
        counters: { ...state.counters },
        firstFixAtMs: state.firstFixAtMs,
        lastFixAtMs: state.lastFixAtMs,
        longestGapMs: state.longestGapMs,
        submitSequence: state.submitSequence,
      };
    }
    return {
      counters: { ...state.counters },
      firstRenderedAtMs: state.firstRenderedAtMs,
      lastRenderedAtMs: state.lastRenderedAtMs,
      longestGapMs: state.longestGapMs,
      visibleDurationMs: state.visibleDurationMs,
      backgroundDurationMs: state.backgroundDurationMs,
      submitSequence: state.submitSequence,
    };
  }

  function snapshot() {
    if (!isBound()) return null;
    const section = snapshotSection();
    const validated =
      role === "driver"
        ? validateDriverSubmitSection(section)
        : validateCustomerSubmitSection(section);
    if (!validated.ok) return null;
    return cloneState(state);
  }

  function clear() {
    if (!isBound()) {
      state = createEmptyState(role);
      return { ok: true };
    }
    const key = storageKey(role, state.rideId, state.assignmentSessionTokenHash);
    storage.removeItem(key);
    state = createEmptyState(role);
    return { ok: true };
  }

  function setPersistenceEnabled(enabled) {
    persistenceEnabled = enabled === true;
  }

  function applyCounterSnapshot(counters) {
    if (!isBound()) return { ok: false, reason: "not_bound" };
    if (counters == null || typeof counters !== "object") {
      return { ok: false, reason: "invalid_counters" };
    }
    for (const key of allowedCounterKeys(role)) {
      const value = counters[key];
      if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0) {
        state.counters[key] = Math.max(state.counters[key] || 0, value);
      }
    }
    persist();
    return { ok: true };
  }

  return {
    bind,
    isBound,
    incrementCounter,
    recordEventAtMs,
    addVisibleDurationMs,
    addBackgroundDurationMs,
    bumpSubmitSequence,
    applyCounterSnapshot,
    snapshotSection,
    snapshot,
    clear,
    setPersistenceEnabled,
    getBinding() {
      return isBound()
        ? { rideId: state.rideId, assignmentSessionTokenHash: state.assignmentSessionTokenHash }
        : null;
    },
  };
}
