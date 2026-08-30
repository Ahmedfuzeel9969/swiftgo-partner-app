/** Byte-level source/artifact inventories. No network calls or source writes. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function safeRelative(value) {
  if (typeof value !== "string" || !value || /[\\\x00-\x1f:]/.test(value) ||
      path.posix.isAbsolute(value) || value.split("/").some((part) =>
        !part || /[. ]$/.test(part) || part.toLowerCase() === ".git" ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  return value;
}

/** Refuse symlinks/junctions rather than following them outside an inventory. */
export function safeFile(root, relative) {
  safeRelative(relative);
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Linked root refused: ${current}`);
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) throw new Error(`Linked path refused: ${relative}`);
  }
  return current;
}

export function inventoryFiles(root, files) {
  return [...new Set(files)].sort().map((relative) => {
    const file = safeFile(root, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${relative}`);
    const bytes = fs.readFileSync(file);
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes), mode: stat.mode & 0o777 };
  });
}

export function inventoryTree(root, { paths = ["."], exclude = [] } = {}) {
  const files = new Set();
  const exclusions = new Set(exclude);
  function walk(relative) {
    if (exclusions.has(relative)) return;
    const absolute = relative === "." ? path.resolve(root) : safeFile(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Linked path refused: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        walk(relative === "." ? name : `${relative}/${name}`);
      }
    } else if (stat.isFile()) files.add(relative);
    else throw new Error(`Special file refused: ${relative}`);
  }
  for (const relative of paths) walk(relative);
  return inventoryFiles(root, [...files]);
}

export function inventoryHash(entries, legacyOrder = false) {
  const seen = new Set();
  const normalized = [...entries].sort((a, b) => legacyOrder ? a.path.localeCompare(b.path, "en") :
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((entry) => {
    safeRelative(entry.path);
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate/case-colliding path: ${entry.path}`);
    seen.add(key);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid inventory record: ${entry.path}`);
    }
    return [entry.path, entry.bytes, entry.sha256];
  });
  return sha256(JSON.stringify(normalized));
}

export function compareInventories(expected, actual) {
  const before = new Map(expected.map((entry) => [entry.path, entry]));
  const after = new Map(actual.map((entry) => [entry.path, entry]));
  return {
    missing: [...before.keys()].filter((name) => !after.has(name)),
    added: [...after.keys()].filter((name) => !before.has(name)),
    changed: [...before.keys()].filter((name) => after.has(name) &&
      (before.get(name).sha256 !== after.get(name).sha256 || before.get(name).bytes !== after.get(name).bytes)),
  };
}

export function git(root, args) {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function gitState(root) {
  const headSha = git(root, ["rev-parse", "HEAD"]).trim();
  let branch = null;
  try { branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(); } catch {}
  const raw = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const fields = raw.split("\0").filter(Boolean);
  const changes = [];
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i].slice(0, 2);
    const change = { status, path: fields[i].slice(3) };
    if (/[RC]/.test(status)) change.originalPath = fields[++i];
    changes.push(change);
  }
  return { headSha, branch, detached: branch === null, dirty: changes.length > 0, changes };
}
