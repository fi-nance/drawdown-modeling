// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: income. No behavior changes — pure code movement.

import { DEFAULT_TAX_PROFILE, computeSelfEmploymentTax, computeTaxableSocialSecurityBenefits, netCapitalGainsAndLosses } from "../tax.mjs?v=20260613-portfolio-prices";
import { round } from "../utils.mjs";
import { emptyEarnedIncome } from "./cashFlows.mjs";

export function normalizeLossCarryforward(value) {
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

export function lossCarryforwardTotal(value) {
  if (typeof value === "object" && value !== null) {
    return Math.max(0, (value.shortTerm ?? 0) + (value.longTerm ?? 0));
  }
  return Math.max(0, Number(value) || 0);
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
  // 65+ nonqualified HSA distributions are federal ordinary income but NOT
  // pension/IRA income, so they stay out of the state retirement-income
  // bucket that stateRetirementIncomeExclusion can exempt.
  const hsaOrdinaryIncome = (withdrawal.sales ?? []).reduce(
    (sum, sale) => sale.accountType === "hsa" ? sum + Math.max(0, sale.ordinaryIncome ?? 0) : sum,
    0
  );
  return {
    ordinaryIncome: ordinaryIncome + withdrawal.ordinaryIncome + taxableSocialSecurityAmount,
    retirementOrdinaryIncome: Math.max(0, retirementOrdinaryIncome) + Math.max(0, withdrawal.ordinaryIncome - hsaOrdinaryIncome),
    ordinaryInvestmentIncome,
    adjustmentsToIncome: Math.max(0, adjustmentsToIncome),
    medicareWages: earnedIncome.medicareWages,
    socialSecurityWages: earnedIncome.socialSecurityWages,
    selfEmploymentIncome: earnedIncome.selfEmploymentIncome,
    rrtaCompensation: earnedIncome.rrtaCompensation,
    spouseMedicareWages: earnedIncome.spouseMedicareWages ?? 0,
    spouseSocialSecurityWages: earnedIncome.spouseSocialSecurityWages ?? null,
    spouseSelfEmploymentIncome: earnedIncome.spouseSelfEmploymentIncome ?? 0,
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

export function incomeForYear({
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
    otherIncome: federalAgiForIncome(incomeBeforeSocialSecurity, lossCarryforward, taxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, taxProfile),
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

export function federalAgiForIncome(
  income,
  lossCarryforward = { shortTerm: 0, longTerm: 0 },
  ordinaryOffsetCap = 3000,
  taxProfile = DEFAULT_TAX_PROFILE
) {
  const selfEmployment = computeSelfEmploymentTax({
    selfEmploymentIncome: income.selfEmploymentIncome,
    medicareWages: income.medicareWages,
    socialSecurityWages: income.socialSecurityWages,
    profile: taxProfile
  });
  // The spouse's half-SE-tax deduction also reduces AGI (computed against the
  // spouse's OWN Social Security wage base). Zero spouse inputs → zero.
  const spouseSelfEmployment = computeSelfEmploymentTax({
    selfEmploymentIncome: income.spouseSelfEmploymentIncome ?? 0,
    medicareWages: income.spouseMedicareWages ?? 0,
    socialSecurityWages: income.spouseSocialSecurityWages ?? null,
    profile: taxProfile
  });
  const adjustments = Math.max(0, income.adjustmentsToIncome ?? 0) + selfEmployment.deduction + spouseSelfEmployment.deduction;
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

export function acaMagiForIncome(
  income,
  lossCarryforward = { shortTerm: 0, longTerm: 0 },
  ordinaryOffsetCap = 3000,
  taxProfile = DEFAULT_TAX_PROFILE
) {
  return Math.max(0,
    federalAgiForIncome(income, lossCarryforward, ordinaryOffsetCap, taxProfile)
      + Math.max(0, income.nonTaxableSocialSecurity ?? 0)
  );
}

export function irmaaMagiForIncome(
  income,
  lossCarryforward = { shortTerm: 0, longTerm: 0 },
  ordinaryOffsetCap = 3000,
  taxProfile = DEFAULT_TAX_PROFILE
) {
  return federalAgiForIncome(income, lossCarryforward, ordinaryOffsetCap, taxProfile);
}

export function taxProfileForSimulationYear({
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
  const enhancedSeniorDeductionEligibility = enhancedSeniorDeductionEligibilityForYear({
    profile: inflatedProfile,
    scenario,
    yearIndex,
    filingStatus: inflatedProfile.filingStatus,
    primaryAge,
    spouseAge
  });

  return {
    age65AdditionalDeduction,
    enhancedSeniorDeductionEligibleCount: enhancedSeniorDeductionEligibility.eligibleCount,
    enhancedSeniorDeductionTaxYear: enhancedSeniorDeductionEligibility.taxYear,
    itemizedDeductionTaxYear: enhancedSeniorDeductionEligibility.taxYear,
    profile: {
      ...inflatedProfile,
      qualifyingChildren,
      additionalDeduction: round((inflatedProfile.additionalDeduction ?? 0) + age65AdditionalDeduction, 6),
      age65AdditionalDeduction,
      enhancedSeniorDeductionEligibleCount: enhancedSeniorDeductionEligibility.eligibleCount,
      enhancedSeniorDeductionTaxYear: enhancedSeniorDeductionEligibility.taxYear,
      enhancedSeniorDeductionMax: round(enhancedSeniorDeductionEligibility.eligibleCount * enhancedSeniorDeductionEligibility.amountPerPerson, 6),
      itemizedDeductionTaxYear: enhancedSeniorDeductionEligibility.taxYear,
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

function enhancedSeniorDeductionEligibilityForYear({
  profile,
  scenario,
  yearIndex,
  filingStatus,
  primaryAge,
  spouseAge
}) {
  const config = profile.enhancedSeniorDeduction;
  const taxYear = simulationTaxYear(scenario, profile, yearIndex);
  const amountPerPerson = Math.max(0, Number(config?.amountPerEligiblePerson) || 0);
  if (!config || filingStatus === "marriedFilingSeparately") {
    return { eligibleCount: 0, taxYear, amountPerPerson };
  }

  const start = Number(config.effectiveStartYear);
  const end = Number(config.effectiveEndYear);
  if (Number.isFinite(start) && taxYear < start) return { eligibleCount: 0, taxYear, amountPerPerson };
  if (Number.isFinite(end) && taxYear > end) return { eligibleCount: 0, taxYear, amountPerPerson };

  let eligibleCount = primaryAge >= 65 ? 1 : 0;
  if (filingStatus === "marriedFilingJointly" && Number.isFinite(spouseAge) && spouseAge >= 65) {
    eligibleCount += 1;
  }

  return { eligibleCount, taxYear, amountPerPerson };
}

function simulationTaxYear(scenario = {}, profile = {}, yearIndex = 0) {
  const startYear = Number(scenario?.startYear);
  if (Number.isFinite(startYear)) return startYear + yearIndex;
  const profileYear = Number(profile?.year);
  return Number.isFinite(profileYear) ? profileYear + yearIndex : yearIndex + 1;
}
