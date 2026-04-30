import assert from "node:assert/strict";
import test from "node:test";

import { parsePortfolioJson } from "../src/core/importers.mjs";

test("JSON importer accepts either an array or an object with assets", () => {
  const result = parsePortfolioJson(JSON.stringify({
    assets: [{
      name: "Taxable Total Market",
      accountType: "taxable",
      assetClass: "stock",
      units: 10,
      price: 100,
      costBasisPerUnit: 60
    }]
  }));

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "taxable-total-market");
  assert.equal(result[0].holdingPeriod, "long");
});

test("JSON importer accepts TIPS and crypto asset classes", () => {
  const result = parsePortfolioJson(JSON.stringify([
    { accountType: "taxable", assetClass: "tips", units: 10, price: 100 },
    { accountType: "roth", assetClass: "crypto", units: 1, price: 50000 }
  ]));

  assert.equal(result[0].assetClass, "tips");
  assert.equal(result[1].assetClass, "crypto");
});

test("JSON importer rejects invalid lots before simulation", () => {
  assert.throws(() => parsePortfolioJson("[{\"accountType\":\"taxable\"}]"), /units/i);
});

test("JSON importer rejects unsupported asset classes before simulation", () => {
  assert.throws(
    () => parsePortfolioJson(JSON.stringify([{ accountType: "taxable", assetClass: "collectible", units: 1, price: 10 }])),
    /assetClass/i
  );
});
