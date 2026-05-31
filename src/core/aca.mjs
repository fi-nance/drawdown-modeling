import { clamp, round } from "./utils.mjs";
import { buildAcaConfig } from "../data/taxData.mjs";
import { slcspMonthlyFor } from "../data/acaRatingArea.mjs";

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

export function computeAca({
  magi = 0,
  config = DEFAULT_ACA_CONFIG,
  zip = null,
  age = null,
  householdAges = null,
  planYear = null
} = {}) {
  if (!config?.enabled) {
    return {
      fplPercent: 0,
      contributionRate: 0,
      expectedContribution: 0,
      grossPremium: 0,
      subsidy: 0,
      netPremium: 0,
      householdSize: config?.householdSize ?? 0,
      marketplaceMembers: config?.marketplaceMembers ?? 0,
      eligible: false
    };
  }

  // Thin shim: when a ZIP is supplied, replace the state-level benchmark with
  // the offline rating-area-level SLCSP. When the ZIP cannot be resolved to a
  // rating area (territory/military, a not-yet-ingested state-based exchange, or
  // an underivable county), `slcspMonthlyFor` returns a state-level fallback (or
  // null), so this falls through to the existing state-level path.
  let zipBenchmark = null;
  const zipValue = zip ?? config.zip ?? null;
  if (zipValue != null) {
    zipBenchmark = benchmarkPremiumForZip({
      zip: zipValue,
      planYear: planYear ?? config.year ?? 2026,
      age: age ?? config.currentAge ?? null,
      householdAges: householdAges ?? config.currentMemberAges ?? config.memberAges ?? null
    });
    if (Number.isFinite(zipBenchmark.annualBenchmarkPremium)) {
      const premiumIndex = Number.isFinite(config.premiumInflationIndex)
        ? Math.max(0, Number(config.premiumInflationIndex))
        : 1;
      const annual = round(zipBenchmark.annualBenchmarkPremium * premiumIndex, 6);
      const inStateBenchmarkMode = config.planCostMode !== "selectedPlan";
      config = {
        ...config,
        benchmarkPremium: annual,
        ageRatedBenchmarkPremium: false,
        // In state-benchmark plan-cost mode the modeled plan tracks the
        // benchmark, so move the gross with it. In selected-plan mode the user
        // has an explicit gross premium; only the benchmark (subsidy sizing)
        // changes.
        ...(inStateBenchmarkMode
          ? { selectedPlanPremium: annual, planPremium: annual, ageRatedSelectedPlanPremium: false }
          : {})
      };
    }
  }

  const fpl = config.fpl ?? DEFAULT_ACA_CONFIG.fpl;
  const fplPercent = fpl > 0 ? (Math.max(0, magi) / fpl) * 100 : Infinity;
  const activePlan = activeAcaPlan(config, fplPercent);
  const premiumInputMode = activePlan.premiumInputMode === "net" ? "net" : "gross";
  const benchmarkPremium = Math.max(0, activePlan.benchmarkPremium ?? 0);
  const grossPremium = Math.max(0, activePlan.selectedPlanPremium ?? activePlan.planPremium ?? benchmarkPremium);
  // Per IRC §36B, citizens generally must be at or above 100% FPL to qualify
  // for PTC (those below typically fall to Medicaid). Allow override via
  // `minEligibleFplPercent` for users modeling lawfully-present-non-citizen
  // exceptions or other special cases.
  const minEligibleFplPercent = Number.isFinite(config.minEligibleFplPercent)
    ? config.minEligibleFplPercent
    : 100;
  const maxEligibleFplPercent = config.maxEligibleFplPercent ?? 400;
  const eligible = fplPercent >= minEligibleFplPercent && fplPercent <= maxEligibleFplPercent;
  const contributionRate = eligible
    ? contributionRateForFplPercent(
      fplPercent,
      config.applicablePercentageTable ?? DEFAULT_ACA_CONFIG.applicablePercentageTable
    )
    : config.requiredContributionPercentage ?? DEFAULT_ACA_CONFIG.requiredContributionPercentage;
  const expectedContribution = premiumInputMode === "net" ? 0 : Math.max(0, magi) * contributionRate;
  const maxPremiumTaxCredit = eligible ? clamp(benchmarkPremium - expectedContribution, 0, benchmarkPremium) : 0;
  const subsidy = premiumInputMode === "net" ? 0 : clamp(maxPremiumTaxCredit, 0, grossPremium);

  return {
    premiumInputMode,
    fplPercent: round(fplPercent, 4),
    contributionRate: round(contributionRate, 6),
    expectedContribution: round(expectedContribution, 6),
    benchmarkPremium: round(benchmarkPremium, 6),
    grossPremium: round(grossPremium, 6),
    maxPremiumTaxCredit: round(maxPremiumTaxCredit, 6),
    subsidy: round(subsidy, 6),
    netPremium: round(Math.max(0, grossPremium - subsidy), 6),
    oopMaximum: round(Math.max(0, activePlan.oopMaximum ?? 0), 6),
    householdSize: Math.max(1, Math.trunc(Number(config.householdSize) || 1)),
    marketplaceMembers: Math.max(1, Math.trunc(Number(config.marketplaceMembers) || Number(config.householdSize) || 1)),
    activePlanRole: activePlan.role,
    planName: activePlan.planName ?? "",
    eligible,
    // Present only when a ZIP was supplied. `ratingArea` is null and
    // `benchmarkFallback` describes why when no rating-area data applied.
    ratingArea: zipBenchmark?.ratingArea ?? null,
    benchmarkFallback: zipBenchmark?.fallback ?? null
  };
}

/**
 * Thin shim over the offline rating-area SLCSP table. Resolves a ZIP to the
 * annual household benchmark premium (second-lowest-cost silver plan), age-rated
 * across the household, with graceful state-level / out-of-model fallbacks.
 * Used by `computeAca` and available to callers that want the benchmark and the
 * confidence/fallback metadata without running the full PTC computation.
 */
export function benchmarkPremiumForZip({ zip, planYear = 2026, age = null, householdAges = null, householdComposition = null } = {}) {
  const slcsp = slcspMonthlyFor({ zip, planYear, age, householdAges, householdComposition });
  const monthly = slcsp.monthlyPremium;
  return {
    annualBenchmarkPremium: Number.isFinite(monthly) ? round(monthly * 12, 6) : null,
    monthlyBenchmarkPremium: Number.isFinite(monthly) ? round(monthly, 6) : null,
    ratingArea: slcsp.ratingArea,
    ageRatingFactorTotal: slcsp.ageRatingFactorTotal,
    fallback: slcsp.fallback,
    sources: slcsp.sources
  };
}

function activeAcaPlan(config, fplPercent) {
  const backup = config.backupPlan;
  const backupTrigger = Number.isFinite(Number(backup?.triggerFplPercent))
    ? Number(backup.triggerFplPercent)
    : config.maxEligibleFplPercent ?? 400;
  if (backup?.enabled && fplPercent > backupTrigger) {
    return {
      role: "backup",
      premiumInputMode: backup.premiumInputMode ?? config.premiumInputMode ?? "gross",
      benchmarkPremium: backup.benchmarkPremium ?? config.benchmarkPremium,
      selectedPlanPremium: backup.selectedPlanPremium ?? backup.planPremium,
      planPremium: backup.planPremium,
      oopMaximum: backup.oopMaximum,
      planName: backup.planName ?? ""
    };
  }

  return {
    role: "primary",
    premiumInputMode: config.premiumInputMode ?? "gross",
    benchmarkPremium: config.benchmarkPremium,
    selectedPlanPremium: config.selectedPlanPremium,
    planPremium: config.planPremium,
    oopMaximum: config.oopMaximum,
    planName: config.planName ?? ""
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
  return ageAdjustedHouseholdPremium({
    premium: config.benchmarkPremium,
    ageRated: config.ageRatedBenchmarkPremium,
    referenceAge: config.benchmarkPremiumReferenceAge,
    referenceAges: config.benchmarkPremiumReferenceAges,
    memberAges: config.memberAges,
    marketplaceMembers: config.marketplaceMembers,
    householdSize: config.householdSize,
    currentAge: config.currentAge
  }, ageContext);
}

export function ageAdjustedSelectedPlanPremium(config = DEFAULT_ACA_CONFIG, ageContext = {}) {
  const selectedPlanPremium = config.selectedPlanPremium ?? config.planPremium;
  if (!Number.isFinite(selectedPlanPremium)) {
    return ageAdjustedBenchmarkPremium(config, ageContext);
  }

  return ageAdjustedHouseholdPremium({
    premium: selectedPlanPremium,
    ageRated: config.ageRatedSelectedPlanPremium ?? config.ageRatedBenchmarkPremium,
    referenceAge: config.selectedPlanPremiumReferenceAge ?? config.benchmarkPremiumReferenceAge,
    referenceAges: config.selectedPlanPremiumReferenceAges ?? config.benchmarkPremiumReferenceAges,
    memberAges: config.memberAges,
    marketplaceMembers: config.marketplaceMembers,
    householdSize: config.householdSize,
    currentAge: config.currentAge
  }, ageContext);
}

function ageAdjustedHouseholdPremium(options = {}, ageContext = {}) {
  const premium = Math.max(0, options.premium ?? 0);
  if (!options.ageRated) return round(premium, 6);

  const context = typeof ageContext === "number" ? { age: ageContext } : ageContext ?? {};
  const members = Math.max(1, Math.trunc(Number(options.marketplaceMembers) || Number(options.householdSize) || 1));
  const yearIndex = Math.max(0, Math.trunc(Number(context.yearIndex) || 0));
  const currentFallbackAge = finiteAge(context.age)
    ?? finiteAge(options.currentAge)
    ?? finiteAge(options.referenceAge);
  const referenceFallbackAge = finiteAge(options.referenceAge) ?? currentFallbackAge;

  if (currentFallbackAge == null || referenceFallbackAge == null) return round(premium, 6);

  const currentRatingTotal = householdAgeRatingTotal({
    ages: options.memberAges,
    fallbackAge: currentFallbackAge,
    members,
    ageOffset: Array.isArray(options.memberAges) ? yearIndex : 0,
    exclude65Plus: true
  });
  const referenceRatingTotal = householdAgeRatingTotal({
    ages: options.referenceAges,
    fallbackAge: referenceFallbackAge,
    members,
    ageOffset: 0,
    exclude65Plus: false
  });

  if (referenceRatingTotal <= 0) return round(premium, 6);
  return round(premium * (currentRatingTotal / referenceRatingTotal), 6);
}

export function inflateAcaConfig(config = DEFAULT_ACA_CONFIG, inflationIndex = 1, ageContext = {}, medicalInflationIndex = null) {
  const index = Math.max(0, inflationIndex);
  const medIndex = medicalInflationIndex !== null && medicalInflationIndex !== undefined ? Math.max(0, medicalInflationIndex) : index;
  const currentAge = finiteAge(ageContext?.age) ?? finiteAge(config.currentAge);
  return {
    ...config,
    currentAge,
    currentMemberAges: projectedMemberAges(config.memberAges, ageContext),
    premiumInflationIndex: medIndex,
    fpl: round((config.fpl ?? 0) * index, 6),
    benchmarkPremium: round(ageAdjustedBenchmarkPremium(config, ageContext) * medIndex, 6),
    selectedPlanPremium: round(ageAdjustedSelectedPlanPremium(config, ageContext) * medIndex, 6),
    oopMaximum: round(Math.max(0, config.oopMaximum ?? 0) * medIndex, 6),
    backupPlan: inflateBackupPlan(config, medIndex, ageContext),
    oopMaximumInflated: true
  };
}

function projectedMemberAges(memberAges, ageContext = {}) {
  if (!Array.isArray(memberAges)) return null;
  const offset = Math.max(0, Math.trunc(Number(ageContext?.yearIndex) || 0));
  const projected = memberAges
    .map((age) => finiteAge(age))
    .filter((age) => age != null)
    .map((age) => age + offset);
  return projected.length ? projected : null;
}

function inflateBackupPlan(config, inflationIndex, ageContext) {
  const backup = config.backupPlan;
  if (!backup?.enabled) return backup ?? null;
  return {
    ...backup,
    benchmarkPremium: round(ageAdjustedHouseholdPremium({
      premium: backup.benchmarkPremium,
      ageRated: backup.ageRatedBenchmarkPremium,
      referenceAge: backup.benchmarkPremiumReferenceAge,
      referenceAges: backup.benchmarkPremiumReferenceAges,
      memberAges: backup.memberAges ?? config.memberAges,
      marketplaceMembers: backup.marketplaceMembers ?? config.marketplaceMembers,
      householdSize: backup.householdSize ?? config.householdSize,
      currentAge: backup.currentAge ?? config.currentAge
    }, ageContext) * inflationIndex, 6),
    selectedPlanPremium: round(ageAdjustedHouseholdPremium({
      premium: backup.selectedPlanPremium ?? backup.planPremium,
      ageRated: backup.ageRatedSelectedPlanPremium,
      referenceAge: backup.selectedPlanPremiumReferenceAge,
      referenceAges: backup.selectedPlanPremiumReferenceAges,
      memberAges: backup.memberAges ?? config.memberAges,
      marketplaceMembers: backup.marketplaceMembers ?? config.marketplaceMembers,
      householdSize: backup.householdSize ?? config.householdSize,
      currentAge: backup.currentAge ?? config.currentAge
    }, ageContext) * inflationIndex, 6),
    oopMaximum: round(Math.max(0, backup.oopMaximum ?? 0) * inflationIndex, 6),
    oopMaximumInflated: true
  };
}

function householdAgeRatingTotal({ ages, fallbackAge, members, ageOffset, exclude65Plus = false }) {
  return Array.from({ length: members }, (_, index) => {
    const age = finiteAge(ages?.[index]) ?? fallbackAge;
    const currentAge = age + ageOffset;
    if (exclude65Plus && currentAge >= 65) {
      return 0;
    }
    return acaAgeRatingFactor(currentAge);
  }).reduce((total, factor) => total + factor, 0);
}

function finiteAge(age) {
  const numericAge = Number(age);
  return Number.isFinite(numericAge) ? Math.max(0, numericAge) : null;
}
