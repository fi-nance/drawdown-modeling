// Generator for the offline SLCSP lookup tables (rating-area AND county level).
//
// This script is a DEV TOOL. It is not part of the runtime bundle and has no
// runtime dependencies — Node built-ins only. It reads raw primary-source files
// that the operator downloads (see docs/DATA_SOURCES.md → "Regenerating the
// rating-area SLCSP tables") and emits three generated modules into src/data/:
//
//   acaRatingArea2026.generated.mjs   — SLCSP monthly premium per rating area
//                                       by single-member age, COUNTY-LEVEL
//                                       overrides where a county's own silver
//                                       plan set (via the Service Area PUF)
//                                       yields a different benchmark, ZIP-LEVEL
//                                       overrides where a PARTIAL-county
//                                       service area splits the county, and
//                                       per-state provenance (FFM vs SBM PUF).
//   countyToRatingArea.generated.mjs  — county FIPS → rating area code per
//                                       state, plus 3-digit-ZIP rating areas
//                                       (full states like AK, and intra-state
//                                       zip3 splits like CA's LA County).
//   zipToCounty.generated.mjs         — ZIP5 → primary county FIPS, limited to
//                                       counties that resolve to a covered
//                                       rating area.
//
// Coverage (Phase 4): every state that files into the CMS FFM PUFs PLUS every
// State-Based Marketplace that files into the CMS SBM ("SBE") QHP PUFs for the
// plan year. SBM states without a published PUF for the plan year (2026: CO,
// MD) keep the hand-maintained fallback in src/data/sbeRatingArea.mjs.
//
// County-level SLCSP methodology: within each rating area, a county's silver
// plan set is the plans whose Service Area covers the county (CoverEntireState,
// or the county FIPS listed; PARTIAL-county service areas count as covering the
// county at this level). The 2nd-lowest age-21 rate among those plans is the
// county SLCSP; only counties whose benchmark differs from their rating area's
// are emitted as overrides.
//
// ZIP-level SLCSP methodology (partial-county resolution): where a silver
// plan's service area covers a county only PARTIALLY (PartialCounty = Yes, with
// an explicit ZIP list), the county's benchmark is ambiguous — ZIPs inside the
// list see the plan, ZIPs outside do not. For every ZIP whose primary county
// has at least one partially-covering ranked silver plan, the ZIP's own plan
// set is ranked (a plan covers the ZIP iff it covers the entire state, covers
// the ZIP's county fully, or lists the ZIP in any partial-county ZIP list) and
// a ZIP-level override is emitted when its benchmark plan differs from the
// county's effective benchmark. This matches HealthCare.gov's ZIP+county
// resolution exactly for ZIPs the Census assigns to that county.
//
// Usage:
//   RAW_DIR=/tmp/puf2026 SBE_RAW_DIR=/tmp/sbe2026 node scripts/generateAcaRatingArea.mjs
//
// Expected inputs (override individually with env vars):
//   $RATE_PUF        rate-puf/Rate_PUF.csv                       (CMS FFM Rate PUF)
//   $PLAN_ATTR_PUF   plan-attributes-puf/Plan_Attributes_PUF.csv (CMS FFM Plan Attributes PUF)
//   $SERVICE_PUF     service-area-puf/Service_Area_PUF.csv       (CMS FFM Service Area PUF)
//   $SBE_RAW_DIR     <stateDir>/<ST>{Rates,Plans,ServiceAreas}*.csv per SBM state
//   $CENSUS_COUNTY   census_county.txt   (Census national_county2020.txt)
//   $CENSUS_ZCTA     zcta_county.txt     (Census tab20_zcta520_county20_natl.txt)
//   $GRA_DIR         gra/<state>.html    (one saved CMS <state>-gra page each)

import { createReadStream, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
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
const SERVICE_PUF = process.env.SERVICE_PUF || path.join(RAW_DIR, "service-area-puf", "Service_Area_PUF.csv");
const SBE_RAW_DIR = process.env.SBE_RAW_DIR || "/tmp/sbe2026";
const CENSUS_COUNTY = process.env.CENSUS_COUNTY || path.join(STAGE, "census_county.txt");
const CENSUS_ZCTA = process.env.CENSUS_ZCTA || path.join(STAGE, "zcta_county.txt");
const GRA_DIR = process.env.GRA_DIR || path.join(STAGE, "gra");

const PLAN_YEAR = 2026;
const DATA_VERSION = "2026.3";

// Federal-platform states (ingested from the FFM PUFs).
const FFM_STATES = [
  "ak", "al", "ar", "az", "de", "fl", "hi", "ia", "in", "ks", "la", "mi", "mo",
  "ms", "mt", "nc", "nd", "ne", "nh", "oh", "ok", "or", "sc", "sd", "tn", "tx",
  "ut", "wi", "wv", "wy"
];

// State-Based Marketplaces with a published CMS SBM QHP PUF for the plan year.
// 2026: CO and MD did not publish — they keep the sbeRatingArea.mjs fallback.
// (OR appears in both lists across vintages; the FFM PUF wins when present.)
const SBM_STATES = [
  "ca", "ct", "dc", "ga", "id", "ky", "me", "ma", "mn", "nv",
  "nj", "nm", "ny", "pa", "ri", "vt", "va", "wa"
];

const GRA_STATES = [...new Set([...FFM_STATES, ...SBM_STATES])];

const SOURCES = {
  slcsp: {
    name: "CMS Marketplace Rate, Plan Attributes, and Service Area PUFs (FFM) and CMS State-Based Marketplace QHP PUFs, plan year 2026",
    url: "https://www.cms.gov/marketplace/resources/data/public-use-files"
  },
  sbm: {
    name: "CMS State-Based Marketplace (SBE) QHP Public Use Files, plan year 2026",
    url: "https://www.cms.gov/marketplace/resources/data/state-based-public-use-files"
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

// Header join key tolerant to both PUF conventions:
// FFM "BusinessYear" and SBM "\"BUSINESS YEAR\"" → "BUSINESSYEAR".
function normHeader(h) {
  return String(h).replace(/^﻿/, "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function headerIndex(headerCells) {
  const map = new Map();
  headerCells.forEach((cell, i) => map.set(normHeader(cell), i));
  return (...names) => {
    for (const n of names) {
      const i = map.get(normHeader(n));
      if (i != null) return i;
    }
    return -1;
  };
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
  "OH|galia": "gallia",        // CMS "Galia"      → Gallia County    (39053)
  "CA|sanbernadino": "sanbernardino", // CMS "San Bernadino" → San Bernardino County (06071)
  "GA|heralson": "haralson",   // CMS "Heralson"   → Haralson County  (13143)
  "NY|deleware": "delaware"    // CMS "Deleware"   → Delaware County  (36025)
};

// Normalize a county name to a join key: strip the county-class suffix and all
// punctuation/whitespace. "St. Johns County" → "stjohns"; "DeSoto" → "desoto".
function normCounty(name) {
  return decodeEntities(name)
    .toLowerCase()
    .replace(/[ñ]/g, "n") // Census "Doña Ana" ↔ CMS "Dona Ana"
    .replace(/\b(county|parish|borough|census area|municipality|city and borough|municipio|city)\b/g, "")
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

// "Rating Area 43" → 43
function areaCodeFromRatingArea(raw) {
  const m = String(raw).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ─── 1. silver on-exchange individual medical plan sets ────────────────────────

// FFM Plan Attributes PUF → { silver:Set(planId), planService:Map(planId -> "ST|issuer|serviceAreaId") }
function loadFfmSilverPlans() {
  const lines = readFileSync(PLAN_ATTR_PUF, "utf8").split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const col = headerIndex(header);
  const cState = col("StateCode");
  const cIssuer = col("IssuerId");
  const cMarket = col("MarketCoverage");
  const cDental = col("DentalOnlyPlan");
  const cMetal = col("MetalLevel");
  const cQHP = col("QHPNonQHPTypeId");
  const cStd = col("StandardComponentId");
  const cSvc = col("ServiceAreaId");
  if ([cState, cIssuer, cMarket, cDental, cMetal, cQHP, cStd, cSvc].some((c) => c < 0)) {
    throw new Error("FFM Plan Attributes PUF is missing an expected column header");
  }
  const silver = new Set();
  const planService = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (f.length < header.length) continue;
    if (f[cMarket] !== "Individual") continue;
    if (f[cDental] !== "No") continue;
    if (f[cMetal] !== "Silver") continue;
    if (f[cQHP] !== "On the Exchange" && f[cQHP] !== "Both") continue;
    silver.add(f[cStd]);
    planService.set(f[cStd], `${f[cState]}|${f[cIssuer]}|${f[cSvc]}`);
  }
  return { silver, planService };
}

// SBM <ST>Plans*.csv → same shape for one state.
function loadSbmSilverPlans(csvPath) {
  const lines = readFileSync(csvPath, "utf8").split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const col = headerIndex(header);
  const cState = col("STATE CODE", "StateCode");
  const cIssuer = col("ISSUER ID", "IssuerId");
  const cMarket = col("MARKET COVERAGE", "MarketCoverage");
  const cDental = col("DENTAL ONLY PLAN", "DENTAL PLAN ONLY", "DentalOnlyPlan");
  const cMetal = col("METAL LEVEL", "MetalLevel");
  const cQHP = col("QHP NONQHP TYPE ID", "QHPNonQHPTypeId");
  const cStd = col("STANDARD COMPONENT ID", "StandardComponentId");
  const cSvc = col("SERVICE AREA ID", "ServiceAreaId");
  if ([cState, cIssuer, cMarket, cDental, cMetal, cQHP, cStd, cSvc].some((c) => c < 0)) {
    throw new Error(`SBM plans file ${path.basename(csvPath)} is missing an expected column header`);
  }
  const silver = new Set();
  const planService = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (f.length <= Math.max(cState, cIssuer, cMarket, cDental, cMetal, cQHP, cStd, cSvc)) continue;
    if (f[cMarket].trim() !== "Individual") continue;
    if (f[cDental].trim() !== "No") continue;
    if (f[cMetal].trim().toLowerCase() !== "silver") continue;
    const qhp = f[cQHP].trim();
    if (qhp !== "On the Exchange" && qhp !== "Both") continue;
    silver.add(f[cStd].trim());
    planService.set(f[cStd].trim(), `${f[cState].trim()}|${f[cIssuer].trim()}|${f[cSvc].trim()}`);
  }
  return { silver, planService };
}

// ─── 2. service areas → county coverage ─────────────────────────────────────────

// serviceAreas: Map("ST|issuer|serviceAreaId" -> {
//   entireState,
//   counties:     Set(fips)  — covered counties, fully OR partially (the
//                              county-level plan set uses this),
//   fullCounties: Set(fips)  — counties covered by at least one NON-partial row,
//   partial:      Map(fips -> Set(zip5)) — counties covered ONLY partially,
//                              with the filed ZIP list
// })
function loadFfmServiceAreas(serviceAreas) {
  const lines = readFileSync(SERVICE_PUF, "utf8").split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const col = headerIndex(header);
  const cState = col("StateCode");
  const cIssuer = col("IssuerId");
  const cSvc = col("ServiceAreaId");
  const cEntire = col("CoverEntireState");
  const cCounty = col("County");
  const cMarket = col("MarketCoverage");
  const cPartial = col("PartialCounty");
  const cZips = col("ZipCodes");
  const cDental = col("DentalOnlyPlan");
  if ([cState, cIssuer, cSvc, cEntire, cCounty].some((c) => c < 0)) {
    throw new Error("FFM Service Area PUF is missing an expected column header");
  }
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (f.length < header.length) continue;
    if (cMarket >= 0 && f[cMarket] && f[cMarket] !== "Individual") continue;
    // Only medical service areas feed the silver-plan join. No 2026 file
    // shares a (state, issuer, serviceAreaId) key between dental and medical
    // rows, but skip dental rows so a future filing never widens a medical
    // plan's coverage through a shared key.
    if (cDental >= 0 && String(f[cDental] ?? "").trim() === "Yes") continue;
    addServiceAreaRow(serviceAreas, f[cState], f[cIssuer], f[cSvc], f[cEntire], f[cCounty],
      cPartial >= 0 ? f[cPartial] : "", cZips >= 0 ? f[cZips] : "");
  }
}

function loadSbmServiceAreas(serviceAreas, csvPath) {
  const lines = readFileSync(csvPath, "utf8").split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const col = headerIndex(header);
  const cState = col("STATE CODE", "StateCode");
  const cIssuer = col("ISSUER ID", "IssuerId");
  const cSvc = col("SERVICE AREA ID", "ServiceAreaId");
  const cEntire = col("COVER ENTIRE STATE", "CoverEntireState");
  const cCounty = col("COUNTY");
  const cMarket = col("MARKET COVERAGE", "MarketCoverage");
  const cPartial = col("PARTIAL COUNTY", "PartialCounty");
  const cZips = col("ZIP CODE", "ZIP CODES", "ZipCodes");
  const cDental = col("DENTAL ONLY PLAN", "DENTAL PLAN ONLY", "DentalOnlyPlan");
  if ([cState, cIssuer, cSvc, cEntire, cCounty].some((c) => c < 0)) {
    throw new Error(`SBM service-area file ${path.basename(csvPath)} is missing an expected column header`);
  }
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (f.length <= Math.max(cState, cIssuer, cSvc, cEntire, cCounty)) continue;
    if (cMarket >= 0 && f[cMarket] && f[cMarket].trim() && f[cMarket].trim() !== "Individual") continue;
    // Same dental guard as the FFM loader (see loadFfmServiceAreas).
    if (cDental >= 0 && String(f[cDental] ?? "").trim() === "Yes") continue;
    // SBM county cells embed the FIPS: "Los Angeles - 06037".
    const m = String(f[cCounty]).match(/(\d{5})\s*$/);
    addServiceAreaRow(serviceAreas, f[cState].trim(), f[cIssuer].trim(), f[cSvc].trim(), f[cEntire], m ? m[1] : "",
      cPartial >= 0 ? f[cPartial] : "", cZips >= 0 ? f[cZips] : "");
  }
}

function addServiceAreaRow(serviceAreas, state, issuer, svcId, entireRaw, countyRaw, partialRaw = "", zipsRaw = "") {
  const key = `${state}|${issuer}|${svcId}`;
  let entry = serviceAreas.get(key);
  if (!entry) {
    entry = { entireState: false, counties: new Set(), fullCounties: new Set(), partial: new Map() };
    serviceAreas.set(key, entry);
  }
  const entire = String(entireRaw).trim().toLowerCase();
  if (entire === "yes" || entire === "true") entry.entireState = true;
  const fips = String(countyRaw).trim();
  if (!/^\d{5}$/.test(fips)) return;
  entry.counties.add(fips);
  const zips = String(zipsRaw).split(/[^0-9]+/).filter((z) => /^\d{5}$/.test(z));
  if (String(partialRaw).trim().toLowerCase() === "yes" && zips.length) {
    // A county is "partial" only when NO row covers it fully; a full row
    // (now or later) wins over the partial designation. A partial row WITHOUT
    // a usable ZIP list degrades to full coverage (same as the pre-ZIP-level
    // behavior: we cannot know which ZIPs, so count the plan for all of them).
    if (!entry.fullCounties.has(fips)) {
      let set = entry.partial.get(fips);
      if (!set) { set = new Set(); entry.partial.set(fips, set); }
      for (const z of zips) set.add(z);
    }
  } else {
    entry.fullCounties.add(fips);
    entry.partial.delete(fips);
  }
}

// ─── 3. rates → per-plan age schedules per (state, rating area) ────────────────

// byArea: state -> areaCode -> planId -> Map(ageIndex -> monthlyRate)
async function loadFfmRates(silver, byArea) {
  const rl = createInterface({ input: createReadStream(RATE_PUF), crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    if (!line) continue;
    const f = line.split(","); // FFM Rate PUF has no quoted fields
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
    addRate(byArea, state, areaCode, plan, ai, rate);
  }
}

// SBM rates: quoted CSV; per-age rows for most states; VT-style family-tier
// rows (AGE empty) fall back to a tier-derived schedule: adults (21+) at the
// filed INDIVIDUAL RATE, children (0-20) at the marginal dependent cost
// (PRIMARY SUBSCRIBER AND ONE DEPENDENT − INDIVIDUAL RATE).
function loadSbmRates(silver, byArea, csvPath) {
  const lines = readFileSync(csvPath, "utf8").split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const col = headerIndex(header);
  const cState = col("STATE CODE", "StateCode");
  const cPlan = col("PLAN ID", "PlanId");
  const cArea = col("RATING AREA ID", "RatingAreaId");
  const cTobacco = col("TOBACCO", "Tobacco");
  const cAge = col("AGE", "Age");
  const cRate = col("INDIVIDUAL RATE", "IndividualRate");
  const cP1 = col("PRIMARY SUBSCRIBER AND ONE DEPENDENT", "PrimarySubscriberAndOneDependent");
  if ([cState, cPlan, cArea, cAge, cRate].some((c) => c < 0)) {
    throw new Error(`SBM rates file ${path.basename(csvPath)} is missing an expected column header`);
  }
  const familyTier = new Map(); // "state|area|plan" -> { individual, p1dep }
  const skip = { len: 0, silver: 0, tobacco: 0, area: 0, rate: 0, age: 0, added: 0 };
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    if (f.length <= Math.max(cState, cPlan, cArea, cAge, cRate)) { skip.len++; continue; }
    const plan = f[cPlan].trim();
    if (!silver.has(plan)) { skip.silver++; continue; }
    // Tobacco column semantics (same as the FFM Rate PUF): "No Preference"
    // means one rate for everyone; "Tobacco User/Non-Tobacco User" means the
    // INDIVIDUAL RATE is the NON-tobacco rate (the tobacco rate lives in
    // INDIVIDUAL TOBACCO RATE) — keep both. Only a hypothetical pure
    // "Tobacco User" row would be skipped.
    if (cTobacco >= 0 && String(f[cTobacco] ?? "").trim().toLowerCase() === "tobacco user") { skip.tobacco++; continue; }
    const state = f[cState].trim();
    const areaCode = areaCodeFromRatingArea(f[cArea]);
    if (areaCode == null) { skip.area++; continue; }
    const rate = Number(f[cRate]);
    if (!Number.isFinite(rate) || rate <= 0) { skip.rate++; continue; }
    const ageTok = String(f[cAge] ?? "").trim();
    if (!ageTok) {
      // Family-tier row (VT): keep the lowest filed variant per plan/area.
      const key = `${state}|${areaCode}|${plan}`;
      const p1 = Number(f[cP1]);
      const cur = familyTier.get(key);
      if (!cur || rate < cur.individual) {
        familyTier.set(key, { individual: rate, p1dep: Number.isFinite(p1) && p1 > 0 ? p1 : null });
      }
      continue;
    }
    const ai = ageIndex(ageTok);
    if (ai === null) { skip.age++; continue; }
    skip.added++;
    addRate(byArea, state, areaCode, plan, ai, rate);
  }
  if (process.env.DEBUG_SBM) console.log(`    [debug ${path.basename(csvPath)}]`, JSON.stringify(skip));
  // Materialize family-tier schedules for plans with no per-age rows.
  for (const [key, tier] of familyTier) {
    const [state, areaStr, plan] = key.split("|");
    const areaCode = Number(areaStr);
    const existing = byArea.get(state)?.get(areaCode)?.get(plan);
    if (existing && existing.size) continue; // per-age rows win
    const childRate = tier.p1dep != null ? Math.max(0, round2(tier.p1dep - tier.individual)) : tier.individual;
    addRate(byArea, state, areaCode, plan, 0, childRate || tier.individual);
    for (let a = 15; a <= 20; a++) addRate(byArea, state, areaCode, plan, a, childRate || tier.individual);
    for (let a = 21; a <= 64; a++) addRate(byArea, state, areaCode, plan, a, tier.individual);
  }
}

function addRate(byArea, state, areaCode, plan, ai, rate) {
  let st = byArea.get(state);
  if (!st) { st = new Map(); byArea.set(state, st); }
  let area = st.get(areaCode);
  if (!area) { area = new Map(); st.set(areaCode, area); }
  let pl = area.get(plan);
  if (!pl) { pl = new Map(); area.set(plan, pl); }
  if (!pl.has(ai)) pl.set(ai, rate);
}

// ─── 4. SLCSP reductions (rating-area level and county level) ───────────────────

function rankPlans(plans, planFilter = null) {
  const ranked = [];
  for (const [plan, ages] of plans) {
    if (planFilter && !planFilter(plan)) continue;
    const r21 = ages.get(21);
    if (Number.isFinite(r21)) ranked.push({ plan, r21, ages });
  }
  ranked.sort((a, b) => a.r21 - b.r21 || a.plan.localeCompare(b.plan));
  return ranked;
}

function slcspFromRanked(ranked) {
  if (!ranked.length) return null;
  const chosen = ranked[1] ?? ranked[0]; // 2nd lowest, or the only plan
  return {
    slcspPlanId: chosen.plan,
    lowestPlanId: ranked[0].plan,
    silverPlanCount: ranked.length,
    monthlyByAge: buildAgeSchedule(chosen.ages)
  };
}

function deriveAreaSlcsp(byArea) {
  const slcsp = {}; // "FL-43" -> entry
  const statesSeen = new Set();
  for (const [state, areas] of byArea) {
    statesSeen.add(state);
    for (const [areaCode, plans] of areas) {
      // Rank plans by their age-21 rate. The ACA age-rating curve is uniform
      // across all issuers within a state, so this ranking is age-invariant —
      // the 2nd-lowest plan at age 21 is the 2nd-lowest at every age.
      const entry = slcspFromRanked(rankPlans(plans));
      if (entry) slcsp[`${state}-${areaCode}`] = entry;
    }
  }
  return { slcsp, statesSeen };
}

// County-level SLCSP: filter each rating area's plans to those whose service
// area covers the county; emit overrides only where the benchmark differs from
// the rating-area benchmark (same plan → rating-area entry already exact).
// Also returns the counties where at least one ranked silver plan covers the
// county only PARTIALLY (ZIP-listed) — those need ZIP-level resolution.
function deriveCountyOverrides({ byArea, areaSlcsp, planService, serviceAreas, stateCountyAreas }) {
  const overrides = {}; // fips -> entry
  const partialCounties = []; // [{ state, fips, areaCode }]
  let countiesChecked = 0;
  let countiesNoServiceData = 0;
  for (const [state, fipsToArea] of Object.entries(stateCountyAreas)) {
    const areas = byArea.get(state);
    if (!areas) continue;
    for (const [fips, areaCode] of Object.entries(fipsToArea)) {
      const plans = areas.get(areaCode);
      if (!plans) continue;
      countiesChecked++;
      let sawServiceData = false;
      let sawPartial = false;
      const covers = (plan) => {
        const svcKey = planService.get(plan);
        if (!svcKey) return true; // no service-area info → assume area-wide
        const svc = serviceAreas.get(svcKey);
        if (!svc) return true;
        sawServiceData = true;
        if (!svc.entireState && svc.partial.has(fips)) sawPartial = true;
        return svc.entireState || svc.counties.has(fips);
      };
      const ranked = rankPlans(plans, covers);
      if (!sawServiceData) { countiesNoServiceData++; continue; }
      if (sawPartial) partialCounties.push({ state, fips, areaCode });
      const entry = slcspFromRanked(ranked);
      if (!entry) continue;
      const areaEntry = areaSlcsp[`${state}-${areaCode}`];
      if (!areaEntry) continue;
      // Only a DIFFERENT benchmark plan changes premiums; a county that merely
      // lacks some pricier plan (same SLCSP, smaller count) needs no override.
      if (entry.slcspPlanId === areaEntry.slcspPlanId) continue;
      overrides[fips] = { state, ...entry };
    }
  }
  return { overrides, partialCounties, countiesChecked, countiesNoServiceData };
}

// ZIP-level SLCSP: for every ZIP whose primary county has a partially-covering
// ranked silver plan, rank the ZIP's own plan set — a plan covers the ZIP iff
// it covers the entire state, covers the ZIP's county FULLY, or lists the ZIP
// in any of its partial-county ZIP lists. Emit an override only where the
// ZIP's benchmark plan differs from the county's effective benchmark (county
// override if present, else the rating-area entry).
function deriveZipOverrides({ byArea, areaSlcsp, countyOverrides, planService, serviceAreas, partialCounties, zipToCounty }) {
  const overrides = {}; // zip5 -> entry
  const partialFips = new Map(partialCounties.map((c) => [c.fips, c]));
  const zipsByFips = new Map(); // fips -> [zip5]
  for (const [zip, fips] of Object.entries(zipToCounty)) {
    if (!partialFips.has(fips)) continue;
    let arr = zipsByFips.get(fips);
    if (!arr) { arr = []; zipsByFips.set(fips, arr); }
    arr.push(zip);
  }
  let zipsChecked = 0;
  let zipsUncovered = 0;
  for (const { state, fips, areaCode } of partialCounties) {
    const plans = byArea.get(state)?.get(areaCode);
    const effective = countyOverrides[fips] ?? areaSlcsp[`${state}-${areaCode}`];
    const zips = zipsByFips.get(fips);
    if (!plans || !effective || !zips) continue;
    for (const zip of zips) {
      zipsChecked++;
      const coversZip = (plan) => {
        const svcKey = planService.get(plan);
        if (!svcKey) return true;
        const svc = serviceAreas.get(svcKey);
        if (!svc) return true;
        // County-consistent test: the ZIP belongs to its primary county, so a
        // partial listing only counts when filed under THIS county. (A ZIP
        // listed under a neighboring county's partial row is not offered to
        // this county's addresses — matching HealthCare.gov's ZIP+county
        // resolution.) This keeps the ZIP plan set a subset of the county's.
        return svc.entireState || svc.fullCounties.has(fips) || (svc.partial.get(fips)?.has(zip) ?? false);
      };
      const entry = slcspFromRanked(rankPlans(plans, coversZip));
      // A ZIP outside every plan's filed coverage keeps the county benchmark
      // (no marketplace plan would actually be offered there; the county
      // entry is the best available estimate).
      if (!entry) { zipsUncovered++; continue; }
      if (entry.slcspPlanId === effective.slcspPlanId) continue;
      overrides[zip] = { state, ...entry };
    }
  }
  return { overrides, zipsChecked, zipsUncovered };
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

// ─── 5. county/zip3 → rating area from the CMS GRA pages ───────────────────────

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
    // Accept zip3 cells with annotations, e.g. CA's "906 (only within LA County)".
    const z = zip3.match(/^(\d{3})\b/);
    if (z) { zip3ToArea[z[1]] = area; zip3Rows++; }
  }
  const methodology = zip3Rows > countyRows ? "zip3" : "county";
  return { stateAbbr, countyToArea, zip3ToArea, countyRows, zip3Rows, methodology };
}

// ─── 6. county name → FIPS (Census national county file) ───────────────────────

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

// ─── 7. ZCTA → primary county FIPS (Census relationship file) ──────────────────

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

function slcspEntryLiteral(v) {
  const ages = v.monthlyByAge.map((n) => (n == null ? "null" : String(n))).join(",");
  return `{ p: ${JSON.stringify(v.slcspPlanId)}, lo: ${JSON.stringify(v.lowestPlanId)}, n: ${v.silverPlanCount}, a: [${ages}] }`;
}

function writeSlcspFile(slcsp, countyOverrides, zipOverrides, coveredStates, provenance) {
  const entries = Object.keys(slcsp).sort().map((k) => `  ${JSON.stringify(k)}: ${slcspEntryLiteral(slcsp[k])}`);

  // Dedupe override schedules: counties/ZIPs sharing an IDENTICAL benchmark
  // entry reference one shared const. The key must include the full per-age
  // schedule — the same plan id carries different filed rates in different
  // rating areas, so keying on plan id alone would alias counties across
  // areas to the wrong schedule. The const pool is shared across the county
  // and ZIP override tables (a ZIP override often equals a neighboring
  // county's entry).
  const shared = new Map(); // serialized entry -> constName
  const sharedDefs = [];
  const overrideEntry = (v) => {
    const key = JSON.stringify([v.slcspPlanId, v.lowestPlanId, v.silverPlanCount, v.monthlyByAge]);
    let constName = shared.get(key);
    if (!constName) {
      constName = `C${sharedDefs.length}`;
      shared.set(key, constName);
      sharedDefs.push(`const ${constName} = ${slcspEntryLiteral(v)};`);
    }
    return constName;
  };
  const countyEntries = Object.keys(countyOverrides).sort()
    .map((fips) => `  ${JSON.stringify(fips)}: ${overrideEntry(countyOverrides[fips])}`);
  const zipEntries = Object.keys(zipOverrides).sort()
    .map((zip) => `  ${JSON.stringify(zip)}: ${overrideEntry(zipOverrides[zip])}`);

  const body = `${banner("SLCSP monthly premium per rating area + county- and ZIP-level overrides, by single-member age.")}
//
// Each value: { p: SLCSP plan id, lo: lowest-cost silver plan id,
//               n: silver plan count, a: monthly premium for ONE member at
//               age 0..64 (index = age; ages 0-14 share the 0-14 band; clamp
//               ages >64 to 64). }
// Premiums are the issuer's filed per-age rates from the CMS Rate PUFs — i.e.
// the same rates HealthCare.gov / the state exchange ranks for the benchmark.
// ACA_SLCSP_COUNTY_OVERRIDES_${PLAN_YEAR} holds the counties whose own silver plan
// set (Service Area PUF filtering) yields a DIFFERENT benchmark than their
// rating area; all other counties use the rating-area entry exactly.
// ACA_SLCSP_ZIP_OVERRIDES_${PLAN_YEAR} holds the ZIPs (within counties that have a
// PARTIAL-county silver plan service area) whose own plan set yields a
// DIFFERENT benchmark than their county; it is consulted before the county
// table. ACA_SLCSP_STATE_PROVENANCE: "ffm-puf" (federal platform) |
// "sbm-puf" (State-Based Marketplace QHP PUF).

export const ACA_RATING_AREA_DATA_VERSION = ${JSON.stringify(DATA_VERSION)};

export const ACA_RATING_AREA_SLCSP_SOURCE = Object.freeze(${JSON.stringify(SOURCES.slcsp)});

export const ACA_SBM_PUF_SOURCE = Object.freeze(${JSON.stringify(SOURCES.sbm)});

export const ACA_SLCSP_COVERED_STATES = Object.freeze(${JSON.stringify(coveredStates)});

export const ACA_SLCSP_STATE_PROVENANCE = Object.freeze(${JSON.stringify(provenance)});

export const ACA_SLCSP_BY_RATING_AREA_${PLAN_YEAR} = Object.freeze({
${entries.join(",\n")}
});

${sharedDefs.join("\n")}

export const ACA_SLCSP_COUNTY_OVERRIDES_${PLAN_YEAR} = Object.freeze({
${countyEntries.join(",\n")}
});

export const ACA_SLCSP_ZIP_OVERRIDES_${PLAN_YEAR} = Object.freeze({
${zipEntries.join(",\n")}
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
// ZIP3_TO_RATING_AREA[stateAbbr][zip3]          = rating area number. For
//   zip3-methodology states (AK) this is the primary path; for
//   county-methodology states it carries intra-state zip3 splits (e.g. CA's
//   LA County areas 15/16) and is consulted as a FALLBACK when the ZIP's
//   county is not in the county map.
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

function findSbmFile(stateDirNames, abbr, kind) {
  // SBM zips extract to one directory per state containing <ST><Kind><date>.csv,
  // sometimes behind one more nested directory (e.g. KY's KentuckySBEPUF2026/).
  const upper = abbr.toUpperCase();
  const matchCsv = (files) => files.find((f) => new RegExp(`^${upper}${kind}`, "i").test(f) && f.endsWith(".csv"));
  for (const dir of stateDirNames) {
    const full = path.join(SBE_RAW_DIR, dir);
    let files;
    try { files = readdirSync(full, { withFileTypes: true }); } catch { continue; }
    const hit = matchCsv(files.filter((f) => f.isFile()).map((f) => f.name));
    if (hit) return path.join(full, hit);
    for (const sub of files.filter((f) => f.isDirectory())) {
      let nested;
      try { nested = readdirSync(path.join(full, sub.name)); } catch { continue; }
      const nestedHit = matchCsv(nested);
      if (nestedHit) return path.join(full, sub.name, nestedHit);
    }
  }
  return null;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log("· loading FFM silver on-exchange medical plan set …");
  const ffm = loadFfmSilverPlans();
  console.log(`  ${ffm.silver.size} FFM silver plans`);

  const serviceAreas = new Map();
  console.log("· loading FFM service areas …");
  loadFfmServiceAreas(serviceAreas);

  console.log("· streaming FFM Rate PUF …");
  const byArea = new Map();
  await loadFfmRates(ffm.silver, byArea);

  const planService = new Map(ffm.planService);
  const provenance = {};
  for (const st of FFM_STATES) provenance[st.toUpperCase()] = "ffm-puf";

  console.log("· ingesting SBM QHP PUFs …");
  const sbmDirs = existsSync(SBE_RAW_DIR) ? readdirSync(SBE_RAW_DIR).filter((d) => !d.endsWith(".zip")) : [];
  const sbmIngested = [];
  for (const abbr of SBM_STATES) {
    const plansCsv = findSbmFile(sbmDirs, abbr, "Plans");
    const ratesCsv = findSbmFile(sbmDirs, abbr, "Rates");
    const svcCsv = findSbmFile(sbmDirs, abbr, "ServiceAreas");
    if (!plansCsv || !ratesCsv) {
      console.warn(`  ⚠ SBM ${abbr.toUpperCase()}: missing Plans/Rates CSV — skipped (falls back to sbeRatingArea.mjs)`);
      continue;
    }
    const sbm = loadSbmSilverPlans(plansCsv);
    for (const [k, v] of sbm.planService) planService.set(k, v);
    if (svcCsv) loadSbmServiceAreas(serviceAreas, svcCsv);
    loadSbmRates(sbm.silver, byArea, ratesCsv);
    sbmIngested.push(abbr.toUpperCase());
    provenance[abbr.toUpperCase()] = "sbm-puf";
    const areaCount = byArea.get(abbr.toUpperCase())?.size ?? 0;
    console.log(`  ${abbr.toUpperCase()}: ${sbm.silver.size} silver plans, ${areaCount} rating areas with rates (${path.basename(ratesCsv)})`);
  }

  console.log("· deriving rating-area SLCSP …");
  const { slcsp, statesSeen } = deriveAreaSlcsp(byArea);
  console.log(`  ${Object.keys(slcsp).length} rating areas across ${statesSeen.size} states`);

  console.log("· parsing CMS GRA pages …");
  const countyFips = loadCountyFips();
  const states = [];
  const coveredFips = new Set();
  const stateCountyAreas = {};
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
    stateCountyAreas[upper] = fipsToArea;
    states.push({ stateAbbr: upper, fipsToArea, zip3ToArea: parsed.zip3ToArea, methodology: parsed.methodology });
  }
  if (unmatchedCounties.length) {
    console.warn(`  ⚠ ${unmatchedCounties.length} GRA counties did not match a FIPS: ${unmatchedCounties.slice(0, 20).join(", ")}${unmatchedCounties.length > 20 ? " …" : ""}`);
  }

  console.log("· deriving county-level SLCSP overrides (Service Area PUF) …");
  const { overrides, partialCounties, countiesChecked, countiesNoServiceData } = deriveCountyOverrides({
    byArea,
    areaSlcsp: slcsp,
    planService,
    serviceAreas,
    stateCountyAreas
  });
  console.log(`  ${Object.keys(overrides).length} county overrides out of ${countiesChecked} counties (${countiesNoServiceData} without service-area data)`);

  console.log("· building ZIP → primary county (covered counties only) …");
  const zipToCounty = loadZipToCounty(coveredFips);
  console.log(`  ${Object.keys(zipToCounty).length} ZIPs`);

  console.log("· deriving ZIP-level SLCSP overrides (partial-county service areas) …");
  const zipResult = deriveZipOverrides({
    byArea,
    areaSlcsp: slcsp,
    countyOverrides: overrides,
    planService,
    serviceAreas,
    partialCounties,
    zipToCounty
  });
  const partialStates = [...new Set(partialCounties.map((c) => c.state))].sort();
  console.log(`  ${partialCounties.length} counties with partial-county silver plans (${partialStates.join(", ") || "none"})`);
  console.log(`  ${Object.keys(zipResult.overrides).length} ZIP overrides out of ${zipResult.zipsChecked} ZIPs checked (${zipResult.zipsUncovered} ZIPs outside every plan's filed coverage)`);

  const coveredStates = [...new Set([...states.map((s) => s.stateAbbr)])]
    .filter((st) => statesSeen.has(st))
    .sort();
  for (const st of statesSeen) {
    if (!coveredStates.includes(st)) console.warn(`  ⚠ SLCSP has state ${st} with no GRA page ingested`);
  }
  // Drop provenance entries for states that produced no SLCSP data.
  for (const st of Object.keys(provenance)) {
    if (!coveredStates.includes(st)) delete provenance[st];
  }

  const s1 = writeSlcspFile(slcsp, overrides, zipResult.overrides, coveredStates, provenance);
  const s2 = writeCountyToRatingAreaFile(states);
  const s3 = writeZipToCountyFile(zipToCounty);

  console.log("· wrote:");
  console.log(`  acaRatingArea${PLAN_YEAR}.generated.mjs   ${(s1 / 1024).toFixed(0)} KB`);
  console.log(`  countyToRatingArea.generated.mjs    ${(s2 / 1024).toFixed(0)} KB`);
  console.log(`  zipToCounty.generated.mjs           ${(s3 / 1024).toFixed(0)} KB`);
  console.log(`  total raw                           ${((s1 + s2 + s3) / 1024).toFixed(0)} KB`);
  console.log(`  SBM states ingested: ${sbmIngested.join(", ") || "none"}`);
}

await main();
