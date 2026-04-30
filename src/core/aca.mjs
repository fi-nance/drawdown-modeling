import { clamp, round } from "./utils.mjs";
import { buildAcaConfig } from "../data/taxData.mjs";

export const DEFAULT_ACA_CONFIG = buildAcaConfig();

export const FEDERAL_DEFAULT_ACA_AGE_RATING_CURVE = Object.freeze([
  { minAge: 0, maxAge: 14, factor: 0.765 },
  { minAge: 15, maxAge: 15, factor: 0.833 },
  { minAge: 16, maxAge: 16, factor: 0.859 },
  { minAge: 17, maxAge: 17, factor: 0.885 },
  { minAge: 18, maxAge: 18, factor: 0.913 },
  { minAge: 19, maxAge: 19, factor: 0.941 },
  { minAge: 20, maxAge: 20, factor: 0.970 },
  { minAge: 21, maxAge: 21, factor: 1.000 },
  { minAge: 22, maxAge: 22, factor: 1.000 },
  { minAge: 23, maxAge: 23, factor: 1.000 },
  { minAge: 24, maxAge: 24, factor: 1.000 },
  { minAge: 25, maxAge: 25, factor: 1.004 },
  { minAge: 26, maxAge: 26, factor: 1.024 },
  { minAge: 27, maxAge: 27, factor: 1.048 },
  { minAge: 28, maxAge: 28, factor: 1.087 },
  { minAge: 29, maxAge: 29, factor: 1.119 },
  { minAge: 30, maxAge: 30, factor: 1.135 },
  { minAge: 31, maxAge: 31, factor: 1.159 },
  { minAge: 32, maxAge: 32, factor: 1.183 },
  { minAge: 33, maxAge: 33, factor: 1.198 },
  { minAge: 34, maxAge: 34, factor: 1.214 },
  { minAge: 35, maxAge: 35, factor: 1.222 },
  { minAge: 36, maxAge: 36, factor: 1.230 },
  { minAge: 37, maxAge: 37, factor: 1.238 },
  { minAge: 38, maxAge: 38, factor: 1.246 },
  { minAge: 39, maxAge: 39, factor: 1.262 },
  { minAge: 40, maxAge: 40, factor: 1.278 },
  { minAge: 41, maxAge: 41, factor: 1.302 },
  { minAge: 42, maxAge: 42, factor: 1.325 },
  { minAge: 43, maxAge: 43, factor: 1.357 },
  { minAge: 44, maxAge: 44, factor: 1.397 },
  { minAge: 45, maxAge: 45, factor: 1.444 },
  { minAge: 46, maxAge: 46, factor: 1.500 },
  { minAge: 47, maxAge: 47, factor: 1.563 },
  { minAge: 48, maxAge: 48, factor: 1.635 },
  { minAge: 49, maxAge: 49, factor: 1.706 },
  { minAge: 50, maxAge: 50, factor: 1.786 },
  { minAge: 51, maxAge: 51, factor: 1.865 },
  { minAge: 52, maxAge: 52, factor: 1.952 },
  { minAge: 53, maxAge: 53, factor: 2.040 },
  { minAge: 54, maxAge: 54, factor: 2.135 },
  { minAge: 55, maxAge: 55, factor: 2.230 },
  { minAge: 56, maxAge: 56, factor: 2.333 },
  { minAge: 57, maxAge: 57, factor: 2.437 },
  { minAge: 58, maxAge: 58, factor: 2.548 },
  { minAge: 59, maxAge: 59, factor: 2.603 },
  { minAge: 60, maxAge: 60, factor: 2.714 },
  { minAge: 61, maxAge: 61, factor: 2.810 },
  { minAge: 62, maxAge: 62, factor: 2.873 },
  { minAge: 63, maxAge: 63, factor: 2.952 },
  { minAge: 64, maxAge: Infinity, factor: 3.000 }
]);

export function computeAca({ magi = 0, config = DEFAULT_ACA_CONFIG } = {}) {
  if (!config?.enabled) {
    return {
      fplPercent: 0,
      contributionRate: 0,
      expectedContribution: 0,
      grossPremium: 0,
      subsidy: 0,
      netPremium: 0,
      eligible: false
    };
  }

  const fpl = config.fpl ?? DEFAULT_ACA_CONFIG.fpl;
  const grossPremium = config.benchmarkPremium ?? 0;
  const fplPercent = fpl > 0 ? (Math.max(0, magi) / fpl) * 100 : Infinity;
  const eligible = fplPercent <= (config.maxEligibleFplPercent ?? 400);
  const contributionRate = eligible
    ? contributionRateForFplPercent(
      fplPercent,
      config.applicablePercentageTable ?? DEFAULT_ACA_CONFIG.applicablePercentageTable
    )
    : config.requiredContributionPercentage ?? DEFAULT_ACA_CONFIG.requiredContributionPercentage;
  const expectedContribution = Math.max(0, magi) * contributionRate;
  const subsidy = eligible ? clamp(grossPremium - expectedContribution, 0, grossPremium) : 0;

  return {
    fplPercent: round(fplPercent, 4),
    contributionRate: round(contributionRate, 6),
    expectedContribution: round(expectedContribution, 6),
    grossPremium: round(grossPremium, 6),
    subsidy: round(subsidy, 6),
    netPremium: round(grossPremium - subsidy, 6),
    eligible
  };
}

export function contributionRateForFplPercent(fplPercent, table) {
  if (!table?.length) return 0;

  for (const row of table) {
    const lower = row.minFplPercent ?? 0;
    const upper = row.maxFplPercent ?? Infinity;
    if (fplPercent < lower || fplPercent > upper) continue;
    if (!Number.isFinite(upper) || upper <= lower) return row.finalRate ?? row.initialRate ?? 0;
    const position = clamp((fplPercent - lower) / (upper - lower), 0, 1);
    return (row.initialRate ?? 0) + ((row.finalRate ?? row.initialRate ?? 0) - (row.initialRate ?? 0)) * position;
  }

  return table.at(-1).finalRate ?? table.at(-1).initialRate ?? 0;
}

export function acaAgeRatingFactor(age, curve = FEDERAL_DEFAULT_ACA_AGE_RATING_CURVE) {
  const numericAge = Number(age);
  if (!Number.isFinite(numericAge)) return 1;
  const wholeAge = Math.trunc(Math.max(0, numericAge));
  return curve.find((row) => wholeAge >= row.minAge && wholeAge <= row.maxAge)?.factor ?? 1;
}

export function ageAdjustedBenchmarkPremium(config = DEFAULT_ACA_CONFIG, ageContext = {}) {
  const benchmarkPremium = Math.max(0, config.benchmarkPremium ?? 0);
  if (!config.ageRatedBenchmarkPremium) return round(benchmarkPremium, 6);

  const context = typeof ageContext === "number" ? { age: ageContext } : ageContext ?? {};
  const members = Math.max(1, Math.trunc(Number(config.marketplaceMembers) || Number(config.householdSize) || 1));
  const yearIndex = Math.max(0, Math.trunc(Number(context.yearIndex) || 0));
  const currentFallbackAge = finiteAge(context.age)
    ?? finiteAge(config.currentAge)
    ?? finiteAge(config.benchmarkPremiumReferenceAge);
  const referenceFallbackAge = finiteAge(config.benchmarkPremiumReferenceAge) ?? currentFallbackAge;

  if (currentFallbackAge == null || referenceFallbackAge == null) return round(benchmarkPremium, 6);

  const currentRatingTotal = householdAgeRatingTotal({
    ages: config.memberAges,
    fallbackAge: currentFallbackAge,
    members,
    ageOffset: Array.isArray(config.memberAges) ? yearIndex : 0
  });
  const referenceRatingTotal = householdAgeRatingTotal({
    ages: config.benchmarkPremiumReferenceAges,
    fallbackAge: referenceFallbackAge,
    members,
    ageOffset: 0
  });

  if (referenceRatingTotal <= 0) return round(benchmarkPremium, 6);
  return round(benchmarkPremium * (currentRatingTotal / referenceRatingTotal), 6);
}

export function inflateAcaConfig(config = DEFAULT_ACA_CONFIG, inflationIndex = 1, ageContext = {}) {
  return {
    ...config,
    fpl: round((config.fpl ?? 0) * Math.max(0, inflationIndex), 6),
    benchmarkPremium: round(ageAdjustedBenchmarkPremium(config, ageContext) * Math.max(0, inflationIndex), 6)
  };
}

function householdAgeRatingTotal({ ages, fallbackAge, members, ageOffset }) {
  return Array.from({ length: members }, (_, index) => {
    const age = finiteAge(ages?.[index]) ?? fallbackAge;
    return acaAgeRatingFactor(age + ageOffset);
  }).reduce((total, factor) => total + factor, 0);
}

function finiteAge(age) {
  const numericAge = Number(age);
  return Number.isFinite(numericAge) ? Math.max(0, numericAge) : null;
}
