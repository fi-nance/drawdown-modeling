import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_MONTE_CARLO_MEAN_REVERSION,
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
  inflation: Object.freeze({ mean: 0.024, stdev: 0.017 }),
  medicalInflation: Object.freeze({ mean: 0.042, stdev: 0.020 })
});

const FIELD_IDS = Object.freeze({
  stock: Object.freeze({ mean: "mcStockMean", stdev: "mcStockStdev" }),
  bond: Object.freeze({ mean: "mcBondMean", stdev: "mcBondStdev" }),
  cash: Object.freeze({ mean: "mcCashMean", stdev: "mcCashStdev" }),
  realEstate: Object.freeze({ mean: "mcRealEstateMean", stdev: "mcRealEstateStdev" }),
  tips: Object.freeze({ mean: "mcTipsMean", stdev: "mcTipsStdev" }),
  crypto: Object.freeze({ mean: "mcCryptoMean", stdev: "mcCryptoStdev" }),
  inflation: Object.freeze({ mean: "mcInflationMean", stdev: "mcInflationStdev" }),
  medicalInflation: Object.freeze({ mean: "mcMedicalInflationMean", stdev: "mcMedicalInflationStdev" })
});

test("market-neutral Monte Carlo preset is the default scenario", () => {
  assert.deepEqual(MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral, EXPECTED_MARKET_NEUTRAL);
  assert.equal(DEFAULT_SCENARIO.monteCarlo.assumptionPreset, "marketNeutral");
  assert.equal(DEFAULT_SCENARIO.monteCarlo.samplingMode, "correlated");
  assert.deepEqual(DEFAULT_SCENARIO.monteCarlo.meanReversion, DEFAULT_MONTE_CARLO_MEAN_REVERSION);
  assert.deepEqual(DEFAULT_SCENARIO.returnAssumptions, EXPECTED_MARKET_NEUTRAL);
});

test("runMonteCarlo defaults to 1000 runs for an ordinary spending scenario", () => {
  const result = runMonteCarlo({
    assets: [{
      name: "Taxable cash",
      accountType: "taxable",
      assetClass: "cash",
      units: 1,
      price: 20000,
      costBasisPerUnit: 20000,
      holdingPeriod: "long"
    }],
    scenario: {
      planYears: 1,
      targetSpend: 12000,
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
  assert.deepEqual(optionValues(html, "mcSamplingMode"), ["correlated", "meanRevertingCorrelated", "independent"]);
  assert.equal(Number(inputValue(html, "mcShortTermMeanReversion")), roundPercent(DEFAULT_MONTE_CARLO_MEAN_REVERSION.shortTermStrength));
  assert.equal(Number(inputValue(html, "mcLongTermMeanReversion")), roundPercent(DEFAULT_MONTE_CARLO_MEAN_REVERSION.longTermStrength));
  assert.equal(Number(inputValue(html, "mcLongTermReversionYears")), DEFAULT_MONTE_CARLO_MEAN_REVERSION.longTermYears);

  for (const [assetClass, fields] of Object.entries(FIELD_IDS)) {
    const assumption = EXPECTED_MARKET_NEUTRAL[assetClass];
    assert.equal(Number(inputValue(html, fields.mean)), roundPercent(assumption.mean));
    assert.equal(Number(inputValue(html, fields.stdev)), roundPercent(assumption.stdev));
  }
});

test("Monte Carlo mean reversion controls are persisted, gated, and read into scenarios", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
  ]);
  const meanReversionControlIds = [
    "mcShortTermMeanReversion",
    "mcLongTermMeanReversion",
    "mcLongTermReversionYears"
  ];

  assert.match(html, /data-mean-reversion-controls hidden/);
  for (const id of meanReversionControlIds) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should be visible in the Monte Carlo module`);
    assert.match(appSource, new RegExp(`"${id}"`), `${id} should be persisted with other controls`);
    assert.match(appSource, new RegExp(`${id}: document\\.querySelector\\("#${id}"\\)`), `${id} should be queried by app wiring`);
  }

  assert.match(appSource, /function syncMonteCarloControls\(\)/);
  assert.match(appSource, /meanReversionEnabled = els\.mcSamplingMode\?\.value === "meanRevertingCorrelated"/);
  assert.match(appSource, /document\.querySelectorAll\("\[data-mean-reversion-controls\]"\)/);
  assert.match(appSource, /input\.disabled = !meanReversionEnabled/);
  assert.match(appSource, /els\.mcSamplingMode\?\.addEventListener\("change"/);
  assert.match(appSource, /function readMonteCarloMeanReversion\(\)/);
  assert.match(appSource, /shortTermStrength: readPercentInput\("mcShortTermMeanReversion", DEFAULT_MONTE_CARLO_MEAN_REVERSION\.shortTermStrength\)/);
  assert.match(appSource, /longTermStrength: readPercentInput\("mcLongTermMeanReversion", DEFAULT_MONTE_CARLO_MEAN_REVERSION\.longTermStrength\)/);
  assert.match(appSource, /longTermYears: Math\.max\(2, Math\.min\(30/);
  assert.match(appSource, /samplingMode: normalizeMonteCarloSamplingMode\(els\.mcSamplingMode\?\.value\)/);
  assert.match(appSource, /meanReversion: readMonteCarloMeanReversion\(\)/);
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
