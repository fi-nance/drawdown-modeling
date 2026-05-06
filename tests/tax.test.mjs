import assert from "node:assert/strict";
import test from "node:test";

import {
  computeIncomeTax,
  computeTaxableSocialSecurityBenefits,
  taxFromBrackets,
  inflateTaxProfile
} from "../src/core/tax.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

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
  assert.equal(tax.additionalMedicareSelfEmploymentBase, 100000);
  assert.equal(tax.additionalMedicareRrtaBase, 10000);
  assert.equal(tax.additionalMedicareTax, 1440);
  assert.equal(tax.totalTax, 1440);
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
  assert.equal(tax.federalCreditsUsed, 4400);
  assert.equal(tax.totalTax, 1104);
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
  assert.equal(tax.totalTax, 0);
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
    filingStatus: "marriedFilingJointly"
  });
  taxProfile.childTaxCredit = {
    perChild: 2000,
    refundablePerChild: 1600
  };

  const inflated = inflateTaxProfile(taxProfile, 1.1);

  assert.equal(inflated.standardDeduction, 35420); // 32200 * 1.1
  assert.equal(inflated.childTaxCredit.perChild, 2200);
  assert.equal(inflated.childTaxCredit.refundablePerChild, 1760);
});
