import assert from "node:assert/strict";
import test from "node:test";

import {
  harvestTaxGains,
  harvestTaxLosses,
  portfolioValue,
  sellFromLot
} from "../src/core/portfolio.mjs";

test("taxable sales preserve long-term versus short-term tax character", () => {
  const longSale = sellFromLot({
    id: "long",
    accountType: "taxable",
    holdingPeriod: "long",
    units: 10,
    price: 100,
    costBasisPerUnit: 40
  }, 500);

  const shortSale = sellFromLot({
    id: "short",
    accountType: "taxable",
    holdingPeriod: "short",
    units: 10,
    price: 100,
    costBasisPerUnit: 40
  }, 500);

  assert.equal(longSale.taxType, "capital-gains");
  assert.equal(longSale.gain, 300);
  assert.equal(shortSale.taxType, "ordinary");
  assert.equal(shortSale.gain, 300);
});

test("traditional retirement withdrawals are ordinary income and Roth withdrawals are non-taxable", () => {
  const traditional = sellFromLot({
    id: "ira",
    accountType: "traditional",
    units: 10,
    price: 100,
    costBasisPerUnit: 100
  }, 500);

  const roth = sellFromLot({
    id: "roth",
    accountType: "roth",
    units: 10,
    price: 100,
    costBasisPerUnit: 100
  }, 500);

  assert.equal(traditional.taxType, "ordinary");
  assert.equal(traditional.gain, 500);
  assert.equal(roth.taxType, "none");
  assert.equal(roth.gain, 0);
});

test("tax loss harvesting realizes losses and resets harvested basis", () => {
  const assets = [{
    id: "loss-lot",
    accountType: "taxable",
    assetClass: "stock",
    holdingPeriod: "long",
    units: 10,
    price: 80,
    costBasisPerUnit: 100
  }];

  const harvested = harvestTaxLosses(assets, 150);

  assert.equal(harvested.realizedLosses, 150);
  assert.equal(portfolioValue(assets), 800);
  assert.ok(assets.some((asset) => asset.costBasisPerUnit === 80));
});

test("tax gain harvesting realizes gains and steps up basis", () => {
  const assets = [{
    id: "gain-lot",
    accountType: "taxable",
    assetClass: "stock",
    holdingPeriod: "long",
    units: 10,
    price: 100,
    costBasisPerUnit: 50
  }];

  const harvested = harvestTaxGains(assets, 200);

  assert.equal(harvested.realizedGains, 200);
  assert.equal(portfolioValue(assets), 1000);
  assert.ok(assets.some((asset) => asset.costBasisPerUnit === 100));
});

