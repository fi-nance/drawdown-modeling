import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDecisionEvidence,
  normalizeDecisionProfile,
  runDecisionBatch,
  scenarioWithDiscretionaryCut,
  scenarioWithIncomeBridge
} from "../src/core/decisionEngine.mjs";
import { DEFAULT_SCENARIO } from "../src/core/simulation.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

const cashAssets = [{
  id: "cash",
  name: "Cash",
  accountType: "taxable",
  assetClass: "cash",
  units: 1000000,
  price: 1,
  costBasisPerUnit: 1,
  dividendYield: 0,
  qualifiedDividendShare: 0
}];

test("decision evidence stays fragile when Monte Carlo and history disagree", () => {
  const verdict = classifyDecisionEvidence({
    monteCarloSuccessRate: 0.54,
    historicalSuccessRate: 1,
    historicalCount: 64,
    targetSuccessRate: 0.9
  });

  assert.equal(verdict.label, "fragile");
  assert.equal(verdict.monteCarloPasses, false);
  assert.equal(verdict.historicalPasses, true);
  assert.equal(verdict.combinedSuccessRate, 0.77);
});

test("decision profile derives required and flexible spending from scenario guardrails", () => {
  const profile = normalizeDecisionProfile({}, {
    ...DEFAULT_SCENARIO,
    targetSpend: 100000,
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      essentialSpend: 72000,
      discretionarySpend: 28000
    }
  });

  assert.equal(profile.targetSuccessRate, 0.9);
  assert.equal(profile.requiredSpend, 72000);
  assert.equal(profile.flexibleSpend, 28000);
  assert.equal(profile.evidenceWeights.monteCarlo, 0.5);
});

test("decision profile treats null spend fields as auto-from-strategy", () => {
  const profile = normalizeDecisionProfile({
    requiredSpend: null,
    flexibleSpend: null
  }, {
    ...DEFAULT_SCENARIO,
    targetSpend: 100000,
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      essentialSpend: 64000,
      discretionarySpend: 36000
    }
  });

  assert.equal(profile.requiredSpend, 64000);
  assert.equal(profile.flexibleSpend, 36000);
});

test("scenario transforms apply discretionary cuts and income bridges explicitly", () => {
  const cutScenario = scenarioWithDiscretionaryCut(DEFAULT_SCENARIO, {
    requiredSpend: 70000,
    flexibleSpend: 30000
  }, 15000);
  const incomeScenario = scenarioWithIncomeBridge(DEFAULT_SCENARIO, {
    annualIncome: 42000,
    durationYears: 3,
    incomeType: "medicareWages"
  });

  assert.equal(cutScenario.spendingStrategy.mode, "discretionaryGuardrails");
  assert.equal(cutScenario.spendingStrategy.essentialSpend, 70000);
  assert.equal(cutScenario.spendingStrategy.discretionarySpend, 30000);
  assert.equal(cutScenario.spendingStrategy.bearDiscretionaryPercent, 0.5);
  assert.equal(incomeScenario.oneOffExpenses.at(-1).amount, 42000);
  assert.equal(incomeScenario.oneOffExpenses.at(-1).endYear, 3);
});

test("decision batch returns base, income bridge, and combined rescue summaries", () => {
  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 3,
    currentAge: 44,
    spouseAge: 44,
    targetSpend: 600000,
    targetSpendIncludesTaxes: false,
    targetSpendIncludesMedical: true,
    medicalExpensesBase: 0,
    aca: { enabled: false },
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      mode: "fixed",
      essentialSpend: 500000,
      discretionarySpend: 100000
    },
    returnAssumptions: {
      ...DEFAULT_SCENARIO.returnAssumptions,
      cash: { mean: 0, stdev: 0 },
      inflation: { mean: 0, stdev: 0 }
    }
  };
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    dependentCount: 0
  });

  const decision = runDecisionBatch({
    assets: cashAssets,
    scenario,
    taxProfile,
    runs: 10,
    seed: 7,
    sequences: [],
    decisionProfile: {
      requiredSpend: 500000,
      flexibleSpend: 100000,
      targetSuccessRate: 1
    }
  });

  assert.equal(decision.status, "ready");
  assert.equal(decision.base.kind, "base");
  assert.ok(decision.rescueOptions.some((option) => option.kind === "incomeBridge"));
  assert.ok(decision.rescueOptions.some((option) => option.kind === "combined"));
  assert.equal(decision.verdict.historicalKnown, false);
});
