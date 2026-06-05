// Golden test: OBBBA enhanced senior deduction (2025-2028) under 2026 federal law.
//
// Primary sources:
//   - IRC §151(d)(5) "Temporary senior deduction," added by the One Big
//     Beautiful Bill Act, Pub. L. 119-21 §70103. $6,000 for each individual
//     who has attained age 65 before the close of the taxable year, available
//     2025-2028, disallowed for married-filing-separately.
//   - IRS Schedule 1-A (Form 1040) 2025, Part V (Enhanced Deduction for
//     Seniors), cited in `src/data/taxData.mjs`
//     FEDERAL_TAX_2026.enhancedSeniorDeduction.source.
//
// The phaseout is computed PER ELIGIBLE PERSON, exactly as the Schedule 1-A
// Part V worksheet lays it out:
//   Line 31  MAGI
//   Line 32  threshold ($75,000; $150,000 if MFJ)
//   Line 33  MAGI - threshold (excess, not below 0)
//   Line 34  line 33 × 6%
//   Line 35  $6,000 - line 34 (not below 0)        <- single per-person amount
//   Line 36a if taxpayer is 65+, enter line 35
//   Line 36b if MFJ and spouse is 65+, enter line 35
//   Line 37  line 36a + line 36b                   <- summed across spouses
//
// Because both 36a and 36b carry the SAME per-person line-35 amount, a couple
// where both spouses are 65+ reaches a $0 deduction at $250,000 MAGI (each
// $6,000 erased by 6% × $100,000), not $350,000. This is the distinguishing
// behavior the golden test pins down.
//
// The model under test is `computeIncomeTax` in `src/core/tax.mjs`, which
// reports the realized deduction as `enhancedSeniorDeduction`.

import assert from "node:assert/strict";
import test from "node:test";

import { computeIncomeTax } from "../src/core/tax.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

function seniorProfile({ filingStatus, eligibleCount, taxYear = 2026 }) {
  return {
    ...buildTaxProfile({ taxYear, filingStatus, state: "Florida" }),
    enhancedSeniorDeductionEligibleCount: eligibleCount,
    enhancedSeniorDeductionTaxYear: taxYear
  };
}

function seniorDeductionAt({ filingStatus, eligibleCount, magi, taxYear = 2026 }) {
  // Pure ordinary income with no losses or preferential income, so the
  // model's MAGI equals ordinaryIncome — the input to the Part V phaseout.
  return computeIncomeTax({
    ordinaryIncome: magi,
    profile: seniorProfile({ filingStatus, eligibleCount, taxYear })
  }).enhancedSeniorDeduction;
}

test("Schedule 1-A Part V: single senior gets the full $6,000 at the $75,000 threshold", () => {
  // Line 33 excess = $0, line 35 = $6,000, line 37 = $6,000.
  assert.equal(seniorDeductionAt({ filingStatus: "single", eligibleCount: 1, magi: 75000 }), 6000);
});

test("Schedule 1-A Part V: single senior phases out at 6% of MAGI over $75,000", () => {
  // MAGI $100,000 → excess $25,000 × 6% = $1,500 → $6,000 - $1,500 = $4,500.
  assert.equal(seniorDeductionAt({ filingStatus: "single", eligibleCount: 1, magi: 100000 }), 4500);
});

test("Schedule 1-A Part V: single senior fully phased out at $175,000 MAGI", () => {
  // Excess $100,000 × 6% = $6,000 → line 35 = $0.
  assert.equal(seniorDeductionAt({ filingStatus: "single", eligibleCount: 1, magi: 175000 }), 0);
});

test("Schedule 1-A Part V: two-senior couple subtracts the 6% reduction per person", () => {
  // MFJ both 65+, MAGI $220,000 (Doeren Mayhew worked example).
  //   Line 33 excess = $70,000; line 34 = 6% × $70,000 = $4,200.
  //   Line 35 = $6,000 - $4,200 = $1,800 (per person).
  //   Line 37 = $1,800 (36a) + $1,800 (36b) = $3,600.
  // NOT $12,000 - $4,200 = $7,800, which would be the aggregate reading.
  assert.equal(seniorDeductionAt({ filingStatus: "marriedFilingJointly", eligibleCount: 2, magi: 220000 }), 3600);
});

test("Schedule 1-A Part V: two-senior couple at $200,000 MAGI gets $3,000 each = $6,000", () => {
  // Excess $50,000 × 6% = $3,000; line 35 = $3,000; line 37 = $3,000 × 2.
  assert.equal(seniorDeductionAt({ filingStatus: "marriedFilingJointly", eligibleCount: 2, magi: 200000 }), 6000);
});

test("Schedule 1-A Part V: two-senior couple fully phased out at $250,000 MAGI", () => {
  // Excess $100,000 × 6% = $6,000 → line 35 = $0 → line 37 = $0.
  assert.equal(seniorDeductionAt({ filingStatus: "marriedFilingJointly", eligibleCount: 2, magi: 250000 }), 0);
});

test("IRC §151(d)(5): married-filing-separately is ineligible for the senior deduction", () => {
  assert.equal(seniorDeductionAt({ filingStatus: "marriedFilingSeparately", eligibleCount: 1, magi: 50000 }), 0);
});

test("Pub. L. 119-21 §70103: the senior deduction does not apply outside 2025-2028", () => {
  assert.equal(seniorDeductionAt({ filingStatus: "single", eligibleCount: 1, magi: 50000, taxYear: 2029 }), 0);
});
