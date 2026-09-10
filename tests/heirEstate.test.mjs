// Inheritance tax follows decedent domicile, not heir income-tax residence.
// PA DOR: resident intangible property is in scope irrespective of heir state.
// Nebraska 77-2004: 1% above $100,000 per qualifying heir; under-22 heirs exempt.

import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateHeirValueBreakdown,
  inheritanceTaxStateForScenario
} from "../src/core/simulation/heirEstate.mjs";

// ---------------------------------------------------------------------------
// inheritanceTaxStateForScenario — priority / fallback unit tests
// ---------------------------------------------------------------------------

test("inheritanceTaxStateForScenario: legacy heir residence does not create tax nexus", () => {
  assert.equal(inheritanceTaxStateForScenario({ heirState: "PA" }), undefined);
  assert.equal(inheritanceTaxStateForScenario({ heirState: "NE" }), undefined);
});

test("inheritanceTaxStateForScenario: unset heir residence does not override profile fallback", () => {
  assert.equal(inheritanceTaxStateForScenario({ heirState: null }), undefined);
  assert.equal(inheritanceTaxStateForScenario({ heirState: "" }), undefined);
  assert.equal(inheritanceTaxStateForScenario({ heirState: 0 }), undefined);
});

test("inheritanceTaxStateForScenario: decedent state takes priority over heir residence", () => {
  assert.equal(inheritanceTaxStateForScenario({ heirState: "PA", state: "MA" }), "MA");
  assert.equal(inheritanceTaxStateForScenario({ heirState: "NE", state: "PA" }), "PA");
});

test("inheritanceTaxStateForScenario: null heir residence cannot erase decedent tax", () => {
  assert.equal(inheritanceTaxStateForScenario({ heirState: null, state: "PA" }), "PA");
  assert.equal(inheritanceTaxStateForScenario({ heirState: "", state: "NE" }), "NE");
});

test("inheritanceTaxStateForScenario: no heirState falls back to state", () => {
  assert.equal(inheritanceTaxStateForScenario({ state: "PA" }), "PA");
  assert.equal(inheritanceTaxStateForScenario({ state: "NE" }), "NE");
  assert.equal(inheritanceTaxStateForScenario({ state: "Florida" }), "FL");
});

test("inheritanceTaxStateForScenario: no heirState, state null returns null", () => {
  assert.equal(inheritanceTaxStateForScenario({ state: null }), null);
});

test("inheritanceTaxStateForScenario: no heirState, state undefined returns null", () => {
  // undefined ?? null → null, so an explicit state: undefined is null not undefined.
  assert.equal(inheritanceTaxStateForScenario({ state: undefined }), null);
});

test("inheritanceTaxStateForScenario: neither key returns undefined", () => {
  assert.equal(inheritanceTaxStateForScenario({}), undefined);
  assert.equal(inheritanceTaxStateForScenario({ planYears: 30 }), undefined);
});

test("inheritanceTaxStateForScenario: default argument (no args) returns undefined", () => {
  assert.equal(inheritanceTaxStateForScenario(), undefined);
});

test("inheritanceTaxStateForScenario: null scenario returns undefined", () => {
  // null is treated as the {} default via the ?? guard inside the function.
  assert.equal(inheritanceTaxStateForScenario(null), undefined);
});

// ---------------------------------------------------------------------------
// estimateHeirValueBreakdown — state resolution and inheritance tax amounts
// ---------------------------------------------------------------------------

// Simple roth portfolio: no income tax, no federal estate tax (under $15M),
// only state inheritance tax is in play.
function rothPortfolio(units = 1_000_000) {
  return [{ id: "roth", accountType: "roth", assetClass: "cash", units, price: 1, costBasisPerUnit: 1 }];
}

const NON_SPOUSE_OPTS = { heirType: "nonSpouse10Yr" };

test("PA inheritance tax applies at 4.5% on non-spouse roth value", () => {
  const b = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { ...NON_SPOUSE_OPTS, state: "PA" });
  assert.equal(b.stateInheritanceTax, 45_000);
  assert.equal(b.afterTaxValue, 955_000);
});

test("NE inheritance tax applies at 1% after the qualifying heir exemption", () => {
  const b = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { ...NON_SPOUSE_OPTS, state: "NE" });
  assert.equal(b.stateInheritanceTax, 9_000);
  assert.equal(b.afterTaxValue, 991_000);
});

test("state codes are matched case-insensitively", () => {
  const lower = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { ...NON_SPOUSE_OPTS, state: "pa" });
  const upper = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { ...NON_SPOUSE_OPTS, state: "PA" });
  assert.equal(lower.stateInheritanceTax, upper.stateInheritanceTax);
  assert.equal(lower.stateInheritanceTax, 45_000);
});

test("unknown state code produces zero inheritance tax", () => {
  const b = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { ...NON_SPOUSE_OPTS, state: "Florida" });
  assert.equal(b.stateInheritanceTax, 0);
});

test("state: null in opts suppresses inheritance tax even when taxProfile has a state", () => {
  const taxProfile = { state: { state: "PA" } };
  const b = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { ...NON_SPOUSE_OPTS, state: null, taxProfile });
  // Explicit null in opts means no inheritance-tax state — taxProfile is not consulted.
  assert.equal(b.stateInheritanceTax, 0);
});

test("state: undefined in opts suppresses inheritance tax (falsy explicit property)", () => {
  const taxProfile = { state: { state: "PA" } };
  const b = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { ...NON_SPOUSE_OPTS, state: undefined, taxProfile });
  assert.equal(b.stateInheritanceTax, 0);
});

test("no state in opts falls back to taxProfile.state.state", () => {
  const taxProfile = { state: { state: "PA" } };
  const b = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { ...NON_SPOUSE_OPTS, taxProfile });
  assert.equal(b.stateInheritanceTax, 45_000);
});

test("no state in opts and no taxProfile produces zero inheritance tax", () => {
  const b = estimateHeirValueBreakdown(rothPortfolio(), 0.24, NON_SPOUSE_OPTS);
  assert.equal(b.stateInheritanceTax, 0);
});

test("spouse heir type is exempt from state inheritance tax in all inheritance-tax states", () => {
  const spouseB = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { heirType: "spouse", state: "PA" });
  assert.equal(spouseB.stateInheritanceTax, 0);
  assert.equal(spouseB.spouseRolloverValue, 0); // roth spouse rollover is 0 (roth passes differently)
  assert.equal(spouseB.afterTaxValue, 1_000_000);
});

test("eligible-designated heir in PA is taxed at 4.5%", () => {
  const b = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { heirType: "eligibleDesignated", state: "PA" });
  assert.equal(b.stateInheritanceTax, 45_000);
});

test("mixed beneficiary: spouse portion exempt, non-spouse portion taxed at PA rate", () => {
  const assets = [
    { id: "spouse-roth", accountType: "roth", assetClass: "cash", units: 600_000, price: 1, costBasisPerUnit: 1, beneficiaryType: "spouse" },
    { id: "child-roth", accountType: "roth", assetClass: "cash", units: 400_000, price: 1, costBasisPerUnit: 1, beneficiaryType: "nonSpouse10Yr" }
  ];
  const b = estimateHeirValueBreakdown(assets, 0.24, { heirType: "nonSpouse10Yr", state: "PA" });
  // Only $400k is non-spouse, 4.5% × 400k = 18k
  assert.equal(b.stateInheritanceTax, 18_000);
  assert.equal(b.grossValue, 1_000_000);
  assert.equal(b.afterTaxValue, 982_000);
});

test("federal estate tax does not apply below the $15M exclusion", () => {
  const b = estimateHeirValueBreakdown(rothPortfolio(14_000_000), 0.24, NON_SPOUSE_OPTS);
  assert.equal(b.federalEstateTax, 0);
});

test("federal estate tax applies at 40% on the portion above $15M", () => {
  const b = estimateHeirValueBreakdown(rothPortfolio(16_000_000), 0.24, NON_SPOUSE_OPTS);
  // $16M - $15M exclusion = $1M × 40% = $400k
  assert.equal(b.federalEstateTax, 400_000);
});

test("grossValue, afterTaxValue, and stateInheritanceTax are round-tripped consistently", () => {
  const b = estimateHeirValueBreakdown(rothPortfolio(100_000), 0.24, { ...NON_SPOUSE_OPTS, state: "NE" });
  // The $100k transfer is fully exempt.
  assert.equal(b.stateInheritanceTax, 0);
  assert.equal(b.grossValue, 100_000);
  assert.equal(b.afterTaxValue, 100_000);
  assert.equal(b.totalIncomeTaxEstimate, 0); // roth has no income tax
  assert.equal(b.federalEstateTax, 0); // under $15M
});

test("NE exemption aggregates lots per beneficiary, not per account", () => {
  const assets = [
    { ...rothPortfolio(100000)[0], beneficiaryId: "child-a" },
    { ...rothPortfolio(100000)[0], beneficiaryId: "child-a" },
    { ...rothPortfolio(100000)[0], beneficiaryId: "child-b" }
  ];
  const result = estimateHeirValueBreakdown(assets, .24, { ...NON_SPOUSE_OPTS, state: "ne" });
  assert.equal(result.stateInheritanceTax, 1000);
  assert.equal(result.inheritanceBeneficiaryCount, 2);
});

test("NE qualifying heirs under 22 are exempt; age 22 receives the ordinary exemption", () => {
  for (const [heirAge, expected] of [[0, 0], [21, 0], [22, 9000]]) {
    const result = estimateHeirValueBreakdown(rothPortfolio(), .24, { ...NON_SPOUSE_OPTS, state: "NE", heirAge });
    assert.equal(result.stateInheritanceTax, expected);
  }
});

test("inheritance states accept full names and an explicit decedent-nexus override", () => {
  assert.equal(inheritanceTaxStateForScenario({ state: "pennsylvania" }), "PA");
  assert.equal(inheritanceTaxStateForScenario({ state: "Florida", inheritanceTaxState: "Nebraska" }), "NE");
  assert.equal(estimateHeirValueBreakdown(rothPortfolio(), .24,
    { ...NON_SPOUSE_OPTS, taxProfile: { state: { state: "Pennsylvania" } } }).stateInheritanceTax, 45000);
});
