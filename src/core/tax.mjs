import { EPSILON, round } from "./utils.mjs";
import { buildTaxProfile } from "../data/taxData.mjs";

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
  shortTermCapitalGains = 0,
  longTermCapitalGains = 0,
  qualifiedDividends = 0,
  ordinaryInvestmentIncome = 0,
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
  const federalDeduction = (profile.standardDeduction ?? 0) + (profile.additionalDeduction ?? 0);
  const taxableOrdinaryIncome = Math.max(0, ordinaryAfterLossOffset - federalDeduction);
  const remainingDeduction = Math.max(0, federalDeduction - ordinaryAfterLossOffset);
  const preferentialIncome = longGains + dividendPreferentialIncome;
  const taxablePreferentialIncome = Math.max(0, preferentialIncome - remainingDeduction);
  const taxableLongTermCapitalGains = Math.max(0, longGains - remainingDeduction);
  const taxableQualifiedDividends = Math.max(0, taxablePreferentialIncome - taxableLongTermCapitalGains);

  const federalOrdinaryTax = taxFromBrackets(taxableOrdinaryIncome, profile.ordinaryBrackets);
  const federalPreferentialTax = taxPreferentialIncome({
    ordinaryTaxableIncome: taxableOrdinaryIncome,
    preferentialIncome: taxablePreferentialIncome,
    brackets: profile.capitalGainsBrackets
  });
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
    longTermCapitalGains: longGains,
    qualifiedDividends: dividendPreferentialIncome,
    profile: profile.state
  });

  return {
    ordinaryIncome: round(ordinaryIncome, 6),
    ordinaryInvestmentIncome: round(ordinaryInvestmentIncome, 6),
    shortTermCapitalGains: round(shortTermCapitalGains, 6),
    longTermCapitalGains: round(longTermCapitalGains, 6),
    qualifiedDividends: round(qualifiedDividends, 6),
    ordinaryLossOffset: round(ordinaryLossOffset, 6),
    taxableOrdinaryIncome: round(taxableOrdinaryIncome, 6),
    taxablePreferentialIncome: round(taxablePreferentialIncome, 6),
    taxableLongTermCapitalGains: round(taxableLongTermCapitalGains, 6),
    taxableQualifiedDividends: round(taxableQualifiedDividends, 6),
    federalOrdinaryTax,
    federalPreferentialTax,
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

function computeStateTax({ ordinaryIncome, longTermCapitalGains, qualifiedDividends, profile }) {
  if (!profile) return 0;

  const deduction = (profile.standardDeduction ?? 0) + (profile.personalExemption ?? 0);
  const capitalGains = Math.max(0, longTermCapitalGains);
  const qualified = Math.max(0, qualifiedDividends);

  if (profile.capitalGainsTreatment === "only") {
    return taxFromBrackets(Math.max(0, capitalGains - deduction), profile.brackets);
  }

  if (profile.capitalGainsTreatment === "excluded") {
    return taxFromBrackets(Math.max(0, ordinaryIncome + qualified - deduction), profile.brackets);
  }

  if (profile.treatCapitalGainsAsOrdinary !== false || profile.capitalGainsTreatment === "ordinary") {
    return taxFromBrackets(
      Math.max(0, ordinaryIncome + capitalGains + qualified - deduction),
      profile.brackets
    );
  }

  const stateOrdinaryTax = taxFromBrackets(Math.max(0, ordinaryIncome - deduction), profile.brackets);
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
    childTaxCredit: profile.childTaxCredit ? {
      ...profile.childTaxCredit,
      perChild: round((profile.childTaxCredit.perChild ?? 0) * index, 6),
      refundablePerChild: round((profile.childTaxCredit.refundablePerChild ?? 0) * index, 6)
    } : null,
    state: profile.state ? {
      ...profile.state,
      standardDeduction: round((profile.state.standardDeduction ?? 0) * index, 6),
      personalExemption: round((profile.state.personalExemption ?? 0) * index, 6),
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
