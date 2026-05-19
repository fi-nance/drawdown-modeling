import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_MONTE_CARLO_RUNS,
  DEFAULT_SCENARIO,
  MONTE_CARLO_ASSUMPTION_PRESETS,
  runMonteCarlo
} from "../src/core/simulation.mjs";

const EXPECTED_MARKET_NEUTRAL = Object.freeze({
  stock: Object.freeze({ mean: 0.071, stdev: 0.153 }),
  bond: Object.freeze({ mean: 0.049, stdev: 0.063 }),
  cash: Object.freeze({ mean: 0.033, stdev: 0.011 }),
  realEstate: Object.freeze({ mean: 0.081, stdev: 0.179 }),
  tips: Object.freeze({ mean: 0.042, stdev: 0.05 }),
  crypto: Object.freeze({ mean: 0.12, stdev: 0.65 }),
  inflation: Object.freeze({ mean: 0.024, stdev: 0.017 })
});

const FIELD_IDS = Object.freeze({
  stock: Object.freeze({ mean: "mcStockMean", stdev: "mcStockStdev" }),
  bond: Object.freeze({ mean: "mcBondMean", stdev: "mcBondStdev" }),
  cash: Object.freeze({ mean: "mcCashMean", stdev: "mcCashStdev" }),
  realEstate: Object.freeze({ mean: "mcRealEstateMean", stdev: "mcRealEstateStdev" }),
  tips: Object.freeze({ mean: "mcTipsMean", stdev: "mcTipsStdev" }),
  crypto: Object.freeze({ mean: "mcCryptoMean", stdev: "mcCryptoStdev" }),
  inflation: Object.freeze({ mean: "mcInflationMean", stdev: "mcInflationStdev" })
});

test("market-neutral Monte Carlo preset is the default scenario", () => {
  assert.deepEqual(MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral, EXPECTED_MARKET_NEUTRAL);
  assert.equal(DEFAULT_SCENARIO.monteCarlo.assumptionPreset, "marketNeutral");
  assert.equal(DEFAULT_SCENARIO.monteCarlo.samplingMode, "correlated");
  assert.deepEqual(DEFAULT_SCENARIO.returnAssumptions, EXPECTED_MARKET_NEUTRAL);
});

test("runMonteCarlo defaults to 1000 runs", () => {
  const result = runMonteCarlo({
    assets: [],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      aca: { enabled: false }
    },
    seed: 7
  });

  assert.equal(DEFAULT_MONTE_CARLO_RUNS, 1000);
  assert.equal(result.summary.runs, DEFAULT_MONTE_CARLO_RUNS);
});

test("HTML Monte Carlo controls match the core default preset", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.equal(inputValue(html, "runs"), String(DEFAULT_MONTE_CARLO_RUNS));
  assert.deepEqual(optionValues(html, "mcPreset"), ["marketNeutral", "planning", "historical", "custom"]);
  assert.deepEqual(optionValues(html, "mcSamplingMode"), ["correlated", "independent"]);

  for (const [assetClass, fields] of Object.entries(FIELD_IDS)) {
    const assumption = EXPECTED_MARKET_NEUTRAL[assetClass];
    assert.equal(Number(inputValue(html, fields.mean)), roundPercent(assumption.mean));
    assert.equal(Number(inputValue(html, fields.stdev)), roundPercent(assumption.stdev));
  }
});

test("browser worker limits retained Monte Carlo timelines for 1000-run defaults", async () => {
  const source = await readFile(new URL("../src/core/simulation.worker.mjs", import.meta.url), "utf8");

  assert.match(source, /UI_MONTE_CARLO_TIMELINE_LIMIT\s*=\s*5/);
  assert.match(source, /scenarioTimelineLimit:\s*UI_MONTE_CARLO_TIMELINE_LIMIT/);
});

function inputValue(html, id) {
  const pattern = new RegExp(`<input id="${id}"[^>]*value="([^"]+)"`);
  const match = html.match(pattern);
  assert.ok(match, `expected input #${id} to have a value`);
  return match[1];
}

function optionValues(html, id) {
  const pattern = new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`);
  const match = html.match(pattern);
  assert.ok(match, `expected select #${id}`);
  return [...match[1].matchAll(/<option value="([^"]+)"/g)].map((option) => option[1]);
}

function roundPercent(decimal) {
  return Number((decimal * 100).toFixed(1));
}
