/** Local review collection, NOT deletion. Required source/build/runtime is protected.
 * Copies historical test results because some are audit/CI inputs. Only two explicitly
 * reviewed, unreferenced scratch logs may move, with hashes and no-overwrite restore.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, safeFile, inventoryFiles, inventoryHash, sha256 } from "./source-integrity.mjs";
import { excludedFromSnapshot } from "./remediation-baseline.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const movable = new Set(["tests/_run-cp.log", "tests/_v-cp.log"]);
const isResult = (p) => /^tests\/[^/]+-(results|report)\.json$/.test(p);
export function cleanupCategory(p) {
  if (movable.has(p)) return "unreferenced_scratch_log";
  if (isResult(p)) return "historical_test_evidence_review_only";
  if (excludedFromSnapshot(p) || p.startsWith("cleanup-review/")) return "protected_runtime_backup_or_secret";
  if (/^(customer-app|driver-app|owner-app|super-admin-panel|shared|functions|mobile|hosting-static|legal)\//.test(p)) return "protected_application_or_build_input";
  return "retained_source_test_documentation_or_config";
}
function destination(root, relative) {
  if (!/^cleanup-review\/[a-z0-9][a-z0-9-]{0,63}$/.test(relative)) throw new Error("REVIEW_CHILD_REQUIRED");
  return safeFile(root, relative);
}
export function buildCleanupInventory(root, paths) {
  const entries = inventoryFiles(root, paths.filter((p) => !excludedFromSnapshot(p) && !p.startsWith("cleanup-review/")));
  const searchable = entries.filter((e) => /\.(?:m?js|json|md|html|yml|yaml|ps1)$/.test(e.path) &&
    !isResult(e.path) && !/package-lock\.json$/.test(e.path) && !["tools/cleanup-review.mjs", "tests/cleanup-review.test.mjs"].includes(e.path));
  const text = new Map(searchable.map((e) => [e.path, fs.readFileSync(safeFile(root, e.path), "utf8")]));
  const candidates = entries.filter((e) => movable.has(e.path) || isResult(e.path)).map((e) => {
    const references = [...text].filter(([p, content]) => p !== e.path && content.includes(path.posix.basename(e.path))).map(([p]) => p);
    const action = movable.has(e.path) && references.length === 0 ? "move_verified_scratch_log" : "copy_review_keep_original";
    return { ...e, category: cleanupCategory(e.path), action, references };
  });
  const groups = new Map();
  for (const e of entries) { if (!groups.has(e.sha256)) groups.set(e.sha256, []); groups.get(e.sha256).push(e.path); }
  return {
    sourceFileCount: entries.length, sourceInventorySha256: inventoryHash(entries), candidates,
    identicalContentGroups: [...groups].filter(([, p]) => p.length > 1).map(([hash, paths]) => ({ sha256: hash, paths, action: "retain_until_build_graph_review" })),
    classification: entries.map((e) => ({ path: e.path, category: cleanupCategory(e.path) })),
    protectedDirectories: ["hosting-dist (open preview)", "emulator-data (preview, synthetic databases, test evidence)", ".release-baselines (recovery)", ".firebase (runtime)", "node_modules (dependencies)", ".git (history)", "mobile build/www (verify active build before cleanup)", "credential and environment files"],
    limitations: "Static references cannot prove arbitrary code unreachable. Duplicate bytes are NOT permission to delete wrappers or build inputs. No code, tests, historical documents, baselines, runtime databases, dependencies or credentials are moved/deleted.",
  };
}
export function collectCleanupReview(root, relative, inputPaths, { previous = null } = {}) {
  const dest = destination(root, relative);
  if (fs.existsSync(dest)) throw new Error("REVIEW_ALREADY_EXISTS");
  const paths = inputPaths || [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))]
    .filter((p) => fs.existsSync(safeFile(root, p)));
  const inventory = buildCleanupInventory(root, paths);
  const earlier = previous ? verifyCleanupReview(root, previous) : null;
  // Validate EVERY source and destination before any move, including linked parents.
  const files = inventory.candidates.map((e) => {
    const old = earlier?.files.find((f) => f.path === e.path && f.sha256 === e.sha256);
    const reusedFrom = old && e.action === "copy_review_keep_original" ? old.reusedFrom || `${previous}/${old.collectedPath}` : null;
    return { ...e, collectedPath: `files/${e.path}`, ...(reusedFrom ? { reusedFrom } : {}) };
  });
  for (const e of files) {
    safeFile(root, e.path); safeFile(root, `${relative}/${e.collectedPath}`);
    if (e.action === "move_verified_scratch_log" && !movable.has(e.path)) throw new Error("MOVE_NOT_ALLOWED");
  }
  fs.mkdirSync(dest, { recursive: true });
  // Recovery plan exists before collecting. Unexpected interruption is inspectable.
  const plan = { version: previous ? 2 : 1, createdAt: new Date().toISOString(), relative, previous, ...inventory, files };
  const planText = JSON.stringify(plan, null, 2) + "\n";
  fs.writeFileSync(safeFile(dest, "manifest.json"), planText, { flag: "wx" });
  fs.writeFileSync(safeFile(dest, "manifest.sha256"), sha256(planText) + "\n", { flag: "wx" });
  for (const e of files) {
    const from = safeFile(root, e.path), to = safeFile(dest, e.collectedPath);
    if (sha256(fs.readFileSync(from)) !== e.sha256) throw new Error("SOURCE_CHANGED_DURING_COLLECTION");
    if (e.reusedFrom) {
      if (sha256(fs.readFileSync(safeFile(root, e.reusedFrom))) !== e.sha256) throw new Error("REUSED_FILE_CHANGED");
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    if (sha256(fs.readFileSync(to)) !== e.sha256) throw new Error("COLLECTION_HASH_MISMATCH");
    // Never delete the source; rename only the two proven scratch logs. The copy
    // remains in files/; moved/ is an additional recoverable original, not a delete.
    if (e.action === "move_verified_scratch_log") {
      const moved = safeFile(dest, `moved/${e.path}`);
      fs.mkdirSync(path.dirname(moved), { recursive: true });
      if (fs.existsSync(moved)) throw new Error("MOVE_TARGET_EXISTS");
      fs.renameSync(from, moved);
    }
  }
  verifyCleanupReview(root, relative);
  return { relative, sourceFileCount: inventory.sourceFileCount, collected: files.length,
    moved: files.filter((e) => e.action === "move_verified_scratch_log").length,
    copiedOnly: files.filter((e) => e.action === "copy_review_keep_original" && !e.reusedFrom).length,
    reused: files.filter((e) => e.reusedFrom).length,
    identicalGroups: inventory.identicalContentGroups.length };
}
export function verifyCleanupReview(root, relative) {
  const dest = destination(root, relative), raw = fs.readFileSync(safeFile(dest, "manifest.json"));
  if (sha256(raw) !== fs.readFileSync(safeFile(dest, "manifest.sha256"), "utf8").trim()) throw new Error("MANIFEST_CHANGED");
  const manifest = JSON.parse(raw);
  if (![1, 2].includes(manifest.version) || manifest.relative !== relative) throw new Error("MANIFEST_SCOPE_MISMATCH");
  for (const e of manifest.files) {
    if (e.collectedPath !== `files/${e.path}` || (!movable.has(e.path) && !isResult(e.path))) throw new Error("UNEXPECTED_REVIEW_PATH");
    if (e.reusedFrom && (manifest.version !== 2 || e.action !== "copy_review_keep_original" ||
        !/^cleanup-review\/[a-z0-9][a-z0-9-]{0,63}\/files\/tests\/[^/]+-(results|report)\.json$/.test(e.reusedFrom) ||
        path.posix.basename(e.reusedFrom) !== path.posix.basename(e.path))) throw new Error("INVALID_REUSE_PATH");
    const collected = e.reusedFrom ? safeFile(root, e.reusedFrom) : safeFile(dest, e.collectedPath);
    if (sha256(fs.readFileSync(collected)) !== e.sha256) throw new Error("COLLECTED_FILE_CHANGED");
    if (e.action === "move_verified_scratch_log" && sha256(fs.readFileSync(safeFile(dest, `moved/${e.path}`))) !== e.sha256) throw new Error("MOVED_FILE_CHANGED");
  }
  return manifest;
}
export function restoreCleanupLogs(root, relative) {
  const m = verifyCleanupReview(root, relative), dest = destination(root, relative);
  const logs = m.files.filter((e) => e.action === "move_verified_scratch_log");
  for (const e of logs) {
    if (!movable.has(e.path) || fs.existsSync(safeFile(root, e.path))) throw new Error("RESTORE_WOULD_OVERWRITE_OR_ESCAPE");
  }
  for (const e of logs) fs.copyFileSync(safeFile(dest, `moved/${e.path}`), safeFile(root, e.path), fs.constants.COPYFILE_EXCL);
  return logs.length;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, relative] = process.argv.slice(2);
  try {
    if (command === "collect") console.log(JSON.stringify(collectCleanupReview(ROOT, relative, undefined,
      { previous: process.argv.slice(4).find((s) => s.startsWith("--reuse="))?.slice(8) || null }), null, 2));
    else if (command === "verify") console.log(JSON.stringify({ verified: true, files: verifyCleanupReview(ROOT, relative).files.length }));
    else if (command === "restore-logs") console.log(JSON.stringify({ restored: restoreCleanupLogs(ROOT, relative) }));
    else throw new Error("Usage: cleanup-review.mjs collect|verify|restore-logs cleanup-review/LABEL");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
