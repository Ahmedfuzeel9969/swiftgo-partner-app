import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, getDocs, collection } from "firebase/firestore";
const require = createRequire(import.meta.url), serverRequire = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = serverRequire("firebase-admin/app");
const { getFirestore, Timestamp } = serverRequire("firebase-admin/firestore");
const { getAuth } = serverRequire("firebase-admin/auth");
const { createRidePeerOffer, publishRidePeerAnswer, closeRidePeerSession, renewRidePeerSession, getRidePeerOfferRevision } = require("../functions/ride-peer-session.js");
const { issueRideTurnCredentials } = require("../functions/p2p-turn-credentials.js");
const projectId = "demo-remediation-phase3";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8188" || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9197") {
  throw new Error("ISOLATED_PHASE_THREE_LOOPBACK_EMULATORS_REQUIRED; never target production or the user's preview");
}
let env, app, db, token, serial = 0;
const rejected = (code) => (error) => error.code === code;
const client = (uid) => env.authenticatedContext(uid).firestore();
async function seed() {
  const id = `phase3_ride_${++serial}`;
  const ride = { id, userId: "customer", driverId: "driver", vehicleId: `car_${serial}`, ownerId: "owner", status: "in_progress", assignmentSessionToken: `assignment_${serial}_phase3` };
  const ref = db.doc(`rides/${id}`), peerRef = db.doc(`ridePeerSessions/${id}`); await ref.set(ride);
  const input = { driverUid: "driver", rideId: id, assignmentId: ride.assignmentSessionToken, offerSdp: "v=0\r\no=- fixture\r\n", trackingSessionId: "tracking_phase3", peerSessionId: `peer_phase3_${serial}` };
  const offer = await createRidePeerOffer(db, input);
  const identity = { uid: "driver", rideId: id, assignmentId: ride.assignmentSessionToken, peerSessionId: offer.sessionId, offerFingerprint: offer.offerFingerprint };
  return { id, ride, ref, peerRef, input, offer, identity };
}
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 8188, rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8") } });
  await env.clearFirestore(); app = initializeApp({ projectId }); db = getFirestore(app);
  await getAuth(app).createUser({ uid: "driver", email: "phase3-driver@example.test", password: "Local-only-test-123!" }).catch((e) => { if (e.code !== "auth/uid-already-exists") throw e; });
  const response = await fetch("http://127.0.0.1:9197/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "phase3-driver@example.test", password: "Local-only-test-123!", returnSecureToken: true }),
  });
  assert.equal(response.status, 200); token = (await response.json()).idToken;
});
after(async () => { await env?.cleanup(); if (app) await deleteApp(app); });

test("signaling has SHA-256 offer identity and cannot answer without that identity", async () => {
  const s = await seed(); assert.match(s.offer.offerFingerprint, /^sha256_[0-9a-f]{64}$/);
  const input = { customerUid: "customer", rideId: s.id, peerSessionId: s.offer.sessionId, answerSdp: "v=0\r\no=- answer\r\n" };
  await assert.rejects(publishRidePeerAnswer(db, input), rejected("invalid-argument"));
  await assert.rejects(publishRidePeerAnswer(db, { ...input, offerFingerprint: "wrong" }), rejected("failed-precondition"));
  assert.equal((await publishRidePeerAnswer(db, { ...input, offerFingerprint: s.offer.offerFingerprint })).ok, true);
});
test("one delayed upload cannot overwrite a newer signaling revision", async () => {
  const s = await seed(), revision = await getRidePeerOfferRevision(db, s.identity);
  const newer = await createRidePeerOffer(db, { ...s.input, ...revision, peerSessionId: "newer_peer_phase3" });
  await assert.rejects(createRidePeerOffer(db, { ...s.input, ...revision, peerSessionId: "delayed_peer_phase3" }), rejected("aborted"));
  assert.equal((await s.peerRef.get()).data().sessionId, newer.sessionId);
  assert.equal((await closeRidePeerSession(db, s.identity)).skipped, true);
});
test("two competing offer uploads have one transaction winner", async () => {
  const s = await seed(), revision = await getRidePeerOfferRevision(db, s.identity);
  const result = await Promise.allSettled(["a", "b"].map((n) => createRidePeerOffer(db, { ...s.input, ...revision, peerSessionId: `competing_peer_${n}` })));
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(result.filter((r) => r.status === "rejected" && r.reason.code === "aborted").length, 1);
});
test("renewal extends an active lease without changing offer, answer or session identity", async () => {
  const s = await seed(), now = Date.now(); await s.peerRef.update({ expiresAt: Timestamp.fromMillis(now + 300000) });
  const before = (await s.peerRef.get()).data();
  const result = await renewRidePeerSession(db, s.identity, { nowMs: () => now });
  assert.equal(result.expiresAtMs, now + 900000);
  const after = (await s.peerRef.get()).data(); assert.equal(after.offer, before.offer); assert.equal(after.sessionId, before.sessionId); assert.equal(after.offerFingerprint, before.offerFingerprint);
  const duplicate = await renewRidePeerSession(db, s.identity, { nowMs: () => now + 1000 });
  assert.equal(duplicate.unchanged, true); assert.equal(duplicate.expiresAtMs, result.expiresAtMs);
});
test("renewal rejects outsiders, customers, retired assignment, rotated offer and terminal ride", async () => {
  const s = await seed();
  for (const uid of ["stranger", "customer"]) await assert.rejects(renewRidePeerSession(db, { ...s.identity, uid }), rejected("permission-denied"));
  await assert.rejects(renewRidePeerSession(db, { ...s.identity, assignmentId: "old_assignment" }), rejected("failed-precondition"));
  await assert.rejects(renewRidePeerSession(db, { ...s.identity, peerSessionId: "new_session_123" }), rejected("failed-precondition"));
  await s.ref.update({ status: "completed" }); await assert.rejects(renewRidePeerSession(db, s.identity), rejected("failed-precondition"));
});
test("expired/missing deadline is not revived and stale answers cannot reopen it", async () => {
  const s = await seed(); await s.peerRef.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  await assert.rejects(renewRidePeerSession(db, s.identity), rejected("failed-precondition"));
  await assert.rejects(publishRidePeerAnswer(db, { customerUid: "customer", rideId: s.id, peerSessionId: s.offer.sessionId, offerFingerprint: s.offer.offerFingerprint, answerSdp: "v=0" }), rejected("failed-precondition"));
});
test("current peers can subscribe before an offer exists; outsiders cannot list/read/write signaling", async () => {
  const s = await seed(); await s.peerRef.delete();
  for (const uid of ["customer", "driver"]) await assertSucceeds(getDoc(doc(client(uid), "ridePeerSessions", s.id)));
  await assertFails(getDoc(doc(client("stranger"), "ridePeerSessions", s.id)));
  await assertFails(getDocs(collection(client("driver"), "ridePeerSessions")));
  await assertFails(setDoc(doc(client("driver"), "ridePeerSessions", s.id), { sessionId: "fake" }));
  await createRidePeerOffer(db, s.input);
  for (const uid of ["customer", "driver"]) await assertSucceeds(getDoc(doc(client(uid), "ridePeerSessions", s.id)));
});
test("reassignment hides old SDP, but the new driver can acquire an opaque revision and replace it", async () => {
  const s = await seed(); await s.ref.update({ driverId: "new_driver", assignmentSessionToken: "new_assignment_phase3" });
  for (const uid of ["driver", "customer", "new_driver"]) await assertFails(getDoc(doc(client(uid), "ridePeerSessions", s.id)));
  const revision = await getRidePeerOfferRevision(db, { uid: "new_driver", rideId: s.id, assignmentId: "new_assignment_phase3" });
  assert.deepEqual(Object.keys(revision).sort(), ["expectedOfferFingerprint", "expectedPeerSessionId"]);
  await createRidePeerOffer(db, { ...s.input, ...revision, driverUid: "new_driver", assignmentId: "new_assignment_phase3", peerSessionId: "new_assignment_peer" });
  await assertSucceeds(getDoc(doc(client("new_driver"), "ridePeerSessions", s.id))); await assertFails(getDoc(doc(client("driver"), "ridePeerSessions", s.id)));
});
test("TURN is active-participant and full-assignment scoped before contacting the provider", async () => {
  const s = await seed(); let calls = 0;
  const opts = { enabled: true, config: { provider: "cloudflare", keyId: "fixture_key", apiToken: "fixture_secret_not_real", ttlSec: 3600 }, fetchFn: async () => { calls++; return { ok: false }; } };
  for (const uid of ["owner", "stranger"]) await assert.rejects(issueRideTurnCredentials(db, { ...s.identity, uid }, opts), rejected("permission-denied"));
  await assert.rejects(issueRideTurnCredentials(db, { ...s.identity, assignmentId: "old" }, opts), rejected("failed-precondition"));
  assert.equal(calls, 0); assert.equal((await issueRideTurnCredentials(db, s.identity, opts)).configured, false); assert.equal(calls, 1);
});
test("TURN issuance is transactionally rate-limited and stores metadata, never credentials", async () => {
  const s = await seed(); const opts = { enabled: true, config: { provider: "coturn", urls: ["turn:relay.test:3478"], secret: "fixture_secret_not_real", ttlSec: 3600 } };
  const results = await Promise.allSettled([issueRideTurnCredentials(db, s.identity, opts), issueRideTurnCredentials(db, s.identity, opts)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected" && r.reason.code === "resource-exhausted").length, 1);
  const metadata = await s.ref.collection("peerCredentialIssues").get(); assert.equal(metadata.size, 1);
  const storedMetadata = metadata.docs[0].data();
  assert.deepEqual(Object.keys(storedMetadata).sort(), ["expiresAt", "issuedAt"]);
  assert.ok(storedMetadata.expiresAt.toMillis() > storedMetadata.issuedAt.toMillis(), "retention deadline must follow issuance");
  await assertFails(getDoc(doc(client("driver"), metadata.docs[0].ref.path)));
  assert.equal(JSON.stringify(results.find((r) => r.status === "fulfilled").value).includes("fixture_secret_not_real"), false);
});
test("disabled TURN makes no provider calls or issuance writes and preserves fallback", async () => {
  const s = await seed(); const result = await issueRideTurnCredentials(db, s.identity, { enabled: false, fetchFn: () => { throw new Error("MUST_NOT_CALL"); } });
  assert.deepEqual(result, { configured: false, reason: "TURN_NOT_CONFIGURED" }); assert.equal((await s.ref.collection("peerCredentialIssues").get()).size, 0);
});
test("real local callables enforce auth and wire renewal/revision/disabled TURN correctly", async () => {
  const s = await seed();
  const call = (name, data, auth = true) => fetch(`http://127.0.0.1:5108/${projectId}/us-central1/${name}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }),
  });
  assert.equal((await call("renewRidePeerSession", s.identity, false)).status, 401);
  assert.equal((await call("renewRidePeerSession", s.identity)).status, 200);
  const revision = await call("getRidePeerOfferRevision", s.identity); assert.equal(revision.status, 200); assert.equal((await revision.json()).result.expectedPeerSessionId, s.offer.sessionId);
  const turn = await call("getP2pTurnCredentials", s.identity); assert.equal(turn.status, 200); assert.equal((await turn.json()).result.configured, false);
  assert.equal((await call("createRidePeerOffer", s.input)).status, 400, "unversioned public uploads cannot bypass compare-and-swap");
  assert.equal((await call("closeRidePeerSession", { rideId: s.id })).status, 400, "unscoped closes cannot destroy a new session");
  const stale = await call("createRidePeerOffer", { ...s.input, expectedPeerSessionId: "wrong_revision", expectedOfferFingerprint: "wrong", peerSessionId: "cannot_overwrite_peer" });
  assert.equal(stale.status, 409);
});
