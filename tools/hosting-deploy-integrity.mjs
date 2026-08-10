/**
 * Fail-closed Hosting deploy integrity gate.
 *
 * Runs immediately before `firebase deploy --only hosting` via firebase.json predeploy.
 *
 * Phases:
 *   (default)  Pre-build: verify committed HEAD matches working tree for all
 *              deployment-affecting Hosting sources; record source SHA.
 *   --verify-build  Post-build: verify hosting-dist/.hosting-source.json matches HEAD.
 *
 * Exit 1 on any drift or mismatch.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HOSTING_DEPLOY_SOURCE_PATHS,
  analyzeHostingRouting,
  loadHostingConfig,
} from "./hosting-routing-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VERIFY_BUILD = process.argv.includes("--verify-build");
const STAMP_PATH = path.join(ROOT, "hosting-dist", ".hosting-source.json");

function fail(message) {
  console.error(`\n[hosting-deploy-integrity] FAIL: ${message}`);
  process.exit(1);
}

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (err) {
    const msg = err.stderr?.toString?.() || err.message || String(err);
    fail(`git ${args} failed: ${msg}`);
  }
}

function assertGitRepo() {
  const inside = git("rev-parse --is-inside-work-tree");
  if (inside !== "true") {
    fail("not inside a git work tree — Hosting deploy source must be reproducible from git HEAD");
  }
}

function assertHostingSourcesCommitted() {
  const diff = git(`diff HEAD -- ${HOSTING_DEPLOY_SOURCE_PATHS.join(" ")}`);
  if (diff) {
    fail(
      "uncommitted Hosting deployment source drift detected:\n" +
        diff +
        "\nCommit or discard changes before deploying Hosting."
    );
  }

  const status = git(`status --porcelain -- ${HOSTING_DEPLOY_SOURCE_PATHS.join(" ")}`);
  if (status) {
    fail(
      "untracked or unstaged Hosting deployment files detected:\n" +
        status +
        "\nAll Hosting configuration must be committed before deploy."
    );
  }
}

function assertPathMatchesHead(relPath) {
  try {
    execSync(`git diff --exit-code HEAD -- ${relPath}`, { cwd: ROOT, stdio: "pipe" });
  } catch {
    fail(
      `${relPath} does not exactly match committed HEAD version.\n` +
        "Deploy aborted to prevent uncommitted Hosting configuration from reaching production."
    );
  }
}

function assertFirebaseJsonMatchesHead() {
  assertPathMatchesHead("firebase.json");
}

function assertFirebasercMatchesHead() {
  assertPathMatchesHead(".firebaserc");
}

function assertRoutingPolicy() {
  const hosting = loadHostingConfig(ROOT);
  const analysis = analyzeHostingRouting(hosting);
  if (!analysis.ok) {
    const details = JSON.stringify(
      {
        selfRedirects: analysis.selfRedirects,
        protectedRedirects: analysis.protectedRedirects,
        chainViolations: analysis.chainViolations,
        missingRewrites: analysis.missingRewrites,
      },
      null,
      2
    );
    fail(`Hosting routing policy violation in committed firebase.json:\n${details}`);
  }
}

function readHeadSha() {
  return git("rev-parse HEAD");
}

function writeBuildLock(sha) {
  const lockPath = path.join(ROOT, ".hosting-deploy-lock.json");
  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      {
        headSha: sha,
        recordedAt: new Date().toISOString(),
        hostingPaths: HOSTING_DEPLOY_SOURCE_PATHS,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`[hosting-deploy-integrity] recorded HEAD ${sha}`);
}

function verifyBuildStamp() {
  const headSha = readHeadSha();
  if (!fs.existsSync(STAMP_PATH)) {
    fail(
      `missing ${path.relative(ROOT, STAMP_PATH)} — run build:hosting before deploy`
    );
  }

  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(STAMP_PATH, "utf8"));
  } catch (err) {
    fail(`invalid ${path.relative(ROOT, STAMP_PATH)}: ${err.message}`);
  }

  if (stamp.headSha !== headSha) {
    fail(
      `Hosting build source SHA mismatch.\n` +
        `  build stamp: ${stamp.headSha}\n` +
        `  current HEAD: ${headSha}\n` +
        `Rebuild Hosting from the committed source before deploy.`
    );
  }

  const lockPath = path.join(ROOT, ".hosting-deploy-lock.json");
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock.headSha !== headSha) {
      fail(
        `Hosting deploy lock SHA mismatch.\n` +
          `  lock: ${lock.headSha}\n` +
          `  HEAD: ${headSha}`
      );
    }
  }

  console.log(`[hosting-deploy-integrity] build stamp matches HEAD ${headSha}`);
}

function main() {
  assertGitRepo();

  if (VERIFY_BUILD) {
    verifyBuildStamp();
    console.log("[hosting-deploy-integrity] post-build verification PASS");
    return;
  }

  assertFirebaseJsonMatchesHead();
  assertFirebasercMatchesHead();
  assertHostingSourcesCommitted();
  assertRoutingPolicy();

  const headSha = readHeadSha();
  writeBuildLock(headSha);

  console.log("[hosting-deploy-integrity] pre-build verification PASS");
  console.log(`[hosting-deploy-integrity] deploy source commit: ${headSha}`);
}

main();
