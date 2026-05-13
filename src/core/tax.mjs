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
  adjustmentsToIncome = 0,
  medicareWages = 0,
  selfEmploymentIncome = 0,
  rrtaCompensation = 0,
  capitalLosses = 0,
  shortTermCapitalLosses,
  longTermCapitalLosses,
  capitalLossCarryforward = 0,
  profile = DEFAULT_TAX_PROFILE
} = {}) {
  // Schedule D / IRC §1212(b) netting: short-term and long-term losses retain
  // their character when carried forward. Within-character losses offset
  // within-character gains first; any remaining loss may then offset gains of
  // the other character; any remaining loss offsets up to $3,000 of ordinary
  // income (ST first, then LT per the Capital Loss Carryover Worksheet);
  // the rest carries forward by character.
  const carryforwardShort = typeof capitalLossCarryforward === "object" && capitalLossCarryforward !== null
    ? Math.max(0, capitalLossCarryforward.shortTerm ?? 0)
    : 0;
  // Legacy callers pass `capitalLossCarryforward` as a single number with no
  // character info; treat that number as long-term to match the long-standing
  // (and dominant in retirement) case.
  const carryforwardLong = typeof capitalLossCarryforward === "object" && capitalLossCarryforward !== null
    ? Math.max(0, capitalLossCarryforward.longTerm ?? 0)
    : Math.max(0, capitalLossCarryforward);
  const hasCharacterizedLosses = Number.isFinite(shortTermCapitalLosses) || Number.isFinite(longTermCapitalLosses);
  const currentShortLosses = hasCharacterizedLosses
    ? Math.max(0, shortTermCapitalLosses ?? 0)
    : 0;
  const currentLongLosses = hasCharacterizedLosses
    ? Math.max(0, longTermCapitalLosses ?? 0)
    : Math.max(0, capitalLosses);

  const shortGains = Math.max(0, shortTermCapitalGains);
  let longGains = Math.max(0, longTermCapitalGains);
  const dividendPreferentialIncome = Math.max(0, qualifiedDividends);
  let shortLossPool = currentShortLosses + carryforwardShort;
  let longLossPool = currentLongLosses + carryforwardLong;

  // Step 1: same-character netting.
  const shortGainOffset = Math.min(shortGains, shortLossPool);
  let netShortGains = shortGains - shortGainOffset;
  shortLossPool -= shortGainOffset;

  const longGainOffset = Math.min(longGains, longLossPool);
  longGains -= longGainOffset;
  longLossPool -= longGainOffset;

  // Step 2: cross-character netting (ST loss vs LT gain, LT loss vs ST gain).
  const stLossVsLtGain = Math.min(shortLossPool, longGains);
  shortLossPool -= stLossVsLtGain;
  longGains -= stLossVsLtGain;

  const ltLossVsStGain = Math.min(longLossPool, netShortGains);
  longLossPool -= ltLossVsStGain;
  netShortGains -= ltLossVsStGain;

  // Step 3: offset against ordinary income (ST loss first, then LT, capped at
  // §1211(b) threshold — $3,000 for MFJ/Single, $1,500 for MFS).
  const adjustments = Math.max(0, adjustmentsToIncome);
  const ordinaryBeforeLossOffset = Math.max(0, ordinaryIncome + netShortGains - adjustments);
  const ordinaryOffsetCap = Math.min(
    profile.capitalLossOrdinaryIncomeOffset ?? 3000,
    ordinaryBeforeLossOffset
  );
  const shortOrdOffset = Math.min(shortLossPool, ordinaryOffsetCap);
  shortLossPool -= shortOrdOffset;
  const longOrdOffset = Math.min(longLossPool, ordinaryOffsetCap - shortOrdOffset);
  longLossPool -= longOrdOffset;
  const ordinaryLossOffset = shortOrdOffset + longOrdOffset;
  const lossPool = shortLossPool + longLossPool;

  const ordinaryAfterLossOffset = Math.max(0, ordinaryBeforeLossOffset - ordinaryLossOffset);
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
  const additionalMedicare = computeAdditionalMedicareTax({
    medicareWages,
    selfEmploymentIncome,
    rrtaCompensation,
    profile
  });
  const childTaxCredit = computeChildTaxCredit({
    magi,
    profile
  });
  const requestedFederalCredits = round(childTaxCredit + Math.max(0, profile.additionalCredits ?? 0), 6);
  const federalCreditsUsed = round(Math.min(federalIncomeTaxBeforeCredits, requestedFederalCredits), 6);
  const federalIncomeTax = round(federalIncomeTaxBeforeCredits - federalCreditsUsed, 6);

  // Pass the full retirement-income amounts to the state tax computation;
  // state retirement-income exclusions and taxable-SS adjustments operate on
  // the raw retirement components, not on a federal-loss-offset prorated
  // amount. The state computation will apply its own deductions/exclusions.
  const stateTax = computeStateTax({
    ordinaryIncome: ordinaryAfterLossOffset,
    retirementOrdinaryIncome: Math.max(0, retirementOrdinaryIncome),
    taxableSocialSecurity: Math.max(0, taxableSocialSecurity),
    longTermCapitalGains: longGains,
    qualifiedDividends: dividendPreferentialIncome,
    profile: profile.state
  });

  return {
    ordinaryIncome: round(ordinaryIncome, 6),
    retirementOrdinaryIncome: round(retirementOrdinaryIncome, 6),
    ordinaryInvestmentIncome: round(ordinaryInvestmentIncome, 6),
    taxableSocialSecurity: round(taxableSocialSecurity, 6),
    adjustmentsToIncome: round(adjustments, 6),
    medicareWages: round(medicareWages, 6),
    selfEmploymentIncome: round(selfEmploymentIncome, 6),
    rrtaCompensation: round(rrtaCompensation, 6),
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
    additionalMedicareTax: additionalMedicare.tax,
    additionalMedicareTaxBase: additionalMedicare.taxBase,
    additionalMedicareWageBase: additionalMedicare.wageBase,
    additionalMedicareSelfEmploymentBase: additionalMedicare.selfEmploymentBase,
    additionalMedicareRrtaBase: additionalMedicare.rrtaBase,
    additionalMedicareThreshold: additionalMedicare.threshold,
    stateTax,
    totalTax: round(federalIncomeTax + niitTax + additionalMedicare.tax + stateTax, 6),
    lossCarryforward: round(lossPool, 6),
    lossCarryforwardShort: round(shortLossPool, 6),
    lossCarryforwardLong: round(longLossPool, 6)
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

function computeAdditionalMedicareTax({
  medicareWages = 0,
  selfEmploymentIncome = 0,
  rrtaCompensation = 0,
  profile
}) {
  const config = profile.additionalMedicareTax;
  if (!config) {
    return {
      tax: 0,
      taxBase: 0,
      wageBase: 0,
      selfEmploymentBase: 0,
      rrtaBase: 0,
      threshold: Infinity
    };
  }
  const threshold = config.thresholds?.[profile.filingStatus] ?? Infinity;
  const rate = config.rate ?? 0;
  const wages = Math.max(0, medicareWages);
  const selfEmployment = Math.max(0, selfEmploymentIncome);
  const rrta = Math.max(0, rrtaCompensation);
  const wageBase = Math.max(0, wages - threshold);
  const selfEmploymentThreshold = Math.max(0, threshold - wages);
  const selfEmploymentBase = Math.max(0, selfEmployment - selfEmploymentThreshold);
  const rrtaBase = Math.max(0, rrta - threshold);
  const taxBase = round(wageBase + selfEmploymentBase + rrtaBase, 6);

  return {
    tax: round(taxBase * rate, 6),
    taxBase,
    wageBase: round(wageBase, 6),
    selfEmploymentBase: round(selfEmploymentBase, 6),
    rrtaBase: round(rrtaBase, 6),
    threshold: Number.isFinite(threshold) ? round(threshold, 6) : Infinity
  };
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
