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
  oneOffExpenses: [],
  currentAge: 55,
  spouseAge: 55,
  retirementPenaltyAge: 59.5,
  earlyWithdrawalPenaltyRate: 0.1,
  rothBasis: 60000,
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

    scenarios.push({
      id: run + 1,
      success: plan.success,
      endingValue: plan.endingValue,
      heirValue: plan.heirValue,
      depletionYear: firstDepletionYear(plan.years),
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
    return {
      id: sequence.name ?? `Sequence ${index + 1}`,
      sourceYears: sequence.sourceYears ?? [],
      sourceStartYear: sequence.startYear ?? null,
      sourceEndYear: sequence.endYear ?? null,
      depletionYear: firstDepletionYear(plan.years),
      ...plan
    };
  });
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
  let ordinaryIncome = dividends.ordinaryDividends;
  let qualifiedDividends = dividends.qualifiedDividends;
  let strategyCapitalLosses = 0;
  let strategyLongTermGains = 0;

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
      rothBasisRemaining
    })
    : emptyWithdrawal(rothBasisRemaining);
  rothBasisRemaining = rmdWithdrawal.rothBasisRemaining;

  const socialSecurityBenefits = socialSecurityBenefitsForYear(scenario, age, inflationIndex);

  const rothConversionAmount = scenario.rothConversion?.enabled
    ? convertTraditionalToRoth(portfolio, rothConversionAmountForYear({
      portfolio,
      scenario,
      taxProfile: yearTaxProfile,
      acaConfig: yearAcaConfig,
      ordinaryIncome,
      qualifiedDividends
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

  const plannedSpending = plannedSpendingForYear(scenario, yearIndex + 1, inflationIndex);
  let finalWithdrawal = null;
  let finalTaxes = null;
  let finalAca = null;
  let finalMedicare = emptyMedicareCost();
  let finalTaxableSocialSecurity = 0;
  let finalPortfolio = null;
  let medicalEstimate = 0;
  let taxEstimate = 0;

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const workingPortfolio = clonePortfolio(portfolio);
    const cashRequired = plannedSpending
      + (scenario.targetSpendIncludesMedical ? 0 : medicalEstimate)
      + (scenario.targetSpendIncludesTaxes ? 0 : taxEstimate);
    const voluntaryWithdrawal = withdrawForCash(
      workingPortfolio,
      Math.max(0, cashRequired - dividends.cash - rmdWithdrawal.cashRaised - socialSecurityBenefits),
      scenario.withdrawalOrder,
      {
        age,
        calendarYear,
        penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
        penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
        rothBasisRemaining: rmdWithdrawal.rothBasisRemaining
      }
    );
    const withdrawal = mergeWithdrawals(rmdWithdrawal, voluntaryWithdrawal);

    const { income, taxableSocialSecurity } = incomeForYear({
      ordinaryIncome,
      retirementOrdinaryIncome: rothConversionAmount,
      ordinaryInvestmentIncome: dividends.ordinaryDividends,
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
    medicalEstimate = scenario.targetSpendIncludesMedical ? 0 : medical.total;
    taxEstimate = taxesWithPenalties.totalTax;

    finalWithdrawal = withdrawal;
    finalTaxes = taxesWithPenalties;
    finalAca = aca;
    finalMedicare = medical.medicare;
    finalTaxableSocialSecurity = taxableSocialSecurity;
    finalPortfolio = workingPortfolio;
  }

  if (scenario.taxGainHarvesting?.enabled) {
    const gainHarvestLimit = gainHarvestingRoom({
      taxes: finalTaxes,
      taxProfile: yearTaxProfile,
      acaConfig: yearAcaConfig,
      currentMagi: estimateMagi(incomeForYear({
        ordinaryIncome,
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
      })
    });
    const gainHarvest = harvestTaxGains(finalPortfolio, gainHarvestLimit);
    strategyLongTermGains += gainHarvest.realizedGains;
    flows.push(...gainHarvest.flows);

    if (gainHarvest.realizedGains > 0) {
      const { income, taxableSocialSecurity } = incomeForYear({
        ordinaryIncome,
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
    ordinaryIncome,
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
  medicalEstimate = reconciled.medicalEstimate;

  const totalCashRequired = plannedSpending
    + (scenario.targetSpendIncludesMedical ? 0 : medicalEstimate)
    + (scenario.targetSpendIncludesTaxes ? 0 : finalTaxes.totalTax);
  const { income: finalIncome, taxableSocialSecurity: reconciledTaxableSocialSecurity } = incomeForYear({
    ordinaryIncome,
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
  if (finalTaxes.totalTax > 0) {
    const incomeTax = Math.max(0, finalTaxes.totalTax - (finalTaxes.penaltyTax ?? 0));
    if (incomeTax > 0) flows.push({ from: "Spending reserve", to: "Tax payments", amount: incomeTax, type: "tax" });
    if ((finalTaxes.penaltyTax ?? 0) > 0) {
      flows.push({
        from: "Spending reserve",
        to: "Early withdrawal penalties",
        amount: finalTaxes.penaltyTax,
        type: "penalty"
      });
    }
  }
  for (const item of taxAttribution) {
    if (item.amount > 0) {
      flows.push({
        from: item.source,
        to: taxAttributionTarget(item.source),
        amount: item.amount,
        type: "tax-source"
      });
    }
  }
  if (medicalEstimate > 0) {
    flows.push({ from: "Spending reserve", to: "Medical", amount: medicalEstimate, type: "medical" });
  }
  if (plannedSpending > 0) {
    flows.push({ from: "Spending reserve", to: "Lifestyle and one-off spending", amount: plannedSpending, type: "spending" });
  }

  const cashAvailable = dividends.cash + socialSecurityBenefits + finalWithdrawal.cashRaised;
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
    rothBasisUsed: round(finalWithdrawal.rothBasisUsed, 6),
    rothBasisRemaining: round(finalWithdrawal.rothBasisRemaining, 6),
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
  ordinaryIncome,
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

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const totalCashRequired = plannedSpending
      + (scenario.targetSpendIncludesMedical ? 0 : currentMedicalEstimate)
      + (scenario.targetSpendIncludesTaxes ? 0 : currentTaxes.totalTax);
    const cashAvailable = dividends.cash + socialSecurityBenefits + currentWithdrawal.cashRaised;
    const gap = totalCashRequired - cashAvailable;
    if (gap <= 1) break;

    const topUp = withdrawForCash(portfolio, gap, scenario.withdrawalOrder, {
      age,
      calendarYear,
      penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
      penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
      rothBasisRemaining: currentWithdrawal.rothBasisRemaining
    });
    if (topUp.cashRaised <= 0.000001) break;

    currentWithdrawal = mergeWithdrawals(currentWithdrawal, topUp);
    const { income, taxableSocialSecurity: recomputedTaxableSocialSecurity } = incomeForYear({
      ordinaryIncome,
      retirementOrdinaryIncome,
      ordinaryInvestmentIncome: dividends.ordinaryDividends,
      qualifiedDividends,
      strategyLongTermGains,
      strategyCapitalLosses,
      withdrawal: currentWithdrawal,
      socialSecurityBenefits,
      taxProfile: yearTaxProfile,
      scenario
    });
    currentTaxableSocialSecurity = recomputedTaxableSocialSecurity;
    currentTaxes = computeIncomeTax({
      ...income,
      capitalLossCarryforward: lossCarryforward,
      profile: yearTaxProfile
    });
    currentTaxes = addPenaltyTax(currentTaxes, currentWithdrawal.penaltyTax);
    const magi = estimateMagi(income);
    currentAca = computeAcaForYear({ age, magi, config: yearAcaConfig });
    if (!scenario.targetSpendIncludesMedical) {
      const medical = medicalCostForYear({
        scenario,
        aca: currentAca,
        yearAcaConfig,
        inflationIndex,
        age,
        spouseAge,
        yearIndex,
        filingStatus: yearTaxProfile.filingStatus,
        magi,
        magiHistory
      });
      currentMedicalEstimate = medical.total;
      currentMedicare = medical.medicare;
    }
  }

  return {
    withdrawal: currentWithdrawal,
    taxes: currentTaxes,
    aca: currentAca,
    medicare: currentMedicare,
    taxableSocialSecurity: currentTaxableSocialSecurity,
    medicalEstimate: currentMedicalEstimate
  };
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
    rothBasisUsed: round(base.rothBasisUsed + addition.rothBasisUsed, 6),
    rothBasisRemaining: addition.rothBasisRemaining,
    sales: [...base.sales, ...addition.sales],
    flows: [...base.flows, ...addition.flows]
  };
}

function emptyWithdrawal(rothBasisRemaining = 0) {
  return {
    cashRaised: 0,
    ordinaryIncome: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    penaltyTax: 0,
    penaltyBase: 0,
    rothBasisUsed: 0,
    rothBasisRemaining: round(Math.max(0, rothBasisRemaining), 6),
    sales: [],
    flows: []
  };
}

function withdrawForCash(portfolio, amount, withdrawalOrder = [], context = {}) {
  let remaining = Math.max(0, amount);
  let rothBasisRemaining = Math.max(0, context.rothBasisRemaining ?? 0);
  const age = context.age ?? 99;
  const calendarYear = context.calendarYear ?? 0;
  const penaltyAge = context.penaltyAge ?? 59.5;
  const penaltyRate = context.penaltyRate ?? 0.1;
  const isEarly = age < penaltyAge;
  const result = {
    cashRaised: 0,
    ordinaryIncome: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    penaltyTax: 0,
    penaltyBase: 0,
    rothBasisUsed: 0,
    rothBasisRemaining,
    sales: [],
    flows: []
  };

  for (const accountType of withdrawalOrder) {
    const candidates = portfolio
      .filter((asset) => asset.accountType === accountType && marketValue(asset) > 0)
      .sort(accountType === "roth" ? rothDistributionSort : taxAwareSaleSort);

    for (const asset of candidates) {
      if (remaining <= 0) break;
      const sale = sellFromLot(asset, remaining);
      if (sale.proceeds <= 0) continue;

      remaining -= sale.proceeds;
      result.cashRaised += sale.proceeds;
      applyRetirementDistributionTax(sale, {
        result,
        isEarly,
        penaltyRate,
        calendarYear,
        getRothBasis: () => rothBasisRemaining,
        useRothBasis: (amountUsed) => {
          const used = Math.min(rothBasisRemaining, Math.max(0, amountUsed));
          rothBasisRemaining = round(rothBasisRemaining - used, 6);
          result.rothBasisUsed += used;
          result.rothBasisRemaining = rothBasisRemaining;
          return used;
        }
      });
      result.sales.push(sale);
      result.flows.push({
        from: accountLabel(sale.accountType),
        to: "Spending reserve",
        amount: sale.proceeds,
        type: "withdrawal"
      });

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
  result.rothBasisUsed = round(result.rothBasisUsed, 6);
  result.rothBasisRemaining = round(rothBasisRemaining, 6);
  return result;
}

function applyRetirementDistributionTax(sale, context) {
  if (sale.accountType === "traditional") {
    sale.ordinaryIncome = sale.proceeds;
    sale.penaltyBase = context.isEarly ? sale.proceeds : 0;
    sale.penaltyTax = sale.penaltyBase * context.penaltyRate;
    context.result.ordinaryIncome += sale.proceeds;
    context.result.penaltyBase += sale.penaltyBase;
    context.result.penaltyTax += sale.penaltyTax;
    return;
  }

  if (sale.accountType !== "roth" || !context.isEarly) {
    sale.ordinaryIncome = 0;
    sale.penaltyBase = 0;
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
  sale.rothBasisUsed = basisUsed;
  sale.ordinaryIncome = taxableEarnings;
  sale.penaltyBase = conversionPenaltyBase + taxableEarnings;
  sale.penaltyTax = sale.penaltyBase * context.penaltyRate;
  sale.taxType = taxableEarnings > 0
    ? "roth-earnings"
    : conversionPenaltyBase > 0
      ? "roth-conversion-penalty"
      : "roth-basis";

  context.result.ordinaryIncome += taxableEarnings;
  context.result.penaltyBase += sale.penaltyBase;
  context.result.penaltyTax += sale.penaltyTax;
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
  const tableKey = filingStatus === "marriedFilingJointly"
    ? "marriedFilingJointly"
    : filingStatus === "marriedFilingSeparately" && marriedFilingSeparatelyLivedTogether
      ? "marriedFilingSeparatelyTogether"
      : "individual";
  return (config.brackets?.[tableKey] ?? config.brackets?.individual ?? []).find((row) => magi <= row.upTo) ?? {
    partBMonthlyAdjustment: 0,
    partDMonthlyAdjustment: 0
  };
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

function plannedSpendingForYear(scenario, planYear, inflationIndex) {
  const baseSpend = (scenario.targetSpend ?? 0)
    * (scenario.targetSpendInflationAdjusted === false ? 1 : inflationIndex);
  const oneOffs = (scenario.oneOffExpenses ?? []).reduce((total, expense) => {
    const start = expense.startYear ?? expense.year ?? 1;
    const end = expense.endYear ?? start;
    if (planYear < start || planYear > end) return total;
    return total + (expense.amount ?? 0) * (expense.inflationAdjusted ? inflationIndex : 1);
  }, 0);
  return round(baseSpend + oneOffs, 6);
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

function taxAttributionTarget(source) {
  return `${source} tax`;
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
  currentMagi = 0
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
  return round(Math.max(0, Math.min(configuredMaxGain ?? Infinity, federalRoom, acaRoom)), 6);
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
  qualifiedDividends
}) {
  const requested = scenario.rothConversion?.overrideAmount != null
    && Number.isFinite(Number(scenario.rothConversion.overrideAmount))
    ? Number(scenario.rothConversion.overrideAmount)
    : scenario.rothConversion?.annualAmount != null
      && Number.isFinite(Number(scenario.rothConversion.annualAmount))
      ? Number(scenario.rothConversion.annualAmount)
      : null;
  if (requested !== null && requested >= 0) return requested;

  const targetRate = scenario.rothConversion?.targetMarginalRate ?? 0.12;
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

  return round(Math.min(federalRoom, acaRoom, traditionalAccountValue(portfolio)), 6);
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

function firstDepletionYear(years) {
  const depleted = years.find((year) => year.unfunded > 1 || year.endingPortfolioValue <= 1);
  return depleted?.year ?? null;
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
    rothConversion: {
      ...DEFAULT_SCENARIO.rothConversion,
      ...(scenario.rothConversion ?? {})
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

function rothDistributionSort(a, b) {
  if (a.rothSource === "conversion" && b.rothSource !== "conversion") return -1;
  if (a.rothSource !== "conversion" && b.rothSource === "conversion") return 1;
  if (a.rothSource === "conversion" && b.rothSource === "conversion") {
    return (a.conversionYear ?? Infinity) - (b.conversionYear ?? Infinity);
  }
  return taxAwareSaleSort(a, b);
}

function embeddedGainRatio(asset) {
  const value = marketValue(asset);
  if (value <= 0) return 0;
  return (value - (asset.costBasisPerUnit ?? asset.price) * asset.units) / value;
}
