import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_START_PARAM,
  beginCanonicalGoogleSignIn,
  buildCanonicalAuthUrl,
  consumeCanonicalAuthStart,
  resumeCanonicalGoogleSignIn,
} from "../shared/js/google-auth-flow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonical = buildCanonicalAuthUrl("https://swiftgo-ride-app.web.app/partner/?lang=ur");
assert.equal(
  canonical,
  `https://swiftgo-ride-app.firebaseapp.com/partner/?lang=ur&${AUTH_START_PARAM}=1`
);

let assigned = "";
let redirectCalls = 0;
const navigationResult = await beginCanonicalGoogleSignIn({
  auth: {},
  provider: {},
  signInWithRedirect: async () => {
    redirectCalls += 1;
  },
  locationLike: {
    hostname: "swiftgo-ride-app.web.app",
    href: "https://swiftgo-ride-app.web.app/admin/",
    assign: (value) => {
      assigned = value;
    },
  },
});
assert.equal(navigationResult, "navigating");
assert.equal(assigned, `https://swiftgo-ride-app.firebaseapp.com/admin/?${AUTH_START_PARAM}=1`);
assert.equal(redirectCalls, 0);

let replaced = "";
const canonicalLocation = {
  hostname: "swiftgo-ride-app.firebaseapp.com",
  href: `https://swiftgo-ride-app.firebaseapp.com/partner/?${AUTH_START_PARAM}=1`,
};
const historyLike = {
  state: { kept: true },
  replaceState: (_state, _title, value) => {
    replaced = value;
    canonicalLocation.href = value;
  },
};
assert.equal(consumeCanonicalAuthStart(canonicalLocation, historyLike), true);
assert.equal(replaced, "https://swiftgo-ride-app.firebaseapp.com/partner/");

canonicalLocation.href = `https://swiftgo-ride-app.firebaseapp.com/partner/?${AUTH_START_PARAM}=1`;
const resumed = await resumeCanonicalGoogleSignIn({
  auth: {},
  provider: {},
  signInWithRedirect: async () => {
    redirectCalls += 1;
  },
  locationLike: canonicalLocation,
  historyLike,
});
assert.equal(resumed, true);
assert.equal(redirectCalls, 1);

for (const [appFile, configFile] of [
  ["driver-app/js/driver-app.js", "driver-app/js/firebase-config.js"],
  ["super-admin-panel/js/admin-app.js", "super-admin-panel/js/firebase-config.js"],
]) {
  const app = fs.readFileSync(path.join(root, appFile), "utf8");
  const config = fs.readFileSync(path.join(root, configFile), "utf8");
  assert.match(app, /beginCanonicalGoogleSignIn/);
  assert.match(app, /resumeCanonicalGoogleSignIn/);
  assert.doesNotMatch(app, /signInWithPopup/);
  assert.match(config, /authDomain: "swiftgo-ride-app\.firebaseapp\.com"/);
}

const buildTool = fs.readFileSync(path.join(root, "tools/build-hosting.mjs"), "utf8");
assert.match(buildTool, /stampModuleEntrypoint\("partner\/index\.html", "js\/driver-app\.js", headSha\)/);
assert.match(buildTool, /stampModuleEntrypoint\("admin\/index\.html", "\/admin\/js\/admin-app\.js", headSha\)/);
assert.match(buildTool, /copySharedCrossAppDependencies\(\)/);

const adminSettings = fs.readFileSync(
  path.join(root, "super-admin-panel/js/admin-settings-client.js"),
  "utf8"
);
assert.match(adminSettings, /export async function callAdmin/);

const firebaseJson = JSON.parse(fs.readFileSync(path.join(root, "firebase.json"), "utf8"));
assert.ok(
  firebaseJson.hosting.predeploy.includes("node tools/hosting-startup-health.mjs --no-write")
);

console.log("Canonical Google auth flow checks passed.");
