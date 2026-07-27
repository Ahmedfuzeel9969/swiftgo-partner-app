/**
 * Dashboard analytics — summary layout + ApexCharts (vanilla integration).
 * Real data: subscribeDriverEarnings + ride outcome counts from Firestore.
 */

import { subscribeDriverEarnings } from "./earnings-service.js";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase } from "./firebase.js";

/** @type {import("apexcharts").ApexCharts | null} */
let earningsChart = null;
/** @type {import("apexcharts").ApexCharts | null} */
let ratioChart = null;
let earningsUnsub = () => {};
let ridesUnsub = () => {};

const DEMO_EARNINGS = {
  categories: ["سوم", "منگل", "بدھ", "جمعر", "جمعہ", "ہفتہ", "اتوار"],
  series: [420, 680, 510, 890, 1200, 760, 536],
};

const DEMO_RATIO = { completed: 80, cancelled: 20 };

function moneyPkr(n) {
  return `Rs. ${Math.round(Math.max(0, Number(n) || 0)).toLocaleString("en-PK")}`;
}

function ensureApex() {
  if (typeof ApexCharts === "undefined") {
    console.warn("[SwiftGo Dashboard] ApexCharts not loaded");
    return false;
  }
  return true;
}

function baseChartOptions() {
  return {
    chart: {
      fontFamily: '"Manrope", "Noto Nastaliq Urdu", system-ui, sans-serif',
      toolbar: { show: false },
      animations: { enabled: true, speed: 450 },
    },
    grid: {
      borderColor: "rgba(148, 163, 184, 0.25)",
      strokeDashArray: 4,
    },
    dataLabels: { enabled: false },
    tooltip: { theme: "light" },
  };
}

function renderEarningsChart(el, daily, useDemo) {
  if (!el || !ensureApex()) return;

  const categories = useDemo
    ? DEMO_EARNINGS.categories
    : daily.map((d) => d.label || d.dateKey);
  const amounts = useDemo ? DEMO_EARNINGS.series : daily.map((d) => Math.round(d.amount || 0));

  const options = {
    ...baseChartOptions(),
    chart: {
      ...baseChartOptions().chart,
      type: "bar",
      height: 280,
    },
    series: [{ name: "کمائی (Rs.)", data: amounts }],
    xaxis: {
      categories,
      labels: { style: { fontSize: "11px" } },
    },
    yaxis: {
      labels: {
        formatter: (v) => `${Math.round(v)}`,
      },
    },
    colors: ["#0b7a4b"],
    plotOptions: {
      bar: {
        borderRadius: 8,
        columnWidth: "55%",
      },
    },
    fill: {
      type: "gradient",
      gradient: {
        shade: "light",
        type: "vertical",
        opacityFrom: 0.95,
        opacityTo: 0.75,
        stops: [0, 100],
      },
    },
  };

  if (earningsChart) {
    earningsChart.updateOptions(options);
    return;
  }
  earningsChart = new ApexCharts(el, options);
  earningsChart.render();
}

function renderRatioChart(el, completed, cancelled, useDemo) {
  if (!el || !ensureApex()) return;

  const comp = useDemo ? DEMO_RATIO.completed : Math.max(0, completed);
  const cancel = useDemo ? DEMO_RATIO.cancelled : Math.max(0, cancelled);
  const total = comp + cancel;
  const safeCompleted = total > 0 ? comp : useDemo ? 80 : 1;
  const safeCancelled = total > 0 ? cancel : useDemo ? 20 : 0;

  const options = {
    ...baseChartOptions(),
    chart: {
      ...baseChartOptions().chart,
      type: "donut",
      height: 280,
    },
    series: [safeCompleted, safeCancelled],
    labels: ["مکمل شدہ سواریاں", "منسوخ شدہ سواریاں"],
    colors: ["#0b7a4b", "#dc2626"],
    legend: {
      position: "bottom",
      fontFamily: '"Noto Nastaliq Urdu", "Manrope", sans-serif',
      fontSize: "13px",
    },
    plotOptions: {
      pie: {
        donut: {
          size: "62%",
          labels: {
            show: true,
            total: {
              show: true,
              label: "کل",
              fontFamily: '"Noto Nastaliq Urdu", sans-serif',
              formatter: () => String(safeCompleted + safeCancelled),
            },
          },
        },
      },
    },
  };

  if (ratioChart) {
    ratioChart.updateOptions(options);
    ratioChart.updateSeries([safeCompleted, safeCancelled]);
    return;
  }
  ratioChart = new ApexCharts(el, options);
  ratioChart.render();
}

function subscribeRideOutcomes(driverUid, onOutcomes) {
  ridesUnsub();
  const { ready, db } = getFirebase();
  if (!ready || !db || !driverUid) {
    onOutcomes({ completed: 0, cancelled: 0 });
    return;
  }

  const q = query(
    collection(db, "rides"),
    where("driverId", "==", driverUid),
    orderBy("createdAt", "desc"),
    limit(80)
  );

  ridesUnsub = onSnapshot(
    q,
    (snap) => {
      let completed = 0;
      let cancelled = 0;
      snap.docs.forEach((docSnap) => {
        const status = docSnap.data().status;
        if (status === "completed") completed += 1;
        else if (
          status === "cancelled_by_user" ||
          status === "cancelled" ||
          status === "declined" ||
          status === "cancelled_by_driver"
        ) {
          cancelled += 1;
        }
      });
      onOutcomes({ completed, cancelled });
    },
    () => onOutcomes({ completed: 0, cancelled: 0 })
  );
}

/**
 * @param {{
 *   getDriverUid: () => string | null,
 *   earningsChartEl: HTMLElement | null,
 *   ratioChartEl: HTMLElement | null,
 * }} config
 */
export function initDriverDashboard(config) {
  const getDriverUid = config.getDriverUid || (() => null);
  const earningsEl = config.earningsChartEl;
  const ratioEl = config.ratioChartEl;

  let lastDaily = [];
  let lastOutcomes = { completed: 0, cancelled: 0 };
  let hasRemoteEarnings = false;
  let hasRemoteOutcomes = false;

  function paintCharts() {
    const useEarningsDemo = !hasRemoteEarnings || !lastDaily.length;
    const useRatioDemo =
      !hasRemoteOutcomes || (lastOutcomes.completed === 0 && lastOutcomes.cancelled === 0);
    renderEarningsChart(earningsEl, lastDaily, useEarningsDemo);
    renderRatioChart(
      ratioEl,
      lastOutcomes.completed,
      lastOutcomes.cancelled,
      useRatioDemo
    );
  }

  function activate() {
    deactivate();
    paintCharts();

    const uid = getDriverUid();
    if (!uid) return;

    earningsUnsub = subscribeDriverEarnings(uid, (snapshot) => {
      if (snapshot?.daily?.length) {
        lastDaily = snapshot.daily;
        hasRemoteEarnings = snapshot.source === "remote";
      }
      paintCharts();
    });

    subscribeRideOutcomes(uid, (outcomes) => {
      lastOutcomes = outcomes;
      hasRemoteOutcomes = true;
      paintCharts();
    });
  }

  function deactivate() {
    earningsUnsub();
    earningsUnsub = () => {};
    ridesUnsub();
    ridesUnsub = () => {};
  }

  function resize() {
    earningsChart?.resize();
    ratioChart?.resize();
  }

  function destroy() {
    deactivate();
    earningsChart?.destroy();
    ratioChart?.destroy();
    earningsChart = null;
    ratioChart = null;
  }

  return { activate, deactivate, resize, destroy };
}

export { moneyPkr };
