// Golden test: Section 199A qualified business income (QBI) deduction under
// 2026 federal law, including the OBBBA $400 minimum deduction.
//
// Primary sources:
//   - 26 USC §199A as amended by Pub. L. 119-21 (One Big Beautiful Bill Act):
//     20% deduction on QBI, limited to 20% of taxable income less net capital
//     gain; W-2 wage / UBIA limitation above the taxable-income threshold;
//     specified-service-trade-or-business (SSTB) phaseout; and the new minimum
//     deduction of $400 for taxpayers with at least $1,000 of QBI from an
//     active qualified trade or business.
//   - IRS Rev. Proc. 2025-32 §4.26 (2026 thresholds) and IRS Form 8995 /
//     8995-A instructions, cited in `src/data/taxData.mjs`
//     FEDERAL_TAX_2026.qualifiedBusinessIncomeDeduction.source.
//
// 2026 MFJ taxable-income threshold $403,500; phase-in completes at $553,500.
// The model under test is `computeIncomeTax` in `src/core/tax.mjs`, which
// reports the realized deduction as `qbiDeduction`.

import assert from "node:assert/strict";
import test from "node:test";

import { computeIncomeTax } from "../src/core/tax.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

function qbiProfile({ amount, specifiedServiceBusiness = false, w2Wages = 0 }) {
  return buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    qbiSourceMode: "manual",
    qbiAmount: amount,
    qbiSpecifiedServiceBusiness: specifiedServiceBusiness,
    qbiW2Wages: w2Wages
  });
}

function qbiDeductionAt(args) {
  return computeIncomeTax({
    ordinaryIncome: args.ordinaryIncome,
    profile: qbiProfile(args)
  }).qbiDeduction;
}

test("Form 8995: below the threshold the deduction is a flat 20% of QBI", () => {
  // MFJ ordinary $200,000 - $32,200 standard deduction = $167,800 taxable
  // ordinary income; 20% cap = $33,560 does not bind. 20% × $100,000 QBI.
  assert.equal(qbiDeductionAt({ ordinaryIncome: 200000, amount: 100000 }), 20000);
});

test("Form 8995: the 20%-of-taxable-income cap binds when income is low", () => {
  // Ordinary $60,000 - $32,200 = $27,800 taxable ordinary income.
  // 20% × $27,800 = $5,560 < 20% × $100,000 QBI = $20,000 → capped at $5,560.
  assert.equal(qbiDeductionAt({ ordinaryIncome: 60000, amount: 100000 }), 5560);
});

test("Pub. L. 119-21: $400 minimum applies to active QBI of at least $1,000", () => {
  // QBI $1,500 → 20% = $300, raised to the $400 statutory minimum.
  assert.equal(qbiDeductionAt({ ordinaryIncome: 50000, amount: 1500 }), 400);
});

test("Pub. L. 119-21: the $400 minimum does not apply below $1,000 of QBI", () => {
  // QBI $900 < $1,000 active-QBI floor → ordinary 20% × $900 = $180.
  assert.equal(qbiDeductionAt({ ordinaryIncome: 50000, amount: 900 }), 180);
});

test("Form 8995-A: above the phase-in, sufficient W-2 wages preserve the 20%", () => {
  // Taxable income > $553,500. 50% × $80,000 wages = $40,000 wage limit
  // ≥ 20% × $100,000 = $20,000 → full $20,000 allowed.
  assert.equal(qbiDeductionAt({ ordinaryIncome: 700000, amount: 100000, w2Wages: 80000 }), 20000);
});

test("Form 8995-A: a fully phased-in SSTB gets no QBI deduction", () => {
  // Taxable income > $553,500 with SSTB → applicable percentage 0 → $0,
  // and the $400 minimum does not rescue a fully phased-out SSTB.
  assert.equal(qbiDeductionAt({ ordinaryIncome: 700000, amount: 100000, w2Wages: 80000, specifiedServiceBusiness: true }), 0);
});
