import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupCategory, collectCleanupReview, verifyCleanupReview, restoreCleanupLogs } from "../tools/cleanup-review.mjs";
function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swiftgo-cleanup-review-"));
  const files = { "tests/_run-cp.log": "scratch one\n", "tests/_v-cp.log": "scratch two\n", "tests/example-results.json": '{"ok":true}', "customer-app/js/required.mjs": 'export * from "../../shared/js/required.mjs";', ...extra };
  for (const [p, bytes] of Object.entries(files)) { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); }
  return { root, files, paths: Object.keys(files), relative: "cleanup-review/fixture" };
}
test("cleanup protects app wrappers, server modules, credentials, dependencies and preview", () => {
  for (const p of ["driver-app/js/p2p-peer-session.mjs", "shared/js/p2p-peer-session.mjs", "functions/location-delivery-policy.js"]) assert.equal(cleanupCategory(p), "protected_application_or_build_input");
  for (const p of ["functions/.env.demo-test", "hosting-dist/index.html", "emulator-data/preview/data.json", ".release-baselines/source/file", "node_modules/lib.js"]) assert.equal(cleanupCategory(p), "protected_runtime_backup_or_secret");
});
test("only explicitly reviewed scratch logs move; source and historical report stay intact", () => {
  const h = fixture(); const result = collectCleanupReview(h.root, h.relative, h.paths);
  assert.equal(result.moved, 2); assert.equal(result.copiedOnly, 1);
  assert.equal(fs.existsSync(path.join(h.root, "tests/_run-cp.log")), false);
  assert.equal(fs.readFileSync(path.join(h.root, "customer-app/js/required.mjs"), "utf8"), h.files["customer-app/js/required.mjs"]);
  assert.equal(fs.readFileSync(path.join(h.root, "tests/example-results.json"), "utf8"), h.files["tests/example-results.json"]);
  assert.equal(verifyCleanupReview(h.root, h.relative).files.length, 3);
});
test("a referenced scratch log is copied for review, never moved", () => {
  const h = fixture({ "tests/reader.mjs": 'readFileSync("tests/_run-cp.log");' });
  const result = collectCleanupReview(h.root, h.relative, h.paths); assert.equal(result.moved, 1); assert.ok(fs.existsSync(path.join(h.root, "tests/_run-cp.log")));
});
test("report dependencies are recorded so cleanup cannot pretend evidence is unused", () => {
  const h = fixture({ "tests/gate.mjs": 'readFileSync("tests/example-results.json");' }); collectCleanupReview(h.root, h.relative, h.paths);
  const m = verifyCleanupReview(h.root, h.relative); assert.deepEqual(m.files.find((e) => e.path.endsWith("example-results.json")).references, ["tests/gate.mjs"]);
});
test("collection refuses broad roots, traversal and existing destinations", () => {
  const h = fixture();
  for (const p of [".", "../outside", "cleanup-review/../outside", "cleanup-review", "C:/outside"]) assert.throws(() => collectCleanupReview(h.root, p, h.paths));
  collectCleanupReview(h.root, h.relative, h.paths); assert.throws(() => collectCleanupReview(h.root, h.relative, h.paths), /REVIEW_ALREADY_EXISTS/);
});
test("collected files and manifest are independently hash-verified", () => {
  const h = fixture(); collectCleanupReview(h.root, h.relative, h.paths);
  fs.appendFileSync(path.join(h.root, h.relative, "files/tests/_run-cp.log"), "tamper"); assert.throws(() => verifyCleanupReview(h.root, h.relative), /COLLECTED_FILE_CHANGED/);
  const j = fixture(); collectCleanupReview(j.root, j.relative, j.paths);
  fs.appendFileSync(path.join(j.root, j.relative, "manifest.json"), " "); assert.throws(() => verifyCleanupReview(j.root, j.relative), /MANIFEST_CHANGED/);
});
test("logs restore byte-for-byte while the recovery copy remains; repeated restore refuses overwrite", () => {
  const h = fixture(); collectCleanupReview(h.root, h.relative, h.paths); assert.equal(restoreCleanupLogs(h.root, h.relative), 2);
  for (const p of ["tests/_run-cp.log", "tests/_v-cp.log"]) assert.equal(fs.readFileSync(path.join(h.root, p), "utf8"), h.files[p]);
  assert.throws(() => restoreCleanupLogs(h.root, h.relative), /RESTORE_WOULD_OVERWRITE/); verifyCleanupReview(h.root, h.relative);
});
test("restore preflights every target before restoring any log", () => {
  const h = fixture(); collectCleanupReview(h.root, h.relative, h.paths);
  fs.writeFileSync(path.join(h.root, "tests/_v-cp.log"), "new user file"); assert.throws(() => restoreCleanupLogs(h.root, h.relative), /RESTORE_WOULD_OVERWRITE/);
  assert.equal(fs.existsSync(path.join(h.root, "tests/_run-cp.log")), false); assert.equal(fs.readFileSync(path.join(h.root, "tests/_v-cp.log"), "utf8"), "new user file");
});
test("next phase reuses verified unchanged evidence without making redundant copies", () => {
  const h = fixture(); collectCleanupReview(h.root, h.relative, h.paths);
  const next = "cleanup-review/next", paths = h.paths.filter((p) => !p.endsWith(".log"));
  const r = collectCleanupReview(h.root, next, paths, { previous: h.relative });
  assert.equal(r.reused, 1); assert.equal(r.copiedOnly, 0); assert.equal(r.moved, 0);
  assert.equal(fs.existsSync(path.join(h.root, next, "files/tests/example-results.json")), false);
  assert.equal(verifyCleanupReview(h.root, next).files[0].reusedFrom, `${h.relative}/files/tests/example-results.json`);
});
test("changed evidence is copied into the new phase and old evidence remains immutable", () => {
  const h = fixture(); collectCleanupReview(h.root, h.relative, h.paths);
  fs.appendFileSync(path.join(h.root, "tests/example-results.json"), " ");
  const r = collectCleanupReview(h.root, "cleanup-review/changed", ["tests/example-results.json"], { previous: h.relative });
  assert.equal(r.reused, 0); assert.equal(r.copiedOnly, 1);
  verifyCleanupReview(h.root, h.relative); verifyCleanupReview(h.root, "cleanup-review/changed");
});
test("cross-phase reuse revalidates archive hashes before new collection and on every verify", () => {
  const h = fixture(); collectCleanupReview(h.root, h.relative, h.paths);
  collectCleanupReview(h.root, "cleanup-review/next", ["tests/example-results.json"], { previous: h.relative });
  fs.appendFileSync(path.join(h.root, h.relative, "files/tests/example-results.json"), "tamper");
  assert.throws(() => verifyCleanupReview(h.root, "cleanup-review/next"), /COLLECTED_FILE_CHANGED/);
  assert.throws(() => collectCleanupReview(h.root, "cleanup-review/last", ["tests/example-results.json"], { previous: h.relative }), /COLLECTED_FILE_CHANGED/);
});
