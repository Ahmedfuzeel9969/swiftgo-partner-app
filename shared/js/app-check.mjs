import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js";
import { APP_CHECK_CONFIG } from "./app-check-config.mjs";
const initialized = new WeakMap();
export function configureAppCheck(app, { emulator = false } = {}) {
  if (emulator || !APP_CHECK_CONFIG.siteKey) return { state: emulator ? "emulator" : "not_configured" };
  if (initialized.has(app)) return initialized.get(app);
  const instance = initializeAppCheck(app, { provider: new ReCaptchaV3Provider(APP_CHECK_CONFIG.siteKey), isTokenAutoRefreshEnabled: true });
  const result = { state: "configured", instance }; initialized.set(app, result); return result;
}
