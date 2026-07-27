/**
 * Phase 2B — PIN hashing + attempt lockout helpers (Admin SDK / CF).
 * Pepper is application-level; plaintext PIN must never be logged or returned.
 */

"use strict";

const crypto = require("crypto");

const PIN_PEPPER = "swiftgo-phase2b-pin-v1";
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function hashVehiclePin(pin) {
  const normalized = String(pin || "").trim();
  return crypto.createHash("sha256").update(`${PIN_PEPPER}:${normalized}`, "utf8").digest("hex");
}

function isValidPinFormat(pin) {
  return /^\d{4}$/.test(String(pin || "").trim());
}

/**
 * @returns {{ allowed: boolean, remaining?: number, lockedUntil?: number, reason?: string }}
 */
function evaluatePinAttemptGate(attemptDoc, nowMs = Date.now()) {
  const data = attemptDoc || {};
  const lockedUntil = Number(data.lockedUntilMs || 0);
  if (lockedUntil && lockedUntil > nowMs) {
    return { allowed: false, reason: "PIN_LOCKED", lockedUntil };
  }
  const fails = Math.max(0, Number(data.failCount || 0));
  if (fails >= MAX_PIN_ATTEMPTS && lockedUntil && lockedUntil > nowMs) {
    return { allowed: false, reason: "PIN_LOCKED", lockedUntil };
  }
  return { allowed: true, remaining: Math.max(0, MAX_PIN_ATTEMPTS - fails) };
}

function nextFailState(attemptDoc, nowMs = Date.now()) {
  const prev = attemptDoc || {};
  const lockedUntilPrev = Number(prev.lockedUntilMs || 0);
  let fails = Math.max(0, Number(prev.failCount || 0));
  if (lockedUntilPrev && lockedUntilPrev <= nowMs) {
    fails = 0;
  }
  fails += 1;
  if (fails >= MAX_PIN_ATTEMPTS) {
    return {
      failCount: fails,
      lockedUntilMs: nowMs + LOCKOUT_MS,
      updatedAtMs: nowMs,
    };
  }
  return {
    failCount: fails,
    lockedUntilMs: 0,
    updatedAtMs: nowMs,
  };
}

function resetPinAttempts(nowMs = Date.now()) {
  return { failCount: 0, lockedUntilMs: 0, updatedAtMs: nowMs };
}

module.exports = {
  PIN_PEPPER,
  MAX_PIN_ATTEMPTS,
  LOCKOUT_MS,
  hashVehiclePin,
  isValidPinFormat,
  evaluatePinAttemptGate,
  nextFailState,
  resetPinAttempts,
};
