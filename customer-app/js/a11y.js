/**
 * Phase 4B — shared accessibility helpers (focus trap, live announce, reduced motion).
 * Keep announcements short; avoid noisy repeats.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let liveRegion = null;
let lastAnnounce = { text: "", at: 0 };

export function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

export function applyReducedMotionClass(root = document.documentElement) {
  if (!root) return;
  const sync = () => {
    root.classList.toggle("prefers-reduced-motion", prefersReducedMotion());
  };
  sync();
  try {
    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", sync);
  } catch {
    /* older browsers */
  }
}

function ensureLiveRegion() {
  if (liveRegion && document.body.contains(liveRegion)) return liveRegion;
  liveRegion = document.createElement("div");
  liveRegion.id = "swiftgoA11yLive";
  liveRegion.className = "a11y-live-region";
  liveRegion.setAttribute("role", "status");
  liveRegion.setAttribute("aria-live", "polite");
  liveRegion.setAttribute("aria-atomic", "true");
  liveRegion.style.cssText =
    "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;";
  document.body.appendChild(liveRegion);
  return liveRegion;
}

/**
 * @param {string} message
 * @param {{ assertive?: boolean, force?: boolean }} [opts]
 */
export function announce(message, opts = {}) {
  const text = String(message || "").trim();
  if (!text) return;
  const now = Date.now();
  if (!opts.force && text === lastAnnounce.text && now - lastAnnounce.at < 2500) return;
  lastAnnounce = { text, at: now };
  const el = ensureLiveRegion();
  el.setAttribute("aria-live", opts.assertive ? "assertive" : "polite");
  el.textContent = "";
  window.requestAnimationFrame(() => {
    el.textContent = text;
  });
}

function listFocusable(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.closest("[hidden]")) return false;
    if (el.disabled) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  });
}

/**
 * @param {HTMLElement} container dialog / overlay root
 * @param {{ dismissible?: boolean, onDismiss?: () => void, initialFocus?: HTMLElement | null }} [options]
 */
export function trapFocus(container, options = {}) {
  if (!container) return () => {};
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dismissible = options.dismissible !== false;

  const onKeyDown = (event) => {
    if (event.key === "Escape" && dismissible) {
      event.preventDefault();
      options.onDismiss?.();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = listFocusable(container);
    if (!nodes.length) {
      event.preventDefault();
      container.focus?.();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener("keydown", onKeyDown);
  if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");

  const initial =
    options.initialFocus ||
    listFocusable(container)[0] ||
    container;
  window.requestAnimationFrame(() => initial.focus?.());

  return () => {
    container.removeEventListener("keydown", onKeyDown);
    if (previous && document.contains(previous)) {
      try {
        previous.focus();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Phase 4D — keep focused fields above the on-screen keyboard (visualViewport).
 * Sets --keyboard-inset on :root and scrolls the active control into view.
 */
export function initKeyboardInset(root = document.documentElement) {
  if (typeof window === "undefined" || !window.visualViewport) return () => {};

  const sync = () => {
    const vv = window.visualViewport;
    const obscured = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty("--keyboard-inset", `${Math.round(obscured)}px`);
  };

  const onFocusIn = (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    if (!el.matches("input, textarea, select, [contenteditable='true']")) return;
    window.requestAnimationFrame(() => {
      try {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      } catch {
        el.scrollIntoView(true);
      }
    });
  };

  sync();
  window.visualViewport.addEventListener("resize", sync);
  window.visualViewport.addEventListener("scroll", sync);
  document.addEventListener("focusin", onFocusIn);

  return () => {
    window.visualViewport?.removeEventListener("resize", sync);
    window.visualViewport?.removeEventListener("scroll", sync);
    document.removeEventListener("focusin", onFocusIn);
  };
}

/** Blur focused descendant before hiding overlay — avoids aria-hidden / inert warnings. */
export function releaseFocusFrom(container) {
  if (!container) return;
  const active = document.activeElement;
  if (active && container.contains(active)) active.blur();
}

/** Toggle inert on overlays; always release trapped focus when closing. */
export function setOverlayInert(container, inert) {
  if (!container) return;
  if (inert) {
    releaseFocusFrom(container);
    container.setAttribute("inert", "");
    container.removeAttribute("aria-hidden");
  } else {
    container.removeAttribute("inert");
  }
}
