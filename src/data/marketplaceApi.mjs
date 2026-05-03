export const MARKETPLACE_API_BASE_URL = "https://marketplace.api.healthcare.gov/api/v1";

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

export function marketplaceStateCode(state) {
  const value = String(state ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  return STATE_ABBREVIATIONS[value] ?? "";
}

export function buildMarketplacePlanSearchRequest({
  income,
  ages = [],
  state,
  zipcode,
  countyfips,
  year,
  usesTobacco = false,
  utilizationLevel = "Medium"
} = {}) {
  const people = ages
    .map((age) => Number(age))
    .filter((age) => Number.isFinite(age))
    .map((age) => ({
      age: Math.max(0, Math.trunc(age)),
      aptc_eligible: true,
      uses_tobacco: Boolean(usesTobacco),
      gender: "Female",
      utilization_level: utilizationLevel
    }));

  if (!people.length) throw new Error("Marketplace plan search requires at least one covered member age.");
  if (!String(zipcode ?? "").trim()) throw new Error("Marketplace plan search requires a ZIP code.");
  if (!String(countyfips ?? "").trim()) throw new Error("Marketplace plan search requires a county FIPS code.");

  return {
    household: {
      income: Math.max(0, Number(income) || 0),
      people
    },
    market: "Individual",
    place: {
      countyfips: String(countyfips).trim(),
      state: marketplaceStateCode(state),
      zipcode: String(zipcode).trim()
    },
    year: Math.trunc(Number(year) || new Date().getFullYear())
  };
}

export function normalizeMarketplacePlans(plans = [], { marketplaceMembers = 1 } = {}) {
  const sourcePlans = Array.isArray(plans)
    ? plans
    : Array.isArray(plans?.plans)
      ? plans.plans
      : Array.isArray(plans?.results)
        ? plans.results
        : [];
  const familyCoverage = Math.max(1, Math.trunc(Number(marketplaceMembers) || 1)) > 1;
  return sourcePlans
    .map((plan) => normalizeMarketplacePlan(plan, { familyCoverage }))
    .filter((plan) => Number.isFinite(plan.premium))
    .sort((a, b) => a.premium - b.premium || a.name.localeCompare(b.name));
}

export function normalizeMarketplacePlan(plan = {}, { familyCoverage = false } = {}) {
  return {
    id: plan.id ?? "",
    name: plan.name ?? "Marketplace plan",
    issuer: plan.issuer?.name ?? plan.issuer?.id ?? "",
    metalLevel: plan.metal_level ?? "",
    type: plan.type ?? "",
    premium: finiteNumber(plan.premium),
    premiumWithCredit: finiteNumber(plan.premium_w_credit),
    oopMaximum: marketplacePlanOopMaximum(plan, { familyCoverage }),
    benefitsUrl: plan.benefits_url ?? "",
    brochureUrl: plan.brochure_url ?? "",
    networkUrl: plan.network_url ?? "",
    formularyUrl: plan.formulary_url ?? "",
    hsaEligible: Boolean(plan.hsa_eligible),
    qualityRating: finiteNumber(plan.quality_rating?.global_rating)
  };
}

export function secondLowestSilverPremium(plans = []) {
  const silverPremiums = plans
    .filter((plan) => String(plan.metalLevel ?? plan.metal_level ?? "").toLowerCase() === "silver")
    .map((plan) => finiteNumber(plan.premium))
    .filter((premium) => Number.isFinite(premium))
    .sort((a, b) => a - b);
  return silverPremiums[1] ?? silverPremiums[0] ?? null;
}

export function marketplacePlanOopMaximum(plan = {}, { familyCoverage = false } = {}) {
  const moops = Array.isArray(plan.moops) ? plan.moops : [];
  const preferred = moops.find((moop) => moopMatchesCoverage(moop, familyCoverage) && moopLooksInNetwork(moop))
    ?? moops.find((moop) => moopMatchesCoverage(moop, familyCoverage))
    ?? moops.find((moop) => moopLooksInNetwork(moop))
    ?? moops[0];
  const value = firstFiniteNumber([
    familyCoverage ? preferred?.family_amount : preferred?.individual_amount,
    familyCoverage ? preferred?.family : preferred?.individual,
    familyCoverage ? preferred?.family_maximum : preferred?.individual_maximum,
    preferred?.amount,
    preferred?.in_network,
    preferred?.combined
  ]);
  return value ?? null;
}

export function normalizeMarketplaceCounties(payload = {}) {
  const counties = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.counties)
      ? payload.counties
      : Array.isArray(payload.results)
        ? payload.results
        : [];
  return counties
    .map((county) => ({
      fips: String(county.fips ?? county.countyfips ?? county.county_fips ?? county.countyFips ?? "").trim(),
      name: String(county.name ?? county.county ?? county.county_name ?? county.countyName ?? "").trim(),
      state: String(county.state ?? county.state_code ?? county.stateCode ?? "").trim()
    }))
    .filter((county) => county.fips);
}

export function marketplaceApiUrl(path, apiKey) {
  const normalizedPath = String(path ?? "").startsWith("/") ? String(path) : `/${path}`;
  const separator = normalizedPath.includes("?") ? "&" : "?";
  return `${MARKETPLACE_API_BASE_URL}${normalizedPath}${separator}apikey=${encodeURIComponent(apiKey ?? "")}`;
}

function moopMatchesCoverage(moop = {}, familyCoverage) {
  const text = Object.values(moop).join(" ").toLowerCase();
  return familyCoverage ? /family/.test(text) : /(individual|self|person)/.test(text);
}

function moopLooksInNetwork(moop = {}) {
  const text = Object.values(moop).join(" ").toLowerCase();
  return /in[-_\s]?network|in network|inn/.test(text) || !/out[-_\s]?of[-_\s]?network|out of network|oon/.test(text);
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const numeric = finiteNumber(value);
    if (numeric != null) return numeric;
  }
  return null;
}
