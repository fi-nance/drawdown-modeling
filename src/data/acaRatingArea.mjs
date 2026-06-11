// Offline COUNTY-level Second Lowest Cost Silver Plan (SLCSP) lookup.
//
// Why this exists
// ───────────────
// `docs/GOAL.md` Phase 1 calls for "Rating-area-level SLCSP from ZIP code
// alone" and Phase 4 for county-level precision plus State-Based Marketplace
// rate-sheet ingestion. The state-level defaults in
// `taxData.mjs::ACA_BENCHMARK_PREMIUMS_2026_MONTHLY` are a single number per
// state; two households in the same state but different rating areas — or even
// different counties of one rating area, when plan service areas cover only
// part of it — can face materially different benchmark premiums, which changes
// the modeled premium tax credit. This module resolves a ZIP to its county and
// rating area and returns the second-lowest-cost silver plan premium for the
// COUNTY when its own silver plan set differs from the rating area's
// (Service Area PUF filtering), otherwise the rating-area benchmark — with no
// network call. It is the offline equivalent of the online CMS Marketplace API
// helper in `marketplaceApi.mjs`.
//
// Data chain (all bundled offline, all from primary sources)
// ──────────────────────────────────────────────────────────
//   ZIP5  ──Census ZCTA↔county──▶  county FIPS
//   county FIPS  ──CMS rating areas──▶  rating area code   (county-based states)
//   ZIP3  ──CMS rating areas──▶  rating area code          (ZIP-based states like
//                                 AK/MA, and intra-state splits like CA's LA County)
//   (state, rating area)  ──CMS Rate + Plan Attributes PUFs──▶  area SLCSP per age
//   county FIPS  ──CMS Service Area PUF──▶  county SLCSP override where the
//                                 county's available silver plan set differs
//
// The three `*.generated.mjs` files are produced by
// `scripts/generateAcaRatingArea.mjs`; see docs/DATA_SOURCES.md for the runbook.
//
// Scope and fallbacks
// ───────────────────
// Coverage is every state that files into the CMS FFM PUFs (30) PLUS every
// State-Based Marketplace with a published CMS SBM QHP PUF for the plan year
// (2026: 18 states incl. CA, NY, MA, WA, PA, NJ — rate-sheet-derived, no longer
// hand-maintained estimates). SBM states WITHOUT a published PUF (2026: CO, MD)
// fall back to the reference estimates in `sbeRatingArea.mjs`. The returned
// `fallback` field always tells the caller what happened:
//   - null          → bundled county/rating-area SLCSP was used (the accurate
//                     path; see `benchmarkLevel` for which).
//   - "state"       → fell back to the state-level benchmark (SBM state not yet
//                     ingested, or the ZIP's county/rating area could not be
//                     derived). The premium is still age-rated to the household.
//   - "out-of-model"→ no marketplace applies (U.S. territory, APO/FPO military,
//                     or an unrecognizable ZIP). `monthlyPremium` is null.

import { resolveZip } from "./geo.mjs";
import { isSbeState, sbeSlcspMonthlyFor } from "./sbeRatingArea.mjs";
// `acaAgeRatingFactor` is a hoisted function export; importing it here from the
// core ACA module is safe under the module cycle (core/aca.mjs imports
// `slcspMonthlyFor` back) because neither binding is used at module-eval time.
import { acaAgeRatingFactor } from "../core/aca.mjs";
import {
  ACA_DEFAULT_BENCHMARK_REFERENCE_AGE,
  getMonthlyBenchmarkPremium,
  ACA_2026
} from "./taxData.mjs";
import {
  ACA_RATING_AREA_DATA_VERSION,
  ACA_RATING_AREA_SLCSP_SOURCE,
  ACA_SBM_PUF_SOURCE,
  ACA_SLCSP_BY_RATING_AREA_2026,
  ACA_SLCSP_COUNTY_OVERRIDES_2026,
  ACA_SLCSP_COVERED_STATES,
  ACA_SLCSP_STATE_PROVENANCE
} from "./acaRatingArea2026.generated.mjs";
import {
  ACA_RATING_AREA_GRA_SOURCE,
  COUNTY_TO_RATING_AREA,
  RATING_AREA_METHODOLOGY,
  ZIP3_TO_RATING_AREA
} from "./countyToRatingArea.generated.mjs";
import {
  ZIP5_TO_COUNTY_FIPS,
  ZIP_TO_COUNTY_SOURCE
} from "./zipToCounty.generated.mjs";

export { ACA_RATING_AREA_DATA_VERSION } from "./acaRatingArea2026.generated.mjs";

const COVERED_STATE_SET = new Set(ACA_SLCSP_COVERED_STATES);
const MAX_RATING_AGE = 64; // marketplace age rating tops out at 64
// Members 65+ are Medicare-eligible and are EXCLUDED from the marketplace
// household premium (they are not clamped to the age-64 rate — that would
// double-charge a mixed ACA/Medicare household, since the simulator already
// bills Part B/D premiums for the 65+ member). Matches the exclude65Plus
// behavior of the manual age-rated path in src/core/aca.mjs.
const MEDICARE_ELIGIBILITY_AGE = 65;

// Manifest for the data-sources coverage test.
export const ACA_RATING_AREA_DATA_SOURCES = Object.freeze([
  { name: ACA_RATING_AREA_SLCSP_SOURCE.name, url: ACA_RATING_AREA_SLCSP_SOURCE.url },
  { name: ACA_SBM_PUF_SOURCE.name, url: ACA_SBM_PUF_SOURCE.url },
  { name: ACA_RATING_AREA_GRA_SOURCE.name, url: ACA_RATING_AREA_GRA_SOURCE.url },
  { name: ZIP_TO_COUNTY_SOURCE.name, url: ZIP_TO_COUNTY_SOURCE.url }
]);

// Per-state SLCSP provenance for confidence copy: "ffm-puf" | "sbm-puf".
export { ACA_SLCSP_STATE_PROVENANCE } from "./acaRatingArea2026.generated.mjs";

function slcspSourceForState(state) {
  return ACA_SLCSP_STATE_PROVENANCE[state] === "sbm-puf"
    ? ACA_SBM_PUF_SOURCE.name
    : ACA_RATING_AREA_SLCSP_SOURCE.name;
}

/**
 * Resolve a ZIP code to the rating-area-level SLCSP monthly premium for a
 * household, age-rated across its members.
 *
 * @param {object} args
 * @param {string|number} args.zip         5-digit ZIP (string, number, or ZIP+4).
 * @param {number} [args.planYear=2026]    Plan year (only 2026 data is bundled).
 * @param {number} [args.age]              A single covered member's age.
 * @param {number[]} [args.householdAges]  Ages of every marketplace-covered member.
 * @param {object} [args.householdComposition] Optional {adults?, children?} where
 *        each is an array of ages; merged with householdAges when provided.
 * @returns {{
 *   monthlyPremium: number|null,
 *   ratingArea: {state:string, areaCode:number|null, methodology:string, source:string}|null,
 *   ageRatingFactorTotal: number,
 *   medicareExcludedMemberCount: number,
 *   fallback: null|"state"|"out-of-model",
 *   sources: {ratingArea:string, slcsp:string, zipToCounty:string}
 * }}
 *
 * Members age 65+ are Medicare-eligible and excluded from the marketplace
 * premium (`medicareExcludedMemberCount` reports how many were dropped). A
 * household whose members are ALL 65+ returns monthlyPremium 0 rather than
 * throwing — the marketplace premium for such a household is zero.
 *
 * Never throws on geography. Throws only when no usable age is supplied.
 */
export function slcspMonthlyFor({ zip, planYear = 2026, age, householdAges, householdComposition } = {}) {
  const memberAges = resolveMemberAges({ age, householdAges, householdComposition });
  if (!memberAges.length) {
    throw new Error("slcspMonthlyFor requires `age`, `householdAges`, or `householdComposition` with member ages.");
  }
  const { counted, medicareExcludedMemberCount } = splitMarketplaceMembers(memberAges);

  const geo = resolveZip(zip);
  const state = geo.stateAbbreviation;

  // No marketplace: territory, military, or unrecognizable ZIP (no state).
  if (!state) {
    return outOfModel(geo, planYear, medicareExcludedMemberCount);
  }

  // State not in the bundled federal-platform set (e.g. a state-based exchange):
  // check if it is a covered State-Based Exchange (SBE) and route offline;
  // otherwise, fall back to the state-level benchmark.
  if (!COVERED_STATE_SET.has(state)) {
    if (isSbeState(state)) {
      return sbeSlcspMonthlyFor({ state, zip, planYear, age, householdAges, householdComposition });
    }
    return stateFallback({ geo, state: geo.state, counted, medicareExcludedMemberCount, planYear, reason: "sbm-not-ingested" });
  }

  const { areaCode, countyFips, resolvedBy } = ratingAreaForZip(state, geo);
  // County-level benchmark when this county's own silver plan set (Service
  // Area PUF filtering) yields a different SLCSP than its rating area;
  // otherwise the rating-area entry is already county-exact.
  const countyOverride = countyFips ? ACA_SLCSP_COUNTY_OVERRIDES_2026[countyFips] ?? null : null;
  const slcsp = countyOverride ?? (areaCode == null ? null : ACA_SLCSP_BY_RATING_AREA_2026[`${state}-${areaCode}`]);
  if (!slcsp) {
    // Covered state but the ZIP's county / rating area could not be resolved.
    return stateFallback({ geo, state: geo.state, counted, medicareExcludedMemberCount, planYear, reason: "rating-area-underived" });
  }

  const base21 = slcsp.a[21];
  let monthlyPremium = 0;
  let factorTotal = 0;
  for (const memberAge of counted) {
    const idx = clampRatingAge(memberAge);
    const rate = slcsp.a[idx];
    if (Number.isFinite(rate)) {
      monthlyPremium += rate;
      // Effective age factor implied by the issuer's filed per-age rates.
      factorTotal += base21 > 0 ? rate / base21 : acaAgeRatingFactor(idx);
    }
  }

  return Object.freeze({
    monthlyPremium: round2(monthlyPremium),
    ratingArea: Object.freeze({
      state,
      areaCode,
      // How THIS ZIP resolved: "zip3" for zip3-methodology states (AK, MA)
      // and intra-state splits (CA's LA County); "county" otherwise.
      methodology: resolvedBy ?? (RATING_AREA_METHODOLOGY[state] ?? "county"),
      source: ACA_RATING_AREA_GRA_SOURCE.name
    }),
    ageRatingFactorTotal: round6(factorTotal),
    medicareExcludedMemberCount,
    fallback: null,
    benchmarkLevel: countyOverride ? "county" : "rating-area",
    planYear,
    slcspPlanId: slcsp.p,
    referenceMonthlyPremium: base21,
    countyFips: countyFips ?? null,
    sources: Object.freeze({
      ratingArea: ACA_RATING_AREA_GRA_SOURCE.name,
      slcsp: slcspSourceForState(state),
      zipToCounty: ZIP_TO_COUNTY_SOURCE.name
    })
  });
}

// ─── geography ─────────────────────────────────────────────────────────────

// Resolve the rating area AND (when applicable) the county FIPS for a ZIP.
// Precedence in county-methodology states: the county map wins when the ZIP's
// county is mapped (it also unlocks county-level SLCSP overrides); the zip3
// map is the fallback for counties the GRA defines only by 3-digit ZIP —
// e.g. CA's Los Angeles County, split into rating areas 15/16 by zip3.
// zip3-methodology states (AK, MA) resolve by zip3 alone (no county overrides).
function ratingAreaForZip(state, geo) {
  const methodology = RATING_AREA_METHODOLOGY[state] ?? "county";
  const zip3 = geo.zip3 ?? (geo.zip ? geo.zip.slice(0, 3) : null);
  const zip3Area = zip3 != null ? (ZIP3_TO_RATING_AREA[state]?.[zip3] ?? null) : null;
  if (methodology === "zip3") {
    return { areaCode: zip3Area, countyFips: null, resolvedBy: "zip3" };
  }
  const fips = geo.zip ? ZIP5_TO_COUNTY_FIPS[geo.zip] ?? null : null;
  const countyArea = fips != null ? COUNTY_TO_RATING_AREA[state]?.[fips] ?? null : null;
  if (countyArea != null) return { areaCode: countyArea, countyFips: fips, resolvedBy: "county" };
  if (zip3Area != null) return { areaCode: zip3Area, countyFips: null, resolvedBy: "zip3" };
  return { areaCode: null, countyFips: null, resolvedBy: null };
}

// ─── fallbacks ───────────────────────────────────────────────────────────────

function stateFallback({ geo, state, counted, medicareExcludedMemberCount = 0, planYear, reason }) {
  // State-level benchmark is a per-member monthly premium at the default
  // reference age (40). Convert to an age-21 base, then age-rate the household
  // via the federal default age curve — matching how the rest of the model
  // age-rates the state benchmark.
  const perMember40 = getMonthlyBenchmarkPremium({ taxYear: 2026, state });
  const factor40 = acaAgeRatingFactor(ACA_DEFAULT_BENCHMARK_REFERENCE_AGE);
  const base21 = factor40 > 0 ? perMember40 / factor40 : perMember40;

  let monthlyPremium = 0;
  let factorTotal = 0;
  for (const memberAge of counted) {
    const factor = acaAgeRatingFactor(clampRatingAge(memberAge));
    monthlyPremium += base21 * factor;
    factorTotal += factor;
  }

  return Object.freeze({
    monthlyPremium: round2(monthlyPremium),
    ratingArea: Object.freeze({
      state: geo.stateAbbreviation,
      areaCode: null,
      methodology: "state-benchmark",
      source: ACA_2026.source
    }),
    ageRatingFactorTotal: round6(factorTotal),
    medicareExcludedMemberCount,
    fallback: "state",
    fallbackReason: reason,
    benchmarkLevel: "state",
    planYear,
    referenceMonthlyPremium: round2(base21),
    countyFips: null,
    sources: Object.freeze({
      ratingArea: ACA_2026.source,
      slcsp: ACA_2026.source,
      zipToCounty: ZIP_TO_COUNTY_SOURCE.name
    })
  });
}

function outOfModel(geo, planYear, medicareExcludedMemberCount = 0) {
  return Object.freeze({
    monthlyPremium: null,
    ratingArea: null,
    ageRatingFactorTotal: 0,
    medicareExcludedMemberCount,
    fallback: "out-of-model",
    benchmarkLevel: null,
    fallbackReason: geo.fallback ?? "unknown", // "military" | "territory" | "unknown"
    planYear,
    referenceMonthlyPremium: null,
    countyFips: null,
    sources: Object.freeze({
      ratingArea: ACA_RATING_AREA_GRA_SOURCE.name,
      slcsp: ACA_RATING_AREA_SLCSP_SOURCE.name,
      zipToCounty: ZIP_TO_COUNTY_SOURCE.name
    })
  });
}

// ─── household composition ─────────────────────────────────────────────────

function resolveMemberAges({ age, householdAges, householdComposition }) {
  const ages = [];
  if (Array.isArray(householdAges)) {
    for (const a of householdAges) if (Number.isFinite(Number(a))) ages.push(Number(a));
  }
  if (!ages.length && householdComposition && typeof householdComposition === "object") {
    for (const group of [householdComposition.adults, householdComposition.children, householdComposition.ages]) {
      if (Array.isArray(group)) for (const a of group) if (Number.isFinite(Number(a))) ages.push(Number(a));
    }
  }
  if (!ages.length && Number.isFinite(Number(age))) ages.push(Number(age));
  return ages.map((a) => Math.max(0, Math.trunc(a)));
}

// Split a household into marketplace-rated members and Medicare-eligible
// (65+) members. Medicare-eligible members are excluded from the marketplace
// premium entirely; the count is surfaced so callers/confidence copy can
// explain the exclusion.
function splitMarketplaceMembers(memberAges) {
  const marketplaceAges = memberAges.filter((memberAge) => memberAge < MEDICARE_ELIGIBILITY_AGE);
  return {
    counted: countedMembers(marketplaceAges),
    medicareExcludedMemberCount: memberAges.length - marketplaceAges.length
  };
}

// Apply the ACA family-premium rule: every member age 21+ is counted; among
// members under 21, only the three oldest are counted. (26 CFR §1.36B-3(d) /
// 45 CFR §147.102(c)(1).)
function countedMembers(memberAges) {
  const adults = memberAges.filter((a) => a >= 21);
  const minors = memberAges.filter((a) => a < 21).sort((x, y) => y - x).slice(0, 3);
  return [...adults, ...minors];
}

function clampRatingAge(age) {
  return Math.min(MAX_RATING_AGE, Math.max(0, Math.trunc(Number(age) || 0)));
}

const round2 = (n) => Math.round(n * 100) / 100;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
