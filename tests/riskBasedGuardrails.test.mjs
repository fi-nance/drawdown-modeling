import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRiskBasedGuardrailTable,
  riskBasedGuardrailSpendForYear,
  scalePortfolioToValue
} from "../src/core/simulation/riskBasedGuardrails.mjs";

const assets = [{
  id: "taxable-stock",
  name: "Taxable stock",
  accountType: "taxable",
  assetClass: "stock",
  units: 10_000,
  price: 100,
  costBasisPerUnit: 100
}];

function assetValue(list) {
  return list.reduce((sum, asset) => sum + (Number(asset.units) || 0) * (Number(asset.price) || 0), 0);
}

function deterministicHistoricalEvaluator({ assets: probeAssets, scenario }) {
  const value = assetValue(probeAssets);
  const spend = Math.max(1, Number(scenario.targetSpend) || 0);
  const successRate = Math.max(0, Math.min(1, ((value / spend) - 10) / 10));
  return { successRate, count: 64 };
}

test("risk-based guardrail table solves failsafe spend and portfolio trigger values", () => {
  const table = buildRiskBasedGuardrailTable({
    assets,
    scenario: {
      planYears: 30,
      targetSpend: 55_000
    },
    config: {
      targetSuccessRate: 0.9,
      lowerSuccessRate: 0.75,
      upperSuccessRate: 0.98,
      solverIterations: 10
    },
    evaluateHistoricalSuccess: deterministicHistoricalEvaluator
  });

  assert.ok(table, "expected a solved risk-based guardrail table");
  assert.equal(table.method, "historical");
  assert.equal(table.sequenceCount, 64);
  assert.ok(table.fixedFailsafeSpend < table.initialSpend, "100% failsafe spend should sit below the target-success spend");
  assert.ok(table.initialSpend > 51_000);
  assert.ok(table.initialSpend < 54_000);
  assert.ok(table.lowerGuardrailPortfolioValue < table.initialPortfolioValue);
  assert.ok(table.upperGuardrailPortfolioValue > table.initialPortfolioValue);
  assert.ok(table.lowerAdjustedSpend < table.initialSpend);
  assert.ok(table.upperAdjustedSpend > table.initialSpend);
});

test("risk-based guardrails scale portfolio assets without mutating the original portfolio", () => {
  const scaled = scalePortfolioToValue(assets, 500_000);

  assert.equal(assetValue(assets), 1_000_000);
  assert.equal(assetValue(scaled), 500_000);
  assert.notEqual(scaled[0], assets[0]);
});

test("risk-based guardrails apply only meaningful lower and upper spending adjustments", () => {
  const table = {
    method: "historical",
    sequenceCount: 64,
    initialPortfolioValue: 1_000_000,
    fixedFailsafeSpend: 45_000,
    initialSpend: 50_000,
    targetSuccessRate: 0.9,
    lowerSuccessRate: 0.75,
    upperSuccessRate: 1,
    lowerGuardrailPortfolioValue: 900_000,
    lowerAdjustedSpend: 43_000,
    upperGuardrailPortfolioValue: 1_100_000,
    upperAdjustedSpend: 56_000
  };

  const lower = riskBasedGuardrailSpendForYear({
    currentRealPortfolioValue: 875_000,
    currentRealSpend: 50_000,
    config: { minimumAdjustmentPercent: 0.05, table },
    table
  });
  assert.equal(lower.realSpend, 43_000);
  assert.equal(lower.guardrail.action, "lower");

  const upper = riskBasedGuardrailSpendForYear({
    currentRealPortfolioValue: 1_125_000,
    currentRealSpend: 50_000,
    config: { minimumAdjustmentPercent: 0.05, table },
    table
  });
  assert.equal(upper.realSpend, 56_000);
  assert.equal(upper.guardrail.action, "upper");

  const tooSmall = riskBasedGuardrailSpendForYear({
    currentRealPortfolioValue: 875_000,
    currentRealSpend: 50_000,
    config: {
      minimumAdjustmentPercent: 0.05,
      table: {
        ...table,
        lowerAdjustedSpend: 48_000
      }
    }
  });
  assert.equal(tooSmall.realSpend, 50_000);
  assert.equal(tooSmall.guardrail.action, "none");
});
