/**
 * Phase 3 — ephemeral TURN credentials (coturn REST API / time-limited HMAC).
 * Secrets live in environment only — never in client source or Firestore.
 */

"use strict";

const crypto = require("crypto");

const MIN_TTL_SEC = 3600;
const MAX_TTL_SEC = 43200;
const DEFAULT_TTL_SEC = 43200;

function parseTurnUrls(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readTurnConfig() {
  const urls = parseTurnUrls(process.env.P2P_TURN_URLS || process.env.TURN_URLS || "");
  const secret = String(process.env.P2P_TURN_SECRET || process.env.TURN_SECRET || "").trim();
  if (!urls.length || !secret) return null;
  const ttlRaw = Number(process.env.P2P_TURN_TTL_SEC || process.env.TURN_TTL_SEC || DEFAULT_TTL_SEC);
  const ttlSec = Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, Math.floor(ttlRaw) || DEFAULT_TTL_SEC));
  return { urls, secret, ttlSec };
}

function buildTurnUsername(uid, ttlSec, nowSec = Math.floor(Date.now() / 1000)) {
  const expiry = nowSec + ttlSec;
  const user = String(uid || "anon").slice(0, 128);
  return `${expiry}:${user}`;
}

function buildTurnCredential(secret, username) {
  return crypto.createHmac("sha1", secret).update(username).digest("base64");
}

/**
 * @param {{ uid: string }} params
 */
function issueP2pTurnCredentials({ uid }) {
  const cfg = readTurnConfig();
  if (!cfg) {
    return {
      configured: false,
      reason: "TURN_NOT_CONFIGURED",
    };
  }

  const username = buildTurnUsername(uid, cfg.ttlSec);
  const credential = buildTurnCredential(cfg.secret, username);

  return {
    configured: true,
    ttlMs: cfg.ttlSec * 1000,
    turn: {
      urls: cfg.urls,
      username,
      credential,
    },
  };
}

module.exports = {
  issueP2pTurnCredentials,
  buildTurnUsername,
  buildTurnCredential,
  parseTurnUrls,
  readTurnConfig,
};
