/** Fail-closed pre/post-build gate. Does not commit, discard, or deploy anything. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeHostingRouting, loadHostingConfig } from "./hosting-routing-config.mjs";
import {
  assertHostingSourcesClean, hostingSourceState, verifyHostingBuild, writeHostingBuildLock,
} from "./hosting-provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertRoutingPolicy() {
  const analysis = analyzeHostingRouting(loadHostingConfig(ROOT));
  if (!analysis.ok) throw new Error(`Hosting routing policy violation: ${JSON.stringify(analysis)}`);
}

try {
  assertHostingSourcesClean(ROOT);
  assertRoutingPolicy();
  if (process.argv.includes("--verify-build")) {
    const stamp = verifyHostingBuild(ROOT, { requireClean: true, requireLock: true });
    console.log(`[hosting-deploy-integrity] post-build PASS; artifact ${stamp.artifactSha256}`);
  } else {
    const state = hostingSourceState(ROOT);
    writeHostingBuildLock(ROOT, state);
    console.log(`[hosting-deploy-integrity] pre-build PASS; HEAD ${state.headSha}; source ${state.sourceSha256}`);
  }
} catch (error) {
  console.error(`[hosting-deploy-integrity] FAIL: ${error.message}`);
  process.exitCode = 1;
}
