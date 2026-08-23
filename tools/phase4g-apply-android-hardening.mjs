/**
 * After `cap add android`, harden manifests, Gradle versions, deep links, signing hooks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const APPS = [
  {
    id: "customer",
    appId: "com.swiftgo.customer",
    hostPath: "/",
    permissions: ["fine", "coarse", "notifications", "internet", "network"],
    backgroundLocation: false,
  },
  {
    id: "partner",
    appId: "com.swiftgo.partner",
    hostPath: "/partner/",
    permissions: ["fine", "coarse", "background", "notifications", "internet", "network", "foreground-service"],
    backgroundLocation: true,
  },
  {
    id: "owner",
    appId: "com.swiftgo.owner",
    hostPath: "/owner/",
    permissions: ["fine", "coarse", "notifications", "internet", "network"],
    backgroundLocation: false,
  },
];

function ensureLocalProperties(androidDir) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
    path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
  const lp = path.join(androidDir, "local.properties");
  const content = `sdk.dir=${sdk.replace(/\\/g, "/")}\n`;
  fs.writeFileSync(lp, content);
}

function patchManifest(manifestPath, app) {
  let xml = fs.readFileSync(manifestPath, "utf8");

  const permBlock = `
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
${app.backgroundLocation ? `    <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
` : ""}`;

  if (!xml.includes("ACCESS_FINE_LOCATION")) {
    xml = xml.replace(/<manifest[^>]*>/, (m) => `${m}\n${permBlock}`);
  }

  // Deep links / App Links (verify later with Digital Asset Links)
  if (!xml.includes("swiftgo-ride-app.web.app")) {
    const intent = `
        <intent-filter android:autoVerify="true">
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="https" android:host="swiftgo-ride-app.web.app" android:pathPrefix="${app.hostPath === "/" ? "" : app.hostPath.replace(/\/$/, "")}" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="swiftgo" android:host="${app.id}" />
        </intent-filter>`;
    xml = xml.replace(
      /(<activity[^>]*android:name="\.MainActivity"[^>]*>)/,
      `$1\n${intent}`
    );
    // Fallback if attribute order differs
    if (!xml.includes("swiftgo-ride-app.web.app")) {
      xml = xml.replace(
        /(<activity[\s\S]*?android:name="\.MainActivity"[\s\S]*?>)/,
        `$1\n${intent}`
      );
    }
  }

  // Android 13+ notifications already via POST_NOTIFICATIONS
  if (app.backgroundLocation && !xml.includes("DriverLocationForegroundService")) {
    const serviceXml = `
        <service
            android:name=".DriverLocationForegroundService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="location"
            android:stopWithTask="false" />
`;
    if (xml.includes("</application>")) {
      xml = xml.replace("</application>", `${serviceXml}\n    </application>`);
    }
  }
  if (app.backgroundLocation && !xml.includes("WAKE_LOCK")) {
    xml = xml.replace(
      /<manifest[^>]*>/,
      (m) => `${m}\n    <uses-permission android:name="android.permission.WAKE_LOCK" />`
    );
  }
  fs.writeFileSync(manifestPath, xml);
}

function patchAppGradle(appGradlePath, app) {
  let g = fs.readFileSync(appGradlePath, "utf8");
  if (!g.includes("versionCode")) {
    // Capacitor templates already have versionCode — ensure values
  }
  g = g.replace(/versionCode\s+\d+/, "versionCode 10000");
  g = g.replace(/versionName\s+"[^"]+"/, 'versionName "1.0.0-phase4g"');
  g = g.replace(/namespace\s+"[^"]+"/, `namespace "${app.appId}"`);
  g = g.replace(/applicationId\s+"[^"]+"/, `applicationId "${app.appId}"`);

  if (!g.includes("keystore.properties")) {
    const signing = `
// Phase 4G — optional release signing via mobile/signing/keystore.properties
def keystorePropertiesFile = rootProject.file("../../signing/keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
                storeFile rootProject.file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
            }
        }
    }
    buildTypes {
        release {
            if (keystorePropertiesFile.exists()) {
                signingConfig signingConfigs.release
            }
        }
    }
}
`;
    // Safer minimal inject into existing buildTypes.release
    if (g.includes("buildTypes") && !g.includes("signingConfigs")) {
      g = g.replace(
        /buildTypes\s*\{/,
        `signingConfigs {
        release {
            def ksp = rootProject.file("../../signing/keystore.properties")
            if (ksp.exists()) {
                def props = new Properties()
                props.load(new FileInputStream(ksp))
                keyAlias props['keyAlias']
                keyPassword props['keyPassword']
                storeFile rootProject.file(props['storeFile'])
                storePassword props['storePassword']
            }
        }
    }
    buildTypes {`
      );
      g = g.replace(
        /release\s*\{/,
        `release {
            def ksp2 = rootProject.file("../../signing/keystore.properties")
            if (ksp2.exists()) {
                signingConfig signingConfigs.release
            }`
      );
    }
  }

  // minSdk / targetSdk for Android 13–15
  g = g.replace(/minSdkVersion\s+=?\s*\d+/, "minSdkVersion = 24");
  g = g.replace(/targetSdkVersion\s+=?\s*\d+/, "targetSdkVersion = 35");
  g = g.replace(/compileSdk\s+\d+/, "compileSdk 35");
  g = g.replace(/compileSdkVersion\s+\d+/, "compileSdkVersion 35");

  fs.writeFileSync(appGradlePath, g);
}

function patchStrings(stringsPath, label) {
  if (!fs.existsSync(stringsPath)) return;
  let s = fs.readFileSync(stringsPath, "utf8");
  s = s.replace(/<string name="app_name">[^<]*<\/string>/, `<string name="app_name">${label}</string>`);
  fs.writeFileSync(stringsPath, s);
}

for (const app of APPS) {
  const androidDir = path.join(ROOT, "mobile", app.id, "android");
  if (!fs.existsSync(androidDir)) {
    console.warn(`[phase4g] skip ${app.id} — android/ missing (run cap add android first)`);
    continue;
  }
  ensureLocalProperties(androidDir);
  const manifest = path.join(androidDir, "app", "src", "main", "AndroidManifest.xml");
  const gradle = path.join(androidDir, "app", "build.gradle");
  const strings = path.join(androidDir, "app", "src", "main", "res", "values", "strings.xml");
  if (fs.existsSync(manifest)) patchManifest(manifest, app);
  if (fs.existsSync(gradle)) patchAppGradle(gradle, app);
  const labels = { customer: "SwiftGo", partner: "SwiftGo Driver", owner: "SwiftGo Owner" };
  patchStrings(strings, labels[app.id]);
  console.info(`[phase4g] hardened ${app.id}`);
}
