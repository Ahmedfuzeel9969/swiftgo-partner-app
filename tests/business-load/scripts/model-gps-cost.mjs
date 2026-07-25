/**
 * MODELLED GPS write/cost calculator — no network I/O.
 * Usage: node tests/business-load/scripts/model-gps-cost.mjs [drivers] [hoursPerDay] [days]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WRITE_INTERVAL_MS = 8000;
const WRITES_PER_SEC = 1000 / WRITE_INTERVAL_MS;
const USD_PER_100K_WRITES = 0.18; // MODELLED — confirm in billing console

const drivers = Number(process.argv[2] || 13300);
const hoursPerDay = Number(process.argv[3] || 12);
const days = Number(process.argv[4] || 30);

const writesPerSecond = drivers * WRITES_PER_SEC;
const writesPerHour = drivers * (3600 / (WRITE_INTERVAL_MS / 1000));
const writesPerDay = writesPerHour * hoursPerDay;
const writesPerMonth = writesPerDay * days;
const usdMonth = (writesPerMonth / 100000) * USD_PER_100K_WRITES;

const out = {
  label: "MODELLED",
  assumption: {
    VEHICLE_LOCATION_WRITE_MS: WRITE_INTERVAL_MS,
    stationaryStillWrites: true,
    offlineWrites: false,
    usdPer100kWrites: USD_PER_100K_WRITES,
  },
  inputs: { drivers, hoursPerDay, days },
  outputs: {
    writesPerSecond: Number(writesPerSecond.toFixed(3)),
    writesPerHour,
    writesPerDay,
    writesPerMonth,
    modelledFirestoreWriteUsdPerMonth: Number(usdMonth.toFixed(2)),
  },
  note: "Excludes listener read fan-out, Auth, Hosting, Storage, and map provider cost.",
};

console.log(JSON.stringify(out, null, 2));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const summaryDir = path.resolve(__dirname, "../results/summary");
fs.mkdirSync(summaryDir, { recursive: true });
const file = path.join(summaryDir, `gps-cost-model-${drivers}d.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.error(`Wrote ${file}`);
