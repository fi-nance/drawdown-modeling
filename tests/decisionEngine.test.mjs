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

const noTaxProfile = {
  filingStatus: "marriedFilingJointly",
  standardDeduction: 0,
  capitalLossOrdinaryIncomeOffset: 3000,
  ordinaryBrackets: [{ upTo: Infinity, rate: 0 }],
  capitalGainsBrackets: [{ upTo: Infinity, rate: 0 }],
  additionalMedicareTax: {
    rate: 0,
    thresholds: {
      single: Infinity,
      marriedFilingJointly: Infinity,
      marriedFilingSeparately: Infinity,
      headOfHousehold: Infinity
    }
  },
  state: {
    standardDeduction: 0,
    brackets: [{ upTo: Infinity, rate: 0 }],
    treatCapitalGainsAsOrdinary: true
  }
};

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
  assert.equal(cutScenario.spendingStrategy.correctionDiscretionaryPercent, 0.75);
  assert.equal(cutScenario.spendingStrategy.bearDiscretionaryPercent, 0.5);
  assert.equal(incomeScenario.oneOffExpenses.at(-1).amount, 42000);
  assert.equal(incomeScenario.oneOffExpenses.at(-1).endYear, 3);
});

test("full discretionary rescue cut matches the app guardrail shape", () => {
  const cutScenario = scenarioWithDiscretionaryCut(DEFAULT_SCENARIO, {
    requiredSpend: 70000,
    flexibleSpend: 30000
  }, 30000);

  assert.equal(cutScenario.spendingStrategy.correctionDrawdownThreshold, 0.1);
  assert.equal(cutScenario.spendingStrategy.bearDrawdownThreshold, 0.2);
  assert.equal(cutScenario.spendingStrategy.correctionDiscretionaryPercent, 0.5);
  assert.equal(cutScenario.spendingStrategy.bearDiscretionaryPercent, 0);
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

test("discretionary rescue status is based on finalized full-run evidence", () => {
  const spend = 60;
  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 8,
    currentAge: 60,
    spouseAge: 60,
    targetSpend: spend,
    targetSpendIncludesTaxes: true,
    targetSpendIncludesMedical: true,
    medicalExpensesBase: 0,
    withdrawalOrder: ["taxable"],
    withdrawalStrategy: { mode: "heuristic" },
    taxLossHarvesting: { enabled: false },
    taxGainHarvesting: { enabled: false },
    rothConversion: { enabled: false },
    aca: { enabled: false },
    returnAssumptions: {
      ...DEFAULT_SCENARIO.returnAssumptions,
      stock: { mean: 0.04, stdev: 0.08 },
      inflation: { mean: 0, stdev: 0 }
    },
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      mode: "fixed",
      essentialSpend: 42,
      discretionarySpend: 18
    }
  };

  const decision = runDecisionBatch({
    assets: [{
      id: "stock",
      name: "Stock",
      accountType: "taxable",
      assetClass: "stock",
      units: 500,
      price: 1,
      costBasisPerUnit: 1,
      dividendYield: 0,
      qualifiedDividendShare: 1
    }],
    scenario,
    taxProfile: noTaxProfile,
    runs: 60,
    seed: 2,
    sequences: [],
    decisionProfile: {
      requiredSpend: 42,
      flexibleSpend: 18,
      targetSuccessRate: 0.9,
      incomeBridge: { enabled: false }
    }
  });

  const cut = decision.rescueOptions.find((option) => option.kind === "discretionaryCut");
  assert.equal(cut.status, "best-tested");
  assert.equal(cut.monteCarlo.successRate, 0.8833);
});

test("discretionary rescue can be target-met when finalized run clears target after search miss", () => {
  const spend = 50;
  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 8,
    currentAge: 60,
    spouseAge: 60,
    targetSpend: spend,
    targetSpendIncludesTaxes: true,
    targetSpendIncludesMedical: true,
    medicalExpensesBase: 0,
    withdrawalOrder: ["taxable"],
    withdrawalStrategy: { mode: "heuristic" },
    taxLossHarvesting: { enabled: false },
    taxGainHarvesting: { enabled: false },
    rothConversion: { enabled: false },
    aca: { enabled: false },
    returnAssumptions: {
      ...DEFAULT_SCENARIO.returnAssumptions,
      stock: { mean: 0.04, stdev: 0.08 },
      inflation: { mean: 0, stdev: 0 }
    },
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      mode: "fixed",
      essentialSpend: 35,
      discretionarySpend: 15
    }
  };

  const decision = runDecisionBatch({
    assets: [{
      id: "stock",
      name: "Stock",
      accountType: "taxable",
      assetClass: "stock",
      units: 400,
      price: 1,
      costBasisPerUnit: 1,
      dividendYield: 0,
      qualifiedDividendShare: 1
    }],
    scenario,
    taxProfile: noTaxProfile,
    runs: 60,
    seed: 25,
    sequences: [],
    decisionProfile: {
      requiredSpend: 35,
      flexibleSpend: 15,
      targetSuccessRate: 0.9,
      incomeBridge: { enabled: false }
    }
  });

  const cut = decision.rescueOptions.find((option) => option.kind === "discretionaryCut");
  assert.equal(cut.status, "target-met");
  assert.equal(cut.monteCarlo.successRate, 0.9);
  assert.equal(cut.metadata.cutAmount, 15);
});
