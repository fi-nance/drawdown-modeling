// Generator for the offline Series I savings bond rate table.
//
// This script is a DEV TOOL. It is not part of the runtime bundle and has no
// runtime dependencies — Node built-ins only. It downloads TreasuryDirect's
// I-bond interest-rate page and emits src/data/iBondRates.generated.mjs with
// the complete fixed-rate and semiannual-inflation-rate history since the
// program's first setting (September 1, 1998).
//
// Why a baked table: TreasuryDirect publishes new rates every May 1 and
// November 1, but neither the rates page nor any FiscalData dataset serves the
// I-bond rate history with CORS headers (the FiscalData "Redemption Tables"
// dataset stopped publishing redemption values after 2023-05). Embedding the
// official table lets the app value I bonds exactly, fully offline — values
// only change on the 1st of each month anyway. Rerun this script after each
// May/Nov rate announcement to extend coverage.
//
// Usage:
//   node scripts/generateIBondRates.mjs                # fetches treasurydirect.gov
//   IBOND_RATES_HTML=/tmp/page.html node scripts/...   # parse a saved copy
//
// Source: https://www.treasurydirect.gov/savings-bonds/i-bonds/i-bonds-interest-rates/
// (tables "Date the fixed rate was set" and "Date the inflation rate was set").

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://www.treasurydirect.gov/savings-bonds/i-bonds/i-bonds-interest-rates/";
const OUTPUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "iBondRates.generated.mjs");

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

async function loadHtml() {
  if (process.env.IBOND_RATES_HTML) {
    return readFileSync(process.env.IBOND_RATES_HTML, "utf8");
  }
  const response = await fetch(SOURCE_URL, { headers: { "user-agent": "drawdown-modeling rate-table generator" } });
  if (!response.ok) throw new Error(`TreasuryDirect request failed: ${response.status}`);
  return response.text();
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(tableHtml) {
  return [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((rowMatch) =>
    [...rowMatch[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/g)].map((cell) => stripTags(cell[0]))
  ).filter((cells) => cells.length > 0);
}

// "May 1, 2026" → "2026-05-01"
function parseSettingDate(text) {
  const match = String(text).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

// "1.67%" or "-2.78%" → 0.0167 / -0.0278 (kept exact to basis points)
function parseRatePercent(text) {
  const match = String(text).trim().match(/^(-?\d+(?:\.\d+)?)%$/);
  if (!match) return null;
  return Math.round(Number(match[1]) * 100) / 10000;
}

function parseRateTable(html, headingNeedle) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const table = tables.find((t) => stripTags(t).toLowerCase().includes(headingNeedle));
  if (!table) throw new Error(`Could not find the "${headingNeedle}" table — page layout changed?`);
  const entries = [];
  for (const cells of tableRows(table)) {
    if (cells.length < 2) continue;
    const date = parseSettingDate(cells[0]);
    const rate = parseRatePercent(cells[1]);
    if (date === null || rate === null) continue; // header / footnote rows
    entries.push({ date, rate });
  }
  if (entries.length < 50) {
    throw new Error(`Parsed only ${entries.length} rows for "${headingNeedle}" — expected the full history since 1998.`);
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

function assertHistoryShape(entries, label) {
  if (entries[0].date !== "1998-09-01") {
    throw new Error(`${label} history should start at 1998-09-01, got ${entries[0].date}`);
  }
  for (let index = 1; index < entries.length; index += 1) {
    const [year, month] = entries[index].date.split("-").map(Number);
    const [prevYear, prevMonth] = entries[index - 1].date.split("-").map(Number);
    const gapMonths = (year - prevYear) * 12 + (month - prevMonth);
    // Sep 1998 → Nov 1998 is the lone 2-month gap; everything after is 6 months.
    if (gapMonths !== 6 && !(entries[index - 1].date === "1998-09-01" && gapMonths === 2)) {
      throw new Error(`${label} history has an unexpected gap: ${entries[index - 1].date} → ${entries[index].date}`);
    }
  }
}

const html = await loadHtml();
const fixedRates = parseRateTable(html, "date the fixed rate was set");
const inflationRates = parseRateTable(html, "date the inflation rate was set");
assertHistoryShape(fixedRates, "Fixed rate");
assertHistoryShape(inflationRates, "Inflation rate");
if (fixedRates.length !== inflationRates.length) {
  throw new Error(`Fixed (${fixedRates.length}) and inflation (${inflationRates.length}) histories should have the same length.`);
}

const latest = fixedRates[fixedRates.length - 1].date;
const banner = `// GENERATED FILE — do not edit by hand.
// Series I savings bond rate history scraped from TreasuryDirect:
//   ${SOURCE_URL}
// Regenerate with: node scripts/generateIBondRates.mjs
// Latest rate setting covered: ${latest} (new rates land every May 1 / Nov 1).
// Rates are decimal fractions; inflation rates are SEMIANNUAL (6-month) rates.
`;

const serialize = (entries) => `[\n${entries.map(({ date, rate }) => `  { date: "${date}", rate: ${rate} }`).join(",\n")}\n]`;

writeFileSync(OUTPUT_PATH, `${banner}
export const I_BOND_FIXED_RATES = ${serialize(fixedRates)};

export const I_BOND_INFLATION_RATES = ${serialize(inflationRates)};
`);

console.log(`Wrote ${OUTPUT_PATH}`);
console.log(`  fixed-rate settings: ${fixedRates.length} (latest ${latest}, ${fixedRates[fixedRates.length - 1].rate * 100}%)`);
console.log(`  inflation settings:  ${inflationRates.length} (latest ${inflationRates[inflationRates.length - 1].date}, ${inflationRates[inflationRates.length - 1].rate * 100}%)`);
