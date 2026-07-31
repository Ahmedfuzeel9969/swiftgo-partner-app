/**
 * Customer — fare rate transparency (uses settings/pricing via data.js).
 */

import { t } from "./i18n.js";
import {
  FALLBACK_VEHICLE_RATES,
  getPricingSettings,
  getVehicleRates,
  resolveEffectiveRates,
  calculateVehicleFare,
} from "./data.js";

const money = (n) => `Rs. ${Math.round(Math.max(0, Number(n) || 0)).toLocaleString("en-PK")}`;

const VEHICLE_I18N = Object.freeze({
  bike: "vehBike",
  go: "vehGo",
  "go-plus": "vehGoPlus",
  business: "vehBusiness",
  "bike-cargo": "vehBikeCargo",
  suzuki: "vehSuzuki",
  truck: "vehTruck",
});

function vehicleLabel(key) {
  const i18nKey = VEHICLE_I18N[key];
  return i18nKey ? t(i18nKey) : key;
}

function tierTableHtml(title, rows, kind) {
  if (!rows.length) return "";
  const head =
    kind === "distance"
      ? `<tr><th>${t("fareTierDistance")}</th><th>${t("fareTierBase")}</th><th>${t("fareTierPerKm")}</th></tr>`
      : `<tr><th>${t("fareTierPace")}</th><th>${t("fareTierBase")}</th><th>${t("fareTierPerKm")}</th></tr>`;
  const body = rows
    .map((row) => {
      const label =
        kind === "distance"
          ? row.upToKm == null
            ? t("fareTierOpenEnded")
            : `${row.upToKm} km`
          : row.maxMinPerKm == null
            ? t("fareTierAllPace")
            : `${row.maxMinPerKm} ${t("fareTierMinPerKm")}`;
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
  return `
    <article class="rate-details__vehicle-card">
      <h3>${vehicleLabel(key)}</h3>
      <dl class="rate-details__dl">
        <div><dt>${t("fareBaseLabel")}</dt><dd>${money(rates.baseFare)}</dd></div>
        <div><dt>${t("farePerKmLabel")}</dt><dd>${money(rates.perKmRate)}</dd></div>
      </dl>
      ${tierTableHtml(t("fareDistanceTiers"), rates.distanceTiers, "distance")}
      ${tierTableHtml(t("farePaceTiers"), rates.paceTiers, "pace")}
    </article>`;
}

/**
 * @param {object} pricing
 * @param {{ vehicleTypeKey?: string, distanceKm?: number|null, durationMin?: number|null, estimatedFare?: number|null, mode?: 'ride'|'all' }} ctx
 */
export function buildCustomerRateDetailsHtml(pricing, ctx = {}) {
  const mode = ctx.mode || (ctx.vehicleTypeKey ? "ride" : "all");
  const vehicleKey = ctx.vehicleTypeKey || "go";
  const rates = getVehicleRates(pricing, vehicleKey);
  const distanceKm = Number(ctx.distanceKm);
  const durationMin = Number(ctx.durationMin);
  const hasTrip = Number.isFinite(distanceKm) && distanceKm >= 0;
  const hasTime = Number.isFinite(durationMin) && durationMin > 0;
  const effective = resolveEffectiveRates(rates, hasTrip ? distanceKm : null, hasTime ? durationMin : null);
  const calculatedFare = hasTrip ? calculateVehicleFare(rates, distanceKm, hasTime ? durationMin : null) : null;

  let tripBlock = "";
  if (mode === "ride") {
    tripBlock = `
      <section class="rate-details__hero">
        <p class="rate-details__eyebrow">${vehicleLabel(vehicleKey)} · ${t("fareForThisTrip")}</p>
        <dl class="rate-details__dl rate-details__dl--hero">
          <div><dt>${t("fareBaseLabel")}</dt><dd>${money(effective.baseFare)}</dd></div>
          <div><dt>${t("farePerKmLabel")}</dt><dd>${money(effective.perKmRate)}</dd></div>
          ${hasTrip ? `<div><dt>${t("fareDistanceLabel")}</dt><dd>${distanceKm} km</dd></div>` : ""}
          ${hasTime ? `<div><dt>${t("fareTimeLabel")}</dt><dd>${durationMin} ${t("fareMinutes")}</dd></div>` : ""}
        </dl>
        ${
          hasTrip && calculatedFare != null
            ? `<p class="rate-details__formula">
                ${money(effective.baseFare)} + ${distanceKm} km × ${money(effective.perKmRate)} =
                <strong>${money(calculatedFare)}</strong>
              </p>
              ${
                ctx.estimatedFare != null
                  ? `<p class="rate-details__compare">${t("fareEstimateLabel")}: ${money(ctx.estimatedFare)}</p>`
                  : ""
              }`
            : ""
        }
      </section>
      ${tierTableHtml(t("fareDistanceTiers"), rates.distanceTiers, "distance")}
      ${tierTableHtml(t("farePaceTiers"), rates.paceTiers, "pace")}
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
      <p class="rate-details__source">${t("fareSourceLabel")} · settings/pricing</p>
    </div>`;
}

export async function loadCustomerPricing() {
  return getPricingSettings();
}
