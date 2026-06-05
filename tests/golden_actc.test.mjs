// Golden test: 2026 Child Tax Credit and refundable Additional Child Tax
// Credit (ACTC) under current federal law.
//
// Primary sources:
//   - IRC §24 (Child Tax Credit), as amended by the One Big Beautiful Bill
//     Act, Pub. L. 119-21: $2,200 per qualifying child, of which up to $1,700
//     is refundable as the Additional Child Tax Credit; $400,000 MFJ /
//     $200,000 other phaseout thresholds, reduced $50 per $1,000 (or part) of
//     MAGI over the threshold.
//   - IRS Schedule 8812 instructions (refundable ACTC earned-income formula):
//     the refundable portion is limited to 15% of earned income over $2,500,
//     capped at $1,700 per qualifying child. Cited in
//     `src/data/taxData.mjs` FEDERAL_TAX_2026.childTaxCredit.source.
//
// The model under test is `computeIncomeTax` in `src/core/tax.mjs`. It
// applies the nonrefundable credit against tax first, then sizes the
// refundable ACTC from the unused credit, the per-child refundable cap, and
// the earned-income limit.

import assert from "node:assert/strict";
import test from "node:test";

import { computeIncomeTax } from "../src/core/tax.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

function mfjProfile(qualifyingChildren) {
  return buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qualifyingChildren
  });
}

test("IRC §24: 2026 CTC is $2,200/child and reduces regular tax before refundability", () => {
  // 2 children → $4,400 gross credit, income well below the $400,000 MFJ
  // phaseout, ample tax to absorb it nonrefundably.
  const profile = mfjProfile(2);
  const tax = computeIncomeTax({
    ordinaryIncome: profile.standardDeduction + 50000,
    profile
  });

  assert.equal(tax.childTaxCredit, 4400);
  assert.equal(tax.nonrefundableChildTaxCredit, 4400);
  assert.equal(tax.additionalChildTaxCredit, 0);
  assert.equal(tax.federalRefundableCredits, 0);
});

test("Schedule 8812: refundable ACTC is limited to 15% of earned income over $2,500", () => {
  // 2 children, $20,000 wages, no income tax due (below the standard
  // deduction). Earned-income limit = 15% × ($20,000 − $2,500) = $2,625,
  // which binds below both the $4,400 unused credit and the
  // 2 × $1,700 = $3,400 per-child refundable cap.
  const tax = computeIncomeTax({
    ordinaryIncome: 20_000,
    medicareWages: 20_000,
    profile: mfjProfile(2)
  });

  assert.equal(tax.childTaxCredit, 4400);
  assert.equal(tax.nonrefundableChildTaxCredit, 0);
  assert.equal(tax.unusedChildTaxCredit, 4400);
  assert.equal(tax.earnedIncomeForRefundableCredits, 20_000);
  assert.equal(tax.additionalChildTaxCredit, 2625);
  assert.equal(tax.federalRefundableCredits, 2625);
  // The refundable credit drives net federal income tax below zero.
  assert.equal(tax.netFederalIncomeTaxAfterRefundableCredits, -2625);
});

test("Schedule 8812: no refundable ACTC at the $2,500 earned-income threshold", () => {
  // Earned income exactly at $2,500 → 15% × $0 = $0 refundable.
  const tax = computeIncomeTax({
    ordinaryIncome: 2500,
    medicareWages: 2500,
    profile: mfjProfile(1)
  });

  assert.equal(tax.earnedIncomeForRefundableCredits, 2500);
  assert.equal(tax.childTaxCreditBreakdown.earnedIncomeThreshold, 2500);
  assert.equal(tax.additionalChildTaxCredit, 0);
});

test("Schedule 8812: ACTC earned income uses self-employment net of half the SE tax", () => {
  // $10,000 of self-employment income, 1 child. Earned income for the ACTC
  // is SE income minus the deductible half of SE tax.
  const tax = computeIncomeTax({
    ordinaryIncome: 10_000,
    selfEmploymentIncome: 10_000,
    profile: mfjProfile(1)
  });

  assert.equal(tax.selfEmploymentTaxDeduction, 706.4775);
  assert.equal(tax.earnedIncomeForRefundableCredits, 9293.5225);
  // 15% × ($9,293.5225 − $2,500) = $1,019.028375, capped below $1,700.
  assert.equal(tax.additionalChildTaxCredit, 1019.028375);
});

test("IRC §24: CTC phases out $50 per $1,000 of MAGI over the $400,000 MFJ threshold", () => {
  // 2 children, MAGI $450,000. Excess $50,000 → 50 increments × $50 = $2,500
  // reduction → $4,400 − $2,500 = $1,900 allowable credit.
  const profile = mfjProfile(2);
  const tax = computeIncomeTax({
    ordinaryIncome: 450_000,
    profile
  });

  assert.equal(tax.childTaxCredit, 1900);
});
