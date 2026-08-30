/** Local build provenance. A commit name alone does not identify dirty bytes. */
import fs from "node:fs";
import { HOSTING_DEPLOY_SOURCE_PATHS } from "./hosting-routing-config.mjs";
import { git, inventoryHash, inventoryTree, safeFile } from "./source-integrity.mjs";

export const BUILD_STAMP = ".hosting-source.json";
export const BUILD_LOCK = ".hosting-deploy-lock.json";

function untrackedBuildInputs(root, files) {
  const tracked = new Set(git(root, ["ls-files", "--cached", "-z", "--", ...HOSTING_DEPLOY_SOURCE_PATHS]).split("\0"));
  return files.filter((entry) => !tracked.has(entry.path)).map((entry) => entry.path);
}

export function hostingSourceState(root) {
  const files = inventoryTree(root, { paths: HOSTING_DEPLOY_SOURCE_PATHS });
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...HOSTING_DEPLOY_SOURCE_PATHS]).trim();
  return {
    headSha: git(root, ["rev-parse", "HEAD"]).trim(),
    sourceSha256: inventoryHash(files), sourceFileCount: files.length,
    sourceDirty: status.length > 0 || untrackedBuildInputs(root, files).length > 0,
  };
}

export function assertHostingSourcesClean(root) {
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...HOSTING_DEPLOY_SOURCE_PATHS]).trim();
  if (status) {
    // Report paths only. Never print source diffs or possible secret values.
    throw new Error(`Uncommitted Hosting source changes; deploy blocked:\n${status}\nReview and commit the intended release before deploying. Do not discard work.`);
  }
  const untracked = untrackedBuildInputs(root, inventoryTree(root, { paths: HOSTING_DEPLOY_SOURCE_PATHS }));
  if (untracked.length) throw new Error(`Untracked or ignored build inputs; deploy blocked:\n${untracked.join("\n")}`);
}

export function writeHostingStamp(root, before, { isolatedTest = false } = {}) {
  const after = hostingSourceState(root);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Hosting source changed during build; rebuild required");
  const dist = safeFile(root, isolatedTest ? "emulator-data/phase-two-hosting-check" : "hosting-dist");
  const artifact = inventoryTree(dist, { exclude: [BUILD_STAMP] });
  const stamp = {
    schemaVersion: 2, ...after, builtAt: new Date().toISOString(),
    builder: "tools/build-hosting.mjs", nodeVersion: process.version,
    artifactSha256: inventoryHash(artifact), artifactFileCount: artifact.length,
    ...(isolatedTest ? { verificationOnly: true } : {}),
  };
  fs.writeFileSync(safeFile(dist, BUILD_STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

export function writeHostingBuildLock(root, state) {
  fs.writeFileSync(safeFile(root, BUILD_LOCK), `${JSON.stringify({
    schemaVersion: 2, ...state, recordedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

export function verifyHostingBuild(root, { requireClean = false, requireLock = false } = {}) {
  if (requireClean) assertHostingSourcesClean(root);
  const state = hostingSourceState(root);
  const dist = safeFile(root, "hosting-dist");
  const stamp = JSON.parse(fs.readFileSync(safeFile(dist, BUILD_STAMP), "utf8"));
  if (stamp.verificationOnly) throw new Error("Isolated verification artifact is not a deployment build");
  if (stamp.schemaVersion !== 2) throw new Error("Legacy/unverifiable build stamp; rebuild required");
  for (const key of ["headSha", "sourceSha256", "sourceFileCount", "sourceDirty"]) {
    if (stamp[key] !== state[key]) throw new Error(`Build/source mismatch: ${key}; rebuild required`);
  }
  const artifact = inventoryTree(dist, { exclude: [BUILD_STAMP] });
  if (stamp.artifactSha256 !== inventoryHash(artifact) || stamp.artifactFileCount !== artifact.length) {
    throw new Error("Built artifact changed after packaging; deploy blocked");
  }
  if (requireLock) {
    const lockPath = safeFile(root, BUILD_LOCK);
    if (!fs.existsSync(lockPath)) throw new Error("Missing pre-build lock; run the full deployment preflight");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock.schemaVersion !== 2 || lock.sourceDirty !== false ||
        lock.headSha !== state.headSha || lock.sourceSha256 !== state.sourceSha256 ||
        lock.sourceFileCount !== state.sourceFileCount) {
      throw new Error("Pre-build lock/source mismatch; deploy blocked");
    }
  }
  return stamp;
}
