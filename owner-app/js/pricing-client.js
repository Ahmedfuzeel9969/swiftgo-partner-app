/**
 * Owner — read-only pricing from settings/pricing for rate transparency.
 */

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirebase, isFirebaseConfigured } from "./firebase.js";

export const FALLBACK_VEHICLE_RATES = Object.freeze({
  bike: Object.freeze({ baseFare: 40, perKmRate: 15, commissionPercent: 10, distanceTiers: [], paceTiers: [] }),
  go: Object.freeze({ baseFare: 100, perKmRate: 35, commissionPercent: 10, distanceTiers: [], paceTiers: [] }),
  "go-plus": Object.freeze({ baseFare: 130, perKmRate: 40, commissionPercent: 10, distanceTiers: [], paceTiers: [] }),
  business: Object.freeze({ baseFare: 200, perKmRate: 60, commissionPercent: 10, distanceTiers: [], paceTiers: [] }),
  "bike-cargo": Object.freeze({ baseFare: 60, perKmRate: 20, commissionPercent: 10, distanceTiers: [], paceTiers: [] }),
  suzuki: Object.freeze({ baseFare: 250, perKmRate: 50, commissionPercent: 10, distanceTiers: [], paceTiers: [] }),
  truck: Object.freeze({ baseFare: 500, perKmRate: 80, commissionPercent: 10, distanceTiers: [], paceTiers: [] }),
});

export const VEHICLE_LABELS = Object.freeze({
  bike: "بائیک",
  go: "Go",
  "go-plus": "Go Plus",
  business: "Business",
  "bike-cargo": "بائیک کارگو",
  suzuki: "سوزوکی",
  truck: "ٹرک",
});

const money = (n) => `Rs. ${Math.round(Math.max(0, Number(n) || 0)).toLocaleString("en-PK")}`;

let pricingCache = null;
let pricingPromise = null;

function normalizeDistanceTiers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => {
      const upToRaw = row?.upToKm;
      const upToKm =
        upToRaw === null || upToRaw === undefined || upToRaw === "" ? null : Number(upToRaw);
      const baseFare = Number(row?.baseFare);
      const perKmRate = Number(row?.perKmRate);
      if (!Number.isFinite(baseFare) || baseFare < 0) return null;
      if (!Number.isFinite(perKmRate) || perKmRate < 0) return null;
      if (upToKm !== null && (!Number.isFinite(upToKm) || upToKm <= 0)) return null;
      return { upToKm, baseFare, perKmRate };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const av = a.upToKm == null ? Number.POSITIVE_INFINITY : a.upToKm;
      const bv = b.upToKm == null ? Number.POSITIVE_INFINITY : b.upToKm;
      return av - bv;
    });
}

function normalizePaceTiers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => {
      const maxRaw = row?.maxMinPerKm;
      const maxMinPerKm =
        maxRaw === null || maxRaw === undefined || maxRaw === "" ? null : Number(maxRaw);
      const baseFare = Number(row?.baseFare);
      const perKmRate = Number(row?.perKmRate);
      if (!Number.isFinite(baseFare) || baseFare < 0) return null;
      if (!Number.isFinite(perKmRate) || perKmRate < 0) return null;
      if (maxMinPerKm !== null && (!Number.isFinite(maxMinPerKm) || maxMinPerKm <= 0)) return null;
      return { maxMinPerKm, baseFare, perKmRate };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const av = a.maxMinPerKm == null ? Number.POSITIVE_INFINITY : a.maxMinPerKm;
      const bv = b.maxMinPerKm == null ? Number.POSITIVE_INFINITY : b.maxMinPerKm;
      return av - bv;
    });
}

function normalizeRate(raw, fallback) {
  const base = fallback || FALLBACK_VEHICLE_RATES.go;
  const baseFare = Number(raw?.baseFare ?? raw?.base);
  const perKmRate = Number(raw?.perKmRate ?? raw?.perKm);
  const commissionPercent = Number(raw?.commissionPercent);
  return {
    baseFare: Number.isFinite(baseFare) && baseFare >= 0 ? baseFare : base.baseFare,
    perKmRate: Number.isFinite(perKmRate) && perKmRate >= 0 ? perKmRate : base.perKmRate,
    commissionPercent:
      Number.isFinite(commissionPercent) && commissionPercent >= 0 && commissionPercent <= 100
        ? commissionPercent
        : base.commissionPercent,
    distanceTiers: normalizeDistanceTiers(raw?.distanceTiers ?? base.distanceTiers),
    paceTiers: normalizePaceTiers(raw?.paceTiers ?? base.paceTiers),
  };
}

export function normalizePricingSettings(data = {}) {
  const legacy = {
    baseFare: Number(data.baseFare),
    perKmRate: Number(data.perKmRate),
    commissionPercent: Number(data.commissionPercent),
  };
  const hasLegacy =
    Number.isFinite(legacy.baseFare) ||
    Number.isFinite(legacy.perKmRate) ||
    Number.isFinite(legacy.commissionPercent);
  const legacyRate = hasLegacy
    ? normalizeRate(
        {
          baseFare: Number.isFinite(legacy.baseFare) ? legacy.baseFare : FALLBACK_VEHICLE_RATES.go.baseFare,
          perKmRate: Number.isFinite(legacy.perKmRate) ? legacy.perKmRate : FALLBACK_VEHICLE_RATES.go.perKmRate,
          commissionPercent: Number.isFinite(legacy.commissionPercent)
            ? legacy.commissionPercent
            : FALLBACK_VEHICLE_RATES.go.commissionPercent,
        },
        FALLBACK_VEHICLE_RATES.go
      )
    : null;

  const vehicles = {};
  Object.keys(FALLBACK_VEHICLE_RATES).forEach((key) => {
    vehicles[key] = normalizeRate(
      data?.vehicles?.[key] || legacyRate || FALLBACK_VEHICLE_RATES[key],
      FALLBACK_VEHICLE_RATES[key]
    );
  });
  const go = vehicles.go;
  return {
    walletThreshold: Number(data.walletThreshold),
    baseFare: go.baseFare,
    perKmRate: go.perKmRate,
    commissionPercent: go.commissionPercent,
    vehicles,
  };
}

export function resolveVehicleKeyFromLabel(label) {
  const raw = String(label || "").trim().toLowerCase();
  if (!raw) return "";
  const map = {
    bike: "bike",
    بائیک: "bike",
    go: "go",
    گو: "go",
    "go plus": "go-plus",
    "go-plus": "go-plus",
    "گو پلس": "go-plus",
    business: "business",
    بزنس: "business",
    "bike cargo": "bike-cargo",
    "bike-cargo": "bike-cargo",
    "بائیک کارگو": "bike-cargo",
    suzuki: "suzuki",
    سوزوکی: "suzuki",
    truck: "truck",
    ٹرک: "truck",
  };
  return map[raw] || "";
}

export function getVehicleRates(pricing, vehicleKey) {
  const key = vehicleKey || "go";
  const fromMap = pricing?.vehicles?.[key];
  if (fromMap) return fromMap;
  const fallback = FALLBACK_VEHICLE_RATES[key];
  if (fallback) return fallback;
  return {
    baseFare: pricing?.baseFare ?? FALLBACK_VEHICLE_RATES.go.baseFare,
    perKmRate: pricing?.perKmRate ?? FALLBACK_VEHICLE_RATES.go.perKmRate,
    commissionPercent: pricing?.commissionPercent ?? FALLBACK_VEHICLE_RATES.go.commissionPercent,
    distanceTiers: [],
    paceTiers: [],
  };
}

/** Pick effective base/perKm from distance range, then optional pace (min/km) override. */
export function resolveEffectiveRates(rates, distanceKm, timeMins) {
  const distance = Number(distanceKm);
  const time = Number(timeMins);
  let baseFare = Number(rates?.baseFare) || 0;
  let perKmRate = Number(rates?.perKmRate) || 0;
  let distanceTierLabel = null;
  let paceTierLabel = null;

  const distanceTiers = Array.isArray(rates?.distanceTiers) ? rates.distanceTiers : [];
  if (distanceTiers.length && Number.isFinite(distance) && distance >= 0) {
    const match = distanceTiers.find((tier) => tier.upToKm == null || distance <= tier.upToKm);
    if (match) {
      baseFare = match.baseFare;
      perKmRate = match.perKmRate;
      distanceTierLabel =
        match.upToKm == null ? "باقی تمام فاصلے" : `${match.upToKm} km تک`;
    }
  }

  const paceTiers = Array.isArray(rates?.paceTiers) ? rates.paceTiers : [];
  if (
    paceTiers.length &&
    Number.isFinite(distance) &&
    distance > 0 &&
    Number.isFinite(time) &&
    time >= 0
  ) {
    const minPerKm = time / distance;
    const match = paceTiers.find((tier) => tier.maxMinPerKm == null || minPerKm <= tier.maxMinPerKm);
    if (match) {
      baseFare = match.baseFare;
      perKmRate = match.perKmRate;
      paceTierLabel =
        match.maxMinPerKm == null
          ? "ہر رفتار"
          : `${match.maxMinPerKm} منٹ/کلومیٹر یا سست`;
    }
  }

  return { baseFare, perKmRate, distanceTierLabel, paceTierLabel };
}

export function calculateVehicleFare(rates, distanceKm, timeMins) {
  const { baseFare, perKmRate } = resolveEffectiveRates(rates, distanceKm, timeMins);
  const distance = Number(distanceKm);
  if (![baseFare, perKmRate, distance].every((n) => Number.isFinite(n) && n >= 0)) return 0;
  return Math.round(baseFare + distance * perKmRate);
}

export async function loadDriverPricing(force = false) {
  if (!force && pricingCache) return pricingCache;
  if (!force && pricingPromise) return pricingPromise;

  pricingPromise = (async () => {
    if (!isFirebaseConfigured()) {
      pricingCache = { ...normalizePricingSettings({}), source: "fallback" };
      return pricingCache;
    }
    try {
      const { db, auth } = getFirebase();
      if (!auth?.currentUser || !db) {
        pricingCache = { ...normalizePricingSettings({}), source: "fallback" };
        return pricingCache;
      }
      const snap = await getDoc(doc(db, "settings", "pricing"));
      pricingCache = {
        ...normalizePricingSettings(snap.exists() ? snap.data() : {}),
        source: snap.exists() ? "firestore" : "fallback",
      };
      return pricingCache;
    } catch (err) {
      console.warn("[SwiftGo Owner] loadDriverPricing", err);
      pricingCache = { ...normalizePricingSettings({}), source: "fallback" };
      return pricingCache;
    } finally {
      pricingPromise = null;
    }
  })();

  return pricingPromise;
}

function tierTableHtml(title, rows, kind) {
  if (!rows.length) return "";
  const head =
    kind === "distance"
      ? `<tr><th>فاصلہ</th><th>ابتدائی</th><th>فی کلومیٹر</th></tr>`
      : `<tr><th>رفتار (منٹ/کلومیٹر)</th><th>ابتدائی</th><th>فی کلومیٹر</th></tr>`;
  const body = rows
    .map((row) => {
      const label =
        kind === "distance"
          ? row.upToKm == null
            ? "باقی تمام"
            : `${row.upToKm} km تک`
          : row.maxMinPerKm == null
            ? "ہر رفتار"
            : `${row.maxMinPerKm} یا سست`;
      return `<tr><td>${label}</td><td>${money(row.baseFare)}</td><td>${money(row.perKmRate)}</td></tr>`;
    })
    .join("");
  return `
    <section class="rate-details__section">
      <h3 class="rate-details__section-title">${title}</h3>
      <table class="rate-details__table"><thead>${head}</thead><tbody>${body}</tbody></table>
    </section>`;
}

function vehicleSummaryHtml(key, rates) {
  const label = VEHICLE_LABELS[key] || key;
  return `
    <article class="rate-details__vehicle-card">
      <h3>${label}</h3>
      <dl class="rate-details__dl">
        <div><dt>ابتدائی کرایا</dt><dd>${money(rates.baseFare)}</dd></div>
        <div><dt>فی کلومیٹر ریٹ</dt><dd>${money(rates.perKmRate)}</dd></div>
        <div><dt>کمیشن</dt><dd>${rates.commissionPercent}%</dd></div>
      </dl>
      ${tierTableHtml("فاصلہ کی بنیاد پر", rates.distanceTiers, "distance")}
      ${tierTableHtml("وقت / رفتار کی بنیاد پر", rates.paceTiers, "pace")}
    </article>`;
}

/**
 * @param {object} pricing
 * @param {{ vehicleTypeKey?: string, vehicleTypeLabel?: string, distanceKm?: number|null, durationMin?: number|null, estimatedFare?: number|null, mode?: 'ride'|'all' }} ctx
 */
export function buildRateDetailsHtml(pricing, ctx = {}) {
  const mode = ctx.mode || (ctx.vehicleTypeKey || ctx.vehicleTypeLabel ? "ride" : "all");
  const vehicleKey =
    ctx.vehicleTypeKey ||
    resolveVehicleKeyFromLabel(ctx.vehicleTypeLabel) ||
    "go";
  const vehicleLabel = ctx.vehicleTypeLabel || VEHICLE_LABELS[vehicleKey] || vehicleKey;
  const rates = getVehicleRates(pricing, vehicleKey);
  const distanceKm = Number(ctx.distanceKm);
  const durationMin = Number(ctx.durationMin);
  const hasTrip = Number.isFinite(distanceKm) && distanceKm >= 0;
  const hasTime = Number.isFinite(durationMin) && durationMin > 0;
  const effective = resolveEffectiveRates(rates, hasTrip ? distanceKm : null, hasTime ? durationMin : null);
  const calculatedFare = hasTrip ? calculateVehicleFare(rates, distanceKm, hasTime ? durationMin : null) : null;
  const kmPart = hasTrip ? Math.round(effective.perKmRate * distanceKm) : null;

  let tripBlock = "";
  if (mode === "ride") {
    tripBlock = `
      <section class="rate-details__hero">
        <p class="rate-details__eyebrow">${vehicleLabel} · اس سواری کے لیے</p>
        <dl class="rate-details__dl rate-details__dl--hero">
          <div><dt>ابتدائی کرایا</dt><dd>${money(effective.baseFare)}</dd></div>
          <div><dt>فی کلومیٹر ریٹ</dt><dd>${money(effective.perKmRate)}</dd></div>
          ${hasTrip ? `<div><dt>فاصلہ</dt><dd>${distanceKm} km</dd></div>` : ""}
          ${hasTime ? `<div><dt>تخمینی وقت</dt><dd>${durationMin} منٹ</dd></div>` : ""}
          ${effective.distanceTierLabel ? `<div><dt>فاصلہ سلسلہ</dt><dd>${effective.distanceTierLabel}</dd></div>` : ""}
          ${effective.paceTierLabel ? `<div><dt>وقت سلسلہ</dt><dd>${effective.paceTierLabel}</dd></div>` : ""}
          <div><dt>کمیشن</dt><dd>${rates.commissionPercent}%</dd></div>
        </dl>
        ${
          hasTrip && calculatedFare != null
            ? `<p class="rate-details__formula">
                ${money(effective.baseFare)} (ابتدائی) + ${distanceKm} km × ${money(effective.perKmRate)} =
                <strong>${money(calculatedFare)}</strong>
              </p>
              <p class="rate-details__formula-sub">کلومیٹر حصہ: ${money(kmPart)} · ${hasTime ? `وقت کے سلسلے کے بعد لاگو ریٹ` : "وقت کا سلسلہ نہیں ملا"}</p>
              ${
                ctx.estimatedFare != null
                  ? `<p class="rate-details__compare">کسٹمر تخمینہ: ${money(ctx.estimatedFare)}</p>`
                  : ""
              }`
            : ""
        }
      </section>
      ${tierTableHtml("فاصلہ کی بنیاد پر (تمام سلسلے)", rates.distanceTiers, "distance")}
      ${tierTableHtml("وقت / رفتار کی بنیاد پر (تمام سلسلے)", rates.paceTiers, "pace")}
    `;
  }

  const allBlock =
    mode === "all"
      ? `<div class="rate-details__all-grid">${Object.keys(FALLBACK_VEHICLE_RATES)
          .map((key) => vehicleSummaryHtml(key, getVehicleRates(pricing, key)))
          .join("")}</div>`
      : "";

  return `
    <div class="rate-details__body-inner">
      ${tripBlock}
      ${allBlock}
      <p class="rate-details__source">ماخذ: ${pricing.source === "firestore" ? "سسٹم ترتیبات" : "ڈیفالٹ"} · settings/pricing</p>
    </div>`;
}
