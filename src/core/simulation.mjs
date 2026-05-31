import { computeAca, DEFAULT_ACA_CONFIG, inflateAcaConfig } from "./aca.mjs";
import {
  accountBreakdown,
  ageHoldingPeriods,
  applyTotalReturnsWithIncome,
  clonePortfolio,
  harvestTaxGains,
  harvestTaxLosses,
  marketValue,
  portfolioValue,
  removeEmptyLots,
  sellFromLot
} from "./portfolio.mjs";
import {
  computeIncomeTax,
  computeTaxableSocialSecurityBenefits,
  DEFAULT_TAX_PROFILE,
  inflateTaxProfile,
  netCapitalGainsAndLosses
} from "./tax.mjs";
import { getMedicareIrmaaConfig } from "../data/taxData.mjs";
import { createRng, normalRandom, percentile, round } from "./utils.mjs";

const CASH_GAP_TOLERANCE = 0.01;
const CASH_RAISED_EPSILON = 0.000001;
const FULL_WITHDRAWAL_ORDER = ["taxable", "traditional", "hsa", "roth"];
const DEFENSIVE_ASSET_CLASSES = Object.freeze(["bond", "cash", "tips"]);
const GROWTH_ASSET_CLASSES = Object.freeze(["stock", "realEstate", "crypto"]);
const HSA_LIMITS_2026 = Object.freeze({
  selfOnly: 4400,
  family: 8750,
  catchUp55: 1000
});

export const MONTE_CARLO_ASSUMPTION_PRESETS = Object.freeze({
  marketNeutral: Object.freeze({
    stock: Object.freeze({ mean: 0.071, stdev: 0.153 }),
    bond: Object.freeze({ mean: 0.049, stdev: 0.063 }),
    cash: Object.freeze({ mean: 0.033, stdev: 0.011 }),
    realEstate: Object.freeze({ mean: 0.081, stdev: 0.179 }),
    tips: Object.freeze({ mean: 0.042, stdev: 0.05 }),
    crypto: Object.freeze({ mean: 0.12, stdev: 0.65 }),
    inflation: Object.freeze({ mean: 0.024, stdev: 0.017 })
  }),
  planning: Object.freeze({
    stock: Object.freeze({ mean: 0.065, stdev: 0.18 }),
    bond: Object.freeze({ mean: 0.028, stdev: 0.06 }),
    cash: Object.freeze({ mean: 0.015, stdev: 0.015 }),
    realEstate: Object.freeze({ mean: 0.05, stdev: 0.14 }),
    tips: Object.freeze({ mean: 0.025, stdev: 0.07 }),
    crypto: Object.freeze({ mean: 0.12, stdev: 0.65 }),
    inflation: Object.freeze({ mean: 0.025, stdev: 0.012 })
  }),
  historical: Object.freeze({
    stock: Object.freeze({ mean: 0.1186, stdev: 0.193 }),
    bond: Object.freeze({ mean: 0.0482, stdev: 0.0786 }),
    cash: Object.freeze({ mean: 0.0342, stdev: 0.0302 }),
    realEstate: Object.freeze({ mean: 0.0438, stdev: 0.0615 }),
    tips: Object.freeze({ mean: 0.0372, stdev: 0.0621 }),
    // Crypto's short, regime-heavy series is too unstable to use raw as a
    // planning preset, so keep the tempered forward-looking assumption here.
    crypto: Object.freeze({ mean: 0.12, stdev: 0.65 }),
    inflation: Object.freeze({ mean: 0.0308, stdev: 0.0387 })
  })
});

export const DEFAULT_MONTE_CARLO_RUNS = 1000;

const MONTE_CARLO_FACTOR_LOADINGS = Object.freeze({
  stock: Object.freeze({ market: 0.65, rates: 0.05 }),
  bond: Object.freeze({ market: 0.15, rates: 0.6 }),
  cash: Object.freeze({ market: 0.05, rates: 0.45 }),
  realEstate: Object.freeze({ market: 0.55, rates: 0.15 }),
  tips: Object.freeze({ market: 0.1, rates: 0.6 }),
  crypto: Object.freeze({ market: 0.6, rates: 0.05 })
});

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
  heirOrdinaryTaxRate: 0.24
};

const ROTH_BASIS_ASSET_CLASS_PRIORITY = Object.freeze({
  cash: 0,
  bond: 1,
  tips: 2,
  realEstate: 3,
  stock: 4,
  crypto: 5
});

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

export function simulatePlan({
  assets,
  scenario = {},
  taxProfile = DEFAULT_TAX_PROFILE,
  returnSequence,
  inflationSequence
}) {
  const mergedScenario = ensureReturnAssumptionsForAssets(mergeScenario(scenario), assets);
  const portfolio = clonePortfolio(assets);
  const years = [];
  let lossCarryforward = { shortTerm: 0, longTerm: 0 };
  let rothBasisRemaining = Math.max(0, mergedScenario.rothBasis ?? 0);
  let hsaQualifiedExpenseBalance = hsaStrategyConfig(mergedScenario).startingQualifiedExpenseBalance;
  let success = true;
  let inflationIndex = 1;
  const irmaaMagiHistory = [];
  let spendingGuardrailMarketState = initialSpendingGuardrailMarketState();

  for (let yearIndex = 0; yearIndex < mergedScenario.planYears; yearIndex += 1) {
    if (yearIndex > 0) {
      inflationIndex *= 1 + annualInflation(mergedScenario, inflationSequence, yearIndex - 1);
    }

    const returnByAssetClass = annualReturns(mergedScenario, returnSequence, yearIndex);
    const currentInflationRate = annualInflation(mergedScenario, inflationSequence, yearIndex);
    const spendingGuardrail = spendingGuardrailStateForYear({
      scenario: mergedScenario,
      marketState: spendingGuardrailMarketState
    });
    const result = simulateYear({
      portfolio,
      scenario: mergedScenario,
      taxProfile,
      yearIndex,
      inflationIndex,
      returnByAssetClass,
      annualInflationRate: currentInflationRate,
      spendingGuardrail,
      lossCarryforward,
      rothBasisRemaining,
      hsaQualifiedExpenseBalance,
      magiHistory: irmaaMagiHistory
    });
    spendingGuardrailMarketState = advanceSpendingGuardrailMarketState({
      scenario: mergedScenario,
      marketState: spendingGuardrailMarketState,
      returnByAssetClass
    });

    lossCarryforward = result.lossCarryforwardDetail ?? normalizeLossCarryforward(result.lossCarryforward);
    rothBasisRemaining = result.rothBasisRemaining;
    hsaQualifiedExpenseBalance = result.hsaQualifiedExpenseBalance ?? hsaQualifiedExpenseBalance;
    irmaaMagiHistory.push(result.irmaaMagi);
    success = success && !isPortfolioDepleted(result);
    years.push(result);
  }

  const endingAccounts = accountBreakdown(portfolio);
  const endingValue = portfolioValue(portfolio);
  const heirValueBreakdown = estimateHeirValueBreakdown(portfolio, mergedScenario.heirOrdinaryTaxRate);
  return {
    success,
    years,
    endingValue,
    endingAccounts,
    heirValue: heirValueBreakdown.afterTaxValue,
    heirValueBreakdown,
    rothBasisRemaining,
    hsaQualifiedExpenseBalance,
    finalPortfolio: clonePortfolio(portfolio)
  };
}

export function runMonteCarlo({
  assets,
  scenario = {},
  taxProfile = DEFAULT_TAX_PROFILE,
  runs = DEFAULT_MONTE_CARLO_RUNS,
  seed = 42,
  onProgress = null,
  onBatch = null,
  progressInterval = 25,
  scenarioTimelineLimit = Number.POSITIVE_INFINITY
}) {
  const mergedScenario = ensureReturnAssumptionsForAssets(mergeScenario(scenario), assets);
  const rng = createRng(seed);
  const scenarios = [];
  const reportEvery = Math.max(1, Math.trunc(progressInterval) || 25);
  const timelineLimit = normalizeScenarioTimelineLimit(scenarioTimelineLimit);
  let batchStart = 0;

  for (let run = 0; run < runs; run += 1) {
    const returnSequence = [];
    const inflationSequence = [];
    for (let year = 0; year < mergedScenario.planYears; year += 1) {
      returnSequence.push(sampleReturnsForYear(mergedScenario, rng));
      inflationSequence.push(Math.max(-0.08, normalRandom(
        rng,
        mergedScenario.returnAssumptions.inflation?.mean ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.inflation.mean,
        mergedScenario.returnAssumptions.inflation?.stdev ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.inflation.stdev
      )));
    }

    const plan = simulatePlan({
      assets,
      scenario: mergedScenario,
      taxProfile,
      returnSequence,
      inflationSequence
    });

    const depletion = firstDepletionDetails(plan.years);
    scenarios.push(monteCarloScenarioResult({
      id: run + 1,
      plan,
      depletion,
      includeTimeline: run < timelineLimit
    }));

    if ((run + 1) % reportEvery === 0 || run + 1 === runs) {
      if (typeof onBatch === "function") {
        onBatch({
          scenarios: scenarios.slice(batchStart, run + 1),
          done: run + 1,
          total: runs
        });
        batchStart = run + 1;
      }
      if (typeof onProgress === "function") {
        onProgress({ done: run + 1, total: runs });
      }
    }
  }

  const endingValues = scenarios.map((scenarioResult) => scenarioResult.endingValue);
  const heirValues = scenarios.map((scenarioResult) => scenarioResult.heirValue);
  return {
    scenarios,
    summary: {
      runs,
      successRate: round(scenarios.filter((scenarioResult) => scenarioResult.success).length / runs, 4),
      medianEndingValue: round(percentile(endingValues, 0.5), 2),
      p10EndingValue: round(percentile(endingValues, 0.1), 2),
      p90EndingValue: round(percentile(endingValues, 0.9), 2),
      medianHeirValue: round(percentile(heirValues, 0.5), 2)
    }
  };
}

function normalizeScenarioTimelineLimit(value) {
  if (value === Number.POSITIVE_INFINITY || value === Infinity) return Number.POSITIVE_INFINITY;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.trunc(numeric));
}

function analyzeFailedScenario(years = []) {
  let consecutiveDownYears = 0;
  let maxConsecutiveDownYears = 0;
  let earlyDownYearsCount = 0;
  let totalDownYearsCount = 0;
  let inflationSumFirstDecade = 0;
  let inflationCountFirstDecade = 0;
  let stockReturnSumFirstDecade = 0;
  let stockReturnCountFirstDecade = 0;
  let taxTotal = 0;
  let medicalTotal = 0;
  let spendingTotal = 0;
  let requiredCashTotal = 0;
  let beginningPortfolioTotal = 0;
  let withdrawalRateSum = 0;
  let withdrawalRateCount = 0;
  let riskShareSum = 0;
  let riskShareCount = 0;
  let negativeStockYears = 0;
  let defensiveShortfallYears = 0;

  const depletionIndex = years.findIndex(isPortfolioDepleted);
  const analyzedYears = years.slice(0, depletionIndex >= 0 ? depletionIndex + 1 : years.length);

  for (let i = 0; i < analyzedYears.length; i++) {
    const yr = analyzedYears[i];
    const stockReturn = yr?.assetClassReturns?.stock ?? 0;
    const inflation = yr?.assetClassReturns?.inflation ?? 0;
    const requiredCash = Math.max(0, Number(yr?.totalCashRequired) || 0);
    const beginningPortfolio = Math.max(0, Number(yr?.beginningPortfolioValue) || 0);
    const assets = Array.isArray(yr?.beginningAssets) ? yr.beginningAssets : [];
    const riskValue = assetClassValue(assets, ["stock", "realEstate", "crypto"]);
    const defensiveValue = assetClassValue(assets, ["cash", "bond", "tips"]);
    const totalAssetValue = riskValue + defensiveValue;

    taxTotal += Math.max(0, Number(yr?.taxes?.totalTax) || 0);
    medicalTotal += Math.max(0, Number(yr?.medicalCost) || 0);
    spendingTotal += Math.max(0, Number(yr?.plannedSpending) || 0);
    requiredCashTotal += requiredCash;
    beginningPortfolioTotal += beginningPortfolio;
    if (beginningPortfolio > 0 && requiredCash > 0) {
      withdrawalRateSum += requiredCash / beginningPortfolio;
      withdrawalRateCount++;
    }
    if (totalAssetValue > 0) {
      riskShareSum += riskValue / totalAssetValue;
      riskShareCount++;
    }

    if (stockReturn < 0) {
      consecutiveDownYears++;
      if (consecutiveDownYears > maxConsecutiveDownYears) {
        maxConsecutiveDownYears = consecutiveDownYears;
      }
      totalDownYearsCount++;
      negativeStockYears++;
      if (requiredCash > 0 && defensiveValue < requiredCash * 2) {
        defensiveShortfallYears++;
      }
      if (i < 10) {
        earlyDownYearsCount++;
      }
    } else {
      consecutiveDownYears = 0;
    }

    if (i < 10) {
      inflationSumFirstDecade += inflation;
      inflationCountFirstDecade++;
      stockReturnSumFirstDecade += stockReturn;
      stockReturnCountFirstDecade++;
    }
  }

  const avgInflationFirstDecade = inflationCountFirstDecade > 0 ? inflationSumFirstDecade / inflationCountFirstDecade : 0;
  const avgStockReturnFirstDecade = stockReturnCountFirstDecade > 0 ? stockReturnSumFirstDecade / stockReturnCountFirstDecade : 0;
  const avgWithdrawalRate = withdrawalRateCount > 0 ? withdrawalRateSum / withdrawalRateCount : 0;
  const avgRiskShare = riskShareCount > 0 ? riskShareSum / riskShareCount : 0;
  const taxShareOfNeed = requiredCashTotal > 0 ? taxTotal / requiredCashTotal : 0;
  const healthcareShareOfNeed = requiredCashTotal > 0 ? medicalTotal / requiredCashTotal : 0;
  const spendingRate = beginningPortfolioTotal > 0 ? spendingTotal / beginningPortfolioTotal : 0;
  const stressors = failureStressors({
    taxShareOfNeed,
    healthcareShareOfNeed,
    avgWithdrawalRate,
    spendingRate,
    avgRiskShare,
    negativeStockYears,
    defensiveShortfallYears,
    earlyDownYearsCount,
    avgStockReturnFirstDecade
  });

  return {
    maxConsecutiveDownYears,
    earlyDownYearsCount,
    totalDownYearsCount,
    avgInflationFirstDecade: round(avgInflationFirstDecade, 6),
    avgStockReturnFirstDecade: round(avgStockReturnFirstDecade, 6),
    taxShareOfNeed: round(taxShareOfNeed, 6),
    healthcareShareOfNeed: round(healthcareShareOfNeed, 6),
    avgWithdrawalRate: round(avgWithdrawalRate, 6),
    spendingRate: round(spendingRate, 6),
    avgRiskShare: round(avgRiskShare, 6),
    defensiveShortfallRate: negativeStockYears > 0 ? round(defensiveShortfallYears / negativeStockYears, 6) : 0,
    stressors
  };
}

function assetClassValue(assets, classes) {
  const wanted = new Set(classes);
  return assets.reduce((total, asset) => {
    return wanted.has(asset?.assetClass) ? total + Math.max(0, Number(asset.value) || 0) : total;
  }, 0);
}

function failureStressors({
  taxShareOfNeed,
  healthcareShareOfNeed,
  avgWithdrawalRate,
  spendingRate,
  avgRiskShare,
  negativeStockYears,
  defensiveShortfallYears,
  earlyDownYearsCount,
  avgStockReturnFirstDecade
}) {
  const stressors = [];
  if (taxShareOfNeed >= 0.12) {
    stressors.push({ id: "taxDrag", value: round(taxShareOfNeed, 4), metric: "tax share of required cash" });
  }
  if (healthcareShareOfNeed >= 0.12) {
    stressors.push({ id: "healthcareDrag", value: round(healthcareShareOfNeed, 4), metric: "healthcare share of required cash" });
  }
  if (avgWithdrawalRate >= 0.055 || spendingRate >= 0.05) {
    stressors.push({ id: "spendingPressure", value: round(Math.max(avgWithdrawalRate, spendingRate), 4), metric: "cash need / portfolio" });
  }
  if (negativeStockYears > 0 && defensiveShortfallYears / negativeStockYears >= 0.5) {
    stressors.push({ id: "reserveShortfall", value: round(defensiveShortfallYears / negativeStockYears, 4), metric: "down-market years with <2 years defensive cash" });
  }
  if ((avgRiskShare >= 0.8 && earlyDownYearsCount >= 3) || (avgRiskShare <= 0.35 && avgStockReturnFirstDecade < 0.03)) {
    stressors.push({ id: "allocationMismatch", value: round(avgRiskShare, 4), metric: "average risk-asset share" });
  }
  return stressors;
}

function monteCarloScenarioResult({ id, plan, depletion, includeTimeline }) {
  const result = {
    id,
    success: plan.success,
    endingValue: plan.endingValue,
    heirValue: plan.heirValue,
    heirValueBreakdown: plan.heirValueBreakdown,
    ...depletion,
    diagnostics: plan.success ? null : analyzeFailedScenario(plan.years)
  };
  if (includeTimeline) {
    return {
      ...result,
      years: plan.years
    };
  }
  return {
    ...result,
    lastYear: lastYearThumbnail(plan.years.at(-1))
  };
}

function lastYearThumbnail(year) {
  if (!year) return null;
  return {
    year: year.year,
    yearIndex: year.yearIndex,
    inflationIndex: year.inflationIndex
  };
}

export function runHistoricalBacktests({
  assets,
  scenario = {},
  taxProfile = DEFAULT_TAX_PROFILE,
  sequences = []
}) {
  return sequences.map((sequence, index) => {
    const plan = simulatePlan({
      assets,
      scenario,
      taxProfile,
      returnSequence: sequence.returns,
      inflationSequence: sequence.inflation
    });
    const annotatedPlan = withHistoricalSourceYears(plan, sequence.sourceYears ?? [], sequence.paddedYears ?? 0);
    const depletion = firstDepletionDetails(annotatedPlan.years);
    return {
      id: sequence.name ?? `Sequence ${index + 1}`,
      sourceYears: sequence.sourceYears ?? [],
      sourceStartYear: sequence.startYear ?? null,
      sourceEndYear: sequence.endYear ?? null,
      paddedYears: Math.max(0, Math.trunc(sequence.paddedYears) || 0),
      ...depletion,
      ...annotatedPlan
    };
  });
}

function withHistoricalSourceYears(plan, sourceYears = [], paddedYears = 0) {
  if (!sourceYears.length) return plan;
  // Mark which year-index is "padded" (re-using earlier source-year data
  // because the historical window was shorter than the plan horizon).
  const total = plan.years.length;
  const firstPaddedIndex = Math.max(0, total - paddedYears);
  return {
    ...plan,
    years: plan.years.map((year, index) => ({
      ...year,
      historicalSourceYear: sourceYears[index % sourceYears.length] ?? null,
      historicalPaddedYear: paddedYears > 0 && index >= firstPaddedIndex
    }))
  };
}

// Ensures every asset class present in `assets` has a finite return-assumption
// entry in the scenario. Missing or non-finite values are filled with a
// conservative cash-like default (mean: 1%, stdev: 0.5%) so a stray
// uncategorized class can never produce NaN through `normalRandom`.
function ensureReturnAssumptionsForAssets(scenario, assets = []) {
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

function normalizeLossCarryforward(value) {
  if (typeof value === "object" && value !== null) {
    return {
      shortTerm: Math.max(0, value.shortTerm ?? 0),
      longTerm: Math.max(0, value.longTerm ?? 0)
    };
  }
  // Legacy callers pass a single number; treat it as long-term to preserve
  // existing behavior (most retirement-era losses are long-term).
  return { shortTerm: 0, longTerm: Math.max(0, Number(value) || 0) };
}

function lossCarryforwardTotal(value) {
  if (typeof value === "object" && value !== null) {
    return Math.max(0, (value.shortTerm ?? 0) + (value.longTerm ?? 0));
  }
  return Math.max(0, Number(value) || 0);
}

function simulateYear({
  portfolio,
  scenario,
  taxProfile,
  yearIndex,
  inflationIndex,
  returnByAssetClass,
  annualInflationRate,
  spendingGuardrail = null,
  lossCarryforward,
  rothBasisRemaining,
  hsaQualifiedExpenseBalance = 0,
  magiHistory = []
}) {
  // Accept either a number (legacy: treated as long-term) or
  // { shortTerm, longTerm } object so callers can preserve §1212(b) character.
  lossCarryforward = normalizeLossCarryforward(lossCarryforward);
  const calendarYear = scenario.startYear + yearIndex;
  const age = (scenario.currentAge ?? 55) + yearIndex;
  const spouseAge = Number.isFinite(Number(scenario.spouseAge))
    ? Number(scenario.spouseAge) + yearIndex
    : null;
  const taxProfileContext = taxProfileForSimulationYear({
    inflatedProfile: inflateTaxProfile(taxProfile, inflationIndex),
    baseProfile: taxProfile,
    scenario,
    yearIndex,
    primaryAge: age,
    spouseAge
  });
  const yearTaxProfile = taxProfileContext.profile;
  const yearAcaConfig = inflateAcaConfig(scenario.aca, inflationIndex, { age, yearIndex });
  // Promote any prior-year-harvested "short" lots back to "long" once a
  // full simulation year has elapsed since the reset, before we compute
  // beginning-of-year snapshots and run any sales/harvests.
  ageHoldingPeriods(portfolio, calendarYear);
  const beginningPortfolioValue = portfolioValue(portfolio);
  const beginningTraditionalValue = traditionalAccountValue(portfolio);
  const beginningAssets = assetSnapshot(portfolio);
  const dividends = applyTotalReturnsWithIncome(portfolio, returnByAssetClass);
  const afterReturnPortfolioValue = portfolioValue(portfolio);

  const flows = [...dividends.flows];
  const oneOffCashFlows = oneOffCashFlowsForYear(scenario, yearIndex + 1, inflationIndex);
  const recurringEarnedIncome = earnedIncomeForYear(scenario, inflationIndex);
  const earnedIncome = mergeEarnedIncome(recurringEarnedIncome, oneOffCashFlows.earnedIncome);
  const incomeCashAvailable = round(recurringEarnedIncome.cash + oneOffCashFlows.income, 6);
  let ordinaryIncome = dividends.ordinaryDividends + earnedIncome.ordinaryIncome + oneOffCashFlows.taxableOrdinaryIncome;
  let qualifiedDividends = dividends.qualifiedDividends;
  const hsaContribution = hsaContributionForYear({
    scenario,
    age,
    spouseAge,
    inflationIndex
  });
  const adjustmentsToIncome = hsaContribution.amount;
  let strategyCapitalLosses = 0;
  let strategyShortTermLosses = 0;
  let strategyLongTermLosses = 0;
  let strategyShortTermGains = 0;
  let strategyLongTermGains = 0;
  const annualPenaltyExceptionAmount = earlyWithdrawalPenaltyExceptionAmountForYear(scenario);

  const lossHarvestLimit = strategyLimit({
    strategy: scenario.taxLossHarvesting,
    autoValue: automaticTaxLossHarvestLimit(portfolio, yearTaxProfile, lossCarryforwardTotal(lossCarryforward)),
    legacyField: "maxLoss",
    overrideField: "overrideMaxLoss"
  });
  const lossHarvest = scenario.taxLossHarvesting?.enabled
    ? harvestTaxLosses(portfolio, lossHarvestLimit, { calendarYear })
    : { realizedLosses: 0, shortTermLosses: 0, longTermLosses: 0, flows: [] };
  strategyCapitalLosses += lossHarvest.realizedLosses;
  strategyShortTermLosses += lossHarvest.shortTermLosses ?? 0;
  strategyLongTermLosses += lossHarvest.longTermLosses ?? 0;
  flows.push(...lossHarvest.flows);

  const assetLocation = assetLocationStateForYear({
    scenario,
    portfolio,
    calendarYear
  });
  strategyShortTermGains += assetLocation.shortTermCapitalGains;
  strategyLongTermGains += assetLocation.longTermCapitalGains;
  strategyCapitalLosses += assetLocation.capitalLosses;
  strategyShortTermLosses += assetLocation.shortTermCapitalLosses;
  strategyLongTermLosses += assetLocation.longTermCapitalLosses;
  flows.push(...assetLocation.flows);

  const allocationStrategy = allocationStrategyStateForYear({
    scenario,
    portfolio,
    yearIndex,
    calendarYear
  });
  strategyShortTermGains += allocationStrategy.shortTermCapitalGains;
  strategyLongTermGains += allocationStrategy.longTermCapitalGains;
  strategyCapitalLosses += allocationStrategy.capitalLosses;
  strategyShortTermLosses += allocationStrategy.shortTermCapitalLosses;
  strategyLongTermLosses += allocationStrategy.longTermCapitalLosses;
  flows.push(...allocationStrategy.flows);

  const rmd = requiredMinimumDistributionForYear({
    scenario,
    age,
    beginningTraditionalValue
  });
  const rmdWithdrawal = rmd.amount > 0
    ? withdrawForCash(portfolio, rmd.amount, ["traditional"], {
      age,
      calendarYear,
      penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
      penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
      rothBasisRemaining,
      rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
      penaltyExceptionRemaining: annualPenaltyExceptionAmount,
      returnAssumptions: scenario.returnAssumptions,
      optimizedLotSelection: isLifetimeOptimizerEnabled(scenario)
    })
    : emptyWithdrawal(rothBasisRemaining, annualPenaltyExceptionAmount);
  rothBasisRemaining = rmdWithdrawal.rothBasisRemaining;

  const socialSecurityBenefits = socialSecurityBenefitsForYear(scenario, age, inflationIndex);

  const rothConversionAmount = scenario.rothConversion?.enabled
    ? convertTraditionalToRoth(portfolio, rothConversionAmountForYear({
      portfolio,
      scenario,
      taxProfile: yearTaxProfile,
      acaConfig: yearAcaConfig,
      ordinaryIncome,
      earnedIncome,
      ordinaryInvestmentIncome: dividends.ordinaryDividends,
      qualifiedDividends,
      adjustmentsToIncome,
      socialSecurityBenefits,
      age,
      spouseAge,
      inflationIndex,
      yearIndex,
      magiHistory,
      lossCarryforward
    }), calendarYear)
    : 0;
  ordinaryIncome += rothConversionAmount;
  if (rothConversionAmount > 0) {
    flows.push({
      from: "Traditional accounts",
      to: "Roth conversion",
      amount: rothConversionAmount,
      type: "conversion"
    });
    flows.push({
      from: "Roth conversion",
      to: "Roth accounts",
      amount: rothConversionAmount,
      type: "conversion"
    });
  }

  const plannedSpendingDetail = plannedSpendingDetailForYear(
    scenario,
    yearIndex + 1,
    inflationIndex,
    oneOffCashFlows,
    spendingGuardrail
  );
  const plannedSpending = plannedSpendingDetail.total;
  const sequenceRiskReserve = sequenceRiskReserveStateForYear({
    scenario,
    portfolio,
    plannedSpending,
    returnByAssetClass,
    yearIndex
  });
  let finalWithdrawal = null;
  let finalTaxes = null;
  let finalAca = null;
  let finalMedicare = emptyMedicareCost();
  let finalTaxableSocialSecurity = 0;
  let finalPortfolio = null;
  let finalRothBasisOptimization = null;
  let medicalEstimate = 0;
  let taxEstimate = 0;

  // Around ACA / IRMAA cliffs the withdrawal can oscillate between two states.
  // Track the prior estimate and exit early on convergence; if the loop fails
  // to converge, fall back to the highest-cost iteration so we don't ship a
  // silently understated tax/medical estimate.
  const MAX_FIXED_POINT_ITERATIONS = 10;
  const FIXED_POINT_TOLERANCE = 1;
  let prevTax = null;
  let prevMedical = null;
  let converged = false;
  let highestCostPlan = null;
  let highestCostTotal = -Infinity;

  for (let iteration = 0; iteration < MAX_FIXED_POINT_ITERATIONS; iteration += 1) {
    const cashRequired = plannedSpending
      + (scenario.targetSpendIncludesMedical ? 0 : medicalEstimate)
      + (scenario.targetSpendIncludesTaxes ? 0 : taxEstimate)
      + hsaContribution.amount;
    const chosenPlan = chooseWithdrawalPlan({
      portfolio,
      amount: Math.max(0, cashRequired - dividends.cash - incomeCashAvailable - rmdWithdrawal.cashRaised - socialSecurityBenefits),
      baseWithdrawal: rmdWithdrawal,
      withdrawalOrder: scenario.withdrawalOrder,
      withdrawalContext: {
        age,
        calendarYear,
        penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
        penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
        rothBasisRemaining: rmdWithdrawal.rothBasisRemaining,
        rothBasisAvailable: rothBasisAvailableForWithdrawal(portfolio, {
          rothBasisRemaining: rmdWithdrawal.rothBasisRemaining,
          age,
          calendarYear,
          penaltyAge: scenario.retirementPenaltyAge ?? 59.5
        }),
        rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
        penaltyExceptionRemaining: rmdWithdrawal.penaltyExceptionRemaining,
        returnAssumptions: scenario.returnAssumptions,
        optimizedLotSelection: isLifetimeOptimizerEnabled(scenario) || sequenceRiskReserve.enabled,
        sequenceRiskReserve,
        allocationStrategy,
        hsaQualifiedExpenseAvailable: hsaQualifiedExpenseAvailableForWithdrawal({
          scenario,
          hsaQualifiedExpenseBalance,
          medicalEstimate
        })
      },
      evaluationContext: {
        scenario,
        yearTaxProfile,
        yearAcaConfig,
        inflationIndex,
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome: rothConversionAmount,
        ordinaryInvestmentIncome: dividends.ordinaryDividends,
        qualifiedDividends,
        adjustmentsToIncome,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        lossCarryforward,
        socialSecurityBenefits,
        age,
        spouseAge,
        yearIndex,
        magiHistory
      }
    });

    const nextMedical = scenario.targetSpendIncludesMedical ? 0 : chosenPlan.medicalTotal;
    const nextTax = chosenPlan.taxes.totalTax;
    const totalCost = nextMedical + nextTax;
    if (totalCost > highestCostTotal) {
      highestCostTotal = totalCost;
      highestCostPlan = chosenPlan;
    }

    medicalEstimate = nextMedical;
    taxEstimate = nextTax;

    finalWithdrawal = chosenPlan.withdrawal;
    finalTaxes = chosenPlan.taxes;
    finalAca = chosenPlan.aca;
    finalMedicare = chosenPlan.medicare;
    finalTaxableSocialSecurity = chosenPlan.taxableSocialSecurity;
    finalPortfolio = chosenPlan.portfolio;
    finalRothBasisOptimization = chosenPlan.rothBasisOptimization;

    if (prevTax !== null
      && Math.abs(nextTax - prevTax) + Math.abs(nextMedical - prevMedical) < FIXED_POINT_TOLERANCE) {
      converged = true;
      break;
    }
    prevTax = nextTax;
    prevMedical = nextMedical;
  }

  if (!converged && highestCostPlan) {
    finalWithdrawal = highestCostPlan.withdrawal;
    finalTaxes = highestCostPlan.taxes;
    finalAca = highestCostPlan.aca;
    finalMedicare = highestCostPlan.medicare;
    finalTaxableSocialSecurity = highestCostPlan.taxableSocialSecurity;
    finalPortfolio = highestCostPlan.portfolio;
    finalRothBasisOptimization = highestCostPlan.rothBasisOptimization;
    medicalEstimate = scenario.targetSpendIncludesMedical ? 0 : highestCostPlan.medicalTotal;
    taxEstimate = highestCostPlan.taxes.totalTax;
  }

  if (scenario.taxGainHarvesting?.enabled) {
    const gainHarvestLimit = gainHarvestingRoom({
      taxes: finalTaxes,
      taxProfile: yearTaxProfile,
      acaConfig: yearAcaConfig,
      currentMagi: acaMagiForIncome(incomeForYear({
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome: rothConversionAmount,
        ordinaryInvestmentIncome: dividends.ordinaryDividends,
        qualifiedDividends,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        withdrawal: finalWithdrawal,
        socialSecurityBenefits,
        taxProfile: yearTaxProfile,
        scenario,
        adjustmentsToIncome,
        lossCarryforward
      }).income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000),
      configuredMaxGain: strategyLimit({
        strategy: scenario.taxGainHarvesting,
        autoValue: Infinity,
        legacyField: "maxGain",
        overrideField: "overrideMaxGain"
      }),
      portfolio: finalPortfolio,
      scenario,
      inflationIndex,
      ordinaryIncome,
      earnedIncome,
      retirementOrdinaryIncome: rothConversionAmount,
      ordinaryInvestmentIncome: dividends.ordinaryDividends,
      qualifiedDividends,
      adjustmentsToIncome,
      strategyShortTermGains,
      strategyLongTermGains,
      strategyCapitalLosses,
      strategyShortTermLosses,
      strategyLongTermLosses,
      withdrawal: finalWithdrawal,
      socialSecurityBenefits,
      lossCarryforward,
      age,
      spouseAge,
      yearIndex,
      magiHistory
    });
    const gainHarvest = harvestTaxGains(finalPortfolio, gainHarvestLimit, { calendarYear });
    strategyLongTermGains += gainHarvest.realizedGains;
    flows.push(...gainHarvest.flows);

    if (gainHarvest.realizedGains > 0) {
      const { income, taxableSocialSecurity } = incomeForYear({
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome: rothConversionAmount,
        ordinaryInvestmentIncome: dividends.ordinaryDividends,
        qualifiedDividends,
        adjustmentsToIncome,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        withdrawal: finalWithdrawal,
        socialSecurityBenefits,
        taxProfile: yearTaxProfile,
        scenario,
        lossCarryforward
      });
      finalTaxes = computeIncomeTax({
        ...income,
        capitalLossCarryforward: lossCarryforward,
        profile: yearTaxProfile
      });
      finalTaxes = addPenaltyTax(finalTaxes, finalWithdrawal.penaltyTax);
      const acaMagi = acaMagiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000);
      const irmaaMagi = irmaaMagiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000);
      finalAca = computeAcaForYear({ age, spouseAge, magi: acaMagi, config: yearAcaConfig, filingStatus: yearTaxProfile.filingStatus });
      if (!scenario.targetSpendIncludesMedical) {
        const medical = medicalCostForYear({
          scenario,
          aca: finalAca,
          yearAcaConfig,
          inflationIndex,
          age,
          spouseAge,
          yearIndex,
          filingStatus: yearTaxProfile.filingStatus,
          irmaaMagi,
          magiHistory
        });
        medicalEstimate = medical.total;
        finalMedicare = medical.medicare;
      }
      finalTaxableSocialSecurity = taxableSocialSecurity;
    }
  }

  const reconciled = reconcileCashRequirement({
    portfolio: finalPortfolio,
    withdrawal: finalWithdrawal,
    taxes: finalTaxes,
    aca: finalAca,
    medicare: finalMedicare,
    taxableSocialSecurity: finalTaxableSocialSecurity,
    medicalEstimate,
    scenario,
    yearTaxProfile,
    yearAcaConfig,
    inflationIndex,
    plannedSpending,
    hsaContributionAmount: hsaContribution.amount,
    dividends,
    incomeCashAvailable,
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome: rothConversionAmount,
    ordinaryInvestmentIncome: dividends.ordinaryDividends,
    qualifiedDividends,
    adjustmentsToIncome,
    strategyShortTermGains,
    strategyLongTermGains,
    strategyCapitalLosses,
    strategyShortTermLosses,
    strategyLongTermLosses,
    lossCarryforward,
    socialSecurityBenefits,
    hsaQualifiedExpenseBalance,
    age,
    spouseAge,
    yearIndex,
    calendarYear,
    magiHistory,
    sequenceRiskReserve,
    allocationStrategy
  });
  finalWithdrawal = reconciled.withdrawal;
  finalTaxes = reconciled.taxes;
  finalAca = reconciled.aca;
  finalMedicare = reconciled.medicare;
  finalTaxableSocialSecurity = reconciled.taxableSocialSecurity;
  finalRothBasisOptimization = reconciled.rothBasisOptimization ?? finalRothBasisOptimization;
  medicalEstimate = reconciled.medicalEstimate;

  const totalCashRequired = plannedSpending
    + (scenario.targetSpendIncludesMedical ? 0 : medicalEstimate)
    + (scenario.targetSpendIncludesTaxes ? 0 : finalTaxes.totalTax)
    + hsaContribution.amount;
  const { income: finalIncome, taxableSocialSecurity: reconciledTaxableSocialSecurity } = incomeForYear({
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome: rothConversionAmount,
    ordinaryInvestmentIncome: dividends.ordinaryDividends,
    qualifiedDividends,
    adjustmentsToIncome,
    strategyShortTermGains,
    strategyLongTermGains,
    strategyCapitalLosses,
    strategyShortTermLosses,
    strategyLongTermLosses,
    withdrawal: finalWithdrawal,
    socialSecurityBenefits,
    taxProfile: yearTaxProfile,
    scenario,
    lossCarryforward
  });
  finalTaxableSocialSecurity = reconciledTaxableSocialSecurity;
  const finalFederalAgi = round(federalAgiForIncome(finalIncome, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000), 6);
  const finalAcaMagi = round(acaMagiForIncome(finalIncome, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000), 6);
  const finalIrmaaMagi = round(irmaaMagiForIncome(finalIncome, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000), 6);
  const finalMagi = finalAcaMagi;
  // Use the same net-benefit gate as the conversion sizing so the displayed
  // ceiling reflects the actual cap the optimizer applied.
  const finalAcaMagiTarget = acaMagiCeiling({
    acaConfig: yearAcaConfig,
    currentMagi: finalMagi,
    maxFplPercent: scenario.rothConversion?.maxAcaFplPercent ?? 400,
    targetRate: scenario.rothConversion?.enabled
      ? effectiveRothConversionTargetRate({
          portfolio,
          scenario,
          age,
          taxProfile: yearTaxProfile,
          ordinaryIncome: finalIncome.ordinaryIncome
        })
      : null,
    magiBuffer: rothConversionMagiBuffer(scenario)
  });
  const taxAttribution = estimateTaxAttribution({
    taxProfile: yearTaxProfile,
    lossCarryforward,
    income: finalIncome,
    finalTaxes,
    earnedIncome: recurringEarnedIncome,
    oneOffCashFlows,
    dividends,
    rothConversionAmount,
    withdrawal: finalWithdrawal,
    hsaContribution,
    strategyShortTermGains,
    strategyLongTermGains,
    allocationStrategy,
    assetLocation,
    taxableSocialSecurity: finalTaxableSocialSecurity
  });
  flows.push(...finalWithdrawal.flows);
  if (socialSecurityBenefits > 0) {
    flows.push({
      from: "Social Security",
      to: "Spending reserve",
      amount: socialSecurityBenefits,
      type: "income"
    });
  }
  if (recurringEarnedIncome.cash > 0) {
    flows.push({
      from: "Earned income",
      to: "Spending reserve",
      amount: recurringEarnedIncome.cash,
      type: "income"
    });
  }
  if (oneOffCashFlows.income > 0) {
    flows.push({
      from: "One-off income",
      to: "Spending reserve",
      amount: oneOffCashFlows.income,
      type: "income"
    });
  }
  if (finalTaxes.totalTax > 0) {
    const incomeTax = Math.max(0, finalTaxes.totalTax - (finalTaxes.penaltyTax ?? 0));
    if (incomeTax > 0) flows.push({ from: "Spending reserve", to: "Tax payment", amount: incomeTax, type: "tax" });
    if ((finalTaxes.penaltyTax ?? 0) > 0) {
      flows.push({
        from: "Spending reserve",
        to: "Early withdrawal penalties",
        amount: finalTaxes.penaltyTax,
        type: "penalty"
      });
    }
  }
  if (medicalEstimate > 0) {
    flows.push({ from: "Spending reserve", to: "Medical", amount: medicalEstimate, type: "medical" });
  }
  if (hsaContribution.amount > 0) {
    addHsaContributionLot(finalPortfolio, hsaContribution, {
      calendarYear,
      returnAssumptions: scenario.returnAssumptions
    });
    flows.push({
      from: "Spending reserve",
      to: "HSA contribution",
      amount: hsaContribution.amount,
      type: "contribution"
    });
  }
  if (plannedSpendingDetail.strategy?.mode === "discretionaryGuardrails") {
    if (plannedSpendingDetail.essentialSpend > 0) {
      flows.push({
        from: "Spending reserve",
        to: "Essential spending",
        amount: plannedSpendingDetail.essentialSpend,
        type: "spending"
      });
    }
    if (plannedSpendingDetail.discretionarySpend > 0) {
      flows.push({
        from: "Spending reserve",
        to: "Discretionary spending",
        amount: plannedSpendingDetail.discretionarySpend,
        type: "spending"
      });
    }
    if (plannedSpendingDetail.oneOffExpenses > 0) {
      flows.push({
        from: "Spending reserve",
        to: "One-off spending",
        amount: plannedSpendingDetail.oneOffExpenses,
        type: "spending"
      });
    }
  } else if (plannedSpending > 0) {
    flows.push({ from: "Spending reserve", to: "Lifestyle and one-off spending", amount: plannedSpending, type: "spending" });
  }

  const cashAvailable = dividends.cash + incomeCashAvailable + socialSecurityBenefits + finalWithdrawal.cashRaised;
  const unspentCash = Math.max(0, cashAvailable - totalCashRequired);
  if (unspentCash > 1) {
    addTaxableCash(finalPortfolio, unspentCash, calendarYear);
    flows.push({ from: "Spending reserve", to: "Taxable cash reserve", amount: unspentCash, type: "balance" });
  }

  portfolio.splice(0, portfolio.length, ...finalPortfolio);
  removeEmptyLots(portfolio);
  const endingAssets = assetSnapshot(portfolio);
  const rothBasisSummary = rothBasisSummaryForYear(finalPortfolio, {
    age,
    calendarYear,
    penaltyAge: scenario.retirementPenaltyAge ?? 59.5
  });

  const cashShortfall = Math.max(0, totalCashRequired - cashAvailable);
  const unfunded = cashShortfall <= CASH_GAP_TOLERANCE ? 0 : cashShortfall;
  const finalHsaQualifiedExpenseBalance = hsaStrategyConfig(scenario).useForQualifiedExpenses
    ? round(Math.max(0, hsaQualifiedExpenseBalance + medicalEstimate - (finalWithdrawal.hsaProceeds ?? 0)), 6)
    : hsaQualifiedExpenseBalance;

  return {
    year: calendarYear,
    yearIndex: yearIndex + 1,
    age: round(age, 2),
    inflationIndex: round(inflationIndex, 6),
    beginningPortfolioValue,
    beginningAssets,
    assetClassReturns: summarizeAssetClassReturns(returnByAssetClass, annualInflationRate),
    afterReturnPortfolioValue,
    endingPortfolioValue: portfolioValue(portfolio),
    plannedSpending: round(plannedSpending, 6),
    spendingStrategy: plannedSpendingDetail.strategy,
    essentialSpending: round(plannedSpendingDetail.essentialSpend, 6),
    discretionarySpending: round(plannedSpendingDetail.discretionarySpend, 6),
    discretionarySpendingBudget: round(plannedSpendingDetail.discretionaryBudget, 6),
    spendingGuardrail: plannedSpendingDetail.guardrail,
    medicalCost: round(medicalEstimate, 6),
    medicare: finalMedicare,
    age65AdditionalDeduction: round(taxProfileContext.age65AdditionalDeduction, 6),
    qualifyingChildren: yearTaxProfile.qualifyingChildren,
    earnedIncome: round(recurringEarnedIncome.cash, 6),
    oneOffIncome: round(oneOffCashFlows.income, 6),
    oneOffExpenses: round(oneOffCashFlows.expenses, 6),
    oneOffIncomeDetails: oneOffCashFlows.incomeDetails,
    oneOffExpenseDetails: oneOffCashFlows.expenseDetails,
    medicareWages: round(earnedIncome.medicareWages, 6),
    selfEmploymentIncome: round(earnedIncome.selfEmploymentIncome, 6),
    rrtaCompensation: round(earnedIncome.rrtaCompensation, 6),
    socialSecurityBenefits: round(socialSecurityBenefits, 6),
    taxableSocialSecurity: round(finalTaxableSocialSecurity, 6),
    rmdAmount: round(rmdWithdrawal.cashRaised, 6),
    rmdRequired: round(rmd.amount, 6),
    rmdStartAge: rmd.startAge,
    rmdFactor: rmd.factor,
    rmdBase: round(rmd.base, 6),
    cashRaised: round(finalWithdrawal.cashRaised, 6),
    taxableDividendsCash: dividends.cash,
    taxableDividendDetails: dividends.details,
    cashAvailable: round(cashAvailable, 6),
    unspentCash: round(unspentCash, 6),
    totalCashRequired: round(totalCashRequired, 6),
    taxes: finalTaxes,
    taxAttribution,
    aca: finalAca,
    acaMagiCeiling: Number.isFinite(finalAcaMagiTarget.amount) ? finalAcaMagiTarget.amount : null,
    acaMagiCeilingFplPercent: Number.isFinite(finalAcaMagiTarget.fplPercent) ? finalAcaMagiTarget.fplPercent : null,
    federalAgi: finalFederalAgi,
    acaMagi: finalAcaMagi,
    irmaaMagi: finalIrmaaMagi,
    magi: finalMagi,
    realizedLongTermGains: round(strategyLongTermGains + finalWithdrawal.longTermCapitalGains, 6),
    taxGainHarvested: round(Math.max(
      0,
      strategyLongTermGains
        - allocationStrategy.longTermCapitalGains
        - assetLocation.longTermCapitalGains
    ), 6),
    realizedShortTermGains: round(strategyShortTermGains + finalWithdrawal.shortTermCapitalGains, 6),
    realizedCapitalLosses: round(strategyCapitalLosses + finalWithdrawal.capitalLosses, 6),
    lossCarryforward: finalTaxes.lossCarryforward,
    lossCarryforwardDetail: {
      shortTerm: finalTaxes.lossCarryforwardShort ?? 0,
      longTerm: finalTaxes.lossCarryforwardLong ?? finalTaxes.lossCarryforward ?? 0
    },
    rothConversionAmount: round(rothConversionAmount, 6),
    penaltyTax: round(finalTaxes.penaltyTax ?? 0, 6),
    penaltyBase: round(finalWithdrawal.penaltyBase ?? 0, 6),
    penaltyExceptionUsed: round(finalWithdrawal.penaltyExceptionUsed ?? 0, 6),
    penaltyExceptionRemaining: round(finalWithdrawal.penaltyExceptionRemaining ?? 0, 6),
    rothWithdrawals: round(finalWithdrawal.rothProceeds, 6),
    rothBasisUsed: round(finalWithdrawal.rothBasisUsed, 6),
    rothBasisRemaining: round(finalWithdrawal.rothBasisRemaining, 6),
    rothContributionBasisRemaining: round(finalWithdrawal.rothBasisRemaining, 6),
    rothConversionPrincipalRemaining: rothBasisSummary.conversionPrincipal,
    rothPenaltyFreeConversionPrincipal: rothBasisSummary.penaltyFreeConversionPrincipal,
    rothBasisAvailable: round(finalWithdrawal.rothBasisRemaining + rothBasisSummary.penaltyFreeConversionPrincipal, 6),
    rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
    rothBasisOptimization: finalRothBasisOptimization,
    hsaContribution,
    hsaWithdrawals: round(finalWithdrawal.hsaProceeds ?? 0, 6),
    hsaQualifiedExpenseBalance: finalHsaQualifiedExpenseBalance,
    sequenceRiskReserve,
    allocationStrategy,
    assetLocation,
    unfunded: round(unfunded, 6),
    flows: flows.filter((flow) => flow.amount > 0),
    sales: finalWithdrawal.sales,
    accounts: accountBreakdown(portfolio),
    assets: endingAssets
  };
}

function reconcileCashRequirement({
  portfolio,
  withdrawal,
  taxes,
  aca,
  medicare,
  taxableSocialSecurity,
  medicalEstimate,
  scenario,
  yearTaxProfile,
  yearAcaConfig,
  inflationIndex,
  plannedSpending,
  hsaContributionAmount = 0,
  dividends,
  incomeCashAvailable = 0,
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0,
  lossCarryforward,
  socialSecurityBenefits,
  hsaQualifiedExpenseBalance = 0,
  age,
  spouseAge,
  yearIndex,
  calendarYear,
  magiHistory,
  sequenceRiskReserve,
  allocationStrategy
}) {
  let currentWithdrawal = withdrawal;
  let currentTaxes = taxes;
  let currentAca = aca;
  let currentMedicare = medicare ?? emptyMedicareCost();
  let currentTaxableSocialSecurity = taxableSocialSecurity ?? 0;
  let currentMedicalEstimate = medicalEstimate;
  let currentRothBasisOptimization = null;

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const totalCashRequired = plannedSpending
      + (scenario.targetSpendIncludesMedical ? 0 : currentMedicalEstimate)
      + (scenario.targetSpendIncludesTaxes ? 0 : currentTaxes.totalTax)
      + hsaContributionAmount;
    const cashAvailable = dividends.cash + incomeCashAvailable + socialSecurityBenefits + currentWithdrawal.cashRaised;
    const gap = totalCashRequired - cashAvailable;
    if (gap <= CASH_GAP_TOLERANCE) break;

    const chosenTopUp = chooseWithdrawalPlan({
      portfolio,
      amount: gap,
      baseWithdrawal: currentWithdrawal,
      withdrawalOrder: scenario.withdrawalOrder,
      withdrawalContext: {
        age,
        calendarYear,
        penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
        penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
        rothBasisRemaining: currentWithdrawal.rothBasisRemaining,
        rothBasisAvailable: rothBasisAvailableForWithdrawal(portfolio, {
          rothBasisRemaining: currentWithdrawal.rothBasisRemaining,
          age,
          calendarYear,
          penaltyAge: scenario.retirementPenaltyAge ?? 59.5
        }),
        rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
        penaltyExceptionRemaining: currentWithdrawal.penaltyExceptionRemaining,
        returnAssumptions: scenario.returnAssumptions,
        optimizedLotSelection: isLifetimeOptimizerEnabled(scenario) || sequenceRiskReserve?.enabled,
        sequenceRiskReserve,
        allocationStrategy,
        hsaQualifiedExpenseAvailable: hsaQualifiedExpenseAvailableForWithdrawal({
          scenario,
          hsaQualifiedExpenseBalance,
          medicalEstimate: currentMedicalEstimate
        }) - (currentWithdrawal.hsaProceeds ?? 0)
      },
      evaluationContext: {
        scenario,
        yearTaxProfile,
        yearAcaConfig,
        inflationIndex,
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome,
        ordinaryInvestmentIncome,
        qualifiedDividends,
        adjustmentsToIncome,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        lossCarryforward,
        socialSecurityBenefits,
        age,
        spouseAge,
        yearIndex,
        magiHistory
      }
    });
    if (chosenTopUp.withdrawal.cashRaised <= currentWithdrawal.cashRaised + CASH_RAISED_EPSILON) break;

    portfolio.splice(0, portfolio.length, ...chosenTopUp.portfolio);
    currentWithdrawal = chosenTopUp.withdrawal;
    currentTaxableSocialSecurity = chosenTopUp.taxableSocialSecurity;
    currentTaxes = chosenTopUp.taxes;
    currentAca = chosenTopUp.aca;
    currentMedicalEstimate = scenario.targetSpendIncludesMedical ? 0 : chosenTopUp.medicalTotal;
    currentMedicare = chosenTopUp.medicare;
    currentRothBasisOptimization = chosenTopUp.rothBasisOptimization;
  }

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const totalCashRequired = plannedSpending
      + (scenario.targetSpendIncludesMedical ? 0 : currentMedicalEstimate)
      + (scenario.targetSpendIncludesTaxes ? 0 : currentTaxes.totalTax)
      + hsaContributionAmount;
    const cashAvailable = dividends.cash + incomeCashAvailable + socialSecurityBenefits + currentWithdrawal.cashRaised;
    const gap = totalCashRequired - cashAvailable;
    if (gap <= CASH_GAP_TOLERANCE) break;

    const forcedTopUp = evaluateWithdrawalPlan({
      portfolio,
      amount: gap,
      baseWithdrawal: currentWithdrawal,
      withdrawalOrder: forcedWithdrawalOrder(scenario.withdrawalOrder),
      withdrawalContext: {
        age,
        calendarYear,
        penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
        penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
        rothBasisRemaining: currentWithdrawal.rothBasisRemaining,
        rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
        penaltyExceptionRemaining: currentWithdrawal.penaltyExceptionRemaining,
        returnAssumptions: scenario.returnAssumptions,
        optimizedLotSelection: false,
        maxRothProceeds: Infinity,
        hsaQualifiedExpenseAvailable: hsaQualifiedExpenseAvailableForWithdrawal({
          scenario,
          hsaQualifiedExpenseBalance,
          medicalEstimate: currentMedicalEstimate
        }) - (currentWithdrawal.hsaProceeds ?? 0)
      },
      evaluationContext: {
        scenario,
        yearTaxProfile,
        yearAcaConfig,
        inflationIndex,
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome,
        ordinaryInvestmentIncome,
        qualifiedDividends,
        adjustmentsToIncome,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        lossCarryforward,
        socialSecurityBenefits,
        age,
        spouseAge,
        yearIndex,
        magiHistory
      }
    });
    if (forcedTopUp.withdrawal.cashRaised <= currentWithdrawal.cashRaised + CASH_RAISED_EPSILON) break;

    portfolio.splice(0, portfolio.length, ...forcedTopUp.portfolio);
    currentWithdrawal = forcedTopUp.withdrawal;
    currentTaxableSocialSecurity = forcedTopUp.taxableSocialSecurity;
    currentTaxes = forcedTopUp.taxes;
    currentAca = forcedTopUp.aca;
    currentMedicalEstimate = scenario.targetSpendIncludesMedical ? 0 : forcedTopUp.medicalTotal;
    currentMedicare = forcedTopUp.medicare;
  }

  return {
    withdrawal: currentWithdrawal,
    taxes: currentTaxes,
    aca: currentAca,
    medicare: currentMedicare,
    taxableSocialSecurity: currentTaxableSocialSecurity,
    medicalEstimate: currentMedicalEstimate,
    rothBasisOptimization: currentRothBasisOptimization
  };
}

function chooseWithdrawalPlan({
  portfolio,
  amount,
  baseWithdrawal,
  withdrawalOrder,
  withdrawalContext,
  evaluationContext
}) {
  const optimization = rothBasisOptimizationConfig(evaluationContext.scenario);
  const requestedOrder = normalizedWithdrawalOrder(withdrawalOrder);
  if (isLifetimeOptimizerEnabled(evaluationContext.scenario)) {
    return chooseLifetimeOptimizedWithdrawalPlan({
      portfolio,
      amount,
      baseWithdrawal,
      requestedOrder,
      withdrawalContext,
      evaluationContext,
      rothOptimization: optimization
    });
  }

  const baselineOrder = optimization.enabled ? rothPreservingWithdrawalOrder(requestedOrder) : requestedOrder;
  const baseline = evaluateWithdrawalPlan({
    portfolio,
    amount,
    baseWithdrawal,
    withdrawalOrder: baselineOrder,
    withdrawalContext,
    evaluationContext
  });

  if (optimization.enabled && amount > 0 && requestedOrder.includes("roth") && isBeforePenaltyAge(withdrawalContext)) {
    let penaltyCandidate = null;
    const penaltyOrders = uniqueWithdrawalOrders([
      earlyPenaltyAvoidanceWithdrawalOrder(requestedOrder),
      rothFirstWithdrawalOrder(requestedOrder)
    ]);
    for (const order of penaltyOrders) {
      if (sameWithdrawalOrder(order, baselineOrder)) continue;
      const candidate = evaluateWithdrawalPlan({
        portfolio,
        amount,
        baseWithdrawal,
        withdrawalOrder: order,
        withdrawalContext: {
          ...withdrawalContext,
          maxRothProceeds: optimizedRothProceedsLimit(withdrawalContext)
        },
        evaluationContext
      });
      if (hasLowerPenaltyBurden(candidate.withdrawal, baseline.withdrawal)
        && betterPenaltyAvoidancePlan(candidate, penaltyCandidate)) {
        penaltyCandidate = candidate;
      }
    }
    if (penaltyCandidate) {
      const metrics = rothOptimizationMetrics({
        baseline,
        candidate: penaltyCandidate,
        baseWithdrawal,
        withdrawalContext,
        evaluationContext,
        optimization
      });
      return withRothOptimizationDecision(penaltyCandidate, {
        enabled: true,
        accepted: true,
        reason: "early-penalty-avoidance",
        minSavingsRate: optimization.minSavingsRate,
        ...metrics
      });
    }
  }

  if (!optimization.enabled || amount <= 0 || !requestedOrder.includes("roth")) {
    return withRothOptimizationDecision(baseline, {
      enabled: optimization.enabled,
      accepted: false,
      reason: optimization.enabled ? "no-roth-substitution" : "disabled",
      minSavingsRate: optimization.minSavingsRate,
      extraRothWithdrawal: 0,
      modeledSavings: 0,
      requiredSavings: 0
    });
  }

  const candidateOrder = rothFirstWithdrawalOrder(requestedOrder);
  if (sameWithdrawalOrder(candidateOrder, baselineOrder)) {
    return withRothOptimizationDecision(baseline, {
      enabled: true,
      accepted: false,
      reason: "already-roth-first",
      minSavingsRate: optimization.minSavingsRate,
      extraRothWithdrawal: 0,
      modeledSavings: 0,
      requiredSavings: 0
    });
  }

  const candidate = evaluateWithdrawalPlan({
    portfolio,
    amount,
    baseWithdrawal,
    withdrawalOrder: candidateOrder,
    withdrawalContext: {
      ...withdrawalContext,
      maxRothProceeds: optimizedRothProceedsLimit(withdrawalContext)
    },
    evaluationContext
  });
  const metrics = rothOptimizationMetrics({
    baseline,
    candidate,
    baseWithdrawal,
    withdrawalContext,
    evaluationContext,
    optimization
  });
  const accepted = metrics.extraRothWithdrawal > 0.000001
    && metrics.modeledSavings > 0.01
    && metrics.modeledSavings + 0.01 >= metrics.requiredSavings;

  return withRothOptimizationDecision(accepted ? candidate : baseline, {
    enabled: true,
    accepted,
    reason: accepted ? "savings-hurdle-met" : "savings-below-hurdle",
    minSavingsRate: optimization.minSavingsRate,
    ...metrics
  });
}

function chooseLifetimeOptimizedWithdrawalPlan({
  portfolio,
  amount,
  baseWithdrawal,
  requestedOrder,
  withdrawalContext,
  evaluationContext,
  rothOptimization
}) {
  const config = withdrawalStrategyConfig(evaluationContext.scenario);
  const baseOrder = rothOptimization.enabled ? rothPreservingWithdrawalOrder(requestedOrder) : requestedOrder;
  const baseline = evaluateWithdrawalPlan({
    portfolio,
    amount,
    baseWithdrawal,
    withdrawalOrder: baseOrder,
    withdrawalContext: {
      ...withdrawalContext,
      optimizedLotSelection: true
    },
    evaluationContext
  });
  let best = withRothOptimizationDecision(baseline, {
    enabled: rothOptimization.enabled,
    accepted: false,
    reason: "lifetime-baseline",
    minSavingsRate: rothOptimization.minSavingsRate,
    extraRothWithdrawal: 0,
    modeledSavings: 0,
    requiredSavings: 0
  });
  let bestScore = lifetimeWithdrawalScore(best, config, evaluationContext.scenario);

  const candidates = optimizedWithdrawalCandidates({
    requestedOrder,
    baseline,
    baseWithdrawal,
    amount,
    withdrawalContext,
    evaluationContext,
    rothOptimization
  });

  for (const candidateConfig of candidates) {
    const candidate = evaluateWithdrawalPlan({
      portfolio,
      amount,
      baseWithdrawal,
      withdrawalOrder: candidateConfig.order,
      withdrawalContext: {
        ...withdrawalContext,
        optimizedLotSelection: true,
        ...(Number.isFinite(candidateConfig.maxRothProceeds) ? { maxRothProceeds: candidateConfig.maxRothProceeds } : {})
      },
      evaluationContext
    });
    const metrics = rothOptimizationMetrics({
      baseline,
      candidate,
      baseWithdrawal,
      withdrawalContext,
      evaluationContext,
      optimization: rothOptimization
    });
    const avoidsEarlyPenalty = hasLowerPenaltyBurden(candidate.withdrawal, baseline.withdrawal);

    if (metrics.extraRothWithdrawal > 0.000001
      && !avoidsEarlyPenalty
      && (!rothOptimization.enabled
        || metrics.modeledSavings <= 0.01
        || metrics.modeledSavings + 0.01 < metrics.requiredSavings)) {
      continue;
    }

    const annotated = withRothOptimizationDecision(candidate, {
      enabled: rothOptimization.enabled,
      accepted: metrics.extraRothWithdrawal > 0.000001,
      reason: avoidsEarlyPenalty
        ? "early-penalty-avoidance"
        : metrics.extraRothWithdrawal > 0.000001 ? "lifetime-savings-hurdle-met" : "lifetime-lower-cost-source",
      minSavingsRate: rothOptimization.minSavingsRate,
      ...metrics
    });
    const score = lifetimeWithdrawalScore(annotated, config, evaluationContext.scenario);
    const candidatePenalty = withdrawalPenaltyBurden(annotated.withdrawal);
    const bestPenalty = withdrawalPenaltyBurden(best.withdrawal);
    if (candidatePenalty + 0.01 < bestPenalty) {
      best = annotated;
      bestScore = score;
    } else if (candidatePenalty <= bestPenalty + 0.01 && score + 0.01 < bestScore) {
      best = annotated;
      bestScore = score;
    }
  }

  return best;
}

function optimizedWithdrawalCandidates({
  requestedOrder,
  baseline,
  amount,
  withdrawalContext,
  evaluationContext,
  rothOptimization
}) {
  const canonical = ["taxable", "traditional", "hsa", "roth"].filter((accountType) => requestedOrder.includes(accountType));
  const orders = [
    requestedOrder,
    canonical,
    ["taxable", "hsa", "traditional", "roth"].filter((accountType) => requestedOrder.includes(accountType)),
    ["traditional", "taxable", "hsa", "roth"].filter((accountType) => requestedOrder.includes(accountType)),
    ["taxable", "roth", "traditional", "hsa"].filter((accountType) => requestedOrder.includes(accountType))
  ];
  if ((withdrawalContext.age ?? 99) >= (withdrawalContext.penaltyAge ?? 59.5)) {
    orders.push(["traditional", "hsa", "taxable", "roth"].filter((accountType) => requestedOrder.includes(accountType)));
  }
  if (requestedOrder.includes("roth")) {
    orders.push(rothFirstWithdrawalOrder(requestedOrder));
  }

  const uniqueOrders = uniqueWithdrawalOrders(orders)
    .filter((order) => order.length > 0);
  const candidates = uniqueOrders.map((order) => ({ order }));

  if (rothOptimization.enabled && isBeforePenaltyAge(withdrawalContext) && requestedOrder.includes("roth")) {
    candidates.push({
      order: earlyPenaltyAvoidanceWithdrawalOrder(requestedOrder),
      maxRothProceeds: optimizedRothProceedsLimit(withdrawalContext)
    });
  }

  if (rothOptimization.enabled && requestedOrder.includes("roth") && amount > 0) {
    const rothOrder = rothFirstWithdrawalOrder(requestedOrder);
    for (const limit of rothSubstitutionLimits({
      baseline,
      withdrawalContext,
      evaluationContext,
      amount,
      rothOptimization
    })) {
      candidates.push({ order: rothOrder, maxRothProceeds: limit });
    }
  }

  return candidates;
}

function rothSubstitutionLimits({ baseline, withdrawalContext, evaluationContext, amount, rothOptimization }) {
  const maxRoth = optimizedRothProceedsLimit(withdrawalContext);
  if (!(maxRoth > 0)) return [];
  const baselineRoth = rothWithdrawalProceeds(baseline.withdrawal);
  const thresholds = magiOptimizationThresholds({
    magi: baseline.magi,
    yearTaxProfile: evaluationContext.yearTaxProfile,
    yearAcaConfig: evaluationContext.yearAcaConfig,
    magiBuffer: rothOptimization?.magiBuffer ?? 0
  });
  const limits = [Math.min(maxRoth, amount)];
  for (const threshold of thresholds) {
    const reductionNeeded = Math.max(0, baseline.magi - threshold);
    if (reductionNeeded > 0.000001) {
      limits.push(Math.min(maxRoth, baselineRoth + reductionNeeded));
    }
  }
  return [...new Set(limits.map((limit) => round(Math.max(0, Math.min(maxRoth, limit)), 6)))]
    .filter((limit) => limit > 0.000001)
    .sort((a, b) => a - b);
}

function magiOptimizationThresholds({ magi, yearTaxProfile, yearAcaConfig, magiBuffer = 0 }) {
  const thresholds = [];
  const acaBuffer = Math.max(0, Number(magiBuffer) || 0);
  if (yearAcaConfig?.enabled && yearAcaConfig.fpl > 0) {
    thresholds.push(...(yearAcaConfig.applicablePercentageTable ?? [])
      .map((row) => row.maxFplPercent)
      .filter((percent) => Number.isFinite(percent) && percent > 0)
      .map((percent) => Math.max(0, yearAcaConfig.fpl * percent / 100 - acaBuffer)));
    thresholds.push(Math.max(0, yearAcaConfig.fpl * ((yearAcaConfig.maxEligibleFplPercent ?? 400) / 100) - acaBuffer));
  }
  const niitThreshold = yearTaxProfile?.niit?.thresholds?.[yearTaxProfile.filingStatus];
  if (Number.isFinite(niitThreshold)) thresholds.push(niitThreshold);
  return thresholds
    .filter((threshold) => Number.isFinite(threshold) && threshold > 0 && threshold < magi - 0.000001)
    .sort((a, b) => b - a);
}

function rothOptimizationMetrics({
  baseline,
  candidate,
  baseWithdrawal,
  withdrawalContext,
  evaluationContext,
  optimization
}) {
  const baselineRoth = rothWithdrawalProceeds(baseline.withdrawal) - rothWithdrawalProceeds(baseWithdrawal);
  const candidateRoth = rothWithdrawalProceeds(candidate.withdrawal) - rothWithdrawalProceeds(baseWithdrawal);
  const extraRothWithdrawal = round(Math.max(0, candidateRoth - Math.max(0, baselineRoth)), 6);
  const modeledSavings = round(Math.max(0, baseline.modeledCost - candidate.modeledCost), 6);
  const opportunityCostRate = rothBasisOpportunityCostRate({
    baseline,
    candidate,
    extraRothWithdrawal,
    withdrawalContext,
    evaluationContext,
    optimization
  });
  return {
    extraRothWithdrawal,
    modeledSavings,
    requiredSavings: round(extraRothWithdrawal * opportunityCostRate, 6),
    opportunityCostRate
  };
}

function rothBasisOpportunityCostRate({
  baseline,
  candidate,
  extraRothWithdrawal,
  withdrawalContext,
  evaluationContext,
  optimization
}) {
  if (!(extraRothWithdrawal > 0)) return 0;
  if (optimization?.opportunityCostMode === "fixed") {
    return round(clampFiniteNumber(optimization.minSavingsRate, 0, 1, 0.5), 6);
  }

  const scenario = evaluationContext.scenario ?? {};
  const taxProfile = evaluationContext.yearTaxProfile;
  const years = rothOpportunityCostYears({
    withdrawalContext,
    scenario,
    yearIndex: evaluationContext.yearIndex
  });
  const futureOrdinaryRate = estimatedFutureOrdinaryIncomeRate({
    portfolio: candidate.portfolio ?? [],
    scenario,
    age: withdrawalContext.age,
    taxProfile,
    ordinaryIncome: evaluationContext.ordinaryIncome ?? 0
  });
  const futureCapitalGainRate = estimatedFutureCapitalGainRate({
    taxProfile,
    scenario,
    portfolio: candidate.portfolio ?? []
  });
  const avoidedSales = avoidedSalesFromBaseline(baseline.withdrawal, candidate.withdrawal);
  const retainedTaxRate = weightedRetainedFutureTaxRate(avoidedSales, {
    futureOrdinaryRate,
    futureCapitalGainRate,
    scenario
  });
  const retainedReturn = weightedSaleExpectedReturn(avoidedSales, scenario.returnAssumptions);
  const extraRothSales = extraRothSalesFromCandidate(baseline.withdrawal, candidate.withdrawal);
  const rothReturn = weightedSaleExpectedReturn(extraRothSales, scenario.returnAssumptions);
  const discountReturn = Math.max(0.01, rothReturn);
  const relativeGrowth = Math.pow((1 + Math.max(-0.5, retainedReturn)) / (1 + discountReturn), years);
  const futureTaxCost = retainedTaxRate * relativeGrowth;
  const taxableDrag = retainedTaxRate > 0
    ? 0
    : Math.max(0, rothReturn - retainedReturn) * Math.min(years, 10) * 0.15;
  const rawRate = futureTaxCost + taxableDrag;
  const capped = clampFiniteNumber(rawRate, 0, optimization?.minSavingsRate ?? 0.5, 0.15);
  return round(capped, 6);
}

function clampFiniteNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function rothOpportunityCostYears({ withdrawalContext, scenario, yearIndex = 0 }) {
  const configured = Number(scenario?.rothBasisOptimization?.opportunityCostYears);
  if (Number.isFinite(configured) && configured > 0) return Math.min(40, configured);
  const age = Number(withdrawalContext?.age);
  const remainingPlanYears = Math.max(1, Number(scenario?.planYears ?? 30) - Number(yearIndex ?? 0));
  if (Number.isFinite(age) && age < 65 && scenario?.aca?.enabled !== false) {
    return Math.max(1, Math.min(remainingPlanYears, 65 - age));
  }
  if (Number.isFinite(age)) return Math.max(1, Math.min(remainingPlanYears, 85 - age));
  return Math.min(remainingPlanYears, 20);
}

function avoidedSalesFromBaseline(baselineWithdrawal = {}, candidateWithdrawal = {}) {
  const candidateByKey = saleProceedsByKey(candidateWithdrawal.sales ?? [], (sale) => sale.accountType !== "roth");
  return (baselineWithdrawal.sales ?? [])
    .filter((sale) => sale.accountType !== "roth")
    .map((sale) => {
      const key = saleKey(sale);
      const candidateProceeds = candidateByKey.get(key) ?? 0;
      const avoidedProceeds = Math.max(0, (sale.proceeds ?? 0) - candidateProceeds);
      return avoidedProceeds > 0.000001 ? { ...sale, proceeds: round(avoidedProceeds, 6) } : null;
    })
    .filter(Boolean);
}

function extraRothSalesFromCandidate(baselineWithdrawal = {}, candidateWithdrawal = {}) {
  const baselineByKey = saleProceedsByKey(baselineWithdrawal.sales ?? [], (sale) => sale.accountType === "roth");
  return (candidateWithdrawal.sales ?? [])
    .filter((sale) => sale.accountType === "roth")
    .map((sale) => {
      const key = saleKey(sale);
      const baselineProceeds = baselineByKey.get(key) ?? 0;
      const extraProceeds = Math.max(0, (sale.proceeds ?? 0) - baselineProceeds);
      return extraProceeds > 0.000001 ? { ...sale, proceeds: round(extraProceeds, 6) } : null;
    })
    .filter(Boolean);
}

function saleProceedsByKey(sales = [], predicate = () => true) {
  const map = new Map();
  for (const sale of sales) {
    if (!predicate(sale)) continue;
    const key = saleKey(sale);
    map.set(key, (map.get(key) ?? 0) + Math.max(0, sale.proceeds ?? 0));
  }
  return map;
}

function saleKey(sale = {}) {
  return `${sale.accountType ?? ""}|${sale.assetId ?? sale.id ?? sale.name ?? ""}`;
}

function weightedRetainedFutureTaxRate(sales = [], { futureOrdinaryRate, futureCapitalGainRate, scenario }) {
  const total = sales.reduce((sum, sale) => sum + Math.max(0, sale.proceeds ?? 0), 0);
  if (!(total > 0)) return Math.max(0, futureOrdinaryRate ?? 0) * 0.5;
  return sales.reduce((sum, sale) => {
    const proceeds = Math.max(0, sale.proceeds ?? 0);
    const weight = proceeds / total;
    if (sale.accountType === "traditional") return sum + weight * Math.max(0, futureOrdinaryRate ?? 0);
    if (sale.accountType === "taxable") {
      const gainRatio = proceeds > 0 ? Math.max(0, sale.gain ?? 0) / proceeds : 0;
      return sum + weight * Math.max(0, futureCapitalGainRate ?? 0) * Math.min(1, gainRatio);
    }
    if (sale.accountType === "hsa") {
      const hsaQualified = scenario?.taxEfficiencyStrategy?.hsaUseForQualifiedExpenses === true
        || scenario?.taxEfficiencyStrategy?.hsaContributionEnabled === true;
      return sum + weight * (hsaQualified ? 0 : Math.max(0, futureOrdinaryRate ?? 0));
    }
    return sum;
  }, 0);
}

function weightedSaleExpectedReturn(sales = [], returnAssumptions = {}) {
  const total = sales.reduce((sum, sale) => sum + Math.max(0, sale.proceeds ?? 0), 0);
  if (!(total > 0)) return 0;
  return sales.reduce((sum, sale) => {
    const proceeds = Math.max(0, sale.proceeds ?? 0);
    const explicit = Number(sale.expectedReturn);
    const assumed = Number.isFinite(explicit)
      ? explicit
      : expectedReturnForAsset(sale, returnAssumptions);
    return sum + (proceeds / total) * (Number.isFinite(assumed) ? assumed : 0);
  }, 0);
}

function uniqueWithdrawalOrders(orders) {
  const seen = new Set();
  const result = [];
  for (const order of orders) {
    const normalized = normalizedWithdrawalOrder(order);
    const key = normalized.join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function lifetimeWithdrawalScore(plan, config, scenario) {
  const heirTaxRate = scenario?.heirOrdinaryTaxRate ?? 0.24;
  const heirValue = plan.portfolio ? estimateHeirValueBreakdown(plan.portfolio, heirTaxRate).afterTaxValue : 0;
  return round(
    plan.modeledCost
      + Math.max(0, plan.withdrawal?.saleOpportunityCost ?? 0) * config.expectedReturnPenaltyYears
      - heirValue,
    6
  );
}

function evaluateWithdrawalPlan({
  portfolio,
  amount,
  baseWithdrawal,
  withdrawalOrder,
  withdrawalContext,
  evaluationContext
}) {
  const workingPortfolio = clonePortfolio(portfolio);
  const voluntaryWithdrawal = withdrawForCash(
    workingPortfolio,
    amount,
    withdrawalOrder,
    withdrawalContext
  );
  const withdrawal = mergeWithdrawals(baseWithdrawal, voluntaryWithdrawal);
  return {
    portfolio: workingPortfolio,
    voluntaryWithdrawal,
    withdrawal,
    ...evaluateWithdrawalState({
      ...evaluationContext,
      withdrawal
    })
  };
}

function evaluateWithdrawalState({
  scenario,
  yearTaxProfile,
  yearAcaConfig,
  inflationIndex,
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0,
  lossCarryforward,
  socialSecurityBenefits,
  age,
  spouseAge,
  yearIndex,
  magiHistory,
  withdrawal
}) {
  const { income, taxableSocialSecurity } = incomeForYear({
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome,
    ordinaryInvestmentIncome,
    qualifiedDividends,
    adjustmentsToIncome,
    strategyShortTermGains,
    strategyLongTermGains,
    strategyCapitalLosses,
    strategyShortTermLosses,
    strategyLongTermLosses,
    withdrawal,
    socialSecurityBenefits,
    taxProfile: yearTaxProfile,
    scenario,
    lossCarryforward
  });
  const taxes = computeIncomeTax({
    ...income,
    capitalLossCarryforward: lossCarryforward,
    profile: yearTaxProfile
  });
  const taxesWithPenalties = addPenaltyTax(taxes, withdrawal.penaltyTax);
  const federalAgi = round(federalAgiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000), 6);
  const acaMagi = round(acaMagiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000), 6);
  const irmaaMagi = round(irmaaMagiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000), 6);
  const aca = computeAcaForYear({ age, spouseAge, magi: acaMagi, config: yearAcaConfig, filingStatus: yearTaxProfile.filingStatus });
  const medical = medicalCostForYear({
    scenario,
    aca,
    yearAcaConfig,
    inflationIndex,
    age,
    spouseAge,
    yearIndex,
    filingStatus: yearTaxProfile.filingStatus,
    irmaaMagi,
    magiHistory
  });

  return {
    income,
    taxableSocialSecurity,
    taxes: taxesWithPenalties,
    aca,
    medicare: medical.medicare,
    medicalTotal: medical.total,
    modeledCost: round(taxesWithPenalties.totalTax + medical.total, 6),
    federalAgi,
    acaMagi,
    irmaaMagi,
    magi: acaMagi
  };
}

function withRothOptimizationDecision(plan, decision) {
  return {
    ...plan,
    rothBasisOptimization: {
      ...decision,
      extraRothWithdrawal: round(decision.extraRothWithdrawal ?? 0, 6),
      modeledSavings: round(decision.modeledSavings ?? 0, 6),
      requiredSavings: round(decision.requiredSavings ?? 0, 6),
      opportunityCostRate: round(decision.opportunityCostRate ?? 0, 6)
    }
  };
}

function rothBasisOptimizationConfig(scenario) {
  const config = scenario.rothBasisOptimization ?? {};
  const minSavingsRate = Number(config.minSavingsRate);
  const magiBuffer = Number(config.magiBuffer);
  const opportunityCostMode = config.opportunityCostMode === "fixed" ? "fixed" : "dynamic";
  return {
    enabled: config.enabled !== false,
    minSavingsRate: Number.isFinite(minSavingsRate) && minSavingsRate >= 0 ? minSavingsRate : 0.5,
    opportunityCostMode,
    magiBuffer: Number.isFinite(magiBuffer) && magiBuffer >= 0 ? magiBuffer : 1000
  };
}

function withdrawalStrategyConfig(scenario) {
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

function sequenceRiskReserveConfig(scenario) {
  const config = scenario.sequenceRiskReserve ?? {};
  const targetYears = Number(config.targetYears);
  const tentYears = Number(config.tentYears);
  const triggerStockReturn = Number(config.triggerStockReturn);
  const mode = ["cash", "bond", "hybrid"].includes(config.mode) ? config.mode : "cash";
  return {
    enabled: config.enabled === true,
    mode,
    assetClasses: reserveAssetClassesForMode(mode),
    targetYears: Number.isFinite(targetYears) && targetYears > 0 ? targetYears : 3,
    tentYears: Number.isFinite(tentYears) && tentYears > 0 ? tentYears : 10,
    triggerStockReturn: Number.isFinite(triggerStockReturn) ? triggerStockReturn : 0
  };
}

function sequenceRiskReserveStateForYear({ scenario, portfolio, plannedSpending, returnByAssetClass, yearIndex }) {
  const config = sequenceRiskReserveConfig(scenario);
  if (!config.enabled) {
    return {
      enabled: false,
      mode: config.mode,
      assetClasses: config.assetClasses,
      targetValue: 0,
      currentValue: 0,
      spendReserveFirst: false,
      preserveReserve: false
    };
  }

  const targetValue = round(Math.max(0, plannedSpending) * config.targetYears, 6);
  const currentValue = reserveAssetValue(portfolio, config.assetClasses);
  const inTentWindow = yearIndex < config.tentYears;
  const stockReturn = Number(returnByAssetClass?.stock);
  const stressYear = Number.isFinite(stockReturn) && stockReturn <= config.triggerStockReturn;
  return {
    enabled: true,
    mode: config.mode,
    assetClasses: config.assetClasses,
    targetValue,
    currentValue,
    stockReturn: Number.isFinite(stockReturn) ? round(stockReturn, 6) : null,
    spendReserveFirst: inTentWindow && stressYear && currentValue > 0,
    preserveReserve: inTentWindow && !stressYear && currentValue < targetValue
  };
}

function reserveAssetClassesForMode(mode) {
  if (mode === "bond") return ["bond", "tips"];
  if (mode === "hybrid") return ["cash", "bond", "tips"];
  return ["cash"];
}

function reserveAssetValue(portfolio = [], assetClasses = []) {
  const reserveClasses = new Set(assetClasses);
  return round(portfolio
    .filter((asset) => reserveClasses.has(asset.assetClass))
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
}

function hsaStrategyConfig(scenario) {
  const config = scenario.taxEfficiencyStrategy ?? {};
  const contribution = optionalFiniteNumber(config.hsaAnnualContribution);
  return {
    marginalRateOptimizationEnabled: config.marginalRateOptimizationEnabled !== false,
    assetLocationEnabled: config.assetLocationEnabled === true,
    hsaContributionEnabled: config.hsaContributionEnabled === true,
    hsaCoverage: ["auto", "self", "family"].includes(config.hsaCoverage) ? config.hsaCoverage : "auto",
    hsaAnnualContribution: contribution,
    hsaContributionInflationAdjusted: config.hsaContributionInflationAdjusted !== false,
    hsaCatchUpEnabled: config.hsaCatchUpEnabled !== false,
    hsaInvestmentAssetClass: GROWTH_ASSET_CLASSES.includes(config.hsaInvestmentAssetClass)
      || DEFENSIVE_ASSET_CLASSES.includes(config.hsaInvestmentAssetClass)
      ? config.hsaInvestmentAssetClass
      : "stock",
    useForQualifiedExpenses: config.hsaUseForQualifiedExpenses === true || config.hsaContributionEnabled === true,
    startingQualifiedExpenseBalance: Math.max(0, Number(config.startingHsaQualifiedExpenseBalance) || 0)
  };
}

function hsaContributionForYear({ scenario, age, spouseAge, inflationIndex }) {
  const config = hsaStrategyConfig(scenario);
  if (!config.hsaContributionEnabled || age >= 65) {
    return emptyHsaContribution(config);
  }

  const coverage = config.hsaCoverage === "auto"
    ? (Number(scenario.aca?.marketplaceMembers) || 1) > 1 ? "family" : "self"
    : config.hsaCoverage;
  const baseLimit = coverage === "family" ? HSA_LIMITS_2026.family : HSA_LIMITS_2026.selfOnly;
  const catchUp = config.hsaCatchUpEnabled
    ? (age >= 55 && age < 65 ? HSA_LIMITS_2026.catchUp55 : 0)
      + (coverage === "family" && Number.isFinite(spouseAge) && spouseAge >= 55 && spouseAge < 65
        ? HSA_LIMITS_2026.catchUp55
        : 0)
    : 0;
  const automaticLimit = baseLimit + catchUp;
  const requested = config.hsaAnnualContribution == null
    ? automaticLimit
    : Math.min(config.hsaAnnualContribution, automaticLimit);
  const index = config.hsaContributionInflationAdjusted ? inflationIndex : 1;
  const amount = round(Math.max(0, requested) * Math.max(0, index), 6);

  return {
    enabled: true,
    amount,
    coverage,
    baseLimit: round(baseLimit * Math.max(0, index), 6),
    catchUpLimit: round(catchUp * Math.max(0, index), 6),
    assetClass: config.hsaInvestmentAssetClass
  };
}

function emptyHsaContribution(config = hsaStrategyConfig({})) {
  return {
    enabled: false,
    amount: 0,
    coverage: config.hsaCoverage ?? "auto",
    baseLimit: 0,
    catchUpLimit: 0,
    assetClass: config.hsaInvestmentAssetClass ?? "stock"
  };
}

function hsaQualifiedExpenseAvailableForWithdrawal({ scenario, hsaQualifiedExpenseBalance = 0, medicalEstimate = 0 }) {
  const config = hsaStrategyConfig(scenario);
  if (!config.useForQualifiedExpenses) return Infinity;
  return round(Math.max(0, hsaQualifiedExpenseBalance + Math.max(0, medicalEstimate)), 6);
}

function addHsaContributionLot(portfolio, contribution, { calendarYear = null, returnAssumptions = {} } = {}) {
  const amount = Math.max(0, contribution?.amount ?? 0);
  if (amount <= CASH_RAISED_EPSILON) return;

  const assetClass = contribution.assetClass ?? "stock";
  const template = portfolio.find((asset) => (
    asset.accountType === "hsa"
    && asset.assetClass === assetClass
    && marketValue(asset) > CASH_RAISED_EPSILON
  ));
  const price = Math.max(CASH_RAISED_EPSILON, Number(template?.price) || 1);
  portfolio.push({
    id: `hsa-contribution-${calendarYear ?? "na"}-${portfolio.length + 1}`,
    name: `${assetClassLabel(assetClass)} HSA contribution`,
    accountType: "hsa",
    assetClass,
    units: round(amount / price, 8),
    price: round(price, 8),
    costBasisPerUnit: round(price, 8),
    holdingPeriod: "long",
    expectedReturn: Number.isFinite(Number(template?.expectedReturn))
      ? Number(template.expectedReturn)
      : expectedReturnForAsset({ assetClass }, returnAssumptions),
    ...(Number.isFinite(Number(template?.dividendYield)) ? { dividendYield: Number(template.dividendYield) } : {}),
    ...(Number.isFinite(Number(template?.qualifiedDividendShare))
      ? { qualifiedDividendShare: Number(template.qualifiedDividendShare) }
      : {})
  });
}

function assetLocationStateForYear({ scenario, portfolio, calendarYear }) {
  const config = hsaStrategyConfig(scenario);
  if (!config.assetLocationEnabled) return emptyAssetLocationResult();
  return applyTaxEfficientAssetLocation(portfolio, { calendarYear });
}

function emptyAssetLocationResult() {
  return {
    enabled: false,
    relocatedAmount: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    sales: [],
    flows: []
  };
}

function applyTaxEfficientAssetLocation(portfolio, { calendarYear = null } = {}) {
  const result = { ...emptyAssetLocationResult(), enabled: true };
  let guard = 0;

  while (guard < 50) {
    guard += 1;
    const taxableIncomeAsset = portfolio
      .filter((asset) => (
        asset.accountType === "taxable"
        && ["bond", "tips"].includes(asset.assetClass)
        && marketValue(asset) > CASH_RAISED_EPSILON
      ))
      .sort(assetLocationTaxableIncomeSort)[0];
    const traditionalGrowthAsset = portfolio
      .filter((asset) => (
        asset.accountType === "traditional"
        && GROWTH_ASSET_CLASSES.includes(asset.assetClass)
        && marketValue(asset) > CASH_RAISED_EPSILON
      ))
      .sort((a, b) => expectedReturnForAsset(b) - expectedReturnForAsset(a))[0];

    if (!taxableIncomeAsset || !traditionalGrowthAsset) break;
    const amount = Math.min(marketValue(taxableIncomeAsset), marketValue(traditionalGrowthAsset));
    if (amount <= CASH_RAISED_EPSILON) break;

    const taxableSale = sellFromLot(taxableIncomeAsset, amount);
    const shelteredSale = sellFromLot(traditionalGrowthAsset, amount);
    const swapAmount = Math.min(taxableSale.proceeds, shelteredSale.proceeds);
    if (swapAmount <= CASH_RAISED_EPSILON) break;

    result.relocatedAmount += swapAmount;
    result.sales.push(taxableSale, shelteredSale);
    applyRebalanceTaxCharacter(result, taxableSale);
    addReplacementLot(portfolio, {
      accountType: "taxable",
      assetClass: shelteredSale.assetClass,
      amount: swapAmount,
      source: traditionalGrowthAsset,
      calendarYear,
      label: "asset location"
    });
    addReplacementLot(portfolio, {
      accountType: "traditional",
      assetClass: taxableSale.assetClass,
      amount: swapAmount,
      source: taxableIncomeAsset,
      calendarYear,
      label: "asset location"
    });
    result.flows.push({
      from: taxableSale.name ?? taxableSale.assetId,
      to: "Asset location swap",
      amount: round(swapAmount, 6),
      type: "rebalance"
    });
    result.flows.push({
      from: "Asset location swap",
      to: `${accountLabel("taxable")} ${assetClassLabel(shelteredSale.assetClass)}`,
      amount: round(swapAmount, 6),
      type: "rebalance"
    });
  }

  result.relocatedAmount = round(result.relocatedAmount, 6);
  result.shortTermCapitalGains = round(result.shortTermCapitalGains, 6);
  result.longTermCapitalGains = round(result.longTermCapitalGains, 6);
  result.capitalLosses = round(result.capitalLosses, 6);
  result.shortTermCapitalLosses = round(result.shortTermCapitalLosses, 6);
  result.longTermCapitalLosses = round(result.longTermCapitalLosses, 6);
  removeEmptyLots(portfolio);
  return result;
}

function assetLocationTaxableIncomeSort(a, b) {
  const aIncome = Number(a.dividendYield) || 0;
  const bIncome = Number(b.dividendYield) || 0;
  if (aIncome !== bIncome) return bIncome - aIncome;
  return embeddedGainRatio(a) - embeddedGainRatio(b);
}

function addReplacementLot(portfolio, {
  accountType,
  assetClass,
  amount,
  source = {},
  calendarYear = null,
  label = "replacement"
}) {
  const price = Math.max(CASH_RAISED_EPSILON, Number(source.price) || 1);
  portfolio.push({
    id: `${label.replace(/\s+/g, "-")}-${calendarYear ?? "na"}-${accountType}-${assetClass}-${portfolio.length + 1}`,
    name: `${assetClassLabel(assetClass)} ${label}`,
    accountType,
    assetClass,
    units: round(amount / price, 8),
    price: round(price, 8),
    costBasisPerUnit: round(price, 8),
    holdingPeriod: accountType === "taxable" ? "short" : "long",
    ...(accountType === "taxable" && Number.isFinite(calendarYear)
      ? { holdingPeriodResetCalendarYear: calendarYear }
      : {}),
    ...(Number.isFinite(Number(source.expectedReturn)) ? { expectedReturn: Number(source.expectedReturn) } : {}),
    ...(Number.isFinite(Number(source.dividendYield)) ? { dividendYield: Number(source.dividendYield) } : {}),
    ...(Number.isFinite(Number(source.qualifiedDividendShare))
      ? { qualifiedDividendShare: Number(source.qualifiedDividendShare) }
      : {})
  });
}

function allocationStrategyConfig(scenario, yearIndex = 0) {
  const config = scenario.allocationStrategy ?? {};
  const targetStockPercent = finitePercent(config.targetStockPercent, 70);
  const rebalanceBandPercent = finitePercent(config.rebalanceBandPercent, 5);
  const glidepathStartStockPercent = finitePercent(config.glidepathStartStockPercent, 60);
  const glidepathEndStockPercent = finitePercent(config.glidepathEndStockPercent, 80);
  const glidepathYears = Number.isFinite(Number(config.glidepathYears))
    ? Math.max(1, Math.trunc(Number(config.glidepathYears)))
    : 15;
  const glidepathEnabled = config.glidepathEnabled === true;
  const progress = glidepathEnabled
    ? Math.min(1, Math.max(0, yearIndex) / Math.max(1, glidepathYears - 1))
    : 0;
  const activeTargetStockPercent = glidepathEnabled
    ? glidepathStartStockPercent + ((glidepathEndStockPercent - glidepathStartStockPercent) * progress)
    : targetStockPercent;
  const preferredDefensiveAssetClass = DEFENSIVE_ASSET_CLASSES.includes(config.preferredDefensiveAssetClass)
    ? config.preferredDefensiveAssetClass
    : "bond";

  return {
    rebalanceEnabled: config.rebalanceEnabled === true,
    withdrawalBiasEnabled: config.withdrawalBiasEnabled === true,
    glidepathEnabled,
    targetStockPercent,
    activeTargetStockPercent,
    targetStockShare: activeTargetStockPercent / 100,
    rebalanceBandPercent,
    rebalanceBandShare: rebalanceBandPercent / 100,
    glidepathStartStockPercent,
    glidepathEndStockPercent,
    glidepathYears,
    preferredDefensiveAssetClass
  };
}

function allocationStrategyStateForYear({ scenario, portfolio, yearIndex, calendarYear }) {
  const config = allocationStrategyConfig(scenario, yearIndex);
  const before = managedStockAllocationSnapshot(portfolio);
  const rebalancing = config.rebalanceEnabled
    ? rebalancePortfolioToStockTarget(portfolio, config, { calendarYear })
    : emptyRebalanceResult();
  const after = managedStockAllocationSnapshot(portfolio);

  return {
    enabled: config.rebalanceEnabled || config.withdrawalBiasEnabled || config.glidepathEnabled,
    rebalanceEnabled: config.rebalanceEnabled,
    withdrawalBiasEnabled: config.withdrawalBiasEnabled,
    glidepathEnabled: config.glidepathEnabled,
    targetStockPercent: round(config.activeTargetStockPercent, 6),
    baseTargetStockPercent: round(config.targetStockPercent, 6),
    rebalanceBandPercent: round(config.rebalanceBandPercent, 6),
    glidepathStartStockPercent: round(config.glidepathStartStockPercent, 6),
    glidepathEndStockPercent: round(config.glidepathEndStockPercent, 6),
    glidepathYears: config.glidepathYears,
    stockShareBeforePercent: before.managedValue > 0 ? round(before.stockShare * 100, 6) : null,
    stockShareAfterPercent: after.managedValue > 0 ? round(after.stockShare * 100, 6) : null,
    managedValueBefore: before.managedValue,
    managedValueAfter: after.managedValue,
    ...rebalancing
  };
}

function managedStockAllocationSnapshot(portfolio = []) {
  const stockValue = round(portfolio
    .filter((asset) => asset.assetClass === "stock")
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
  const defensiveValue = round(portfolio
    .filter((asset) => DEFENSIVE_ASSET_CLASSES.includes(asset.assetClass))
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
  const managedValue = round(stockValue + defensiveValue, 6);
  return {
    stockValue,
    defensiveValue,
    managedValue,
    stockShare: managedValue > 0 ? stockValue / managedValue : 0
  };
}

function emptyRebalanceResult() {
  return {
    rebalancedAmount: 0,
    direction: null,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    sales: [],
    flows: []
  };
}

function rebalancePortfolioToStockTarget(portfolio, config, { calendarYear = null } = {}) {
  const snapshot = managedStockAllocationSnapshot(portfolio);
  if (!(snapshot.managedValue > 0)) return emptyRebalanceResult();

  const lowerBand = Math.max(0, config.targetStockShare - config.rebalanceBandShare);
  const upperBand = Math.min(1, config.targetStockShare + config.rebalanceBandShare);
  if (snapshot.stockShare >= lowerBand - 0.000001 && snapshot.stockShare <= upperBand + 0.000001) {
    return emptyRebalanceResult();
  }

  const sellStock = snapshot.stockShare > upperBand;
  const targetStockValue = snapshot.managedValue * config.targetStockShare;
  const requestedAmount = sellStock
    ? Math.max(0, snapshot.stockValue - targetStockValue)
    : Math.max(0, targetStockValue - snapshot.stockValue);
  if (!(requestedAmount > CASH_RAISED_EPSILON)) return emptyRebalanceResult();

  const result = emptyRebalanceResult();
  result.direction = sellStock ? "sell-stock" : "buy-stock";
  let remaining = requestedAmount;
  const candidates = portfolio
    .filter((asset) => sellStock
      ? asset.assetClass === "stock" && marketValue(asset) > 0
      : DEFENSIVE_ASSET_CLASSES.includes(asset.assetClass) && marketValue(asset) > 0)
    .sort(rebalanceSaleSort);

  for (const asset of candidates) {
    if (remaining <= CASH_RAISED_EPSILON) break;
    const sale = sellFromLot(asset, remaining);
    if (sale.proceeds <= CASH_RAISED_EPSILON) continue;

    remaining -= sale.proceeds;
    result.rebalancedAmount += sale.proceeds;
    result.sales.push(sale);
    applyRebalanceTaxCharacter(result, sale);
    addRebalancedLot(portfolio, sale, {
      destinationGroup: sellStock ? "defensive" : "stock",
      preferredDefensiveAssetClass: config.preferredDefensiveAssetClass,
      calendarYear
    });
    result.flows.push({
      from: sale.name ?? sale.assetId,
      to: "Allocation rebalance",
      amount: round(sale.proceeds, 6),
      type: "rebalance"
    });
    result.flows.push({
      from: "Allocation rebalance",
      to: sellStock ? "Defensive sleeve" : "Stock sleeve",
      amount: round(sale.proceeds, 6),
      type: "rebalance"
    });
  }

  result.rebalancedAmount = round(result.rebalancedAmount, 6);
  result.shortTermCapitalGains = round(result.shortTermCapitalGains, 6);
  result.longTermCapitalGains = round(result.longTermCapitalGains, 6);
  result.capitalLosses = round(result.capitalLosses, 6);
  result.shortTermCapitalLosses = round(result.shortTermCapitalLosses, 6);
  result.longTermCapitalLosses = round(result.longTermCapitalLosses, 6);
  return result;
}

function rebalanceSaleSort(a, b) {
  const aTaxable = a.accountType === "taxable";
  const bTaxable = b.accountType === "taxable";
  if (aTaxable !== bTaxable) return aTaxable ? 1 : -1;
  return taxAwareSaleSort(a, b);
}

function applyRebalanceTaxCharacter(result, sale) {
  if (sale.accountType !== "taxable") return;
  if (sale.taxType === "ordinary") {
    result.shortTermCapitalGains += Math.max(0, sale.gain);
  } else if (sale.taxType === "capital-gains") {
    result.longTermCapitalGains += Math.max(0, sale.gain);
  } else if (sale.taxType === "capital-loss-short") {
    const loss = Math.abs(Math.min(0, sale.gain));
    result.capitalLosses += loss;
    result.shortTermCapitalLosses += loss;
  } else if (sale.taxType === "capital-loss-long") {
    const loss = Math.abs(Math.min(0, sale.gain));
    result.capitalLosses += loss;
    result.longTermCapitalLosses += loss;
  }
}

function addRebalancedLot(portfolio, sale, {
  destinationGroup,
  preferredDefensiveAssetClass = "bond",
  calendarYear = null
} = {}) {
  const accountType = sale.accountType ?? "taxable";
  const assetClass = destinationGroup === "stock"
    ? "stock"
    : preferredDefensiveClassForAccount(portfolio, accountType, preferredDefensiveAssetClass);
  const template = portfolio.find((asset) => (
    asset.accountType === accountType
    && asset.assetClass === assetClass
    && marketValue(asset) > CASH_RAISED_EPSILON
  ));
  const price = Math.max(CASH_RAISED_EPSILON, Number(template?.price) || 1);
  portfolio.push({
    id: `rebalance-${calendarYear ?? "na"}-${assetClass}-${portfolio.length + 1}`,
    name: `${assetClassLabel(assetClass)} rebalance`,
    accountType,
    assetClass,
    units: round(sale.proceeds / price, 8),
    price: round(price, 8),
    costBasisPerUnit: round(price, 8),
    holdingPeriod: accountType === "taxable" ? "short" : "long",
    ...(accountType === "taxable" && Number.isFinite(calendarYear)
      ? { holdingPeriodResetCalendarYear: calendarYear }
      : {}),
    ...(Number.isFinite(Number(template?.expectedReturn)) ? { expectedReturn: Number(template.expectedReturn) } : {}),
    ...(Number.isFinite(Number(template?.dividendYield)) ? { dividendYield: Number(template.dividendYield) } : {}),
    ...(Number.isFinite(Number(template?.qualifiedDividendShare))
      ? { qualifiedDividendShare: Number(template.qualifiedDividendShare) }
      : {})
  });
}

function preferredDefensiveClassForAccount(portfolio, accountType, fallback) {
  const candidates = portfolio
    .filter((asset) => asset.accountType === accountType && DEFENSIVE_ASSET_CLASSES.includes(asset.assetClass))
    .sort((a, b) => marketValue(b) - marketValue(a));
  return candidates[0]?.assetClass ?? fallback;
}

function assetClassLabel(assetClass) {
  return {
    stock: "Stock",
    bond: "Bond",
    cash: "Cash",
    tips: "TIPS",
    realEstate: "Real estate",
    crypto: "Crypto"
  }[assetClass] ?? "Allocation";
}

function allocationWithdrawalStateForPortfolio(portfolio, allocationStrategy) {
  if (!allocationStrategy?.withdrawalBiasEnabled) {
    return { enabled: false, direction: null };
  }
  const snapshot = managedStockAllocationSnapshot(portfolio);
  if (!(snapshot.managedValue > 0)) {
    return { enabled: true, direction: null };
  }
  const targetShare = Math.max(0, Math.min(1, (allocationStrategy.targetStockPercent ?? 70) / 100));
  const bandShare = Math.max(0, Math.min(1, (allocationStrategy.rebalanceBandPercent ?? 5) / 100));
  if (snapshot.stockShare > Math.min(1, targetShare + bandShare) + 0.000001) {
    return { enabled: true, direction: "sell-stock" };
  }
  if (snapshot.stockShare < Math.max(0, targetShare - bandShare) - 0.000001) {
    return { enabled: true, direction: "sell-defensive" };
  }
  return { enabled: true, direction: null };
}

function finitePercent(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, numeric));
}

function isLifetimeOptimizerEnabled(scenario) {
  const mode = typeof scenario?.withdrawalStrategy === "string"
    ? scenario.withdrawalStrategy
    : scenario?.withdrawalStrategy?.mode;
  return mode === "lifetime" || mode === "optimized";
}

function earlyWithdrawalPenaltyExceptionAmountForYear(scenario) {
  const amount = Number(scenario.earlyWithdrawalPenaltyExceptionAmount);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function normalizedWithdrawalOrder(withdrawalOrder = []) {
  return [...new Set((withdrawalOrder ?? []).filter(Boolean))];
}

function forcedWithdrawalOrder(withdrawalOrder = []) {
  const preferred = normalizedWithdrawalOrder(withdrawalOrder);
  return [
    ...preferred,
    ...FULL_WITHDRAWAL_ORDER.filter((accountType) => !preferred.includes(accountType))
  ];
}

function rothPreservingWithdrawalOrder(withdrawalOrder) {
  return [
    ...withdrawalOrder.filter((accountType) => accountType !== "roth"),
    ...withdrawalOrder.filter((accountType) => accountType === "roth")
  ];
}

function rothFirstWithdrawalOrder(withdrawalOrder) {
  return [
    ...withdrawalOrder.filter((accountType) => accountType === "roth"),
    ...withdrawalOrder.filter((accountType) => accountType !== "roth")
  ];
}

function earlyPenaltyAvoidanceWithdrawalOrder(withdrawalOrder) {
  const normalized = normalizedWithdrawalOrder(withdrawalOrder);
  return [
    ...normalized.filter((accountType) => accountType !== "traditional" && accountType !== "roth"),
    ...normalized.filter((accountType) => accountType === "roth"),
    ...normalized.filter((accountType) => accountType === "traditional")
  ];
}

function sameWithdrawalOrder(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isBeforePenaltyAge(withdrawalContext = {}) {
  return (withdrawalContext.age ?? 99) < (withdrawalContext.penaltyAge ?? 59.5);
}

function withdrawalPenaltyBurden(withdrawal) {
  return Math.max(0, withdrawal?.penaltyTax ?? 0);
}

function hasLowerPenaltyBurden(candidateWithdrawal, baselineWithdrawal) {
  return withdrawalPenaltyBurden(candidateWithdrawal) + 0.01 < withdrawalPenaltyBurden(baselineWithdrawal);
}

function betterPenaltyAvoidancePlan(candidate, incumbent) {
  if (!incumbent) return true;
  const candidatePenalty = withdrawalPenaltyBurden(candidate.withdrawal);
  const incumbentPenalty = withdrawalPenaltyBurden(incumbent.withdrawal);
  if (candidatePenalty + 0.01 < incumbentPenalty) return true;
  if (candidatePenalty > incumbentPenalty + 0.01) return false;
  if (candidate.modeledCost + 0.01 < incumbent.modeledCost) return true;
  if (candidate.modeledCost > incumbent.modeledCost + 0.01) return false;
  return rothWithdrawalProceeds(candidate.withdrawal) + 0.000001 < rothWithdrawalProceeds(incumbent.withdrawal);
}

function optimizedRothProceedsLimit(withdrawalContext) {
  if ((withdrawalContext.age ?? 99) >= (withdrawalContext.penaltyAge ?? 59.5)) return Infinity;
  const available = Number(withdrawalContext.rothBasisAvailable);
  if (Number.isFinite(available)) return Math.max(0, available);
  return Math.max(0, Number(withdrawalContext.rothBasisRemaining) || 0);
}

function rothWithdrawalProceeds(withdrawal) {
  return round(withdrawal?.sales?.reduce((total, sale) => (
    sale.accountType === "roth" ? total + Math.max(0, sale.proceeds ?? 0) : total
  ), 0) ?? 0, 6);
}

function mergeWithdrawals(base, addition) {
  return {
    cashRaised: round(base.cashRaised + addition.cashRaised, 6),
    ordinaryIncome: round(base.ordinaryIncome + addition.ordinaryIncome, 6),
    shortTermCapitalGains: round(base.shortTermCapitalGains + addition.shortTermCapitalGains, 6),
    longTermCapitalGains: round(base.longTermCapitalGains + addition.longTermCapitalGains, 6),
    capitalLosses: round(base.capitalLosses + addition.capitalLosses, 6),
    shortTermCapitalLosses: round((base.shortTermCapitalLosses ?? 0) + (addition.shortTermCapitalLosses ?? 0), 6),
    longTermCapitalLosses: round((base.longTermCapitalLosses ?? 0) + (addition.longTermCapitalLosses ?? 0), 6),
    penaltyTax: round(base.penaltyTax + addition.penaltyTax, 6),
    penaltyBase: round(base.penaltyBase + addition.penaltyBase, 6),
    penaltyExceptionUsed: round((base.penaltyExceptionUsed ?? 0) + (addition.penaltyExceptionUsed ?? 0), 6),
    penaltyExceptionRemaining: round(Math.max(0, addition.penaltyExceptionRemaining ?? base.penaltyExceptionRemaining ?? 0), 6),
    rothProceeds: round((base.rothProceeds ?? 0) + (addition.rothProceeds ?? 0), 6),
    rothBasisUsed: round(base.rothBasisUsed + addition.rothBasisUsed, 6),
    rothBasisRemaining: addition.rothBasisRemaining,
    hsaProceeds: round((base.hsaProceeds ?? 0) + (addition.hsaProceeds ?? 0), 6),
    hsaQualifiedExpenseUsed: round((base.hsaQualifiedExpenseUsed ?? 0) + (addition.hsaQualifiedExpenseUsed ?? 0), 6),
    saleOpportunityCost: round((base.saleOpportunityCost ?? 0) + (addition.saleOpportunityCost ?? 0), 6),
    sales: [...base.sales, ...addition.sales],
    flows: [...base.flows, ...addition.flows]
  };
}

function emptyWithdrawal(rothBasisRemaining = 0, penaltyExceptionRemaining = 0) {
  return {
    cashRaised: 0,
    ordinaryIncome: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    penaltyTax: 0,
    penaltyBase: 0,
    penaltyExceptionUsed: 0,
    penaltyExceptionRemaining: round(Math.max(0, penaltyExceptionRemaining), 6),
    rothProceeds: 0,
    rothBasisUsed: 0,
    rothBasisRemaining: round(Math.max(0, rothBasisRemaining), 6),
    hsaProceeds: 0,
    hsaQualifiedExpenseUsed: 0,
    saleOpportunityCost: 0,
    sales: [],
    flows: []
  };
}

function withdrawForCash(portfolio, amount, withdrawalOrder = [], context = {}) {
  let remaining = Math.max(0, amount);
  let rothBasisRemaining = Math.max(0, context.rothBasisRemaining ?? 0);
  let penaltyExceptionRemaining = Math.max(0, context.penaltyExceptionRemaining ?? 0);
  const allocationWithdrawal = allocationWithdrawalStateForPortfolio(portfolio, context.allocationStrategy);
  const saleContext = {
    ...context,
    allocationWithdrawal
  };
  const age = context.age ?? 99;
  const calendarYear = context.calendarYear ?? 0;
  const penaltyAge = context.penaltyAge ?? 59.5;
  const penaltyRate = context.penaltyRate ?? 0.1;
  const rothFiveYearRuleSatisfied = context.rothFiveYearRuleSatisfied !== false;
  const maxRothProceeds = Number.isFinite(Number(context.maxRothProceeds))
    ? Math.max(0, Number(context.maxRothProceeds))
    : Infinity;
  const maxHsaProceeds = Number.isFinite(Number(context.hsaQualifiedExpenseAvailable))
    ? Math.max(0, Number(context.hsaQualifiedExpenseAvailable))
    : Infinity;
  const isEarly = age < penaltyAge;
  const result = {
    cashRaised: 0,
    ordinaryIncome: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    penaltyTax: 0,
    penaltyBase: 0,
    penaltyExceptionUsed: 0,
    penaltyExceptionRemaining,
    rothProceeds: 0,
    rothBasisUsed: 0,
    rothBasisRemaining,
    hsaProceeds: 0,
    hsaQualifiedExpenseUsed: 0,
    saleOpportunityCost: 0,
    sales: [],
    flows: []
  };

  for (const accountType of withdrawalOrder) {
    const saleSort = saleSortForWithdrawalContext({ accountType, isEarly, maxRothProceeds, context: saleContext });
    const candidates = portfolio
      .filter((asset) => asset.accountType === accountType && marketValue(asset) > 0)
      .sort(saleSort);

    for (const asset of candidates) {
      if (remaining <= 0) break;
      let requestedSale = remaining;
      if (accountType === "roth") {
        const rothRoom = maxRothProceeds - result.rothProceeds;
        if (rothRoom <= 0.000001) break;
        requestedSale = Math.min(requestedSale, rothRoom);
      } else if (accountType === "hsa") {
        const hsaRoom = maxHsaProceeds - result.hsaProceeds;
        if (hsaRoom <= 0.000001) break;
        requestedSale = Math.min(requestedSale, hsaRoom);
      }
      const sale = sellFromLot(asset, requestedSale);
      if (sale.proceeds <= 0) continue;

      remaining -= sale.proceeds;
      result.cashRaised += sale.proceeds;
      sale.expectedReturn = expectedReturnForAsset(asset, saleContext.returnAssumptions);
      sale.opportunityCost = round(Math.max(0, sale.proceeds * Math.max(0, sale.expectedReturn ?? 0)), 6);
      result.saleOpportunityCost += sale.opportunityCost;
      if (sale.accountType === "roth") result.rothProceeds += sale.proceeds;
      if (sale.accountType === "hsa") {
        const qualified = Math.min(sale.proceeds, Math.max(0, maxHsaProceeds - result.hsaQualifiedExpenseUsed));
        sale.hsaQualifiedExpenseUsed = round(qualified, 6);
        result.hsaProceeds += sale.proceeds;
        result.hsaQualifiedExpenseUsed += qualified;
      }
      applyRetirementDistributionTax(sale, {
        result,
        isEarly,
        penaltyRate,
        calendarYear,
        rothFiveYearRuleSatisfied,
        getRothBasis: () => rothBasisRemaining,
        useRothBasis: (amountUsed) => {
          const used = Math.min(rothBasisRemaining, Math.max(0, amountUsed));
          rothBasisRemaining = round(rothBasisRemaining - used, 6);
          result.rothBasisUsed += used;
          result.rothBasisRemaining = rothBasisRemaining;
          return used;
        },
        usePenaltyException: (penaltyBase) => {
          const rawPenaltyBase = Math.max(0, penaltyBase);
          const used = Math.min(penaltyExceptionRemaining, rawPenaltyBase);
          penaltyExceptionRemaining = round(penaltyExceptionRemaining - used, 6);
          result.penaltyExceptionUsed = round(result.penaltyExceptionUsed + used, 6);
          result.penaltyExceptionRemaining = penaltyExceptionRemaining;
          return {
            exceptionUsed: round(used, 6),
            penaltyBase: round(rawPenaltyBase - used, 6)
          };
        }
      });
      result.sales.push(sale);
      result.flows.push(...withdrawalFlowsForSale(sale));

      if (sale.accountType === "taxable" && sale.taxType === "ordinary") {
        result.shortTermCapitalGains += Math.max(0, sale.gain);
      } else if (sale.accountType === "taxable" && sale.taxType === "capital-gains") {
        result.longTermCapitalGains += Math.max(0, sale.gain);
      } else if (sale.accountType === "taxable" && sale.taxType === "capital-loss-short") {
        const loss = Math.abs(Math.min(0, sale.gain));
        result.capitalLosses += loss;
        result.shortTermCapitalLosses += loss;
      } else if (sale.accountType === "taxable" && sale.taxType === "capital-loss-long") {
        const loss = Math.abs(Math.min(0, sale.gain));
        result.capitalLosses += loss;
        result.longTermCapitalLosses += loss;
      }
    }
  }

  result.cashRaised = round(result.cashRaised, 6);
  result.ordinaryIncome = round(result.ordinaryIncome, 6);
  result.shortTermCapitalGains = round(result.shortTermCapitalGains, 6);
  result.longTermCapitalGains = round(result.longTermCapitalGains, 6);
  result.capitalLosses = round(result.capitalLosses, 6);
  result.shortTermCapitalLosses = round(result.shortTermCapitalLosses, 6);
  result.longTermCapitalLosses = round(result.longTermCapitalLosses, 6);
  result.penaltyTax = round(result.penaltyTax, 6);
  result.penaltyBase = round(result.penaltyBase, 6);
  result.penaltyExceptionUsed = round(result.penaltyExceptionUsed, 6);
  result.penaltyExceptionRemaining = round(penaltyExceptionRemaining, 6);
  result.rothProceeds = round(result.rothProceeds, 6);
  result.rothBasisUsed = round(result.rothBasisUsed, 6);
  result.rothBasisRemaining = round(rothBasisRemaining, 6);
  result.hsaProceeds = round(result.hsaProceeds, 6);
  result.hsaQualifiedExpenseUsed = round(result.hsaQualifiedExpenseUsed, 6);
  result.saleOpportunityCost = round(result.saleOpportunityCost, 6);
  return result;
}

function withdrawalFlowsForSale(sale) {
  if (sale.accountType !== "roth" || !(sale.rothBasisUsed > 0)) {
    return [{
      from: accountLabel(sale.accountType),
      to: "Spending reserve",
      amount: sale.proceeds,
      type: "withdrawal"
    }];
  }

  const basisAmount = Math.min(sale.proceeds, sale.rothBasisUsed);
  const remaining = Math.max(0, sale.proceeds - basisAmount);
  return [
    {
      from: "Roth basis used",
      to: "Spending reserve",
      amount: basisAmount,
      type: "withdrawal"
    },
    ...(remaining > 0.000001 ? [{
      from: "Roth accounts",
      to: "Spending reserve",
      amount: remaining,
      type: "withdrawal"
    }] : [])
  ];
}

function applyRetirementDistributionTax(sale, context) {
  if (sale.accountType === "traditional") {
    const penalty = applyPenaltyException(context, context.isEarly ? sale.proceeds : 0);
    sale.ordinaryIncome = sale.proceeds;
    sale.penaltyBase = penalty.penaltyBase;
    sale.penaltyExceptionUsed = penalty.exceptionUsed;
    sale.penaltyTax = sale.penaltyBase * context.penaltyRate;
    context.result.ordinaryIncome += sale.proceeds;
    context.result.penaltyBase += sale.penaltyBase;
    context.result.penaltyTax += sale.penaltyTax;
    return;
  }

  if (sale.accountType !== "roth") {
    sale.ordinaryIncome = 0;
    sale.penaltyBase = 0;
    sale.penaltyExceptionUsed = 0;
    sale.penaltyTax = 0;
    return;
  }

  if (!context.isEarly && context.rothFiveYearRuleSatisfied !== false) {
    sale.ordinaryIncome = 0;
    sale.penaltyBase = 0;
    sale.penaltyExceptionUsed = 0;
    sale.penaltyTax = 0;
    return;
  }

  let remaining = sale.proceeds;
  const basisUsed = context.useRothBasis(remaining);
  remaining -= basisUsed;

  const conversionPrincipal = sale.rothSource === "conversion"
    ? Math.min(remaining, sale.costBasisSold ?? remaining)
    : 0;
  const conversionIsInsideFiveYears = sale.rothSource === "conversion"
    && Number.isFinite(sale.conversionYear)
    && context.calendarYear - sale.conversionYear < 5;
  const conversionPenaltyBase = conversionIsInsideFiveYears ? conversionPrincipal : 0;
  remaining -= conversionPrincipal;

  const taxableEarnings = Math.max(0, remaining);
  const penalty = applyPenaltyException(context, context.isEarly ? conversionPenaltyBase + taxableEarnings : 0);
  sale.rothBasisUsed = basisUsed;
  sale.ordinaryIncome = taxableEarnings;
  sale.penaltyBase = penalty.penaltyBase;
  sale.penaltyExceptionUsed = penalty.exceptionUsed;
  sale.penaltyTax = sale.penaltyBase * context.penaltyRate;
  sale.taxType = taxableEarnings > 0
    ? context.isEarly ? "roth-earnings" : "roth-nonqualified-earnings"
    : conversionPenaltyBase > 0
      ? "roth-conversion-penalty"
      : "roth-basis";

  context.result.ordinaryIncome += taxableEarnings;
  context.result.penaltyBase += sale.penaltyBase;
  context.result.penaltyTax += sale.penaltyTax;
}

function applyPenaltyException(context, rawPenaltyBase) {
  if (!(rawPenaltyBase > 0)) {
    return { penaltyBase: 0, exceptionUsed: 0 };
  }
  return context.usePenaltyException?.(rawPenaltyBase) ?? {
    penaltyBase: rawPenaltyBase,
    exceptionUsed: 0
  };
}

function convertTraditionalToRoth(portfolio, requestedAmount, calendarYear) {
  let remaining = Math.max(0, requestedAmount);
  let converted = 0;

  for (const asset of [...portfolio]) {
    if (remaining <= 0) break;
    if (asset.accountType !== "traditional" || marketValue(asset) <= 0) continue;

    const amount = Math.min(remaining, marketValue(asset));
    const units = amount / asset.price;
    asset.units = Math.max(0, asset.units - units);
    portfolio.push({
      ...asset,
      id: `${asset.id}-roth-${portfolio.length + 1}`,
      name: `${asset.name ?? asset.id} Roth`,
      accountType: "roth",
      units,
      costBasisPerUnit: asset.price,
      holdingPeriod: "long",
      rothSource: "conversion",
      conversionYear: calendarYear
    });
    remaining -= amount;
    converted += amount;
  }

  removeEmptyLots(portfolio);
  return round(converted, 6);
}

function rothBasisSummaryForYear(portfolio, { age, calendarYear, penaltyAge }) {
  const isEarly = Number(age) < Number(penaltyAge);
  let conversionPrincipal = 0;
  let penaltyFreeConversionPrincipal = 0;

  for (const asset of portfolio) {
    if (asset?.accountType !== "roth" || asset.rothSource !== "conversion") continue;
    const principal = Math.max(0, Math.min(marketValue(asset), (asset.units ?? 0) * (asset.costBasisPerUnit ?? 0)));
    if (!(principal > 0)) continue;
    conversionPrincipal += principal;
    const conversionYear = Number(asset.conversionYear);
    const conversionFiveYearClockMet = Number.isFinite(conversionYear) && calendarYear - conversionYear >= 5;
    if (!isEarly || conversionFiveYearClockMet) {
      penaltyFreeConversionPrincipal += principal;
    }
  }

  return {
    conversionPrincipal: round(conversionPrincipal, 6),
    penaltyFreeConversionPrincipal: round(penaltyFreeConversionPrincipal, 6)
  };
}

function rothBasisAvailableForWithdrawal(portfolio, { rothBasisRemaining = 0, age, calendarYear, penaltyAge }) {
  if (Number(age) >= Number(penaltyAge)) return Infinity;
  const summary = rothBasisSummaryForYear(portfolio, { age, calendarYear, penaltyAge });
  return round(Math.max(0, Number(rothBasisRemaining) || 0) + summary.penaltyFreeConversionPrincipal, 6);
}

function combineIncome({
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0,
  withdrawal,
  taxableSocialSecurity = 0,
  socialSecurityBenefits = 0
}) {
  const taxableSocialSecurityAmount = Math.max(0, taxableSocialSecurity);
  const socialSecurityTotal = Math.max(0, socialSecurityBenefits);
  return {
    ordinaryIncome: ordinaryIncome + withdrawal.ordinaryIncome + taxableSocialSecurityAmount,
    retirementOrdinaryIncome: Math.max(0, retirementOrdinaryIncome) + withdrawal.ordinaryIncome,
    ordinaryInvestmentIncome,
    adjustmentsToIncome: Math.max(0, adjustmentsToIncome),
    medicareWages: earnedIncome.medicareWages,
    selfEmploymentIncome: earnedIncome.selfEmploymentIncome,
    rrtaCompensation: earnedIncome.rrtaCompensation,
    taxableSocialSecurity: taxableSocialSecurityAmount,
    nonTaxableSocialSecurity: Math.max(0, socialSecurityTotal - taxableSocialSecurityAmount),
    shortTermCapitalGains: strategyShortTermGains + withdrawal.shortTermCapitalGains,
    longTermCapitalGains: strategyLongTermGains + withdrawal.longTermCapitalGains,
    qualifiedDividends,
    capitalLosses: strategyCapitalLosses + withdrawal.capitalLosses,
    shortTermCapitalLosses: strategyShortTermLosses + (withdrawal.shortTermCapitalLosses ?? 0),
    longTermCapitalLosses: strategyLongTermLosses + (withdrawal.longTermCapitalLosses ?? 0)
  };
}

function incomeForYear({
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0,
  withdrawal,
  socialSecurityBenefits = 0,
  taxProfile,
  scenario,
  lossCarryforward = { shortTerm: 0, longTerm: 0 }
}) {
  const incomeBeforeSocialSecurity = combineIncome({
    ordinaryIncome,
    retirementOrdinaryIncome,
    ordinaryInvestmentIncome,
    earnedIncome,
    qualifiedDividends,
    adjustmentsToIncome,
    strategyShortTermGains,
    strategyLongTermGains,
    strategyCapitalLosses,
    strategyShortTermLosses,
    strategyLongTermLosses,
    withdrawal,
    socialSecurityBenefits: 0,
    taxableSocialSecurity: 0
  });
  const taxableSocialSecurity = computeTaxableSocialSecurityBenefits({
    benefits: socialSecurityBenefits,
    otherIncome: federalAgiForIncome(incomeBeforeSocialSecurity, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000),
    filingStatus: taxProfile.filingStatus,
    marriedFilingSeparatelyLivedTogether: scenario.medicare?.marriedFilingSeparatelyLivedTogether,
    profile: taxProfile
  });
  return {
    taxableSocialSecurity,
    income: combineIncome({
      ordinaryIncome,
      retirementOrdinaryIncome,
      ordinaryInvestmentIncome,
      earnedIncome,
      qualifiedDividends,
      adjustmentsToIncome,
      strategyShortTermGains,
      strategyLongTermGains,
      strategyCapitalLosses,
      strategyShortTermLosses,
      strategyLongTermLosses,
      withdrawal,
      socialSecurityBenefits,
      taxableSocialSecurity
    })
  };
}

function federalAgiForIncome(income, lossCarryforward = { shortTerm: 0, longTerm: 0 }, ordinaryOffsetCap = 3000) {
  const adjustments = Math.max(0, income.adjustmentsToIncome ?? 0);
  const carryforward = normalizeLossCarryforward(lossCarryforward);
  const netResult = netCapitalGainsAndLosses({
    shortTermCapitalGains: income.shortTermCapitalGains,
    longTermCapitalGains: income.longTermCapitalGains,
    shortTermCapitalLosses: income.shortTermCapitalLosses,
    longTermCapitalLosses: income.longTermCapitalLosses,
    capitalLosses: income.capitalLosses,
    carryforwardShort: carryforward.shortTerm,
    carryforwardLong: carryforward.longTerm,
    ordinaryIncome: income.ordinaryIncome,
    adjustments,
    ordinaryOffsetCap
  });

  return Math.max(0,
    income.ordinaryIncome
    + netResult.netShortGains
    + netResult.netLongGains
    + Math.max(0, income.qualifiedDividends ?? 0)
    - adjustments
    - netResult.ordinaryLossOffset
  );
}

function acaMagiForIncome(income, lossCarryforward = { shortTerm: 0, longTerm: 0 }, ordinaryOffsetCap = 3000) {
  return Math.max(0, federalAgiForIncome(income, lossCarryforward, ordinaryOffsetCap) + Math.max(0, income.nonTaxableSocialSecurity ?? 0));
}

function irmaaMagiForIncome(income, lossCarryforward = { shortTerm: 0, longTerm: 0 }, ordinaryOffsetCap = 3000) {
  return federalAgiForIncome(income, lossCarryforward, ordinaryOffsetCap);
}

function taxProfileForSimulationYear({
  inflatedProfile,
  baseProfile,
  scenario,
  yearIndex,
  primaryAge,
  spouseAge
}) {
  const qualifyingChildren = qualifyingChildrenForYear(baseProfile, inflatedProfile, yearIndex);
  const age65AdditionalDeduction = additionalStandardDeduction65ForYear({
    profile: inflatedProfile,
    filingStatus: inflatedProfile.filingStatus,
    primaryAge,
    spouseAge
  });

  return {
    age65AdditionalDeduction,
    profile: {
      ...inflatedProfile,
      qualifyingChildren,
      additionalDeduction: round((inflatedProfile.additionalDeduction ?? 0) + age65AdditionalDeduction, 6),
      state: inflatedProfile.state ? {
        ...inflatedProfile.state,
        primaryAge,
        spouseAge
      } : null
    }
  };
}

function qualifyingChildrenForYear(baseProfile, inflatedProfile, yearIndex) {
  const childAges = Array.isArray(baseProfile.childAges) ? baseProfile.childAges : [];
  if (!childAges.length) return Math.max(0, Math.trunc(Number(inflatedProfile.qualifyingChildren) || 0));
  return childAges.filter((age) => Number(age) + yearIndex < 17).length;
}

function additionalStandardDeduction65ForYear({ profile, filingStatus, primaryAge, spouseAge }) {
  const config = profile.additionalStandardDeduction65;
  if (!config) return 0;

  const married = filingStatus === "marriedFilingJointly" || filingStatus === "marriedFilingSeparately";
  const amountPerPerson = married ? config.married : config.unmarried;
  let count = primaryAge >= 65 ? 1 : 0;
  if (filingStatus === "marriedFilingJointly" && Number.isFinite(spouseAge) && spouseAge >= 65) {
    count += 1;
  }
  return round(count * (amountPerPerson ?? 0), 6);
}

function socialSecurityBenefitsForYear(scenario, age, inflationIndex) {
  const annualBenefit = Math.max(0, Number(scenario.socialSecurityAnnualBenefit) || 0);
  if (annualBenefit <= 0 || age < (scenario.socialSecurityStartAge ?? 67)) return 0;
  return round(annualBenefit * (scenario.socialSecurityInflationAdjusted === false ? 1 : inflationIndex), 6);
}

function earnedIncomeForYear(scenario, inflationIndex) {
  const index = scenario.earnedIncomeInflationAdjusted === false ? 1 : inflationIndex;
  const medicareWages = round(Math.max(0, Number(scenario.medicareWages) || 0) * index, 6);
  const selfEmploymentIncome = round(Math.max(0, Number(scenario.selfEmploymentIncome) || 0) * index, 6);
  const rrtaCompensation = round(Math.max(0, Number(scenario.rrtaCompensation) || 0) * index, 6);
  const cash = round(medicareWages + selfEmploymentIncome + rrtaCompensation, 6);
  return {
    cash,
    ordinaryIncome: cash,
    medicareWages,
    selfEmploymentIncome,
    rrtaCompensation
  };
}

function emptyEarnedIncome() {
  return {
    cash: 0,
    ordinaryIncome: 0,
    medicareWages: 0,
    selfEmploymentIncome: 0,
    rrtaCompensation: 0
  };
}

function mergeEarnedIncome(left = emptyEarnedIncome(), right = emptyEarnedIncome()) {
  return {
    cash: round((left.cash ?? 0) + (right.cash ?? 0), 6),
    ordinaryIncome: round((left.ordinaryIncome ?? 0) + (right.ordinaryIncome ?? 0), 6),
    medicareWages: round((left.medicareWages ?? 0) + (right.medicareWages ?? 0), 6),
    selfEmploymentIncome: round((left.selfEmploymentIncome ?? 0) + (right.selfEmploymentIncome ?? 0), 6),
    rrtaCompensation: round((left.rrtaCompensation ?? 0) + (right.rrtaCompensation ?? 0), 6)
  };
}

function requiredMinimumDistributionForYear({ scenario, age, beginningTraditionalValue }) {
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

function defaultRmdStartAge(scenario) {
  const birthYear = (scenario.startYear ?? DEFAULT_SCENARIO.startYear) - (scenario.currentAge ?? DEFAULT_SCENARIO.currentAge);
  if (birthYear >= 1960) return 75;
  return 73;
}

function computeAcaForYear({ age, spouseAge, magi, config, filingStatus }) {
  const married = filingStatus === "marriedFilingJointly" && Number.isFinite(spouseAge);
  const both65Plus = married ? (age >= 65 && spouseAge >= 65) : (age >= 65);

  if (both65Plus) return computeAca({ magi, config: { ...config, enabled: false } });
  return computeAca({ magi, config });
}

function medicalCostForYear({
  scenario,
  aca,
  yearAcaConfig,
  inflationIndex,
  age,
  spouseAge,
  yearIndex,
  filingStatus,
  irmaaMagi,
  magiHistory
}) {
  const baseMedical = medicalCostForScenario(scenario, yearAcaConfig, inflationIndex, aca);
  const medicare = computeMedicareCostForYear({
    scenario,
    age,
    spouseAge,
    yearIndex,
    filingStatus,
    irmaaMagi,
    magiHistory,
    inflationIndex
  });
  return {
    total: round(baseMedical + (aca?.netPremium ?? 0) + medicare.totalAnnualPremium, 6),
    medicare
  };
}

function computeMedicareCostForYear({
  scenario,
  age,
  spouseAge,
  yearIndex,
  filingStatus,
  irmaaMagi,
  magiHistory,
  inflationIndex
}) {
  const medicare = scenario.medicare ?? {};
  const autoEnrollees = filingStatus === "marriedFilingJointly"
    ? (age >= 65 ? 1 : 0) + (Number.isFinite(spouseAge) && spouseAge >= 65 ? 1 : 0)
    : (age >= 65 ? 1 : 0);

  if (medicare.irmaaEnabled === false || autoEnrollees === 0) return emptyMedicareCost();

  const config = getMedicareIrmaaConfig({ taxYear: scenario.taxYear, inflationIndex });
  const lookbackMagi = medicareLookbackMagi({
    scenario,
    yearIndex,
    currentMagi: irmaaMagi,
    magiHistory
  });
  const bracket = medicareIrmaaBracket({
    config,
    magi: lookbackMagi,
    filingStatus,
    marriedFilingSeparatelyLivedTogether: medicare.marriedFilingSeparatelyLivedTogether
  });
  const partBEnrollees = clampIntegerLike(medicare.partBEnrollees, 0, 2, autoEnrollees);
  const partDEnrollees = clampIntegerLike(medicare.partDEnrollees, 0, 2, partBEnrollees);
  const partDBaseMonthlyPremium = Math.max(0, Number(medicare.partDMonthlyPremium) || 0) * Math.max(0, inflationIndex);
  const partBMonthlyPremium = (config.partBStandardMonthlyPremium ?? 0) + (bracket.partBMonthlyAdjustment ?? 0);
  const partDMonthlyPremium = partDBaseMonthlyPremium + (bracket.partDMonthlyAdjustment ?? 0);
  const partBAnnualPremium = round(partBMonthlyPremium * 12 * partBEnrollees, 6);
  const partDAnnualPremium = round(partDMonthlyPremium * 12 * partDEnrollees, 6);

  return {
    enabled: true,
    lookbackMagi: round(lookbackMagi, 6),
    partBEnrollees,
    partDEnrollees,
    partBMonthlyPremium: round(partBMonthlyPremium, 6),
    partDMonthlyPremium: round(partDMonthlyPremium, 6),
    partBMonthlyIrmaa: round(bracket.partBMonthlyAdjustment ?? 0, 6),
    partDMonthlyIrmaa: round(bracket.partDMonthlyAdjustment ?? 0, 6),
    partBAnnualPremium,
    partDAnnualPremium,
    totalAnnualPremium: round(partBAnnualPremium + partDAnnualPremium, 6)
  };
}

function medicareLookbackMagi({ scenario, yearIndex, currentMagi, magiHistory }) {
  const medicare = scenario.medicare ?? {};
  if (yearIndex >= 2 && Number.isFinite(magiHistory?.[yearIndex - 2])) return magiHistory[yearIndex - 2];
  const priorYearMagi = optionalFiniteNumber(medicare.priorYearMagi);
  const twoYearsPriorMagi = optionalFiniteNumber(medicare.twoYearsPriorMagi);
  if (yearIndex === 1 && priorYearMagi !== null) return priorYearMagi;
  if (yearIndex === 0 && twoYearsPriorMagi !== null) return twoYearsPriorMagi;
  return Math.max(0, Number(currentMagi) || 0);
}

function optionalFiniteNumber(value) {
  if (value == null || String(value).trim?.() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function medicareIrmaaBracket({
  config,
  magi,
  filingStatus,
  marriedFilingSeparatelyLivedTogether
}) {
  const tableKey = medicareIrmaaBracketKey({ filingStatus, marriedFilingSeparatelyLivedTogether });
  return (config.brackets?.[tableKey] ?? config.brackets?.individual ?? []).find((row) => magi <= row.upTo) ?? {
    partBMonthlyAdjustment: 0,
    partDMonthlyAdjustment: 0
  };
}

function medicareIrmaaBracketKey({ filingStatus, marriedFilingSeparatelyLivedTogether }) {
  return filingStatus === "marriedFilingJointly"
    ? "marriedFilingJointly"
    : filingStatus === "marriedFilingSeparately" && marriedFilingSeparatelyLivedTogether
      ? "marriedFilingSeparatelyTogether"
      : "individual";
}

function emptyMedicareCost() {
  return {
    enabled: false,
    lookbackMagi: 0,
    partBEnrollees: 0,
    partDEnrollees: 0,
    partBMonthlyPremium: 0,
    partDMonthlyPremium: 0,
    partBMonthlyIrmaa: 0,
    partDMonthlyIrmaa: 0,
    partBAnnualPremium: 0,
    partDAnnualPremium: 0,
    totalAnnualPremium: 0
  };
}

function clampIntegerLike(value, min, max, fallback) {
  if (value == null || String(value).trim?.() === "") {
    return Math.min(max, Math.max(min, Math.trunc(fallback)));
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(max, Math.max(min, Math.trunc(fallback)));
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function spendingStrategyConfig(scenario = {}) {
  const raw = scenario.spendingStrategy ?? {};
  const mode = raw.mode === "discretionaryGuardrails" ? "discretionaryGuardrails" : "fixed";
  const targetSpend = Math.max(0, Number(scenario.targetSpend) || 0);
  const essentialFallback = mode === "discretionaryGuardrails" ? targetSpend : DEFAULT_SCENARIO.spendingStrategy.essentialSpend;
  const discretionaryFallback = mode === "discretionaryGuardrails" ? 0 : DEFAULT_SCENARIO.spendingStrategy.discretionarySpend;
  const correctionThreshold = normalizedPercent(
    raw.correctionDrawdownThreshold,
    DEFAULT_SCENARIO.spendingStrategy.correctionDrawdownThreshold
  );
  const bearThreshold = Math.max(
    correctionThreshold,
    normalizedPercent(raw.bearDrawdownThreshold, DEFAULT_SCENARIO.spendingStrategy.bearDrawdownThreshold)
  );

  return {
    mode,
    essentialSpend: nonNegativeNumber(raw.essentialSpend, essentialFallback),
    discretionarySpend: nonNegativeNumber(raw.discretionarySpend, discretionaryFallback),
    essentialInflationAdjusted: raw.essentialInflationAdjusted !== false,
    discretionaryInflationAdjusted: raw.discretionaryInflationAdjusted === true,
    correctionDrawdownThreshold: correctionThreshold,
    bearDrawdownThreshold: bearThreshold,
    correctionDiscretionaryPercent: normalizedPercent(
      raw.correctionDiscretionaryPercent,
      DEFAULT_SCENARIO.spendingStrategy.correctionDiscretionaryPercent
    ),
    bearDiscretionaryPercent: normalizedPercent(
      raw.bearDiscretionaryPercent,
      DEFAULT_SCENARIO.spendingStrategy.bearDiscretionaryPercent
    ),
    marketAssetClass: raw.marketAssetClass || DEFAULT_SCENARIO.spendingStrategy.marketAssetClass
  };
}

function nonNegativeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : Math.max(0, Number(fallback) || 0);
}

function normalizedPercent(value, fallback = 0) {
  const numeric = Number(value);
  const usable = Number.isFinite(numeric) ? numeric : Number(fallback);
  return Math.max(0, Math.min(1, Number.isFinite(usable) ? usable : 0));
}

function initialSpendingGuardrailMarketState() {
  return { marketIndex: 1, highWaterMark: 1 };
}

function spendingGuardrailStateForYear({ scenario, marketState }) {
  const config = spendingStrategyConfig(scenario);
  if (config.mode !== "discretionaryGuardrails") return null;

  const index = Math.max(0.000001, Number(marketState?.marketIndex) || 1);
  const high = Math.max(index, Number(marketState?.highWaterMark) || 1);
  const drawdown = high > 0 ? Math.max(0, 1 - (index / high)) : 0;
  const discretionaryPercent = drawdown + 0.0000001 >= config.bearDrawdownThreshold
    ? config.bearDiscretionaryPercent
    : drawdown + 0.0000001 >= config.correctionDrawdownThreshold
      ? config.correctionDiscretionaryPercent
      : 1;

  return {
    enabled: true,
    marketAssetClass: config.marketAssetClass,
    marketIndex: round(index, 6),
    marketHighWaterMark: round(high, 6),
    marketDrawdown: round(drawdown, 6),
    correctionDrawdownThreshold: config.correctionDrawdownThreshold,
    bearDrawdownThreshold: config.bearDrawdownThreshold,
    discretionaryPercent: round(discretionaryPercent, 6)
  };
}

function advanceSpendingGuardrailMarketState({ scenario, marketState, returnByAssetClass = {} }) {
  const config = spendingStrategyConfig(scenario);
  const currentIndex = Math.max(0.000001, Number(marketState?.marketIndex) || 1);
  const currentHigh = Math.max(currentIndex, Number(marketState?.highWaterMark) || 1);
  const marketReturn = guardrailMarketReturn({
    scenario,
    returnByAssetClass,
    marketAssetClass: config.marketAssetClass
  });
  const nextIndex = Math.max(0.000001, currentIndex * (1 + Math.max(-0.99, marketReturn)));
  return {
    marketIndex: nextIndex,
    highWaterMark: Math.max(currentHigh, nextIndex)
  };
}

function guardrailMarketReturn({ scenario, returnByAssetClass = {}, marketAssetClass = "stock" }) {
  const candidates = [
    returnByAssetClass?.[marketAssetClass],
    returnByAssetClass?.default,
    scenario?.returnAssumptions?.[marketAssetClass]?.mean,
    DEFAULT_SCENARIO.returnAssumptions?.[marketAssetClass]?.mean,
    0
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function plannedSpendingForYear(scenario, planYear, inflationIndex, oneOffCashFlows = null, spendingGuardrail = null) {
  return plannedSpendingDetailForYear(scenario, planYear, inflationIndex, oneOffCashFlows, spendingGuardrail).total;
}

function plannedSpendingDetailForYear(scenario, planYear, inflationIndex, oneOffCashFlows = null, spendingGuardrail = null) {
  const scheduled = oneOffCashFlows ?? oneOffCashFlowsForYear(scenario, planYear, inflationIndex);
  const strategy = spendingStrategyConfig(scenario);
  const oneOffExpenses = round(scheduled.expenses, 6);

  if (strategy.mode === "discretionaryGuardrails") {
    const essentialSpend = round(strategy.essentialSpend * (strategy.essentialInflationAdjusted ? inflationIndex : 1), 6);
    const discretionaryBudget = round(strategy.discretionarySpend * (strategy.discretionaryInflationAdjusted ? inflationIndex : 1), 6);
    const discretionaryPercent = Number.isFinite(Number(spendingGuardrail?.discretionaryPercent))
      ? Math.max(0, Math.min(1, Number(spendingGuardrail.discretionaryPercent)))
      : 1;
    const discretionarySpend = round(discretionaryBudget * discretionaryPercent, 6);
    const total = round(essentialSpend + discretionarySpend + oneOffExpenses, 6);
    return {
      total,
      baseSpend: round(essentialSpend + discretionaryBudget, 6),
      essentialSpend,
      discretionaryBudget,
      discretionarySpend,
      oneOffExpenses,
      guardrail: spendingGuardrail,
      strategy: {
        mode: strategy.mode,
        essentialInflationAdjusted: strategy.essentialInflationAdjusted,
        discretionaryInflationAdjusted: strategy.discretionaryInflationAdjusted,
        discretionaryPercent
      }
    };
  }

  const baseSpend = (scenario.targetSpend ?? 0)
    * (scenario.targetSpendInflationAdjusted === false ? 1 : inflationIndex);
  const total = round(baseSpend + oneOffExpenses, 6);
  return {
    total,
    baseSpend: round(baseSpend, 6),
    essentialSpend: round(baseSpend, 6),
    discretionaryBudget: 0,
    discretionarySpend: 0,
    oneOffExpenses,
    guardrail: null,
    strategy: { mode: "fixed", discretionaryPercent: 1 }
  };
}

function oneOffCashFlowsForYear(scenario, planYear, inflationIndex) {
  const result = emptyOneOffCashFlows();
  for (const entry of scenario.oneOffExpenses ?? []) {
    const start = entry.startYear ?? entry.year ?? 1;
    const end = entry.endYear ?? start;
    if (planYear < start || planYear > end) continue;

    const inflationAdjusted = entry.inflationAdjusted === true;
    const amount = round(Math.max(0, Number(entry.amount) || 0) * (inflationAdjusted ? inflationIndex : 1), 6);
    if (amount <= 0) continue;

    const detail = {
      name: entry.name ?? oneOffTypeLabel(entry.cashFlowType),
      cashFlowType: normalizedOneOffCashFlowType(entry.cashFlowType),
      amount,
      inflationAdjusted
    };

    switch (detail.cashFlowType) {
      case "taxableOrdinaryIncome":
        result.income += amount;
        result.taxableOrdinaryIncome += amount;
        result.incomeDetails.push(detail);
        break;
      case "medicareWages":
        result.income += amount;
        result.earnedIncome = mergeEarnedIncome(result.earnedIncome, {
          cash: amount,
          ordinaryIncome: amount,
          medicareWages: amount,
          selfEmploymentIncome: 0,
          rrtaCompensation: 0
        });
        result.incomeDetails.push(detail);
        break;
      case "selfEmploymentIncome":
        result.income += amount;
        result.earnedIncome = mergeEarnedIncome(result.earnedIncome, {
          cash: amount,
          ordinaryIncome: amount,
          medicareWages: 0,
          selfEmploymentIncome: amount,
          rrtaCompensation: 0
        });
        result.incomeDetails.push(detail);
        break;
      case "rrtaCompensation":
        result.income += amount;
        result.earnedIncome = mergeEarnedIncome(result.earnedIncome, {
          cash: amount,
          ordinaryIncome: amount,
          medicareWages: 0,
          selfEmploymentIncome: 0,
          rrtaCompensation: amount
        });
        result.incomeDetails.push(detail);
        break;
      case "taxFreeIncome":
        result.income += amount;
        result.taxFreeIncome += amount;
        result.incomeDetails.push(detail);
        break;
      default:
        result.expenses += amount;
        result.expenseDetails.push(detail);
        break;
    }
  }

  result.income = round(result.income, 6);
  result.expenses = round(result.expenses, 6);
  result.taxableOrdinaryIncome = round(result.taxableOrdinaryIncome, 6);
  result.taxFreeIncome = round(result.taxFreeIncome, 6);
  return result;
}

function emptyOneOffCashFlows() {
  return {
    income: 0,
    expenses: 0,
    taxableOrdinaryIncome: 0,
    taxFreeIncome: 0,
    earnedIncome: emptyEarnedIncome(),
    incomeDetails: [],
    expenseDetails: []
  };
}

function normalizedOneOffCashFlowType(type) {
  return [
    "taxableOrdinaryIncome",
    "medicareWages",
    "selfEmploymentIncome",
    "rrtaCompensation",
    "taxFreeIncome"
  ].includes(type) ? type : "expense";
}

function oneOffTypeLabel(type) {
  return normalizedOneOffCashFlowType(type) === "expense" ? "One-off expense" : "One-off income";
}

function medicalCostForScenario(scenario, acaConfig, inflationIndex, aca = null) {
  const base = (scenario.medicalExpensesBase ?? 0) * inflationIndex;
  const hasScenarioOopOverride = Number.isFinite(Number(scenario.oopMaxOverride));
  const scenarioOopOverride = Math.max(0, Number(scenario.oopMaxOverride));
  const activePlanOop = aca?.activePlanRole
    && (aca.activePlanRole === "backup" || acaConfig.manualOopMaximum)
    && Number.isFinite(Number(aca.oopMaximum))
    ? Math.max(0, Number(aca.oopMaximum))
    : null;
  const oopMax = activePlanOop ?? (acaConfig.oopMaximumInflated
    ? acaConfig.manualOopMaximum
      ? Math.max(0, acaConfig.oopMaximum ?? 0)
      : hasScenarioOopOverride
        ? scenarioOopOverride * inflationIndex
        : Math.max(0, acaConfig.oopMaximum ?? 0)
    : hasScenarioOopOverride
      ? scenarioOopOverride * inflationIndex
      : Math.max(0, acaConfig.oopMaximum ?? 0) * inflationIndex);
  const expectedOop = oopMax * Math.max(0, Math.min(1, scenario.expectedOopMaxUsePercent ?? 0));
  return round(base + expectedOop, 6);
}

function addPenaltyTax(taxes, penaltyTax = 0) {
  const penalty = Math.max(0, penaltyTax);
  return {
    ...taxes,
    incomeTax: round(taxes.totalTax, 6),
    penaltyTax: round(penalty, 6),
    totalTax: round(taxes.totalTax + penalty, 6)
  };
}

function estimateTaxAttribution({
  taxProfile,
  lossCarryforward,
  income,
  finalTaxes,
  earnedIncome = emptyEarnedIncome(),
  oneOffCashFlows = emptyOneOffCashFlows(),
  dividends,
  rothConversionAmount,
  withdrawal,
  hsaContribution = emptyHsaContribution(),
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  allocationStrategy = emptyRebalanceResult(),
  assetLocation = emptyAssetLocationResult(),
  taxableSocialSecurity = 0
}) {
  const totalTax = Math.max(0, finalTaxes.incomeTax ?? (finalTaxes.totalTax - (finalTaxes.penaltyTax ?? 0)));
  if (totalTax <= 0) return [];

  const fullTax = computeIncomeTax({
    ...income,
    capitalLossCarryforward: lossCarryforward,
    profile: taxProfile
  }).totalTax;
  const sources = [];
  const addSource = (source, adjustments) => {
    const hasAmount = Object.values(adjustments).some((value) => Math.abs(value ?? 0) > 0.000001);
    if (!hasAmount) return;
    const reduced = {
      ordinaryIncome: Math.max(0, income.ordinaryIncome - (adjustments.ordinaryIncome ?? 0)),
      retirementOrdinaryIncome: Math.max(0, (income.retirementOrdinaryIncome ?? 0) - (adjustments.retirementOrdinaryIncome ?? 0)),
      ordinaryInvestmentIncome: Math.max(0, income.ordinaryInvestmentIncome - (adjustments.ordinaryInvestmentIncome ?? 0)),
      adjustmentsToIncome: Math.max(0, (income.adjustmentsToIncome ?? 0) - (adjustments.adjustmentsToIncome ?? 0)),
      medicareWages: Math.max(0, (income.medicareWages ?? 0) - (adjustments.medicareWages ?? 0)),
      selfEmploymentIncome: Math.max(0, (income.selfEmploymentIncome ?? 0) - (adjustments.selfEmploymentIncome ?? 0)),
      rrtaCompensation: Math.max(0, (income.rrtaCompensation ?? 0) - (adjustments.rrtaCompensation ?? 0)),
      taxableSocialSecurity: Math.max(0, (income.taxableSocialSecurity ?? 0) - (adjustments.taxableSocialSecurity ?? 0)),
      shortTermCapitalGains: Math.max(0, income.shortTermCapitalGains - (adjustments.shortTermCapitalGains ?? 0)),
      longTermCapitalGains: Math.max(0, income.longTermCapitalGains - (adjustments.longTermCapitalGains ?? 0)),
      qualifiedDividends: Math.max(0, income.qualifiedDividends - (adjustments.qualifiedDividends ?? 0)),
      capitalLosses: Math.max(0, income.capitalLosses - (adjustments.capitalLosses ?? 0))
    };
    const taxWithoutSource = computeIncomeTax({
      ...reduced,
      capitalLossCarryforward: lossCarryforward,
      profile: taxProfile
    }).totalTax;
    const delta = Math.max(0, fullTax - taxWithoutSource);
    if (delta > 0.000001) sources.push({ source, delta });
  };

  const traditionalOrdinaryIncome = sumSaleIncome(withdrawal.sales, "traditional");
  const rothEarningsIncome = sumSaleIncome(withdrawal.sales, "roth");

  addSource("Earned income", {
    ordinaryIncome: earnedIncome.ordinaryIncome,
    medicareWages: earnedIncome.medicareWages,
    selfEmploymentIncome: earnedIncome.selfEmploymentIncome,
    rrtaCompensation: earnedIncome.rrtaCompensation
  });
  addSource("One-off income", {
    ordinaryIncome: oneOffCashFlows.taxableOrdinaryIncome + oneOffCashFlows.earnedIncome.ordinaryIncome,
    medicareWages: oneOffCashFlows.earnedIncome.medicareWages,
    selfEmploymentIncome: oneOffCashFlows.earnedIncome.selfEmploymentIncome,
    rrtaCompensation: oneOffCashFlows.earnedIncome.rrtaCompensation
  });
  addSource("Taxable account dividends", {
    ordinaryIncome: dividends.ordinaryDividends,
    ordinaryInvestmentIncome: dividends.ordinaryDividends,
    qualifiedDividends: dividends.qualifiedDividends
  });
  addSource("Roth conversion", {
    ordinaryIncome: rothConversionAmount,
    retirementOrdinaryIncome: rothConversionAmount
  });
  addSource("HSA contribution deduction", {
    adjustmentsToIncome: hsaContribution.amount ?? 0
  });
  addSource("Traditional withdrawals", {
    ordinaryIncome: traditionalOrdinaryIncome,
    retirementOrdinaryIncome: traditionalOrdinaryIncome
  });
  addSource("Social Security benefits", {
    ordinaryIncome: taxableSocialSecurity,
    taxableSocialSecurity
  });
  addSource("Roth earnings withdrawals", { ordinaryIncome: rothEarningsIncome });
  addSource("Taxable sales", {
    shortTermCapitalGains: withdrawal.shortTermCapitalGains,
    longTermCapitalGains: withdrawal.longTermCapitalGains,
    capitalLosses: withdrawal.capitalLosses
  });
  addSource("Allocation rebalancing", {
    shortTermCapitalGains: allocationStrategy.shortTermCapitalGains ?? strategyShortTermGains,
    longTermCapitalGains: allocationStrategy.longTermCapitalGains ?? 0
  });
  addSource("Asset location", {
    shortTermCapitalGains: assetLocation.shortTermCapitalGains ?? 0,
    longTermCapitalGains: assetLocation.longTermCapitalGains ?? 0
  });
  addSource("Tax gain harvesting", {
    longTermCapitalGains: Math.max(
      0,
      strategyLongTermGains
        - (allocationStrategy.longTermCapitalGains ?? 0)
        - (assetLocation.longTermCapitalGains ?? 0)
    )
  });

  const deltaTotal = sources.reduce((total, item) => total + item.delta, 0);
  if (deltaTotal <= 0.000001) return [{ source: "Taxable income", amount: round(totalTax, 6) }];

  const scale = totalTax / deltaTotal;
  const allocations = sources.map((item) => ({
    source: item.source,
    amount: round(item.delta * scale, 6)
  }));
  const allocated = allocations.reduce((total, item) => total + item.amount, 0);
  const remainder = round(totalTax - allocated, 6);
  if (Math.abs(remainder) > 0.01) allocations.push({ source: "Tax interactions", amount: remainder });
  return allocations.filter((item) => item.amount > 0);
}

function sumSaleIncome(sales = [], accountType) {
  return round(sales
    .filter((sale) => sale.accountType === accountType)
    .reduce((total, sale) => total + Math.max(0, sale.ordinaryIncome ?? 0), 0), 6);
}

function gainHarvestingRoom({
  taxes,
  taxProfile,
  configuredMaxGain = Infinity,
  acaConfig,
  currentMagi = 0,
  portfolio = [],
  scenario = {},
  age = null,
  inflationIndex = 1,
  ordinaryIncome = 0,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0,
  withdrawal = emptyWithdrawal(),
  socialSecurityBenefits = 0,
  lossCarryforward = { shortTerm: 0, longTerm: 0 },
  spouseAge = null,
  yearIndex = 0,
  magiHistory = []
} = {}) {
  const zeroBracket = taxProfile.capitalGainsBrackets?.find((bracket) => bracket.rate === 0);
  if (!zeroBracket) return 0;
  const taxableIncomeAlreadyStacked = taxes.taxableOrdinaryIncome + taxes.taxablePreferentialIncome;
  const federalRoom = Math.max(0, zeroBracket.upTo - taxableIncomeAlreadyStacked);
  const acaTarget = acaMagiCeiling({
    acaConfig,
    currentMagi,
    maxFplPercent: acaConfig?.maxEligibleFplPercent ?? 400,
    magiBuffer: taxGainHarvestingMagiBuffer(scenario)
  });
  const acaRoom = acaConfig?.enabled
    ? Math.max(0, acaTarget.amount - currentMagi)
    : Infinity;
  const currentRoom = Math.max(0, Math.min(configuredMaxGain ?? Infinity, federalRoom, acaRoom));
  if (!isLifetimeOptimizerEnabled(scenario) || scenario.taxGainHarvesting?.mode === "manual") {
    return round(currentRoom, 6);
  }

  const futureRate = estimatedFutureCapitalGainRate({ taxProfile, scenario, age, portfolio });
  const currentFifteenRate = estimatedCurrentCapitalGainRate({ taxProfile, preferredRate: 0.15 });
  if (!(futureRate > currentFifteenRate * withdrawalStrategyConfig(scenario).gainHarvestingFutureTaxDiscount + 0.0001)) {
    return round(currentRoom, 6);
  }

  const fifteenBracket = taxProfile.capitalGainsBrackets?.find((bracket) => bracket.rate === 0.15);
  const federalFifteenRoom = fifteenBracket
    ? Math.max(0, fifteenBracket.upTo - taxableIncomeAlreadyStacked)
    : federalRoom;
  const marginalBenefitRate = Math.max(0, futureRate - currentFifteenRate);
  const optimizedAcaTarget = acaMagiCeiling({
    acaConfig,
    currentMagi,
    maxFplPercent: acaConfig?.maxEligibleFplPercent ?? 400,
    targetRate: marginalBenefitRate,
    magiBuffer: taxGainHarvestingMagiBuffer(scenario)
  });
  const acaEligibilityCeiling = acaConfig?.enabled && acaConfig.fpl > 0
    ? acaConfig.fpl * ((acaConfig.maxEligibleFplPercent ?? 400) / 100)
    : Infinity;
  const acaAlreadyUnavailable = acaConfig?.enabled
    && Number.isFinite(acaEligibilityCeiling)
    && currentMagi > acaEligibilityCeiling + 0.000001;
  const optimizedAcaRoom = acaConfig?.enabled
    ? acaAlreadyUnavailable
      ? Infinity
      : Math.max(0, optimizedAcaTarget.amount - currentMagi)
    : Infinity;
  const niitThreshold = taxProfile.niit?.thresholds?.[taxProfile.filingStatus];
  const niitRoom = Number.isFinite(niitThreshold)
    ? Math.max(0, niitThreshold - currentMagi)
    : Infinity;
  const embeddedGains = embeddedTaxableGains(portfolio);
  if (hsaStrategyConfig(scenario).marginalRateOptimizationEnabled && isLifetimeOptimizerEnabled(scenario)) {
    const marginalRoom = marginalIncomeRoom({
      kind: "longTermGains",
      scenario,
      taxProfile,
      acaConfig,
      inflationIndex,
      targetRate: futureRate,
      maxAmount: Math.min(
        configuredMaxGain ?? Infinity,
        federalFifteenRoom,
        optimizedAcaRoom,
        niitRoom,
        embeddedGains
      ),
      ordinaryIncome,
      earnedIncome,
      retirementOrdinaryIncome,
      ordinaryInvestmentIncome,
      qualifiedDividends,
      adjustmentsToIncome,
      strategyShortTermGains,
      strategyLongTermGains,
      strategyCapitalLosses,
      strategyShortTermLosses,
      strategyLongTermLosses,
      withdrawal,
      socialSecurityBenefits,
      lossCarryforward,
      age,
      spouseAge,
      yearIndex,
      magiHistory
    });
    return round(Math.max(currentRoom, marginalRoom), 6);
  }
  const optimizedRoom = Math.max(0, Math.min(
    configuredMaxGain ?? Infinity,
    federalFifteenRoom,
    optimizedAcaRoom,
    niitRoom,
    embeddedGains
  ));
  return round(Math.max(currentRoom, optimizedRoom), 6);
}

function estimatedCurrentCapitalGainRate({ taxProfile, preferredRate = 0.15 }) {
  const state = taxProfile.state ?? {};
  const stateRate = state.treatCapitalGainsAsOrdinary === false
    ? state.capitalGainsRate ?? 0
    : topBracketRate(state.brackets);
  return Math.max(0, preferredRate + stateRate);
}

function estimatedFutureCapitalGainRate({ taxProfile, scenario, portfolio }) {
  const maxFederalPreferentialRate = Math.max(0, ...(taxProfile.capitalGainsBrackets ?? []).map((bracket) => bracket.rate ?? 0));
  const niitRate = taxProfile.niit?.rate ?? 0;
  const state = taxProfile.state ?? {};
  const stateRate = state.treatCapitalGainsAsOrdinary === false
    ? state.capitalGainsRate ?? 0
    : topBracketRate(state.brackets);
  const rmdPressure = traditionalAccountValue(portfolio) > Math.max(0, Number(scenario.targetSpend) || 0) * 8;
  return Math.max(0, maxFederalPreferentialRate + (rmdPressure ? niitRate : niitRate / 2) + stateRate);
}

function estimatedFutureOrdinaryIncomeRate({ portfolio, scenario, age, taxProfile, ordinaryIncome = 0 }) {
  const federalTarget = effectiveRothConversionTargetRate({
    portfolio,
    scenario,
    age,
    taxProfile,
    ordinaryIncome
  });
  return Math.max(0, federalTarget + approximateStateMarginalRate({ taxProfile, ordinaryIncome }));
}

function marginalIncomeRoom({
  kind,
  scenario,
  taxProfile,
  acaConfig,
  inflationIndex = 1,
  targetRate = 0,
  maxAmount = 0,
  ordinaryIncome = 0,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0,
  withdrawal = emptyWithdrawal(),
  socialSecurityBenefits = 0,
  lossCarryforward = { shortTerm: 0, longTerm: 0 },
  age = null,
  spouseAge = null,
  yearIndex = 0,
  magiHistory = []
}) {
  const cap = Math.max(0, Number(maxAmount) || 0);
  if (cap <= CASH_RAISED_EPSILON) return 0;

  const costFor = (additionalIncome) => {
    const extra = Math.max(0, additionalIncome);
    const { income } = incomeForYear({
      ordinaryIncome: ordinaryIncome + (kind === "ordinary" ? extra : 0),
      earnedIncome,
      retirementOrdinaryIncome: retirementOrdinaryIncome + (kind === "ordinary" ? extra : 0),
      ordinaryInvestmentIncome,
      qualifiedDividends,
      adjustmentsToIncome,
      strategyShortTermGains,
      strategyLongTermGains: strategyLongTermGains + (kind === "longTermGains" ? extra : 0),
      strategyCapitalLosses,
      strategyShortTermLosses,
      strategyLongTermLosses,
      withdrawal,
      socialSecurityBenefits,
      taxProfile,
      scenario,
      lossCarryforward
    });
    const taxes = computeIncomeTax({
      ...income,
      capitalLossCarryforward: lossCarryforward,
      profile: taxProfile
    });
    const acaMagi = acaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000);
    const irmaaMagi = irmaaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000);
    const aca = computeAca({ magi: acaMagi, config: acaConfig });
    const medical = medicalCostForYear({
      scenario,
      aca,
      yearAcaConfig: acaConfig,
      inflationIndex,
      age: age ?? 99,
      spouseAge,
      yearIndex,
      filingStatus: taxProfile.filingStatus,
      irmaaMagi,
      magiHistory
    });
    return {
      cost: round(taxes.totalTax + medical.total, 6),
      taxes,
      income,
      acaMagi,
      irmaaMagi
    };
  };

  const base = costFor(0);
  const points = marginalIncomeCandidateAmounts({
    kind,
    maxAmount: cap,
    taxProfile,
    acaConfig,
    scenario,
    base,
    inflationIndex,
    socialSecurityBenefits
  });
  const tolerance = Math.max(0, targetRate) + 0.0001;
  let admitted = 0;
  let previousAmount = 0;
  let previousCost = base.cost;

  for (const amount of points) {
    if (amount <= previousAmount + CASH_RAISED_EPSILON) continue;
    const next = costFor(amount);
    const segmentRate = (next.cost - previousCost) / (amount - previousAmount);
    const cumulativeRate = (next.cost - base.cost) / amount;
    if (segmentRate <= tolerance || cumulativeRate <= tolerance) {
      admitted = amount;
      previousAmount = amount;
      previousCost = next.cost;
      continue;
    }
    break;
  }

  return round(admitted, 6);
}

function marginalIncomeCandidateAmounts({
  kind,
  maxAmount,
  taxProfile,
  acaConfig,
  scenario,
  base,
  inflationIndex = 1,
  socialSecurityBenefits = 0
}) {
  const points = new Set([round(maxAmount, 6)]);
  const addPoint = (amount) => {
    if (Number.isFinite(amount) && amount > CASH_RAISED_EPSILON && amount <= maxAmount + CASH_RAISED_EPSILON) {
      points.add(round(Math.min(maxAmount, amount), 6));
    }
  };

  if (kind === "ordinary") {
    for (const bracket of taxProfile.ordinaryBrackets ?? []) {
      if (Number.isFinite(bracket.upTo)) {
        addPoint(bracket.upTo + (taxProfile.standardDeduction ?? 0) + (taxProfile.additionalDeduction ?? 0) - base.taxes.taxableOrdinaryIncome);
      }
    }
  } else {
    const stacked = base.taxes.taxableOrdinaryIncome + base.taxes.taxablePreferentialIncome;
    for (const bracket of taxProfile.capitalGainsBrackets ?? []) {
      if (Number.isFinite(bracket.upTo)) addPoint(bracket.upTo - stacked);
    }
  }

  if (acaConfig?.enabled && acaConfig.fpl > 0) {
    for (const row of acaConfig.applicablePercentageTable ?? []) {
      addPoint(acaConfig.fpl * (row.maxFplPercent ?? 0) / 100 - base.acaMagi);
    }
    addPoint(acaConfig.fpl * ((acaConfig.maxEligibleFplPercent ?? 400) / 100) - base.acaMagi);
  }

  const niitThreshold = taxProfile.niit?.thresholds?.[taxProfile.filingStatus];
  if (Number.isFinite(niitThreshold)) addPoint(niitThreshold - base.irmaaMagi);

  const ssConfig = taxProfile.socialSecurityTaxation ?? {};
  const benefits = Math.max(
    0,
    Number(socialSecurityBenefits) || Number(scenario.socialSecurityAnnualBenefit) || 0
  );
  if (benefits > 0) {
    const otherIncome = base.irmaaMagi - Math.max(0, base.income.taxableSocialSecurity ?? 0);
    addPoint((ssConfig.baseAmounts?.[taxProfile.filingStatus] ?? 25000) - (benefits * 0.5) - otherIncome);
    addPoint((ssConfig.adjustedBaseAmounts?.[taxProfile.filingStatus] ?? 34000) - (benefits * 0.5) - otherIncome);
  }

  const irmaaConfig = getMedicareIrmaaConfig({ taxYear: scenario.taxYear, inflationIndex });
  const key = medicareIrmaaBracketKey({
    filingStatus: taxProfile.filingStatus,
    marriedFilingSeparatelyLivedTogether: scenario.medicare?.marriedFilingSeparatelyLivedTogether
  });
  for (const bracket of irmaaConfig.brackets?.[key] ?? []) {
    if (Number.isFinite(bracket.upTo)) addPoint(bracket.upTo - base.irmaaMagi);
  }

  return [...points].sort((a, b) => a - b);
}

function topBracketRate(brackets = []) {
  return Math.max(0, ...brackets.map((bracket) => bracket.rate ?? 0).filter(Number.isFinite));
}

function finiteRoom(value) {
  const number = Number(value);
  if (Number.isNaN(number)) return Infinity;
  return Number.isFinite(number) ? Math.max(0, number) : Infinity;
}

function rothConversionMagiBuffer(scenario = {}) {
  const buffer = Number(scenario.rothConversion?.magiBuffer ?? scenario.aca?.magiBuffer ?? 0);
  return Number.isFinite(buffer) && buffer > 0 ? buffer : 0;
}

function taxGainHarvestingMagiBuffer(scenario = {}) {
  const buffer = Number(scenario.taxGainHarvesting?.magiBuffer ?? scenario.aca?.magiBuffer ?? 0);
  return Number.isFinite(buffer) && buffer > 0 ? buffer : 0;
}

function strategyLimit({ strategy, autoValue, legacyField, overrideField }) {
  const legacy = Number(strategy?.[legacyField]);
  const override = Number(strategy?.[overrideField]);
  if (strategy?.mode === "manual" && Number.isFinite(override)) return Math.max(0, override);
  if (Number.isFinite(legacy) && legacy > 0) return Math.max(0, legacy);
  return Math.max(0, autoValue);
}

function automaticTaxLossHarvestLimit(portfolio, taxProfile, lossCarryforward = 0) {
  const ordinaryOffset = Math.max(0, (taxProfile.capitalLossOrdinaryIncomeOffset ?? 3000) - lossCarryforward);
  return round(embeddedTaxableGains(portfolio) + ordinaryOffset, 6);
}

function rothConversionAmountForYear({
  portfolio,
  scenario,
  taxProfile,
  acaConfig,
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  socialSecurityBenefits = 0,
  age = null,
  spouseAge = null,
  inflationIndex = 1,
  yearIndex = 0,
  magiHistory = [],
  lossCarryforward = { shortTerm: 0, longTerm: 0 }
}) {
  const requested = scenario.rothConversion?.overrideAmount != null
    && Number.isFinite(Number(scenario.rothConversion.overrideAmount))
    ? Number(scenario.rothConversion.overrideAmount)
    : scenario.rothConversion?.annualAmount != null
      && Number.isFinite(Number(scenario.rothConversion.annualAmount))
      ? Number(scenario.rothConversion.annualAmount)
      : null;
  if (requested !== null && requested >= 0) {
    if (scenario.rothConversion?.applyMagiGuardrails === true || rothConversionMagiBuffer(scenario) > 0) {
      const room = rothConversionMagiGuardrailRoom({
        portfolio,
        scenario,
        taxProfile,
        acaConfig,
        ordinaryIncome,
        earnedIncome,
        ordinaryInvestmentIncome,
        qualifiedDividends,
        adjustmentsToIncome,
        socialSecurityBenefits,
        age,
        inflationIndex,
        lossCarryforward
      });
      const directAcaRoom = rothConversionDirectAcaRoom({
        scenario,
        acaConfig,
        ordinaryIncome,
        qualifiedDividends,
        adjustmentsToIncome
      });
      return round(Math.min(requested, room, directAcaRoom, traditionalAccountValue(portfolio)), 6);
    }
    return requested;
  }

  const targetRate = effectiveRothConversionTargetRate({
    portfolio,
    scenario,
    age,
    taxProfile,
    ordinaryIncome
  });
  if (hsaStrategyConfig(scenario).marginalRateOptimizationEnabled && isLifetimeOptimizerEnabled(scenario)) {
    const maxTraditional = traditionalAccountValue(portfolio);
    const { income } = incomeForYear({
      ordinaryIncome,
      earnedIncome,
      retirementOrdinaryIncome: 0,
      ordinaryInvestmentIncome,
      qualifiedDividends,
      adjustmentsToIncome,
      withdrawal: emptyWithdrawal(),
      socialSecurityBenefits,
      taxProfile,
      scenario,
      lossCarryforward
    });
    const magiBeforeConversion = acaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000);
    const acaTarget = scenario.rothConversion?.optimizeForAca === false
      ? { amount: Infinity }
      : acaMagiCeiling({
          acaConfig,
          currentMagi: magiBeforeConversion,
          maxFplPercent: scenario.rothConversion?.maxAcaFplPercent ?? 400,
          targetRate,
          magiBuffer: rothConversionMagiBuffer(scenario)
        });
    const acaRoom = acaConfig?.enabled
      ? Math.max(0, acaTarget.amount - magiBeforeConversion)
      : Infinity;
    const irmaaRoom = irmaaMagiRoomForConversion({
      scenario,
      taxProfile,
      age,
      inflationIndex,
      magiBeforeConversion: irmaaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000),
      targetRate
    });
    const marginalRoom = marginalIncomeRoom({
      kind: "ordinary",
      scenario,
      taxProfile,
      acaConfig: scenario.rothConversion?.optimizeForAca === false
        ? { ...acaConfig, enabled: false }
        : acaConfig,
      inflationIndex,
      targetRate: estimatedFutureOrdinaryIncomeRate({
        portfolio,
        scenario,
        age,
        taxProfile,
        ordinaryIncome
      }),
      maxAmount: Math.min(maxTraditional, acaRoom, irmaaRoom),
      ordinaryIncome,
      earnedIncome,
      retirementOrdinaryIncome: 0,
      ordinaryInvestmentIncome,
      qualifiedDividends,
      adjustmentsToIncome,
      withdrawal: emptyWithdrawal(),
      socialSecurityBenefits,
      lossCarryforward,
      age,
      spouseAge,
      yearIndex,
      magiHistory
    });
    return round(Math.min(marginalRoom, irmaaRoom, maxTraditional), 6);
  }
  const targetCeiling = bracketCeilingForRate(taxProfile.ordinaryBrackets, targetRate);
  const federalRoom = Math.max(0, targetCeiling + (taxProfile.standardDeduction ?? 0) - ordinaryIncome);
  const { income: incomeBeforeConversion } = incomeForYear({
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome: 0,
    ordinaryInvestmentIncome,
    qualifiedDividends,
    adjustmentsToIncome,
    withdrawal: emptyWithdrawal(),
    socialSecurityBenefits,
    taxProfile,
    scenario,
    lossCarryforward
  });
  const magiBeforeConversion = acaMagiForIncome(incomeBeforeConversion, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000);
  const acaTarget = scenario.rothConversion?.optimizeForAca === false
    ? {
        amount: (acaConfig?.fpl ?? 0) * ((scenario.rothConversion?.maxAcaFplPercent ?? 400) / 100)
      }
    : acaMagiCeiling({
        acaConfig,
        currentMagi: magiBeforeConversion,
        maxFplPercent: scenario.rothConversion?.maxAcaFplPercent ?? 400,
        targetRate,
        magiBuffer: rothConversionMagiBuffer(scenario)
      });
  const acaRoom = acaConfig?.enabled
    ? Math.max(0, acaTarget.amount - magiBeforeConversion)
    : Infinity;
  const irmaaRoom = irmaaMagiRoomForConversion({
    scenario,
    taxProfile,
    age,
    inflationIndex,
    magiBeforeConversion: irmaaMagiForIncome(incomeBeforeConversion, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000),
    targetRate
  });

  return round(Math.min(
    finiteRoom(federalRoom),
    finiteRoom(acaRoom),
    finiteRoom(irmaaRoom),
    traditionalAccountValue(portfolio)
  ), 6);
}

function rothConversionMagiGuardrailRoom({
  portfolio,
  scenario,
  taxProfile,
  acaConfig,
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  socialSecurityBenefits = 0,
  age = null,
  inflationIndex = 1,
  lossCarryforward = { shortTerm: 0, longTerm: 0 }
}) {
  const targetRate = effectiveRothConversionTargetRate({
    portfolio,
    scenario,
    age,
    taxProfile,
    ordinaryIncome
  });
  const { income } = incomeForYear({
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome: 0,
    ordinaryInvestmentIncome,
    qualifiedDividends,
    adjustmentsToIncome,
    withdrawal: emptyWithdrawal(),
    socialSecurityBenefits,
    taxProfile,
    scenario,
    lossCarryforward
  });
  const magiBeforeConversion = acaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000);
  const acaTarget = scenario.rothConversion?.optimizeForAca === false
    ? { amount: Infinity }
    : acaMagiCeiling({
        acaConfig,
        currentMagi: magiBeforeConversion,
        maxFplPercent: scenario.rothConversion?.maxAcaFplPercent ?? 400,
        targetRate,
        magiBuffer: rothConversionMagiBuffer(scenario)
      });
  const acaRoom = acaConfig?.enabled
    ? Math.max(0, acaTarget.amount - magiBeforeConversion)
    : Infinity;
  const irmaaRoom = irmaaMagiRoomForConversion({
    scenario,
    taxProfile,
    age,
    inflationIndex,
    magiBeforeConversion: irmaaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000),
    targetRate
  });
  return Math.min(finiteRoom(acaRoom), finiteRoom(irmaaRoom), traditionalAccountValue(portfolio));
}

function rothConversionDirectAcaRoom({
  scenario,
  acaConfig,
  ordinaryIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0
}) {
  if (!acaConfig?.enabled || !(acaConfig.fpl > 0) || scenario.rothConversion?.optimizeForAca === false) return Infinity;
  const ceiling = Math.max(0,
    acaConfig.fpl * ((scenario.rothConversion?.maxAcaFplPercent ?? 400) / 100)
      - rothConversionMagiBuffer(scenario)
  );
  const currentMagi = Math.max(0, ordinaryIncome + qualifiedDividends - Math.max(0, adjustmentsToIncome));
  return Math.max(0, ceiling - currentMagi);
}

function effectiveRothConversionTargetRate({ portfolio, scenario, age, taxProfile, ordinaryIncome = 0 }) {
  const config = scenario.rothConversion ?? {};
  // If the user supplies `combinedTargetMarginalRate`, treat it as the
  // combined federal+state rate ceiling and back out the federal target by
  // subtracting an approximation of the state marginal rate. This avoids the
  // common gotcha of declaring "I'll convert up to 12%" but actually paying
  // ~21% combined in a high-tax state.
  let configured = config.targetMarginalRate ?? 0.12;
  if (Number.isFinite(Number(config.combinedTargetMarginalRate))) {
    const combined = Math.max(0, Number(config.combinedTargetMarginalRate));
    const stateMarginal = taxProfile
      ? approximateStateMarginalRate({ taxProfile, ordinaryIncome })
      : 0;
    configured = Math.max(0, combined - stateMarginal);
  }
  if (!isLifetimeOptimizerEnabled(scenario) || config.mode === "manual") return configured;
  const rmdStartAge = scenario.rmd?.startAge != null && Number.isFinite(Number(scenario.rmd.startAge))
    ? Number(scenario.rmd.startAge)
    : defaultRmdStartAge(scenario);
  const yearsUntilRmd = Number.isFinite(age) ? Math.max(0, rmdStartAge - age) : Infinity;
  const traditionalValue = traditionalAccountValue(portfolio);
  const annualSpend = Math.max(0, Number(scenario.targetSpend) || 0);
  const rmdPressure = traditionalValue > annualSpend * Math.max(6, Math.min(15, yearsUntilRmd || 10));
  return rmdPressure && configured <= 0.12 ? 0.22 : configured;
}

function approximateStateMarginalRate({ taxProfile, ordinaryIncome = 0 }) {
  const state = taxProfile?.state;
  if (!state || !Array.isArray(state.brackets) || state.brackets.length === 0) return 0;
  const taxable = Math.max(0, ordinaryIncome - (state.standardDeduction ?? 0));
  let previous = 0;
  for (const bracket of state.brackets) {
    if (taxable <= (bracket.upTo ?? Infinity)) return Math.max(0, bracket.rate ?? 0);
    previous = bracket.upTo;
  }
  // taxable income exceeds all bracket ceilings — return the top bracket rate.
  return Math.max(0, state.brackets.at(-1)?.rate ?? 0);
}

function irmaaMagiRoomForConversion({ scenario, taxProfile, age, inflationIndex, magiBeforeConversion, targetRate = 0.12 }) {
  if (!isLifetimeOptimizerEnabled(scenario) || scenario.medicare?.irmaaEnabled === false || !(age >= 63)) return Infinity;
  const config = getMedicareIrmaaConfig({ taxYear: scenario.taxYear, inflationIndex });
  const key = medicareIrmaaBracketKey({
    filingStatus: taxProfile.filingStatus,
    marriedFilingSeparatelyLivedTogether: scenario.medicare?.marriedFilingSeparatelyLivedTogether
  });
  const brackets = config.brackets?.[key] ?? [];
  if (!brackets.length) return Infinity;

  // User-configurable hard cap on tier index (0-indexed). When unset we let
  // the per-bracket net-benefit gate decide.
  const maxTier = Number.isFinite(Number(scenario.medicare?.maxIrmaaTier))
    ? Math.max(0, Math.trunc(Number(scenario.medicare.maxIrmaaTier)))
    : brackets.length - 1;
  const enrollees = Math.max(1, Math.trunc(Number(scenario.medicare?.householdEnrollees) || 1));

  // Locate the bracket the household sits in before conversion.
  let currentIndex = brackets.findIndex((row) => magiBeforeConversion <= (row.upTo ?? Infinity) + 0.000001);
  if (currentIndex < 0) currentIndex = brackets.length - 1;

  // Walk forward and admit each next bracket only if the federal tax savings
  // on the conversion within the bracket's MAGI width exceed the additional
  // annual IRMAA surcharge that crossing the threshold imposes.
  let lastAdmittedUpTo = brackets[currentIndex]?.upTo ?? Infinity;
  for (let nextIndex = currentIndex + 1; nextIndex <= maxTier && nextIndex < brackets.length; nextIndex += 1) {
    const prevUpTo = brackets[nextIndex - 1]?.upTo ?? 0;
    const nextUpTo = brackets[nextIndex]?.upTo ?? Infinity;
    const additionalAnnualSurcharge = (
      ((brackets[nextIndex].partBMonthlyAdjustment ?? 0) - (brackets[nextIndex - 1].partBMonthlyAdjustment ?? 0))
      + ((brackets[nextIndex].partDMonthlyAdjustment ?? 0) - (brackets[nextIndex - 1].partDMonthlyAdjustment ?? 0))
    ) * 12 * enrollees;
    const widthInBracket = Number.isFinite(nextUpTo) ? Math.max(0, nextUpTo - prevUpTo) : Infinity;
    const federalBenefit = widthInBracket * Math.max(0, targetRate);
    if (federalBenefit + 0.01 < additionalAnnualSurcharge) break;
    lastAdmittedUpTo = nextUpTo;
  }

  return Number.isFinite(lastAdmittedUpTo) ? Math.max(0, lastAdmittedUpTo - magiBeforeConversion) : Infinity;
}

function acaMagiCeiling({ acaConfig, currentMagi = 0, maxFplPercent = 400, targetRate = null, magiBuffer = 0 } = {}) {
  if (!acaConfig?.enabled || !(acaConfig.fpl > 0)) {
    return { amount: Infinity, fplPercent: Infinity };
  }

  const fpl = acaConfig.fpl;
  const currentFplPercent = Math.max(0, currentMagi / fpl * 100);
  const cappedMax = Math.max(0, Math.min(maxFplPercent, acaConfig.maxEligibleFplPercent ?? maxFplPercent));
  const buffer = Math.max(0, Number(magiBuffer) || 0);
  const bufferedResult = (targetPercent) => {
    const amount = Math.max(0, fpl * targetPercent / 100 - buffer);
    return {
      amount: round(amount, 6),
      fplPercent: round(amount / fpl * 100, 6)
    };
  };

  // Sort intra-table band boundaries above currentFplPercent, capped by
  // cappedMax. Always include cappedMax itself as a candidate boundary.
  const bands = (acaConfig.applicablePercentageTable ?? [])
    .filter((row) => Number.isFinite(row.maxFplPercent) && row.maxFplPercent > currentFplPercent + 0.0001 && row.maxFplPercent <= cappedMax + 0.0001)
    .sort((a, b) => (a.minFplPercent ?? 0) - (b.minFplPercent ?? 0));

  // Legacy "blind cap" path: when `targetRate` isn't supplied (e.g., the
  // post-conversion display call), preserve the original conservative
  // behavior of stopping at the next intra-table boundary.
  if (!Number.isFinite(targetRate)) {
    const nextBoundary = bands[0]?.maxFplPercent;
    const targetPercent = Number.isFinite(nextBoundary) ? Math.min(cappedMax, nextBoundary) : cappedMax;
    return bufferedResult(targetPercent);
  }

  // Net-benefit path: admit crossing each next band only if the band's
  // average marginal subsidy clawback per dollar of MAGI does not exceed
  // `targetRate` (the federal tax savings rate the optimizer hopes to lock
  // in via the conversion). The configured `cappedMax` is treated as a
  // hard cliff.
  let admittedPercent = currentFplPercent;
  let prevPercent = currentFplPercent;
  const tolerance = Math.max(0, targetRate) + 0.0001;
  for (const band of bands) {
    const boundary = Math.min(band.maxFplPercent, cappedMax);
    if (boundary <= prevPercent + 0.0001) continue;
    const marginalClawback = bandAverageMarginalAcaCost({
      acaConfig,
      band,
      lowerFplPercent: prevPercent,
      upperFplPercent: boundary
    });
    if (marginalClawback > tolerance) break;
    admittedPercent = boundary;
    prevPercent = boundary;
    if (boundary >= cappedMax - 0.0001) break;
  }
  const targetPercent = Math.min(cappedMax, admittedPercent);

  return bufferedResult(targetPercent);
}

// Average marginal cost-per-MAGI-dollar of traversing the FPL% range
// [lower, upper] inside a single applicable-percentage band, computed as
// (contribution_at_upper - contribution_at_lower) / (MAGI_upper - MAGI_lower).
// This collapses to the band's flat rate when initial == final, and captures
// both the linear slope and any rate-jump at the band entry.
function bandAverageMarginalAcaCost({ acaConfig, band, lowerFplPercent, upperFplPercent }) {
  if (!acaConfig?.enabled || !(acaConfig.fpl > 0)) return 0;
  if (upperFplPercent <= lowerFplPercent + 0.0001) return 0;
  const fpl = acaConfig.fpl;
  const bandLower = band.minFplPercent ?? 0;
  const bandUpper = band.maxFplPercent ?? Infinity;
  const initialRate = band.initialRate ?? 0;
  const finalRate = band.finalRate ?? initialRate;
  const positionLower = Number.isFinite(bandUpper) && bandUpper > bandLower
    ? Math.max(0, Math.min(1, (lowerFplPercent - bandLower) / (bandUpper - bandLower)))
    : 0;
  const positionUpper = Number.isFinite(bandUpper) && bandUpper > bandLower
    ? Math.max(0, Math.min(1, (upperFplPercent - bandLower) / (bandUpper - bandLower)))
    : 1;
  const rateLower = initialRate + (finalRate - initialRate) * positionLower;
  const rateUpper = initialRate + (finalRate - initialRate) * positionUpper;
  const magiLower = fpl * lowerFplPercent / 100;
  const magiUpper = fpl * upperFplPercent / 100;
  const denom = magiUpper - magiLower;
  if (denom <= 0) return 0;
  return (rateUpper * magiUpper - rateLower * magiLower) / denom;
}

function bracketCeilingForRate(brackets = [], targetRate = 0.12) {
  const eligible = brackets.filter((bracket) => bracket.rate <= targetRate);
  const last = eligible.at(-1);
  return last ? last.upTo : 0;
}

function traditionalAccountValue(portfolio) {
  return round(portfolio
    .filter((asset) => asset.accountType === "traditional")
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
}

function addTaxableCash(portfolio, amount, calendarYear) {
  const cashAmount = round(Math.max(0, amount), 6);
  if (cashAmount <= 0) return;

  const existingCash = portfolio.find((asset) => (
    asset.accountType === "taxable"
    && asset.assetClass === "cash"
    && (asset.price ?? 0) > 0
  ));
  if (existingCash) {
    existingCash.units = round((existingCash.units ?? 0) + cashAmount / existingCash.price, 8);
    return;
  }

  portfolio.push({
    id: `taxable-cash-${calendarYear}`,
    name: "Taxable cash reserve",
    accountType: "taxable",
    assetClass: "cash",
    holdingPeriod: "long",
    units: cashAmount,
    price: 1,
    costBasisPerUnit: 1,
    dividendYield: 0,
    qualifiedDividendShare: 0
  });
}

function embeddedTaxableGains(portfolio) {
  return round(portfolio.reduce((total, asset) => {
    if (asset.accountType !== "taxable" || asset.assetClass === "cash") return total;
    return total + Math.max(0, (asset.price - (asset.costBasisPerUnit ?? asset.price)) * asset.units);
  }, 0), 6);
}

function estimateHeirValueBreakdown(portfolio, ordinaryTaxRate = 0.24) {
  const assumedOrdinaryTaxRate = Math.max(0, Math.min(1, Number(ordinaryTaxRate) || 0));
  const breakdown = {
    grossValue: 0,
    afterTaxValue: 0,
    assumedOrdinaryTaxRate,
    taxableValue: 0,
    taxableUnrealizedGain: 0,
    taxableStepUpGainAssumed: 0,
    traditionalValue: 0,
    traditionalIncomeTaxEstimate: 0,
    rothValue: 0,
    hsaValue: 0,
    hsaIncomeTaxEstimate: 0,
    otherValue: 0,
    totalIncomeTaxEstimate: 0
  };

  for (const asset of portfolio) {
    const value = marketValue(asset);
    breakdown.grossValue += value;

    if (asset.accountType === "taxable") {
      const basis = (asset.costBasisPerUnit ?? asset.price) * (asset.units ?? 0);
      const unrealizedGain = Math.max(0, value - basis);
      breakdown.taxableValue += value;
      breakdown.taxableUnrealizedGain += unrealizedGain;
      breakdown.taxableStepUpGainAssumed += unrealizedGain;
      breakdown.afterTaxValue += value;
      continue;
    }

    if (asset.accountType === "traditional" || asset.accountType === "hsa") {
      const tax = value * assumedOrdinaryTaxRate;
      if (asset.accountType === "traditional") {
        breakdown.traditionalValue += value;
        breakdown.traditionalIncomeTaxEstimate += tax;
      } else {
        breakdown.hsaValue += value;
        breakdown.hsaIncomeTaxEstimate += tax;
      }
      breakdown.totalIncomeTaxEstimate += tax;
      breakdown.afterTaxValue += value - tax;
      continue;
    }

    if (asset.accountType === "roth") {
      breakdown.rothValue += value;
    } else {
      breakdown.otherValue += value;
    }
    breakdown.afterTaxValue += value;
  }

  return Object.fromEntries(
    Object.entries(breakdown).map(([key, value]) => [
      key,
      key === "assumedOrdinaryTaxRate" ? round(value, 6) : round(value, 2)
    ])
  );
}

function assetSnapshot(portfolio) {
  return clonePortfolio(portfolio).map((asset) => {
    const value = marketValue(asset);
    const costBasis = (asset.costBasisPerUnit ?? asset.price) * (asset.units ?? 0);
    return {
      id: asset.id,
      name: asset.name ?? asset.id,
      accountType: asset.accountType,
      assetClass: asset.assetClass,
      units: round(asset.units ?? 0, 6),
      price: round(asset.price ?? 0, 6),
      costBasis: round(costBasis, 6),
      value: round(value, 6),
      unrealizedGain: round(value - costBasis, 6)
    };
  });
}

function firstDepletionDetails(years) {
  const depleted = years.find(isPortfolioDepleted);
  return {
    depletionYear: depleted?.year ?? null,
    depletionYearIndex: depleted?.yearIndex ?? null,
    depletionAge: depleted?.age ?? null
  };
}

function isPortfolioDepleted(year) {
  return (year?.endingPortfolioValue ?? 0) <= 0;
}

function annualReturns(scenario, returnSequence, yearIndex) {
  if (returnSequence?.[yearIndex]) return returnSequence[yearIndex];
  const assumptions = scenario.returnAssumptions ?? {};
  return Object.fromEntries(
    Object.entries(assumptions)
      .filter(([assetClass]) => assetClass !== "inflation")
      .map(([assetClass, assumption]) => [assetClass, assumption.mean ?? 0])
  );
}

function annualInflation(scenario, inflationSequence, yearIndex) {
  if (Number.isFinite(inflationSequence?.[yearIndex])) return inflationSequence[yearIndex];
  return scenario.returnAssumptions.inflation?.mean ?? 0;
}

function sampleReturnsForYear(scenario, rng) {
  const result = {};
  const correlated = scenario.monteCarlo?.samplingMode === "correlated";
  const factorShocks = correlated
    ? {
        market: standardNormal(rng),
        rates: standardNormal(rng)
      }
    : null;
  for (const [assetClass, assumption] of Object.entries(scenario.returnAssumptions ?? {})) {
    if (assetClass === "inflation") continue;
    const mean = assumption.mean ?? 0;
    const stdev = assumption.stdev ?? 0;
    const sampledReturn = correlated
      ? mean + (stdev * correlatedStandardNormal(rng, assetClass, factorShocks))
      : normalRandom(rng, mean, stdev);
    result[assetClass] = Math.max(-0.95, sampledReturn);
  }
  return result;
}

function correlatedStandardNormal(rng, assetClass, factorShocks) {
  const loadings = MONTE_CARLO_FACTOR_LOADINGS[assetClass];
  if (!loadings) return standardNormal(rng);
  const market = loadings.market ?? 0;
  const rates = loadings.rates ?? 0;
  const idiosyncraticWeight = Math.sqrt(Math.max(0, 1 - (market ** 2) - (rates ** 2)));
  return (market * factorShocks.market)
    + (rates * factorShocks.rates)
    + (idiosyncraticWeight * standardNormal(rng));
}

function standardNormal(rng) {
  return normalRandom(rng, 0, 1);
}

function summarizeAssetClassReturns(returnsByAssetClass = {}, inflationRate = null) {
  const summary = {};
  for (const assetClass of ["stock", "bond", "cash", "realEstate", "tips", "crypto"]) {
    summary[assetClass] = finiteReturnOrNull(returnsByAssetClass[assetClass]);
  }
  summary.inflation = finiteReturnOrNull(inflationRate);
  return summary;
}

function finiteReturnOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? round(value, 6) : null;
}

function expectedReturnForAsset(asset = {}, returnAssumptions = {}) {
  const explicit = Number(asset.expectedReturn);
  if (Number.isFinite(explicit)) return explicit;
  const assumption = returnAssumptions?.[asset.assetClass];
  const mean = Number(typeof assumption === "number" ? assumption : assumption?.mean);
  return Number.isFinite(mean) ? mean : 0;
}

function mergeScenario(scenario) {
  return {
    ...DEFAULT_SCENARIO,
    ...scenario,
    monteCarlo: {
      ...DEFAULT_SCENARIO.monteCarlo,
      ...(scenario.monteCarlo ?? {})
    },
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

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function accountLabel(accountType) {
  return {
    taxable: "Taxable account sales",
    traditional: "Traditional accounts",
    roth: "Roth accounts",
    hsa: "HSA"
  }[accountType] ?? accountType;
}

function saleSortForWithdrawalContext({ accountType, isEarly, maxRothProceeds, context }) {
  if (accountType === "roth") return rothSaleSortForContext({ isEarly, maxRothProceeds, context });
  return context.optimizedLotSelection
    ? (a, b) => optimizedTaxAwareSaleSort(a, b, context)
    : taxAwareSaleSort;
}

function taxAwareSaleSort(a, b) {
  if (a.assetClass === "cash" && b.assetClass !== "cash") return -1;
  if (a.assetClass !== "cash" && b.assetClass === "cash") return 1;
  const aGainRatio = embeddedGainRatio(a);
  const bGainRatio = embeddedGainRatio(b);
  if (a.accountType === "taxable" && b.accountType === "taxable" && aGainRatio !== bGainRatio) {
    return aGainRatio - bGainRatio;
  }
  if (a.holdingPeriod === "long" && b.holdingPeriod === "short") return -1;
  if (a.holdingPeriod === "short" && b.holdingPeriod === "long") return 1;
  return (b.expectedReturn ?? 0) - (a.expectedReturn ?? 0);
}

function optimizedTaxAwareSaleSort(a, b, context = {}) {
  const reserveCompare = sequenceRiskReserveSaleCompare(a, b, context.sequenceRiskReserve);
  if (reserveCompare !== 0) return reserveCompare;
  const allocationCompare = allocationWithdrawalSaleCompare(a, b, context.allocationWithdrawal);
  if (allocationCompare !== 0) return allocationCompare;
  if (a.assetClass === "cash" && b.assetClass !== "cash") return -1;
  if (a.assetClass !== "cash" && b.assetClass === "cash") return 1;
  const aExpectedReturn = expectedReturnForAsset(a, context.returnAssumptions);
  const bExpectedReturn = expectedReturnForAsset(b, context.returnAssumptions);
  if (a.accountType === "taxable" && b.accountType === "taxable") {
    const aGainRatio = embeddedGainRatio(a);
    const bGainRatio = embeddedGainRatio(b);
    if (Math.abs(aGainRatio - bGainRatio) > 0.01) return aGainRatio - bGainRatio;
    if (a.holdingPeriod === "long" && b.holdingPeriod === "short") return -1;
    if (a.holdingPeriod === "short" && b.holdingPeriod === "long") return 1;
  }
  if (aExpectedReturn !== bExpectedReturn) return aExpectedReturn - bExpectedReturn;
  const aPriority = ROTH_BASIS_ASSET_CLASS_PRIORITY[a.assetClass] ?? 99;
  const bPriority = ROTH_BASIS_ASSET_CLASS_PRIORITY[b.assetClass] ?? 99;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return taxAwareSaleSort(a, b);
}

function sequenceRiskReserveSaleCompare(a, b, reserveState) {
  if (!reserveState?.enabled) return 0;
  const reserveClasses = new Set(reserveState.assetClasses ?? []);
  const aReserve = reserveClasses.has(a.assetClass);
  const bReserve = reserveClasses.has(b.assetClass);
  if (aReserve === bReserve) return 0;
  if (reserveState.spendReserveFirst) return aReserve ? -1 : 1;
  if (reserveState.preserveReserve) return aReserve ? 1 : -1;
  return 0;
}

function allocationWithdrawalSaleCompare(a, b, allocationState) {
  if (!allocationState?.enabled || !allocationState.direction) return 0;
  const aStock = a.assetClass === "stock";
  const bStock = b.assetClass === "stock";
  const aDefensive = DEFENSIVE_ASSET_CLASSES.includes(a.assetClass);
  const bDefensive = DEFENSIVE_ASSET_CLASSES.includes(b.assetClass);
  if (allocationState.direction === "sell-stock" && aStock !== bStock) return aStock ? -1 : 1;
  if (allocationState.direction === "sell-defensive" && aDefensive !== bDefensive) return aDefensive ? -1 : 1;
  return 0;
}

function rothDistributionSort(a, b) {
  if (a.rothSource === "conversion" && b.rothSource !== "conversion") return -1;
  if (a.rothSource !== "conversion" && b.rothSource === "conversion") return 1;
  if (a.rothSource === "conversion" && b.rothSource === "conversion") {
    return (a.conversionYear ?? Infinity) - (b.conversionYear ?? Infinity);
  }
  return taxAwareSaleSort(a, b);
}

function rothSaleSortForContext({ isEarly, maxRothProceeds, context = {} }) {
  return isEarly && Number.isFinite(maxRothProceeds)
    ? (a, b) => rothBasisWithdrawalSort(a, b, context)
    : context.optimizedLotSelection
      ? (a, b) => optimizedTaxAwareSaleSort(a, b, context)
      : rothDistributionSort;
}

function rothBasisWithdrawalSort(a, b, context = {}) {
  const aPenaltyFree = rothPenaltyFreePrincipalLot(a, context);
  const bPenaltyFree = rothPenaltyFreePrincipalLot(b, context);
  if (aPenaltyFree !== bPenaltyFree && !(context.rothBasisRemaining > 0)) return aPenaltyFree ? -1 : 1;

  const aExpectedReturn = Number(a.expectedReturn);
  const bExpectedReturn = Number(b.expectedReturn);
  if (Number.isFinite(aExpectedReturn) && Number.isFinite(bExpectedReturn) && aExpectedReturn !== bExpectedReturn) {
    return aExpectedReturn - bExpectedReturn;
  }
  if (Number.isFinite(aExpectedReturn) !== Number.isFinite(bExpectedReturn)) {
    return Number.isFinite(aExpectedReturn) ? -1 : 1;
  }

  const aPriority = ROTH_BASIS_ASSET_CLASS_PRIORITY[a.assetClass] ?? 99;
  const bPriority = ROTH_BASIS_ASSET_CLASS_PRIORITY[b.assetClass] ?? 99;
  if (aPriority !== bPriority) return aPriority - bPriority;

  const aValue = marketValue(a);
  const bValue = marketValue(b);
  if (aValue !== bValue) return aValue - bValue;
  return String(a.name ?? a.id ?? "").localeCompare(String(b.name ?? b.id ?? ""));
}

function rothPenaltyFreePrincipalLot(asset = {}, context = {}) {
  if (asset.accountType !== "roth" || asset.rothSource !== "conversion") return false;
  if ((context.age ?? 99) >= (context.penaltyAge ?? 59.5)) return true;
  const conversionYear = Number(asset.conversionYear);
  return Number.isFinite(conversionYear) && (context.calendarYear ?? 0) - conversionYear >= 5;
}

function embeddedGainRatio(asset) {
  const value = marketValue(asset);
  if (value <= 0) return 0;
  return (value - (asset.costBasisPerUnit ?? asset.price) * asset.units) / value;
}
