/** Visible fail-safe for protected app startup; contains no account data. */
(function protectedAppStartupGuard() {
  "use strict";

  const script = document.currentScript;
  const surface = String(script?.dataset?.surface || "محفوظ");
  let ready = false;
  let firstFailure = "";

  function rememberFailure(value) {
    if (firstFailure) return;
    const resource = String(value?.target?.src || value?.target?.href || "");
    if (resource) {
      try {
        firstFailure = `فائل نہیں ملی: ${new URL(resource, window.location.href).pathname}`;
        return;
      } catch {
        firstFailure = "ضروری فائل لوڈ نہیں ہوئی";
        return;
      }
    }
    const message = String(value?.message || value?.reason?.message || value?.reason || value || "");
    firstFailure = message.replace(/https?:\/\/\S+/gi, "[رابطہ]").slice(0, 180);
  }

  function showFailure() {
    if (ready || document.getElementById("swiftgoStartupFailure")) return;

    const panel = document.createElement("section");
    panel.id = "swiftgoStartupFailure";
    panel.setAttribute("role", "alert");
    Object.assign(panel.style, {
      position: "fixed",
      inset: "16px",
      zIndex: "2147483647",
      margin: "auto",
      maxWidth: "520px",
      height: "fit-content",
      padding: "22px",
      borderRadius: "18px",
      background: "#fff",
      color: "#13231c",
      boxShadow: "0 18px 60px rgba(0,0,0,.3)",
      direction: "rtl",
      fontFamily: "system-ui, sans-serif",
      lineHeight: "1.7",
    });

    const title = document.createElement("h1");
    title.textContent = `${surface} ایپ شروع نہیں ہو سکی`;
    title.style.fontSize = "20px";
    title.style.margin = "0 0 8px";

    const copy = document.createElement("p");
    copy.textContent = "تازہ نسخہ حاصل کرنے کے لیے دوبارہ کوشش کریں۔ مسئلہ برقرار رہے تو اس پیغام کی تصویر بھیجیں۔";
    copy.style.margin = "0 0 14px";

    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "دوبارہ کھولیں";
    Object.assign(retry.style, {
      border: "0",
      borderRadius: "12px",
      padding: "11px 18px",
      background: "#087443",
      color: "#fff",
      fontWeight: "700",
      cursor: "pointer",
    });
    retry.addEventListener("click", () => window.location.reload());

    panel.append(title, copy, retry);
    if (firstFailure) {
      const detail = document.createElement("p");
      detail.textContent = `خرابی: ${firstFailure}`;
      detail.style.cssText = "margin:14px 0 0;font-size:12px;overflow-wrap:anywhere;color:#6b2b24";
      panel.append(detail);
    }
    document.body.append(panel);
  }

  window.addEventListener("swiftgo:app-ready", () => {
    ready = true;
  }, { once: true });
  window.addEventListener("error", rememberFailure, true);
  window.addEventListener("unhandledrejection", (event) => {
    rememberFailure(event.reason);
  });
  window.setTimeout(showFailure, 10000);
})();
