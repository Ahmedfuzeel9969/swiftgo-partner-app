import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureBaseline, excludedFromSnapshot, restoreBaseline, verifyBaseline } from "../tools/remediation-baseline.mjs";
import { compareInventories, git, inventoryHash, inventoryTree, safeRelative, sha256 } from "../tools/source-integrity.mjs";
import { HOSTING_DEPLOY_SOURCE_PATHS } from "../tools/hosting-routing-config.mjs";
import {
  assertHostingSourcesClean, BUILD_LOCK, hostingSourceState,
  verifyHostingBuild, writeHostingBuildLock, writeHostingStamp,
} from "../tools/hosting-provenance.mjs";

const temporaryRoot = fs.realpathSync(os.tmpdir());
function write(root, name, content) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(temporaryRoot, "swiftgo-phase-zero-"));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith("swiftgo-phase-zero-"));
    assert.ok(!fs.lstatSync(resolved).isSymbolicLink());
    fs.rmSync(resolved, { recursive: true }); // Only this validated, test-created directory.
  });
  git(root, ["init", "--quiet"]);
  write(root, ".gitignore", ".release-baselines/\nhosting-dist/\n.hosting-deploy-lock.json\nnode_modules/\n.env\nignored-asset.js\n");
  write(root, "README.md", "original\n");
  write(root, "binary.dat", Buffer.from([0, 1, 255, 13, 10]));
  return root;
}
function commit(root) {
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Local Test", "-c", "user.email=test@invalid.example", "commit", "--quiet", "-m", "isolated fixture"]);
}
function hostingFixture(t) {
  const root = fixture(t);
  const directories = new Set(["customer-app", "driver-app", "owner-app", "super-admin-panel", "shared", "legal", "hosting-static"]);
  for (const relative of HOSTING_DEPLOY_SOURCE_PATHS) {
    write(root, directories.has(relative) ? `${relative}/fixture.txt` : relative, `fixture:${relative}\n`);
  }
  commit(root);
  write(root, "hosting-dist/index.html", "<!doctype html><title>Fixture</title>\n");
  const before = hostingSourceState(root);
  writeHostingBuildLock(root, before);
  writeHostingStamp(root, before);
  return root;
}

test("inventory is deterministic and detects changed, added and missing bytes", (t) => {
  const root = fixture(t);
  const before = inventoryTree(root, { exclude: [".git"] });
  assert.equal(inventoryHash(before), inventoryHash([...before].reverse()));
  write(root, "README.md", "changed\n");
  write(root, "new.txt", "new\n");
  fs.unlinkSync(path.join(root, "binary.dat"));
  const after = inventoryTree(root, { exclude: [".git"] });
  assert.notEqual(inventoryHash(before), inventoryHash(after));
  assert.deepEqual(compareInventories(before, after), { missing: ["binary.dat"], added: ["new.txt"], changed: ["README.md"] });
});

test("path traversal, Git metadata and case-colliding inventories are refused", () => {
  for (const relative of ["../x", "a/../x", "/x", "C:/x", "a\\b", ".git/config", "a//b", "a/./b", "a/.. /x", "NUL.txt", "a/trailing."]) {
    assert.throws(() => safeRelative(relative), /Unsafe/);
  }
  assert.throws(() => inventoryHash([
    { path: "A.js", bytes: 1, sha256: sha256("a") },
    { path: "a.js", bytes: 1, sha256: sha256("a") },
  ]), /case-colliding/);
});

test("credential/dependency exclusions do not exclude credential implementation code", () => {
  for (const name of [".env", "functions/.env.production", "serviceAccount-prod.json", "a/credentials.json", "key.pem", "android/app.jks", "node_modules/a.js"]) {
    assert.equal(excludedFromSnapshot(name), true, name);
  }
  assert.equal(excludedFromSnapshot("functions/p2p-turn-credentials.js"), false);
  assert.equal(excludedFromSnapshot(".env.example"), false);
});

test("snapshot preserves dirty/untracked bytes, records deletions and omits credentials", (t) => {
  const root = fixture(t);
  commit(root);
  write(root, "README.md", "user edit\n");
  write(root, "untracked.txt", "not committed\n");
  write(root, ".env", "TEST_ONLY=not-a-real-secret\n");
  write(root, "credentials.json", "{}\n");
  fs.unlinkSync(path.join(root, "binary.dat"));
  write(root, "hosting-dist/index.html", "prior artifact\n");
  const stateBefore = git(root, ["status", "--porcelain=v1", "-z"]);
  const { destination, manifest } = captureBaseline(root, "unit-test");
  assert.equal(manifest.git.dirty, true);
  assert.ok(manifest.deletedPaths.includes("binary.dat"));
  assert.ok(manifest.excludedPaths.includes("credentials.json"));
  assert.equal(fs.existsSync(path.join(destination, "source/.env")), false);
  assert.equal(fs.readFileSync(path.join(destination, "source/README.md"), "utf8"), "user edit\n");
  assert.equal(fs.readFileSync(path.join(destination, "source/untracked.txt"), "utf8"), "not committed\n");
  assert.equal(verifyBaseline(root, destination).source.sha256, manifest.source.sha256);
  assert.equal(git(root, ["status", "--porcelain=v1", "-z"]), stateBefore);
});

test("restore verifies binary bytes and cannot overwrite an existing directory", (t) => {
  const root = fixture(t);
  commit(root);
  const { destination, manifest } = captureBaseline(root, "restore-test");
  const target = ".release-baselines/restored";
  const result = restoreBaseline(root, destination, target);
  assert.equal(result.sourceSha256, manifest.source.sha256);
  assert.deepEqual(fs.readFileSync(path.join(result.destination, "source/binary.dat")), Buffer.from([0, 1, 255, 13, 10]));
  assert.throws(() => restoreBaseline(root, destination, target), /already exists/);
  assert.throws(() => restoreBaseline(root, destination, "../outside"), /must be a child/);
  assert.throws(() => restoreBaseline(root, destination, "."), /must be a child/);
});

test("the initial snapshot hash format remains verifiable and restorable", (t) => {
  const root = fixture(t);
  commit(root);
  const { destination, manifest } = captureBaseline(root, "legacy-test");
  delete manifest.inventoryHashVersion;
  manifest.source.sha256 = inventoryHash(manifest.source.files, true);
  const bytes = JSON.stringify(manifest);
  write(destination, "manifest.json", bytes);
  write(destination, "manifest.sha256", sha256(bytes));
  assert.equal(verifyBaseline(root, destination).source.sha256, manifest.source.sha256);
  assert.equal(restoreBaseline(root, destination, ".release-baselines/legacy-restored").sourceSha256, manifest.source.sha256);
});

test("modified, missing and injected snapshot files fail integrity verification", (t) => {
  const root = fixture(t);
  commit(root);
  const { destination } = captureBaseline(root, "tamper-test");
  const source = path.join(destination, "source");
  write(source, "README.md", "tampered\n");
  assert.throws(() => verifyBaseline(root, destination), /content mismatch/);
  write(source, "README.md", "original\n");
  write(source, "injected.js", "injected\n");
  assert.throws(() => verifyBaseline(root, destination), /content mismatch/);
  fs.unlinkSync(path.join(source, "injected.js"));
  fs.unlinkSync(path.join(source, "README.md"));
  assert.throws(() => verifyBaseline(root, destination), /content mismatch/);
});

test("a corrupt manifest cannot be restored", (t) => {
  const root = fixture(t);
  commit(root);
  const { destination } = captureBaseline(root, "manifest-test");
  fs.appendFileSync(path.join(destination, "manifest.json"), " ");
  assert.throws(() => verifyBaseline(root, destination), /Manifest checksum mismatch/);
});

test("a forged path is refused even if the manifest checksum was recomputed", (t) => {
  const root = fixture(t);
  commit(root);
  const { destination, manifest } = captureBaseline(root, "path-test");
  manifest.source.files[0].path = "../../escape.txt";
  const bytes = JSON.stringify(manifest);
  write(destination, "manifest.json", bytes);
  write(destination, "manifest.sha256", sha256(bytes));
  assert.throws(() => restoreBaseline(root, destination, ".release-baselines/restored"), /Unsafe/);
});

test("directory links cannot escape an inventory", (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  const linked = path.join(root, "linked");
  try { fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip("OS denied test link creation");
    throw error;
  }
  assert.throws(() => inventoryTree(root, { exclude: [".git"] }), /Linked/);
  fs.unlinkSync(linked);
});

test("clean source, artifact and pre-build lock verify together", (t) => {
  const root = hostingFixture(t);
  assertHostingSourcesClean(root);
  assert.equal(verifyHostingBuild(root, { requireClean: true, requireLock: true }).sourceDirty, false);
});

test("every app, shared code and legal asset is covered by the release gate", (t) => {
  const root = hostingFixture(t);
  for (const dir of ["customer-app", "driver-app", "owner-app", "super-admin-panel", "shared", "legal", "hosting-static"]) {
    const file = path.join(root, dir, "fixture.txt");
    const original = fs.readFileSync(file);
    fs.appendFileSync(file, "change");
    assert.throws(() => assertHostingSourcesClean(root), /Uncommitted/, dir);
    assert.throws(() => verifyHostingBuild(root), /Build\/source mismatch/, dir);
    fs.writeFileSync(file, original);
  }
});

test("untracked and Git-ignored build inputs cannot bypass the clean-source gate", (t) => {
  const root = hostingFixture(t);
  write(root, "customer-app/new.js", "new\n");
  assert.throws(() => assertHostingSourcesClean(root), /Uncommitted/);
  fs.unlinkSync(path.join(root, "customer-app/new.js"));
  write(root, "customer-app/ignored-asset.js", "ignored but packaged\n");
  assert.equal(hostingSourceState(root).sourceDirty, true);
  assert.throws(() => assertHostingSourcesClean(root), /ignored build inputs/);
});

test("built byte changes and added assets are detected", (t) => {
  const root = hostingFixture(t);
  const html = path.join(root, "hosting-dist/index.html");
  const original = fs.readFileSync(html);
  fs.appendFileSync(html, "changed");
  assert.throws(() => verifyHostingBuild(root), /artifact changed/);
  fs.writeFileSync(html, original);
  write(root, "hosting-dist/added.js", "extra");
  assert.throws(() => verifyHostingBuild(root), /artifact changed/);
});

test("a local dirty build remains verifiable but never deployable", (t) => {
  const root = hostingFixture(t);
  write(root, "customer-app/fixture.txt", "local edit\n");
  writeHostingStamp(root, hostingSourceState(root));
  assert.equal(verifyHostingBuild(root).sourceDirty, true);
  assert.throws(() => verifyHostingBuild(root, { requireClean: true }), /Uncommitted/);
});

test("mid-build source changes cannot produce a valid new stamp", (t) => {
  const root = hostingFixture(t);
  const before = hostingSourceState(root);
  write(root, "shared/fixture.txt", "changed while building\n");
  assert.throws(() => writeHostingStamp(root, before), /changed during build/);
});

test("missing/stale pre-build locks and HEAD-only stamps fail closed", (t) => {
  const root = hostingFixture(t);
  fs.unlinkSync(path.join(root, BUILD_LOCK));
  assert.throws(() => verifyHostingBuild(root, { requireLock: true }), /Missing pre-build lock/);
  writeHostingBuildLock(root, { ...hostingSourceState(root), sourceSha256: "0".repeat(64) });
  assert.throws(() => verifyHostingBuild(root, { requireLock: true }), /lock\/source mismatch/);
  write(root, "hosting-dist/.hosting-source.json", JSON.stringify({ headSha: hostingSourceState(root).headSha }));
  assert.throws(() => verifyHostingBuild(root), /Legacy\/unverifiable/);
});
