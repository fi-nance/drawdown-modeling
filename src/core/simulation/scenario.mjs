// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: scenario. No behavior changes — pure code movement.

import { DEFAULT_ACA_CONFIG } from "../aca.mjs";
import { MONTE_CARLO_ASSUMPTION_PRESETS } from "./constants.mjs";
import { hasOwn } from "./guards.mjs";

export const DEFAULT_SCENARIO = {
  planYears: 35,
  startYear: 2026,
  targetSpend: 90000,
  targetSpendInflationAdjusted: true,
  targetSpendIncludesTaxes: false,
  targetSpendIncludesMedical: false,
  spendingStrategy: {
    mode: "fixed",
    essentialSpend: 60000,
    discretionarySpend: 30000,
    essentialInflationAdjusted: true,
    discretionaryInflationAdjusted: false,
    correctionDrawdownThreshold: 0.1,
    bearDrawdownThreshold: 0.2,
    correctionDiscretionaryPercent: 0.5,
    bearDiscretionaryPercent: 0,
    marketAssetClass: "stock"
  },
  medicalExpensesBase: 0,
  expectedOopMaxUsePercent: 0.25,
  oopMaxOverride: null,
  withdrawalOrder: ["taxable", "traditional", "hsa", "roth"],
  withdrawalStrategy: {
    mode: "lifetime",
    expectedReturnPenaltyYears: 1,
    gainHarvestingFutureTaxDiscount: 0.85
  },
  sequenceRiskReserve: {
    enabled: false,
    mode: "cash",
    targetYears: 3,
    tentYears: 10,
    triggerStockReturn: 0
  },
  allocationStrategy: {
    rebalanceEnabled: false,
    withdrawalBiasEnabled: false,
    glidepathEnabled: false,
    targetStockPercent: 70,
    rebalanceBandPercent: 5,
    glidepathStartStockPercent: 60,
    glidepathEndStockPercent: 80,
    glidepathYears: 15,
    preferredDefensiveAssetClass: "bond"
  },
  taxEfficiencyStrategy: {
    marginalRateOptimizationEnabled: true,
    assetLocationEnabled: false,
    hsaContributionEnabled: false,
    hsaCoverage: "auto",
    hsaAnnualContribution: null,
    hsaContributionInflationAdjusted: true,
    hsaCatchUpEnabled: true,
    hsaInvestmentAssetClass: "stock",
    hsaUseForQualifiedExpenses: false,
    startingHsaQualifiedExpenseBalance: 0
  },
  oneOffExpenses: [],
  currentAge: 55,
  spouseAge: 55,
  retirementPenaltyAge: 59.5,
  earlyWithdrawalPenaltyRate: 0.1,
  earlyWithdrawalPenaltyExceptionAmount: 0,
  rothBasis: 60000,
  rothFiveYearRuleSatisfied: true,
  rothBasisOptimization: {
    enabled: true,
    minSavingsRate: 0.5,
    opportunityCostMode: "dynamic",
    magiBuffer: 1000
  },
  medicareWages: 0,
  socialSecurityWages: null,
  selfEmploymentIncome: 0,
  rrtaCompensation: 0,
  earnedIncomeInflationAdjusted: true,
  socialSecurityAnnualBenefit: 0,
  socialSecurityStartAge: 67,
  socialSecurityInflationAdjusted: true,
  rmd: {
    enabled: true,
    startAge: null
  },
  medicare: {
    irmaaEnabled: true,
    partBEnrollees: null,
    partDEnrollees: null,
    partDMonthlyPremium: 0,
    twoYearsPriorMagi: null,
    priorYearMagi: null,
    marriedFilingSeparatelyLivedTogether: false
  },
  monteCarlo: {
    assumptionPreset: "marketNeutral",
    samplingMode: "correlated"
  },
  returnAssumptions: cloneReturnAssumptions(MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral),
  taxLossHarvesting: { enabled: true, mode: "auto", overrideMaxLoss: null },
  taxGainHarvesting: { enabled: true, mode: "auto", overrideMaxGain: null },
  rothConversion: {
    enabled: true,
    mode: "auto",
    overrideAmount: null,
    annualAmount: null,
    targetMarginalRate: 0.12,
    optimizeForAca: true,
    maxAcaFplPercent: 400,
    magiBuffer: 0,
    applyMagiGuardrails: false
  },
  aca: DEFAULT_ACA_CONFIG,
  heirOrdinaryTaxRate: 0.24,
  primaryMortalityAge: 95,
  spouseMortalityAge: 95,
  spouseSocialSecurityAnnualBenefit: 0,
  spouseSocialSecurityStartAge: 67,
  spouseSocialSecurityInflationAdjusted: true,
  heirType: "spouse",
  // User-set planning assumptions for inherited-IRA bracket effects. The
  // model has no primary source for either: leave 0 unless the household
  // wants to stress-test a specific heir scenario. See KNOWN_LIMITATIONS.
  nonSpouse10YrTaxDrag: 0,
  eligibleDesignatedTaxDiscount: 0
};

// Ensures every asset class present in `assets` has a finite return-assumption
// entry in the scenario. Missing or non-finite values are filled with a
// conservative cash-like default (mean: 1%, stdev: 0.5%) so a stray
// uncategorized class can never produce NaN through `normalRandom`.
export function ensureReturnAssumptionsForAssets(scenario, assets = []) {
  const assumptions = { ...(scenario.returnAssumptions ?? {}) };
  const FALLBACK = { mean: 0.01, stdev: 0.005 };
  for (const asset of assets ?? []) {
    const cls = asset?.assetClass;
    if (!cls || cls === "inflation") continue;
    const current = assumptions[cls];
    const meanOk = Number.isFinite(Number(current?.mean));
    const stdevOk = Number.isFinite(Number(current?.stdev));
    if (!current || !meanOk || !stdevOk) {
      assumptions[cls] = {
        mean: meanOk ? Number(current.mean) : FALLBACK.mean,
        stdev: stdevOk ? Number(current.stdev) : FALLBACK.stdev
      };
    }
  }
  return { ...scenario, returnAssumptions: assumptions };
}

export function withdrawalStrategyConfig(scenario) {
  const config = scenario.withdrawalStrategy ?? {};
  const expectedReturnPenaltyYears = Number(config.expectedReturnPenaltyYears);
  const gainHarvestingFutureTaxDiscount = Number(config.gainHarvestingFutureTaxDiscount);
  return {
    mode: isLifetimeOptimizerEnabled(scenario) ? "lifetime" : "heuristic",
    expectedReturnPenaltyYears: Number.isFinite(expectedReturnPenaltyYears) && expectedReturnPenaltyYears >= 0
      ? expectedReturnPenaltyYears
      : 1,
    gainHarvestingFutureTaxDiscount: Number.isFinite(gainHarvestingFutureTaxDiscount) && gainHarvestingFutureTaxDiscount > 0
      ? gainHarvestingFutureTaxDiscount
      : 0.85
  };
}

export function isLifetimeOptimizerEnabled(scenario) {
  const mode = typeof scenario?.withdrawalStrategy === "string"
    ? scenario.withdrawalStrategy
    : scenario?.withdrawalStrategy?.mode;
  return mode === "lifetime" || mode === "optimized";
}

export function expectedReturnForAsset(asset = {}, returnAssumptions = {}) {
  const explicit = Number(asset.expectedReturn);
  if (Number.isFinite(explicit)) return explicit;
  const assumption = returnAssumptions?.[asset.assetClass];
  const mean = Number(typeof assumption === "number" ? assumption : assumption?.mean);
  return Number.isFinite(mean) ? mean : 0;
}

export function mergeScenario(scenario) {
  return {
    ...DEFAULT_SCENARIO,
    ...scenario,
    monteCarlo: {
      ...DEFAULT_SCENARIO.monteCarlo,
      ...(scenario.monteCarlo ?? {})
    },
    // Plain spread: an explicitly-supplied medicalInflation always wins and is
    // never overwritten based on the general value. (The previous heuristic
    // inferred "left at default" via exact float equality and silently
    // collapsed medical→general whenever general was customized, defeating the
    // two-stream feature.) Whether a medical stream was explicitly provided is
    // detected from the raw scenario in simulatePlan, so an absent medical
    // assumption stays backward-compatibly tied to general inflation.
    returnAssumptions: {
      ...DEFAULT_SCENARIO.returnAssumptions,
      ...(scenario.returnAssumptions ?? {})
    },
    taxLossHarvesting: {
      ...DEFAULT_SCENARIO.taxLossHarvesting,
      ...(scenario.taxLossHarvesting ?? {})
    },
    taxGainHarvesting: {
      ...DEFAULT_SCENARIO.taxGainHarvesting,
      ...(scenario.taxGainHarvesting ?? {})
    },
    withdrawalStrategy: {
      ...DEFAULT_SCENARIO.withdrawalStrategy,
      ...(typeof scenario.withdrawalStrategy === "string"
        ? { mode: scenario.withdrawalStrategy }
        : (scenario.withdrawalStrategy ?? {}))
    },
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      ...(typeof scenario.spendingStrategy === "string"
        ? { mode: scenario.spendingStrategy }
        : (scenario.spendingStrategy ?? {}))
    },
    sequenceRiskReserve: {
      ...DEFAULT_SCENARIO.sequenceRiskReserve,
      ...(scenario.sequenceRiskReserve ?? {})
    },
    allocationStrategy: {
      ...DEFAULT_SCENARIO.allocationStrategy,
      ...(scenario.allocationStrategy ?? {})
    },
    taxEfficiencyStrategy: {
      ...DEFAULT_SCENARIO.taxEfficiencyStrategy,
      ...(scenario.taxEfficiencyStrategy ?? {})
    },
    rothConversion: {
      ...DEFAULT_SCENARIO.rothConversion,
      ...(scenario.rothConversion ?? {})
    },
    rothBasisOptimization: {
      ...DEFAULT_SCENARIO.rothBasisOptimization,
      ...(scenario.rothBasisOptimization ?? {})
    },
    rmd: {
      ...DEFAULT_SCENARIO.rmd,
      ...(scenario.rmd ?? {})
    },
    medicare: {
      ...DEFAULT_SCENARIO.medicare,
      ...(scenario.medicare ?? {})
    },
    aca: mergeAcaScenario(scenario.aca),
    oneOffExpenses: scenario.oneOffExpenses ?? DEFAULT_SCENARIO.oneOffExpenses
  };
}

function cloneReturnAssumptions(assumptions = {}) {
  return Object.fromEntries(
    Object.entries(assumptions).map(([assetClass, assumption]) => [
      assetClass,
      { mean: assumption.mean, stdev: assumption.stdev }
    ])
  );
}

function mergeAcaScenario(aca) {
  const merged = {
    ...DEFAULT_SCENARIO.aca,
    ...(aca ?? {})
  };
  if (!aca) return merged;

  const hasBenchmark = hasOwn(aca, "benchmarkPremium");
  const hasSelectedPlanPremium = hasOwn(aca, "selectedPlanPremium") || hasOwn(aca, "planPremium");
  if (hasOwn(aca, "fpl") && !hasOwn(aca, "manualFpl")) {
    merged.manualFpl = true;
  }
  const hasAgeRatingConfig = hasOwn(aca, "ageRatedBenchmarkPremium")
    || hasOwn(aca, "benchmarkPremiumReferenceAge")
    || hasOwn(aca, "benchmarkPremiumReferenceAges")
    || hasOwn(aca, "ageRatedSelectedPlanPremium")
    || hasOwn(aca, "selectedPlanPremiumReferenceAge")
    || hasOwn(aca, "selectedPlanPremiumReferenceAges")
    || hasOwn(aca, "memberAges");

  if (hasBenchmark && !hasAgeRatingConfig) {
    merged.ageRatedBenchmarkPremium = false;
    merged.benchmarkPremiumReferenceAge = null;
    merged.benchmarkPremiumReferenceAges = null;
    merged.memberAges = null;
  }
  if (hasBenchmark && !hasSelectedPlanPremium) {
    merged.selectedPlanPremium = merged.benchmarkPremium;
    merged.ageRatedSelectedPlanPremium = merged.ageRatedBenchmarkPremium;
    merged.selectedPlanPremiumReferenceAge = merged.benchmarkPremiumReferenceAge;
    merged.selectedPlanPremiumReferenceAges = merged.benchmarkPremiumReferenceAges;
  }
  if (hasSelectedPlanPremium && !hasAgeRatingConfig) {
    merged.ageRatedSelectedPlanPremium = false;
    merged.selectedPlanPremiumReferenceAge = null;
    merged.selectedPlanPremiumReferenceAges = null;
  }

  return merged;
}
