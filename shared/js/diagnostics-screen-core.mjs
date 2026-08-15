/**
 * Field Diagnostics screen binder — live summary + Copy report.
 * Used by customer and driver apps (inlined into app js/ on hosting build).
 *
 * Summary/log use the lightweight field-diagnostics singleton immediately.
 * Phase 1/2/3 copy actions await ensureFieldDiagnosticReports() once.
 */

import {
  getFieldDiagnostics,
  installFieldDiagnostics,
  ensureFieldDiagnosticReports,
} from "./field-diagnostics.mjs";

function fmtAge(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTs(ms) {
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

function fmtCoord(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return "—";
  return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {{
 *   role: "customer"|"driver",
 *   summaryId: string,
 *   logId: string,
 *   copyBtnId: string,
 *   clearBtnId?: string,
 *   statusId?: string,
 *   phase1CopyBtnId?: string,
 *   phase2CopyBtnId?: string,
 *   phase3CopyBtnId?: string,
 *   onCopied?: (ok: boolean) => void,
 * }} opts
 */
export function initDiagnosticsScreen(opts) {
  const diag = installFieldDiagnostics({ role: opts.role });
  const summaryEl = document.getElementById(opts.summaryId);
  const logEl = document.getElementById(opts.logId);
  const copyBtn = document.getElementById(opts.copyBtnId);
  const phase1Btn = opts.phase1CopyBtnId
    ? document.getElementById(opts.phase1CopyBtnId)
    : null;
  const phase2Btn = opts.phase2CopyBtnId
    ? document.getElementById(opts.phase2CopyBtnId)
    : null;
  const phase3Btn = opts.phase3CopyBtnId
    ? document.getElementById(opts.phase3CopyBtnId)
    : null;
  const clearBtn = opts.clearBtnId ? document.getElementById(opts.clearBtnId) : null;
  const statusEl = opts.statusId ? document.getElementById(opts.statusId) : null;

  let refreshTimer = 0;
  let reportsReady = false;

  function setPhaseButtonsEnabled(enabled) {
    for (const btn of [phase1Btn, phase2Btn, phase3Btn]) {
      if (!btn) continue;
      btn.disabled = !enabled;
      if (enabled) btn.removeAttribute("aria-busy");
      else btn.setAttribute("aria-busy", "true");
    }
  }

  setPhaseButtonsEnabled(false);

  const reportsReadyPromise = ensureFieldDiagnosticReports({ role: opts.role })
    .then((readyDiag) => {
      reportsReady = true;
      setPhaseButtonsEnabled(true);
      return readyDiag;
    })
    .catch((err) => {
      if (statusEl) {
        statusEl.textContent = `Phase reports unavailable: ${err?.message || err}`;
      }
      throw err;
    });

  function render() {
    const snap = diag.getSnapshot();
    if (summaryEl) {
      const rows = [
        ["Role", snap.role],
        ["Ride", snap.rideId ? `${snap.rideId} (${snap.rideStatus || "?"})` : "—"],
        ["Firebase auth", snap.firebase.authUidPresent ? "yes" : "no"],
        ["Firebase snapshot", fmtTs(snap.firebase.lastSnapshotAt)],
        ["Firebase write", fmtTs(snap.firebase.lastWriteAt)],
        ["Firebase error", snap.firebase.lastError || "—"],
        ["P2P state", snap.p2p.state || "—"],
        ["P2P healthy", snap.p2p.healthy == null ? "—" : String(snap.p2p.healthy)],
        ["P2P last diag", snap.p2p.lastDiag || "—"],
        ["P2P recv", fmtTs(snap.p2p.lastRecvAt)],
        ["GPS last", fmtTs(snap.gps.lastAt)],
        ["GPS coords", fmtCoord(snap.gps.lastLat, snap.gps.lastLng)],
        ["GPS interval", fmtAge(snap.gps.intervalMs)],
        ["GPS error", snap.gps.errorCode || "—"],
        ["Publish last", `${fmtTs(snap.publish.lastAt)} (${snap.publish.lastChannel || "—"})`],
        ["Publish interval", fmtAge(snap.publish.intervalMs)],
        ["FB writes / P2P sends", `${snap.publish.firebaseCount} / ${snap.publish.p2pCount}`],
        ["Receive last", `${fmtTs(snap.receive.lastAt)} (${snap.receive.lastSource || "—"})`],
        ["Receive coords", fmtCoord(snap.receive.lastLat, snap.receive.lastLng)],
        ["Receive interval", fmtAge(snap.receive.intervalMs)],
        ["FB recv / P2P recv", `${snap.receive.firebaseCount} / ${snap.receive.p2pCount}`],
        ["Freshness", `${snap.freshness.lastClass || "—"} / ${fmtAge(snap.freshness.lastAgeMs)}`],
        ["Freshness UI", snap.freshness.lastUiMessage || "—"],
        [
          "Routing",
          snap.routing.lastDiag
            ? `${snap.routing.lastDiag.reason || "?"} @ ${fmtTs(snap.routing.lastAt)}`
            : "—",
        ],
        ["Events / errors", `${snap.counters.events} / ${snap.counters.errors}`],
        ["Phase reports", reportsReady ? "ready" : "loading"],
      ];
      summaryEl.innerHTML = rows
        .map(
          ([k, v]) =>
            `<div class="diag-row"><span class="diag-row__k">${escapeHtml(k)}</span><span class="diag-row__v">${escapeHtml(
              String(v)
            )}</span></div>`
        )
        .join("");
    }
    if (logEl) {
      const recent = (snap.recentEvents || []).slice(-40).reverse();
      logEl.textContent = recent
        .map((e) => {
          const t = fmtTs(e.ts);
          const plain = e.data?.plainText || e.data?.reasonPlain || e.data?.writeReasonPlain || "";
          const d = e.data ? JSON.stringify(e.data) : "";
          return plain
            ? `${t}  ${e.type}\n${plain}`
            : `${t}  ${e.type}  ${d}`;
        })
        .join("\n\n");
    }
  }

  function startRefresh() {
    stopRefresh();
    render();
    refreshTimer = window.setInterval(render, 1000);
    void reportsReadyPromise.catch(() => {});
  }

  function stopRefresh() {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = 0;
    }
  }

  copyBtn?.addEventListener("click", async () => {
    try {
      const result = await diag.copyReport();
      if (statusEl) {
        statusEl.textContent = result.ok
          ? `Report copied (${result.bytes} chars)`
          : "Copy failed — report left on window.__SWIFTGO_LAST_DIAG_REPORT__";
      }
      if (!result.ok && result.text) {
        window.__SWIFTGO_LAST_DIAG_REPORT__ = result.text;
      }
      opts.onCopied?.(Boolean(result.ok));
    } catch (err) {
      if (statusEl) statusEl.textContent = `Copy error: ${err?.message || err}`;
      opts.onCopied?.(false);
    }
  });

  async function copyPhaseReport(copyFnName, okLabel) {
    try {
      if (statusEl && !reportsReady) statusEl.textContent = "Loading phase reports…";
      const ready = await ensureFieldDiagnosticReports({ role: opts.role });
      const result = await ready[copyFnName]();
      if (statusEl) {
        statusEl.textContent = result.ok
          ? `${okLabel} (${result.bytes} chars)`
          : "Copy failed — see window.__SWIFTGO_LAST_DIAG_REPORT__";
      }
      if (!result.ok && result.text) {
        window.__SWIFTGO_LAST_DIAG_REPORT__ = result.text;
      }
      opts.onCopied?.(Boolean(result.ok));
    } catch (err) {
      if (statusEl) statusEl.textContent = `Copy error: ${err?.message || err}`;
      opts.onCopied?.(false);
    }
  }

  phase1Btn?.addEventListener("click", () =>
    copyPhaseReport("copyPhase1Reports", "Phase 1 reports copied")
  );
  phase2Btn?.addEventListener("click", () =>
    copyPhaseReport("copyPhase2Reports", "Phase 2 verification copied")
  );
  phase3Btn?.addEventListener("click", () =>
    copyPhaseReport("copyPhase3Reports", "Phase 3 billing proof copied")
  );

  clearBtn?.addEventListener("click", () => {
    diag.clear();
    render();
    if (statusEl) statusEl.textContent = "Diagnostics cleared";
  });

  return {
    diag,
    render,
    onShow: startRefresh,
    onHide: stopRefresh,
    ensureReports: () => ensureFieldDiagnosticReports({ role: opts.role }),
    getFieldDiagnostics,
  };
}
