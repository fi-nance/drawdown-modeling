import assert from "node:assert/strict";
import test from "node:test";

import {
  historicalCoverageForAssetClasses,
  HISTORICAL_RETURNS,
  makeHistoricalSequences
} from "../src/data/historicalReturns.mjs";

test("historical return dataset runs through 2025 for core asset classes", () => {
  assert.equal(HISTORICAL_RETURNS[0].year, 1928);
  assert.equal(HISTORICAL_RETURNS.at(-1).year, 2025);

  const latest = HISTORICAL_RETURNS.at(-1);
  assert.equal(latest.stock, 0.1778);
  assert.equal(latest.bond, 0.078);
  assert.equal(latest.cash, 0.0421);
  assert.equal(latest.realEstate, 0.0158);
  assert.ok(Number.isFinite(latest.inflation));
});

test("asset-class coverage reflects shorter TIPS and crypto histories", () => {
  assert.deepEqual(historicalCoverageForAssetClasses(["stock", "bond"]), {
    startYear: 1928,
    endYear: 2025,
    rowCount: 98,
    dataVersion: "2026.1"
  });
  assert.equal(historicalCoverageForAssetClasses(["tips"]).startYear, 2004);
  assert.equal(historicalCoverageForAssetClasses(["crypto"]).startYear, 2011);
  assert.equal(historicalCoverageForAssetClasses(["tips", "crypto"]).startYear, 2011);
});

test("rolling all-year backtests create every full historical window", () => {
  const sequences = makeHistoricalSequences({ planYears: 35, mode: "all" });
  assert.equal(sequences.length, 64);
  assert.equal(sequences[0].name, "1928-1962");
  assert.equal(sequences.at(-1).name, "1991-2025");
  assert.equal(sequences.at(-1).returns.at(-1).stock, 0.1778);
});

test("specific and chunked historical modes produce complete plan-length sequences", () => {
  const specific = makeHistoricalSequences({ planYears: 5, mode: "specific", startYear: 1973 });
  assert.equal(specific.length, 1);
  assert.deepEqual(specific[0].sourceYears, [1973, 1974, 1975, 1976, 1977]);

  const chunks = makeHistoricalSequences({ planYears: 12, mode: "chunks", chunkYears: 10, startYear: 2000, endYear: 2025 });
  assert.equal(chunks[0].sourceYears.length, 12);
  assert.equal(chunks[0].name, "2000-2009 repeated");
});

test("historical backtests filter to years where portfolio asset classes exist", () => {
  const sequences = makeHistoricalSequences({
    planYears: 8,
    mode: "all",
    requiredAssetClasses: ["crypto"]
  });

  assert.equal(sequences[0].sourceYears[0], 2011);
  assert.equal(sequences.at(-1).sourceYears.at(-1), 2025);
  assert.ok(sequences.every((sequence) => sequence.returns.every((returns) => Number.isFinite(returns.crypto))));
});
