// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: rmd. No behavior changes — pure code movement.

import { round } from "../utils.mjs";
import { DEFAULT_SCENARIO } from "./scenario.mjs";

const UNIFORM_LIFETIME_RMD_FACTORS = Object.freeze({
  72: 27.4,
  73: 26.5,
  74: 25.5,
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22.0,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16.0,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
  93: 10.1,
  94: 9.5,
  95: 8.9,
  96: 8.4,
  97: 7.8,
  98: 7.3,
  99: 6.8,
  100: 6.4,
  101: 6.0,
  102: 5.6,
  103: 5.2,
  104: 4.9,
  105: 4.6,
  106: 4.3,
  107: 4.1,
  108: 3.9,
  109: 3.7,
  110: 3.5,
  111: 3.4,
  112: 3.3,
  113: 3.1,
  114: 3.0,
  115: 2.9,
  116: 2.8,
  117: 2.7,
  118: 2.5,
  119: 2.3,
  120: 2.0
});

export function requiredMinimumDistributionForYear({ scenario, age, beginningTraditionalValue }) {
  if (scenario.rmd?.enabled === false) {
    return { amount: 0, base: beginningTraditionalValue, factor: null, startAge: null };
  }
  const startAge = scenario.rmd?.startAge != null && Number.isFinite(Number(scenario.rmd.startAge))
    ? Number(scenario.rmd.startAge)
    : defaultRmdStartAge(scenario);
  if (age < startAge || beginningTraditionalValue <= 0) {
    return { amount: 0, base: beginningTraditionalValue, factor: null, startAge };
  }

  const factorAge = Math.max(72, Math.min(120, Math.trunc(age)));
  const factor = UNIFORM_LIFETIME_RMD_FACTORS[factorAge] ?? UNIFORM_LIFETIME_RMD_FACTORS[120];
  return {
    amount: round(beginningTraditionalValue / factor, 6),
    base: beginningTraditionalValue,
    factor,
    startAge
  };
}

export function defaultRmdStartAge(scenario) {
  const birthYear = (scenario.startYear ?? DEFAULT_SCENARIO.startYear) - (scenario.currentAge ?? DEFAULT_SCENARIO.currentAge);
  if (birthYear >= 1960) return 75;
  return 73;
}

export function defaultSpouseRmdStartAge(scenario) {
  const spouseAge = Number(scenario.spouseAge);
  if (!Number.isFinite(spouseAge)) return defaultRmdStartAge(scenario);
  const birthYear = (scenario.startYear ?? DEFAULT_SCENARIO.startYear) - spouseAge;
  if (birthYear >= 1960) return 75;
  return 73;
}

// Household RMD with per-owner traditional buckets. Spouse-owned traditional
// accounts (asset.owner === "spouse") use the SPOUSE's age, Uniform Lifetime
// factor, and SECURE 2.0 start age — applying the primary's clock to a
// younger/older spouse's IRA mistimes RMDs by years. When `spouseAge` is null
// (single filer, no spouse data, or survivor years where the household pools
// under the surviving holder), everything uses the primary bucket — which is
// also the exact pre-owner-dimension behavior for untagged portfolios.
// The IRS Joint Life and Last Survivor Table (spouse sole beneficiary >10
// years younger) is NOT modeled — see KNOWN_LIMITATIONS.
export function householdRmdForYear({ scenario, primaryAge, spouseAge = null, traditionalByOwner }) {
  const spouseValue = Math.max(0, Number(traditionalByOwner?.spouse) || 0);
  const primaryValue = Math.max(0, Number(traditionalByOwner?.primary) || 0);
  // Null/undefined spouse age (single filer, no spouse data, or survivor
  // years) pools everything under the primary clock — Number(null) coerces to
  // 0, so the nullish check must come first or a survivor year would treat
  // spouse-owned accounts as belonging to an age-0 owner and skip their RMDs.
  const pooledSpouse = spouseAge == null || !Number.isFinite(Number(spouseAge));

  const primary = requiredMinimumDistributionForYear({
    scenario,
    age: primaryAge,
    beginningTraditionalValue: pooledSpouse ? primaryValue + spouseValue : primaryValue
  });
  if (pooledSpouse || spouseValue <= 0) {
    return {
      amount: primary.amount,
      base: primary.base,
      factor: primary.factor,
      startAge: primary.startAge,
      byOwner: { primary, spouse: null }
    };
  }

  const spouseStartAge = scenario.rmd?.spouseStartAge != null && Number.isFinite(Number(scenario.rmd.spouseStartAge))
    ? Number(scenario.rmd.spouseStartAge)
    : defaultSpouseRmdStartAge(scenario);
  const spouse = requiredMinimumDistributionForYear({
    scenario: { ...scenario, rmd: { ...(scenario.rmd ?? {}), startAge: spouseStartAge } },
    age: spouseAge,
    beginningTraditionalValue: spouseValue
  });
  return {
    amount: round(primary.amount + spouse.amount, 6),
    base: round(primary.base + spouse.base, 6),
    factor: primary.factor,
    startAge: primary.startAge,
    byOwner: { primary, spouse }
  };
}
