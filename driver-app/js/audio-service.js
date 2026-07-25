/**
 * Phase 41 — Reusable audio + browser notification service.
 */

const DEFAULTS = Object.freeze({
  isMuted: false,
  selectedTone: "tone1",
  volumeLevel: 0.8,
});

const TONE_LABELS = Object.freeze({
  tone1: "Default Chime",
  tone2: "Bell",
  tone3: "Beep",
});

let storagePrefix = "swiftgo_audio_";
/** @type {Record<string, string>} */
let toneSources = {};

function key(name) {
  return `${storagePrefix}${name}`;
}

function normalizeTone(value) {
  const raw = String(value || DEFAULTS.selectedTone).toLowerCase();
  if (raw.includes("tone3")) return "tone3";
  if (raw.includes("tone2")) return "tone2";
  return "tone1";
}

/** Build a tiny mono WAV data URI (safe inline fallback, no external MP3). */
function buildWavDataUri(frequency, durationSec = 0.22, volume = 0.55) {
  const sampleRate = 22050;
  const numSamples = Math.max(1, Math.floor(sampleRate * durationSec));
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, i / (sampleRate * 0.01)) *
      Math.max(0, 1 - (i / numSamples));
    const sample = Math.sin(2 * Math.PI * frequency * t) * volume * envelope;
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function ensureToneSources() {
  if (Object.keys(toneSources).length) return toneSources;
  toneSources = {
    tone1: buildWavDataUri(880, 0.18, 0.5),
    tone2: buildWavDataUri(660, 0.28, 0.55),
    tone3: buildWavDataUri(440, 0.12, 0.65),
  };
  return toneSources;
}

export function getAudioSettings() {
  let isMuted = DEFAULTS.isMuted;
  try {
    const storedMuted = localStorage.getItem(key("isMuted"));
    if (storedMuted != null) isMuted = storedMuted === "true";
  } catch {
    /* ignore */
  }

  let selectedTone = DEFAULTS.selectedTone;
  try {
    selectedTone = normalizeTone(
      localStorage.getItem(key("selectedTone")) || DEFAULTS.selectedTone
    );
  } catch {
    /* ignore */
  }

  let volumeLevel = DEFAULTS.volumeLevel;
  try {
    const storedVolume = Number(localStorage.getItem(key("volumeLevel")));
    if (Number.isFinite(storedVolume)) {
      volumeLevel = Math.min(1, Math.max(0, storedVolume));
    }
  } catch {
    /* ignore */
  }

  return { isMuted, selectedTone, volumeLevel };
}

export function saveAudioSettings(partial = {}) {
  const current = getAudioSettings();
  const next = {
    isMuted:
      typeof partial.isMuted === "boolean" ? partial.isMuted : current.isMuted,
    selectedTone: partial.selectedTone
      ? normalizeTone(partial.selectedTone)
      : current.selectedTone,
    volumeLevel:
      typeof partial.volumeLevel === "number"
        ? Math.min(1, Math.max(0, partial.volumeLevel))
        : current.volumeLevel,
  };

  try {
    localStorage.setItem(key("isMuted"), String(next.isMuted));
    localStorage.setItem(key("selectedTone"), next.selectedTone);
    localStorage.setItem(key("volumeLevel"), String(next.volumeLevel));
  } catch (error) {
    console.warn("[SwiftGo Audio] save settings", error);
  }

  return next;
}

export function playAlert(force = false) {
  const settings = getAudioSettings();
  if (!force && settings.isMuted) return;

  const toneKey = normalizeTone(settings.selectedTone);
  const sources = ensureToneSources();
  const src = sources[toneKey] || sources.tone1;

  const audio = new Audio(src);
  audio.volume = Math.min(1, Math.max(0, settings.volumeLevel));
  audio.play().catch((error) => {
    console.warn("[SwiftGo Audio] playAlert", error);
  });
}

export async function requestBrowserNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch (error) {
    console.warn("[SwiftGo Audio] notification permission", error);
    return "denied";
  }
}

export function showNotification(title, body, options = {}) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return false;
  }

  try {
    const notification = new Notification(title, {
      body,
      icon: options.icon || undefined,
      tag: options.tag || "swiftgo-alert",
      renotify: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return true;
  } catch (error) {
    console.warn("[SwiftGo Audio] show notification", error);
    return false;
  }
}

export function initAudioService(options = {}) {
  if (options.storagePrefix) storagePrefix = options.storagePrefix;
  ensureToneSources();
}

function bindRangeLabel(rangeEl, labelEl) {
  if (!rangeEl || !labelEl) return;
  const update = () => {
    labelEl.textContent = `${Math.round(Number(rangeEl.value) || 0)}%`;
  };
  rangeEl.addEventListener("input", update);
  update();
}

export function initNotificationSettingsUI(config = {}) {
  const modal = document.getElementById(config.modalId || "notificationSettingsModal");
  const openBtn = document.getElementById(config.openBtnId || "openNotificationSettingsBtn");
  const closeBtn = document.getElementById(config.closeBtnId || "notificationSettingsCloseBtn");
  const backdrop = document.getElementById(config.backdropId || "notificationSettingsBackdrop");
  const muteToggle = document.getElementById(config.muteToggleId || "notificationMuteToggle");
  const toneSelect = document.getElementById(config.toneSelectId || "notificationToneSelect");
  const volumeRange = document.getElementById(config.volumeRangeId || "notificationVolumeRange");
  const volumeLabel = document.getElementById(config.volumeLabelId || "notificationVolumeLabel");
  const testBtn = document.getElementById(config.testBtnId || "notificationTestBtn");
  const permissionBtn = document.getElementById(
    config.permissionBtnId || "notificationPermissionBtn"
  );
  const statusEl = document.getElementById(config.statusId || "notificationSettingsStatus");

  const setStatus = (message = "") => {
    if (statusEl) statusEl.textContent = message;
  };

  const applySettingsToUi = () => {
    const settings = getAudioSettings();
    if (muteToggle) {
      muteToggle.checked = !settings.isMuted;
      muteToggle.setAttribute("aria-checked", String(!settings.isMuted));
    }
    if (toneSelect) toneSelect.value = settings.selectedTone;
    if (volumeRange) {
      volumeRange.value = String(Math.round(settings.volumeLevel * 100));
      if (volumeLabel) {
        volumeLabel.textContent = `${Math.round(settings.volumeLevel * 100)}%`;
      }
    }
  };

  const openModal = () => {
    if (!modal) return;
    applySettingsToUi();
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    requestBrowserNotificationPermission().then((state) => {
      if (state === "granted") setStatus("براؤزر نوٹیفکیشنز فعال ہیں۔");
      else if (state === "denied") setStatus("براؤزر نوٹیفکیشنز بلاک ہیں۔");
      else if (state === "unsupported") setStatus("یہ براؤزر نوٹیفکیشنز سپورٹ نہیں کرتا۔");
    });
  };

  const closeModal = () => {
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  };

  openBtn?.addEventListener("click", openModal);
  closeBtn?.addEventListener("click", closeModal);
  backdrop?.addEventListener("click", closeModal);

  muteToggle?.addEventListener("change", () => {
    const soundOn = Boolean(muteToggle.checked);
    muteToggle.setAttribute("aria-checked", String(soundOn));
    saveAudioSettings({ isMuted: !soundOn });
    setStatus(soundOn ? "آواز آن ہے۔" : "آواز خاموش ہے۔");
  });

  toneSelect?.addEventListener("change", () => {
    saveAudioSettings({ selectedTone: toneSelect.value });
    setStatus("رنگ ٹون محفوظ ہو گیا۔");
  });

  volumeRange?.addEventListener("input", () => {
    const pct = Number(volumeRange.value);
    if (volumeLabel) volumeLabel.textContent = `${Math.round(pct)}%`;
    saveAudioSettings({ volumeLevel: pct / 100 });
  });

  if (volumeRange && volumeLabel) bindRangeLabel(volumeRange, volumeLabel);

  volumeRange?.addEventListener("change", () => {
    setStatus("آواز کی شدت محفوظ ہو گئی۔");
  });

  testBtn?.addEventListener("click", () => {
    playAlert(true);
    showNotification("SwiftGo · ٹیسٹ", "یہ ایک ٹیسٹ نوٹیفکیشن ہے۔");
    setStatus("ٹیسٹ آواز بجائی گئی۔");
  });

  permissionBtn?.addEventListener("click", async () => {
    const state = await requestBrowserNotificationPermission();
    if (state === "granted") setStatus("براؤزر نوٹیفکیشنز فعال ہو گئیں۔");
    else setStatus("براؤزر نوٹیفکیشنز فعال نہیں ہو سکیں۔");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hidden) closeModal();
  });

  applySettingsToUi();
}

export const AudioService = {
  getAudioSettings,
  saveAudioSettings,
  playAlert,
  requestBrowserNotificationPermission,
  showNotification,
  initAudioService,
  initNotificationSettingsUI,
  TONE_LABELS,
};
