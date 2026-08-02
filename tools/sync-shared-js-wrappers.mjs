/**
 * Write thin re-export wrappers from shared/js into customer-app/js and driver-app/js.
 * Canonical algorithms live only in shared/js.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = [
  "geometry-quality.mjs",
  "marker-heading.mjs",
  "route-geometry.mjs",
  "road-route-provider.mjs",
  "two-leg-route-controller.mjs",
  "two-leg-route-layers.mjs",
  "route-projection.mjs",
  "route-progress.mjs",
  "route-motion-controller.mjs",
  "off-route-detector.mjs",
  "display-location-pipeline.mjs",
];

const body = (name) =>
  `/** Auto-wrapper: canonical implementation in shared/js. Do not edit algorithms here. */\n` +
  `export * from "../../shared/js/${name}";\n`;

for (const app of ["customer-app/js", "driver-app/js"]) {
  const dir = path.join(ROOT, app);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of MODULES) {
    fs.writeFileSync(path.join(dir, name), body(name));
  }
}
console.info(`Wrote ${MODULES.length} re-export wrappers into customer-app/js and driver-app/js`);
