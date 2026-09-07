/**
 * Local-only recovery snapshots. Never deploys, exports a database, or overwrites
 * source. Restore always creates a NEW directory; credentials/history are omitted.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  compareInventories, git, gitState, inventoryFiles, inventoryHash,
  inventoryTree, safeFile, sha256,
} from "./source-integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = ".release-baselines";

export function excludedFromSnapshot(relative) {
  const parts = relative.toLowerCase().split("/");
  const name = parts.at(-1);
  return parts.some((part) => [".git", ".release-baselines", "node_modules", ".firebase", "hosting-dist", "emulator-data"].includes(part)) ||
    (/^\.env(?:\.|$)/.test(name) && !name.endsWith(".example")) ||
    /\.(?:pem|p12|pfx|key|jks|keystore)$/.test(name) ||
    /^(?:credentials|serviceaccount.*|.*service-account.*)\.json$/.test(name) ||
    ["keystore.properties", "google-services.json", ".firebaserc.local"].includes(name);
}

function localChild(root, value) {
  const relative = path.relative(path.resolve(root), path.resolve(root, value)).replaceAll("\\", "/");
  if (!relative.startsWith(`${SNAPSHOT_DIR}/`)) {
    throw new Error(`Snapshot/restore destination must be a child of ${SNAPSHOT_DIR}/`);
  }
  return safeFile(root, relative);
}

function sourceFiles(root) {
  const candidates = [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean))].sort();
  const excluded = candidates.filter(excludedFromSnapshot);
  const deleted = [];
  const files = candidates.filter((relative) => {
    if (excludedFromSnapshot(relative)) return false;
    const absolute = safeFile(root, relative);
    if (!fs.existsSync(absolute)) { deleted.push(relative); return false; }
    return true;
  });
  return { files, excluded, deleted };
}

function copyInventory(from, to, entries) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of entries) {
    const source = safeFile(from, entry.path);
    const target = safeFile(to, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") fs.chmodSync(target, entry.mode);
  }
}

function assertInventory(entries, root, expectedHash, legacyOrder = false) {
  if (inventoryHash(entries, legacyOrder) !== expectedHash) throw new Error("Manifest inventory checksum mismatch");
  const actual = inventoryTree(root);
  if (inventoryHash(actual, legacyOrder) !== expectedHash) {
    throw new Error(`Snapshot content mismatch: ${JSON.stringify(compareInventories(entries, actual))}`);
  }
}

export function captureBaseline(root = ROOT, label = "manual") {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(label)) throw new Error("Use a short lowercase label");
  const stateBefore = gitState(root);
  const listed = sourceFiles(root);
  const source = inventoryFiles(root, listed.files);
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${label}-${randomBytes(3).toString("hex")}`;
  const base = safeFile(root, SNAPSHOT_DIR);
  fs.mkdirSync(base, { recursive: true });
  const destination = localChild(root, `${SNAPSHOT_DIR}/${id}`);
  fs.mkdirSync(destination); // Never replace an existing snapshot.
  copyInventory(root, path.join(destination, "source"), source);
  const artifactRoot = path.join(root, "hosting-dist");
  const artifact = fs.existsSync(artifactRoot) ? inventoryTree(artifactRoot) : null;
  if (artifact) copyInventory(artifactRoot, path.join(destination, "hosting-artifact"), artifact);
  const after = sourceFiles(root);
  if (inventoryHash(inventoryFiles(root, after.files)) !== inventoryHash(source) ||
      JSON.stringify(gitState(root)) !== JSON.stringify(stateBefore)) {
    throw new Error(`Source changed during capture; incomplete snapshot left at ${destination}`);
  }
  const manifest = {
    schemaVersion: 1, inventoryHashVersion: 2, createdAt, label, git: stateBefore,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    scope: "local working-tree bytes and optional pre-existing hosting artifact; NOT a production/data backup",
    omitted: ["Git history/index state", "ignored files/dependencies", "known credential-file patterns (not a content secret scan)", "Firestore/Auth/Storage data", "deployed Functions/Rules/configuration"],
    excludedPaths: listed.excluded, deletedPaths: listed.deleted,
    source: { fileCount: source.length, bytes: source.reduce((sum, item) => sum + item.bytes, 0), sha256: inventoryHash(source), files: source },
    hostingArtifact: artifact ? { fileCount: artifact.length, sha256: inventoryHash(artifact), files: artifact } : null,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(destination, "manifest.json"), manifestBytes, { flag: "wx" });
  fs.writeFileSync(path.join(destination, "manifest.sha256"), `${sha256(manifestBytes)}\n`, { flag: "wx" });
  verifyBaseline(root, destination);
  return { destination, manifest };
}

export function verifyBaseline(root = ROOT, snapshot) {
  const destination = localChild(root, snapshot);
  const bytes = fs.readFileSync(safeFile(destination, "manifest.json"));
  const expected = fs.readFileSync(safeFile(destination, "manifest.sha256"), "utf8").trim();
  if (sha256(bytes) !== expected) throw new Error("Manifest checksum mismatch");
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported snapshot schema");
  const legacyOrder = manifest.inventoryHashVersion === undefined;
  if (!legacyOrder && manifest.inventoryHashVersion !== 2) throw new Error("Unsupported inventory hash version");
  assertInventory(manifest.source.files, safeFile(destination, "source"), manifest.source.sha256, legacyOrder);
  if (manifest.hostingArtifact) {
    assertInventory(manifest.hostingArtifact.files, safeFile(destination, "hosting-artifact"), manifest.hostingArtifact.sha256, legacyOrder);
  }
  return manifest;
}

export function restoreBaseline(root = ROOT, snapshot, target) {
  const manifest = verifyBaseline(root, snapshot);
  const from = localChild(root, snapshot);
  const destination = localChild(root, target);
  if (fs.existsSync(destination)) throw new Error("Restore target already exists; nothing was overwritten");
  fs.mkdirSync(destination); // Parent must already exist; never create arbitrary trees.
  copyInventory(path.join(from, "source"), path.join(destination, "source"), manifest.source.files);
  assertInventory(manifest.source.files, path.join(destination, "source"), manifest.source.sha256, manifest.inventoryHashVersion === undefined);
  if (manifest.hostingArtifact) {
    copyInventory(path.join(from, "hosting-artifact"), path.join(destination, "hosting-artifact"), manifest.hostingArtifact.files);
    assertInventory(manifest.hostingArtifact.files, path.join(destination, "hosting-artifact"), manifest.hostingArtifact.sha256, manifest.inventoryHashVersion === undefined);
  }
  return { destination, sourceSha256: manifest.source.sha256 };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "capture" && args.length <= 1) {
      const { destination, manifest } = captureBaseline(ROOT, args[0]);
      console.log(JSON.stringify({ status: "VERIFIED", destination, files: manifest.source.fileCount,
        sourceSha256: manifest.source.sha256, headSha: manifest.git.headSha, dirty: manifest.git.dirty,
        hostingArtifactFiles: manifest.hostingArtifact?.fileCount ?? 0 }, null, 2));
    } else if (command === "verify" && args.length === 1) {
      const manifest = verifyBaseline(ROOT, args[0]);
      console.log(JSON.stringify({ status: "VERIFIED", files: manifest.source.fileCount, sourceSha256: manifest.source.sha256 }, null, 2));
    } else if (command === "restore" && args.length === 2) {
      console.log(JSON.stringify({ status: "RESTORED_AND_VERIFIED", ...restoreBaseline(ROOT, args[0], args[1]) }, null, 2));
    } else throw new Error("Usage: node tools/remediation-baseline.mjs capture [label] | verify SNAPSHOT | restore SNAPSHOT NEW_LOCAL_DIRECTORY");
  } catch (error) {
    console.error(`[remediation-baseline] ${error.message}`);
    process.exitCode = 1;
  }
}
