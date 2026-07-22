/**
 * Phase 13.4 — language purity scan for EN/UR dictionaries.
 * Run: node tests/i18n-purity-scan.mjs
 */
import fs from "node:fs";

const src = fs.readFileSync(new URL("../customer-app/js/i18n.js", import.meta.url), "utf8");

function extractDict(lang) {
  const marker = `${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`missing ${lang} dict`);
  let i = start + marker.length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return src.slice(start, i);
}

function entries(block) {
  const out = [];
  const re = /(\w+)\s*:\s*"([^"]*)"/g;
  let hit;
  while ((hit = re.exec(block))) out.push({ key: hit[1], val: hit[2] });
  return out;
}

function stripPlaceholders(val) {
  return val.replace(/\{[a-zA-Z]+\}/g, "");
}

const en = entries(extractDict("en"));
const ur = entries(extractDict("ur"));

const enBad = en.filter((e) => /[\u0600-\u06FF]/.test(e.val));
const urBad = ur.filter((e) => /[A-Za-z]/.test(stripPlaceholders(e.val)));

console.log(`EN keys: ${en.length} · UR keys: ${ur.length}`);
console.log(`EN arabic leftovers: ${enBad.length}`);
enBad.forEach((b) => console.log(`  ${b.key}: ${b.val}`));
console.log(`UR latin leftovers: ${urBad.length}`);
urBad.forEach((b) => console.log(`  ${b.key}: ${b.val}`));

if (enBad.length || urBad.length) process.exitCode = 1;

