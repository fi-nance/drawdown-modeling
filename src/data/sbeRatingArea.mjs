// Offline, rating-area-level Second Lowest Cost Silver Plan (SLCSP) lookup for State-Based Exchanges (SBEs).
//
// Why this exists
// ───────────────
// Ingests and maps ZIP codes and counties to their local SBE rating areas and 2026 SLCSP rates
// for Covered California, NY State of Health, Pennie, kynect, Access Health CT, Your Health Idaho, etc.
// Enforces state-specific rules, such as community-rated plans in NY and VT (no age-rating drag).
//
// Provenance caveat (CPA lens, docs/REVIEW_BAR.md): these SBE figures are
// hand-maintained reference estimates. As of Phase 4, MOST State-Based
// Marketplaces are ingested from the CMS SBM QHP PUFs into
// acaRatingArea2026.generated.mjs (rate-sheet-derived, county/rating-area
// accurate) and never reach this module — the main resolver in
// acaRatingArea.mjs only routes here for SBE states WITHOUT a published SBM
// PUF for the plan year (2026: Colorado and Maryland) or if a regeneration
// ever drops a state. The remaining estimates are reference-age (40) /
// community-flat second-lowest-silver approximations to be verified against
// the source bulletins during the annual refresh; states with no ZIP3
// rating-area map return fallback:"state" so the confidence layer presents
// them as state-level estimates rather than rating-area-accurate benchmarks.

import { acaAgeRatingFactor } from "../core/aca.mjs";
import { resolveZip } from "./geo.mjs";

export const SBE_DATA_VERSION = "2026.1";

export const SBE_COVERED_STATES = Object.freeze([
  "CA", "NY", "WA", "CO", "PA", "NJ", "MA", "CT", "DC", "ID", "KY", "ME", "MD", "MN", "NV", "NM", "RI", "VT"
]);

const SBE_COVERED_STATE_SET = new Set(SBE_COVERED_STATES);

/**
 * Check if a state abbreviation is a covered State-Based Exchange.
 */
export function isSbeState(stateAbbr) {
  return SBE_COVERED_STATE_SET.has(stateAbbr);
}

// ─── SBE ZIP3 to Rating Area Map ─────────────────────────────────────────────
const SBE_ZIP3_TO_RATING_AREA = Object.freeze({
  CA: {
    // Southern CA / LA & San Diego / Orange County
    "900": 15, "901": 15, "902": 15, "903": 15, "904": 15, "905": 15, "906": 15, "907": 15, "908": 15,
    "910": 15, "911": 15, "912": 15, "913": 15, "914": 15, "915": 15, "916": 15, "917": 15, "918": 15,
    "919": 19, "920": 19, "921": 19,
    "922": 17, "923": 17, "924": 17, "925": 17,
    "926": 18, "927": 18, "928": 18,
    // Central Coast & Kern
    "930": 12, "931": 12, "932": 14, "933": 14, "934": 12,
    "935": 13, "936": 11, "937": 11, "938": 11, "939": 7,
    // Northern CA / Bay Area / Central Valley
    "940": 3, "941": 3, "942": 3, "943": 3, "944": 8,
    "945": 4, "946": 5, "947": 5, "948": 4, "949": 3,
    "950": 6, "951": 6, "952": 9, "953": 9, "954": 1, "955": 1,
    "956": 2, "957": 2, "958": 2, "959": 1, "960": 1, "961": 1
  },
  NY: {
    "005": 6, // Pfizer/Holtsville outlier
    "100": 6, "101": 6, "102": 6, "103": 6, "104": 6, // NYC Metro
    "105": 5, "106": 5, "107": 5, "108": 5, "109": 5, // Mid-Hudson
    "110": 7, "111": 7, "112": 7, "113": 7, "114": 7, "115": 7, "116": 7, "117": 7, "118": 7, "119": 7, // Long Island
    "120": 4, "121": 4, "122": 4, "123": 4, // Albany
    "124": 5, "125": 5, "126": 5, "127": 5, // Mid-Hudson
    "128": 4, "129": 4, // Albany
    "130": 3, "131": 3, "132": 3, "133": 3, "134": 3, "135": 3, // Syracuse
    "136": 8, // Utica
    "137": 3, "138": 3, "139": 3, // Syracuse
    "140": 2, "141": 2, "142": 2, "143": 2, // Buffalo
    "144": 1, "145": 1, "146": 1, // Rochester
    "147": 2, "148": 2, "149": 2 // Buffalo/Elmira
  },
  WA: {
    "980": 1, "981": 1, // King County
    "982": 4, // Snohomish/North
    "983": 2, "984": 2, // Pierce/Tacoma
    "990": 3, "991": 3, "992": 3 // Spokane
  },
  CO: {
    "800": 1, "801": 1, "802": 1, // Denver
    "803": 2, // Boulder
    "805": 4, // Fort Collins
    "806": 6, // Greeley
    "808": 3, "809": 3, // Colorado Springs
    "810": 7, // Pueblo
    "815": 5 // Mesa
  },
  PA: {
    "150": 2, "151": 2, "152": 2, "153": 2, "154": 2, // Pittsburgh
    "158": 8, "159": 8, "160": 8, "161": 8, "162": 8, "163": 8, "164": 8, "165": 8, "166": 8, "167": 8, "168": 8, // Central PA
    "169": 4, "170": 4, "171": 4, // Harrisburg
    "179": 3, "180": 3, "181": 3, // Allentown
    "182": 5, "183": 5, "184": 5, "185": 5, "186": 5, "187": 5, "188": 5, // Scranton
    "189": 1, "190": 1, "191": 1, "192": 1, "193": 1, "194": 1, // Philadelphia Metro
    "195": 7, "196": 7 // Reading
  },
  NJ: {
    "070": 1, "071": 1, "072": 1, "073": 1, "074": 1, "075": 1, "076": 1, // North Jersey
    "077": 2, "078": 2, "079": 2, // Central Jersey
    "080": 3, "081": 3, "082": 3, "083": 3, "084": 3, // South Jersey
    "085": 5, "086": 5, "087": 5, // Shore
    "088": 4, "089": 4 // West
  }
});

// ─── SBE Rating Area Monthly SLCSPs (at Age 40 / Community Flat) ─────────────
const SBE_RATING_AREA_SLCSP_2026 = Object.freeze({
  CA: {
    1: 630.00, 2: 560.00, 3: 620.00, 4: 595.00, 5: 580.00, 6: 575.00, 7: 640.00, 8: 610.00,
    9: 530.00, 10: 540.00, 11: 520.00, 12: 590.00, 13: 580.00, 14: 510.00, 15: 515.00,
    16: 505.00, 17: 530.00, 18: 525.00, 19: 540.00, default: 570.00
  },
  NY: {
    1: 760.00, 2: 730.00, 3: 780.00, 4: 800.00, 5: 890.00, 6: 835.00, 7: 860.00, 8: 810.00, default: 817.00
  },
  WA: {
    1: 580.00, 2: 605.00, 3: 620.00, 4: 595.00, 5: 650.00, default: 612.00
  },
  CO: {
    1: 510.00, 2: 530.00, 3: 520.00, 4: 545.00, 5: 590.00, 6: 535.00, 7: 560.00, 8: 610.00, 9: 650.00, default: 557.00
  },
  PA: {
    1: 610.00, 2: 520.00, 3: 590.00, 4: 560.00, 5: 580.00, 6: 550.00, 7: 600.00, 8: 570.00, 9: 595.00, default: 572.00
  },
  NJ: {
    1: 560.00, 2: 550.00, 3: 520.00, 4: 575.00, 5: 540.00, 6: 535.00, default: 545.00
  },
  MA: { default: 494.00 },
  CT: { default: 870.00 },
  DC: { default: 610.00 },
  ID: { default: 490.00 },
  KY: { default: 590.00 },
  ME: { default: 709.00 },
  MD: { default: 414.00 },
  MN: { default: 448.00 },
  NV: { default: 497.00 },
  NM: { default: 623.00 },
  RI: { default: 506.00 },
  VT: { default: 1299.00 }
});

const MAX_RATING_AGE = 64;
// Members 65+ are Medicare-eligible and are EXCLUDED from the marketplace
// household premium (mirrors acaRatingArea.mjs — clamping them to the age-64
// rate would double-charge mixed ACA/Medicare households).
const MEDICARE_ELIGIBILITY_AGE = 65;
// CMS benchmark reference age; the bundled non-community SBE figures are quoted
// at this age, matching ACA_DEFAULT_BENCHMARK_REFERENCE_AGE in taxData.mjs.
const REFERENCE_AGE = 40;

/**
 * Resolve an SBE ZIP code to the rating-area-level SLCSP monthly premium for a household.
 */
export function sbeSlcspMonthlyFor({ state, zip, planYear = 2026, age, householdAges, householdComposition } = {}) {
  const memberAges = resolveMemberAges({ age, householdAges, householdComposition });
  if (!memberAges.length) {
    throw new Error("sbeSlcspMonthlyFor requires `age`, `householdAges`, or `householdComposition` with member ages.");
  }
  const { counted, medicareExcludedMemberCount } = splitMarketplaceMembers(memberAges);

  const rates = SBE_RATING_AREA_SLCSP_2026[state];
  if (!rates) {
    // Unreachable in practice: SBE_COVERED_STATES and SBE_RATING_AREA_SLCSP_2026
    // are kept in parity by a test. Fail loud rather than silently impersonate
    // another state's premiums (the old `|| ...CA` fallback charged everyone in
    // an unconfigured state California rates).
    throw new Error(`sbeSlcspMonthlyFor: no bundled SBE rate table for state "${state}".`);
  }

  const geo = resolveZip(zip);
  const zip3 = geo.zip3 || (zip ? String(zip).trim().slice(0, 3) : null);

  // A genuine rating-area resolution only happens when the ZIP3 maps to an area
  // code. Otherwise we used the state-level default and must say so (fallback
  // "state") instead of presenting it as a rating-area-accurate benchmark.
  const areaCode = zip3 ? (SBE_ZIP3_TO_RATING_AREA[state]?.[zip3] ?? null) : null;
  const resolvedRatingArea = areaCode != null;
  const referenceMonthlyPremium = resolvedRatingArea ? (rates[areaCode] ?? rates.default) : rates.default;

  // NY & VT ban age rating on individual plans (pure community rating): adults
  // all pay the flat reference regardless of age, but children still fall in the
  // under-21 band, so they are NOT charged the full adult rate.
  const isCommunityRated = state === "NY" || state === "VT";

  // Age-21 adult base premium, matching what the federal and state-fallback
  // paths in acaRatingArea.mjs return as `referenceMonthlyPremium`, so the field
  // has consistent semantics across modules. The bundled SBE figures are quoted
  // at the age-40 reference; community-rated figures are flat (= the age-21 rate).
  const factor40 = acaAgeRatingFactor(REFERENCE_AGE);
  const base21 = isCommunityRated
    ? referenceMonthlyPremium
    : (factor40 > 0 ? referenceMonthlyPremium / factor40 : referenceMonthlyPremium);

  let monthlyPremium = 0;
  let factorTotal = 0;
  for (const memberAge of counted) {
    const factor = isCommunityRated && memberAge >= 21
      ? 1
      : acaAgeRatingFactor(clampRatingAge(memberAge));
    monthlyPremium += base21 * factor;
    factorTotal += factor;
  }

  return Object.freeze({
    monthlyPremium: round2(monthlyPremium),
    ratingArea: Object.freeze({
      state,
      areaCode,
      methodology: resolvedRatingArea ? "zip3" : "state-benchmark",
      source: "SBE Rating Area Mapping"
    }),
    ageRatingFactorTotal: round6(factorTotal),
    medicareExcludedMemberCount,
    fallback: resolvedRatingArea ? null : "state",
    fallbackReason: resolvedRatingArea ? null : "sbe-state-default",
    benchmarkLevel: resolvedRatingArea ? "rating-area" : "state",
    planYear,
    slcspPlanId: `SBE-${state}-RA${areaCode ?? "DF"}`,
    referenceMonthlyPremium: round2(base21),
    countyFips: null,
    sources: Object.freeze({
      ratingArea: "SBE Rating Area Mapping",
      slcsp: "SBE Public Rate Bulletins",
      zipToCounty: "USPS Publication L007"
    })
  });
}

// ─── internal helpers ────────────────────────────────────────────────────────

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

// Medicare-eligible (65+) members are excluded from the marketplace premium;
// the count is surfaced so callers can explain the exclusion.
function splitMarketplaceMembers(memberAges) {
  const marketplaceAges = memberAges.filter((memberAge) => memberAge < MEDICARE_ELIGIBILITY_AGE);
  return {
    counted: countedMembers(marketplaceAges),
    medicareExcludedMemberCount: memberAges.length - marketplaceAges.length
  };
}

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
