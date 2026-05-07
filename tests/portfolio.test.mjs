import assert from "node:assert/strict";
import test from "node:test";

import {
  dividendIncome,
  harvestTaxGains,
  harvestTaxLosses,
  portfolioValue,
  sellFromLot,
  removeEmptyLots
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

test("taxable cash sales do not create capital gain or loss treatment", () => {
  const sale = sellFromLot({
    id: "cash",
    name: "Cash",
    accountType: "taxable",
    assetClass: "cash",
    holdingPeriod: "long",
    units: 1000,
    price: 0.95,
    costBasisPerUnit: 1
  }, 500);

  assert.equal(sale.proceeds, 500);
  assert.equal(sale.taxType, "none");
  assert.equal(sale.gain, 0);
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

test("tax-loss harvesting resets holding period on harvested lots", () => {
  // After TLH, the harvested lot is effectively re-purchased today: its
  // holding period must reset to short so a sale within one year of the
  // harvest is not mistakenly classified as long-term.
  const assets = [{
    id: "long-loss",
    accountType: "taxable",
    assetClass: "stock",
    holdingPeriod: "long",
    units: 10,
    price: 80,
    costBasisPerUnit: 100
  }];

  // Partial harvest: produces a NEW split lot for the harvested portion.
  harvestTaxLosses(assets, 100);
  const harvestedLot = assets.find((asset) => asset.costBasisPerUnit === 80);
  assert.ok(harvestedLot, "expected a new lot at the harvested basis");
  assert.equal(harvestedLot.holdingPeriod, "short");
});

test("tax-loss harvesting reports short-term and long-term losses separately", () => {
  const assets = [
    {
      id: "long-loss",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 10,
      price: 80,
      costBasisPerUnit: 100
    },
    {
      id: "short-loss",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "short",
      units: 10,
      price: 70,
      costBasisPerUnit: 100
    }
  ];

  const harvested = harvestTaxLosses(assets, 500);
  assert.equal(harvested.realizedLosses, 500);
  // First-encountered iterates assets in declaration order. With a $500 cap:
  // long-loss has up to $200 available; short-loss has up to $300.
  assert.equal(harvested.longTermLosses, 200);
  assert.equal(harvested.shortTermLosses, 300);
});

test("tax-gain harvesting resets holding period on harvested lots", () => {
  const assets = [{
    id: "gain-lot",
    accountType: "taxable",
    assetClass: "stock",
    holdingPeriod: "long",
    units: 10,
    price: 100,
    costBasisPerUnit: 50
  }];

  // Full harvest: in-place basis update + holding-period reset.
  harvestTaxGains(assets, 500);
  assert.equal(assets[0].costBasisPerUnit, 100);
  assert.equal(assets[0].holdingPeriod, "short");
});

test("tax loss harvesting ignores cash lots", () => {
  const assets = [{
    id: "cash-lot",
    accountType: "taxable",
    assetClass: "cash",
    holdingPeriod: "long",
    units: 1000,
    price: 0.95,
    costBasisPerUnit: 1
  }];

  const harvested = harvestTaxLosses(assets, 100);

  assert.equal(harvested.realizedLosses, 0);
  assert.equal(harvested.flows.length, 0);
  assert.equal(assets[0].costBasisPerUnit, 1);
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

test("tax gain harvesting ignores cash lots", () => {
  const assets = [{
    id: "cash-lot",
    accountType: "taxable",
    assetClass: "cash",
    holdingPeriod: "long",
    units: 1000,
    price: 1.05,
    costBasisPerUnit: 1
  }];

  const harvested = harvestTaxGains(assets, 100);

  assert.equal(harvested.realizedGains, 0);
  assert.equal(harvested.flows.length, 0);
  assert.equal(assets[0].costBasisPerUnit, 1);
});

test("taxable dividends are reported as one aggregate cash-flow input", () => {
  const assets = [
    {
      id: "stock-a",
      name: "Stock A",
      accountType: "taxable",
      assetClass: "stock",
      units: 10,
      price: 100,
      dividendYield: 0.02,
      qualifiedDividendShare: 1
    },
    {
      id: "stock-b",
      name: "Stock B",
      accountType: "taxable",
      assetClass: "stock",
      units: 5,
      price: 100,
      dividendYield: 0.04,
      qualifiedDividendShare: 0.5
    }
  ];

  const dividends = dividendIncome(assets);

  assert.equal(dividends.cash, 40);
  assert.deepEqual(dividends.flows, [{
    from: "Taxable account dividends",
    to: "Spending reserve",
    amount: 40,
    type: "income"
  }]);
  assert.deepEqual(dividends.details, [
    {
      assetId: "stock-a",
      name: "Stock A",
      accountType: "taxable",
      dividend: 20,
      ordinaryDividends: 0,
      qualifiedDividends: 20
    },
    {
      assetId: "stock-b",
      name: "Stock B",
      accountType: "taxable",
      dividend: 20,
      ordinaryDividends: 10,
      qualifiedDividends: 10
    }
  ]);
});

test("dividendIncome reinvests dividends for non-taxable accounts", () => {
  const assets = [{
    id: "ira-stock",
    accountType: "traditional",
    assetClass: "stock",
    units: 10,
    price: 100,
    dividendYield: 0.05
  }];
  const dividends = dividendIncome(assets);
  assert.equal(dividends.cash, 0);
  assert.equal(assets[0].units, 10.5); // 1000 * 0.05 = 50 / 100 = 0.5 units added
});

test("sellFromLot returns empty sale for zero price or zero units", () => {
  const emptySaleResult = sellFromLot({
    id: "empty",
    accountType: "taxable",
    units: 0,
    price: 100
  }, 500);
  assert.equal(emptySaleResult.proceeds, 0);
  assert.equal(emptySaleResult.unitsSold, 0);
});

test("removeEmptyLots removes lots with zero units or zero price", () => {
  const assets = [
    { id: "good", units: 10, price: 100 },
    { id: "empty1", units: 0, price: 100 },
    { id: "empty2", units: 10, price: 0 }
  ];
  removeEmptyLots(assets);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].id, "good");
});
