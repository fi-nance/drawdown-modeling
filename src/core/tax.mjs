import { EPSILON, round } from "./utils.mjs";
import { buildTaxProfile } from "../data/taxData.mjs";
import {
  stateRetirementIncomeExclusion,
  stateSocialSecurityExclusion
} from "../data/stateRetirementTax2026.mjs";

export const DEFAULT_TAX_PROFILE = buildTaxProfile();

export function taxFromBrackets(amount, brackets = []) {
  const taxable = Math.max(0, amount);
  let previousLimit = 0;
  let tax = 0;

  for (const bracket of brackets) {
    const upper = bracket.upTo;
    const width = Math.max(0, Math.min(taxable, upper) - previousLimit);
    tax += width * bracket.rate;
    previousLimit = upper;
    if (taxable <= upper + EPSILON) break;
  }

  return round(tax, 6);
}

export function taxPreferentialIncome({ ordinaryTaxableIncome, preferentialIncome, brackets = [] }) {
  const gainStart = Math.max(0, ordinaryTaxableIncome);
  const gainEnd = gainStart + Math.max(0, preferentialIncome);
  let previousLimit = 0;
  let tax = 0;

  for (const bracket of brackets) {
    const upper = bracket.upTo;
    const lowerOverlap = Math.max(gainStart, previousLimit);
    const upperOverlap = Math.min(gainEnd, upper);
    const taxableInBracket = Math.max(0, upperOverlap - lowerOverlap);
    tax += taxableInBracket * bracket.rate;
    previousLimit = upper;
    if (gainEnd <= upper + EPSILON) break;
  }

  return round(tax, 6);
}

export function computeIncomeTax({
  ordinaryIncome = 0,
  retirementOrdinaryIncome = 0,
  shortTermCapitalGains = 0,
  longTermCapitalGains = 0,
  qualifiedDividends = 0,
  ordinaryInvestmentIncome = 0,
  taxableSocialSecurity = 0,
  capitalLosses = 0,
  capitalLossCarryforward = 0,
  profile = DEFAULT_TAX_PROFILE
} = {}) {
  const shortGains = Math.max(0, shortTermCapitalGains);
  let longGains = Math.max(0, longTermCapitalGains);
  const dividendPreferentialIncome = Math.max(0, qualifiedDividends);
  let lossPool = Math.max(0, capitalLosses) + Math.max(0, capitalLossCarryforward);

  const shortGainOffset = Math.min(shortGains, lossPool);
  const netShortGains = shortGains - shortGainOffset;
  lossPool -= shortGainOffset;

  const longGainOffset = Math.min(longGains, lossPool);
  longGains -= longGainOffset;
  lossPool -= longGainOffset;

  const ordinaryBeforeLossOffset = Math.max(0, ordinaryIncome + netShortGains);
  const ordinaryLossOffset = Math.min(
    profile.capitalLossOrdinaryIncomeOffset ?? 3000,
    ordinaryBeforeLossOffset,
    lossPool
  );
  lossPool -= ordinaryLossOffset;

  const ordinaryAfterLossOffset = Math.max(0, ordinaryBeforeLossOffset - ordinaryLossOffset);
  const ordinaryIncomeScale = ordinaryBeforeLossOffset > 0
    ? ordinaryAfterLossOffset / ordinaryBeforeLossOffset
    : 0;
  const federalDeduction = (profile.standardDeduction ?? 0) + (profile.additionalDeduction ?? 0);
  const taxableOrdinaryIncome = Math.max(0, ordinaryAfterLossOffset - federalDeduction);
  const remainingDeduction = Math.max(0, federalDeduction - ordinaryAfterLossOffset);
  const preferentialIncome = longGains + dividendPreferentialIncome;
  const taxablePreferentialIncome = Math.max(0, preferentialIncome - remainingDeduction);
  const taxableLongTermCapitalGains = Math.max(0, longGains - remainingDeduction);
  const taxableQualifiedDividends = Math.max(0, taxablePreferentialIncome - taxableLongTermCapitalGains);

  const federalOrdinaryBracketDetails = taxBracketDetails(taxableOrdinaryIncome, profile.ordinaryBrackets);
  const federalOrdinaryTax = round(federalOrdinaryBracketDetails.reduce((total, bracket) => total + bracket.tax, 0), 6);
  const federalPreferentialBracketDetails = preferentialTaxBracketDetails({
    ordinaryTaxableIncome: taxableOrdinaryIncome,
    preferentialIncome: taxablePreferentialIncome,
    brackets: profile.capitalGainsBrackets
  });
  const federalPreferentialTax = round(federalPreferentialBracketDetails.reduce((total, bracket) => total + bracket.tax, 0), 6);
  const federalIncomeTaxBeforeCredits = round(federalOrdinaryTax + federalPreferentialTax, 6);
  const magi = round(ordinaryAfterLossOffset + preferentialIncome, 6);
  const niitTax = computeNiit({
    magi,
    ordinaryInvestmentIncome,
    qualifiedDividends: dividendPreferentialIncome,
    netShortGains,
    longTermCapitalGains: longGains,
    profile
  });
  const childTaxCredit = computeChildTaxCredit({
    magi,
    profile
  });
  const requestedFederalCredits = round(childTaxCredit + Math.max(0, profile.additionalCredits ?? 0), 6);
  const federalCreditsUsed = round(Math.min(federalIncomeTaxBeforeCredits, requestedFederalCredits), 6);
  const federalIncomeTax = round(federalIncomeTaxBeforeCredits - federalCreditsUsed, 6);

  const stateTax = computeStateTax({
    ordinaryIncome: ordinaryAfterLossOffset,
    retirementOrdinaryIncome: Math.max(0, retirementOrdinaryIncome) * ordinaryIncomeScale,
    taxableSocialSecurity: Math.max(0, taxableSocialSecurity) * ordinaryIncomeScale,
    longTermCapitalGains: longGains,
    qualifiedDividends: dividendPreferentialIncome,
    profile: profile.state
  });

  return {
    ordinaryIncome: round(ordinaryIncome, 6),
    retirementOrdinaryIncome: round(retirementOrdinaryIncome, 6),
    ordinaryInvestmentIncome: round(ordinaryInvestmentIncome, 6),
    taxableSocialSecurity: round(taxableSocialSecurity, 6),
    shortTermCapitalGains: round(shortTermCapitalGains, 6),
    longTermCapitalGains: round(longTermCapitalGains, 6),
    qualifiedDividends: round(qualifiedDividends, 6),
    ordinaryLossOffset: round(ordinaryLossOffset, 6),
    taxableOrdinaryIncome: round(taxableOrdinaryIncome, 6),
    taxablePreferentialIncome: round(taxablePreferentialIncome, 6),
    taxableLongTermCapitalGains: round(taxableLongTermCapitalGains, 6),
    taxableQualifiedDividends: round(taxableQualifiedDividends, 6),
    federalOrdinaryTax,
    federalOrdinaryBracketDetails,
    federalPreferentialTax,
    federalPreferentialBracketDetails,
    federalIncomeTaxBeforeCredits,
    childTaxCredit: round(childTaxCredit, 6),
    additionalCredits: round(Math.max(0, profile.additionalCredits ?? 0), 6),
    federalCreditsUsed,
    federalIncomeTax,
    niitTax,
    stateTax,
    totalTax: round(federalIncomeTax + niitTax + stateTax, 6),
    lossCarryforward: round(lossPool, 6)
  };
}

function taxBracketDetails(amount, brackets = []) {
  const taxable = Math.max(0, amount);
  let previousLimit = 0;
  const details = [];

  for (const bracket of brackets) {
    const upper = bracket.upTo;
    const width = Math.max(0, Math.min(taxable, upper) - previousLimit);
    if (width > EPSILON) {
      details.push({
        rate: bracket.rate ?? 0,
        upTo: Number.isFinite(upper) ? round(upper, 6) : Infinity,
        taxableIncome: round(width, 6),
        tax: round(width * (bracket.rate ?? 0), 6)
      });
    }
    previousLimit = upper;
    if (taxable <= upper + EPSILON) break;
  }

  return details;
}

function preferentialTaxBracketDetails({ ordinaryTaxableIncome, preferentialIncome, brackets = [] }) {
  const gainStart = Math.max(0, ordinaryTaxableIncome);
  const gainEnd = gainStart + Math.max(0, preferentialIncome);
  let previousLimit = 0;
  const details = [];

  for (const bracket of brackets) {
    const upper = bracket.upTo;
    const lowerOverlap = Math.max(gainStart, previousLimit);
    const upperOverlap = Math.min(gainEnd, upper);
    const taxableInBracket = Math.max(0, upperOverlap - lowerOverlap);
    if (taxableInBracket > EPSILON) {
      details.push({
        rate: bracket.rate ?? 0,
        upTo: Number.isFinite(upper) ? round(upper, 6) : Infinity,
        taxableIncome: round(taxableInBracket, 6),
        tax: round(taxableInBracket * (bracket.rate ?? 0), 6)
      });
    }
    previousLimit = upper;
    if (gainEnd <= upper + EPSILON) break;
  }

  return details;
}

function computeNiit({
  magi,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  netShortGains = 0,
  longTermCapitalGains = 0,
  profile
}) {
  const config = profile.niit;
  if (!config) return 0;
  const threshold = config.thresholds?.[profile.filingStatus] ?? Infinity;
  const excessMagi = Math.max(0, magi - threshold);
  const netInvestmentIncome = Math.max(
    0,
    ordinaryInvestmentIncome
      + qualifiedDividends
      + Math.max(0, netShortGains)
      + Math.max(0, longTermCapitalGains)
  );
  return round(Math.min(netInvestmentIncome, excessMagi) * (config.rate ?? 0), 6);
}

function computeChildTaxCredit({ magi, profile }) {
  const config = profile.childTaxCredit;
  const qualifyingChildren = Math.max(0, Math.trunc(Number(profile.qualifyingChildren) || 0));
  if (!config || qualifyingChildren <= 0) return 0;

  const grossCredit = qualifyingChildren * (config.perChild ?? 0);
  const threshold = config.phaseoutThresholds?.[profile.filingStatus] ?? 0;
  const excess = Math.max(0, magi - threshold);
  const phaseout = Math.ceil(excess / 1000) * (config.phaseoutPerThousand ?? 0);
  return round(Math.max(0, grossCredit - phaseout), 6);
}

export function computeTaxableSocialSecurityBenefits({
  benefits = 0,
  otherIncome = 0,
  filingStatus = "single",
  marriedFilingSeparatelyLivedTogether = false,
  profile = DEFAULT_TAX_PROFILE
} = {}) {
  const totalBenefits = Math.max(0, Number(benefits) || 0);
  if (totalBenefits <= 0) return 0;

  if (filingStatus === "marriedFilingSeparately" && marriedFilingSeparatelyLivedTogether) {
    return round(totalBenefits * 0.85, 6);
  }

  const config = profile.socialSecurityTaxation ?? {};
  const baseAmount = config.baseAmounts?.[filingStatus] ?? 25000;
  const adjustedBaseAmount = config.adjustedBaseAmounts?.[filingStatus] ?? 34000;
  const lowRate = config.taxableShareLow ?? 0.5;
  const highRate = config.taxableShareHigh ?? 0.85;
  const combinedIncome = Math.max(0, Number(otherIncome) || 0) + totalBenefits * 0.5;
  if (combinedIncome <= baseAmount) return 0;

  const lowerBandWidth = Math.max(0, adjustedBaseAmount - baseAmount);
  const lowerBandTaxable = Math.min(totalBenefits * lowRate, Math.min(combinedIncome - baseAmount, lowerBandWidth) * lowRate);
  const upperBandTaxable = Math.max(0, combinedIncome - adjustedBaseAmount) * highRate;
  return round(Math.min(totalBenefits * highRate, lowerBandTaxable + upperBandTaxable), 6);
}

function computeStateTax({
  ordinaryIncome,
  retirementOrdinaryIncome = 0,
  taxableSocialSecurity = 0,
  longTermCapitalGains,
  qualifiedDividends,
  profile
}) {
  if (!profile) return 0;

  const deduction = (profile.standardDeduction ?? 0) + (profile.personalExemption ?? 0);
  const capitalGains = Math.max(0, longTermCapitalGains);
  const qualified = Math.max(0, qualifiedDividends);
  const stateIncomeBeforeDeduction = Math.max(0, ordinaryIncome + capitalGains + qualified);
  const socialSecurityExclusion = stateSocialSecurityExclusion({
    rule: profile.retirementRules,
    filingStatus: profile.filingStatus,
    age: profile.primaryAge,
    spouseAge: profile.spouseAge,
    taxableSocialSecurity,
    stateIncome: stateIncomeBeforeDeduction,
    manualTaxableRate: profile.socialSecurityTaxableRate
  });
  const remainingTaxableSocialSecurity = Math.max(0, taxableSocialSecurity - socialSecurityExclusion);
  const retirementExclusion = stateRetirementIncomeExclusion({
    rule: profile.retirementRules,
    filingStatus: profile.filingStatus,
    age: profile.primaryAge,
    spouseAge: profile.spouseAge,
    retirementIncome: retirementOrdinaryIncome,
    remainingTaxableSocialSecurity,
    stateIncome: stateIncomeBeforeDeduction,
    manualExclusion: profile.retirementIncomeExclusion
  });
  const stateOrdinaryIncome = Math.max(0, ordinaryIncome - retirementExclusion - socialSecurityExclusion);

  if (profile.capitalGainsTreatment === "only") {
    return taxFromBrackets(Math.max(0, capitalGains - deduction), profile.brackets);
  }

  if (profile.capitalGainsTreatment === "excluded") {
    return taxFromBrackets(Math.max(0, stateOrdinaryIncome + qualified - deduction), profile.brackets);
  }

  if (profile.treatCapitalGainsAsOrdinary !== false || profile.capitalGainsTreatment === "ordinary") {
    return taxFromBrackets(
      Math.max(0, stateOrdinaryIncome + capitalGains + qualified - deduction),
      profile.brackets
    );
  }

  const stateOrdinaryTax = taxFromBrackets(Math.max(0, stateOrdinaryIncome - deduction), profile.brackets);
  const stateCapitalGainsTax = Math.max(0, capitalGains + qualified) * (profile.capitalGainsRate ?? 0);
  return round(stateOrdinaryTax + stateCapitalGainsTax, 6);
}

export function inflateTaxProfile(profile = DEFAULT_TAX_PROFILE, inflationIndex = 1) {
  const index = Math.max(0, inflationIndex);
  return {
    ...profile,
    standardDeduction: round((profile.standardDeduction ?? 0) * index, 6),
    additionalDeduction: round((profile.additionalDeduction ?? 0) * index, 6),
    additionalCredits: round((profile.additionalCredits ?? 0) * index, 6),
    ordinaryBrackets: scaleBracketLimits(profile.ordinaryBrackets, index),
    capitalGainsBrackets: scaleBracketLimits(profile.capitalGainsBrackets, index),
    additionalStandardDeduction65: profile.additionalStandardDeduction65 ? {
      married: round((profile.additionalStandardDeduction65.married ?? 0) * index, 6),
      unmarried: round((profile.additionalStandardDeduction65.unmarried ?? 0) * index, 6)
    } : null,
    childTaxCredit: profile.childTaxCredit ? {
      ...profile.childTaxCredit,
      perChild: round((profile.childTaxCredit.perChild ?? 0) * index, 6),
      refundablePerChild: round((profile.childTaxCredit.refundablePerChild ?? 0) * index, 6)
    } : null,
    state: profile.state ? {
      ...profile.state,
      standardDeduction: round((profile.state.standardDeduction ?? 0) * index, 6),
      personalExemption: round((profile.state.personalExemption ?? 0) * index, 6),
      retirementIncomeExclusion: round((profile.state.retirementIncomeExclusion ?? 0) * index, 6),
      brackets: scaleBracketLimits(profile.state.brackets, index)
    } : null
  };
}

function scaleBracketLimits(brackets = [], inflationIndex = 1) {
  return brackets.map((bracket) => ({
    ...bracket,
    upTo: Number.isFinite(bracket.upTo) ? round(bracket.upTo * inflationIndex, 6) : Infinity
  }));
}
