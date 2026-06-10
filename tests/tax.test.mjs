import assert from "node:assert/strict";
import test from "node:test";

import {
  computeIncomeTax,
  computeTaxableSocialSecurityBenefits,
  taxFromBrackets,
  inflateTaxProfile
} from "../src/core/tax.mjs";
import { buildTaxProfile, TAX_DATA_VERSION } from "../src/data/taxData.mjs";

const profile = {
  standardDeduction: 0,
  capitalLossOrdinaryIncomeOffset: 3000,
  ordinaryBrackets: [
    { upTo: 10000, rate: 0.1 },
    { upTo: 50000, rate: 0.2 },
    { upTo: Infinity, rate: 0.3 }
  ],
  capitalGainsBrackets: [
    { upTo: 40000, rate: 0 },
    { upTo: Infinity, rate: 0.15 }
  ],
  state: {
    standardDeduction: 0,
    brackets: [{ upTo: Infinity, rate: 0.05 }],
    treatCapitalGainsAsOrdinary: true
  }
};

test("taxFromBrackets applies progressive marginal rates", () => {
  const tax = taxFromBrackets(60000, profile.ordinaryBrackets);
  assert.equal(tax, 12000);
});

test("capital gains stack on top of ordinary taxable income", () => {
  const tax = computeIncomeTax({
    ordinaryIncome: 30000,
    longTermCapitalGains: 20000,
    profile
  });

  assert.equal(tax.federalOrdinaryTax, 5000);
  assert.equal(tax.federalPreferentialTax, 1500);
  assert.equal(tax.stateTax, 2500);
  assert.equal(tax.totalTax, 9000);
  assert.deepEqual(tax.federalOrdinaryBracketDetails.map((bracket) => ({
    rate: bracket.rate,
    taxableIncome: bracket.taxableIncome,
    tax: bracket.tax
  })), [
    { rate: 0.1, taxableIncome: 10000, tax: 1000 },
    { rate: 0.2, taxableIncome: 20000, tax: 4000 }
  ]);
  assert.deepEqual(tax.federalPreferentialBracketDetails.map((bracket) => ({
    rate: bracket.rate,
    taxableIncome: bracket.taxableIncome,
    tax: bracket.tax
  })), [
    { rate: 0, taxableIncome: 10000, tax: 0 },
    { rate: 0.15, taxableIncome: 10000, tax: 1500 }
  ]);
});

test("capital losses offset gains, then ordinary income, then carry forward", () => {
  const tax = computeIncomeTax({
    ordinaryIncome: 10000,
    longTermCapitalGains: 1000,
    capitalLosses: 6000,
    profile: { ...profile, state: { ...profile.state, brackets: [{ upTo: Infinity, rate: 0 }] } }
  });

  assert.equal(tax.taxablePreferentialIncome, 0);
  assert.equal(tax.ordinaryLossOffset, 3000);
  assert.equal(tax.lossCarryforward, 2000);
  assert.equal(tax.federalOrdinaryTax, 700);
});

test("short-term loss carryforward retains character (Schedule D / IRC §1212(b))", () => {
  // Year 1: $5000 ST loss with no gains → $3000 ordinary offset, $2000 ST
  // carryforward. Year 2: only a $1500 LT gain, no ST gains. The ST
  // carryforward must offset the LT gain (cross-character per Schedule D
  // line 14), then the remaining $500 ST loss offsets ordinary income.
  const yearOne = computeIncomeTax({
    ordinaryIncome: 50000,
    shortTermCapitalLosses: 5000,
    profile
  });
  assert.equal(yearOne.ordinaryLossOffset, 3000);
  assert.equal(yearOne.lossCarryforwardShort, 2000);
  assert.equal(yearOne.lossCarryforwardLong, 0);

  const yearTwo = computeIncomeTax({
    ordinaryIncome: 50000,
    longTermCapitalGains: 1500,
    capitalLossCarryforward: { shortTerm: yearOne.lossCarryforwardShort, longTerm: 0 },
    profile
  });
  assert.equal(yearTwo.taxableLongTermCapitalGains, 0);
  assert.equal(yearTwo.ordinaryLossOffset, 500);
  assert.equal(yearTwo.lossCarryforwardShort, 0);
  assert.equal(yearTwo.lossCarryforwardLong, 0);
});

test("long-term loss carryforward retains character", () => {
  // Year 1: $5000 LT loss, no gains → $3000 ordinary offset, $2000 LT
  // carryforward. Year 2: $1500 LT gain, no ST gains. The LT carryforward
  // offsets LT gain; remaining $500 still has LT character but offsets
  // ordinary income (after ST is exhausted).
  const yearOne = computeIncomeTax({
    ordinaryIncome: 50000,
    longTermCapitalLosses: 5000,
    profile
  });
  assert.equal(yearOne.ordinaryLossOffset, 3000);
  assert.equal(yearOne.lossCarryforwardShort, 0);
  assert.equal(yearOne.lossCarryforwardLong, 2000);

  const yearTwo = computeIncomeTax({
    ordinaryIncome: 50000,
    longTermCapitalGains: 1500,
    capitalLossCarryforward: { shortTerm: 0, longTerm: yearOne.lossCarryforwardLong },
    profile
  });
  assert.equal(yearTwo.taxableLongTermCapitalGains, 0);
  assert.equal(yearTwo.ordinaryLossOffset, 500);
  assert.equal(yearTwo.lossCarryforwardLong, 0);
});

test("state retirement exclusion uses full retirement income, not federal-loss-prorated", () => {
  // Bug repro: pre-fix, retirementOrdinaryIncome was multiplied by
  // (ordinaryAfterLossOffset / ordinaryBeforeLossOffset). When capital
  // losses reduced ordinary income, the state retirement-income exclusion
  // shrank with it, even though state law applies the exclusion to the
  // full retirement amount. Use a state with a "type: all" exclusion
  // (e.g., Illinois): with the fix the retirement portion is fully
  // excluded regardless of federal losses.
  const stateProfile = {
    ...profile,
    state: {
      standardDeduction: 0,
      brackets: [{ upTo: Infinity, rate: 0.05 }],
      treatCapitalGainsAsOrdinary: true,
      retirementRules: {
        retirementIncome: { type: "all" },
        socialSecurity: { type: "taxable" }
      }
    }
  };
  // Same ordinaryIncome (50000) which already includes retirement (20000);
  // with capital losses the retirement portion's exclusion eligibility
  // should not shrink.
  const withLoss = computeIncomeTax({
    ordinaryIncome: 50000,
    retirementOrdinaryIncome: 20000,
    capitalLosses: 4000,
    profile: stateProfile
  });
  const withoutLoss = computeIncomeTax({
    ordinaryIncome: 50000,
    retirementOrdinaryIncome: 20000,
    capitalLosses: 0,
    profile: stateProfile
  });
  // Federal ordinary tax DIFFERS (capital losses reduce ordinary by $3k).
  assert.notEqual(withLoss.federalOrdinaryTax, withoutLoss.federalOrdinaryTax);
  // State tax = 5% * (ordinaryAfterLossOffset - retirementExclusion).
  // The fix ensures retirement is fully excluded regardless of federal
  // loss offset, so the *delta* between the two scenarios reflects ONLY
  // the change in non-retirement ordinary income, NOT a prorated
  // shrinkage of the retirement exclusion.
  // Pre-fix, withLoss.stateTax would have been HIGHER than expected
  // because retirement exclusion was prorated down.
  // Post-fix, the state tax difference should equal exactly 5% of the $3k
  // ordinary loss offset = $150.
  const stateTaxDelta = Math.round((withoutLoss.stateTax - withLoss.stateTax) * 100) / 100;
  assert.equal(stateTaxDelta, 150);
});

test("state tax can apply a separate capital gains rate", () => {
  const tax = computeIncomeTax({
    ordinaryIncome: 10000,
    longTermCapitalGains: 10000,
    profile: {
      ...profile,
      state: {
        standardDeduction: 0,
        brackets: [{ upTo: Infinity, rate: 0.05 }],
        treatCapitalGainsAsOrdinary: false,
        capitalGainsRate: 0.03
      }
    }
  });

  assert.equal(tax.stateTax, 800);
});

test("2026 federal MFJ ordinary brackets and standard deduction are versioned", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida"
  });
  const tax = computeIncomeTax({
    ordinaryIncome: taxProfile.standardDeduction + 100800,
    profile: taxProfile
  });

  assert.equal(taxProfile.standardDeduction, 32200);
  assert.deepEqual(taxProfile.ordinaryBrackets.slice(0, 3), [
    { upTo: 24800, rate: 0.1 },
    { upTo: 100800, rate: 0.12 },
    { upTo: 211400, rate: 0.22 }
  ]);
  assert.equal(tax.federalOrdinaryTax, 11600);
});

test("2026 federal long-term capital gains use the MFJ zero-rate threshold", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida"
  });
  const zeroRate = computeIncomeTax({
    ordinaryIncome: taxProfile.standardDeduction,
    longTermCapitalGains: 98900,
    profile: taxProfile
  });
  const fifteenRate = computeIncomeTax({
    ordinaryIncome: taxProfile.standardDeduction,
    longTermCapitalGains: 99900,
    profile: taxProfile
  });

  assert.equal(zeroRate.federalPreferentialTax, 0);
  assert.equal(fifteenRate.federalPreferentialTax, 150);
});

test("2026 NIIT applies to the lesser of investment income or MAGI over the threshold", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida"
  });
  const tax = computeIncomeTax({
    ordinaryIncome: taxProfile.standardDeduction + 300000 + 20000,
    ordinaryInvestmentIncome: 20000,
    longTermCapitalGains: 50000,
    qualifiedDividends: 10000,
    profile: taxProfile
  });

  assert.equal(tax.niitTax, 3040);
});

test("2026 Additional Medicare Tax applies to wage and self-employment thresholds", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida"
  });
  const tax = computeIncomeTax({
    medicareWages: 300000,
    selfEmploymentIncome: 100000,
    rrtaCompensation: 260000,
    profile: taxProfile
  });

  assert.equal(tax.additionalMedicareWageBase, 50000);
  assert.equal(tax.additionalMedicareSelfEmploymentBase, 92350);
  assert.equal(tax.additionalMedicareRrtaBase, 10000);
  assert.equal(tax.additionalMedicareTax, 1371.15);
  assert.equal(tax.employeePayrollTax, 15789);
  assert.equal(tax.selfEmploymentTax, 2678.15);
  assert.equal(tax.selfEmploymentTaxDeduction, 1339.075);
  assert.equal(tax.socialSecurityWages, 184500);
  assert.equal(tax.totalTax, 19838.3);
});

test("2026 W-2 employee FICA uses Social Security wage base and Medicare wages", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida"
  });
  const tax = computeIncomeTax({
    medicareWages: 300000,
    profile: taxProfile
  });

  assert.equal(tax.socialSecurityWages, 184500);
  assert.equal(tax.employeeSocialSecurityTaxableWages, 184500);
  assert.equal(tax.employeeSocialSecurityTax, 11439);
  assert.equal(tax.employeeMedicareTax, 4350);
  assert.equal(tax.employeePayrollTax, 15789);
  assert.equal(tax.additionalMedicareTax, 450);
  assert.equal(tax.totalTax, 16239);
});

test("2026 self-employment tax uses Schedule SE net earnings, wage base, and half-tax deduction", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida"
  });
  const tax = computeIncomeTax({
    selfEmploymentIncome: 100000,
    profile: taxProfile
  });

  assert.equal(tax.selfEmploymentNetEarnings, 92350);
  assert.equal(tax.selfEmploymentSocialSecurityTaxableEarnings, 92350);
  assert.equal(tax.selfEmploymentSocialSecurityTax, 11451.4);
  assert.equal(tax.selfEmploymentMedicareTax, 2678.15);
  assert.equal(tax.selfEmploymentTax, 14129.55);
  assert.equal(tax.selfEmploymentTaxDeduction, 7064.775);
  assert.equal(tax.adjustmentsToIncome, 7064.775);
  assert.equal(tax.totalTax, 14129.55);
});

test("2026 self-employment Social Security tax coordinates with explicit W-2 Social Security wages", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida"
  });
  const tax = computeIncomeTax({
    selfEmploymentIncome: 100000,
    socialSecurityWages: 100000,
    profile: taxProfile
  });

  assert.equal(tax.selfEmploymentSocialSecurityWageBase, 184500);
  assert.equal(tax.selfEmploymentRemainingSocialSecurityWageBase, 84500);
  assert.equal(tax.selfEmploymentSocialSecurityTaxableEarnings, 84500);
  assert.equal(tax.selfEmploymentSocialSecurityTax, 10478);
  assert.equal(tax.selfEmploymentMedicareTax, 2678.15);
  assert.equal(tax.selfEmploymentTax, 13156.15);
});

test("2026 child tax credit reduces regular federal income tax after brackets", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qualifyingChildren: 2
  });
  const tax = computeIncomeTax({
    ordinaryIncome: taxProfile.standardDeduction + 50000,
    profile: taxProfile
  });

  assert.equal(tax.childTaxCredit, 4400);
  assert.equal(tax.federalIncomeTaxBeforeCredits, 5504);
  assert.equal(tax.nonrefundableChildTaxCredit, 4400);
  assert.equal(tax.additionalChildTaxCredit, 0);
  assert.equal(tax.federalCreditsUsed, 4400);
  assert.equal(tax.federalRefundableCredits, 0);
  assert.equal(tax.totalTax, 1104);
});

test("2026 Additional Child Tax Credit applies the common earned-income limit", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qualifyingChildren: 2
  });
  const tax = computeIncomeTax({
    ordinaryIncome: 20_000,
    medicareWages: 20_000,
    profile: taxProfile
  });

  assert.equal(tax.childTaxCredit, 4400);
  assert.equal(tax.nonrefundableChildTaxCredit, 0);
  assert.equal(tax.unusedChildTaxCredit, 4400);
  assert.equal(tax.earnedIncomeForRefundableCredits, 20_000);
  assert.equal(tax.additionalChildTaxCredit, 2625);
  assert.equal(tax.federalRefundableCredits, 2625);
  assert.equal(tax.employeePayrollTax, 1530);
  assert.equal(tax.netFederalIncomeTaxAfterRefundableCredits, -2625);
  assert.equal(tax.totalTax, -1095);
});

test("Additional Child Tax Credit is zero at the earned-income threshold", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qualifyingChildren: 1
  });
  const tax = computeIncomeTax({
    ordinaryIncome: 2500,
    medicareWages: 2500,
    profile: taxProfile
  });

  assert.equal(tax.earnedIncomeForRefundableCredits, 2500);
  assert.equal(tax.childTaxCreditBreakdown.earnedIncomeThreshold, 2500);
  assert.equal(tax.additionalChildTaxCredit, 0);
  assert.equal(tax.employeePayrollTax, 191.25);
  assert.equal(tax.totalTax, 191.25);
});

test("Additional Child Tax Credit uses self-employment income after half-SE-tax deduction", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qualifyingChildren: 1
  });
  const tax = computeIncomeTax({
    ordinaryIncome: 10_000,
    selfEmploymentIncome: 10_000,
    profile: taxProfile
  });

  assert.equal(tax.selfEmploymentTax, 1412.955);
  assert.equal(tax.selfEmploymentTaxDeduction, 706.4775);
  assert.equal(tax.earnedIncomeForRefundableCredits, 9293.5225);
  assert.equal(tax.additionalChildTaxCredit, 1019.028375);
  assert.equal(tax.totalTax, 393.926625);
});

test("additional federal deductions and credits are explicit tax-profile overrides", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    additionalDeduction: 10000,
    additionalCredits: 1000
  });
  const tax = computeIncomeTax({
    ordinaryIncome: taxProfile.standardDeduction + 20000,
    profile: taxProfile
  });

  assert.equal(tax.taxableOrdinaryIncome, 10000);
  assert.equal(tax.federalIncomeTaxBeforeCredits, 1000);
  assert.equal(tax.federalCreditsUsed, 1000);
  assert.equal(tax.additionalCreditsUsed, 1000);
  assert.equal(tax.totalTax, 0);
});

test("2026 AMT tripwire data and preference addbacks are source-versioned", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    amtPreferenceItems: 20_000
  });

  assert.equal(TAX_DATA_VERSION, "2026.9");
  assert.equal(taxProfile.amtPreferenceItems, 20_000);
  assert.equal(taxProfile.buildOptions.amtPreferenceItems, 20_000);
  assert.deepEqual(taxProfile.alternativeMinimumTax.exemption, {
    single: 90_100,
    marriedFilingJointly: 140_200,
    marriedFilingSeparately: 70_100,
    headOfHousehold: 90_100
  });
  assert.equal(taxProfile.alternativeMinimumTax.phaseoutThreshold.marriedFilingJointly, 1_000_000);
  assert.equal(taxProfile.alternativeMinimumTax.completePhaseout.marriedFilingJointly, 1_280_400);
  assert.equal(taxProfile.alternativeMinimumTax.rateThreshold.marriedFilingJointly, 244_500);
  assert.deepEqual(taxProfile.alternativeMinimumTax.rates, [0.26, 0.28]);
});

test("2026 QBI deduction applies below-threshold manual QBI without changing MAGI", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qbiSourceMode: "manual",
    qbiAmount: 50_000
  });
  const tax = computeIncomeTax({
    ordinaryIncome: taxProfile.standardDeduction + 100_000,
    profile: taxProfile
  });

  assert.equal(taxProfile.qualifiedBusinessIncome.sourceMode, "manual");
  assert.equal(tax.federalAgi, 132_200);
  assert.equal(tax.magi, 132_200);
  assert.equal(tax.taxableOrdinaryIncomeBeforeQbi, 100_000);
  assert.equal(tax.qbiDeduction, 10_000);
  assert.equal(tax.taxableOrdinaryIncome, 90_000);
  assert.equal(tax.federalIncomeTax, 10_304);
  assert.equal(tax.qbiDeductionBreakdown.threshold, 403_500);
  assert.equal(tax.qbiDeductionBreakdown.sourceMode, "manual");
});

test("2026 QBI deduction applies the active-QBI minimum when larger than the percentage deduction", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "single",
    state: "Florida",
    qbiSourceMode: "manual",
    qbiAmount: 1_000
  });
  const tax = computeIncomeTax({
    ordinaryIncome: taxProfile.standardDeduction + 5_000,
    profile: taxProfile
  });

  assert.equal(tax.qbiDeduction, 400);
  assert.equal(tax.taxableOrdinaryIncomeBeforeQbi, 5_000);
  assert.equal(tax.taxableOrdinaryIncome, 4_600);
  assert.equal(tax.qbiDeductionBreakdown.minimumDeductionApplied, true);
});

test("2026 QBI deduction phases in wage and UBIA limits and fully phases out SSTBs", () => {
  const noWageProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qbiSourceMode: "manual",
    qbiAmount: 100_000
  });
  const phased = computeIncomeTax({
    ordinaryIncome: noWageProfile.standardDeduction + 500_000,
    profile: noWageProfile
  });

  assert.equal(phased.qbiDeduction, 7_133.333333);
  assert.equal(phased.qbiDeductionBreakdown.qbiComponent, 20_000);
  assert.equal(phased.qbiDeductionBreakdown.wageLimit, 0);
  assert.equal(phased.qbiDeductionBreakdown.phaseRatio, 0.643333);

  const wagePropertyProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qbiSourceMode: "manual",
    qbiAmount: 100_000,
    qbiW2Wages: 60_000,
    qbiUbiaQualifiedProperty: 1_000_000
  });
  const wageLimited = computeIncomeTax({
    ordinaryIncome: wagePropertyProfile.standardDeduction + 600_000,
    profile: wagePropertyProfile
  });

  assert.equal(wageLimited.qbiDeduction, 20_000);
  assert.equal(wageLimited.qbiDeductionBreakdown.wageLimit, 40_000);

  const sstbProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qbiSourceMode: "manual",
    qbiAmount: 100_000,
    qbiSpecifiedServiceBusiness: true
  });
  const phasedOutSstb = computeIncomeTax({
    ordinaryIncome: sstbProfile.standardDeduction + 600_000,
    profile: sstbProfile
  });

  assert.equal(phasedOutSstb.qbiDeduction, 0);
  assert.equal(phasedOutSstb.qbiDeductionBreakdown.phaseRatio, 1);
  assert.equal(phasedOutSstb.qbiDeductionBreakdown.specifiedServiceBusiness, true);
});

test("2026 QBI deduction can derive qualified business income from self-employment income", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "single",
    state: "Florida",
    qbiSourceMode: "selfEmployment"
  });
  const tax = computeIncomeTax({
    ordinaryIncome: taxProfile.standardDeduction + 100_000,
    selfEmploymentIncome: 100_000,
    profile: taxProfile
  });

  assert.equal(tax.selfEmploymentTaxDeduction, 7_064.775);
  assert.equal(tax.taxableOrdinaryIncomeBeforeQbi, 92_935.225);
  assert.equal(tax.qbiDeductionBreakdown.qualifiedBusinessIncome, 92_935.225);
  assert.equal(tax.qbiDeduction, 18_587.045);
  assert.equal(tax.qbiDeductionBreakdown.sourceMode, "selfEmployment");
});

test("itemized deductions auto-select when they exceed the standard deduction", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    itemizedDeductionMode: "auto",
    itemizedStateLocalTaxes: 60_000,
    itemizedMortgageInterest: 10_000,
    itemizedCharitableContributions: 5_000,
    itemizedMedicalExpenses: 20_000
  });
  const tax = computeIncomeTax({
    ordinaryIncome: 200_000,
    profile: taxProfile
  });

  assert.equal(tax.federalDeductionKind, "itemized");
  assert.equal(tax.itemizedDeductionBreakdown.stateLocalTaxes, 40_400);
  assert.equal(tax.itemizedDeductionBreakdown.medicalExpenseFloor, 15_000);
  assert.equal(tax.itemizedDeductionBreakdown.medicalExpenses, 5_000);
  assert.equal(tax.itemizedDeduction, 60_400);
  assert.equal(tax.federalDeduction, 60_400);
  assert.equal(tax.taxableOrdinaryIncome, 139_600);
});

test("itemized deductions honor forced standard and forced itemized modes", () => {
  const autoProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "single",
    state: "Florida",
    itemizedDeductionMode: "auto",
    itemizedStateLocalTaxes: 2_000,
    itemizedMortgageInterest: 1_000
  });
  const auto = computeIncomeTax({ ordinaryIncome: 40_000, profile: autoProfile });
  assert.equal(auto.federalDeductionKind, "standard");
  assert.equal(auto.federalDeduction, 16_100);

  const forcedItemized = computeIncomeTax({
    ordinaryIncome: 40_000,
    profile: {
      ...autoProfile,
      itemizedDeductions: { ...autoProfile.itemizedDeductions, mode: "itemized" }
    }
  });
  assert.equal(forcedItemized.federalDeductionKind, "itemized");
  assert.equal(forcedItemized.federalDeduction, 3_000);

  const forcedStandardProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "single",
    state: "Florida",
    itemizedDeductionMode: "standard",
    itemizedStateLocalTaxes: 40_000,
    itemizedMortgageInterest: 20_000
  });
  const forcedStandard = computeIncomeTax({ ordinaryIncome: 80_000, profile: forcedStandardProfile });
  assert.equal(forcedStandard.federalDeductionKind, "standard");
  assert.equal(forcedStandard.federalDeduction, 16_100);
});

test("2026 SALT itemized cap phases down but not below the statutory floor", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    itemizedDeductionMode: "itemized",
    itemizedStateLocalTaxes: 80_000
  });

  const phased = computeIncomeTax({ ordinaryIncome: 600_000, profile: taxProfile });
  assert.equal(phased.itemizedDeductionBreakdown.stateLocalTaxLimit, 11_900);
  assert.equal(phased.itemizedDeductionBreakdown.stateLocalTaxes, 11_900);
  assert.equal(phased.federalDeduction, 11_900);

  const floor = computeIncomeTax({ ordinaryIncome: 700_000, profile: taxProfile });
  assert.equal(floor.itemizedDeductionBreakdown.stateLocalTaxLimit, 10_000);
  assert.equal(floor.itemizedDeductionBreakdown.stateLocalTaxes, 10_000);
  assert.equal(floor.federalDeduction, 10_000);
});

test("age-65 standard-deduction bump does not attach to itemized deductions", () => {
  const baseProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "single",
    state: "Florida",
    itemizedDeductionMode: "itemized",
    itemizedStateLocalTaxes: 30_000
  });
  const tax = computeIncomeTax({
    ordinaryIncome: 50_000,
    profile: {
      ...baseProfile,
      additionalDeduction: 2_050,
      age65AdditionalDeduction: 2_050
    }
  });

  assert.equal(tax.federalDeductionKind, "itemized");
  assert.equal(tax.standardDeductionWithAge65, 18_150);
  assert.equal(tax.additionalDeduction, 0);
  assert.equal(tax.federalDeduction, 30_000);
});

test("enhanced senior deduction applies per eligible person and phases out from MAGI", () => {
  const singleProfile = {
    ...buildTaxProfile({
      taxYear: 2026,
      filingStatus: "single",
      state: "Florida"
    }),
    enhancedSeniorDeductionEligibleCount: 1,
    enhancedSeniorDeductionTaxYear: 2026
  };

  const full = computeIncomeTax({
    ordinaryIncome: 75_000,
    profile: singleProfile
  });
  assert.equal(full.enhancedSeniorDeduction, 6_000);
  assert.equal(full.federalDeduction, singleProfile.standardDeduction + 6_000);

  const partial = computeIncomeTax({
    ordinaryIncome: 100_000,
    profile: singleProfile
  });
  assert.equal(partial.enhancedSeniorDeduction, 4_500);

  const phasedOut = computeIncomeTax({
    ordinaryIncome: 175_000,
    profile: singleProfile
  });
  assert.equal(phasedOut.enhancedSeniorDeduction, 0);

  const marriedProfile = {
    ...buildTaxProfile({
      taxYear: 2026,
      filingStatus: "marriedFilingJointly",
      state: "Florida"
    }),
    enhancedSeniorDeductionEligibleCount: 2,
    enhancedSeniorDeductionTaxYear: 2026
  };
  const married = computeIncomeTax({
    ordinaryIncome: 200_000,
    profile: marriedProfile
  });
  assert.equal(married.enhancedSeniorDeduction, 6_000);

  const separateProfile = {
    ...buildTaxProfile({
      taxYear: 2026,
      filingStatus: "marriedFilingSeparately",
      state: "Florida"
    }),
    enhancedSeniorDeductionEligibleCount: 1,
    enhancedSeniorDeductionTaxYear: 2026
  };
  assert.equal(computeIncomeTax({ ordinaryIncome: 50_000, profile: separateProfile }).enhancedSeniorDeduction, 0);

  const expiredProfile = {
    ...singleProfile,
    enhancedSeniorDeductionTaxYear: 2029
  };
  assert.equal(computeIncomeTax({ ordinaryIncome: 50_000, profile: expiredProfile }).enhancedSeniorDeduction, 0);
});

test("Social Security taxable benefits follow provisional-income tiers", () => {
  const taxable = computeTaxableSocialSecurityBenefits({
    benefits: 20000,
    otherIncome: 30000,
    filingStatus: "single",
    profile: buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Florida" })
  });

  assert.equal(taxable, 9600);
});

test("state tax can exclude retirement income and taxable Social Security", () => {
  const tax = computeIncomeTax({
    ordinaryIncome: 50000,
    retirementOrdinaryIncome: 30000,
    taxableSocialSecurity: 10000,
    profile: {
      ...profile,
      state: {
        standardDeduction: 0,
        personalExemption: 0,
        brackets: [{ upTo: Infinity, rate: 0.05 }],
        treatCapitalGainsAsOrdinary: true,
        retirementIncomeExclusion: 20000,
        socialSecurityTaxableRate: 0
      }
    }
  });

  assert.equal(tax.stateTax, 1000);
});

test("state retirement rules exclude Illinois retirement income by default", () => {
  const taxProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Illinois" });
  taxProfile.state.primaryAge = 65;
  const tax = computeIncomeTax({
    ordinaryIncome: 50000,
    retirementOrdinaryIncome: 50000,
    profile: taxProfile
  });

  assert.equal(tax.stateTax, 0);
});

test("state retirement rules apply age and income limited exclusions", () => {
  const newJersey = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "New Jersey" });
  newJersey.state.primaryAge = 62;
  newJersey.state.spouseAge = 62;
  const excluded = computeIncomeTax({
    ordinaryIncome: 100000,
    retirementOrdinaryIncome: 100000,
    profile: newJersey
  });

  const highIncomeProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "New Jersey" });
  highIncomeProfile.state.primaryAge = 62;
  highIncomeProfile.state.spouseAge = 62;
  const taxable = computeIncomeTax({
    ordinaryIncome: 200000,
    retirementOrdinaryIncome: 200000,
    profile: highIncomeProfile
  });

  assert.equal(excluded.stateTax, 0);
  assert.ok(taxable.stateTax > 0);
});

test("state Social Security rules distinguish exempt and taxable states", () => {
  const colorado = buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Colorado" });
  colorado.state.primaryAge = 65;
  const coloradoTax = computeIncomeTax({
    ordinaryIncome: 10000,
    taxableSocialSecurity: 10000,
    profile: colorado
  });

  const utah = buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Utah" });
  utah.state.primaryAge = 65;
  const utahTax = computeIncomeTax({
    ordinaryIncome: 10000,
    taxableSocialSecurity: 10000,
    profile: utah
  });

  assert.equal(coloradoTax.stateTax, 0);
  assert.ok(utahTax.stateTax > 0);
});

test("2026 state profile applies no-tax and progressive-tax states", () => {
  const florida = computeIncomeTax({
    ordinaryIncome: 250000,
    longTermCapitalGains: 50000,
    profile: buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Florida" })
  });
  const california = computeIncomeTax({
    ordinaryIncome: 100000,
    profile: buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "California" })
  });

  assert.equal(florida.stateTax, 0);
  assert.ok(california.stateTax > 5000);
  assert.ok(california.stateTax < 5300);
});

test("2026 state capital-gains special cases are represented", () => {
  const missouri = computeIncomeTax({
    longTermCapitalGains: 100000,
    profile: buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Missouri" })
  });
  const washington = computeIncomeTax({
    longTermCapitalGains: 300000,
    profile: buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Washington" })
  });

  assert.equal(missouri.stateTax, 0);
  assert.equal(washington.stateTax, 1540);
});

test("inflateTaxProfile scales standard deduction, child tax credit, and brackets", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    itemizedDeductionMode: "itemized",
    itemizedStateLocalTaxes: 10_000,
    itemizedMortgageInterest: 5_000,
    itemizedCharitableContributions: 2_000,
    itemizedMedicalExpenses: 1_000,
    qbiSourceMode: "manual",
    qbiAmount: 10_000,
    qbiW2Wages: 3_000,
    qbiUbiaQualifiedProperty: 20_000
  });
  taxProfile.childTaxCredit = {
    perChild: 2000,
    refundablePerChild: 1600,
    refundableEarnedIncomeThreshold: 2500
  };

  const inflated = inflateTaxProfile(taxProfile, 1.1);

  assert.equal(inflated.standardDeduction, 35420); // 32200 * 1.1
  assert.equal(inflated.childTaxCredit.perChild, 2200);
  assert.equal(inflated.childTaxCredit.refundablePerChild, 1760);
  // IRC §24(d)(1)(B)(i): the $2,500 ACTC earned-income threshold is statutory
  // and not inflation-indexed, so inflateTaxProfile must leave it unscaled.
  assert.equal(inflated.childTaxCredit.refundableEarnedIncomeThreshold, 2500);
  assert.equal(inflated.itemizedDeductions.stateLocalTaxes, 11_000);
  assert.equal(inflated.itemizedDeductions.mortgageInterest, 5_500);
  assert.equal(inflated.itemizedDeductions.charitableContributions, 2_200);
  assert.equal(inflated.itemizedDeductions.medicalExpenses, 1_100);
  assert.equal(inflated.itemizedDeductions.limits.salt.cap2025, 40_000);
  assert.equal(inflated.qualifiedBusinessIncomeDeduction.threshold.marriedFilingJointly, 443_850);
  assert.equal(inflated.qualifiedBusinessIncomeDeduction.phaseInEnd.marriedFilingJointly, 608_850);
  assert.equal(inflated.qualifiedBusinessIncomeDeduction.minimumDeduction, 440);
  assert.equal(inflated.qualifiedBusinessIncome.amount, 11_000);
  assert.equal(inflated.qualifiedBusinessIncome.w2Wages, 3_300);
  assert.equal(inflated.qualifiedBusinessIncome.ubiaQualifiedProperty, 20_000);
});
