// Golden tests for the heir taxation engine's Single-filer bracket resolution
// and valuation-year inflation indexing.
//
// Bugs fixed:
// 1. When the household tax profile was passed (as simulatePlan does),
//    estimateHeirValueBreakdown adopted the household's OWN bracket array and
//    standard deduction. For an MFJ household, the heir's documented
//    "Single-filer" 10-year-distribution tax was computed on MFJ bracket
//    widths and the $32,200 MFJ deduction — understating heir tax by ~28% on
//    a $1M IRA. Profiles built by buildTaxProfile (which carry buildOptions)
//    are now re-resolved as Single filers.
// 2. Heir brackets, the Single standard deduction, heir base income, and the
//    $15M federal estate exclusion (IRC §2010(c)(3)(B), indexed) were frozen
//    at 2026 nominal values while the portfolio being valued is in nominal
//    death-year dollars. They now scale with `inflationIndex`, which
//    simulatePlan passes as the last LIVING year's price level.
//
// Hand-derived golden (2026 Single, Rev. Proc. 2025-32):
//   $1,000,000 traditional IRA, nonSpouse10Yr, heir base income $80,000,
//   Single standard deduction $16,100 → base taxable $63,900.
//   Each of 10 years distributes $100,000 → total taxable $163,900.
//   tax($163,900) = 12,400×10% + 38,000×12% + 55,300×22% + 58,200×24%
//                 = 1,240 + 4,560 + 12,166 + 13,968 = $31,934
//   tax($63,900)  = 1,240 + 4,560 + 13,500×22% = $8,770
//   per-year drag = $23,164 → ×10 years = $231,640.

import assert from "node:assert/strict";
import test from "node:test";

import { estimateHeirValueBreakdown } from "../src/core/simulation/heirEstate.mjs?v=20260613-tips-coupon";
import { simulatePlan } from "../src/core/simulation.mjs?v=20260613-tips-coupon";
import { buildTaxProfile } from "../src/data/taxData.mjs";

const milIra = () => [
  { id: "ira", accountType: "traditional", assetClass: "stock", units: 1000, price: 1000, costBasisPerUnit: 100 }
];

const heirOptions = (extra = {}) => ({
  heirType: "nonSpouse10Yr",
  heirBaseIncome: 80000,
  heirAge: 30,
  ...extra
});

test("MFJ household profiles resolve to SINGLE heir brackets (hand-derived $231,640)", () => {
  const mfjProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" });
  const withProfile = estimateHeirValueBreakdown(milIra(), 0.24, heirOptions({ taxProfile: mfjProfile }));
  assert.equal(withProfile.traditionalIncomeTaxEstimate, 231640);

  // The statutory-default path (no profile) must agree exactly.
  const withoutProfile = estimateHeirValueBreakdown(milIra(), 0.24, heirOptions());
  assert.equal(withoutProfile.traditionalIncomeTaxEstimate, 231640);

  // Head-of-household profiles resolve to Single too.
  const hohProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "headOfHousehold", state: "Florida" });
  const withHoh = estimateHeirValueBreakdown(milIra(), 0.24, heirOptions({ taxProfile: hohProfile }));
  assert.equal(withHoh.traditionalIncomeTaxEstimate, 231640);
});

test("heir tax is homogeneous under inflation indexing (2x prices at index 2 → exactly 2x tax)", () => {
  const mfjProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" });
  const base = estimateHeirValueBreakdown(milIra(), 0.24, heirOptions({ taxProfile: mfjProfile }));
  const doubled = estimateHeirValueBreakdown(
    milIra().map((asset) => ({ ...asset, price: asset.price * 2 })),
    0.24,
    heirOptions({ taxProfile: mfjProfile, inflationIndex: 2 })
  );
  assert.equal(doubled.traditionalIncomeTaxEstimate, base.traditionalIncomeTaxEstimate * 2);
  assert.equal(doubled.heirTaxInflationIndex, 2);
});

test("eligible-designated stretch is also homogeneous under inflation indexing", () => {
  // The EDB life-expectancy stretch path shares the indexed brackets/deduction
  // with the 10-year path; doubling prices at index 2 must exactly double tax.
  const base = estimateHeirValueBreakdown(milIra(), 0.24, {
    heirType: "eligibleDesignated", heirBaseIncome: 80000, heirAge: 60
  });
  const doubled = estimateHeirValueBreakdown(
    milIra().map((asset) => ({ ...asset, price: asset.price * 2 })),
    0.24,
    { heirType: "eligibleDesignated", heirBaseIncome: 80000, heirAge: 60, inflationIndex: 2 }
  );
  assert.ok(
    Math.abs(doubled.traditionalIncomeTaxEstimate - base.traditionalIncomeTaxEstimate * 2) < 0.02,
    `${doubled.traditionalIncomeTaxEstimate} vs 2x ${base.traditionalIncomeTaxEstimate}`
  );
});

test("federal estate exclusion indexes with the valuation year", () => {
  const estate = [{ id: "roth", accountType: "roth", assetClass: "stock", units: 1, price: 20000000, costBasisPerUnit: 1 }];

  // 2026 price level: $20M − $15M exclusion → 40% × $5M = $2,000,000.
  const at2026 = estimateHeirValueBreakdown(estate, 0.24, { heirType: "nonSpouse10Yr" });
  assert.equal(at2026.federalEstateTax, 2000000);
  assert.equal(at2026.federalEstateExclusion, 15000000);

  // At a 1.4 price level the exclusion is $21M > $20M estate → no estate tax.
  const indexed = estimateHeirValueBreakdown(estate, 0.24, { heirType: "nonSpouse10Yr", inflationIndex: 1.4 });
  assert.equal(indexed.federalEstateTax, 0);
  assert.equal(indexed.federalEstateExclusion, 21000000);
});

test("hand-rolled fixture profiles without buildOptions keep the flat-rate path", () => {
  // A 1-element bracket array triggers the documented flat assumedOrdinaryTaxRate
  // path — test fixtures across the suite rely on this.
  const flatProfile = {
    filingStatus: "marriedFilingJointly",
    standardDeduction: 12000,
    ordinaryBrackets: [{ upTo: Infinity, rate: 0.1 }]
  };
  const flat = estimateHeirValueBreakdown(milIra(), 0.3, heirOptions({ taxProfile: flatProfile }));
  assert.equal(flat.traditionalIncomeTaxEstimate, 300000); // flat 30% of $1M
});

test("simulatePlan indexes heir taxes at the last LIVING year's price level", () => {
  const taxProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Florida" });
  const assets = [{ id: "cash", accountType: "roth", assetClass: "cash", units: 100000, price: 1, costBasisPerUnit: 1 }];

  // Alive through the whole plan: index compounds across planYears - 1 steps.
  const fullPlan = simulatePlan({
    assets,
    scenario: {
      planYears: 3,
      currentAge: 70,
      spouseAge: null,
      targetSpend: 1000,
      heirType: "nonSpouse10Yr",
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile,
    returnSequence: Array.from({ length: 3 }, () => ({ cash: 0 })),
    inflationSequence: [0.1, 0.1, 0.1]
  });
  assert.equal(fullPlan.heirValueBreakdown.heirTaxInflationIndex, Math.round(1.1 * 1.1 * 1e6) / 1e6);

  // Death mid-plan: the index freezes at the death year even though the plan
  // (and its inflation track) continues to planYears.
  const earlyDeath = simulatePlan({
    assets,
    scenario: {
      planYears: 6,
      currentAge: 80,
      spouseAge: null,
      primaryMortalityAge: 82,
      targetSpend: 1000,
      heirType: "nonSpouse10Yr",
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile,
    returnSequence: Array.from({ length: 6 }, () => ({ cash: 0 })),
    inflationSequence: Array.from({ length: 6 }, () => 0.1)
  });
  // Living years are indexes 0-2 (death at age 82 in year index 2); the last
  // living year's inflation index is 1.1^2 = 1.21.
  assert.equal(earlyDeath.heirValueBreakdown.heirTaxInflationIndex, 1.21);
});
