import assert from "node:assert/strict";
import test from "node:test";

import { simulatePlan, DEFAULT_SCENARIO, runMonteCarlo } from "../src/core/simulation.mjs";
import { findHouseholdBreakpoints, runDecisionBatch } from "../src/core/decisionEngine.mjs";

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

test("two-stream inflation scales healthcare costs and general costs by separate indexes", () => {
  const assets = [{
    id: "taxable",
    name: "Taxable",
    accountType: "taxable",
    assetClass: "cash",
    units: 1_000_000,
    price: 1,
    costBasisPerUnit: 1
  }];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 3,
    medicalExpensesBase: 10000,
    targetSpend: 50000,
    targetSpendIncludesMedical: false,
    targetSpendIncludesTaxes: true,
    aca: { enabled: false }
  };

  const plan = simulatePlan({
    assets,
    scenario,
    taxProfile: noTaxProfile,
    returnSequence: [{}, {}, {}],
    inflationSequence: [0, 0, 0],
    medicalInflationSequence: [0.05, 0.05, 0.05]
  });

  // Year 0: medicalCost is 10000 (medicalInflationIndex is 1.0)
  // Year 1: medicalCost is 10000 * 1.05 = 10500 (medicalInflationIndex is 1.05)
  // Year 2: medicalCost is 10000 * 1.1025 = 11025 (medicalInflationIndex is 1.1025)
  assert.equal(plan.years[0].medicalCost, 10000);
  assert.equal(plan.years[1].medicalCost, 10500);
  assert.equal(plan.years[2].medicalCost, 11025);
});

test("Guyton-Klinger spending strategy enforces the inflation-skip rule on negative equity returns", () => {
  const assets = [{
    id: "taxable",
    name: "Taxable",
    accountType: "taxable",
    assetClass: "stock",
    units: 1_000_000,
    price: 1,
    costBasisPerUnit: 1
  }];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 3,
    targetSpend: 50000,
    spendingStrategy: {
      mode: "guytonKlinger"
    },
    aca: { enabled: false }
  };

  // Year 0 stock return is negative (-0.1), so Year 1 inflation-adjustment should be skipped.
  // Year 1 stock return is positive (+0.1), so Year 2 inflation-adjustment should be applied.
  const plan = simulatePlan({
    assets,
    scenario,
    taxProfile: noTaxProfile,
    returnSequence: [
      { stock: -0.1 },
      { stock: 0.1 },
      { stock: 0 }
    ],
    inflationSequence: [0.03, 0.03, 0.03],
    medicalInflationSequence: [0.03, 0.03, 0.03]
  });

  // Year 0: base plannedSpending = 50000
  // Year 1: prior year stock return was negative, so we skip inflation-adjustment -> spend is 50000
  // Year 2: prior year stock return was positive, so we apply Year 1 inflation (3%) -> 50000 * 1.03 = 51500
  assert.equal(plan.years[0].plannedSpending, 50000);
  assert.equal(plan.years[1].plannedSpending, 50000);
  assert.equal(plan.years[2].plannedSpending, 51500);
});

test("Kitces Ratcheting strategy increases spend when portfolio value exceeds 1.5x high-water mark", () => {
  const assets = [{
    id: "taxable",
    name: "Taxable",
    accountType: "taxable",
    assetClass: "stock",
    units: 100_000,
    price: 1,
    costBasisPerUnit: 1
  }];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 3,
    targetSpend: 5000,
    spendingStrategy: {
      mode: "kitces"
    },
    aca: { enabled: false }
  };

  // Year 0 stock return is huge (+100%), raising the portfolio value from 100k to 200k (exceeding 1.5x high-water mark of 100k).
  // Year 1 inflation is 0%, so spend increases by 10% ratchet -> 5000 * 1.1 = 5500.
  const plan = simulatePlan({
    assets,
    scenario,
    taxProfile: noTaxProfile,
    returnSequence: [
      { stock: 1.0 },
      { stock: 0 },
      { stock: 0 }
    ],
    inflationSequence: [0, 0, 0]
  });

  assert.equal(plan.years[0].plannedSpending, 5000);
  assert.equal(plan.years[1].plannedSpending, 5500);
});

test("VPW strategy calculates spend based on remaining plan horizon and expected real returns", () => {
  const assets = [{
    id: "taxable",
    name: "Taxable",
    accountType: "taxable",
    assetClass: "stock",
    units: 100_000,
    price: 1,
    costBasisPerUnit: 1
  }];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 3,
    spendingStrategy: {
      mode: "vpw"
    },
    returnAssumptions: {
      stock: { mean: 0.08, stdev: 0.15 },
      inflation: { mean: 0.03, stdev: 0.01 }
    },
    aca: { enabled: false }
  };

  const plan = simulatePlan({
    assets,
    scenario,
    taxProfile: noTaxProfile,
    returnSequence: [
      { stock: 0 },
      { stock: 0 },
      { stock: 0 }
    ],
    inflationSequence: [0, 0, 0]
  });

  // Expected real return r = 0.08 - 0.03 = 0.05
  // Horizon N = 3
  // PMT factor p = 0.05 / (1 - (1.05)^-3) = 0.3672085
  // Spend in Year 0 = 100,000 * 0.3672085 = 36720.85 (or rounded)
  assert.ok(plan.years[0].plannedSpending > 35000);
  assert.ok(plan.years[0].plannedSpending < 38000);
});

test("customizing general inflation does not collapse an explicit medical-inflation stream", () => {
  // Regression: mergeScenario used to silently overwrite medical inflation with
  // general inflation whenever general was customized, defeating two-stream
  // inflation. With zero volatility the indices are deterministic, so medical
  // costs must compound at the explicit 6% medical mean, not the 3% general mean.
  const assets = [{
    id: "taxable", name: "Taxable", accountType: "taxable", assetClass: "cash",
    units: 5_000_000, price: 1, costBasisPerUnit: 1
  }];
  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 3,
    targetSpend: 50000,
    targetSpendIncludesMedical: false,
    targetSpendIncludesTaxes: true,
    medicalExpensesBase: 10000,
    aca: { enabled: false },
    returnAssumptions: {
      ...DEFAULT_SCENARIO.returnAssumptions,
      cash: { mean: 0, stdev: 0 },
      inflation: { mean: 0.03, stdev: 0 },          // customized general
      medicalInflation: { mean: 0.06, stdev: 0 }    // explicit, higher medical
    }
  };
  const result = runMonteCarlo({ assets, scenario, taxProfile: noTaxProfile, runs: 1, seed: 7 });
  const years = result.scenarios[0].years;
  // Year 2 medical index = 1.06^2 = 1.1236 → 10000 * 1.1236 = 11236.
  // If medical had collapsed to general (3%), this would be 10000 * 1.0609 = 10609.
  assert.equal(years[2].medicalCost, 11236);
});

test("failed Monte Carlo runs populate structured outflow-composition metadata", () => {
  const assets = [{
    id: "taxable",
    name: "Taxable",
    accountType: "taxable",
    assetClass: "cash",
    units: 100_000,
    price: 1,
    costBasisPerUnit: 1
  }];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 10,
    targetSpend: 20000,
    targetSpendIncludesTaxes: false,
    targetSpendIncludesMedical: false,
    medicalExpensesBase: 2000,
    aca: { enabled: false }
  };

  const result = runMonteCarlo({
    assets,
    scenario,
    taxProfile: {
      ...noTaxProfile,
      ordinaryBrackets: [{ upTo: Infinity, rate: 0.1 }] // Flat 10% ordinary tax
    },
    runs: 5,
    seed: 123
  });

  // Since targetSpend is 20k/yr and we only have 100k cash, it will deplete/fail.
  const failed = result.scenarios.find(s => !s.success);
  if (failed) {
    assert.ok(failed.diagnostics);
    const oc = failed.diagnostics.outflowComposition;
    assert.ok(oc);
    assert.equal(oc.basis, "lifetime-outflow-share");
    assert.ok(Number.isFinite(oc.tax.total));
    assert.ok(Number.isFinite(oc.healthcare.total));
    assert.ok(Number.isFinite(oc.spending.total));
    assert.ok(oc.tax.percent >= 0 && oc.tax.percent <= 1);
    assert.ok(oc.healthcare.percent >= 0 && oc.healthcare.percent <= 1);
    assert.ok(oc.spending.percent >= 0 && oc.spending.percent <= 1);
    assert.ok(Array.isArray(oc.tax.actions));
  }
});

test("findHouseholdBreakpoints computes boundary thresholds where success rate drops", () => {
  const assets = [{
    id: "taxable",
    name: "Taxable",
    accountType: "taxable",
    assetClass: "stock",
    units: 1_000_000,
    price: 1,
    costBasisPerUnit: 1
  }];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 30,
    targetSpend: 40000,
    spendingStrategy: { mode: "fixed" },
    returnAssumptions: {
      stock: { mean: 0.08, stdev: 0.15 },
      bond: { mean: 0.04, stdev: 0.06 },
      cash: { mean: 0.02, stdev: 0.01 },
      realEstate: { mean: 0.06, stdev: 0.10 },
      tips: { mean: 0.03, stdev: 0.04 },
      crypto: { mean: 0.12, stdev: 0.50 },
      inflation: { mean: 0.03, stdev: 0.01 },
      medicalInflation: { mean: 0.048, stdev: 0.02 }
    },
    aca: { enabled: false }
  };

  const profile = {
    requiredSpend: 30000,
    flexibleSpend: 10000,
    targetSuccessRate: 0.90,
    incomeBridge: { enabled: false }
  };

  const base = {
    monteCarlo: { successRate: 0.95 }
  };

  const bp = findHouseholdBreakpoints({
    assets,
    scenario,
    taxProfile: noTaxProfile,
    runs: 50,
    seed: 123,
    sequences: [],
    profile,
    base
  });

  assert.ok(bp);
  assert.ok(Object.prototype.hasOwnProperty.call(bp, "returnBreakpoint"));
  assert.ok(Object.prototype.hasOwnProperty.call(bp, "spendingBreakpoint"));
  assert.ok(Object.prototype.hasOwnProperty.call(bp, "inflationBreakpoint"));
});

test("runDecisionBatch evaluates switching to Guyton-Klinger or VPW as spending-guardrail rescues", () => {
  const assets = [{
    id: "taxable",
    name: "Taxable",
    accountType: "taxable",
    assetClass: "stock",
    units: 1_000_000,
    price: 1,
    costBasisPerUnit: 1
  }];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 30,
    targetSpend: 50000,
    spendingStrategy: {
      mode: "fixed",
      essentialSpend: 40000,
      discretionarySpend: 10000
    },
    aca: { enabled: false }
  };

  const profile = {
    requiredSpend: 40000,
    flexibleSpend: 10000,
    targetSuccessRate: 0.90,
    incomeBridge: { enabled: false }
  };

  const decision = runDecisionBatch({
    assets,
    scenario,
    taxProfile: noTaxProfile,
    runs: 10,
    seed: 123,
    sequences: [],
    decisionProfile: profile
  });

  const gk = decision.rescueOptions.find(o => o.kind === "guytonKlingerRescue");
  const vpw = decision.rescueOptions.find(o => o.kind === "vpwRescue");

  assert.ok(gk, "expected Guyton-Klinger rescue option to be evaluated");
  assert.ok(vpw, "expected VPW rescue option to be evaluated");
  assert.equal(gk.metadata.strategyMode, "guytonKlinger");
  assert.equal(vpw.metadata.strategyMode, "vpw");
});
