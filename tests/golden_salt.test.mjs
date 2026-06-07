// Golden test: OBBBA temporary state-and-local-tax (SALT) deduction limit
// under 2026 federal law and its 2030 reversion.
//
// Primary sources:
//   - One Big Beautiful Bill Act, Pub. L. 119-21, temporary SALT deduction
//     limitation: $40,000 cap for 2025, increased 1% per year through 2029,
//     phased down by 30% of MAGI over $500,000 (half for married-filing-
//     separately) but never below a $10,000 floor, reverting to a flat
//     $10,000 cap in 2030.
//   - IRS 2026 Form 1040-ES SALT correction and IRS Schedule A instructions,
//     cited in `src/data/taxData.mjs`
//     FEDERAL_TAX_2026.itemizedDeductions.salt.source.
//
// The model under test is `computeIncomeTax` in `src/core/tax.mjs`, which
// reports the realized SALT limit and deductible amount in
// `itemizedDeductionBreakdown`. The tax year that selects the temporary-cap
// vs. reverted regime is `itemizedDeductionTaxYear`, set per calendar year by
// the simulation (see `taxProfileForSimulationYear`), mirrored here.

import assert from "node:assert/strict";
import test from "node:test";

import { computeIncomeTax } from "../src/core/tax.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

function saltProfile({ saltPaid, itemizedDeductionTaxYear, filingStatus = "marriedFilingJointly" }) {
  return {
    ...buildTaxProfile({
      taxYear: 2026,
      filingStatus,
      state: "Florida",
      itemizedDeductionMode: "itemized",
      itemizedStateLocalTaxes: saltPaid
    }),
    itemizedDeductionTaxYear
  };
}

function saltDeductionAt({ ordinaryIncome, saltPaid, itemizedDeductionTaxYear = 2026, filingStatus = "marriedFilingJointly" }) {
  // Pure ordinary income with no losses or preferential income, so the
  // model's MAGI equals ordinaryIncome — the input to the SALT phasedown.
  const breakdown = computeIncomeTax({
    ordinaryIncome,
    profile: saltProfile({ saltPaid, itemizedDeductionTaxYear, filingStatus })
  }).itemizedDeductionBreakdown;
  return { limit: breakdown.stateLocalTaxLimit, deductible: breakdown.stateLocalTaxes };
}

test("2026 SALT cap is $40,400 ($40,000 base × 1.01) below the phasedown threshold", () => {
  // MAGI $300,000 < $505,000 phasedown threshold → no phasedown, full cap.
  const { limit, deductible } = saltDeductionAt({ ordinaryIncome: 300000, saltPaid: 50000 });
  assert.equal(limit, 40400);
  assert.equal(deductible, 40400);
});

test("SALT paid below the cap is deducted in full", () => {
  // $12,000 paid, well under the $40,400 cap → deduct the full $12,000.
  const { deductible } = saltDeductionAt({ ordinaryIncome: 200000, saltPaid: 12000 });
  assert.equal(deductible, 12000);
});

test("2026 SALT cap phases down 30% of MAGI over $505,000", () => {
  // MAGI $600,000 → excess $95,000 × 30% = $28,500 → $40,400 - $28,500 = $11,900.
  const { limit, deductible } = saltDeductionAt({ ordinaryIncome: 600000, saltPaid: 50000 });
  assert.equal(limit, 11900);
  assert.equal(deductible, 11900);
});

test("2026 SALT phasedown never drops below the $10,000 floor", () => {
  // MAGI $700,000 → excess $195,000 × 30% = $58,500 → $40,400 - $58,500 < 0,
  // floored at $10,000.
  const { limit } = saltDeductionAt({ ordinaryIncome: 700000, saltPaid: 50000 });
  assert.equal(limit, 10000);
});

test("the temporary cap grows 1% per year through 2029", () => {
  // 2029 cap = $40,000 × 1.01^4 = $41,624.16.
  const { limit } = saltDeductionAt({ ordinaryIncome: 300000, saltPaid: 60000, itemizedDeductionTaxYear: 2029 });
  assert.equal(limit, 41624.1604);
});

test("the SALT cap reverts to a flat $10,000 in 2030", () => {
  // Post-2029 reversion: cap is $10,000 regardless of MAGI.
  const { limit, deductible } = saltDeductionAt({ ordinaryIncome: 300000, saltPaid: 50000, itemizedDeductionTaxYear: 2030 });
  assert.equal(limit, 10000);
  assert.equal(deductible, 10000);
});

test("married-filing-separately uses half the SALT cap", () => {
  // 2026 MFS cap = $20,000 × 1.01 = $20,200 below the $250,000 MFS threshold.
  const { limit } = saltDeductionAt({ ordinaryIncome: 150000, saltPaid: 50000, filingStatus: "marriedFilingSeparately" });
  assert.equal(limit, 20200);
});
