import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { simulatePlan, DEFAULT_SCENARIO, runMonteCarlo, generateSingleMonteCarloPath } from "../src/core/simulation.mjs";
import { buildTradeoffFrontier } from "../src/core/decisionEngine.mjs";

test("Inherited-IRA 10-Year Payout & Heir Brackets progressive compression", () => {
  const assets = [
    {
      id: "traditional",
      name: "Traditional IRA",
      accountType: "traditional",
      assetClass: "stock",
      units: 1_000_000,
      price: 1,
      costBasisPerUnit: 1
    }
  ];

  const scenarioBase = {
    ...DEFAULT_SCENARIO,
    planYears: 1,
    targetSpend: 0,
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      essentialSpend: 0,
      discretionarySpend: 0
    },
    heirOrdinaryTaxRate: 0.10, // low spousal rate to contrast progressive bracket compressions
    aca: { enabled: false }
  };

  // Spouse rollover
  const spousePlan = simulatePlan({
    assets,
    scenario: { ...scenarioBase, heirType: "spouse" },
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  // Non-spouse 10-year payout stacked on top of $80k income.
  const nonSpousePlan = simulatePlan({
    assets,
    scenario: { ...scenarioBase, heirType: "nonSpouse10Yr", heirBaseIncome: 80000 },
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.ok(nonSpousePlan.heirValueBreakdown.totalIncomeTaxEstimate > spousePlan.heirValueBreakdown.totalIncomeTaxEstimate, "Non-spouse 10-yr payout creates dynamic bracket compression and higher tax pressure");
});

test("Federal Estate Tax uses the 2026 $15M OBBBA exclusion; spouse exempt", () => {
  const mkScenario = (heirType) => ({
    ...DEFAULT_SCENARIO,
    planYears: 1,
    targetSpend: 0,
    heirType,
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      essentialSpend: 0,
      discretionarySpend: 0
    },
    aca: { enabled: false }
  });
  const mkPlan = (units, heirType) => simulatePlan({
    assets: [{ id: "roth", name: "Roth IRA", accountType: "roth", assetClass: "stock", units, price: 1, costBasisPerUnit: 1 }],
    scenario: mkScenario(heirType),
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  // $10M estate to a non-spouse heir is BELOW the $15M exclusion → no estate tax.
  const below = mkPlan(10_000_000, "nonSpouse10Yr");
  assert.equal(below.heirValueBreakdown.federalEstateTax, 0);
  assert.equal(below.heirValueBreakdown.afterTaxValue, 10_000_000);

  // $20M to a non-spouse heir → 40% × ($20M − $15M) = $2M.
  const above = mkPlan(20_000_000, "nonSpouse10Yr");
  assert.equal(above.heirValueBreakdown.federalEstateTax, 2_000_000);
  assert.equal(above.heirValueBreakdown.afterTaxValue, 18_000_000);

  // $20M to a surviving spouse → unlimited marital deduction → no estate tax.
  const spouse = mkPlan(20_000_000, "spouse");
  assert.equal(spouse.heirValueBreakdown.federalEstateTax, 0);
});

test("State Inheritance Tax: PA taxes lineal heirs (4.5%), NJ exempts them (Class A)", () => {
  const assets = [
    {
      id: "roth",
      name: "Roth IRA",
      accountType: "roth",
      assetClass: "stock",
      units: 1_000_000,
      price: 1,
      costBasisPerUnit: 1
    }
  ];

  const scenarioPA = {
    ...DEFAULT_SCENARIO,
    planYears: 1,
    targetSpend: 0,
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      essentialSpend: 0,
      discretionarySpend: 0
    },
    heirType: "nonSpouse10Yr",
    state: "PA",
    aca: { enabled: false }
  };

  const scenarioNJ = {
    ...DEFAULT_SCENARIO,
    planYears: 1,
    targetSpend: 0,
    spendingStrategy: {
      ...DEFAULT_SCENARIO.spendingStrategy,
      essentialSpend: 0,
      discretionarySpend: 0
    },
    heirType: "nonSpouse10Yr",
    state: "NJ",
    aca: { enabled: false }
  };

  const planPA = simulatePlan({
    assets,
    scenario: scenarioPA,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });
  const planNJ = simulatePlan({
    assets,
    scenario: scenarioNJ,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  // PA taxes lineal descendants at 4.5%; NJ Class A (children/grandchildren/
  // parents) are fully exempt, so a lineal heir owes $0 NJ inheritance tax.
  assert.equal(planPA.heirValueBreakdown.stateInheritanceTax, 45_000);
  assert.equal(planNJ.heirValueBreakdown.stateInheritanceTax, 0);
});

test("inheritance jurisdiction is not selected using heir residence", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.doesNotMatch(html, /id="heirState"/);
  assert.match(html, /id="stateSelect"/);
  assert.doesNotMatch(html, /New Jersey \(NJ - 15% non-spouse\)/);
  assert.doesNotMatch(html, /Maryland \(MD - 10%\)/);
});

test("Social Security early reductions and delayed retirement credits", () => {
  const assets = [
    {
      id: "taxable",
      name: "Taxable Cash",
      accountType: "taxable",
      assetClass: "cash",
      units: 100_000,
      price: 1,
      costBasisPerUnit: 1
    }
  ];

  const scenarioBase = {
    ...DEFAULT_SCENARIO,
    planYears: 1,
    socialSecurityAnnualBenefit: 0,
    estimateSocialSecurityFromEarnings: true, // opt in to earnings-based PIA
    medicareWages: 85714.28,
    currentAge: 62,
    aca: { enabled: false }
  };

  const plan62 = simulatePlan({
    assets,
    scenario: { ...scenarioBase, socialSecurityStartAge: 62, currentAge: 62 },
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  const plan67 = simulatePlan({
    assets,
    scenario: { ...scenarioBase, socialSecurityStartAge: 67, currentAge: 67 },
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  const plan70 = simulatePlan({
    assets,
    scenario: { ...scenarioBase, socialSecurityStartAge: 70, currentAge: 70 },
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.ok(plan62.years[0].socialSecurityBenefits < plan67.years[0].socialSecurityBenefits);
  assert.ok(plan70.years[0].socialSecurityBenefits > plan67.years[0].socialSecurityBenefits);
});

test("Social Security PIA-from-earnings progressive estimation", () => {
  const assets = [
    {
      id: "taxable",
      name: "Taxable Cash",
      accountType: "taxable",
      assetClass: "cash",
      units: 100_000,
      price: 1,
      costBasisPerUnit: 1
    }
  ];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 1,
    socialSecurityAnnualBenefit: 0,
    estimateSocialSecurityFromEarnings: true, // opt in to earnings-based PIA
    medicareWages: 120000,
    socialSecurityStartAge: 66 + 10 / 12, // 1959 cohort FRA
    currentAge: 67,
    aca: { enabled: false }
  };

  const plan = simulatePlan({
    assets,
    scenario,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].socialSecurityBenefits, 42758.4);
});

test("Tradeoff frontier compiles alternative plans", () => {
  const assets = [
    {
      id: "taxable",
      name: "Taxable Portfolio",
      accountType: "taxable",
      assetClass: "stock",
      units: 1_000_000,
      price: 1,
      costBasisPerUnit: 1
    }
  ];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 35,
    targetSpend: 100000,
    aca: { enabled: true }
  };

  const tradeoff = buildTradeoffFrontier({
    assets,
    scenario,
    runs: 10
  });

  assert.equal(tradeoff.length, 4);
  assert.equal(tradeoff[0].id, "max-spending");
  assert.equal(tradeoff[1].id, "base-reference");
  assert.equal(tradeoff[2].id, "max-healthcare");
  assert.equal(tradeoff[3].id, "max-bequest");

  assert.equal(tradeoff[0].candidate.scenario.targetSpend, 120000);
  assert.equal(tradeoff[3].candidate.scenario.targetSpend, 60000);
  // An unfunded higher target need not deliver more spending over the lifetime.
  for (const point of tradeoff) {
    assert.equal(point.spend, point.candidate.monteCarlo.medianAverageRealSpending);
    assert.equal(point.bequest, point.candidate.monteCarlo.medianHeirValue);
    assert.doesNotMatch(point.label, /Max /);
  }
});

test("generateSingleMonteCarloPath reconstructs a deterministic run path matching Monte Carlo output", () => {
  const assets = [
    {
      id: "stock",
      name: "Stock Account",
      accountType: "taxable",
      assetClass: "stock",
      units: 100_000,
      price: 1,
      costBasisPerUnit: 1
    }
  ];

  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 10,
    targetSpend: 4000,
    aca: { enabled: false }
  };

  const seed = "test-reconstruct-seed";
  const mc = runMonteCarlo({
    assets,
    scenario,
    runs: 5,
    seed,
    scenarioTimelineLimit: 2 // only first 2 get timelines
  });

  // Reconstruct scenario ID 3 (which was not included in timeline limit)
  const plan = generateSingleMonteCarloPath({
    assets,
    scenario,
    seed,
    scenarioId: 3
  });

  assert.ok(plan, "Single MC path reconstruction succeeds");
  assert.equal(plan.years.length, 10, "Reconstructed path has full 10 years of timeline");

  // Reconstructed ending value should precisely match the cached summary ending value of run 3!
  const scenarioResult3 = mc.scenarios[2];
  assert.equal(plan.years[9].endingPortfolioValue, scenarioResult3.endingValue, "Reconstructed ending value matches Monte Carlo cached summary");
});

test("generateSingleMonteCarloPath reconstructs mean-reverting correlated paths with per-run state reset", () => {
  const assets = [
    {
      id: "stock",
      name: "Stock Account",
      accountType: "taxable",
      assetClass: "stock",
      units: 100_000,
      price: 1,
      costBasisPerUnit: 1
    },
    {
      id: "bond",
      name: "Bond Account",
      accountType: "taxable",
      assetClass: "bond",
      units: 50_000,
      price: 1,
      costBasisPerUnit: 1
    }
  ];
  const scenario = {
    ...DEFAULT_SCENARIO,
    planYears: 6,
    targetSpend: 0,
    targetSpendIncludesTaxes: true,
    targetSpendIncludesMedical: true,
    aca: { enabled: false },
    monteCarlo: {
      assumptionPreset: "custom",
      samplingMode: "meanRevertingCorrelated",
      meanReversion: {
        shortTermStrength: 0.8,
        longTermStrength: 0.6,
        longTermYears: 4
      }
    },
    returnAssumptions: {
      stock: { mean: 0.05, stdev: 0.03 },
      bond: { mean: 0.02, stdev: 0.02 },
      inflation: { mean: 0.02, stdev: 0.01 },
      medicalInflation: { mean: 0.04, stdev: 0.01 }
    }
  };
  const seed = 20260608;
  const limitedTimeline = runMonteCarlo({
    assets,
    scenario,
    runs: 4,
    seed,
    scenarioTimelineLimit: 1
  });
  const reconstructed = generateSingleMonteCarloPath({
    assets,
    scenario,
    seed,
    scenarioId: 4
  });
  const fullTimeline = runMonteCarlo({
    assets,
    scenario,
    runs: 4,
    seed,
    scenarioTimelineLimit: 4
  });

  assert.ok(reconstructed, "Single MC path reconstruction succeeds");
  assert.equal(limitedTimeline.scenarios[3].years, undefined, "Run 4 is not retained in the limited batch timeline");
  assert.equal(reconstructed.years.at(-1).endingPortfolioValue, limitedTimeline.scenarios[3].endingValue);
  assert.equal(reconstructed.heirValue, limitedTimeline.scenarios[3].heirValue);
  assert.deepEqual(
    reconstructed.years.map((year) => year.assetClassReturns),
    fullTimeline.scenarios[3].years.map((year) => year.assetClassReturns)
  );
});
