// Unit tests for inheritanceTaxStateForScenario and the state-resolution logic
// inside estimateHeirValueBreakdown. These cover the priority rules introduced
// to isolate the heir's state of residence from the household's state:
//
//   heirState (own property) → authoritative for inheritance tax state
//   state (own property, no heirState) → fallback
//   neither key present → undefined (caller falls back to taxProfile.state.state)

import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateHeirValueBreakdown,
  inheritanceTaxStateForScenario
} from "../src/core/simulation/heirEstate.mjs";

// ---------------------------------------------------------------------------
// inheritanceTaxStateForScenario — priority / fallback unit tests
// ---------------------------------------------------------------------------

test("inheritanceTaxStateForScenario: heirState present and truthy returns heirState", () => {
  assert.equal(inheritanceTaxStateForScenario({ heirState: "PA" }), "PA");
  assert.equal(inheritanceTaxStateForScenario({ heirState: "NE" }), "NE");
});

test("inheritanceTaxStateForScenario: heirState present but falsy returns null", () => {
  assert.equal(inheritanceTaxStateForScenario({ heirState: null }), null);
  assert.equal(inheritanceTaxStateForScenario({ heirState: "" }), null);
  assert.equal(inheritanceTaxStateForScenario({ heirState: 0 }), null);
});

test("inheritanceTaxStateForScenario: heirState takes priority over state when both present", () => {
  assert.equal(inheritanceTaxStateForScenario({ heirState: "PA", state: "MA" }), "PA");
  assert.equal(inheritanceTaxStateForScenario({ heirState: "NE", state: "PA" }), "NE");
});

test("inheritanceTaxStateForScenario: heirState null beats a truthy state", () => {
  // Explicit heirState: null means the heir is in a non-inheritance-tax state,
  // and should not inherit the household state.
  assert.equal(inheritanceTaxStateForScenario({ heirState: null, state: "PA" }), null);
  assert.equal(inheritanceTaxStateForScenario({ heirState: "", state: "NE" }), null);
});

test("inheritanceTaxStateForScenario: no heirState falls back to state", () => {
  assert.equal(inheritanceTaxStateForScenario({ state: "PA" }), "PA");
  assert.equal(inheritanceTaxStateForScenario({ state: "NE" }), "NE");
  assert.equal(inheritanceTaxStateForScenario({ state: "Florida" }), "Florida");
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

test("NE inheritance tax applies at 1% on non-spouse roth value", () => {
  const b = estimateHeirValueBreakdown(rothPortfolio(), 0.24, { ...NON_SPOUSE_OPTS, state: "NE" });
  assert.equal(b.stateInheritanceTax, 10_000);
  assert.equal(b.afterTaxValue, 990_000);
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
  // NE: 1% × 100k = 1k
  assert.equal(b.stateInheritanceTax, 1_000);
  assert.equal(b.grossValue, 100_000);
  assert.equal(b.afterTaxValue, 99_000);
  assert.equal(b.totalIncomeTaxEstimate, 0); // roth has no income tax
  assert.equal(b.federalEstateTax, 0); // under $15M
});
