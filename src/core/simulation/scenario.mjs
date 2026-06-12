// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: scenario. No behavior changes — pure code movement.

import { DEFAULT_ACA_CONFIG } from "../aca.mjs";
import { DEFAULT_MONTE_CARLO_MEAN_REVERSION, MONTE_CARLO_ASSUMPTION_PRESETS } from "./constants.mjs";
import { hasOwn } from "./guards.mjs";
import { DEFAULT_RISK_BASED_GUARDRAILS } from "./riskBasedGuardrails.mjs";

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
    marketAssetClass: "stock",
    riskBasedGuardrails: DEFAULT_RISK_BASED_GUARDRAILS
  },
  medicalExpensesBase: 0,
  expectedOopMaxUsePercent: 0.25,
  oopMaxOverride: null,
  // Opt-in age-banded spending ("retirement smile"): scales fixed-mode and
  // essential/discretionary spending by phase percentages keyed to the
  // primary's age. Disabled by default — no effect on existing plans. Not
  // applied to the dynamic strategies (Guyton-Klinger, Kitces, VPW,
  // risk-based guardrails), which set their own spending paths.
  agePhasedSpending: {
    enabled: false,
    slowGoAge: 76,
    slowGoPercent: 85,
    noGoAge: 86,
    noGoPercent: 75
  },
  // Opt-in long-term-care stress: an additional medical-inflated annual cost
  // while the selected member is alive and inside the age window.
  ltcStress: {
    enabled: false,
    member: "primary",
    startAge: 85,
    years: 3,
    annualCost: 100000
  },
  // Opt-in survivor basis step-up at the FIRST death of an MFJ couple:
  // taxable lots owned by the deceased step up fully to market value; lots
  // owned jointly step up `jointBasisStepUpPercent` of the unrealized gain
  // (50% = common-law half step-up); survivor-owned lots are unchanged.
  // Untagged lots default to owner "primary".
  survivorStepUp: {
    enabled: false,
    jointBasisStepUpPercent: 50
  },
  // Heir tax-parameter indexing: "indexed" (default) scales heir brackets,
  // deduction, base income, and the federal estate exclusion to the death/
  // valuation-year price level; "frozen2026" keeps them at 2026 nominal
  // amounts for conservative planning.
  heirTaxIndexing: "indexed",
  // First-class recurring income streams (pension / annuity / rent / other):
  // age-started, optional COLA, survivor percentage, tax character, and
  // state retirement-income eligibility. Empty by default.
  incomeStreams: [],
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
  // Opt-in TIPS bond ladder: at plan start (the "first rebalance"), carve out
  // `years` rungs of inflation-indexed, held-to-maturity TIPS — one rung per
  // year — each paying `annualRealAmount` (today's dollars; null = the plan's
  // base annual spending target) at a locked `realYield`. Rungs maturing
  // before age 59.5 are placed taxable-first (no early-withdrawal penalty);
  // later rungs traditional-first (maturities then count toward RMDs). Rungs
  // are deterministic (no market sampling), excluded from rebalancing /
  // asset-location / reserve counting / ordinary withdrawals, and matured
  // rungs fund spending before any other withdrawal. Disabled by default —
  // no effect on existing plans.
  // maintenanceMode — what happens to the ladder after the initial carve-out:
  //   "none"            (default) build once, deplete: each matured rung funds
  //                     its year and is not replaced — a declining bond tent
  //                     that leaves a rising equity glidepath behind.
  //   "always"          after each maturity, buy a new far rung so the ladder
  //                     keeps `years` of coverage (full catch-up of any
  //                     previously unfunded rungs).
  //   "stocks-up"       replenish only in years where the realized stock
  //                     return is ABOVE triggerStockReturnPercent (sell
  //                     appreciated stock to refill the floor);
  //                     replenishCatchUp controls whether missed rungs are
  //                     bought back after a recovery (defaults ON: in seeded
  //                     500-run tournaments catch-up added ~1.5pp success for
  //                     ~8-10% median heir value — success-first).
  //   "spend-on-stress" a maturing rung is SPENT only when the stock return
  //                     is at or below the trigger; in other years it rolls
  //                     forward `years` ahead and spending comes from the
  //                     (appreciated) portfolio instead. The tournament's
  //                     efficiency winner: near always-replenish success at a
  //                     fraction of its heir-value cost.
  tipsLadder: {
    enabled: false,
    years: 10,
    annualRealAmount: null,
    realYieldPercent: 2,
    maintenanceMode: "none",
    replenishCatchUp: true,
    triggerStockReturnPercent: 0
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
    hsaUseForQualifiedExpenses: true,
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
  spouseMedicareWages: 0,
  spouseSocialSecurityWages: null,
  spouseSelfEmploymentIncome: 0,
  estimateSocialSecurityFromEarnings: false,
  earnedIncomeInflationAdjusted: true,
  socialSecurityAnnualBenefit: 0,
  socialSecurityStartAge: 67,
  socialSecurityInflationAdjusted: true,
  rmd: {
    enabled: true,
    startAge: null,
    // Optional override for the spouse's RMD start age when spouse-owned
    // traditional accounts (asset.owner === "spouse") are modeled. Null →
    // derived from the spouse's birth year (SECURE 2.0).
    spouseStartAge: null
  },
  medicare: {
    irmaaEnabled: true,
    partBEnrollees: null,
    partDEnrollees: null,
    partDMonthlyPremium: 0,
    // Medigap / Medicare Advantage supplemental monthly premium per enrolled
    // member (today's dollars, medical-inflated, no IRMAA adjustment).
    medigapMonthlyPremium: 0,
    // Annual non-premium out-of-pocket estimate (today's dollars) applied once
    // the whole household is on Medicare. Null → legacy ACA-plan OOP proxy
    // (flagged input-limited by the confidence layer).
    annualOopBase: null,
    twoYearsPriorMagi: null,
    priorYearMagi: null,
    marriedFilingSeparatelyLivedTogether: false
  },
  monteCarlo: {
    assumptionPreset: "marketNeutral",
    samplingMode: "correlated",
    meanReversion: DEFAULT_MONTE_CARLO_MEAN_REVERSION,
    // AR(1) persistence for the sampled inflation streams (0 = i.i.d. draws,
    // the historical default). Positive values produce serially correlated
    // inflation paths with the SAME unconditional variance (shocks scaled by
    // sqrt(1 - phi^2)), capturing sustained-inflation sequence risk. Annual
    // US CPI lag-1 autocorrelation is commonly estimated around 0.6-0.8.
    inflationPersistence: 0
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
    tipsLadder: {
      ...DEFAULT_SCENARIO.tipsLadder,
      ...(scenario.tipsLadder ?? {})
    },
    agePhasedSpending: {
      ...DEFAULT_SCENARIO.agePhasedSpending,
      ...(scenario.agePhasedSpending ?? {})
    },
    ltcStress: {
      ...DEFAULT_SCENARIO.ltcStress,
      ...(scenario.ltcStress ?? {})
    },
    survivorStepUp: {
      ...DEFAULT_SCENARIO.survivorStepUp,
      ...(scenario.survivorStepUp ?? {})
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
    oneOffExpenses: scenario.oneOffExpenses ?? DEFAULT_SCENARIO.oneOffExpenses,
    incomeStreams: Array.isArray(scenario.incomeStreams) ? scenario.incomeStreams : DEFAULT_SCENARIO.incomeStreams
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
