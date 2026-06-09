import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MONTE_CARLO_MEAN_REVERSION } from "../src/core/simulation.mjs";
import {
  MEAN_REVERTING_CORRELATED_SAMPLING_MODE,
  createMonteCarloSamplingState,
  normalizeMeanReversionConfig,
  sampleReturnsForYearWithState
} from "../src/core/simulation/market.mjs";
import { createRng } from "../src/core/utils.mjs";

const ASSET_CLASSES = Object.freeze(["stock", "bond", "cash"]);

function assertNear(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

function assertReturnsNear(actual, expected, tolerance = 1e-12) {
  for (const assetClass of ASSET_CLASSES) {
    assertNear(actual[assetClass], expected[assetClass], tolerance);
  }
}

function scenarioFor(samplingMode, meanReversion = {}) {
  return {
    monteCarlo: {
      samplingMode,
      meanReversion
    },
    returnAssumptions: {
      stock: { mean: 0.05, stdev: 0.03 },
      bond: { mean: 0.02, stdev: 0.02 },
      cash: { mean: 0.01, stdev: 0.005 },
      inflation: { mean: 0.02, stdev: 0.01 }
    }
  };
}

function meanFor(scenario, assetClass) {
  return scenario.returnAssumptions[assetClass].mean;
}

test("mean reversion config defaults and clamps user input", () => {
  assert.deepEqual(normalizeMeanReversionConfig(), DEFAULT_MONTE_CARLO_MEAN_REVERSION);
  assert.deepEqual(
    normalizeMeanReversionConfig({
      shortTermStrength: -0.2,
      longTermStrength: 1.4,
      longTermYears: 99
    }),
    {
      shortTermStrength: 0,
      longTermStrength: 1,
      longTermYears: 30
    }
  );
  assert.deepEqual(
    normalizeMeanReversionConfig({
      shortTermStrength: "0.125",
      longTermStrength: "0.875",
      longTermYears: "3.9"
    }),
    {
      shortTermStrength: 0.125,
      longTermStrength: 0.875,
      longTermYears: 3
    }
  );
});

test("mean-reverting correlated mode creates isolated sampler state", () => {
  assert.equal(createMonteCarloSamplingState(scenarioFor("correlated")), null);
  assert.equal(createMonteCarloSamplingState(scenarioFor("independent")), null);

  const state = createMonteCarloSamplingState(scenarioFor(MEAN_REVERTING_CORRELATED_SAMPLING_MODE, {
    shortTermStrength: 0.4,
    longTermStrength: 0.6,
    longTermYears: 12
  }));

  assert.deepEqual(state.config, {
    shortTermStrength: 0.4,
    longTermStrength: 0.6,
    longTermYears: 12
  });
  assert.deepEqual(state.previousDeviation, {});
  assert.deepEqual(state.cumulativeDeviation, {});
});

test("mean-reverting correlated sampling starts from the correlated factor draw", () => {
  const correlatedScenario = scenarioFor("correlated");
  const meanRevertingScenario = scenarioFor(MEAN_REVERTING_CORRELATED_SAMPLING_MODE, {
    shortTermStrength: 1,
    longTermStrength: 1,
    longTermYears: 2
  });
  const correlatedReturns = sampleReturnsForYearWithState(correlatedScenario, createRng(12345), null);
  const meanRevertingReturns = sampleReturnsForYearWithState(
    meanRevertingScenario,
    createRng(12345),
    createMonteCarloSamplingState(meanRevertingScenario)
  );

  assertReturnsNear(meanRevertingReturns, correlatedReturns);
  assert.equal("inflation" in meanRevertingReturns, false);
});

test("short-term mean reversion offsets the prior year's asset-class excess return", () => {
  const correlatedScenario = scenarioFor("correlated");
  const meanRevertingScenario = scenarioFor(MEAN_REVERTING_CORRELATED_SAMPLING_MODE, {
    shortTermStrength: 1,
    longTermStrength: 0,
    longTermYears: 10
  });
  const correlatedRng = createRng(731);
  const meanRevertingRng = createRng(731);
  const state = createMonteCarloSamplingState(meanRevertingScenario);

  const correlatedYear0 = sampleReturnsForYearWithState(correlatedScenario, correlatedRng, null);
  const meanRevertingYear0 = sampleReturnsForYearWithState(meanRevertingScenario, meanRevertingRng, state);
  const correlatedYear1 = sampleReturnsForYearWithState(correlatedScenario, correlatedRng, null);
  const meanRevertingYear1 = sampleReturnsForYearWithState(meanRevertingScenario, meanRevertingRng, state);

  assertReturnsNear(meanRevertingYear0, correlatedYear0);
  for (const assetClass of ASSET_CLASSES) {
    const firstYearDeviation = meanRevertingYear0[assetClass] - meanFor(meanRevertingScenario, assetClass);
    assertNear(
      meanRevertingYear1[assetClass] - correlatedYear1[assetClass],
      -firstYearDeviation
    );
  }
});

test("long-term mean reversion offsets cumulative adjusted deviations over the configured horizon", () => {
  const correlatedScenario = scenarioFor("correlated");
  const meanRevertingScenario = scenarioFor(MEAN_REVERTING_CORRELATED_SAMPLING_MODE, {
    shortTermStrength: 0,
    longTermStrength: 1,
    longTermYears: 2
  });
  const correlatedRng = createRng(947);
  const meanRevertingRng = createRng(947);
  const state = createMonteCarloSamplingState(meanRevertingScenario);

  const meanRevertingYear0 = sampleReturnsForYearWithState(meanRevertingScenario, meanRevertingRng, state);
  sampleReturnsForYearWithState(correlatedScenario, correlatedRng, null);
  const correlatedYear1 = sampleReturnsForYearWithState(correlatedScenario, correlatedRng, null);
  const meanRevertingYear1 = sampleReturnsForYearWithState(meanRevertingScenario, meanRevertingRng, state);

  for (const assetClass of ASSET_CLASSES) {
    const cumulativeBeforeYear1 = meanRevertingYear0[assetClass] - meanFor(meanRevertingScenario, assetClass);
    assertNear(
      meanRevertingYear1[assetClass] - correlatedYear1[assetClass],
      -(cumulativeBeforeYear1 / 2)
    );
  }

  const correlatedYear2 = sampleReturnsForYearWithState(correlatedScenario, correlatedRng, null);
  const cumulativeBeforeYear2 = Object.fromEntries(
    ASSET_CLASSES.map((assetClass) => [
      assetClass,
      (meanRevertingYear0[assetClass] - meanFor(meanRevertingScenario, assetClass))
        + (meanRevertingYear1[assetClass] - meanFor(meanRevertingScenario, assetClass))
    ])
  );
  const meanRevertingYear2 = sampleReturnsForYearWithState(meanRevertingScenario, meanRevertingRng, state);

  for (const assetClass of ASSET_CLASSES) {
    assertNear(
      meanRevertingYear2[assetClass] - correlatedYear2[assetClass],
      -(cumulativeBeforeYear2[assetClass] / 2)
    );
  }
});
