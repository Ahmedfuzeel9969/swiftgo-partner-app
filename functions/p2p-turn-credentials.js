/**
 * Server-only coturn/Cloudflare credential adapter. No long-lived key ever leaves
 * the function. Live issuance is separately enabled and bound to an active ride.
 */
"use strict";
const crypto = require("crypto");
const { normalizeTurnServer } = require("./p2p-ice-config");
const MIN_TTL_SEC = 3600, MAX_TTL_SEC = 43200, DEFAULT_TTL_SEC = 3600;

function parseTurnUrls(raw) {
  return (Array.isArray(raw) ? raw : String(raw || "").split(/[,;\n]+/)).map((s) => String(s).trim()).filter(Boolean);
}
function readTurnConfig(env = process.env) {
  let raw = null;
  if (env.P2P_TURN_CONFIG) {
    try { raw = JSON.parse(env.P2P_TURN_CONFIG); } catch { return null; }
  } else {
    // Compatibility for existing server-side coturn setups; new deployments use
    // the opt-in Secret Manager JSON binding in index.js.
    raw = { provider: "coturn", urls: env.P2P_TURN_URLS || env.TURN_URLS,
      secret: env.P2P_TURN_SECRET || env.TURN_SECRET, ttlSec: env.P2P_TURN_TTL_SEC || env.TURN_TTL_SEC };
  }
  const ttlSec = Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, Math.floor(Number(raw?.ttlSec)) || DEFAULT_TTL_SEC));
  if (raw?.provider === "cloudflare") {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(raw.keyId || "") || typeof raw.apiToken !== "string" || raw.apiToken.length < 16) return null;
    return { provider: "cloudflare", keyId: raw.keyId, apiToken: raw.apiToken, ttlSec };
  }
  if (raw?.provider !== "coturn" || typeof raw.secret !== "string" || !raw.secret.trim()) return null;
  const turn = normalizeTurnServer({ urls: parseTurnUrls(raw.urls), username: "validate", credential: "validate" });
  return turn ? { provider: "coturn", urls: turn.urls, secret: raw.secret.trim(), ttlSec } : null;
}
function buildTurnUsername(uid, ttlSec, nowSec = Math.floor(Date.now() / 1000)) {
  return `${nowSec + ttlSec}:${String(uid || "anon").slice(0, 128)}`;
}
function buildTurnCredential(secret, username) {
  return crypto.createHmac("sha1", secret).update(username).digest("base64");
}
async function cloudflareCredentials(cfg, { fetchFn = globalThis.fetch } = {}) {
  try {
    const res = await fetchFn(`https://rtc.live.cloudflare.com/v1/turn/keys/${cfg.keyId}/credentials/generate-ice-servers`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${cfg.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: cfg.ttlSec }),
    });
    if (!res.ok) return { configured: false, reason: "TURN_PROVIDER_UNAVAILABLE" };
    const body = await res.json();
    const entries = Array.isArray(body?.iceServers) ? body.iceServers : [body?.iceServers];
    const servers = entries.map(normalizeTurnServer).filter(Boolean);
    if (!servers.length) return { configured: false, reason: "TURN_PROVIDER_INVALID_RESPONSE" };
    // Cloudflare returns one credential pair with multiple UDP/TCP/TLS URLs.
    const first = servers[0];
    const turn = normalizeTurnServer({ ...first, urls: servers.filter((s) => s.username === first.username && s.credential === first.credential).flatMap((s) => s.urls) });
    return { configured: true, ttlMs: cfg.ttlSec * 1000, turn };
  } catch {
    // Never surface the request, Authorization header, response body or SDK error.
    return { configured: false, reason: "TURN_PROVIDER_UNAVAILABLE" };
  }
}
function issueP2pTurnCredentials({ uid }, opts = {}) {
  const cfg = opts.config || readTurnConfig();
  if (!cfg) return { configured: false, reason: "TURN_NOT_CONFIGURED" };
  if (cfg.provider === "cloudflare") return cloudflareCredentials(cfg, opts);
  const username = buildTurnUsername(uid, cfg.ttlSec, Math.floor((opts.nowMs || Date.now)() / 1000));
  return { configured: true, ttlMs: cfg.ttlSec * 1000, turn: { urls: cfg.urls, username, credential: buildTurnCredential(cfg.secret, username) } };
}

async function issueRideTurnCredentials(db, input, opts = {}) {
  const uid = String(input?.uid || ""), rideId = String(input?.rideId || "");
  const fail = (code, message) => { const err = new Error(message); err.code = code; throw err; };
  if (!uid) fail("unauthenticated", "AUTH_REQUIRED");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(rideId)) fail("invalid-argument", "INVALID_RIDE_ID");
  const cfg = opts.enabled === true ? (opts.config || readTurnConfig()) : null;
  const now = (opts.nowMs || Date.now)();
  const pseudonym = crypto.createHash("sha256").update(`${uid}|${rideId}|${input.assignmentId || ""}`).digest("hex");
  const rideRef = db.collection("rides").doc(rideId);
  const rateRef = rideRef.collection("peerCredentialIssues").doc(crypto.createHash("sha256").update(uid).digest("hex"));
  await db.runTransaction(async (tx) => {
    const rideSnap = await tx.get(rideRef), ride = rideSnap.exists ? rideSnap.data() : null;
    if (!ride || !["accepted", "arrived", "in_progress"].includes(ride.status)) fail("failed-precondition", "RIDE_NOT_TRACKABLE");
    if (ride.userId !== uid && ride.driverId !== uid) fail("permission-denied", "NOT_RIDE_PARTICIPANT");
    if (!ride.driverId || !ride.vehicleId || !ride.assignmentSessionToken || input.assignmentId !== ride.assignmentSessionToken) fail("failed-precondition", "STALE_ASSIGNMENT");
    if (!cfg) return;
    const previous = await tx.get(rateRef);
    const last = previous.data()?.issuedAt?.toMillis?.() || 0;
    if (last && now - last < 30000) fail("resource-exhausted", "TURN_RETRY_LATER");
    // One fixed metadata document per participant/ride; credentials are NEVER stored.
    tx.set(rateRef, { issuedAt: new Date(now), expiresAt: new Date(now + cfg.ttlSec * 1000 + 60000) });
  });
  if (!cfg) return { configured: false, reason: "TURN_NOT_CONFIGURED" };
  const issued = await issueP2pTurnCredentials({ uid: pseudonym }, { ...opts, config: cfg });
  // Provider I/O may finish after cancellation/reassignment. Do not return that
  // credential to a stale caller. Already-issued credentials still expire by TTL.
  const latest = (await rideRef.get()).data();
  if (!latest || !["accepted", "arrived", "in_progress"].includes(latest.status) ||
      latest.assignmentSessionToken !== input.assignmentId || (latest.userId !== uid && latest.driverId !== uid))
    fail("failed-precondition", "STALE_ASSIGNMENT");
  return issued;
}

module.exports = { issueP2pTurnCredentials, issueRideTurnCredentials, buildTurnUsername, buildTurnCredential, parseTurnUrls, readTurnConfig };
