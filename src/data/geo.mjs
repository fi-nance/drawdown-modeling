// Offline geographic resolver: ZIP code → state → exchange type and Medicaid
// expansion status.
//
// Why this exists
// ───────────────
// `docs/GOAL.md` makes "ZIP code is the only geographic input required for the
// common case" a Design-lens requirement. Today the user picks a state, and the
// CMS Marketplace API helper in `src/data/marketplaceApi.mjs` derives county
// FIPS and rating area from a ZIP via a network call. This module is the
// offline path: it lets the app know the state, exchange type, and Medicaid
// expansion status from a ZIP alone, without any network dependency, so the
// healthcare-bridge surface can start producing useful estimates the moment
// a household types their ZIP.
//
// What this module does NOT do
// ────────────────────────────
// - It does not by itself resolve county FIPS or CMS rating area from a ZIP.
//   That layer now lives in `acaRatingArea.mjs`, which bundles Census ZIP→county
//   and CMS rating-area/SLCSP data for the federal-platform states. This module
//   stays smaller: ZIP→state, exchange type, and Medicaid expansion status.
// - It does not handle U.S. territories (PR, USVI, GU, MP, AS). The federal
//   ACA marketplace does not cover territories the same way; territory plans
//   are out of model. ZIPs that resolve to territories return `state: null`
//   with `fallback: "territory"`.
// - It does not handle APO/FPO/DPO military ZIPs. They return `state: null`
//   with `fallback: "military"`.
//
// Sources
// ───────
// State assignments for ZIP3 prefixes come from USPS Publication L007 (state
// abbreviations and ZIP code prefixes), cross-checked against the SmartyStreets
// public ZIP3 → state list and the IRS Pub 17 state filing addresses table for
// edge cases. Exchange type and Medicaid expansion data carry their own
// sources on each entry.

export const GEO_DATA_VERSION = "2026.1";

// Declared up here so module-level initializers (GEO_DATA_SOURCES,
// STATE_EXCHANGE_TYPE_2026) can reference them without TDZ issues — same
// hoisting discipline as `ASSET_COLUMN_META` in `src/app.mjs`.
const ZIP_TO_STATE_SOURCE = "USPS Publication L007 (State Abbreviations, Military Codes, and ZIP Code Prefixes)";
const ZIP_TO_STATE_SOURCE_URL = "https://pe.usps.com/text/pub28/welcome.htm";

// ─── State abbreviations ────────────────────────────────────────────────────

// Two-letter postal abbreviations for the 50 states + DC. Matches the state
// names used in `src/data/taxData.mjs` so downstream code can interoperate.
export const STATE_ABBREVIATIONS = Object.freeze({
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  "District of Columbia": "DC",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY"
});

// ─── ACA Marketplace exchange type ──────────────────────────────────────────

// Three exchange-type values, mapped from the CMS plan-year-2026 listing:
//   "healthCareGov"        — Federally-Facilitated Marketplace; the CMS
//                            Marketplace API helper in `marketplaceApi.mjs`
//                            works for these states.
//   "stateBasedFederal"    — State-Based Marketplace using the federal
//                            platform (SBM-FP). HealthCare.gov enrollment
//                            still works, so the CMS API helper is usable,
//                            but state-specific rules may apply for
//                            outreach, navigators, and special enrollment.
//   "stateBased"           — State-Based Marketplace with its own portal.
//                            The CMS API helper does NOT cover these states;
//                            the user picks a plan on the state portal and
//                            enters exact-plan data manually (the
//                            Massachusetts ConnectorCare helper is an
//                            example for one such state).
export const STATE_EXCHANGE_TYPE_2026 = Object.freeze({
  year: 2026,
  source: "CMS State Marketplace Profiles for plan year 2026",
  sourceUrl: "https://www.cms.gov/marketplace/about/state-marketplace-profiles",
  states: Object.freeze({
    Alabama: { type: "healthCareGov" },
    Alaska: { type: "healthCareGov" },
    Arizona: { type: "healthCareGov" },
    Arkansas: { type: "stateBasedFederal" },
    California: { type: "stateBased", portal: "Covered California" },
    Colorado: { type: "stateBased", portal: "Connect for Health Colorado" },
    Connecticut: { type: "stateBased", portal: "Access Health CT" },
    Delaware: { type: "healthCareGov" },
    "District of Columbia": { type: "stateBased", portal: "DC Health Link" },
    Florida: { type: "healthCareGov" },
    Georgia: { type: "stateBased", portal: "Georgia Access" },
    Hawaii: { type: "healthCareGov" },
    Idaho: { type: "stateBased", portal: "Your Health Idaho" },
    Illinois: { type: "stateBasedFederal" },
    Indiana: { type: "healthCareGov" },
    Iowa: { type: "healthCareGov" },
    Kansas: { type: "healthCareGov" },
    Kentucky: { type: "stateBased", portal: "kynect" },
    Louisiana: { type: "healthCareGov" },
    Maine: { type: "stateBased", portal: "CoverME.gov" },
    Maryland: { type: "stateBased", portal: "Maryland Health Connection" },
    Massachusetts: { type: "stateBased", portal: "Massachusetts Health Connector" },
    Michigan: { type: "healthCareGov" },
    Minnesota: { type: "stateBased", portal: "MNsure" },
    Mississippi: { type: "healthCareGov" },
    Missouri: { type: "healthCareGov" },
    Montana: { type: "healthCareGov" },
    Nebraska: { type: "healthCareGov" },
    Nevada: { type: "stateBased", portal: "Nevada Health Link" },
    "New Hampshire": { type: "healthCareGov" },
    "New Jersey": { type: "stateBased", portal: "Get Covered New Jersey" },
    "New Mexico": { type: "stateBased", portal: "beWellnm" },
    "New York": { type: "stateBased", portal: "NY State of Health" },
    "North Carolina": { type: "healthCareGov" },
    "North Dakota": { type: "healthCareGov" },
    Ohio: { type: "healthCareGov" },
    Oklahoma: { type: "healthCareGov" },
    Oregon: { type: "stateBasedFederal" },
    Pennsylvania: { type: "stateBased", portal: "Pennie" },
    "Rhode Island": { type: "stateBased", portal: "HealthSource RI" },
    "South Carolina": { type: "healthCareGov" },
    "South Dakota": { type: "healthCareGov" },
    Tennessee: { type: "healthCareGov" },
    Texas: { type: "healthCareGov" },
    Utah: { type: "healthCareGov" },
    Vermont: { type: "stateBased", portal: "Vermont Health Connect" },
    Virginia: { type: "stateBased", portal: "Virginia's Insurance Marketplace" },
    Washington: { type: "stateBased", portal: "Washington Healthplanfinder" },
    "West Virginia": { type: "healthCareGov" },
    Wisconsin: { type: "healthCareGov" },
    Wyoming: { type: "healthCareGov" }
  })
});

// ─── Medicaid expansion status ──────────────────────────────────────────────

// Adoption of ACA Medicaid expansion under §1902(a)(10)(A)(i)(VIII) of the
// Social Security Act. Affects the "coverage gap" — in non-expansion states,
// adults with income below 100% FPL who would otherwise qualify for Medicaid
// in an expansion state fall through to neither Medicaid nor a PTC.
//
//   `expanded: true`   — Adopted; adults up to 138% FPL generally eligible
//                        for Medicaid.
//   `expanded: false`  — Not adopted; coverage gap exists between Medicaid
//                        eligibility ceiling and 100% FPL PTC floor.
//   `expanded: "partial"` — State runs a §1115 demonstration waiver with
//                        partial expansion; downstream logic should flag
//                        this for review rather than treating as a
//                        clean boolean.
export const STATE_MEDICAID_EXPANSION_2026 = Object.freeze({
  source: "KFF Status of State Medicaid Expansion Decisions",
  sourceUrl: "https://www.kff.org/medicaid/issue-brief/status-of-state-medicaid-expansion-decisions-interactive-map/",
  notes:
    "North Carolina implemented expansion December 2023. South Dakota " +
    "implemented expansion July 2023. Wisconsin has not adopted expansion " +
    "but uses a §1115 waiver to cover adults up to 100% FPL without the " +
    "enhanced federal match, leaving the same coverage-gap behavior at the " +
    "100% boundary as a non-expansion state.",
  states: Object.freeze({
    Alabama: { expanded: false },
    Alaska: { expanded: true, effectiveYear: 2015 },
    Arizona: { expanded: true, effectiveYear: 2014 },
    Arkansas: { expanded: true, effectiveYear: 2014 },
    California: { expanded: true, effectiveYear: 2014 },
    Colorado: { expanded: true, effectiveYear: 2014 },
    Connecticut: { expanded: true, effectiveYear: 2014 },
    Delaware: { expanded: true, effectiveYear: 2014 },
    "District of Columbia": { expanded: true, effectiveYear: 2014 },
    Florida: { expanded: false },
    Georgia: { expanded: "partial", note: "Georgia Pathways limited expansion via §1115 waiver" },
    Hawaii: { expanded: true, effectiveYear: 2014 },
    Idaho: { expanded: true, effectiveYear: 2020 },
    Illinois: { expanded: true, effectiveYear: 2014 },
    Indiana: { expanded: true, effectiveYear: 2015 },
    Iowa: { expanded: true, effectiveYear: 2014 },
    Kansas: { expanded: false },
    Kentucky: { expanded: true, effectiveYear: 2014 },
    Louisiana: { expanded: true, effectiveYear: 2016 },
    Maine: { expanded: true, effectiveYear: 2019 },
    Maryland: { expanded: true, effectiveYear: 2014 },
    Massachusetts: { expanded: true, effectiveYear: 2014 },
    Michigan: { expanded: true, effectiveYear: 2014 },
    Minnesota: { expanded: true, effectiveYear: 2014 },
    Mississippi: { expanded: false },
    Missouri: { expanded: true, effectiveYear: 2021 },
    Montana: { expanded: true, effectiveYear: 2016 },
    Nebraska: { expanded: true, effectiveYear: 2020 },
    Nevada: { expanded: true, effectiveYear: 2014 },
    "New Hampshire": { expanded: true, effectiveYear: 2014 },
    "New Jersey": { expanded: true, effectiveYear: 2014 },
    "New Mexico": { expanded: true, effectiveYear: 2014 },
    "New York": { expanded: true, effectiveYear: 2014 },
    "North Carolina": { expanded: true, effectiveYear: 2023 },
    "North Dakota": { expanded: true, effectiveYear: 2014 },
    Ohio: { expanded: true, effectiveYear: 2014 },
    Oklahoma: { expanded: true, effectiveYear: 2021 },
    Oregon: { expanded: true, effectiveYear: 2014 },
    Pennsylvania: { expanded: true, effectiveYear: 2015 },
    "Rhode Island": { expanded: true, effectiveYear: 2014 },
    "South Carolina": { expanded: false },
    "South Dakota": { expanded: true, effectiveYear: 2023 },
    Tennessee: { expanded: false },
    Texas: { expanded: false },
    Utah: { expanded: true, effectiveYear: 2020 },
    Vermont: { expanded: true, effectiveYear: 2014 },
    Virginia: { expanded: true, effectiveYear: 2019 },
    Washington: { expanded: true, effectiveYear: 2014 },
    "West Virginia": { expanded: true, effectiveYear: 2014 },
    Wisconsin: { expanded: false, note: "§1115 waiver covers adults to 100% FPL but coverage-gap risk persists at PTC boundary" },
    Wyoming: { expanded: false }
  })
});

// ─── ZIP3 → state range table ───────────────────────────────────────────────

// ZIP3 prefix ranges per state, derived from USPS Publication L007. Ranges
// are inclusive at both ends, expressed as 3-character strings to preserve
// leading zeros ("005" not 5). The table is intentionally exhaustive of the
// 50 states + DC; territories (PR, USVI, GU, MP, AS) and APO/FPO military
// ZIPs are handled by `resolveZip` as fallbacks because they are out of
// model for ACA marketplace plans.
//
// A few ZIP3s are non-contiguous within a state, so a state can appear in
// multiple ranges. Lookup is O(n) over ~80 ranges; for browser use that is
// inconsequential. If profiling ever shows it matters, replace with binary
// search on a sorted-by-low array.
const ZIP3_RANGES = Object.freeze([
  // Northeast
  { low: "005", high: "005", state: "New York" }, // Pfizer/Holtsville
  { low: "010", high: "027", state: "Massachusetts" },
  { low: "028", high: "029", state: "Rhode Island" },
  { low: "030", high: "038", state: "New Hampshire" },
  { low: "039", high: "049", state: "Maine" },
  { low: "050", high: "059", state: "Vermont" },
  { low: "060", high: "069", state: "Connecticut" },
  { low: "070", high: "089", state: "New Jersey" },
  // 090-098: APO/FPO Europe — handled as military fallback
  { low: "100", high: "149", state: "New York" },
  { low: "150", high: "196", state: "Pennsylvania" },
  { low: "197", high: "199", state: "Delaware" },

  // Mid-Atlantic and Southeast
  { low: "200", high: "200", state: "District of Columbia" },
  { low: "202", high: "205", state: "District of Columbia" },
  { low: "201", high: "201", state: "Virginia" }, // DC-suburb VA carve-out
  { low: "206", high: "219", state: "Maryland" },
  { low: "220", high: "246", state: "Virginia" },
  { low: "247", high: "268", state: "West Virginia" },
  { low: "269", high: "289", state: "North Carolina" },
  { low: "270", high: "289", state: "North Carolina" }, // explicit guard
  { low: "290", high: "299", state: "South Carolina" },
  { low: "300", high: "319", state: "Georgia" },
  // 320-349 Florida (with 340 APO/FPO Miami military carve-out)
  { low: "320", high: "339", state: "Florida" },
  { low: "341", high: "349", state: "Florida" },
  { low: "350", high: "369", state: "Alabama" },
  { low: "370", high: "385", state: "Tennessee" },
  { low: "386", high: "397", state: "Mississippi" },
  { low: "398", high: "399", state: "Georgia" },

  // Great Lakes / Ohio Valley
  { low: "400", high: "427", state: "Kentucky" },
  { low: "430", high: "459", state: "Ohio" },
  { low: "460", high: "479", state: "Indiana" },
  { low: "480", high: "499", state: "Michigan" },

  // Upper Midwest and Plains
  { low: "500", high: "528", state: "Iowa" },
  { low: "530", high: "549", state: "Wisconsin" },
  { low: "550", high: "567", state: "Minnesota" },
  { low: "570", high: "577", state: "South Dakota" },
  { low: "580", high: "588", state: "North Dakota" },
  { low: "590", high: "599", state: "Montana" },
  { low: "600", high: "629", state: "Illinois" },
  { low: "630", high: "658", state: "Missouri" },
  { low: "660", high: "679", state: "Kansas" },
  { low: "680", high: "693", state: "Nebraska" },

  // South Central
  { low: "700", high: "714", state: "Louisiana" },
  { low: "716", high: "729", state: "Arkansas" },
  { low: "730", high: "732", state: "Oklahoma" },
  { low: "733", high: "733", state: "Texas" }, // Lubbock/El Paso edge
  { low: "734", high: "749", state: "Oklahoma" },
  { low: "750", high: "799", state: "Texas" },
  { low: "885", high: "885", state: "Texas" }, // El Paso outlier

  // Mountain
  { low: "800", high: "816", state: "Colorado" },
  { low: "820", high: "831", state: "Wyoming" },
  { low: "832", high: "838", state: "Idaho" },
  { low: "840", high: "847", state: "Utah" },
  { low: "850", high: "865", state: "Arizona" },
  { low: "870", high: "884", state: "New Mexico" },
  { low: "889", high: "898", state: "Nevada" },

  // Pacific
  { low: "900", high: "961", state: "California" },
  // 962-966 APO/FPO Pacific — military fallback
  { low: "967", high: "968", state: "Hawaii" },
  // 969 territories (Guam, Northern Marianas) — territory fallback
  { low: "970", high: "979", state: "Oregon" },
  { low: "980", high: "994", state: "Washington" },
  { low: "995", high: "999", state: "Alaska" }
]);

// ZIP3 prefixes used by APO/FPO/DPO military mail.
const MILITARY_ZIP3 = Object.freeze(new Set([
  "090", "091", "092", "093", "094", "095", "096", "097", "098", "099",
  "340",
  "962", "963", "964", "965", "966"
]));

// ZIP3 prefixes used by U.S. territories that are out of model for ACA
// marketplace plans (PR, USVI, GU, MP, AS).
const TERRITORY_ZIP3 = Object.freeze(new Set([
  "006", "007", "008", "009", // Puerto Rico (008 also USVI overlap)
  "969"                         // Guam, Northern Marianas
]));

// ─── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolve a U.S. ZIP code to its state, ACA exchange type, and Medicaid
 * expansion status.
 *
 * Accepts ZIP as a 5-digit string ("02139"), a number (2139, which is
 * normalized back to a leading-zero 5-char string), or a 3-digit prefix.
 *
 * Returns:
 *   {
 *     zip: "02139",            // normalized 5-char ZIP (or null if input was a prefix)
 *     zip3: "021",             // 3-char ZIP prefix used for lookup
 *     state: "Massachusetts",  // full state name, or null when out of model
 *     stateAbbreviation: "MA", // two-letter code, or null
 *     exchange: { type, portal, source }  // null if state is null
 *     medicaid: { expanded, effectiveYear, note, source }  // null if state is null
 *     fallback: null | "military" | "territory" | "unknown",
 *     sources: { exchange, medicaid }
 *   }
 *
 * Never throws. Unknown ZIPs return `state: null, fallback: "unknown"` so
 * downstream code can prompt the household to enter state manually.
 */
export function resolveZip(zipInput) {
  const zip3 = zipPrefixOf(zipInput);
  const normalizedZip = typeof zipInput === "string"
    ? zip5Of(zipInput)
    : (Number.isFinite(zipInput) ? String(Math.trunc(zipInput)).padStart(5, "0").slice(0, 5) : null);

  if (!zip3) {
    return emptyResolution({ zip: normalizedZip, fallback: "unknown" });
  }

  if (MILITARY_ZIP3.has(zip3)) {
    return emptyResolution({ zip: normalizedZip, zip3, fallback: "military" });
  }
  if (TERRITORY_ZIP3.has(zip3)) {
    return emptyResolution({ zip: normalizedZip, zip3, fallback: "territory" });
  }

  const state = stateForZip3(zip3);
  if (!state) {
    return emptyResolution({ zip: normalizedZip, zip3, fallback: "unknown" });
  }

  const exchange = STATE_EXCHANGE_TYPE_2026.states[state] ?? null;
  const medicaid = STATE_MEDICAID_EXPANSION_2026.states[state] ?? null;

  return Object.freeze({
    zip: normalizedZip,
    zip3,
    state,
    stateAbbreviation: STATE_ABBREVIATIONS[state] ?? null,
    exchange: exchange ? Object.freeze({ ...exchange, source: STATE_EXCHANGE_TYPE_2026.source }) : null,
    medicaid: medicaid ? Object.freeze({ ...medicaid, source: STATE_MEDICAID_EXPANSION_2026.source }) : null,
    fallback: null,
    sources: Object.freeze({
      zipToState: ZIP_TO_STATE_SOURCE,
      exchange: STATE_EXCHANGE_TYPE_2026.source,
      medicaid: STATE_MEDICAID_EXPANSION_2026.source
    })
  });
}

function emptyResolution({ zip = null, zip3 = null, fallback }) {
  return Object.freeze({
    zip,
    zip3,
    state: null,
    stateAbbreviation: null,
    exchange: null,
    medicaid: null,
    fallback,
    sources: Object.freeze({
      zipToState: ZIP_TO_STATE_SOURCE
    })
  });
}

// Full 5-digit ZIP from a string input, accepting the same forms as
// zipPrefixOf ("02139", "02139-1234", surrounding whitespace). A bare 3-digit
// prefix has no ZIP5 and returns null. Keeping the two normalizers aligned
// matters downstream: ZIP5-keyed lookups (county FIPS, ZIP-level SLCSP
// overrides) must not silently degrade to the state fallback for a ZIP+4
// input that zipPrefixOf happily resolved to a state.
function zip5Of(zipInput) {
  const trimmed = String(zipInput).trim();
  if (/^\d{5}$/.test(trimmed)) return trimmed;
  const plus4 = trimmed.match(/^(\d{5})-\d{4}$/);
  return plus4 ? plus4[1] : null;
}

function zipPrefixOf(zipInput) {
  if (zipInput == null) return null;
  if (typeof zipInput === "number") {
    if (!Number.isFinite(zipInput)) return null;
    return String(Math.trunc(zipInput)).padStart(5, "0").slice(0, 3);
  }
  const trimmed = String(zipInput).trim();
  if (/^\d{3}$/.test(trimmed)) return trimmed;
  if (/^\d{5}$/.test(trimmed)) return trimmed.slice(0, 3);
  // Allow ZIP+4 forms like "02139-1234".
  const plus4 = trimmed.match(/^(\d{5})-\d{4}$/);
  if (plus4) return plus4[1].slice(0, 3);
  return null;
}

function stateForZip3(zip3) {
  for (const range of ZIP3_RANGES) {
    if (zip3 >= range.low && zip3 <= range.high) {
      return range.state;
    }
  }
  return null;
}

// ─── Source manifest for the data-sources coverage test ─────────────────────

export const GEO_DATA_SOURCES = Object.freeze([
  {
    name: ZIP_TO_STATE_SOURCE,
    url: ZIP_TO_STATE_SOURCE_URL
  },
  {
    name: STATE_EXCHANGE_TYPE_2026.source,
    url: STATE_EXCHANGE_TYPE_2026.sourceUrl
  },
  {
    name: STATE_MEDICAID_EXPANSION_2026.source,
    url: STATE_MEDICAID_EXPANSION_2026.sourceUrl
  }
]);
