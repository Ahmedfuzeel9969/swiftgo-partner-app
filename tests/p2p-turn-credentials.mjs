/**
 * TURN credential issuance — coturn REST API HMAC unit tests.
 * Run: npm run test:p2p-turn-credentials
 */
import {
  buildTurnCredential,
  buildTurnUsername,
  issueP2pTurnCredentials,
  parseTurnUrls,
  readTurnConfig,
} from "../functions/p2p-turn-credentials.js";

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "✓" : "✗";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

function testParseTurnUrls() {
  const urls = parseTurnUrls("turn:relay.example.com:3478, turns:relay.example.com:5349");
  return urls.length === 2 && urls[0].startsWith("turn:");
}

function testBuildUsernameExpiry() {
  const user = buildTurnUsername("uid_test", 3600, 1_700_000_000);
  return user === "1700003600:uid_test";
}

function testBuildCredentialDeterministic() {
  const user = "1700003600:uid_test";
  const a = buildTurnCredential("secret123", user);
  const b = buildTurnCredential("secret123", user);
  return a === b && typeof a === "string" && a.length > 8;
}

function testNotConfiguredWithoutEnv() {
  const prevUrls = process.env.P2P_TURN_URLS;
  const prevSecret = process.env.P2P_TURN_SECRET;
  delete process.env.P2P_TURN_URLS;
  delete process.env.P2P_TURN_SECRET;
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  const res = issueP2pTurnCredentials({ uid: "u1" });
  if (prevUrls !== undefined) process.env.P2P_TURN_URLS = prevUrls;
  else delete process.env.P2P_TURN_URLS;
  if (prevSecret !== undefined) process.env.P2P_TURN_SECRET = prevSecret;
  else delete process.env.P2P_TURN_SECRET;
  return res.configured === false && res.reason === "TURN_NOT_CONFIGURED";
}

function testConfiguredWithEnv() {
  const prevUrls = process.env.P2P_TURN_URLS;
  const prevSecret = process.env.P2P_TURN_SECRET;
  process.env.P2P_TURN_URLS = "turn:relay.test:3478?transport=udp";
  process.env.P2P_TURN_SECRET = "unit_test_secret";
  const cfg = readTurnConfig();
  const res = issueP2pTurnCredentials({ uid: "driver_uid" });
  if (prevUrls !== undefined) process.env.P2P_TURN_URLS = prevUrls;
  else delete process.env.P2P_TURN_URLS;
  if (prevSecret !== undefined) process.env.P2P_TURN_SECRET = prevSecret;
  else delete process.env.P2P_TURN_SECRET;
  return (
    Boolean(cfg?.urls?.length) &&
    res.configured === true &&
    res.turn?.urls?.length === 1 &&
    String(res.turn.username).includes("driver_uid") &&
    String(res.turn.credential).length > 4 &&
    Number(res.ttlMs) >= 3_600_000
  );
}

async function testBootstrapInjection() {
  const { createP2pIceBootstrap } = await import("../shared/js/p2p-ice-bootstrap-core.mjs");
  const g = {};
  const bootstrap = createP2pIceBootstrap({
    globalObj: g,
    fetchTurnCredentials: async () => ({
      configured: true,
      ttlMs: 3_600_000,
      turn: {
        urls: ["turn:relay.test:3478"],
        username: "1700003600:test",
        credential: "abc123",
      },
    }),
  });
  await bootstrap.ensureP2pIceConfiguration();
  const ice = g.__SWIFTGO_P2P_ICE__;
  return (
    ice?.turn?.urls?.[0] === "turn:relay.test:3478" &&
    ice?.turn?.username === "1700003600:test" &&
    ice?.turn?.credential === "abc123"
  );
}

async function testResolveIceWithTurn() {
  const { resolveIceConfiguration } = await import("../customer-app/js/p2p-protocol.mjs");
  const ice = resolveIceConfiguration({
    __SWIFTGO_P2P_ICE__: {
      turn: {
        urls: ["turn:relay.test:3478"],
        username: "u",
        credential: "p",
      },
    },
  });
  return ice.hasTurn === true && ice.hasStun === true && ice.iceServers.length >= 2;
}

async function main() {
  record("1-parse-turn-urls", testParseTurnUrls() ? "PASS" : "FAIL");
  record("2-build-username-expiry", testBuildUsernameExpiry() ? "PASS" : "FAIL");
  record("3-build-credential-hmac", testBuildCredentialDeterministic() ? "PASS" : "FAIL");
  record("4-not-configured-without-env", testNotConfiguredWithoutEnv() ? "PASS" : "FAIL");
  record("5-configured-with-env", testConfiguredWithEnv() ? "PASS" : "FAIL");
  record("6-bootstrap-injects-ice", (await testBootstrapInjection()) ? "PASS" : "FAIL");
  record("7-resolve-ice-has-turn", (await testResolveIceWithTurn()) ? "PASS" : "FAIL");

  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`\nP2P TURN credentials: ${results.length - fail} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
