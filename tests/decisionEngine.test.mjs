import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDecisionEvidence,
  normalizeDecisionProfile,
  runDecisionBatch,
  scenarioWithAllocationTarget,
  scenarioWithConversionGuardrails,
  scenarioWithDiscretionaryCut,
  scenarioWithFlatSpend,
  scenarioWithIncomeBridge,
  scenarioWithIrmaaLookbackGuardrails,
  scenarioWithMagiDiscipline,
  scenarioWithMagiSpendTrim,
  scenarioWithRothBasisCliffRescue,
  scenarioWithSequenceReserve,
  scenarioWithSocialSecurityBridge,
  scenarioWithTaxableLotRescue
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

function cliffAcaConfig() {
  return {
    enabled: true,
    fpl: 20000,
    benchmarkPremium: 60000,
    selectedPlanPremium: 60000,
    applicablePercentageTable: [
      { minFplPercent: 0, maxFplPercent: 400, initialRate: 0, finalRate: 0 }
    ],
    requiredContributionPercentage: 0.1,
    maxEligibleFplPercent: 400,
    minEligibleFplPercent: 0
  };
}

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

test("decision batch omits the income bridge and combined rescues when the household opts out", () => {
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
      targetSuccessRate: 1,
      incomeBridge: { enabled: false }
    }
  });

  assert.equal(decision.status, "ready");
  assert.ok(decision.rescueOptions.every((option) => option.kind !== "incomeBridge"));
  assert.ok(decision.rescueOptions.every((option) => option.kind !== "combined"));
  // The failure diagnosis must not push a return to work the household ruled out.
  assert.ok(!decision.diagnosis.reason.includes("income bridge"));
});

test("decision batch surfaces Roth basis cliff rescue when it preserves ACA subsidy", () => {
  const scenario = {
    ...DEFAULT_SCENARIO,
    startYear: 2026,
    planYears: 1,
    currentAge: 50,
    rothBasis: 0,
    targetSpend: 81000,
    targetSpendIncludesTaxes: true,
    targetSpendIncludesMedical: true,
    withdrawalOrder: ["traditional", "roth"],
    withdrawalStrategy: { mode: "heuristic" },
    rothBasisOptimization: { enabled: false },
    earlyWithdrawalPenaltyRate: 0,
    taxLossHarvesting: { enabled: false },
    taxGainHarvesting: { enabled: false },
    rothConversion: { enabled: false },
    aca: cliffAcaConfig(),
    returnAssumptions: { ...DEFAULT_SCENARIO.returnAssumptions, cash: { mean: 0, stdev: 0 }, inflation: { mean: 0, stdev: 0 } }
  };

  const decision = runDecisionBatch({
    assets: [{
      id: "traditional",
      accountType: "traditional",
      assetClass: "cash",
      units: 100000,
      price: 1,
      costBasisPerUnit: 1
    }, {
      id: "seasoned-conversion",
      accountType: "roth",
      assetClass: "cash",
      units: 10000,
      price: 1,
      costBasisPerUnit: 1,
      rothSource: "conversion",
      conversionYear: 2020
    }],
    scenario,
    taxProfile: noTaxProfile,
    runs: 10,
    seed: 1,
    sequences: [],
    decisionProfile: { requiredSpend: 81000, flexibleSpend: 0, targetSuccessRate: 1, incomeBridge: { enabled: false } }
  });

  const rescue = decision.rescueOptions.find((option) => option.kind === "rothBasisCliffRescue");
  assert.ok(rescue);
  assert.equal(rescue.delta.firstYearSubsidy, 60000);
  assert.equal(rescue.planFirstYear.magi, 79000);
});

test("decision batch surfaces conversion guardrails when manual conversions cross ACA cliffs", () => {
  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 1,
    currentAge: 50,
    targetSpend: 0,
    targetSpendIncludesTaxes: true,
    targetSpendIncludesMedical: true,
    medicareWages: 70000,
    earnedIncomeInflationAdjusted: false,
    withdrawalOrder: ["traditional"],
    withdrawalStrategy: { mode: "lifetime" },
    taxLossHarvesting: { enabled: false },
    taxGainHarvesting: { enabled: false },
    rothConversion: { enabled: true, annualAmount: 50000 },
    aca: cliffAcaConfig(),
    returnAssumptions: { ...DEFAULT_SCENARIO.returnAssumptions, cash: { mean: 0, stdev: 0 }, inflation: { mean: 0, stdev: 0 } }
  };

  const decision = runDecisionBatch({
    assets: [{
      id: "traditional",
      accountType: "traditional",
      assetClass: "cash",
      units: 100000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario,
    taxProfile: noTaxProfile,
    runs: 10,
    seed: 1,
    sequences: [],
    decisionProfile: { requiredSpend: 0, flexibleSpend: 0, targetSuccessRate: 1, incomeBridge: { enabled: false } }
  });

  const rescue = decision.rescueOptions.find((option) => option.kind === "conversionGuardrail");
  assert.ok(rescue);
  assert.equal(rescue.delta.firstYearSubsidy, 60000);
  assert.equal(rescue.planFirstYear.rothConversionAmount, 9000);
});

test("decision batch surfaces MAGI spend trim when a small flexible cut protects ACA", () => {
  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 1,
    currentAge: 50,
    targetSpend: 81000,
    targetSpendIncludesTaxes: true,
    targetSpendIncludesMedical: true,
    withdrawalOrder: ["traditional"],
    withdrawalStrategy: { mode: "lifetime" },
    taxLossHarvesting: { enabled: false },
    taxGainHarvesting: { enabled: false },
    rothConversion: { enabled: false },
    aca: cliffAcaConfig(),
    returnAssumptions: { ...DEFAULT_SCENARIO.returnAssumptions, cash: { mean: 0, stdev: 0 }, inflation: { mean: 0, stdev: 0 } }
  };

  const decision = runDecisionBatch({
    assets: [{
      id: "traditional",
      accountType: "traditional",
      assetClass: "cash",
      units: 100000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario,
    taxProfile: noTaxProfile,
    runs: 10,
    seed: 1,
    sequences: [],
    decisionProfile: { requiredSpend: 79000, flexibleSpend: 2000, targetSuccessRate: 1, incomeBridge: { enabled: false } }
  });

  const rescue = decision.rescueOptions.find((option) => option.kind === "magiSpendTrim");
  assert.ok(rescue);
  assert.equal(rescue.metadata.trimAmount, 2000);
  assert.equal(rescue.delta.firstYearSubsidy, 60000);
});

test("discretionary rescue falls back to the full cut when the searched cut misses on finalized runs", () => {
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
    monteCarlo: { ...DEFAULT_SCENARIO.monteCarlo, samplingMode: "independent" },
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
  // The bounded search picks a partial cut that looks sufficient on
  // search-run noise; finalized full-run evidence shows it misses the
  // target, so the engine reports the full flexible-spend cut instead.
  assert.equal(cut.status, "target-met");
  assert.equal(cut.monteCarlo.successRate, 1);
  assert.equal(cut.metadata.cutAmount, 18);
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
    monteCarlo: { ...DEFAULT_SCENARIO.monteCarlo, samplingMode: "independent" },
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

test("income bridge default cap is a modest amount", () => {
  const profile = normalizeDecisionProfile({}, DEFAULT_SCENARIO);
  assert.equal(profile.incomeBridge.maxAnnualIncome, 150000);
});

test("safe spending transform forces fixed mode with the given total", () => {
  const flat = scenarioWithFlatSpend({
    ...DEFAULT_SCENARIO,
    spendingStrategy: { ...DEFAULT_SCENARIO.spendingStrategy, mode: "discretionaryGuardrails" }
  }, 72000);

  assert.equal(flat.targetSpend, 72000);
  assert.equal(flat.spendingStrategy.mode, "fixed");
});

test("sequence reserve transform enables the reserve with the requested mode", () => {
  const withReserve = scenarioWithSequenceReserve(DEFAULT_SCENARIO, { mode: "hybrid", targetYears: 4 });

  assert.equal(withReserve.sequenceRiskReserve.enabled, true);
  assert.equal(withReserve.sequenceRiskReserve.mode, "hybrid");
  assert.equal(withReserve.sequenceRiskReserve.targetYears, 4);
});

test("allocation transform enables rebalancing toward the target stock percent", () => {
  const shifted = scenarioWithAllocationTarget(DEFAULT_SCENARIO, 55);

  assert.equal(shifted.allocationStrategy.rebalanceEnabled, true);
  assert.equal(shifted.allocationStrategy.glidepathEnabled, false);
  assert.equal(shifted.allocationStrategy.targetStockPercent, 55);
});

test("MAGI discipline transform makes Roth conversions ACA-aware", () => {
  const disciplined = scenarioWithMagiDiscipline(DEFAULT_SCENARIO, {
    maxAcaFplPercent: 250,
    disableGainHarvesting: true
  });

  assert.equal(disciplined.rothConversion.optimizeForAca, true);
  assert.equal(disciplined.rothConversion.maxAcaFplPercent, 250);
  assert.equal(disciplined.taxGainHarvesting.enabled, false);
});

test("Roth basis cliff rescue enables dynamic basis substitution with a MAGI buffer", () => {
  const rescued = scenarioWithRothBasisCliffRescue({
    ...DEFAULT_SCENARIO,
    withdrawalOrder: ["traditional"],
    rothBasisOptimization: { enabled: false, minSavingsRate: 0.4 }
  }, {
    maxAcaFplPercent: 400,
    magiBuffer: 1500
  });

  assert.equal(rescued.withdrawalStrategy.mode, "lifetime");
  assert.deepEqual(rescued.withdrawalOrder, ["traditional", "roth"]);
  assert.equal(rescued.rothBasisOptimization.enabled, true);
  assert.equal(rescued.rothBasisOptimization.opportunityCostMode, "dynamic");
  assert.equal(rescued.rothBasisOptimization.magiBuffer, 1500);
  assert.equal(rescued.rothConversion.magiBuffer, 1500);
});

test("conversion guardrails cap manual conversions with ACA buffers", () => {
  const guarded = scenarioWithConversionGuardrails({
    ...DEFAULT_SCENARIO,
    rothConversion: {
      enabled: true,
      annualAmount: 50000,
      optimizeForAca: false
    }
  }, {
    maxAcaFplPercent: 300,
    magiBuffer: 2000
  });

  assert.equal(guarded.rothConversion.applyMagiGuardrails, true);
  assert.equal(guarded.rothConversion.optimizeForAca, true);
  assert.equal(guarded.rothConversion.maxAcaFplPercent, 300);
  assert.equal(guarded.rothConversion.magiBuffer, 2000);
});

test("MAGI spend trim lowers flexible spend without changing required spend", () => {
  const trimmed = scenarioWithMagiSpendTrim(DEFAULT_SCENARIO, {
    requiredSpend: 70000,
    flexibleSpend: 30000
  }, 12000);

  assert.equal(trimmed.targetSpend, 88000);
  assert.equal(trimmed.spendingStrategy.mode, "fixed");
  assert.equal(trimmed.spendingStrategy.essentialSpend, 70000);
  assert.equal(trimmed.spendingStrategy.discretionarySpend, 18000);
});

test("IRMAA lookback guardrail disables gain harvesting and caps IRMAA tier", () => {
  const guarded = scenarioWithIrmaaLookbackGuardrails(DEFAULT_SCENARIO, { maxIrmaaTier: 0 });

  assert.equal(guarded.medicare.irmaaEnabled, true);
  assert.equal(guarded.medicare.maxIrmaaTier, 0);
  assert.equal(guarded.taxGainHarvesting.enabled, false);
  assert.equal(guarded.rothConversion.applyMagiGuardrails, true);
});

test("decision batch surfaces the IRMAA lookback rescue only in the 63-64 window", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida",
    dependentCount: 0
  });
  const assets = [{
    id: "trad",
    name: "Traditional",
    accountType: "traditional",
    assetClass: "stock",
    units: 900000,
    price: 1,
    costBasisPerUnit: 1,
    dividendYield: 0,
    qualifiedDividendShare: 0
  }, {
    id: "taxable",
    name: "Taxable",
    accountType: "taxable",
    assetClass: "stock",
    units: 250000,
    price: 1,
    costBasisPerUnit: 0.4,
    dividendYield: 0,
    qualifiedDividendShare: 1
  }];
  const baseScenario = {
    ...DEFAULT_SCENARIO,
    planYears: 6,
    targetSpend: 90000,
    aca: { enabled: false },
    rothConversion: {
      ...DEFAULT_SCENARIO.rothConversion,
      enabled: true,
      mode: "auto",
      optimizeForAca: false,
      targetMarginalRate: 0.32
    }
  };
  const decisionProfile = { requiredSpend: 68000, flexibleSpend: 22000, targetSuccessRate: 0.9 };

  // Ages 63-64 are the Medicare IRMAA lookback window. The rescue must be
  // reachable here, which requires planFirstYear.age to carry the real age
  // rather than a 0 fallback that would silently gate the rescue out.
  const inWindow = runDecisionBatch({
    assets,
    scenario: { ...baseScenario, currentAge: 63, spouseAge: 63 },
    taxProfile,
    runs: 12,
    seed: 7,
    sequences: [],
    decisionProfile
  });
  assert.equal(inWindow.base.planFirstYear.age, 63);
  assert.ok(inWindow.rescueOptions.some((option) => option.kind === "irmaaLookbackRescue"));

  // Outside the lookback window the rescue must not appear.
  const tooYoung = runDecisionBatch({
    assets,
    scenario: { ...baseScenario, currentAge: 44, spouseAge: 44 },
    taxProfile,
    runs: 12,
    seed: 7,
    sequences: [],
    decisionProfile
  });
  assert.equal(tooYoung.base.planFirstYear.age, 44);
  assert.ok(tooYoung.rescueOptions.every((option) => option.kind !== "irmaaLookbackRescue"));
});

test("Social Security bridge delay applies SSA early/delayed claiming factors", () => {
  const bridged = scenarioWithSocialSecurityBridge({
    ...DEFAULT_SCENARIO,
    socialSecurityAnnualBenefit: 21000,
    socialSecurityStartAge: 62
  }, 70);

  assert.equal(bridged.socialSecurityStartAge, 70);
  assert.equal(Math.round(bridged.socialSecurityAnnualBenefit), 37200);
});

test("taxable lot rescue uses lifetime taxable-first ordering and protects ACA years from gain harvests", () => {
  const rescued = scenarioWithTaxableLotRescue({
    ...DEFAULT_SCENARIO,
    aca: { enabled: true },
    taxGainHarvesting: { enabled: true }
  });

  assert.equal(rescued.withdrawalStrategy.mode, "lifetime");
  assert.deepEqual(rescued.withdrawalOrder, ["taxable", "hsa", "traditional", "roth"]);
  assert.equal(rescued.taxLossHarvesting.enabled, true);
  assert.equal(rescued.taxGainHarvesting.enabled, false);
});

test("decision batch surfaces a safe spending boundary and a failure diagnosis", () => {
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
      targetSuccessRate: 0.9
    }
  });

  assert.equal(decision.safeSpending.available, true);
  assert.equal(typeof decision.safeSpending.safeTotalSpend, "number");
  assert.ok(decision.safeSpending.safeTotalSpend >= 0);
  assert.ok(["headroom", "trim-flexible", "required-unsustainable"].includes(decision.safeSpending.status));
  assert.equal(typeof decision.diagnosis.primary, "string");
  assert.ok(Array.isArray(decision.diagnosis.recommendedKinds));
});

test("discretionary cut is skipped when the base plan already uses guardrails", () => {
  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 3,
    targetSpend: 600000,
    aca: { enabled: false },
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      mode: "discretionaryGuardrails",
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
      targetSuccessRate: 0.9
    }
  });

  assert.ok(decision.rescueOptions.every((option) => option.kind !== "discretionaryCut"));
  assert.ok(decision.rescueOptions.every((option) => option.kind !== "combined"));
});

test("decision batch runs every rescue solver and only returns known rescue kinds", () => {
  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 5,
    currentAge: 60,
    spouseAge: 60,
    targetSpend: 55,
    targetSpendIncludesTaxes: true,
    targetSpendIncludesMedical: true,
    medicalExpensesBase: 0,
    withdrawalOrder: ["taxable"],
    withdrawalStrategy: { mode: "heuristic" },
    taxLossHarvesting: { enabled: false },
    taxGainHarvesting: { enabled: false },
    rothConversion: { enabled: false },
    aca: { enabled: false },
    monteCarlo: { ...DEFAULT_SCENARIO.monteCarlo, samplingMode: "independent" },
    returnAssumptions: {
      ...DEFAULT_SCENARIO.returnAssumptions,
      stock: { mean: 0.04, stdev: 0.08 },
      inflation: { mean: 0, stdev: 0 }
    },
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      mode: "fixed",
      essentialSpend: 40,
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
    runs: 12,
    seed: 5,
    sequences: [],
    decisionProfile: {
      requiredSpend: 40,
      flexibleSpend: 15,
      targetSuccessRate: 0.9
    }
  });

  assert.equal(decision.status, "ready");
  assert.ok(decision.safeSpending);
  assert.ok(decision.diagnosis);
  const validKinds = new Set([
    "discretionaryCut",
    "incomeBridge",
    "combined",
    "sequenceReserve",
    "allocationShift",
    "withdrawalShift",
    "healthcareRescue",
    "rothBasisCliffRescue",
    "taxableLotRescue",
    "conversionGuardrail",
    "magiSpendTrim",
    "irmaaLookbackRescue",
    "socialSecurityBridge"
  ]);
  for (const option of decision.rescueOptions) {
    assert.ok(validKinds.has(option.kind), `unexpected rescue kind: ${option.kind}`);
    assert.equal(typeof option.monteCarlo.successRate, "number");
  }
});
