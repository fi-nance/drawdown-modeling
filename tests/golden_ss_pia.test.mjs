// Golden test: opt-in Social Security earnings-to-PIA estimate.
//
// Primary source:
//   - SSA Primary Insurance Amount formula for 2026:
//     https://www.ssa.gov/oact/cola/piaformula.html
//   - SSA 2026 benefit examples:
//     https://www.ssa.gov/OACT/COLA/Benefits.html
//
// The app is not a full SSA earnings-history calculator. These tests only lock
// the source-versioned 2026 PIA formula used by the explicit single-year proxy.

import assert from "node:assert/strict";
import test from "node:test";

import { simulatePlan, DEFAULT_SCENARIO } from "../src/core/simulation.mjs";
import { FEDERAL_TAX_2026, buildTaxProfile } from "../src/data/taxData.mjs";

const assets = [
  {
    id: "taxable-cash",
    name: "Taxable Cash",
    accountType: "taxable",
    assetClass: "cash",
    units: 500_000,
    price: 1,
    costBasisPerUnit: 1
  }
];

function oneYearBenefitForWages(medicareWages) {
  const plan = simulatePlan({
    assets,
    scenario: {
      ...DEFAULT_SCENARIO,
      planYears: 1,
      currentAge: 67,
      socialSecurityStartAge: 67,
      socialSecurityAnnualBenefit: 0,
      estimateSocialSecurityFromEarnings: true,
      medicareWages,
      targetSpend: 50000,
      aca: { enabled: false }
    },
    taxProfile: buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" }),
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  return plan.years[0].socialSecurityBenefits;
}

test("2026 SSA PIA formula data is source-versioned", () => {
  assert.deepEqual(FEDERAL_TAX_2026.socialSecurityPiaFormula.bendPoints, [1286, 7749]);
  assert.deepEqual(FEDERAL_TAX_2026.socialSecurityPiaFormula.rates, [0.9, 0.32, 0.15]);
  assert.equal(FEDERAL_TAX_2026.socialSecurityPiaFormula.socialSecurityWageBase, 184500);
  assert.match(FEDERAL_TAX_2026.socialSecurityPiaFormula.source, /SSA 2026/);
});

test("earnings-to-PIA proxy uses 2026 bend points and SSA dime rounding", () => {
  // AIME = $120,000 / 12 = $10,000.
  // Monthly PIA = .90*1286 + .32*(7749-1286) + .15*(10000-7749)
  //             = $3,563.21, rounded down to $3,563.20.
  assert.equal(oneYearBenefitForWages(120000), 42758.4);
});

test("earnings-to-PIA proxy caps wages at the 2026 Social Security wage base", () => {
  // AIME = $184,500 / 12 = $15,375 after the wage-base cap.
  // Monthly PIA = $4,369.46, rounded down to $4,369.40.
  assert.equal(oneYearBenefitForWages(300000), 52432.8);
});
