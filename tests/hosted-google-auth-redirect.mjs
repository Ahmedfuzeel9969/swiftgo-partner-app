import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const surfaces = [
  ["driver", "driver-app/js/driver-app.js", "driver-app/js/firebase-config.js"],
  ["admin", "super-admin-panel/js/admin-app.js", "super-admin-panel/js/firebase-config.js"],
];

for (const [name, appFile, configFile] of surfaces) {
  const app = fs.readFileSync(path.join(root, appFile), "utf8");
  const config = fs.readFileSync(path.join(root, configFile), "utf8");

  if (!config.includes('authDomain: "swiftgo-ride-app.web.app"')) {
    throw new Error(`${name}: hosted authDomain is not same-origin`);
  }

  const hostedCheck = app.indexOf('window.location.hostname === "swiftgo-ride-app.web.app"');
  const redirect = app.indexOf("signInWithRedirect(auth, googleProvider)", hostedCheck);
  const popup = app.indexOf("signInWithPopup(auth, googleProvider)", hostedCheck);
  if (hostedCheck < 0 || redirect < 0 || popup < 0 || redirect > popup) {
    throw new Error(`${name}: hosted sign-in must redirect before popup fallback`);
  }
}

console.log("Hosted Google auth redirect checks passed for driver and admin.");
