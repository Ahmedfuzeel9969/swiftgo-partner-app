import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { issueP2pTurnCredentials, readTurnConfig } = require("../functions/p2p-turn-credentials.js");
const fixture = { provider: "cloudflare", keyId: "fixture_key_123456", apiToken: "fixture_api_token_not_real_123", ttlSec: 3600 };

test("browser and server validate ICE with exactly the same canonical contract", () => {
  const source = readFileSync(new URL("../shared/js/p2p-ice-config.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n").trimEnd();
  const adapter = readFileSync(new URL("../functions/p2p-ice-config.js", import.meta.url), "utf8").replace(/\r\n/g, "\n").trimEnd();
  assert.equal(adapter, "// Generated adapter of shared/js/p2p-ice-config.mjs; parity is tested.\n" + source.replaceAll("export function ", "function ") + "\nmodule.exports = { normalizeIceUrl, normalizeTurnServer };");
});
test("Cloudflare uses the pinned server endpoint and returns ephemeral UDP/TCP/TLS credentials only", async () => {
  let request;
  const result = await issueP2pTurnCredentials({ uid: "not-transmitted" }, { config: fixture, fetchFn: async (url, opts) => {
    request = { url, opts };
    return { ok: true, json: async () => ({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, { username: "temporary_user", credential: "temporary_password",
      urls: ["turn:turn.cloudflare.com:53?transport=udp", "turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"] }] }) };
  } });
  assert.equal(request.url, `https://rtc.live.cloudflare.com/v1/turn/keys/${fixture.keyId}/credentials/generate-ice-servers`);
  assert.equal(request.opts.redirect, "error"); assert.equal(request.opts.headers.Authorization, `Bearer ${fixture.apiToken}`);
  assert.deepEqual(JSON.parse(request.opts.body), { ttl: 3600 }); assert.ok(request.opts.signal);
  assert.equal(result.configured, true); assert.equal(result.turn.urls.length, 3); assert.equal(result.ttlMs, 3600000);
  assert.equal(JSON.stringify(result).includes(fixture.apiToken), false); assert.equal(JSON.stringify(result).includes("not-transmitted"), false);
});
test("provider failure, redirect/error and malformed response never leak keys or arbitrary error bodies", async () => {
  for (const fetchFn of [async () => ({ ok: false, status: 401 }), async () => { throw new Error(fixture.apiToken); },
    async () => ({ ok: true, json: async () => ({ error: fixture.apiToken }) }),
    async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: "https://not-turn.test", username: "u", credential: "p" }] }) })]) {
    const result = await issueP2pTurnCredentials({ uid: "u" }, { config: fixture, fetchFn });
    assert.equal(result.configured, false); assert.equal(JSON.stringify(result).includes(fixture.apiToken), false);
    assert.deepEqual(Object.keys(result).sort(), ["configured", "reason"]);
  }
});
test("server secret JSON rejects bad provider/key/URL and clamps credential lifetime", () => {
  assert.equal(readTurnConfig({ P2P_TURN_CONFIG: "not json" }), null);
  assert.equal(readTurnConfig({ P2P_TURN_CONFIG: JSON.stringify({ ...fixture, keyId: "../../evil" }) }), null);
  assert.equal(readTurnConfig({ P2P_TURN_CONFIG: JSON.stringify({ provider: "unknown" }) }), null);
  assert.equal(readTurnConfig({ P2P_TURN_CONFIG: JSON.stringify({ provider: "coturn", urls: ["https://evil.test"], secret: "fixture" }) }), null);
  assert.equal(readTurnConfig({ P2P_TURN_CONFIG: JSON.stringify({ ...fixture, ttlSec: 9999999 }) }).ttlSec, 43200);
});
test("only the opt-in callable binds the TURN secret; browser code never imports a provider key", () => {
  const server = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  assert.match(server, /secrets: process\.env\.P2P_TURN_ENABLED === "true" \? \["P2P_TURN_CONFIG"\] : \[\]/);
  for (const app of ["customer-app", "driver-app"]) {
    const client = readFileSync(new URL(`../${app}/js/p2p-ice-bootstrap.mjs`, import.meta.url), "utf8");
    assert.ok(client.includes("context.rideId")); assert.equal(/apiToken|P2P_TURN_CONFIG|Bearer/.test(client), false);
  }
});
