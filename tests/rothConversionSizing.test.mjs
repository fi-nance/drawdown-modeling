import assert from "node:assert/strict";
import test from "node:test";

import { simulatePlan } from "../src/core/simulation.mjs";
import { mergeScenario } from "../src/core/simulation/scenario.mjs";

// Spending-aware Roth conversion sizing (rothConversion.spendingAware) and
// the Roth-basis swap (rothConversion.spendFromBasis). The hazard pinned
// here: conversions used to be sized BEFORE the year's withdrawal income was
// known, so an ACA-targeted conversion plus TIPS rung maturities / RMDs /
// spending withdrawals could blow past the 400% FPL cliff and vaporize the
// premium tax credit.

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

const ACA_TEST_CONFIG = {
  enabled: true,
  fpl: 20000, // 400% cliff at $80,000 MAGI
  benchmarkPremium: 18000,
  applicablePercentageTable: [
    { minFplPercent: 0, maxFplPercent: 133, initialRate: 0.02, finalRate: 0.02 },
    { minFplPercent: 133, maxFplPercent: 150, initialRate: 0.03, finalRate: 0.04 },
    { minFplPercent: 150, maxFplPercent: 200, initialRate: 0.04, finalRate: 0.06 },
    { minFplPercent: 200, maxFplPercent: 400, initialRate: 0.06, finalRate: 0.1 }
  ]
};

const ACA_CLIFF_MAGI = 80000;

function ladderYearScenario(rothConversionOverrides = {}) {
  return {
    assets: [
      {
        id: "ira-bond",
        accountType: "traditional",
        assetClass: "bond",
        units: 500_000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "taxable-cash",
        accountType: "taxable",
        assetClass: "cash",
        holdingPeriod: "long",
        units: 120_000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 3,
      startYear: 2026,
      currentAge: 60,
      targetSpend: 40_000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable", "traditional", "roth"],
      withdrawalStrategy: { mode: "heuristic" },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      returnAssumptions: { bond: { mean: 0, stdev: 0 }, cash: { mean: 0, stdev: 0 }, tips: { mean: 0, stdev: 0 } },
      tipsLadder: {
        enabled: true,
        years: 2,
        annualRealAmount: 40_000,
        realYieldPercent: 0,
        maintenanceMode: "none"
      },
      rothConversion: {
        enabled: true,
        mode: "auto",
        targetMarginalRate: 0.22,
        optimizeForAca: true,
        maxAcaFplPercent: 400,
        ...rothConversionOverrides
      },
      aca: ACA_TEST_CONFIG
    },
    taxProfile: {
      ...noTaxProfile,
      ordinaryBrackets: [
        { upTo: 90_000, rate: 0.12 },
        { upTo: Infinity, rate: 0.22 }
      ]
    },
    returnSequence: [{ bond: 0, cash: 0, tips: 0 }, { bond: 0, cash: 0, tips: 0 }, { bond: 0, cash: 0, tips: 0 }],
    inflationSequence: [0, 0, 0]
  };
}

test("TIPS rung maturity income is visible to ACA-targeted conversion sizing", () => {
  const plan = simulatePlan(ladderYearScenario());

  const maturityYears = plan.years.filter((year) => (year.tipsLadder?.maturedCash ?? 0) > 0);
  assert.ok(maturityYears.length >= 2, "expected at least two ladder maturity years");

  for (const year of plan.years) {
    assert.ok(
      year.acaMagi <= ACA_CLIFF_MAGI + 1,
      `year ${year.yearIndex}: acaMagi ${year.acaMagi} must stay at or below the 400% FPL cliff`
    );
    assert.equal(year.aca.eligible, true, `year ${year.yearIndex}: PTC eligibility must survive`);
  }

  // The conversion fill still happens in maturity years — it just fills the
  // REMAINING headroom on top of the rung's ordinary income.
  for (const year of maturityYears) {
    assert.ok(year.rothConversionAmount > 0, `maturity year ${year.yearIndex} should still convert`);
    assert.ok(
      year.rothConversionAmount <= ACA_CLIFF_MAGI - year.tipsLadder.maturedCash + 1,
      `maturity year ${year.yearIndex}: conversion must leave room for rung income`
    );
  }
});

test("spendingAware: false reproduces the legacy cliff overshoot (pinned hazard)", () => {
  const plan = simulatePlan(ladderYearScenario({ spendingAware: false }));

  const overshootYears = plan.years.filter((year) => year.acaMagi > ACA_CLIFF_MAGI + 1);
  assert.ok(
    overshootYears.length > 0,
    "legacy sizing must overshoot the cliff in at least one ladder year (this is the bug the default fixes)"
  );
  assert.ok(
    overshootYears.some((year) => year.aca.eligible === false),
    "legacy overshoot must cost PTC eligibility"
  );
});

test("RMD income is visible to bracket-targeted conversion sizing", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira-bond",
      accountType: "traditional",
      assetClass: "bond",
      units: 500_000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      startYear: 2026,
      currentAge: 76,
      targetSpend: 1_000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      withdrawalStrategy: { mode: "heuristic" },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, mode: "auto", targetMarginalRate: 0.12, optimizeForAca: false },
      aca: { enabled: false }
    },
    taxProfile: {
      ...noTaxProfile,
      ordinaryBrackets: [
        { upTo: 50_000, rate: 0.12 },
        { upTo: Infinity, rate: 0.22 }
      ]
    },
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  const year = plan.years[0];
  assert.ok(year.rmdAmount > 10_000, "fixture must force a meaningful RMD");
  assert.ok(year.rothConversionAmount > 0, "conversion should still fill the remaining room");
  // RMD ordinary income + conversion land exactly at the 12% bracket ceiling
  // instead of the conversion claiming the full ceiling on its own.
  assert.ok(
    Math.abs(year.taxes.taxableOrdinaryIncome - 50_000) < 1,
    `total ordinary income ${year.taxes.taxableOrdinaryIncome} should land at the bracket ceiling`
  );
});

function swapScenario(rothConversionOverrides = {}) {
  return {
    assets: [
      {
        id: "ira-bond",
        accountType: "traditional",
        assetClass: "bond",
        units: 400_000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "roth-stock",
        accountType: "roth",
        assetClass: "stock",
        holdingPeriod: "long",
        units: 200_000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      startYear: 2026,
      currentAge: 60,
      targetSpend: 50_000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable", "traditional", "roth"],
      withdrawalStrategy: { mode: "heuristic" },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      returnAssumptions: { bond: { mean: 0, stdev: 0 }, stock: { mean: 0, stdev: 0 } },
      rothConversion: {
        enabled: true,
        mode: "auto",
        targetMarginalRate: 0.22,
        optimizeForAca: true,
        maxAcaFplPercent: 400,
        ...rothConversionOverrides
      },
      aca: ACA_TEST_CONFIG
    },
    taxProfile: {
      ...noTaxProfile,
      ordinaryBrackets: [{ upTo: Infinity, rate: 0.1 }]
    },
    returnSequence: [{ bond: 0, stock: 0 }],
    inflationSequence: [0]
  };
}

test("basis swap: spending funds from Roth so the conversion claims the full ACA room", () => {
  const plan = simulatePlan(swapScenario());
  const year = plan.years[0];

  // Conversion fills (nearly) the whole cliff because spending is assumed —
  // and then actually — funded from the Roth sleeve, which adds no MAGI.
  assert.ok(
    year.rothConversionAmount > ACA_CLIFF_MAGI - 5_000,
    `conversion ${year.rothConversionAmount} should claim (nearly) the full ACA headroom`
  );
  assert.ok(year.acaMagi <= ACA_CLIFF_MAGI + 1, `acaMagi ${year.acaMagi} must respect the cliff`);
  assert.equal(year.aca.eligible, true);

  const rothProceeds = (year.sales ?? [])
    .filter((sale) => sale.accountType === "roth")
    .reduce((total, sale) => total + Math.max(0, sale.proceeds ?? 0), 0);
  assert.ok(rothProceeds > 40_000, `spending should be funded from Roth (got ${rothProceeds})`);
});

test("basis swap off: conversion shrinks to leave room for traditional-funded spending", () => {
  const withSwap = simulatePlan(swapScenario()).years[0];
  const withoutSwap = simulatePlan(swapScenario({ spendFromBasis: false })).years[0];

  assert.ok(
    withSwap.rothConversionAmount > withoutSwap.rothConversionAmount + 20_000,
    `swap should widen the conversion materially (with: ${withSwap.rothConversionAmount}, without: ${withoutSwap.rothConversionAmount})`
  );
  // Both variants must respect the cliff — the swap changes WHO funds
  // spending, never whether the PTC survives.
  assert.ok(withoutSwap.acaMagi <= ACA_CLIFF_MAGI + 1);
  assert.equal(withoutSwap.aca.eligible, true);
});

test("mergeScenario defaults spendingAware and spendFromBasis to true and honors overrides", () => {
  const merged = mergeScenario({});
  assert.equal(merged.rothConversion.spendingAware, true);
  assert.equal(merged.rothConversion.spendFromBasis, true);

  const overridden = mergeScenario({ rothConversion: { spendingAware: false, spendFromBasis: false } });
  assert.equal(overridden.rothConversion.spendingAware, false);
  assert.equal(overridden.rothConversion.spendFromBasis, false);
  // Sibling defaults survive a partial override.
  assert.equal(overridden.rothConversion.targetMarginalRate, 0.12);
});
