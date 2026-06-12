// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: taxStrategy. No behavior changes — pure code movement.

import { computeAca } from "../aca.mjs";
import { computeFederalDeductionChoice, computeIncomeTax } from "../tax.mjs?v=20260612-aca-conversions";
import { getMedicareIrmaaConfig } from "../../data/taxData.mjs";
import { round } from "../utils.mjs";
import { emptyRebalanceResult } from "./allocation.mjs";
import { emptyAssetLocationResult } from "./assetLocation.mjs";
import { emptyEarnedIncome, emptyOneOffCashFlows } from "./cashFlows.mjs";
import { CASH_RAISED_EPSILON } from "./constants.mjs";
import { finiteRoom } from "./guards.mjs";
import { emptyHsaContribution, hsaStrategyConfig } from "./hsa.mjs";
import { acaMagiForIncome, incomeForYear, irmaaMagiForIncome } from "./income.mjs?v=20260612-aca-conversions";
import { medicalCostForYear, medicareIrmaaBracketKey } from "./medical.mjs";
import { embeddedTaxableGains, traditionalAccountValue } from "./portfolioQueries.mjs";
import { defaultRmdStartAge } from "./rmd.mjs";
import { isLifetimeOptimizerEnabled, withdrawalStrategyConfig } from "./scenario.mjs";
import { emptyWithdrawal } from "./withdrawalExecution.mjs";

export function addPenaltyTax(taxes, penaltyTax = 0) {
  const penalty = Math.max(0, penaltyTax);
  return {
    ...taxes,
    incomeTax: round(taxes.totalTax, 6),
    penaltyTax: round(penalty, 6),
    totalTax: round(taxes.totalTax + penalty, 6)
  };
}

export function estimateTaxAttribution({
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
  tipsLadderBuild = null,
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
      socialSecurityWages: income.socialSecurityWages == null
        ? null
        : Math.max(0, (income.socialSecurityWages ?? 0) - (adjustments.socialSecurityWages ?? 0)),
      selfEmploymentIncome: Math.max(0, (income.selfEmploymentIncome ?? 0) - (adjustments.selfEmploymentIncome ?? 0)),
      rrtaCompensation: Math.max(0, (income.rrtaCompensation ?? 0) - (adjustments.rrtaCompensation ?? 0)),
      spouseMedicareWages: Math.max(0, (income.spouseMedicareWages ?? 0) - (adjustments.spouseMedicareWages ?? 0)),
      spouseSocialSecurityWages: income.spouseSocialSecurityWages == null
        ? null
        : Math.max(0, (income.spouseSocialSecurityWages ?? 0) - (adjustments.spouseSocialSecurityWages ?? 0)),
      spouseSelfEmploymentIncome: Math.max(0, (income.spouseSelfEmploymentIncome ?? 0) - (adjustments.spouseSelfEmploymentIncome ?? 0)),
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
  const hsaOrdinaryIncome = sumSaleIncome(withdrawal.sales, "hsa");

  addSource("Earned income", {
    ordinaryIncome: earnedIncome.ordinaryIncome,
    medicareWages: earnedIncome.medicareWages,
    socialSecurityWages: earnedIncome.socialSecurityWages,
    selfEmploymentIncome: earnedIncome.selfEmploymentIncome,
    rrtaCompensation: earnedIncome.rrtaCompensation,
    spouseMedicareWages: earnedIncome.spouseMedicareWages ?? 0,
    spouseSocialSecurityWages: earnedIncome.spouseSocialSecurityWages,
    spouseSelfEmploymentIncome: earnedIncome.spouseSelfEmploymentIncome ?? 0
  });
  addSource("One-off income", {
    ordinaryIncome: oneOffCashFlows.taxableOrdinaryIncome + oneOffCashFlows.earnedIncome.ordinaryIncome,
    medicareWages: oneOffCashFlows.earnedIncome.medicareWages,
    socialSecurityWages: oneOffCashFlows.earnedIncome.socialSecurityWages,
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
  // Mirrors combineIncome: HSA ordinary income is federal-only, never part of
  // the state retirement-income bucket.
  addSource("HSA nonqualified withdrawals", {
    ordinaryIncome: hsaOrdinaryIncome
  });
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
  addSource("TIPS ladder funding", {
    shortTermCapitalGains: tipsLadderBuild?.shortTermCapitalGains ?? 0,
    longTermCapitalGains: tipsLadderBuild?.longTermCapitalGains ?? 0,
    capitalLosses: tipsLadderBuild?.capitalLosses ?? 0
  });
  addSource("Tax gain harvesting", {
    longTermCapitalGains: Math.max(
      0,
      strategyLongTermGains
        - (allocationStrategy.longTermCapitalGains ?? 0)
        - (assetLocation.longTermCapitalGains ?? 0)
        - (tipsLadderBuild?.longTermCapitalGains ?? 0)
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

export function gainHarvestingRoom({
  taxes,
  taxProfile,
  configuredMaxGain = Infinity,
  acaConfig,
  currentMagi = 0,
  portfolio = [],
  scenario = {},
  age = null,
  inflationIndex = 1,
  medicalInflationIndex = null,
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
      medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
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

export function estimatedFutureCapitalGainRate({ taxProfile, scenario, portfolio }) {
  const maxFederalPreferentialRate = Math.max(0, ...(taxProfile.capitalGainsBrackets ?? []).map((bracket) => bracket.rate ?? 0));
  const niitRate = taxProfile.niit?.rate ?? 0;
  const state = taxProfile.state ?? {};
  const stateRate = state.treatCapitalGainsAsOrdinary === false
    ? state.capitalGainsRate ?? 0
    : topBracketRate(state.brackets);
  const rmdPressure = traditionalAccountValue(portfolio) > Math.max(0, Number(scenario.targetSpend) || 0) * 8;
  return Math.max(0, maxFederalPreferentialRate + (rmdPressure ? niitRate : niitRate / 2) + stateRate);
}

export function estimatedFutureOrdinaryIncomeRate({ portfolio, scenario, age, taxProfile, ordinaryIncome = 0 }) {
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
  medicalInflationIndex = null,
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
    const acaMagi = acaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, taxProfile);
    const irmaaMagi = irmaaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, taxProfile);
    const aca = computeAca({ magi: acaMagi, config: acaConfig });
    const medical = medicalCostForYear({
      scenario,
      aca,
      yearAcaConfig: acaConfig,
      inflationIndex,
      medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
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
        addPoint(bracket.upTo + federalDeductionCandidateRoom(taxProfile, 0, base.taxes) - base.taxes.taxableOrdinaryIncome);
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

export function rothConversionMagiBuffer(scenario = {}) {
  const buffer = Number(scenario.rothConversion?.magiBuffer ?? scenario.aca?.magiBuffer ?? 0);
  return Number.isFinite(buffer) && buffer > 0 ? buffer : 0;
}

function taxGainHarvestingMagiBuffer(scenario = {}) {
  const buffer = Number(scenario.taxGainHarvesting?.magiBuffer ?? scenario.aca?.magiBuffer ?? 0);
  return Number.isFinite(buffer) && buffer > 0 ? buffer : 0;
}

export function strategyLimit({ strategy, autoValue, legacyField, overrideField }) {
  const legacy = Number(strategy?.[legacyField]);
  const override = Number(strategy?.[overrideField]);
  if (strategy?.mode === "manual" && Number.isFinite(override)) return Math.max(0, override);
  if (Number.isFinite(legacy) && legacy > 0) return Math.max(0, legacy);
  return Math.max(0, autoValue);
}

export function automaticTaxLossHarvestLimit(portfolio, taxProfile, lossCarryforward = 0) {
  const ordinaryOffset = Math.max(0, (taxProfile.capitalLossOrdinaryIncomeOffset ?? 3000) - lossCarryforward);
  return round(embeddedTaxableGains(portfolio) + ordinaryOffset, 6);
}

export function rothConversionAmountForYear({
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
  medicalInflationIndex = null,
  yearIndex = 0,
  magiHistory = [],
  lossCarryforward = { shortTerm: 0, longTerm: 0 },
  // Withdrawal income that is already certain (or reliably estimated) for
  // this year — RMD forced sales, TIPS ladder rung maturities, and the
  // provisional spending withdrawal — so the conversion stacks on TOP of it
  // instead of double-claiming the same bracket/ACA/IRMAA headroom.
  baseWithdrawal = emptyWithdrawal(),
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0
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
        lossCarryforward,
        baseWithdrawal,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses
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
      strategyShortTermGains,
      strategyLongTermGains,
      strategyCapitalLosses,
      strategyShortTermLosses,
      strategyLongTermLosses,
      withdrawal: baseWithdrawal,
      socialSecurityBenefits,
      taxProfile,
      scenario,
      lossCarryforward
    });
    const magiBeforeConversion = acaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, taxProfile);
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
      magiBeforeConversion: irmaaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, taxProfile),
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
      medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
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
      strategyShortTermGains,
      strategyLongTermGains,
      strategyCapitalLosses,
      strategyShortTermLosses,
      strategyLongTermLosses,
      withdrawal: baseWithdrawal,
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
  const withdrawalOrdinaryIncome = Math.max(0, baseWithdrawal?.ordinaryIncome ?? 0);
  const federalRoom = Math.max(0, targetCeiling + federalDeductionCandidateRoom(taxProfile, ordinaryIncome + withdrawalOrdinaryIncome) - ordinaryIncome - withdrawalOrdinaryIncome);
  const { income: incomeBeforeConversion } = incomeForYear({
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome: 0,
    ordinaryInvestmentIncome,
    qualifiedDividends,
    adjustmentsToIncome,
    strategyShortTermGains,
    strategyLongTermGains,
    strategyCapitalLosses,
    strategyShortTermLosses,
    strategyLongTermLosses,
    withdrawal: baseWithdrawal,
    socialSecurityBenefits,
    taxProfile,
    scenario,
    lossCarryforward
  });
  const magiBeforeConversion = acaMagiForIncome(incomeBeforeConversion, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, taxProfile);
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
    magiBeforeConversion: irmaaMagiForIncome(incomeBeforeConversion, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, taxProfile),
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
  lossCarryforward = { shortTerm: 0, longTerm: 0 },
  baseWithdrawal = emptyWithdrawal(),
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0
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
    strategyShortTermGains,
    strategyLongTermGains,
    strategyCapitalLosses,
    strategyShortTermLosses,
    strategyLongTermLosses,
    withdrawal: baseWithdrawal,
    socialSecurityBenefits,
    taxProfile,
    scenario,
    lossCarryforward
  });
  const magiBeforeConversion = acaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, taxProfile);
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
    magiBeforeConversion: irmaaMagiForIncome(income, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, taxProfile),
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

export function effectiveRothConversionTargetRate({ portfolio, scenario, age, taxProfile, ordinaryIncome = 0 }) {
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

export function acaMagiCeiling({ acaConfig, currentMagi = 0, maxFplPercent = 400, targetRate = null, magiBuffer = 0 } = {}) {
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

function federalDeductionCandidateRoom(taxProfile = {}, agi = 0, taxes = null) {
  if (Number.isFinite(Number(taxes?.federalDeduction))) {
    return Math.max(0, Number(taxes.federalDeduction));
  }
  return computeFederalDeductionChoice({ agi, profile: taxProfile }).federalDeduction
    + Math.max(0, Number(taxProfile.enhancedSeniorDeductionMax) || 0);
}
