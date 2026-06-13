import assert from "node:assert/strict";
import test from "node:test";

import {
  representativeAssets,
  portfolioFromTotal,
  essentialsToControls
} from "../src/core/onboarding.mjs";
import { simulatePlan } from "../src/core/simulation.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

const sumUnits = (assets) => assets.reduce((acc, a) => acc + a.units * a.price, 0);

test("portfolioFromTotal: single number is modeled as a taxable stock/bond split summing to the total", () => {
  const assets = portfolioFromTotal({ total: 1_000_000, stockPercent: 60 });

  assert.equal(assets.length, 2, "one stock lot + one bond lot");
  assert.ok(assets.every((a) => a.accountType === "taxable"), "all taxable");
  assert.equal(sumUnits(assets), 1_000_000, "lots sum to the entered total");

  const stock = assets.find((a) => a.assetClass === "stock");
  const bond = assets.find((a) => a.assetClass === "bond");
  assert.equal(stock.units, 600_000);
  assert.equal(bond.units, 400_000);
  // Class income defaults are applied so the lots behave like broad funds.
  assert.equal(stock.qualifiedDividendShare, 0.95);
  assert.equal(bond.qualifiedDividendShare, 0);
});

test("representativeAssets: one stock+bond lot per non-empty bucket, empty buckets skipped, totals preserved", () => {
  const assets = representativeAssets({
    taxable: 500_000,
    traditional: 300_000,
    roth: 200_000,
    hsa: 0,
    stockPercent: 70
  });

  const byAccount = (type) => assets.filter((a) => a.accountType === type);
  assert.equal(byAccount("taxable").length, 2);
  assert.equal(byAccount("traditional").length, 2);
  assert.equal(byAccount("roth").length, 2);
  assert.equal(byAccount("hsa").length, 0, "zero bucket produces no lots");

  // Each bucket's lots sum back to its dollar amount exactly (no rounding drift).
  assert.equal(sumUnits(byAccount("taxable")), 500_000);
  assert.equal(sumUnits(byAccount("traditional")), 300_000);
  assert.equal(sumUnits(byAccount("roth")), 200_000);
  assert.equal(sumUnits(assets), 1_000_000);

  // 70% stock applied uniformly.
  const taxableStock = byAccount("taxable").find((a) => a.assetClass === "stock");
  assert.equal(taxableStock.units, 350_000);
});

test("representativeAssets: stockPercent extremes drop the empty class lot", () => {
  const allStock = representativeAssets({ taxable: 100_000, stockPercent: 100 });
  assert.equal(allStock.length, 1);
  assert.equal(allStock[0].assetClass, "stock");
  assert.equal(allStock[0].units, 100_000);

  const allBond = representativeAssets({ taxable: 100_000, stockPercent: 0 });
  assert.equal(allBond.length, 1);
  assert.equal(allBond[0].assetClass, "bond");
  assert.equal(allBond[0].units, 100_000);
});

test("representativeAssets: id factory is honored so synthesized lots get unique app ids", () => {
  let n = 0;
  const ids = representativeAssets({
    taxable: 100_000,
    traditional: 100_000,
    stockPercent: 50,
    makeId: () => `asset-new-${(n += 1)}`
  }).map((a) => a.id);
  assert.deepEqual(ids, ["asset-new-1", "asset-new-2", "asset-new-3", "asset-new-4"]);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});

test("essentialsToControls: married surfaces spouse age; single mirrors the primary age", () => {
  const married = essentialsToControls({
    currentAge: 62,
    spouseAge: 60,
    filingStatus: "marriedFilingJointly",
    state: "Massachusetts",
    householdSize: 2,
    planYears: 33,
    targetSpend: 90_000
  });
  assert.equal(married.spouseAge, 60);
  assert.equal(married.filingStatus, "marriedFilingJointly");
  assert.equal(married.stateSelect, "Massachusetts");
  assert.equal(married.targetSpend, 90_000);
  assert.equal(married.includeTaxes, false);
  assert.equal(married.includeMedical, false);

  const single = essentialsToControls({
    currentAge: 70,
    spouseAge: 60, // ignored for a single filer
    filingStatus: "single",
    state: "Florida",
    householdSize: 1,
    planYears: 25,
    targetSpend: 55_000,
    includeTaxes: true
  });
  // Spouse age mirrors the primary (harmless; spouse mechanics are gated off by
  // filing status), never the stray 60 passed in.
  assert.equal(single.spouseAge, 70);
  assert.equal(single.includeTaxes, true);
});

test("synthesized portfolios run cleanly through the engine (no per-holding detail required)", () => {
  const assets = representativeAssets({
    taxable: 500_000,
    traditional: 300_000,
    roth: 200_000,
    stockPercent: 60
  });
  const taxProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Florida" });
  const planYears = 5;
  const plan = simulatePlan({
    assets,
    scenario: {
      planYears,
      targetSpend: 40_000,
      currentAge: 65,
      spouseAge: 65,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile,
    returnSequence: Array.from({ length: planYears }, () => ({ stock: 0.05, bond: 0.03 })),
    inflationSequence: Array.from({ length: planYears }, () => 0.02)
  });

  assert.ok(plan && Array.isArray(plan.years), "plan has a years array");
  assert.equal(plan.years.length, planYears);
  const ending = plan.years.at(-1);
  assert.ok(Number.isFinite(ending.endingPortfolioValue ?? ending.portfolioValue ?? ending.endingValue),
    "final year reports a finite portfolio value");
});
