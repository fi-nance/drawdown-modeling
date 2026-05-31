// Generator for the offline rating-area-level SLCSP lookup tables.
//
// This script is a DEV TOOL. It is not part of the runtime bundle and has no
// runtime dependencies — Node built-ins only. It reads raw primary-source files
// that the operator downloads (see docs/DATA_SOURCES.md → "Regenerating the
// rating-area SLCSP tables") and emits three generated modules into src/data/:
//
//   acaRatingArea2026.generated.mjs   — SLCSP monthly premium per rating area
//                                       by single-member age (from the CMS
//                                       Rate PUF + Plan Attributes PUF).
//   countyToRatingArea.generated.mjs  — county FIPS → rating area code per
//                                       state, plus 3-digit-ZIP rating areas
//                                       for ZIP-based states (from the CMS
//                                       state geographic-rating-area pages).
//   zipToCounty.generated.mjs         — ZIP5 → primary county FIPS, limited to
//                                       counties that resolve to a covered
//                                       rating area (from the Census ZCTA↔county
//                                       relationship file + county FIPS list).
//
// Coverage is intentionally limited to federal-platform states — every state
// that files rates into the CMS PUFs. State-based-exchange states (CA, NY, MA,
// …) publish their own data and are out of scope here; the runtime module falls
// back to the state-level benchmark for them. See docs/KNOWN_LIMITATIONS.md.
//
// Usage:
//   RAW_DIR=/path/to/staging node scripts/generateAcaRatingArea.mjs
//
// Expected files under RAW_DIR (override individually with env vars):
//   $RATE_PUF        rate-puf/Rate_PUF.csv                     (CMS Rate PUF)
//   $PLAN_ATTR_PUF   plan-attributes-puf/Plan_Attributes_PUF.csv (CMS Plan Attributes PUF)
//   $CENSUS_COUNTY   census_county.txt   (Census national_county2020.txt)
//   $CENSUS_ZCTA     zcta_county.txt     (Census tab20_zcta520_county20_natl.txt)
//   $GRA_DIR         gra/<state>.html    (one saved CMS <state>-gra page each)

import { createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT_DIR = path.join(REPO, "src", "data");

const RAW_DIR = process.env.RAW_DIR || "/tmp/puf2026";
const STAGE = process.env.STAGE_DIR || "/tmp";
const RATE_PUF = process.env.RATE_PUF || path.join(RAW_DIR, "rate-puf", "Rate_PUF.csv");
const PLAN_ATTR_PUF = process.env.PLAN_ATTR_PUF || path.join(RAW_DIR, "plan-attributes-puf", "Plan_Attributes_PUF.csv");
const CENSUS_COUNTY = process.env.CENSUS_COUNTY || path.join(STAGE, "census_county.txt");
const CENSUS_ZCTA = process.env.CENSUS_ZCTA || path.join(STAGE, "zcta_county.txt");
const GRA_DIR = process.env.GRA_DIR || path.join(STAGE, "gra");

const PLAN_YEAR = 2026;
const DATA_VERSION = "2026.1";

// The federal-platform states whose <state>-gra pages we ingest. The actual
// covered set is the intersection of this list with what appears in the PUFs;
// we log any divergence.
const GRA_STATES = [
  "ak", "al", "ar", "az", "de", "fl", "hi", "ia", "in", "ks", "la", "mi", "mo",
  "ms", "mt", "nc", "nd", "ne", "nh", "oh", "ok", "or", "sc", "sd", "tn", "tx",
  "ut", "wi", "wv", "wy"
];

const SOURCES = {
  slcsp: {
    name: "CMS Marketplace Rate PUF and Plan Attributes PUF, plan year 2026",
    url: "https://www.cms.gov/marketplace/resources/data/public-use-files"
  },
  ratingArea: {
    name: "CMS state geographic rating areas (2026)",
    url: "https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/state-gra"
  },
  zipToCounty: {
    name: "Census 2020 ZCTA-to-county relationship file and national county FIPS list",
    url: "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt"
  }
};

// ─── small helpers ────────────────────────────────────────────────────────────

// RFC4180-ish CSV line parser (handles quoted fields with embedded commas).
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?39;|&#x27;|&rsquo;|&apos;/gi, "'")
    .replace(/&#0?38;/g, "&")
    .replace(/&[a-z]+;/gi, " ");
}

// CMS's own state geographic-rating-area pages contain a handful of county
// misspellings. Map the normalized misspelling → the correct normalized Census
// county name so the FIPS join succeeds. Keyed by "STATE|normalizedMisspelling".
// Verified against the Census national county FIPS list.
const GRA_COUNTY_FIXES = {
  "IN|kosclusko": "kosciusko", // CMS "Kosclusko"  → Kosciusko County (18085)
  "IN|deleware": "delaware",   // CMS "Deleware"   → Delaware County  (18035)
  "IN|davless": "daviess",     // CMS "Davless"    → Daviess County   (18027)
  "IN|dubols": "dubois",       // CMS "Dubols"     → Dubois County    (18037)
  "KS|chautaugua": "chautauqua", // CMS "Chautaugua" → Chautauqua County (20019)
  "LA|vermillion": "vermilion", // CMS "Vermillion" → Vermilion Parish (22113)
  "ND|trail": "traill",        // CMS "Trail"      → Traill County    (38097)
  "OH|galia": "gallia"         // CMS "Galia"      → Gallia County    (39053)
};

// Normalize a county name to a join key: strip the county-class suffix and all
// punctuation/whitespace. "St. Johns County" → "stjohns"; "DeSoto" → "desoto".
function normCounty(name) {
  return decodeEntities(name)
    .toLowerCase()
    .replace(/\b(county|parish|borough|census area|municipality|city and borough|municipio)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function ageIndex(token) {
  if (token === "0-14") return 0;     // applies to the whole 0–14 band
  if (token === "64 and over") return 64;
  const n = Number(token);
  return Number.isInteger(n) && n >= 15 && n <= 63 ? n : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

// ─── 1. silver on-exchange individual medical plan set (Plan Attributes PUF) ───

function loadSilverPlanSet() {
  const lines = readFileSync(PLAN_ATTR_PUF, "utf8").split(/\r?\n/);
  const header = parseCsvLine(lines[0].replace(/^﻿/, ""));
  const idx = (n) => header.indexOf(n);
  const cMarket = idx("MarketCoverage");
  const cDental = idx("DentalOnlyPlan");
  const cMetal = idx("MetalLevel");
  const cQHP = idx("QHPNonQHPTypeId");
  const cStd = idx("StandardComponentId");
  if ([cMarket, cDental, cMetal, cQHP, cStd].some((c) => c < 0)) {
    throw new Error("Plan Attributes PUF is missing an expected column header");
  }
  const silver = new Set();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (f.length < header.length) continue;
    if (f[cMarket] !== "Individual") continue;
    if (f[cDental] !== "No") continue;
    if (f[cMetal] !== "Silver") continue;
    // "On the Exchange" or "Both" → offered on the marketplace; SLCSP only
    // counts marketplace silver plans.
    if (f[cQHP] !== "On the Exchange" && f[cQHP] !== "Both") continue;
    silver.add(f[cStd]);
  }
  return silver;
}

// ─── 2. SLCSP per (state, rating area) from the Rate PUF ───────────────────────

async function deriveSlcsp(silver) {
  // state -> areaCode -> planId -> Map(ageIndex -> monthlyRate)
  const byArea = new Map();
  const rl = createInterface({ input: createReadStream(RATE_PUF), crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    if (!line) continue;
    const f = line.split(","); // Rate PUF has no quoted fields
    const state = f[1];
    const plan = f[7];
    const areaRaw = f[8];
    const ageTok = f[10];
    const rate = Number(f[11]);
    if (!silver.has(plan)) continue;
    const ai = ageIndex(ageTok);
    if (ai === null) continue;
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const areaCode = areaCodeFromRatingArea(areaRaw);
    if (areaCode == null) continue;
    let st = byArea.get(state);
    if (!st) { st = new Map(); byArea.set(state, st); }
    const key = areaCode;
    let area = st.get(key);
    if (!area) { area = new Map(); st.set(key, area); }
    let pl = area.get(plan);
    if (!pl) { pl = new Map(); area.set(plan, pl); }
    if (!pl.has(ai)) pl.set(ai, rate);
  }

  // Reduce to SLCSP per rating area.
  const slcsp = {}; // "FL-43" -> { slcspPlanId, lowestPlanId, silverPlanCount, monthlyByAge:[65] }
  const statesSeen = new Set();
  for (const [state, areas] of byArea) {
    statesSeen.add(state);
    for (const [areaCode, plans] of areas) {
      // Rank plans by their age-21 rate. The ACA age-rating curve is uniform
      // across all issuers within a state, so this ranking is age-invariant —
      // the 2nd-lowest plan at age 21 is the 2nd-lowest at every age.
      const ranked = [];
      for (const [plan, ages] of plans) {
        const r21 = ages.get(21);
        if (Number.isFinite(r21)) ranked.push({ plan, r21, ages });
      }
      if (!ranked.length) continue;
      ranked.sort((a, b) => a.r21 - b.r21 || a.plan.localeCompare(b.plan));
      const chosen = ranked[1] ?? ranked[0]; // 2nd lowest, or the only plan
      const monthlyByAge = buildAgeSchedule(chosen.ages);
      slcsp[`${state}-${areaCode}`] = {
        slcspPlanId: chosen.plan,
        lowestPlanId: ranked[0].plan,
        silverPlanCount: ranked.length,
        monthlyByAge
      };
    }
  }
  return { slcsp, statesSeen };
}

// "Rating Area 43" → 43
function areaCodeFromRatingArea(raw) {
  const m = String(raw).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Expand the SLCSP plan's age rows into a dense [age0 … age64] schedule. Ages
// 0–14 share the "0-14" band rate. Any missing interior age (rare) is filled by
// linear hold from the nearest lower known age.
function buildAgeSchedule(ageMap) {
  const out = new Array(65).fill(null);
  const band0 = ageMap.get(0);
  for (let a = 0; a <= 14; a++) out[a] = band0 ?? null;
  for (let a = 15; a <= 64; a++) {
    if (ageMap.has(a)) out[a] = ageMap.get(a);
  }
  // forward-fill any gaps (defensive; PUF rows are normally complete 0–64)
  let last = null;
  for (let a = 0; a <= 64; a++) {
    if (out[a] == null) out[a] = last;
    else last = out[a];
  }
  // backfill leading nulls
  let next = null;
  for (let a = 64; a >= 0; a--) {
    if (out[a] == null) out[a] = next;
    else next = out[a];
  }
  return out.map((v) => (v == null ? null : round2(v)));
}

// ─── 3. county/zip3 → rating area from the CMS GRA pages ───────────────────────

// Pull <tr> rows, then the cell texts, from a GRA HTML page.
function parseGraRows(html) {
  const rows = [];
  const trChunks = html.split(/<tr[\s>]/i).slice(1);
  for (const chunk of trChunks) {
    const body = chunk.split(/<\/tr>/i)[0];
    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = cellRe.exec(body))) {
      cells.push(decodeEntities(m[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim());
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function parseGraState(stateAbbr, html) {
  const rows = parseGraRows(html);
  const countyToArea = {}; // normCounty -> area
  const zip3ToArea = {};    // "995" -> area
  let countyRows = 0;
  let zip3Rows = 0;
  for (const cells of rows) {
    const m = String(cells[0] || "").match(/^Rating Area\s+(\d+)/i);
    if (!m) continue;
    const area = Number(m[1]);
    const county = (cells[1] || "").trim();
    const zip3 = (cells[2] || "").trim();
    if (county) {
      const key = normCounty(county);
      if (key) { countyToArea[key] = area; countyRows++; }
    }
    const z = zip3.match(/^(\d{3})$/);
    if (z) { zip3ToArea[z[1]] = area; zip3Rows++; }
  }
  const methodology = zip3Rows > countyRows ? "zip3" : "county";
  return { stateAbbr, countyToArea, zip3ToArea, countyRows, zip3Rows, methodology };
}

// ─── 4. county name → FIPS (Census national county file) ───────────────────────

function loadCountyFips() {
  const lines = readFileSync(CENSUS_COUNTY, "utf8").split(/\r?\n/);
  const byStateName = new Map(); // "FL" -> Map(normCounty -> fips5)
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split("|");
    if (f.length < 5) continue;
    const st = f[0];
    const fips = f[1] + f[2];
    const name = f[4];
    if (!/^\d{5}$/.test(fips)) continue;
    let m = byStateName.get(st);
    if (!m) { m = new Map(); byStateName.set(st, m); }
    m.set(normCounty(name), fips);
  }
  return byStateName;
}

// ─── 5. ZCTA → primary county FIPS (Census relationship file) ──────────────────

function loadZipToCounty(coveredFips) {
  const lines = readFileSync(CENSUS_ZCTA, "utf8").split(/\r?\n/);
  const best = new Map(); // zip -> { fips, area }
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split("|");
    if (f.length < 18) continue;
    const zip = f[1];
    const fips = f[9];
    const landPart = Number(f[16]);
    if (!/^\d{5}$/.test(zip) || !/^\d{5}$/.test(fips)) continue;
    if (!coveredFips.has(fips)) continue; // only bundle what slcspMonthlyFor consumes
    const cur = best.get(zip);
    const area = Number.isFinite(landPart) ? landPart : 0;
    if (!cur || area > cur.area) best.set(zip, { fips, area });
  }
  const out = {};
  for (const [zip, { fips }] of best) out[zip] = fips;
  return out;
}

// ─── emit ──────────────────────────────────────────────────────────────────────

function banner(extra) {
  return [
    "// AUTO-GENERATED — DO NOT EDIT BY HAND.",
    "// Regenerate with: node scripts/generateAcaRatingArea.mjs",
    "// See docs/DATA_SOURCES.md → \"Regenerating the rating-area SLCSP tables\".",
    `// Plan year ${PLAN_YEAR}. Data version ${DATA_VERSION}.`,
    extra ? `// ${extra}` : null
  ].filter(Boolean).join("\n");
}

function writeSlcspFile(slcsp, coveredStates) {
  const entries = Object.keys(slcsp).sort().map((k) => {
    const v = slcsp[k];
    const ages = v.monthlyByAge.map((n) => (n == null ? "null" : String(n))).join(",");
    return `  ${JSON.stringify(k)}: { p: ${JSON.stringify(v.slcspPlanId)}, lo: ${JSON.stringify(v.lowestPlanId)}, n: ${v.silverPlanCount}, a: [${ages}] }`;
  });
  const body = `${banner("SLCSP monthly premium per rating area, by single-member age.")}
//
// Each value: { p: SLCSP plan id, lo: lowest-cost silver plan id,
//               n: silver plan count in the rating area,
//               a: monthly premium for ONE member at age 0..64 (index = age;
//                  ages 0-14 share the 0-14 band; clamp ages >64 to 64). }
// Premiums are the issuer's filed per-age rates from the CMS Rate PUF — i.e.
// the same rates HealthCare.gov ranks to pick the benchmark.

export const ACA_RATING_AREA_DATA_VERSION = ${JSON.stringify(DATA_VERSION)};

export const ACA_RATING_AREA_SLCSP_SOURCE = Object.freeze(${JSON.stringify(SOURCES.slcsp)});

export const ACA_SLCSP_COVERED_STATES = Object.freeze(${JSON.stringify(coveredStates)});

export const ACA_SLCSP_BY_RATING_AREA_${PLAN_YEAR} = Object.freeze({
${entries.join(",\n")}
});
`;
  writeFileSync(path.join(OUT_DIR, `acaRatingArea${PLAN_YEAR}.generated.mjs`), body);
  return body.length;
}

function writeCountyToRatingAreaFile(states) {
  const countyBlocks = [];
  const zip3Blocks = [];
  const methodology = {};
  for (const s of states) {
    methodology[s.stateAbbr] = s.methodology;
    const cEntries = Object.keys(s.fipsToArea).sort().map((fips) => `${JSON.stringify(fips)}: ${s.fipsToArea[fips]}`);
    if (cEntries.length) {
      countyBlocks.push(`  ${JSON.stringify(s.stateAbbr)}: { ${cEntries.join(", ")} }`);
    }
    const zEntries = Object.keys(s.zip3ToArea).sort().map((z) => `${JSON.stringify(z)}: ${s.zip3ToArea[z]}`);
    if (zEntries.length) {
      zip3Blocks.push(`  ${JSON.stringify(s.stateAbbr)}: { ${zEntries.join(", ")} }`);
    }
  }
  const body = `${banner("County FIPS → rating area code, per state.")}
//
// COUNTY_TO_RATING_AREA[stateAbbr][countyFips5] = rating area number.
// ZIP3_TO_RATING_AREA[stateAbbr][zip3]          = rating area number, for the
//   handful of states whose rating areas are defined by 3-digit ZIP, not county.
// RATING_AREA_METHODOLOGY[stateAbbr] = "county" | "zip3".

export const ACA_RATING_AREA_GRA_SOURCE = Object.freeze(${JSON.stringify(SOURCES.ratingArea)});

export const RATING_AREA_METHODOLOGY = Object.freeze(${JSON.stringify(methodology)});

export const COUNTY_TO_RATING_AREA = Object.freeze({
${countyBlocks.join(",\n")}
});

export const ZIP3_TO_RATING_AREA = Object.freeze({
${zip3Blocks.join(",\n")}
});
`;
  writeFileSync(path.join(OUT_DIR, "countyToRatingArea.generated.mjs"), body);
  return body.length;
}

function writeZipToCountyFile(zipToCounty) {
  const entries = Object.keys(zipToCounty).sort().map((z) => `${JSON.stringify(z)}:${JSON.stringify(zipToCounty[z])}`);
  const body = `${banner("ZIP5 → primary county FIPS (covered rating-area counties only).")}
//
// ZIP5_TO_COUNTY_FIPS[zip5] = primary county FIPS (the county holding the most
// of the ZCTA's land area, per the Census ZCTA↔county relationship file). Only
// ZIPs whose county resolves to a covered rating area are bundled — ZIP-based
// rating-area states and out-of-coverage states are intentionally absent.

export const ZIP_TO_COUNTY_SOURCE = Object.freeze(${JSON.stringify(SOURCES.zipToCounty)});

export const ZIP5_TO_COUNTY_FIPS = Object.freeze({
${entries.map((e) => `  ${e}`).join(",\n")}
});
`;
  writeFileSync(path.join(OUT_DIR, "zipToCounty.generated.mjs"), body);
  return body.length;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log("· loading silver on-exchange medical plan set …");
  const silver = loadSilverPlanSet();
  console.log(`  ${silver.size} silver plans`);

  console.log("· streaming Rate PUF → SLCSP per rating area …");
  const { slcsp, statesSeen } = await deriveSlcsp(silver);
  console.log(`  ${Object.keys(slcsp).length} rating areas across ${statesSeen.size} states`);

  console.log("· parsing CMS GRA pages …");
  const countyFips = loadCountyFips();
  const states = [];
  const coveredFips = new Set();
  const unmatchedCounties = [];
  for (const abbr of GRA_STATES) {
    const upper = abbr.toUpperCase();
    const html = readFileSync(path.join(GRA_DIR, `${abbr}.html`), "utf8");
    const parsed = parseGraState(upper, html);
    const fipsMap = countyFips.get(upper) ?? new Map();
    const fipsToArea = {};
    for (const [normName, area] of Object.entries(parsed.countyToArea)) {
      const corrected = GRA_COUNTY_FIXES[`${upper}|${normName}`] ?? normName;
      const fips = fipsMap.get(corrected);
      if (fips) { fipsToArea[fips] = area; coveredFips.add(fips); }
      else unmatchedCounties.push(`${upper}:${normName}`);
    }
    states.push({ stateAbbr: upper, fipsToArea, zip3ToArea: parsed.zip3ToArea, methodology: parsed.methodology });
  }
  if (unmatchedCounties.length) {
    console.warn(`  ⚠ ${unmatchedCounties.length} GRA counties did not match a FIPS: ${unmatchedCounties.slice(0, 20).join(", ")}${unmatchedCounties.length > 20 ? " …" : ""}`);
  }

  console.log("· building ZIP → primary county (covered counties only) …");
  const zipToCounty = loadZipToCounty(coveredFips);
  console.log(`  ${Object.keys(zipToCounty).length} ZIPs`);

  const coveredStates = states.map((s) => s.stateAbbr).sort();
  // Sanity: every state present in the SLCSP table should be a GRA state.
  for (const st of statesSeen) {
    if (!coveredStates.includes(st)) console.warn(`  ⚠ SLCSP has state ${st} with no GRA page ingested`);
  }

  const s1 = writeSlcspFile(slcsp, coveredStates);
  const s2 = writeCountyToRatingAreaFile(states);
  const s3 = writeZipToCountyFile(zipToCounty);

  console.log("· wrote:");
  console.log(`  acaRatingArea${PLAN_YEAR}.generated.mjs   ${(s1 / 1024).toFixed(0)} KB`);
  console.log(`  countyToRatingArea.generated.mjs    ${(s2 / 1024).toFixed(0)} KB`);
  console.log(`  zipToCounty.generated.mjs           ${(s3 / 1024).toFixed(0)} KB`);
  console.log(`  total raw                           ${((s1 + s2 + s3) / 1024).toFixed(0)} KB`);
}

await main();
