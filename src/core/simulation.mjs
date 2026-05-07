import { computeAca, DEFAULT_ACA_CONFIG, inflateAcaConfig } from "./aca.mjs";
import {
  accountBreakdown,
  applyReturns,
  clonePortfolio,
  dividendIncome,
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
  inflateTaxProfile
} from "./tax.mjs";
import { getMedicareIrmaaConfig } from "../data/taxData.mjs";
import { createRng, normalRandom, percentile, round } from "./utils.mjs";

export const DEFAULT_SCENARIO = {
  planYears: 35,
  startYear: 2026,
  targetSpend: 90000,
  targetSpendInflationAdjusted: true,
  targetSpendIncludesTaxes: false,
  targetSpendIncludesMedical: false,
  medicalExpensesBase: 0,
  expectedOopMaxUsePercent: 0.25,
  oopMaxOverride: null,
  withdrawalOrder: ["taxable", "traditional", "hsa", "roth"],
  withdrawalStrategy: {
    mode: "heuristic",
    expectedReturnPenaltyYears: 1,
    gainHarvestingFutureTaxDiscount: 0.85
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
    minSavingsRate: 0.5
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
  returnAssumptions: {
    stock: { mean: 0.065, stdev: 0.18 },
    bond: { mean: 0.028, stdev: 0.06 },
    cash: { mean: 0.015, stdev: 0.015 },
    realEstate: { mean: 0.05, stdev: 0.14 },
    tips: { mean: 0.025, stdev: 0.07 },
    crypto: { mean: 0.12, stdev: 0.65 },
    inflation: { mean: 0.025, stdev: 0.012 }
  },
  taxLossHarvesting: { enabled: true, mode: "auto", overrideMaxLoss: null },
  taxGainHarvesting: { enabled: true, mode: "auto", overrideMaxGain: null },
  rothConversion: {
    enabled: true,
    mode: "auto",
    overrideAmount: null,
    annualAmount: null,
    targetMarginalRate: 0.12,
    optimizeForAca: true,
    maxAcaFplPercent: 400
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
  const mergedScenario = mergeScenario(scenario);
  const portfolio = clonePortfolio(assets);
  const years = [];
  let lossCarryforward = 0;
  let rothBasisRemaining = Math.max(0, mergedScenario.rothBasis ?? 0);
  let success = true;
  let inflationIndex = 1;
  const magiHistory = [];

  for (let yearIndex = 0; yearIndex < mergedScenario.planYears; yearIndex += 1) {
    if (yearIndex > 0) {
      inflationIndex *= 1 + annualInflation(mergedScenario, inflationSequence, yearIndex - 1);
    }

    const returnByAssetClass = annualReturns(mergedScenario, returnSequence, yearIndex);
    const currentInflationRate = annualInflation(mergedScenario, inflationSequence, yearIndex);
    const result = simulateYear({
      portfolio,
      scenario: mergedScenario,
      taxProfile,
      yearIndex,
      inflationIndex,
      returnByAssetClass,
      annualInflationRate: currentInflationRate,
      lossCarryforward,
      rothBasisRemaining,
      magiHistory
    });

    lossCarryforward = result.lossCarryforward;
    rothBasisRemaining = result.rothBasisRemaining;
    magiHistory.push(result.magi);
    success = success && result.unfunded <= 1;
    years.push(result);
  }

  const endingAccounts = accountBreakdown(portfolio);
  const endingValue = portfolioValue(portfolio);
  return {
    success,
    years,
    endingValue,
    endingAccounts,
    heirValue: estimateHeirValue(portfolio, mergedScenario.heirOrdinaryTaxRate),
    rothBasisRemaining,
    finalPortfolio: clonePortfolio(portfolio)
  };
}

export function runMonteCarlo({
  assets,
  scenario = {},
  taxProfile = DEFAULT_TAX_PROFILE,
  runs = 500,
  seed = 42
}) {
  const mergedScenario = mergeScenario(scenario);
  const rng = createRng(seed);
  const scenarios = [];

  for (let run = 0; run < runs; run += 1) {
    const returnSequence = [];
    const inflationSequence = [];
    for (let year = 0; year < mergedScenario.planYears; year += 1) {
      returnSequence.push(sampleReturnsForYear(mergedScenario, rng));
      inflationSequence.push(Math.max(-0.08, normalRandom(
        rng,
        mergedScenario.returnAssumptions.inflation?.mean ?? 0.025,
        mergedScenario.returnAssumptions.inflation?.stdev ?? 0.012
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
    scenarios.push({
      id: run + 1,
      success: plan.success,
      endingValue: plan.endingValue,
      heirValue: plan.heirValue,
      ...depletion,
      years: plan.years
    });
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
    const annotatedPlan = withHistoricalSourceYears(plan, sequence.sourceYears ?? []);
    const depletion = firstDepletionDetails(annotatedPlan.years);
    return {
      id: sequence.name ?? `Sequence ${index + 1}`,
      sourceYears: sequence.sourceYears ?? [],
      sourceStartYear: sequence.startYear ?? null,
      sourceEndYear: sequence.endYear ?? null,
      ...depletion,
      ...annotatedPlan
    };
  });
}

function withHistoricalSourceYears(plan, sourceYears = []) {
  if (!sourceYears.length) return plan;
  return {
    ...plan,
    years: plan.years.map((year, index) => ({
      ...year,
      historicalSourceYear: sourceYears[index % sourceYears.length] ?? null
    }))
  };
}

function simulateYear({
  portfolio,
  scenario,
  taxProfile,
  yearIndex,
  inflationIndex,
  returnByAssetClass,
  annualInflationRate,
  lossCarryforward,
  rothBasisRemaining,
  magiHistory = []
}) {
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
  const beginningPortfolioValue = portfolioValue(portfolio);
  const beginningTraditionalValue = traditionalAccountValue(portfolio);
  const beginningAssets = assetSnapshot(portfolio);
  applyReturns(portfolio, returnByAssetClass);
  const afterReturnPortfolioValue = portfolioValue(portfolio);

  const dividends = dividendIncome(portfolio);
  const flows = [...dividends.flows];
  const oneOffCashFlows = oneOffCashFlowsForYear(scenario, yearIndex + 1, inflationIndex);
  const recurringEarnedIncome = earnedIncomeForYear(scenario, inflationIndex);
  const earnedIncome = mergeEarnedIncome(recurringEarnedIncome, oneOffCashFlows.earnedIncome);
  const incomeCashAvailable = round(recurringEarnedIncome.cash + oneOffCashFlows.income, 6);
  let ordinaryIncome = dividends.ordinaryDividends + earnedIncome.ordinaryIncome + oneOffCashFlows.taxableOrdinaryIncome;
  let qualifiedDividends = dividends.qualifiedDividends;
  let strategyCapitalLosses = 0;
  let strategyLongTermGains = 0;
  const annualPenaltyExceptionAmount = earlyWithdrawalPenaltyExceptionAmountForYear(scenario);

  const lossHarvestLimit = strategyLimit({
    strategy: scenario.taxLossHarvesting,
    autoValue: automaticTaxLossHarvestLimit(portfolio, yearTaxProfile, lossCarryforward),
    legacyField: "maxLoss",
    overrideField: "overrideMaxLoss"
  });
  const lossHarvest = scenario.taxLossHarvesting?.enabled
    ? harvestTaxLosses(portfolio, lossHarvestLimit)
    : { realizedLosses: 0, flows: [] };
  strategyCapitalLosses += lossHarvest.realizedLosses;
  flows.push(...lossHarvest.flows);

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
      qualifiedDividends,
      age,
      inflationIndex
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

  const plannedSpending = plannedSpendingForYear(scenario, yearIndex + 1, inflationIndex, oneOffCashFlows);
  let finalWithdrawal = null;
  let finalTaxes = null;
  let finalAca = null;
  let finalMedicare = emptyMedicareCost();
  let finalTaxableSocialSecurity = 0;
  let finalPortfolio = null;
  let finalRothBasisOptimization = null;
  let medicalEstimate = 0;
  let taxEstimate = 0;

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const cashRequired = plannedSpending
      + (scenario.targetSpendIncludesMedical ? 0 : medicalEstimate)
      + (scenario.targetSpendIncludesTaxes ? 0 : taxEstimate);
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
        rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
        penaltyExceptionRemaining: rmdWithdrawal.penaltyExceptionRemaining,
        returnAssumptions: scenario.returnAssumptions,
        optimizedLotSelection: isLifetimeOptimizerEnabled(scenario)
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
        strategyLongTermGains,
        strategyCapitalLosses,
        lossCarryforward,
        socialSecurityBenefits,
        age,
        spouseAge,
        yearIndex,
        magiHistory
      }
    });

    medicalEstimate = scenario.targetSpendIncludesMedical ? 0 : chosenPlan.medicalTotal;
    taxEstimate = chosenPlan.taxes.totalTax;

    finalWithdrawal = chosenPlan.withdrawal;
    finalTaxes = chosenPlan.taxes;
    finalAca = chosenPlan.aca;
    finalMedicare = chosenPlan.medicare;
    finalTaxableSocialSecurity = chosenPlan.taxableSocialSecurity;
    finalPortfolio = chosenPlan.portfolio;
    finalRothBasisOptimization = chosenPlan.rothBasisOptimization;
  }

  if (scenario.taxGainHarvesting?.enabled) {
    const gainHarvestLimit = gainHarvestingRoom({
      taxes: finalTaxes,
      taxProfile: yearTaxProfile,
      acaConfig: yearAcaConfig,
      currentMagi: estimateMagi(incomeForYear({
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome: rothConversionAmount,
        ordinaryInvestmentIncome: dividends.ordinaryDividends,
        qualifiedDividends,
        strategyLongTermGains,
        strategyCapitalLosses,
        withdrawal: finalWithdrawal,
        socialSecurityBenefits,
        taxProfile: yearTaxProfile,
        scenario
      }).income),
      configuredMaxGain: strategyLimit({
        strategy: scenario.taxGainHarvesting,
        autoValue: Infinity,
        legacyField: "maxGain",
        overrideField: "overrideMaxGain"
      }),
      portfolio: finalPortfolio,
      scenario,
      age,
      yearIndex
    });
    const gainHarvest = harvestTaxGains(finalPortfolio, gainHarvestLimit);
    strategyLongTermGains += gainHarvest.realizedGains;
    flows.push(...gainHarvest.flows);

    if (gainHarvest.realizedGains > 0) {
      const { income, taxableSocialSecurity } = incomeForYear({
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome: rothConversionAmount,
        ordinaryInvestmentIncome: dividends.ordinaryDividends,
        qualifiedDividends,
        strategyLongTermGains,
        strategyCapitalLosses,
        withdrawal: finalWithdrawal,
        socialSecurityBenefits,
        taxProfile: yearTaxProfile,
        scenario
      });
      finalTaxes = computeIncomeTax({
        ...income,
        capitalLossCarryforward: lossCarryforward,
        profile: yearTaxProfile
      });
      finalTaxes = addPenaltyTax(finalTaxes, finalWithdrawal.penaltyTax);
      const magi = estimateMagi(income);
      finalAca = computeAcaForYear({ age, magi, config: yearAcaConfig });
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
          magi,
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
    dividends,
    incomeCashAvailable,
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome: rothConversionAmount,
    qualifiedDividends,
    strategyLongTermGains,
    strategyCapitalLosses,
    lossCarryforward,
    socialSecurityBenefits,
    age,
    spouseAge,
    yearIndex,
    calendarYear,
    magiHistory
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
    + (scenario.targetSpendIncludesTaxes ? 0 : finalTaxes.totalTax);
  const { income: finalIncome, taxableSocialSecurity: reconciledTaxableSocialSecurity } = incomeForYear({
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome: rothConversionAmount,
    ordinaryInvestmentIncome: dividends.ordinaryDividends,
    qualifiedDividends,
    strategyLongTermGains,
    strategyCapitalLosses,
    withdrawal: finalWithdrawal,
    socialSecurityBenefits,
    taxProfile: yearTaxProfile,
    scenario
  });
  finalTaxableSocialSecurity = reconciledTaxableSocialSecurity;
  const finalMagi = round(estimateMagi(finalIncome), 6);
  const finalAcaMagiTarget = acaMagiCeiling({
    acaConfig: yearAcaConfig,
    currentMagi: finalMagi,
    maxFplPercent: scenario.rothConversion?.maxAcaFplPercent ?? 400
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
    strategyLongTermGains,
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
  if (plannedSpending > 0) {
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

  const unfunded = Math.max(0, totalCashRequired - cashAvailable);

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
    magi: finalMagi,
    realizedLongTermGains: round(strategyLongTermGains + finalWithdrawal.longTermCapitalGains, 6),
    taxGainHarvested: round(strategyLongTermGains, 6),
    realizedShortTermGains: finalWithdrawal.shortTermCapitalGains,
    realizedCapitalLosses: round(strategyCapitalLosses + finalWithdrawal.capitalLosses, 6),
    lossCarryforward: finalTaxes.lossCarryforward,
    rothConversionAmount: round(rothConversionAmount, 6),
    penaltyTax: round(finalTaxes.penaltyTax ?? 0, 6),
    penaltyBase: round(finalWithdrawal.penaltyBase ?? 0, 6),
    penaltyExceptionUsed: round(finalWithdrawal.penaltyExceptionUsed ?? 0, 6),
    penaltyExceptionRemaining: round(finalWithdrawal.penaltyExceptionRemaining ?? 0, 6),
    rothWithdrawals: round(finalWithdrawal.rothProceeds, 6),
    rothBasisUsed: round(finalWithdrawal.rothBasisUsed, 6),
    rothBasisRemaining: round(finalWithdrawal.rothBasisRemaining, 6),
    rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
    rothBasisOptimization: finalRothBasisOptimization,
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
  dividends,
  incomeCashAvailable = 0,
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  qualifiedDividends,
  strategyLongTermGains,
  strategyCapitalLosses,
  lossCarryforward,
  socialSecurityBenefits,
  age,
  spouseAge,
  yearIndex,
  calendarYear,
  magiHistory
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
      + (scenario.targetSpendIncludesTaxes ? 0 : currentTaxes.totalTax);
    const cashAvailable = dividends.cash + incomeCashAvailable + socialSecurityBenefits + currentWithdrawal.cashRaised;
    const gap = totalCashRequired - cashAvailable;
    if (gap <= 1) break;

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
        rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
        penaltyExceptionRemaining: currentWithdrawal.penaltyExceptionRemaining,
        returnAssumptions: scenario.returnAssumptions,
        optimizedLotSelection: isLifetimeOptimizerEnabled(scenario)
      },
      evaluationContext: {
        scenario,
        yearTaxProfile,
        yearAcaConfig,
        inflationIndex,
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome,
        ordinaryInvestmentIncome: dividends.ordinaryDividends,
        qualifiedDividends,
        strategyLongTermGains,
        strategyCapitalLosses,
        lossCarryforward,
        socialSecurityBenefits,
        age,
        spouseAge,
        yearIndex,
        magiHistory
      }
    });
    if (chosenTopUp.withdrawal.cashRaised <= currentWithdrawal.cashRaised + 0.000001) break;

    portfolio.splice(0, portfolio.length, ...chosenTopUp.portfolio);
    currentWithdrawal = chosenTopUp.withdrawal;
    currentTaxableSocialSecurity = chosenTopUp.taxableSocialSecurity;
    currentTaxes = chosenTopUp.taxes;
    currentAca = chosenTopUp.aca;
    currentMedicalEstimate = scenario.targetSpendIncludesMedical ? 0 : chosenTopUp.medicalTotal;
    currentMedicare = chosenTopUp.medicare;
    currentRothBasisOptimization = chosenTopUp.rothBasisOptimization;
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
  const baselineRoth = rothWithdrawalProceeds(baseline.withdrawal) - rothWithdrawalProceeds(baseWithdrawal);
  const candidateRoth = rothWithdrawalProceeds(candidate.withdrawal) - rothWithdrawalProceeds(baseWithdrawal);
  const extraRothWithdrawal = round(Math.max(0, candidateRoth - Math.max(0, baselineRoth)), 6);
  const modeledSavings = round(Math.max(0, baseline.modeledCost - candidate.modeledCost), 6);
  const requiredSavings = round(extraRothWithdrawal * optimization.minSavingsRate, 6);
  const accepted = extraRothWithdrawal > 0.000001 && modeledSavings + 0.01 >= requiredSavings;

  return withRothOptimizationDecision(accepted ? candidate : baseline, {
    enabled: true,
    accepted,
    reason: accepted ? "savings-hurdle-met" : "savings-below-hurdle",
    minSavingsRate: optimization.minSavingsRate,
    extraRothWithdrawal,
    modeledSavings,
    requiredSavings
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
  let bestScore = lifetimeWithdrawalScore(best, config);

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
    const baselineRoth = rothWithdrawalProceeds(baseline.withdrawal) - rothWithdrawalProceeds(baseWithdrawal);
    const candidateRoth = rothWithdrawalProceeds(candidate.withdrawal) - rothWithdrawalProceeds(baseWithdrawal);
    const extraRothWithdrawal = round(Math.max(0, candidateRoth - Math.max(0, baselineRoth)), 6);
    const modeledSavings = round(Math.max(0, baseline.modeledCost - candidate.modeledCost), 6);
    const requiredSavings = round(extraRothWithdrawal * rothOptimization.minSavingsRate, 6);

    if (extraRothWithdrawal > 0.000001 && (!rothOptimization.enabled || modeledSavings + 0.01 < requiredSavings)) {
      continue;
    }

    const annotated = withRothOptimizationDecision(candidate, {
      enabled: rothOptimization.enabled,
      accepted: extraRothWithdrawal > 0.000001,
      reason: extraRothWithdrawal > 0.000001 ? "lifetime-savings-hurdle-met" : "lifetime-lower-cost-source",
      minSavingsRate: rothOptimization.minSavingsRate,
      extraRothWithdrawal,
      modeledSavings,
      requiredSavings
    });
    const score = lifetimeWithdrawalScore(annotated, config);
    if (score + 0.01 < bestScore) {
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

  if (rothOptimization.enabled && requestedOrder.includes("roth") && amount > 0) {
    const rothOrder = rothFirstWithdrawalOrder(requestedOrder);
    for (const limit of rothSubstitutionLimits({
      baseline,
      withdrawalContext,
      evaluationContext,
      amount
    })) {
      candidates.push({ order: rothOrder, maxRothProceeds: limit });
    }
  }

  return candidates;
}

function rothSubstitutionLimits({ baseline, withdrawalContext, evaluationContext, amount }) {
  const maxRoth = optimizedRothProceedsLimit(withdrawalContext);
  if (!(maxRoth > 0)) return [];
  const baselineRoth = rothWithdrawalProceeds(baseline.withdrawal);
  const thresholds = magiOptimizationThresholds({
    magi: baseline.magi,
    yearTaxProfile: evaluationContext.yearTaxProfile,
    yearAcaConfig: evaluationContext.yearAcaConfig
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

function magiOptimizationThresholds({ magi, yearTaxProfile, yearAcaConfig }) {
  const thresholds = [];
  if (yearAcaConfig?.enabled && yearAcaConfig.fpl > 0) {
    thresholds.push(...(yearAcaConfig.applicablePercentageTable ?? [])
      .map((row) => row.maxFplPercent)
      .filter((percent) => Number.isFinite(percent) && percent > 0)
      .map((percent) => yearAcaConfig.fpl * percent / 100));
    thresholds.push(yearAcaConfig.fpl * ((yearAcaConfig.maxEligibleFplPercent ?? 400) / 100));
  }
  const niitThreshold = yearTaxProfile?.niit?.thresholds?.[yearTaxProfile.filingStatus];
  if (Number.isFinite(niitThreshold)) thresholds.push(niitThreshold);
  return thresholds
    .filter((threshold) => Number.isFinite(threshold) && threshold > 0 && threshold < magi - 0.000001)
    .sort((a, b) => b - a);
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

function lifetimeWithdrawalScore(plan, config) {
  return round(
    plan.modeledCost
      + Math.max(0, plan.withdrawal?.saleOpportunityCost ?? 0) * config.expectedReturnPenaltyYears,
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
  qualifiedDividends,
  strategyLongTermGains,
  strategyCapitalLosses,
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
    strategyLongTermGains,
    strategyCapitalLosses,
    withdrawal,
    socialSecurityBenefits,
    taxProfile: yearTaxProfile,
    scenario
  });
  const taxes = computeIncomeTax({
    ...income,
    capitalLossCarryforward: lossCarryforward,
    profile: yearTaxProfile
  });
  const taxesWithPenalties = addPenaltyTax(taxes, withdrawal.penaltyTax);
  const magi = estimateMagi(income);
  const aca = computeAcaForYear({ age, magi, config: yearAcaConfig });
  const medical = medicalCostForYear({
    scenario,
    aca,
    yearAcaConfig,
    inflationIndex,
    age,
    spouseAge,
    yearIndex,
    filingStatus: yearTaxProfile.filingStatus,
    magi,
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
    magi
  };
}

function withRothOptimizationDecision(plan, decision) {
  return {
    ...plan,
    rothBasisOptimization: {
      ...decision,
      extraRothWithdrawal: round(decision.extraRothWithdrawal ?? 0, 6),
      modeledSavings: round(decision.modeledSavings ?? 0, 6),
      requiredSavings: round(decision.requiredSavings ?? 0, 6)
    }
  };
}

function rothBasisOptimizationConfig(scenario) {
  const config = scenario.rothBasisOptimization ?? {};
  const minSavingsRate = Number(config.minSavingsRate);
  return {
    enabled: config.enabled !== false,
    minSavingsRate: Number.isFinite(minSavingsRate) && minSavingsRate >= 0 ? minSavingsRate : 0.5
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

function sameWithdrawalOrder(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function optimizedRothProceedsLimit(withdrawalContext) {
  if ((withdrawalContext.age ?? 99) >= (withdrawalContext.penaltyAge ?? 59.5)) return Infinity;
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
    penaltyTax: round(base.penaltyTax + addition.penaltyTax, 6),
    penaltyBase: round(base.penaltyBase + addition.penaltyBase, 6),
    penaltyExceptionUsed: round((base.penaltyExceptionUsed ?? 0) + (addition.penaltyExceptionUsed ?? 0), 6),
    penaltyExceptionRemaining: round(Math.max(0, addition.penaltyExceptionRemaining ?? base.penaltyExceptionRemaining ?? 0), 6),
    rothProceeds: round((base.rothProceeds ?? 0) + (addition.rothProceeds ?? 0), 6),
    rothBasisUsed: round(base.rothBasisUsed + addition.rothBasisUsed, 6),
    rothBasisRemaining: addition.rothBasisRemaining,
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
    penaltyTax: 0,
    penaltyBase: 0,
    penaltyExceptionUsed: 0,
    penaltyExceptionRemaining: round(Math.max(0, penaltyExceptionRemaining), 6),
    rothProceeds: 0,
    rothBasisUsed: 0,
    rothBasisRemaining: round(Math.max(0, rothBasisRemaining), 6),
    saleOpportunityCost: 0,
    sales: [],
    flows: []
  };
}

function withdrawForCash(portfolio, amount, withdrawalOrder = [], context = {}) {
  let remaining = Math.max(0, amount);
  let rothBasisRemaining = Math.max(0, context.rothBasisRemaining ?? 0);
  let penaltyExceptionRemaining = Math.max(0, context.penaltyExceptionRemaining ?? 0);
  const age = context.age ?? 99;
  const calendarYear = context.calendarYear ?? 0;
  const penaltyAge = context.penaltyAge ?? 59.5;
  const penaltyRate = context.penaltyRate ?? 0.1;
  const rothFiveYearRuleSatisfied = context.rothFiveYearRuleSatisfied !== false;
  const maxRothProceeds = Number.isFinite(Number(context.maxRothProceeds))
    ? Math.max(0, Number(context.maxRothProceeds))
    : Infinity;
  const isEarly = age < penaltyAge;
  const result = {
    cashRaised: 0,
    ordinaryIncome: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    penaltyTax: 0,
    penaltyBase: 0,
    penaltyExceptionUsed: 0,
    penaltyExceptionRemaining,
    rothProceeds: 0,
    rothBasisUsed: 0,
    rothBasisRemaining,
    saleOpportunityCost: 0,
    sales: [],
    flows: []
  };

  for (const accountType of withdrawalOrder) {
    const saleSort = saleSortForWithdrawalContext({ accountType, isEarly, maxRothProceeds, context });
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
      }
      const sale = sellFromLot(asset, requestedSale);
      if (sale.proceeds <= 0) continue;

      remaining -= sale.proceeds;
      result.cashRaised += sale.proceeds;
      sale.expectedReturn = expectedReturnForAsset(asset, context.returnAssumptions);
      sale.opportunityCost = round(Math.max(0, sale.proceeds * Math.max(0, sale.expectedReturn ?? 0)), 6);
      result.saleOpportunityCost += sale.opportunityCost;
      if (sale.accountType === "roth") result.rothProceeds += sale.proceeds;
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
      } else if (sale.accountType === "taxable" && sale.taxType === "capital-loss") {
        result.capitalLosses += Math.abs(Math.min(0, sale.gain));
      }
    }
  }

  result.cashRaised = round(result.cashRaised, 6);
  result.ordinaryIncome = round(result.ordinaryIncome, 6);
  result.shortTermCapitalGains = round(result.shortTermCapitalGains, 6);
  result.longTermCapitalGains = round(result.longTermCapitalGains, 6);
  result.capitalLosses = round(result.capitalLosses, 6);
  result.penaltyTax = round(result.penaltyTax, 6);
  result.penaltyBase = round(result.penaltyBase, 6);
  result.penaltyExceptionUsed = round(result.penaltyExceptionUsed, 6);
  result.penaltyExceptionRemaining = round(penaltyExceptionRemaining, 6);
  result.rothProceeds = round(result.rothProceeds, 6);
  result.rothBasisUsed = round(result.rothBasisUsed, 6);
  result.rothBasisRemaining = round(rothBasisRemaining, 6);
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

function combineIncome({
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends,
  strategyLongTermGains,
  strategyCapitalLosses,
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
    medicareWages: earnedIncome.medicareWages,
    selfEmploymentIncome: earnedIncome.selfEmploymentIncome,
    rrtaCompensation: earnedIncome.rrtaCompensation,
    taxableSocialSecurity: taxableSocialSecurityAmount,
    nonTaxableSocialSecurity: Math.max(0, socialSecurityTotal - taxableSocialSecurityAmount),
    shortTermCapitalGains: withdrawal.shortTermCapitalGains,
    longTermCapitalGains: strategyLongTermGains + withdrawal.longTermCapitalGains,
    qualifiedDividends,
    capitalLosses: strategyCapitalLosses + withdrawal.capitalLosses
  };
}

function incomeForYear({
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends,
  strategyLongTermGains,
  strategyCapitalLosses,
  withdrawal,
  socialSecurityBenefits,
  taxProfile,
  scenario
}) {
  const incomeBeforeSocialSecurity = combineIncome({
    ordinaryIncome,
    retirementOrdinaryIncome,
    ordinaryInvestmentIncome,
    earnedIncome,
    qualifiedDividends,
    strategyLongTermGains,
    strategyCapitalLosses,
    withdrawal,
    socialSecurityBenefits: 0,
    taxableSocialSecurity: 0
  });
  const taxableSocialSecurity = computeTaxableSocialSecurityBenefits({
    benefits: socialSecurityBenefits,
    otherIncome: estimateMagi(incomeBeforeSocialSecurity),
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
      strategyLongTermGains,
      strategyCapitalLosses,
      withdrawal,
      socialSecurityBenefits,
      taxableSocialSecurity
    })
  };
}

function estimateMagi(income) {
  return Math.max(0,
    income.ordinaryIncome
    + Math.max(0, income.shortTermCapitalGains)
    + Math.max(0, income.longTermCapitalGains)
    + Math.max(0, income.qualifiedDividends)
    + Math.max(0, income.nonTaxableSocialSecurity ?? 0)
  );
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

function computeAcaForYear({ age, magi, config }) {
  if (age >= 65) return computeAca({ magi, config: { ...config, enabled: false } });
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
  magi,
  magiHistory
}) {
  const baseMedical = medicalCostForScenario(scenario, yearAcaConfig, inflationIndex, aca);
  const medicare = computeMedicareCostForYear({
    scenario,
    age,
    spouseAge,
    yearIndex,
    filingStatus,
    magi,
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
  magi,
  magiHistory,
  inflationIndex
}) {
  const medicare = scenario.medicare ?? {};
  if (medicare.irmaaEnabled === false || age < 65) return emptyMedicareCost();

  const config = getMedicareIrmaaConfig({ taxYear: scenario.taxYear, inflationIndex });
  const lookbackMagi = medicareLookbackMagi({
    scenario,
    yearIndex,
    currentMagi: magi,
    magiHistory
  });
  const bracket = medicareIrmaaBracket({
    config,
    magi: lookbackMagi,
    filingStatus,
    marriedFilingSeparatelyLivedTogether: medicare.marriedFilingSeparatelyLivedTogether
  });
  const autoEnrollees = filingStatus === "marriedFilingJointly"
    ? (age >= 65 ? 1 : 0) + (Number.isFinite(spouseAge) && spouseAge >= 65 ? 1 : 0)
    : 1;
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
  if (yearIndex === 1 && Number.isFinite(Number(medicare.priorYearMagi))) return Number(medicare.priorYearMagi);
  if (yearIndex === 0 && Number.isFinite(Number(medicare.twoYearsPriorMagi))) return Number(medicare.twoYearsPriorMagi);
  return Math.max(0, Number(currentMagi) || 0);
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

function plannedSpendingForYear(scenario, planYear, inflationIndex, oneOffCashFlows = null) {
  const baseSpend = (scenario.targetSpend ?? 0)
    * (scenario.targetSpendInflationAdjusted === false ? 1 : inflationIndex);
  const scheduled = oneOffCashFlows ?? oneOffCashFlowsForYear(scenario, planYear, inflationIndex);
  return round(baseSpend + scheduled.expenses, 6);
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
  strategyLongTermGains,
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
  addSource("Tax gain harvesting", { longTermCapitalGains: strategyLongTermGains });

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
  age = null
} = {}) {
  const zeroBracket = taxProfile.capitalGainsBrackets?.find((bracket) => bracket.rate === 0);
  if (!zeroBracket) return 0;
  const taxableIncomeAlreadyStacked = taxes.taxableOrdinaryIncome + taxes.taxablePreferentialIncome;
  const federalRoom = Math.max(0, zeroBracket.upTo - taxableIncomeAlreadyStacked);
  const acaTarget = acaMagiCeiling({
    acaConfig,
    currentMagi,
    maxFplPercent: acaConfig?.maxEligibleFplPercent ?? 400
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
  const embeddedGains = embeddedTaxableGains(portfolio);
  return round(Math.max(0, Math.min(configuredMaxGain ?? Infinity, federalFifteenRoom, acaRoom, embeddedGains)), 6);
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

function topBracketRate(brackets = []) {
  return Math.max(0, ...brackets.map((bracket) => bracket.rate ?? 0).filter(Number.isFinite));
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
  qualifiedDividends,
  age = null,
  inflationIndex = 1
}) {
  const requested = scenario.rothConversion?.overrideAmount != null
    && Number.isFinite(Number(scenario.rothConversion.overrideAmount))
    ? Number(scenario.rothConversion.overrideAmount)
    : scenario.rothConversion?.annualAmount != null
      && Number.isFinite(Number(scenario.rothConversion.annualAmount))
      ? Number(scenario.rothConversion.annualAmount)
      : null;
  if (requested !== null && requested >= 0) return requested;

  const targetRate = effectiveRothConversionTargetRate({ portfolio, scenario, age });
  const targetCeiling = bracketCeilingForRate(taxProfile.ordinaryBrackets, targetRate);
  const federalRoom = Math.max(0, targetCeiling + (taxProfile.standardDeduction ?? 0) - ordinaryIncome);
  const magiBeforeConversion = Math.max(0, ordinaryIncome + qualifiedDividends);
  const acaTarget = scenario.rothConversion?.optimizeForAca === false
    ? {
        amount: (acaConfig?.fpl ?? 0) * ((scenario.rothConversion?.maxAcaFplPercent ?? 400) / 100)
      }
    : acaMagiCeiling({
        acaConfig,
        currentMagi: magiBeforeConversion,
        maxFplPercent: scenario.rothConversion?.maxAcaFplPercent ?? 400
      });
  const acaRoom = acaConfig?.enabled
    ? Math.max(0, acaTarget.amount - magiBeforeConversion)
    : Infinity;
  const irmaaRoom = irmaaMagiRoomForConversion({
    scenario,
    taxProfile,
    age,
    inflationIndex,
    magiBeforeConversion
  });

  return round(Math.min(federalRoom, acaRoom, irmaaRoom, traditionalAccountValue(portfolio)), 6);
}

function effectiveRothConversionTargetRate({ portfolio, scenario, age }) {
  const configured = scenario.rothConversion?.targetMarginalRate ?? 0.12;
  if (!isLifetimeOptimizerEnabled(scenario) || scenario.rothConversion?.mode === "manual") return configured;
  const rmdStartAge = scenario.rmd?.startAge != null && Number.isFinite(Number(scenario.rmd.startAge))
    ? Number(scenario.rmd.startAge)
    : defaultRmdStartAge(scenario);
  const yearsUntilRmd = Number.isFinite(age) ? Math.max(0, rmdStartAge - age) : Infinity;
  const traditionalValue = traditionalAccountValue(portfolio);
  const annualSpend = Math.max(0, Number(scenario.targetSpend) || 0);
  const rmdPressure = traditionalValue > annualSpend * Math.max(6, Math.min(15, yearsUntilRmd || 10));
  return rmdPressure && configured <= 0.12 ? 0.22 : configured;
}

function irmaaMagiRoomForConversion({ scenario, taxProfile, age, inflationIndex, magiBeforeConversion }) {
  if (!isLifetimeOptimizerEnabled(scenario) || scenario.medicare?.irmaaEnabled === false || !(age >= 63)) return Infinity;
  const config = getMedicareIrmaaConfig({ taxYear: scenario.taxYear, inflationIndex });
  const key = medicareIrmaaBracketKey({
    filingStatus: taxProfile.filingStatus,
    marriedFilingSeparatelyLivedTogether: scenario.medicare?.marriedFilingSeparatelyLivedTogether
  });
  const firstThreshold = config.brackets?.[key]?.[0]?.upTo;
  return Number.isFinite(firstThreshold) ? Math.max(0, firstThreshold - magiBeforeConversion) : Infinity;
}

function acaMagiCeiling({ acaConfig, currentMagi = 0, maxFplPercent = 400 } = {}) {
  if (!acaConfig?.enabled || !(acaConfig.fpl > 0)) {
    return { amount: Infinity, fplPercent: Infinity };
  }

  const fpl = acaConfig.fpl;
  const currentFplPercent = Math.max(0, currentMagi / fpl * 100);
  const cappedMax = Math.max(0, Math.min(maxFplPercent, acaConfig.maxEligibleFplPercent ?? maxFplPercent));
  const thresholds = [
    ...(acaConfig.applicablePercentageTable ?? []).map((row) => row.maxFplPercent),
    cappedMax
  ]
    .filter((value) => Number.isFinite(value) && value > 0 && value <= cappedMax)
    .sort((a, b) => a - b);
  const targetPercent = thresholds.find((threshold) => currentFplPercent <= threshold + 0.0001) ?? cappedMax;

  return {
    amount: round(fpl * targetPercent / 100, 6),
    fplPercent: round(targetPercent, 6)
  };
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

function estimateHeirValue(portfolio, ordinaryTaxRate = 0.24) {
  return round(portfolio.reduce((total, asset) => {
    const value = marketValue(asset);
    if (asset.accountType === "traditional" || asset.accountType === "hsa") {
      return total + value * (1 - ordinaryTaxRate);
    }
    return total + value;
  }, 0), 6);
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
  const depleted = years.find((year) => year.unfunded > 1 || year.endingPortfolioValue <= 1);
  return {
    depletionYear: depleted?.year ?? null,
    depletionYearIndex: depleted?.yearIndex ?? null,
    depletionAge: depleted?.age ?? null
  };
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
  for (const [assetClass, assumption] of Object.entries(scenario.returnAssumptions ?? {})) {
    if (assetClass === "inflation") continue;
    result[assetClass] = Math.max(-0.95, normalRandom(rng, assumption.mean ?? 0, assumption.stdev ?? 0));
  }
  return result;
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
    ? rothBasisWithdrawalSort
    : context.optimizedLotSelection
      ? (a, b) => optimizedTaxAwareSaleSort(a, b, context)
      : rothDistributionSort;
}

function rothBasisWithdrawalSort(a, b) {
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

function embeddedGainRatio(asset) {
  const value = marketValue(asset);
  if (value <= 0) return 0;
  return (value - (asset.costBasisPerUnit ?? asset.price) * asset.units) / value;
}
