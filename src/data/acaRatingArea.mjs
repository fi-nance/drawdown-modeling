// Offline, rating-area-level Second Lowest Cost Silver Plan (SLCSP) lookup.
//
// Why this exists
// ───────────────
// `docs/GOAL.md` Phase 1 calls for "Rating-area-level SLCSP from ZIP code
// alone, not state-level fallback." The state-level defaults in
// `taxData.mjs::ACA_BENCHMARK_PREMIUMS_2026_MONTHLY` are a single number per
// state; two households in the same state but different rating areas can face
// materially different benchmark premiums, which changes the modeled premium
// tax credit. This module resolves a ZIP to its CMS rating area and returns the
// real second-lowest-cost silver plan premium for that rating area, age-rated to
// the household — with no network call. It is the offline equivalent of the
// online CMS Marketplace API helper in `marketplaceApi.mjs`.
//
// Data chain (all bundled offline, all from primary sources)
// ──────────────────────────────────────────────────────────
//   ZIP5  ──Census ZCTA↔county──▶  county FIPS
//   county FIPS  ──CMS rating areas──▶  rating area code   (county-based states)
//   ZIP3  ──CMS rating areas──▶  rating area code          (ZIP-based states, e.g. AK)
//   (state, rating area)  ──CMS Rate + Plan Attributes PUF──▶  SLCSP per-age premium
//
// The three `*.generated.mjs` files are produced by
// `scripts/generateAcaRatingArea.mjs`; see docs/DATA_SOURCES.md for the runbook.
//
// Scope and fallbacks
// ───────────────────
// Coverage is the 30 federal-platform states that file rates into the CMS PUFs.
// State-based-exchange states (CA, NY, MA, CO, …) publish their own data and are
// out of scope for this slice — see docs/KNOWN_LIMITATIONS.md. The returned
// `fallback` field always tells the caller what happened:
//   - null          → bundled rating-area SLCSP was used (the accurate path).
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
  ACA_SLCSP_BY_RATING_AREA_2026,
  ACA_SLCSP_COVERED_STATES
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
  { name: ACA_RATING_AREA_GRA_SOURCE.name, url: ACA_RATING_AREA_GRA_SOURCE.url },
  { name: ZIP_TO_COUNTY_SOURCE.name, url: ZIP_TO_COUNTY_SOURCE.url }
]);

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

  const areaCode = ratingAreaForZip(state, geo);
  const slcsp = areaCode == null ? null : ACA_SLCSP_BY_RATING_AREA_2026[`${state}-${areaCode}`];
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
      methodology: RATING_AREA_METHODOLOGY[state] ?? "county",
      source: ACA_RATING_AREA_GRA_SOURCE.name
    }),
    ageRatingFactorTotal: round6(factorTotal),
    medicareExcludedMemberCount,
    fallback: null,
    planYear,
    slcspPlanId: slcsp.p,
    referenceMonthlyPremium: base21,
    countyFips: geo.state && RATING_AREA_METHODOLOGY[state] === "county" ? ZIP5_TO_COUNTY_FIPS[geo.zip] ?? null : null,
    sources: Object.freeze({
      ratingArea: ACA_RATING_AREA_GRA_SOURCE.name,
      slcsp: ACA_RATING_AREA_SLCSP_SOURCE.name,
      zipToCounty: ZIP_TO_COUNTY_SOURCE.name
    })
  });
}

// ─── geography ─────────────────────────────────────────────────────────────

function ratingAreaForZip(state, geo) {
  const methodology = RATING_AREA_METHODOLOGY[state] ?? "county";
  if (methodology === "zip3") {
    const zip3 = geo.zip3 ?? (geo.zip ? geo.zip.slice(0, 3) : null);
    return zip3 != null ? (ZIP3_TO_RATING_AREA[state]?.[zip3] ?? null) : null;
  }
  if (!geo.zip) return null; // need a full ZIP5 to resolve county
  const fips = ZIP5_TO_COUNTY_FIPS[geo.zip];
  if (!fips) return null;
  return COUNTY_TO_RATING_AREA[state]?.[fips] ?? null;
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
