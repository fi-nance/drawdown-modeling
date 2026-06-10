// Seeded-RNG regression tests.
//
// Bug fixed: createRng coerced seeds with `seed >>> 0`, which maps EVERY
// string to 0 — so "finance", "test-reconstruct-seed", and any other string
// seed produced the same stream. String seeds are now FNV-1a hashed (distinct,
// deterministic streams), while numeric seeds keep the historical coercion so
// every existing seeded Monte Carlo run stays bit-identical.

import assert from "node:assert/strict";
import test from "node:test";

import { createRng } from "../src/core/utils.mjs";
import { runMonteCarlo, generateSingleMonteCarloPath } from "../src/core/simulation.mjs?v=20260609-deepfix";

test("numeric seeds stay bit-identical to the historical mulberry32 stream", () => {
  // These values pin the exact stream for seed 42 — seeded Monte Carlo
  // reproducibility depends on them never changing.
  const rng = createRng(42);
  assert.equal(rng(), 0.6011037519201636);
  assert.equal(rng(), 0.44829055899754167);
  assert.equal(rng(), 0.8524657934904099);

  // Fractional numeric seeds keep the legacy `>>> 0` truncation.
  assert.equal(createRng(42.9)(), 0.6011037519201636);
});

test("string seeds are deterministic and distinct from each other", () => {
  const first = createRng("finance");
  const second = createRng("finance");
  assert.equal(first(), second()); // deterministic

  // Previously both of these collapsed to state 0 and produced one stream.
  const finance = createRng("finance")();
  const other = createRng("other-seed")();
  assert.notEqual(finance, other);

  // A string seed no longer aliases the numeric seed 0.
  assert.notEqual(createRng("finance")(), createRng(0)());
});

test("string-seeded Monte Carlo paths reproduce across both engine entry points", () => {
  const assets = [{ id: "stock", accountType: "taxable", assetClass: "stock", units: 100, price: 100, costBasisPerUnit: 50 }];
  const scenario = {
    planYears: 5,
    currentAge: 60,
    targetSpend: 5000,
    rothConversion: { enabled: false },
    aca: { enabled: false }
  };

  const monteCarlo = runMonteCarlo({ assets, scenario, runs: 3, seed: "string-seed-repro", scenarioTimelineLimit: Infinity });
  const replayed = generateSingleMonteCarloPath({ assets, scenario, seed: "string-seed-repro", scenarioId: 2 });
  assert.equal(replayed.years.at(-1).endingPortfolioValue, monteCarlo.scenarios[1].years.at(-1).endingPortfolioValue);
});
