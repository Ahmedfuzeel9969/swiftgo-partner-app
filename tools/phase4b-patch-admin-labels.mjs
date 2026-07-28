import fs from "node:fs";

const path = "super-admin-panel/index.html";
let html = fs.readFileSync(path, "utf8");

html = html.replace(
  /<section class="vehicle-rate-card" data-vehicle-key="([^"]+)">([\s\S]*?)<\/section>/g,
  (block, key, inner) => {
    const i = inner.replace(
      /<label class="finance-field">\s*<span class="finance-field__label">([^<]*)<\/span>\s*<input type="number" data-rate-field="([^"]+)"/g,
      (_m, _labelText, field) => {
        const id = `rate-${key}-${field}`;
        const bilingual =
          {
            baseFare: "بیس فیئر (PKR) / Base fare (PKR)",
            perKmRate: "فی کلومیٹر (PKR) / Per km (PKR)",
            commissionPercent: "کمیشن (%) / Commission (%)",
          }[field] || _labelText;
        return `<label class="finance-field" for="${id}">
                    <span class="finance-field__label" id="${id}Label">${bilingual}</span>
                    <input id="${id}" type="number" data-rate-field="${field}" aria-labelledby="${id}Label"`;
      }
    );
    return `<section class="vehicle-rate-card" data-vehicle-key="${key}">${i}</section>`;
  }
);

html = html.replace(
  /<select id="candidateDriverLimitInput" name="candidateDriverLimit" required>/,
  '<select id="candidateDriverLimitInput" name="candidateDriverLimit" required aria-label="Candidate driver limit 10 or 20 / قریبی ڈرائیور حد">'
);

html = html.replace(
  /<input type="number" id="promoValueInput" name="value" min="1" step="1" required \/>/,
  '<input type="number" id="promoValueInput" name="value" min="1" step="1" required aria-label="Promo value / پرومو ویلیو" />'
);

html = html.replace(
  /<input type="number" id="promoMaxUsesInput" name="maxUses" min="0" step="1" placeholder="0 = unlimited" \/>/,
  '<input type="number" id="promoMaxUsesInput" name="maxUses" min="0" step="1" placeholder="0 = unlimited" aria-label="Promo max uses / زیادہ سے زیادہ استعمال" />'
);

html = html.replace(
  '<main class="admin-shell" id="adminLoginScreen">',
  '<main class="admin-shell" id="adminLoginScreen" role="dialog" aria-modal="true" aria-labelledby="adminLoginHeading">'
);

html = html.replace(
  "<h1>SwiftGo - Super Admin Command Center</h1>",
  '<h1 id="adminLoginHeading">SwiftGo - Super Admin Command Center</h1>'
);

fs.writeFileSync(path, html);
console.log("rate ids", (html.match(/id="rate-/g) || []).length);
