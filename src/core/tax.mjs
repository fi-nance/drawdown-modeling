import { EPSILON, round } from "./utils.mjs";
import { buildTaxProfile } from "../data/taxData.mjs?v=20260612-ladder-maintenance";
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

// Schedule D / IRC §1212(b) netting: short-term and long-term losses retain
// their character when carried forward. Within-character losses offset
// within-character gains first; any remaining loss may then offset gains of
// the other character. A net capital loss then creates the Schedule D line 21
// capital-loss deduction, but next-year carryover must be computed later
// against taxable income under the Capital Loss Carryover Worksheet.
export function netCapitalGainsAndLosses({
  shortTermCapitalGains = 0,
  longTermCapitalGains = 0,
  shortTermCapitalLosses,
  longTermCapitalLosses,
  capitalLosses = 0,
  carryforwardShort = 0,
  carryforwardLong = 0,
  ordinaryIncome = 0,
  adjustments = 0,
  ordinaryOffsetCap = 3000
} = {}) {
  const hasCharacterizedLosses = Number.isFinite(shortTermCapitalLosses) || Number.isFinite(longTermCapitalLosses);
  const currentShortLosses = hasCharacterizedLosses
    ? Math.max(0, shortTermCapitalLosses ?? 0)
    : 0;
  const currentLongLosses = hasCharacterizedLosses
    ? Math.max(0, longTermCapitalLosses ?? 0)
    : Math.max(0, capitalLosses);

  const shortGains = Math.max(0, shortTermCapitalGains);
  let longGains = Math.max(0, longTermCapitalGains);
  let shortLossPool = currentShortLosses + Math.max(0, carryforwardShort);
  let longLossPool = currentLongLosses + Math.max(0, carryforwardLong);
  const scheduleDShortTermNet = shortGains - shortLossPool;
  const scheduleDLongTermNet = longGains - longLossPool;
  const scheduleDNet = scheduleDShortTermNet + scheduleDLongTermNet;

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

  // Step 3: Schedule D line 21 capital-loss deduction, capped at the
  // §1211(b) threshold — $3,000 for most filers, $1,500 for MFS.
  const adjustmentsAmount = Math.max(0, adjustments);
  const ordinaryBeforeLossOffset = Math.max(0, ordinaryIncome + netShortGains - adjustmentsAmount);
  const cap = Math.min(Math.max(0, ordinaryOffsetCap), Math.max(0, -scheduleDNet));
  const shortOrdOffset = Math.min(shortLossPool, cap);
  shortLossPool -= shortOrdOffset;
  const longOrdOffset = Math.min(longLossPool, cap - shortOrdOffset);
  longLossPool -= longOrdOffset;

  return {
    netShortGains,
    netLongGains: longGains,
    ordinaryLossOffset: shortOrdOffset + longOrdOffset,
    ordinaryBeforeLossOffset,
    lossCarryforwardShort: shortLossPool,
    lossCarryforwardLong: longLossPool,
    scheduleDShortTermNet,
    scheduleDLongTermNet,
    scheduleDNet,
    scheduleDLine21Loss: shortOrdOffset + longOrdOffset
  };
}

function capitalLossCarryforwardForNextYear({
  scheduleDShortTermNet = 0,
  scheduleDLongTermNet = 0,
  scheduleDLine21Loss = 0,
  taxableIncomeBeforeZeroFloor = 0
} = {}) {
  const line2 = Math.max(0, scheduleDLine21Loss);
  if (!(line2 > 0)) return { shortTerm: 0, longTerm: 0, absorbedLoss: 0 };

  // Capital Loss Carryover Worksheet line 4: the part of line 21 actually
  // absorbed after deductions. If taxable income would be negative, unused
  // line-21 loss carries forward instead of vanishing.
  const line3 = Math.max(0, taxableIncomeBeforeZeroFloor + line2);
  const line4 = Math.min(line2, line3);

  const shortLoss = scheduleDShortTermNet < 0 ? -scheduleDShortTermNet : 0;
  const longLoss = scheduleDLongTermNet < 0 ? -scheduleDLongTermNet : 0;
  const shortGain = scheduleDShortTermNet > 0 ? scheduleDShortTermNet : 0;
  const longGain = scheduleDLongTermNet > 0 ? scheduleDLongTermNet : 0;

  const shortTerm = shortLoss > 0 ? Math.max(0, shortLoss - (line4 + longGain)) : 0;
  const line11 = Math.max(0, line4 - shortLoss);
  const longTerm = longLoss > 0 ? Math.max(0, longLoss - (shortGain + line11)) : 0;

  return {
    shortTerm: round(shortTerm, 6),
    longTerm: round(longTerm, 6),
    absorbedLoss: round(line4, 6)
  };
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
  socialSecurityWages = null,
  selfEmploymentIncome = 0,
  rrtaCompensation = 0,
  spouseMedicareWages = 0,
  spouseSocialSecurityWages = null,
  spouseSelfEmploymentIncome = 0,
  capitalLosses = 0,
  shortTermCapitalLosses,
  longTermCapitalLosses,
  capitalLossCarryforward = 0,
  profile = DEFAULT_TAX_PROFILE
} = {}) {
  // Legacy callers pass `capitalLossCarryforward` as a single number with no
  // character info; treat that number as long-term to match the long-standing
  // (and dominant in retirement) case.
  const carryforwardShort = typeof capitalLossCarryforward === "object" && capitalLossCarryforward !== null
    ? Math.max(0, capitalLossCarryforward.shortTerm ?? 0)
    : 0;
  const carryforwardLong = typeof capitalLossCarryforward === "object" && capitalLossCarryforward !== null
    ? Math.max(0, capitalLossCarryforward.longTerm ?? 0)
    : Math.max(0, capitalLossCarryforward);

  // Payroll and self-employment taxes are computed PER EARNER: each spouse
  // has their own Social Security wage base (pooling both earners' wages
  // under one base overstated the cap), while the Additional Medicare Tax
  // threshold applies to the couple's COMBINED wages/earnings per Form 8959.
  const selfEmployment = computeSelfEmploymentTax({
    selfEmploymentIncome,
    medicareWages,
    socialSecurityWages,
    profile
  });
  const spouseSelfEmployment = computeSelfEmploymentTax({
    selfEmploymentIncome: spouseSelfEmploymentIncome,
    medicareWages: spouseMedicareWages,
    socialSecurityWages: spouseSocialSecurityWages,
    profile
  });
  const employeePayroll = computeEmployeePayrollTax({
    medicareWages,
    socialSecurityWages,
    profile
  });
  const spouseEmployeePayroll = computeEmployeePayrollTax({
    medicareWages: spouseMedicareWages,
    socialSecurityWages: spouseSocialSecurityWages,
    profile
  });
  const adjustments = round(Math.max(0, adjustmentsToIncome) + selfEmployment.deduction + spouseSelfEmployment.deduction, 6);
  const netting = netCapitalGainsAndLosses({
    shortTermCapitalGains,
    longTermCapitalGains,
    shortTermCapitalLosses,
    longTermCapitalLosses,
    capitalLosses,
    carryforwardShort,
    carryforwardLong,
    ordinaryIncome,
    adjustments,
    ordinaryOffsetCap: profile.capitalLossOrdinaryIncomeOffset ?? 3000
  });
  const netShortGains = netting.netShortGains;
  const longGains = netting.netLongGains;
  const dividendPreferentialIncome = Math.max(0, qualifiedDividends);
  const ordinaryBeforeLossOffset = netting.ordinaryBeforeLossOffset;
  const ordinaryLossOffset = netting.ordinaryLossOffset;

  const ordinaryAfterLossOffset = Math.max(0, ordinaryBeforeLossOffset - ordinaryLossOffset);
  const preferentialIncome = longGains + dividendPreferentialIncome;
  const magi = round(ordinaryAfterLossOffset + preferentialIncome, 6);
  const enhancedSeniorDeduction = computeEnhancedSeniorDeduction({ magi, profile });
  const deductionChoice = computeFederalDeductionChoice({ agi: magi, profile });
  const federalDeduction = deductionChoice.federalDeduction + enhancedSeniorDeduction;
  const taxableOrdinaryIncomeBeforeQbi = Math.max(0, ordinaryAfterLossOffset - federalDeduction);
  const remainingDeduction = Math.max(0, federalDeduction - ordinaryAfterLossOffset);
  const taxablePreferentialIncome = Math.max(0, preferentialIncome - remainingDeduction);
  const qbi = computeQualifiedBusinessIncomeDeduction({
    taxableOrdinaryIncomeBeforeQbi,
    taxableIncomeBeforeQbi: taxableOrdinaryIncomeBeforeQbi + taxablePreferentialIncome,
    selfEmploymentIncome,
    selfEmploymentTaxDeduction: selfEmployment.deduction,
    profile
  });
  const taxableIncomeBeforeZeroFloor = round(
    ordinaryBeforeLossOffset + preferentialIncome - ordinaryLossOffset - federalDeduction - qbi.deduction,
    6
  );
  const carryforward = capitalLossCarryforwardForNextYear({
    scheduleDShortTermNet: netting.scheduleDShortTermNet,
    scheduleDLongTermNet: netting.scheduleDLongTermNet,
    scheduleDLine21Loss: netting.scheduleDLine21Loss,
    taxableIncomeBeforeZeroFloor
  });
  const shortLossPool = carryforward.shortTerm;
  const longLossPool = carryforward.longTerm;
  const lossPool = shortLossPool + longLossPool;
  const taxableOrdinaryIncome = Math.max(0, taxableOrdinaryIncomeBeforeQbi - qbi.deduction);
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
  const niitTax = computeNiit({
    magi,
    ordinaryInvestmentIncome,
    qualifiedDividends: dividendPreferentialIncome,
    netShortGains,
    longTermCapitalGains: longGains,
    profile
  });
  const additionalMedicare = computeAdditionalMedicareTax({
    medicareWages: medicareWages + Math.max(0, spouseMedicareWages),
    selfEmploymentIncome: selfEmployment.taxableEarnings + spouseSelfEmployment.taxableEarnings,
    rrtaCompensation,
    profile
  });
  const earnedIncomeForRefundableCredits = computeEarnedIncomeForRefundableChildCredit({
    medicareWages: medicareWages + Math.max(0, spouseMedicareWages),
    selfEmploymentIncome: selfEmploymentIncome + Math.max(0, spouseSelfEmploymentIncome),
    selfEmploymentTaxDeduction: selfEmployment.deduction + spouseSelfEmployment.deduction,
    rrtaCompensation
  });
  const additionalCredits = round(Math.max(0, profile.additionalCredits ?? 0), 6);
  const childTaxCreditBreakdown = computeChildTaxCreditBreakdown({
    magi,
    federalIncomeTaxBeforeCredits,
    additionalCredits,
    earnedIncomeForRefundableCredits,
    profile
  });
  const childTaxCredit = childTaxCreditBreakdown.allowableCredit;
  const federalCreditsUsed = childTaxCreditBreakdown.federalCreditsUsed;
  const federalIncomeTax = round(federalIncomeTaxBeforeCredits - federalCreditsUsed, 6);
  const federalRefundableCredits = childTaxCreditBreakdown.additionalChildTaxCredit;
  const netFederalIncomeTaxAfterRefundableCredits = round(federalIncomeTax - federalRefundableCredits, 6);

  // Pass the full retirement-income amounts to the state tax computation;
  // state retirement-income exclusions and taxable-SS adjustments operate on
  // the raw retirement components, not on a federal-loss-offset prorated
  // amount. The state computation will apply its own deductions/exclusions.
  const stateTaxBreakdown = computeStateTax({
    ordinaryIncome: ordinaryAfterLossOffset,
    retirementOrdinaryIncome: Math.max(0, retirementOrdinaryIncome),
    taxableSocialSecurity: Math.max(0, taxableSocialSecurity),
    longTermCapitalGains: longGains,
    qualifiedDividends: dividendPreferentialIncome,
    federalCapitalLossDeduction: ordinaryLossOffset,
    federalCapitalLossCarryforward: lossPool,
    federalCapitalLossCarryforwardShort: shortLossPool,
    federalCapitalLossCarryforwardLong: longLossPool,
    profile: profile.state
  });
  const stateTax = stateTaxBreakdown.tax;

  return {
    ordinaryIncome: round(ordinaryIncome, 6),
    retirementOrdinaryIncome: round(retirementOrdinaryIncome, 6),
    ordinaryInvestmentIncome: round(ordinaryInvestmentIncome, 6),
    taxableSocialSecurity: round(taxableSocialSecurity, 6),
    adjustmentsToIncome: round(adjustments, 6),
    federalAgi: round(magi, 6),
    magi: round(magi, 6),
    medicareWages: round(medicareWages, 6),
    socialSecurityWages: employeePayroll.socialSecurityWages,
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
    taxableOrdinaryIncomeBeforeQbi: round(taxableOrdinaryIncomeBeforeQbi, 6),
    federalDeduction: round(federalDeduction, 6),
    federalDeductionBase: round(deductionChoice.baseDeduction, 6),
    federalDeductionKind: deductionChoice.kind,
    standardDeductionWithAge65: round(deductionChoice.standardDeductionWithAge65, 6),
    itemizedDeduction: round(deductionChoice.itemizedDeduction, 6),
    itemizedDeductionBreakdown: deductionChoice.itemizedBreakdown,
    additionalDeduction: round(deductionChoice.additionalDeduction, 6),
    enhancedSeniorDeduction: round(enhancedSeniorDeduction, 6),
    qbiDeduction: round(qbi.deduction, 6),
    qbiDeductionBreakdown: qbi.breakdown,
    federalOrdinaryTax,
    federalOrdinaryBracketDetails,
    federalPreferentialTax,
    federalPreferentialBracketDetails,
    federalIncomeTaxBeforeCredits,
    childTaxCredit: round(childTaxCredit, 6),
    childTaxCreditBreakdown,
    nonrefundableChildTaxCredit: childTaxCreditBreakdown.nonrefundableChildTaxCredit,
    unusedChildTaxCredit: childTaxCreditBreakdown.unusedChildTaxCredit,
    additionalChildTaxCredit: childTaxCreditBreakdown.additionalChildTaxCredit,
    federalRefundableCredits,
    earnedIncomeForRefundableCredits,
    additionalCredits,
    additionalCreditsUsed: childTaxCreditBreakdown.additionalCreditsUsed,
    federalCreditsUsed,
    federalIncomeTax,
    netFederalIncomeTaxAfterRefundableCredits,
    niitTax,
    employeePayrollTax: employeePayroll.tax,
    employeeSocialSecurityTax: employeePayroll.socialSecurityTax,
    employeeSocialSecurityTaxableWages: employeePayroll.socialSecurityTaxableWages,
    employeeMedicareTax: employeePayroll.medicareTax,
    employeePayrollSocialSecurityWageBase: employeePayroll.socialSecurityWageBase,
    selfEmploymentTax: selfEmployment.tax,
    selfEmploymentTaxableEarnings: selfEmployment.taxableEarnings,
    selfEmploymentNetEarnings: selfEmployment.netEarnings,
    selfEmploymentSocialSecurityTax: selfEmployment.socialSecurityTax,
    selfEmploymentSocialSecurityTaxableEarnings: selfEmployment.socialSecurityTaxableEarnings,
    selfEmploymentMedicareTax: selfEmployment.medicareTax,
    selfEmploymentTaxDeduction: selfEmployment.deduction,
    selfEmploymentSocialSecurityWageBase: selfEmployment.socialSecurityWageBase,
    selfEmploymentRemainingSocialSecurityWageBase: selfEmployment.remainingSocialSecurityWageBase,
    spouseEmployeePayrollTax: spouseEmployeePayroll.tax,
    spouseEmployeeSocialSecurityTax: spouseEmployeePayroll.socialSecurityTax,
    spouseEmployeeMedicareTax: spouseEmployeePayroll.medicareTax,
    spouseSelfEmploymentTax: spouseSelfEmployment.tax,
    spouseSelfEmploymentTaxDeduction: spouseSelfEmployment.deduction,
    spouseSelfEmploymentTaxableEarnings: spouseSelfEmployment.taxableEarnings,
    spouseMedicareWages: round(Math.max(0, spouseMedicareWages), 6),
    spouseSocialSecurityWages: spouseEmployeePayroll.socialSecurityWages,
    additionalMedicareTax: additionalMedicare.tax,
    additionalMedicareTaxBase: additionalMedicare.taxBase,
    additionalMedicareWageBase: additionalMedicare.wageBase,
    additionalMedicareSelfEmploymentBase: additionalMedicare.selfEmploymentBase,
    additionalMedicareRrtaBase: additionalMedicare.rrtaBase,
    additionalMedicareThreshold: additionalMedicare.threshold,
    stateTax,
    stateTaxBreakdown,
    totalTax: round(netFederalIncomeTaxAfterRefundableCredits + niitTax + employeePayroll.tax + spouseEmployeePayroll.tax + selfEmployment.tax + spouseSelfEmployment.tax + additionalMedicare.tax + stateTax, 6),
    lossCarryforward: round(lossPool, 6),
    lossCarryforwardShort: round(shortLossPool, 6),
    lossCarryforwardLong: round(longLossPool, 6)
  };
}

export function computeFederalDeductionChoice({ agi = 0, profile = DEFAULT_TAX_PROFILE } = {}) {
  const age65AdditionalDeduction = Math.max(0, Number(profile.age65AdditionalDeduction) || 0);
  const totalAdditionalDeduction = Math.max(0, Number(profile.additionalDeduction) || 0);
  const additionalDeduction = Math.max(0, totalAdditionalDeduction - age65AdditionalDeduction);
  const standardDeductionWithAge65 = Math.max(0, Number(profile.standardDeduction) || 0) + age65AdditionalDeduction;
  const itemized = computeItemizedDeduction({ agi, profile });
  const mode = itemized.mode;

  let kind = "standard";
  let baseDeduction = standardDeductionWithAge65;
  if (mode === "itemized" || (mode === "auto" && itemized.total > standardDeductionWithAge65)) {
    kind = "itemized";
    baseDeduction = itemized.total;
  }

  return {
    kind,
    baseDeduction: round(baseDeduction, 6),
    federalDeduction: round(baseDeduction + additionalDeduction, 6),
    standardDeductionWithAge65: round(standardDeductionWithAge65, 6),
    itemizedDeduction: round(itemized.total, 6),
    itemizedBreakdown: itemized.breakdown,
    additionalDeduction: round(additionalDeduction, 6)
  };
}

export function computeQualifiedBusinessIncomeDeduction({
  taxableOrdinaryIncomeBeforeQbi = 0,
  taxableIncomeBeforeQbi = 0,
  selfEmploymentIncome = 0,
  selfEmploymentTaxDeduction = 0,
  profile = DEFAULT_TAX_PROFILE
} = {}) {
  const config = profile.qualifiedBusinessIncomeDeduction;
  const qbiInput = profile.qualifiedBusinessIncome ?? {};
  const sourceMode = ["manual", "selfEmployment"].includes(qbiInput.sourceMode) ? qbiInput.sourceMode : "none";
  const taxableOrdinaryCap = Math.max(0, Number(taxableOrdinaryIncomeBeforeQbi) || 0);
  if (!config || sourceMode === "none" || taxableOrdinaryCap <= EPSILON) {
    return emptyQbiDeduction(sourceMode, taxableOrdinaryCap);
  }

  const qualifiedBusinessIncome = sourceMode === "selfEmployment"
    ? Math.max(0, (Number(selfEmploymentIncome) || 0) - Math.max(0, Number(selfEmploymentTaxDeduction) || 0))
    : Math.max(0, Number(qbiInput.amount) || 0);
  if (qualifiedBusinessIncome <= EPSILON) {
    return emptyQbiDeduction(sourceMode, taxableOrdinaryCap);
  }

  const filingStatus = profile.filingStatus ?? "marriedFilingJointly";
  const threshold = qbiConfigAmount(config.threshold, filingStatus, Infinity);
  const phaseInEnd = qbiConfigAmount(config.phaseInEnd, filingStatus, threshold);
  const phaseInRange = Math.max(1, phaseInEnd - threshold);
  const taxableIncome = Math.max(0, Number(taxableIncomeBeforeQbi) || 0);
  const w2Wages = Math.max(0, Number(qbiInput.w2Wages) || 0);
  const ubiaQualifiedProperty = Math.max(0, Number(qbiInput.ubiaQualifiedProperty) || 0);
  const rate = Math.max(0, Number(config.rate) || 0.20);
  const qbiComponent = qualifiedBusinessIncome * rate;
  const taxableIncomeCap = taxableOrdinaryCap * rate;
  const wageLimit = Math.max(
    w2Wages * Math.max(0, Number(config.wageLimitPercent) || 0),
    w2Wages * Math.max(0, Number(config.wagePropertyWagePercent) || 0)
      + ubiaQualifiedProperty * Math.max(0, Number(config.propertyLimitPercent) || 0)
  );
  const specifiedServiceBusiness = qbiInput.specifiedServiceBusiness === true;
  const phaseRatio = taxableIncome <= threshold
    ? 0
    : Math.min(1, Math.max(0, (taxableIncome - threshold) / phaseInRange));

  let businessComponent = qbiComponent;
  if (specifiedServiceBusiness && phaseRatio >= 1) {
    businessComponent = 0;
  } else if (specifiedServiceBusiness && phaseRatio > 0) {
    const applicablePercentage = Math.max(0, 1 - phaseRatio);
    const reducedQbiComponent = qbiComponent * applicablePercentage;
    const reducedWageLimit = wageLimit * applicablePercentage;
    businessComponent = reducedQbiComponent - Math.max(0, reducedQbiComponent - reducedWageLimit) * phaseRatio;
  } else if (phaseRatio >= 1) {
    businessComponent = Math.min(qbiComponent, wageLimit);
  } else if (phaseRatio > 0) {
    businessComponent = qbiComponent - Math.max(0, qbiComponent - wageLimit) * phaseRatio;
  }

  let deduction = Math.min(Math.max(0, businessComponent), taxableIncomeCap);
  const minimumActiveQbi = Math.max(0, Number(config.minimumActiveQbi) || 0);
  const minimumDeduction = Math.max(0, Number(config.minimumDeduction) || 0);
  const qualifiesForMinimum = qualifiedBusinessIncome >= minimumActiveQbi
    && minimumDeduction > 0
    && (!specifiedServiceBusiness || phaseRatio < 1);
  if (qualifiesForMinimum) {
    deduction = Math.max(deduction, Math.min(minimumDeduction, taxableOrdinaryCap));
  }
  deduction = Math.min(deduction, taxableOrdinaryCap);

  return {
    deduction: round(deduction, 6),
    breakdown: {
      sourceMode,
      qualifiedBusinessIncome: round(qualifiedBusinessIncome, 6),
      qbiComponent: round(qbiComponent, 6),
      taxableIncomeCap: round(taxableIncomeCap, 6),
      wageLimit: round(wageLimit, 6),
      w2Wages: round(w2Wages, 6),
      ubiaQualifiedProperty: round(ubiaQualifiedProperty, 6),
      threshold: round(threshold, 6),
      phaseInEnd: round(phaseInEnd, 6),
      phaseRatio: round(phaseRatio, 6),
      specifiedServiceBusiness,
      minimumDeductionApplied: qualifiesForMinimum && deduction >= minimumDeduction - EPSILON && businessComponent < minimumDeduction
    }
  };
}

function emptyQbiDeduction(sourceMode = "none", taxableOrdinaryCap = 0) {
  return {
    deduction: 0,
    breakdown: {
      sourceMode,
      qualifiedBusinessIncome: 0,
      qbiComponent: 0,
      taxableIncomeCap: round(Math.max(0, Number(taxableOrdinaryCap) || 0) * 0.20, 6),
      wageLimit: 0,
      w2Wages: 0,
      ubiaQualifiedProperty: 0,
      threshold: null,
      phaseInEnd: null,
      phaseRatio: 0,
      specifiedServiceBusiness: false,
      minimumDeductionApplied: false
    }
  };
}

function qbiConfigAmount(map = {}, filingStatus, fallback) {
  const value = Number(map?.[filingStatus]);
  if (Number.isFinite(value)) return value;
  const single = Number(map?.single);
  return Number.isFinite(single) ? single : fallback;
}

export function computeItemizedDeduction({ agi = 0, profile = DEFAULT_TAX_PROFILE } = {}) {
  const itemized = profile.itemizedDeductions ?? {};
  const mode = ["auto", "standard", "itemized"].includes(itemized.mode) ? itemized.mode : "auto";
  const limits = itemized.limits ?? {};
  const saltLimit = saltDeductionLimit({
    agi,
    filingStatus: profile.filingStatus,
    taxYear: profile.itemizedDeductionTaxYear ?? profile.year,
    config: limits.salt
  });
  const stateLocalTaxes = Math.max(0, Number(itemized.stateLocalTaxes) || 0);
  const saltDeduction = Math.min(stateLocalTaxes, saltLimit);
  const medicalFloorRate = Math.max(0, Number(limits.medicalExpenseAgiFloor) || 0.075);
  const medicalExpenses = Math.max(0, Number(itemized.medicalExpenses) || 0);
  const medicalFloor = Math.max(0, Number(agi) || 0) * medicalFloorRate;
  const medicalDeduction = Math.max(0, medicalExpenses - medicalFloor);
  const mortgageInterest = Math.max(0, Number(itemized.mortgageInterest) || 0);
  const charitableContributions = Math.max(0, Number(itemized.charitableContributions) || 0);
  const total = saltDeduction + mortgageInterest + charitableContributions + medicalDeduction;
  return {
    mode,
    total: round(total, 6),
    breakdown: {
      stateLocalTaxes: round(saltDeduction, 6),
      stateLocalTaxesEntered: round(stateLocalTaxes, 6),
      stateLocalTaxLimit: round(saltLimit, 6),
      mortgageInterest: round(mortgageInterest, 6),
      charitableContributions: round(charitableContributions, 6),
      medicalExpenses: round(medicalDeduction, 6),
      medicalExpensesEntered: round(medicalExpenses, 6),
      medicalExpenseFloor: round(medicalFloor, 6),
      medicalExpenseFloorRate: medicalFloorRate
    }
  };
}

function saltDeductionLimit({ agi = 0, filingStatus, taxYear, config = {} } = {}) {
  const year = Number(taxYear);
  const isMfs = filingStatus === "marriedFilingSeparately";
  if (Number.isFinite(year) && year >= Number(config.temporaryCapStartYear ?? 2025) && year <= Number(config.temporaryCapEndYear ?? 2029)) {
    const yearsAfter2025 = Math.max(0, Math.trunc(year - 2025));
    const growth = Math.pow(1 + Math.max(0, Number(config.annualIncreaseRate) || 0), yearsAfter2025);
    const capBase = isMfs ? Number(config.mfsCap2025) : Number(config.cap2025);
    const thresholdBase = isMfs ? Number(config.mfsPhaseoutThreshold2025) : Number(config.phaseoutThreshold2025);
    const floor = isMfs ? Number(config.mfsFloor) : Number(config.floor);
    const cap = Number.isFinite(capBase) ? capBase * growth : (isMfs ? 5000 : 10000);
    const threshold = Number.isFinite(thresholdBase) ? thresholdBase * growth : Infinity;
    const phaseout = Math.max(0, Number(agi) - threshold) * Math.max(0, Number(config.phaseoutRate) || 0);
    return round(Math.max(Number.isFinite(floor) ? floor : 0, cap - phaseout), 6);
  }
  const postCap = isMfs ? Number(config.mfsPost2029Cap) : Number(config.post2029Cap);
  return round(Number.isFinite(postCap) ? postCap : (isMfs ? 5000 : 10000), 6);
}

export function computeEnhancedSeniorDeduction({ magi = 0, profile = DEFAULT_TAX_PROFILE } = {}) {
  const config = profile.enhancedSeniorDeduction;
  if (!config) return 0;

  const filingStatus = profile.filingStatus;
  if (filingStatus === "marriedFilingSeparately") return 0;

  const eligibleCount = Math.max(0, Math.trunc(Number(profile.enhancedSeniorDeductionEligibleCount) || 0));
  if (!eligibleCount) return 0;

  const taxYear = Number(profile.enhancedSeniorDeductionTaxYear ?? profile.year);
  if (Number.isFinite(taxYear)) {
    const start = Number(config.effectiveStartYear);
    const end = Number(config.effectiveEndYear);
    if (Number.isFinite(start) && taxYear < start) return 0;
    if (Number.isFinite(end) && taxYear > end) return 0;
  }

  const amountPerPerson = Math.max(0, Number(config.amountPerEligiblePerson) || 0);
  if (amountPerPerson <= 0) return 0;

  const threshold = Number(config.phaseoutThresholds?.[filingStatus]);
  if (!Number.isFinite(threshold)) return 0;

  const phaseout = Math.max(0, Number(magi) - threshold) * Math.max(0, Number(config.phaseoutRate) || 0);
  const deductionPerPerson = Math.max(0, amountPerPerson - phaseout);
  return round(deductionPerPerson * eligibleCount, 6);
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

export function computeSelfEmploymentTax({
  selfEmploymentIncome = 0,
  medicareWages = 0,
  socialSecurityWages = null,
  profile = DEFAULT_TAX_PROFILE
} = {}) {
  const config = profile?.selfEmploymentTax;
  const wageBase = Math.max(0, Number(config?.socialSecurityWageBase) || 0);
  const modeledSocialSecurityWages = modeledW2SocialSecurityWages({ socialSecurityWages, medicareWages, wageBase });
  const rawSelfEmploymentIncome = Math.max(0, Number(selfEmploymentIncome) || 0);
  const empty = {
    tax: 0,
    taxableEarnings: 0,
    netEarnings: 0,
    socialSecurityTax: 0,
    socialSecurityTaxableEarnings: 0,
    medicareTax: 0,
    deduction: 0,
    socialSecurityWages: round(modeledSocialSecurityWages, 6),
    socialSecurityWageBase: round(wageBase, 6),
    remainingSocialSecurityWageBase: round(Math.max(0, wageBase - modeledSocialSecurityWages), 6)
  };
  if (!config || rawSelfEmploymentIncome <= EPSILON) return empty;

  const netEarnings = round(rawSelfEmploymentIncome * (config.netEarningsMultiplier ?? 0.9235), 6);
  if (netEarnings < (config.minimumNetEarnings ?? 400) - EPSILON) {
    return { ...empty, netEarnings };
  }

  const remainingSocialSecurityWageBase = Math.max(0, wageBase - modeledSocialSecurityWages);
  const socialSecurityTaxableEarnings = Math.min(netEarnings, remainingSocialSecurityWageBase);
  const socialSecurityTax = round(socialSecurityTaxableEarnings * (config.socialSecurityRate ?? 0), 6);
  const medicareTax = round(netEarnings * (config.medicareRate ?? 0), 6);
  const tax = round(socialSecurityTax + medicareTax, 6);

  return {
    tax,
    taxableEarnings: netEarnings,
    netEarnings,
    socialSecurityTax,
    socialSecurityTaxableEarnings: round(socialSecurityTaxableEarnings, 6),
    medicareTax,
    deduction: round(tax * 0.5, 6),
    socialSecurityWages: round(modeledSocialSecurityWages, 6),
    socialSecurityWageBase: round(wageBase, 6),
    remainingSocialSecurityWageBase: round(remainingSocialSecurityWageBase, 6)
  };
}

export function computeEmployeePayrollTax({
  medicareWages = 0,
  socialSecurityWages = null,
  profile = DEFAULT_TAX_PROFILE
} = {}) {
  const config = profile?.employeePayrollTax;
  const wageBase = Math.max(0, Number(config?.socialSecurityWageBase) || 0);
  const modeledSocialSecurityWages = modeledW2SocialSecurityWages({ socialSecurityWages, medicareWages, wageBase });
  const socialSecurityTaxableWages = Math.min(modeledSocialSecurityWages, wageBase);
  const medicareTaxableWages = Math.max(0, Number(medicareWages) || 0);
  const empty = {
    tax: 0,
    socialSecurityTax: 0,
    socialSecurityTaxableWages: 0,
    medicareTax: 0,
    medicareTaxableWages: round(medicareTaxableWages, 6),
    socialSecurityWages: round(modeledSocialSecurityWages, 6),
    socialSecurityWageBase: round(wageBase, 6)
  };
  if (!config || medicareTaxableWages <= EPSILON) return empty;

  const socialSecurityTax = round(socialSecurityTaxableWages * (config.socialSecurityRate ?? 0), 6);
  const medicareTax = round(medicareTaxableWages * (config.medicareRate ?? 0), 6);
  return {
    tax: round(socialSecurityTax + medicareTax, 6),
    socialSecurityTax,
    socialSecurityTaxableWages: round(socialSecurityTaxableWages, 6),
    medicareTax,
    medicareTaxableWages: round(medicareTaxableWages, 6),
    socialSecurityWages: round(modeledSocialSecurityWages, 6),
    socialSecurityWageBase: round(wageBase, 6)
  };
}

function modeledW2SocialSecurityWages({ socialSecurityWages = null, medicareWages = 0, wageBase = 0 } = {}) {
  return socialSecurityWages != null && Number.isFinite(Number(socialSecurityWages))
    ? Math.max(0, Number(socialSecurityWages) || 0)
    : Math.min(Math.max(0, Number(medicareWages) || 0), Math.max(0, Number(wageBase) || 0));
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

export function computeChildTaxCredit({ magi, profile }) {
  const config = profile.childTaxCredit;
  const qualifyingChildren = Math.max(0, Math.trunc(Number(profile.qualifyingChildren) || 0));
  if (!config || qualifyingChildren <= 0) return 0;

  const grossCredit = qualifyingChildren * (config.perChild ?? 0);
  const threshold = config.phaseoutThresholds?.[profile.filingStatus] ?? 0;
  const excess = Math.max(0, magi - threshold);
  const phaseout = Math.ceil(excess / 1000) * (config.phaseoutPerThousand ?? 0);
  return round(Math.max(0, grossCredit - phaseout), 6);
}

export function computeChildTaxCreditBreakdown({
  magi = 0,
  federalIncomeTaxBeforeCredits = 0,
  additionalCredits = 0,
  earnedIncomeForRefundableCredits = 0,
  profile = DEFAULT_TAX_PROFILE
} = {}) {
  const config = profile.childTaxCredit;
  const qualifyingChildren = Math.max(0, Math.trunc(Number(profile.qualifyingChildren) || 0));
  const allowableCredit = computeChildTaxCredit({ magi, profile });
  const taxBeforeCredits = Math.max(0, Number(federalIncomeTaxBeforeCredits) || 0);
  const manualAdditionalCredits = Math.max(0, Number(additionalCredits) || 0);
  const nonrefundableChildTaxCredit = round(Math.min(taxBeforeCredits, allowableCredit), 6);
  const taxAfterChildCredit = Math.max(0, taxBeforeCredits - nonrefundableChildTaxCredit);
  const additionalCreditsUsed = round(Math.min(taxAfterChildCredit, manualAdditionalCredits), 6);
  const federalCreditsUsed = round(nonrefundableChildTaxCredit + additionalCreditsUsed, 6);
  const unusedChildTaxCredit = round(Math.max(0, allowableCredit - nonrefundableChildTaxCredit), 6);
  const refundablePerChildLimit = round(qualifyingChildren * Math.max(0, Number(config?.refundablePerChild) || 0), 6);
  const earnedIncomeThreshold = Math.max(0, Number(config?.refundableEarnedIncomeThreshold) || 0);
  const earnedIncomeRate = Math.max(0, Number(config?.refundableEarnedIncomeRate) || 0);
  const earnedIncomeLimit = round(Math.max(0, (Number(earnedIncomeForRefundableCredits) || 0) - earnedIncomeThreshold) * earnedIncomeRate, 6);
  const additionalChildTaxCredit = round(Math.min(unusedChildTaxCredit, refundablePerChildLimit, earnedIncomeLimit), 6);
  const threeOrMoreChildReviewApplies = qualifyingChildren >= 3
    && unusedChildTaxCredit > additionalChildTaxCredit + EPSILON
    && refundablePerChildLimit > additionalChildTaxCredit + EPSILON;

  return {
    qualifyingChildren,
    allowableCredit: round(allowableCredit, 6),
    nonrefundableChildTaxCredit,
    unusedChildTaxCredit,
    refundablePerChildLimit,
    earnedIncomeForRefundableCredits: round(Math.max(0, Number(earnedIncomeForRefundableCredits) || 0), 6),
    earnedIncomeThreshold: round(earnedIncomeThreshold, 6),
    earnedIncomeRate,
    earnedIncomeLimit,
    additionalChildTaxCredit,
    additionalCreditsUsed,
    federalCreditsUsed,
    threeOrMoreChildReviewApplies
  };
}

function computeEarnedIncomeForRefundableChildCredit({
  medicareWages = 0,
  selfEmploymentIncome = 0,
  selfEmploymentTaxDeduction = 0,
  rrtaCompensation = 0
} = {}) {
  const wages = Math.max(0, Number(medicareWages) || 0);
  const selfEmploymentEarnedIncome = Math.max(
    0,
    Math.max(0, Number(selfEmploymentIncome) || 0) - Math.max(0, Number(selfEmploymentTaxDeduction) || 0)
  );
  const railroadCompensation = Math.max(0, Number(rrtaCompensation) || 0);
  return round(wages + selfEmploymentEarnedIncome + railroadCompensation, 6);
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
  federalCapitalLossDeduction = 0,
  federalCapitalLossCarryforward = 0,
  federalCapitalLossCarryforwardShort = 0,
  federalCapitalLossCarryforwardLong = 0,
  profile
}) {
  if (!profile) return emptyStateTaxBreakdown();

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
  const capitalLossTreatment = stateCapitalLossTreatmentBreakdown({
    profile,
    federalCapitalLossDeduction,
    federalCapitalLossCarryforward,
    federalCapitalLossCarryforwardShort,
    federalCapitalLossCarryforwardLong
  });

  const base = {
    state: profile.state ?? null,
    source: profile.source ?? null,
    capitalGainsTreatment: profile.capitalGainsTreatment ?? (profile.treatCapitalGainsAsOrdinary === false ? "separate" : "ordinary"),
    deduction: round(deduction, 6),
    ordinaryIncome: round(Math.max(0, ordinaryIncome), 6),
    retirementOrdinaryIncome: round(Math.max(0, retirementOrdinaryIncome), 6),
    taxableSocialSecurity: round(Math.max(0, taxableSocialSecurity), 6),
    capitalGains: round(capitalGains, 6),
    qualifiedDividends: round(qualified, 6),
    stateIncomeBeforeDeduction: round(stateIncomeBeforeDeduction, 6),
    socialSecurityExclusion: round(socialSecurityExclusion, 6),
    retirementExclusion: round(retirementExclusion, 6),
    stateOrdinaryIncome: round(stateOrdinaryIncome, 6),
    capitalLossTreatment
  };

  let tax = 0;
  let ordinaryTaxableBase = 0;
  let capitalGainsTaxableBase = 0;

  if (profile.capitalGainsTreatment === "only") {
    capitalGainsTaxableBase = Math.max(0, capitalGains - deduction);
    tax = taxFromBrackets(capitalGainsTaxableBase, profile.brackets);
  } else if (profile.capitalGainsTreatment === "excluded") {
    ordinaryTaxableBase = Math.max(0, stateOrdinaryIncome + qualified - deduction);
    tax = taxFromBrackets(ordinaryTaxableBase, profile.brackets);
  } else if (profile.treatCapitalGainsAsOrdinary !== false || profile.capitalGainsTreatment === "ordinary") {
    ordinaryTaxableBase = Math.max(0, stateOrdinaryIncome + capitalGains + qualified - deduction);
    tax = taxFromBrackets(ordinaryTaxableBase, profile.brackets);
  } else {
    ordinaryTaxableBase = Math.max(0, stateOrdinaryIncome - deduction);
    capitalGainsTaxableBase = Math.max(0, capitalGains + qualified);
    const stateOrdinaryTax = taxFromBrackets(ordinaryTaxableBase, profile.brackets);
    const stateCapitalGainsTax = capitalGainsTaxableBase * (profile.capitalGainsRate ?? 0);
    tax = round(stateOrdinaryTax + stateCapitalGainsTax, 6);
  }

  return {
    ...base,
    ordinaryTaxableBase: round(ordinaryTaxableBase, 6),
    capitalGainsTaxableBase: round(capitalGainsTaxableBase, 6),
    tax: round(tax, 6)
  };
}

function stateCapitalLossTreatmentBreakdown({
  profile,
  federalCapitalLossDeduction = 0,
  federalCapitalLossCarryforward = 0,
  federalCapitalLossCarryforwardShort = 0,
  federalCapitalLossCarryforwardLong = 0
} = {}) {
  const ordinaryLossOffsetIncluded = Math.max(0, Number(federalCapitalLossDeduction) || 0);
  const carryforward = Math.max(0, Number(federalCapitalLossCarryforward) || 0);
  const shortTermCarryforward = Math.max(0, Number(federalCapitalLossCarryforwardShort) || 0);
  const longTermCarryforward = Math.max(0, Number(federalCapitalLossCarryforwardLong) || 0);
  const hasCapitalLossEffect = ordinaryLossOffsetIncluded > EPSILON || carryforward > EPSILON;
  const assumption = profile?.capitalLossConformity ?? "federal-agi-approximation";

  return {
    assumption,
    ordinaryLossOffsetIncluded: round(ordinaryLossOffsetIncluded, 6),
    carryforwardForFederalNextYear: round(carryforward, 6),
    carryforwardShortTerm: round(shortTermCarryforward, 6),
    carryforwardLongTerm: round(longTermCarryforward, 6),
    reviewRequired: Boolean(hasCapitalLossEffect && assumption === "federal-agi-approximation"),
    note: "State tax uses the modeled federal capital-loss netting and carryforward as a broad federal-AGI conformity approximation; state-specific additions, subtractions, and carryforward forms are not modeled."
  };
}

function emptyStateTaxBreakdown() {
  return {
    state: null,
    source: null,
    capitalGainsTreatment: null,
    deduction: 0,
    ordinaryIncome: 0,
    retirementOrdinaryIncome: 0,
    taxableSocialSecurity: 0,
    capitalGains: 0,
    qualifiedDividends: 0,
    stateIncomeBeforeDeduction: 0,
    socialSecurityExclusion: 0,
    retirementExclusion: 0,
    stateOrdinaryIncome: 0,
    ordinaryTaxableBase: 0,
    capitalGainsTaxableBase: 0,
    capitalLossTreatment: stateCapitalLossTreatmentBreakdown(),
    tax: 0
  };
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
    itemizedDeductions: profile.itemizedDeductions ? {
      ...profile.itemizedDeductions,
      stateLocalTaxes: round((profile.itemizedDeductions.stateLocalTaxes ?? 0) * index, 6),
      mortgageInterest: round((profile.itemizedDeductions.mortgageInterest ?? 0) * index, 6),
      charitableContributions: round((profile.itemizedDeductions.charitableContributions ?? 0) * index, 6),
      medicalExpenses: round((profile.itemizedDeductions.medicalExpenses ?? 0) * index, 6)
    } : null,
    qualifiedBusinessIncomeDeduction: profile.qualifiedBusinessIncomeDeduction ? {
      ...profile.qualifiedBusinessIncomeDeduction,
      minimumActiveQbi: round((profile.qualifiedBusinessIncomeDeduction.minimumActiveQbi ?? 0) * index, 6),
      minimumDeduction: round((profile.qualifiedBusinessIncomeDeduction.minimumDeduction ?? 0) * index, 6),
      threshold: scaleDollarMap(profile.qualifiedBusinessIncomeDeduction.threshold, index),
      phaseInEnd: scaleDollarMap(profile.qualifiedBusinessIncomeDeduction.phaseInEnd, index)
    } : null,
    qualifiedBusinessIncome: profile.qualifiedBusinessIncome ? {
      ...profile.qualifiedBusinessIncome,
      amount: round((profile.qualifiedBusinessIncome.amount ?? 0) * index, 6),
      w2Wages: round((profile.qualifiedBusinessIncome.w2Wages ?? 0) * index, 6)
    } : null,
    childTaxCredit: profile.childTaxCredit ? {
      // perChild and refundablePerChild are inflation-indexed under
      // IRC §24(h)/(d) as amended by OBBBA. The $2,500 refundable
      // earned-income threshold in §24(d)(1)(B)(i) is statutory and NOT
      // indexed, so it is deliberately left unscaled here.
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

function scaleDollarMap(values = {}, inflationIndex = 1) {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [
    key,
    Number.isFinite(Number(value)) ? round(Number(value) * inflationIndex, 6) : value
  ]));
}
