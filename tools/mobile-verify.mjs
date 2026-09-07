/** Isolated, unsigned Android verification. Never overwrites the original web packages. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { safeFile, inventoryTree, inventoryHash, inventoryFiles } from "./source-integrity.mjs";
import { hostingSourceState, BUILD_STAMP } from "./hosting-provenance.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPS = ["customer", "partner", "owner"];
const POINTER = "emulator-data/phase-seven-mobile-current.json";
const CAPACITOR_VERSIONS = Object.freeze({
  "@capacitor/android": "8.5.0",
  "@capacitor/app": "8.1.1",
  "@capacitor/browser": "8.0.4",
  "@capacitor/core": "8.5.0",
  "@capacitor/geolocation": "8.2.2",
  "@capacitor/network": "8.0.1",
  "@capacitor/splash-screen": "8.0.2",
  "@capacitor/status-bar": "8.0.3",
});
function nativeSourceState() {
  const files = [];
  const walk = rel => {
    const absolute = safeFile(ROOT, rel);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (["node_modules", "build", ".gradle", ".idea", "assets", "local.properties", "google-services.json"].includes(name) ||
            /\.(jks|keystore|p12)$/.test(name)) continue;
        walk(rel + "/" + name);
      }
    } else if (stat.isFile()) files.push(rel);
  };
  for (const rel of ["mobile/shared", "mobile/p2p-shared", "mobile/release.properties", "mobile/package.json", "mobile/package-lock.json", "tools/mobile-verify.mjs"]) walk(rel);
  for (const app of APPS) for (const part of ["android", "package.json", "capacitor.config.json"]) walk("mobile/" + app + "/" + part);
  return inventoryHash(inventoryFiles(ROOT, files));
}
function copyTree(from, to) {
  if (fs.lstatSync(from).isSymbolicLink()) throw new Error("LINKED_INPUT");
  fs.mkdirSync(to, { recursive: true });
  for (const item of fs.readdirSync(from, { withFileTypes: true })) {
    if (["node_modules", "build", ".gradle", ".idea", "assets", "local.properties", "google-services.json"].includes(item.name) ||
        /\.(jks|keystore|p12)$/.test(item.name)) continue;
    const source = path.join(from, item.name), dest = path.join(to, item.name);
    if (item.isSymbolicLink()) throw new Error("LINKED_INPUT");
    if (item.isDirectory()) copyTree(source, dest);
    else fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
  }
}
export function verifyMobileSources(root = ROOT) {
  const mobilePackage = JSON.parse(fs.readFileSync(safeFile(root, "mobile/package.json"), "utf8"));
  if (mobilePackage.devDependencies?.["@capacitor/cli"] !== "8.5.0" || mobilePackage.overrides?.uuid !== "11.1.1")
    throw new Error("UNSAFE_MOBILE_TOOLCHAIN_LOCK");
  for (const app of APPS) {
    const read = rel => fs.readFileSync(safeFile(root, "mobile/" + app + "/android/" + rel), "utf8");
    const manifest = read("app/src/main/AndroidManifest.xml"), gradle = read("app/build.gradle");
    const variables = read("variables.gradle"), rootGradle = read("build.gradle"), wrapper = read("gradle/wrapper/gradle-wrapper.properties");
    const appPackage = JSON.parse(fs.readFileSync(safeFile(root, "mobile/" + app + "/package.json"), "utf8"));
    for (const [name, version] of Object.entries(CAPACITOR_VERSIONS)) {
      if (appPackage.dependencies?.[name] !== version) throw new Error(`UNSAFE_CAPACITOR_VERSION:${app}:${name}`);
    }
    if (!manifest.includes('android:allowBackup="false"') || !manifest.includes('android:dataExtractionRules="@xml/data_extraction_rules"') ||
        !manifest.includes('android:usesCleartextTraffic="false"') || !manifest.includes("|navigation|density") ||
        (manifest.match(/android\.permission\.INTERNET/g) || []).length !== 1) throw new Error("UNSAFE_ANDROID_MANIFEST:" + app);
    if (!gradle.includes("minifyEnabled true") || !gradle.includes("shrinkResources true") ||
        !gradle.includes("release.properties") || !gradle.includes("swiftgoUseReleaseSigning")) throw new Error("UNSAFE_RELEASE:" + app);
    if (!variables.includes("compileSdkVersion = 36") || !variables.includes("targetSdkVersion = 36") ||
        !variables.includes("cordovaAndroidVersion = '14.0.1'")) throw new Error("UNSAFE_ANDROID_SDK:" + app);
    if (!rootGradle.includes("com.android.tools.build:gradle:8.13.0") ||
        !rootGradle.includes("com.google.gms:google-services:4.4.4")) throw new Error("UNSAFE_ANDROID_BUILD_PLUGIN:" + app);
    if (!wrapper.includes("gradle-8.14.3-all.zip") ||
        !wrapper.includes("ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c"))
      throw new Error("UNSAFE_GRADLE_WRAPPER:" + app);
  }
  return { ok: true, apps: APPS };
}
export function packageWebSlice(dist, dest, app) {
  if (!APPS.includes(app) || fs.existsSync(dest)) throw new Error("INVALID_OR_EXISTING_PACKAGE");
  const files = inventoryTree(dist, { paths: [app, "shared", "driver-app", "customer-app", "legal"] });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of files) {
    const target = safeFile(dest, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(safeFile(dist, entry.path), target, fs.constants.COPYFILE_EXCL);
  }
  // Preserve hosted subdirectories, so ../../shared and absolute role paths both resolve.
  fs.writeFileSync(safeFile(dest, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./' + app + '/"><a href="./' + app + '/">Open app</a>', { flag: "wx" });
  const packaged = inventoryTree(dest);
  fs.writeFileSync(safeFile(dest, "mobile-verification.json"), JSON.stringify({
    verificationOnly: true, app, artifactSha256: inventoryHash(packaged), files: packaged,
  }, null, 2));
  return packaged.length;
}
export function verifyWebSlice(dest, app) {
  if (!APPS.includes(app)) throw new Error("INVALID_APP");
  const entry = { customer: "app.js", partner: "driver-app.js", owner: "owner-app.js" }[app];
  const seen = new Set();
  function visit(relative) {
    if (seen.has(relative)) return;
    const file = safeFile(dest, relative);
    if (!fs.existsSync(file)) throw new Error("MISSING_MOBILE_DEPENDENCY:" + relative);
    seen.add(relative);
    if (!/\.m?js$/.test(relative)) return;
    const code = fs.readFileSync(file, "utf8");
    for (const match of code.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      const spec = match[1];
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      const url = new URL(spec, "https://local/" + relative);
      visit(decodeURIComponent(url.pathname.slice(1)));
    }
  }
  visit(app + "/js/" + entry);
  return seen.size;
}
function prepare() {
  verifyMobileSources();
  const nativeSourceSha256 = nativeSourceState();
  execFileSync(process.execPath, [safeFile(ROOT, "tools/build-hosting.mjs"), "--isolated-test"], { cwd: ROOT, stdio: "inherit" });
  const dist = safeFile(ROOT, "emulator-data/phase-two-hosting-check");
  const stamp = JSON.parse(fs.readFileSync(safeFile(dist, BUILD_STAMP), "utf8"));
  if (!stamp.verificationOnly || stamp.sourceSha256 !== hostingSourceState(ROOT).sourceSha256 ||
      stamp.artifactSha256 !== inventoryHash(inventoryTree(dist, { exclude: [BUILD_STAMP] }))) throw new Error("STALE_HOSTING_INPUT");
  const relative = "emulator-data/phase-seven-mobile-" + new Date().toISOString().replace(/[:.]/g, "-");
  const workspace = safeFile(ROOT, relative);
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(workspace, "mobile"));
  for (const file of ["package.json", "package-lock.json", "release.properties"]) {
    fs.copyFileSync(safeFile(ROOT, "mobile/" + file), safeFile(workspace, "mobile/" + file), fs.constants.COPYFILE_EXCL);
  }
  copyTree(safeFile(ROOT, "mobile/shared"), safeFile(workspace, "mobile/shared"));
  copyTree(safeFile(ROOT, "mobile/p2p-shared"), safeFile(workspace, "mobile/p2p-shared"));
  const counts = {};
  for (const app of APPS) {
    const target = safeFile(workspace, "mobile/" + app);
    fs.mkdirSync(target);
    for (const file of ["package.json", "capacitor.config.json"]) {
      fs.copyFileSync(safeFile(ROOT, "mobile/" + app + "/" + file), safeFile(target, file), fs.constants.COPYFILE_EXCL);
    }
    copyTree(safeFile(ROOT, "mobile/" + app + "/android"), safeFile(target, "android"));
    counts[app] = packageWebSlice(dist, safeFile(target, "www"), app);
    verifyWebSlice(safeFile(target, "www"), app);
  }
  if (nativeSourceSha256 !== nativeSourceState()) throw new Error("NATIVE_SOURCE_CHANGED_DURING_COPY");
  const report = { verificationOnly: true, relative, sourceSha256: stamp.sourceSha256, nativeSourceSha256, webFileCounts: counts };
  fs.writeFileSync(safeFile(workspace, "verification.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  fs.writeFileSync(safeFile(ROOT, POINTER), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
function build(app) {
  if (!APPS.includes(app)) throw new Error("INVALID_APP");
  const pointer = JSON.parse(fs.readFileSync(safeFile(ROOT, POINTER), "utf8"));
  if (!pointer.verificationOnly || !/^emulator-data\/phase-seven-mobile-[0-9TZ-]+$/.test(pointer.relative)) throw new Error("INVALID_WORKSPACE");
  const workspace = safeFile(ROOT, pointer.relative), appRoot = safeFile(workspace, "mobile/" + app);
  if (pointer.sourceSha256 !== hostingSourceState(ROOT).sourceSha256 || pointer.nativeSourceSha256 !== nativeSourceState())
    throw new Error("Source changed since preparation; prepare a new isolated workspace");
  const cli = safeFile(workspace, "mobile/node_modules/@capacitor/cli/bin/capacitor");
  if (!fs.existsSync(cli)) throw new Error("Run npm ci --ignore-scripts inside " + safeFile(workspace, "mobile"));
  execFileSync(process.execPath, [cli, "sync", "android"], { cwd: appRoot, stdio: "inherit" });
  // No signing properties are enabled. A package made here is never a deployment approval.
  const args = ["--no-daemon", "--max-workers=2", ":app:testDebugUnitTest", ":app:assembleDebugAndroidTest", ":app:assembleRelease"];
  const android = safeFile(appRoot, "android");
  if (process.platform === "win32") execFileSync("cmd.exe", ["/d", "/c", "gradlew.bat", ...args], { cwd: android, stdio: "inherit" });
  else execFileSync("./gradlew", args, { cwd: android, stdio: "inherit" });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "prepare") prepare();
    else if (process.argv[2] === "build") build(process.argv[3]);
    else if (process.argv[2] === "check") console.log(JSON.stringify(verifyMobileSources()));
    else throw new Error("Usage: mobile-verify.mjs prepare | check | build customer|partner|owner");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
