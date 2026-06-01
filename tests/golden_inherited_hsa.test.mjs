// Golden test: inherited HSA taxation by beneficiary type.
//
// Primary source:
//   - IRS Publication 969, "Death of HSA Holder":
//     https://www.irs.gov/publications/p969
//     Cited in `docs/DATA_SOURCES.md` for `estimateHeirValueBreakdown` /
//     `asset.beneficiaryType`.
//
//     Worked rule from Pub 969:
//       * "Spouse is the designated beneficiary" — the HSA is treated as the
//         surviving spouse's own HSA after death. No amount is included in the
//         spouse's income; it stays tax-deferred (a rollover).
//       * "Spouse isn't the designated beneficiary" — the account stops being
//         an HSA as of the date of death, and its fair market value becomes
//         taxable to the beneficiary in the year the owner dies (a one-time
//         ordinary-income inclusion, not a stretch).
//
// The model under test is `estimateHeirValueBreakdown` in
// `src/core/simulation/heirEstate.mjs`, exercised here through the public
// `simulatePlan` facade. The after-tax bequest surfaces inherited-HSA tax via
// `plan.heirValueBreakdown.hsaIncomeTaxEstimate` and `spouseRolloverValue`.
//
// Worked example (deterministic, no growth, no spending, no state inheritance
// tax, estate well under the $15M federal exclusion):
//   HSA fair market value at death = $50,000
//   Heir ordinary tax rate         = 24%
//     Spouse beneficiary    -> $0 income tax, $50,000 rolled over tax-deferred.
//     Non-spouse beneficiary -> full $50,000 FMV taxed in the death year:
//                               $50,000 * 24% = $12,000.

import assert from "node:assert/strict";
import test from "node:test";

import { simulatePlan } from "../src/core/simulation.mjs";

// Zero-tax owner-lifetime profile so the only tax surfaced by the run is the
// heir-level inherited-account tax we are isolating. A single ordinary bracket
// keeps the heir tax at the flat heirOrdinaryTaxRate, matching the Pub 969
// "FMV becomes taxable" inclusion at a known rate.
const noTaxProfile = {
  filingStatus: "marriedFilingJointly",
  standardDeduction: 0,
  capitalLossOrdinaryIncomeOffset: 3000,
  ordinaryBrackets: [{ upTo: Infinity, rate: 0 }],
  capitalGainsBrackets: [{ upTo: Infinity, rate: 0 }],
  state: {
    standardDeduction: 0,
    brackets: [{ upTo: Infinity, rate: 0 }],
    treatCapitalGainsAsOrdinary: true
  }
};

function hsaBequestPlan({ beneficiaryType, heirType, units = 50000 }) {
  return simulatePlan({
    assets: [
      {
        id: "hsa-cash",
        accountType: "hsa",
        assetClass: "cash",
        units,
        price: 1,
        costBasisPerUnit: 1,
        ...(beneficiaryType ? { beneficiaryType } : {})
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.24,
      heirType,
      rmd: { enabled: false },
      rothConversion: { enabled: false },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      aca: { enabled: false },
      returnAssumptions: { cash: { mean: 0, stdev: 0 } }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
}

test("Pub 969: spouse HSA beneficiary rolls the HSA over tax-deferred (no death-year income tax)", () => {
  const plan = hsaBequestPlan({ heirType: "spouse" });
  const b = plan.heirValueBreakdown;

  assert.equal(b.hsaValue, 50000);
  assert.equal(b.hsaIncomeTaxEstimate, 0);
  assert.equal(b.totalIncomeTaxEstimate, 0);
  assert.equal(b.spouseRolloverValue, 50000);
  // Full FMV survives to the heir: no income, estate, or inheritance tax.
  assert.equal(b.afterTaxValue, 50000);
});

test("Pub 969: non-spouse HSA beneficiary includes full FMV in income in the death year", () => {
  const plan = hsaBequestPlan({ heirType: "nonSpouse10Yr" });
  const b = plan.heirValueBreakdown;

  assert.equal(b.hsaValue, 50000);
  // $50,000 FMV * 24% heir ordinary rate, taxed once in the year of death.
  assert.equal(b.hsaIncomeTaxEstimate, 12000);
  assert.equal(b.totalIncomeTaxEstimate, 12000);
  assert.equal(b.spouseRolloverValue, 0);
  assert.equal(b.afterTaxValue, 38000);
});

test("Pub 969: eligible-designated HSA beneficiary is still fully taxed in the death year (no HSA stretch)", () => {
  // The IRA 10-year / stretch timing rules do not apply to an HSA — Pub 969 is
  // a single death-year FMV inclusion regardless of the non-spouse subtype.
  const plan = hsaBequestPlan({ heirType: "eligibleDesignated" });
  const b = plan.heirValueBreakdown;

  assert.equal(b.hsaIncomeTaxEstimate, 12000);
  assert.equal(b.spouseRolloverValue, 0);
  assert.equal(b.afterTaxValue, 38000);
});

test("Pub 969: per-account beneficiary split taxes only the non-spouse HSA, rolls over the spouse HSA", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "spouse-hsa",
        accountType: "hsa",
        assetClass: "cash",
        units: 25000,
        price: 1,
        costBasisPerUnit: 1,
        beneficiaryType: "spouse"
      },
      {
        id: "child-hsa",
        accountType: "hsa",
        assetClass: "cash",
        units: 25000,
        price: 1,
        costBasisPerUnit: 1,
        beneficiaryType: "nonSpouse10Yr"
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.24,
      heirType: "spouse",
      rmd: { enabled: false },
      rothConversion: { enabled: false },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      aca: { enabled: false },
      returnAssumptions: { cash: { mean: 0, stdev: 0 } }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  const b = plan.heirValueBreakdown;

  // Only the $25,000 child HSA is taxed: $25,000 * 24% = $6,000. The spouse's
  // $25,000 HSA rolls over tax-deferred.
  assert.equal(b.hsaValue, 50000);
  assert.equal(b.hsaIncomeTaxEstimate, 6000);
  assert.equal(b.spouseRolloverValue, 25000);
  assert.equal(b.perAccountBeneficiaryOverrideCount, 1);
  assert.equal(b.afterTaxValue, 44000);
});
