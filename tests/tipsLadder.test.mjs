// Engine unit tests for the opt-in TIPS bond ladder (scenario.tipsLadder).
//
// The ladder is a one-time carve-out at plan start of N held-to-maturity,
// inflation-indexed rungs (assetClass "tips", tagged with `tipsLadderYear`).
// Rungs are deterministic — exempt from market-return sampling, repriced from
//   price = inflationIndex / (1 + realYield)^(yearsToMaturity)
// — and excluded from rebalancing, asset-location, reserve counting, Roth
// conversions, and ordinary withdrawals. Maturities sell through the normal
// withdrawal machinery before RMDs and credit against the owner's forced RMD.
//
// Everything here is deterministic (stdev 0, no Monte Carlo).

import assert from "node:assert/strict";
import test from "node:test";

import { simulatePlan } from "../src/core/simulation.mjs";
import {
  buildTipsLadder,
  isTipsLadderRung,
  repriceTipsLadderRungs,
  tipsLadderConfig,
  tipsLadderValue
} from "../src/core/simulation/tipsLadder.mjs";

const assertClose = (actual, expected, tolerance = 0.01, message) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be within ${tolerance} of ${expected}`
  );
};

const flatZeroSingleProfile = () => ({
  filingStatus: "single",
  standardDeduction: 0,
  capitalLossOrdinaryIncomeOffset: 3000,
  ordinaryBrackets: [{ upTo: Infinity, rate: 0 }],
  capitalGainsBrackets: [{ upTo: Infinity, rate: 0 }],
  state: {
    standardDeduction: 0,
    brackets: [{ upTo: Infinity, rate: 0 }],
    treatCapitalGainsAsOrdinary: true
  }
});

// The verified reference profile: single filer, $15k standard deduction, flat
// 10% ordinary bracket, 0%/15% capital-gains brackets, no state tax.
const goldenProfile = () => ({
  filingStatus: "single",
  standardDeduction: 15000,
  capitalLossOrdinaryIncomeOffset: 3000,
  ordinaryBrackets: [{ upTo: Infinity, rate: 0.1 }],
  capitalGainsBrackets: [{ upTo: 50000, rate: 0 }, { upTo: Infinity, rate: 0.15 }],
  state: {
    standardDeduction: 0,
    brackets: [{ upTo: Infinity, rate: 0 }],
    treatCapitalGainsAsOrdinary: true
  }
});

const deterministicAssumptions = ({ stockMean = 0.05, inflationMean = 0.025 } = {}) => ({
  stock: { mean: stockMean, stdev: 0 },
  bond: { mean: 0.03, stdev: 0 },
  cash: { mean: 0.02, stdev: 0 },
  tips: { mean: 0.02, stdev: 0 },
  inflation: { mean: inflationMean, stdev: 0 }
});

const quietScenario = (overrides = {}) => ({
  startYear: 2026,
  targetSpendIncludesTaxes: false,
  targetSpendIncludesMedical: false,
  aca: { enabled: false },
  medicare: { irmaaEnabled: false },
  rothConversion: { enabled: false },
  taxLossHarvesting: { enabled: false },
  taxGainHarvesting: { enabled: false },
  returnAssumptions: deterministicAssumptions(),
  ...overrides
});

// The verified golden scenario: single 62-year-old, 15-year plan, 8-rung
// ladder of $60k real at a 2% locked real yield, 2.5% deterministic inflation.
const goldenScenario = (overrides = {}) => quietScenario({
  currentAge: 62,
  planYears: 15,
  targetSpend: 80000,
  tipsLadder: { enabled: true, years: 8, annualRealAmount: 60000, realYieldPercent: 2 },
  ...overrides
});

const goldenAssets = () => [
  { id: "trad-stock", accountType: "traditional", assetClass: "stock", units: 900000, price: 1, costBasisPerUnit: 1 },
  { id: "trad-bond", accountType: "traditional", assetClass: "bond", units: 400000, price: 1, costBasisPerUnit: 1 },
  { id: "tx-stock", accountType: "taxable", assetClass: "stock", units: 500000, price: 1, costBasisPerUnit: 0.6 }
];

const rungLots = (assets) => assets.filter((asset) => asset.id.startsWith("tips-ladder-"));

// ─── Config normalization ────────────────────────────────────────────────────

test("tipsLadderConfig defaults, opt-in gate, and input clamps", () => {
  assert.deepEqual(tipsLadderConfig({}), {
    enabled: false,
    years: 10,
    annualRealAmount: null,
    realYield: 0.02
  });
  // enabled requires a literal true.
  assert.equal(tipsLadderConfig({ tipsLadder: { enabled: "true" } }).enabled, false);
  assert.equal(tipsLadderConfig({ tipsLadder: { enabled: true } }).enabled, true);
  // years clamp to [1, 40]; real yield clamps to [-2%, 8%]; non-positive
  // annualRealAmount falls back to null (auto-size from base spending).
  const clamped = tipsLadderConfig({ tipsLadder: { enabled: true, years: 99, annualRealAmount: -5, realYieldPercent: 12 } });
  assert.equal(clamped.years, 40);
  assert.equal(clamped.annualRealAmount, null);
  assert.equal(clamped.realYield, 0.08);
  assert.equal(tipsLadderConfig({ tipsLadder: { years: 0 } }).years, 1);
  assert.equal(tipsLadderConfig({ tipsLadder: { realYieldPercent: -9 } }).realYield, -0.02);
});

// ─── buildTipsLadder + repriceTipsLadderRungs unit behavior ──────────────────

test("buildTipsLadder creates tagged rung lots and reprices on the closed form", () => {
  const portfolio = [
    { id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 100000, price: 1, costBasisPerUnit: 1 }
  ];
  const scenario = { tipsLadder: { enabled: true, years: 2, annualRealAmount: 10000, realYieldPercent: 2 } };
  const build = buildTipsLadder({ portfolio, scenario, age: 50, baseAnnualSpending: 0, inflationIndex: 1 });

  assert.equal(build.requestedYears, 2);
  assert.equal(build.fundedYears, 2);
  assert.equal(build.shortfall, 0);
  // Rung cost = face / (1+realYield)^k.
  assertClose(build.totalCost, 10000 / 1.02 + 10000 / (1.02 ** 2), 0.001);

  const rungs = portfolio.filter((asset) => isTipsLadderRung(asset));
  assert.equal(rungs.length, 2);
  assert.deepEqual(rungs.map((rung) => rung.tipsLadderYear), [1, 2]);
  for (const rung of rungs) {
    assert.equal(rung.assetClass, "tips");
    assert.equal(rung.accountType, "taxable");
    assertClose(rung.units, 10000, 0.001, "units carry the rung's real face amount");
  }
  assert.equal(isTipsLadderRung(portfolio[0]), false);
  assertClose(tipsLadderValue(portfolio), build.totalCost, 0.001);

  // Deterministic repricing: at yearIndex 1 with cumulative inflation 1.03,
  // the maturing rung is worth exactly face × inflationIndex; the year-2 rung
  // is discounted one year at the locked real yield.
  repriceTipsLadderRungs(portfolio, { scenario, yearIndex: 1, inflationIndex: 1.03 });
  const [rung1, rung2] = rungs;
  assertClose(rung1.price * rung1.units, 10300, 0.001);
  assertClose(rung2.price * rung2.units, 10000 * 1.03 / 1.02, 0.001);
});

// ─── Golden ladder math (verified reference numbers) ─────────────────────────

test("golden: 8-year $60k ladder build cost, value path, and maturities", () => {
  const plan = simulatePlan({ assets: goldenAssets(), scenario: goldenScenario(), taxProfile: goldenProfile() });
  const year0 = plan.years[0];

  // Build: annuity-style total cost 60000 × (1 − 1.02^−8) / 0.02.
  const expectedTotalCost = 60000 * (1 - Math.pow(1.02, -8)) / 0.02; // ≈ 439528.88643
  assert.equal(year0.tipsLadder.build.requestedYears, 8);
  assert.equal(year0.tipsLadder.build.fundedYears, 8);
  assert.equal(year0.tipsLadder.build.annualRealAmount, 60000);
  assert.equal(year0.tipsLadder.build.realYield, 0.02);
  assert.equal(year0.tipsLadder.build.shortfall, 0);
  assertClose(year0.tipsLadder.build.totalCost, expectedTotalCost, 0.001);
  assertClose(year0.tipsLadder.value, expectedTotalCost, 0.001);
  // The build block reports only on year 0.
  assert.equal(plan.years[1].tipsLadder.build, null);

  // Maturities: rung k pays face × 1.025^k (real face indexed by inflation).
  for (let k = 1; k <= 8; k += 1) {
    assertClose(plan.years[k].tipsLadder.maturedCash, 60000 * Math.pow(1.025, k), 0.01, `maturity year ${k}`);
  }
  assertClose(plan.years[1].tipsLadder.maturedCash, 61500, 0.01);
  assertClose(plan.years[2].tipsLadder.maturedCash, 63037.5, 0.01);
  assertClose(plan.years[3].tipsLadder.maturedCash, 64613.4378, 0.01);

  // Ladder value declines monotonically and is exhausted at yearIndex 8.
  for (let k = 1; k <= 8; k += 1) {
    assert.ok(plan.years[k].tipsLadder.value < plan.years[k - 1].tipsLadder.value, `value declines at year ${k}`);
  }
  for (let k = 8; k < plan.years.length; k += 1) {
    assert.equal(plan.years[k].tipsLadder.value, 0, `value 0 from yearIndex 8 (year ${k})`);
  }
  for (let k = 9; k < plan.years.length; k += 1) {
    assert.equal(plan.years[k].tipsLadder.maturedCash, 0, `no maturities after the ladder ends (year ${k})`);
  }

  // Maturities are NOT forced RMDs: rmdAmount stays 0 through the pre-RMD
  // ages (62–70) even while maturedCash > 0.
  for (let k = 0; k <= 8; k += 1) {
    assert.equal(plan.years[k].rmdAmount, 0, `pre-RMD rmdAmount stays 0 (year ${k})`);
  }
});

// ─── Deterministic immunity ──────────────────────────────────────────────────

test("rungs never see market returns: ladder path is identical while stocks crater", () => {
  const assets = () => [
    { id: "trad-stock", accountType: "traditional", assetClass: "stock", units: 900000, price: 1, costBasisPerUnit: 1 },
    { id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 1500000, price: 1, costBasisPerUnit: 1 }
  ];
  const run = (stockMean) => simulatePlan({
    assets: assets(),
    scenario: quietScenario({
      currentAge: 62,
      planYears: 10,
      targetSpend: 60000,
      returnAssumptions: deterministicAssumptions({ stockMean }),
      tipsLadder: { enabled: true, years: 8, annualRealAmount: 60000, realYieldPercent: 2 }
    }),
    taxProfile: flatZeroSingleProfile()
  });

  const normal = run(0.05);
  const crash = run(-0.5); // -50%/yr: the equity sleeve craters
  assert.deepEqual(
    crash.years.map((year) => year.tipsLadder.value),
    normal.years.map((year) => year.tipsLadder.value),
    "ladder value path is independent of sampled returns"
  );
  assert.deepEqual(
    crash.years.map((year) => year.tipsLadder.maturedCash),
    normal.years.map((year) => year.tipsLadder.maturedCash)
  );
  assert.ok(
    crash.years.at(-1).endingPortfolioValue < normal.years.at(-1).endingPortfolioValue * 0.8,
    "the rest of the portfolio craters under the extreme mean"
  );
});

// ─── Penalty-aware placement ─────────────────────────────────────────────────

test("rungs maturing before 59.5 fund taxable-first and mature penalty-free", () => {
  const plan = simulatePlan({
    assets: [
      { id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 1500000, price: 1, costBasisPerUnit: 1 },
      { id: "trad-bond", accountType: "traditional", assetClass: "bond", units: 800000, price: 1, costBasisPerUnit: 1 }
    ],
    scenario: quietScenario({
      currentAge: 50,
      planYears: 10,
      targetSpend: 30000,
      returnAssumptions: deterministicAssumptions({ inflationMean: 0 }),
      // All 9 rungs mature at ages 51..59 — before the 59.5 penalty age.
      tipsLadder: { enabled: true, years: 9, annualRealAmount: 40000, realYieldPercent: 2 }
    }),
    taxProfile: flatZeroSingleProfile()
  });

  const rungs = rungLots(plan.years[0].assets);
  assert.equal(rungs.length, 9);
  for (const rung of rungs) {
    assert.equal(rung.accountType, "taxable", `${rung.id} placed taxable to avoid the early-withdrawal penalty`);
  }

  // Maturity at age 51: a taxable capital-gains sale, no penalty.
  const year1 = plan.years[1];
  assert.equal(year1.tipsLadder.maturedCash, 40000);
  assert.equal(year1.penaltyTax, 0);
  assert.equal(year1.penaltyBase, 0);
  const rungSale = year1.sales.find((sale) => String(sale.assetId).startsWith("tips-ladder-"));
  assert.ok(rungSale, "maturity sells through the withdrawal machinery");
  assert.equal(rungSale.accountType, "taxable");
  assert.equal(rungSale.taxType, "capital-gains");
});

test("taxable ladder funding is attributed to the ladder, not gain harvesting", () => {
  const plan = simulatePlan({
    assets: [
      { id: "tx-stock", accountType: "taxable", assetClass: "stock", units: 200000, price: 1, costBasisPerUnit: 0.2, holdingPeriod: "long" }
    ],
    scenario: quietScenario({
      currentAge: 50,
      planYears: 2,
      targetSpend: 1000,
      returnAssumptions: deterministicAssumptions({ stockMean: 0, inflationMean: 0 }),
      tipsLadder: { enabled: true, years: 1, annualRealAmount: 100000, realYieldPercent: 0 }
    }),
    taxProfile: goldenProfile()
  });

  const year0 = plan.years[0];
  assert.ok(year0.realizedLongTermGains > 80000, "funding sale creates taxable capital gains");
  assert.equal(year0.taxGainHarvested, 0, "TIPS funding must not render as tax-gain harvesting");
  assert.ok(
    year0.taxAttribution.some((entry) => entry.source === "TIPS ladder funding"),
    "tax attribution should identify the ladder funding sale"
  );
  assert.equal(
    year0.taxAttribution.some((entry) => entry.source === "Tax gain harvesting"),
    false,
    "tax-gain harvesting is disabled and should not receive ladder gains"
  );
});

test("rungs maturing after 59.5 fund traditional-first and mature as ordinary income", () => {
  const plan = simulatePlan({
    assets: [
      { id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 1500000, price: 1, costBasisPerUnit: 1 },
      { id: "trad-bond", accountType: "traditional", assetClass: "bond", units: 800000, price: 1, costBasisPerUnit: 1 }
    ],
    scenario: quietScenario({
      currentAge: 62,
      planYears: 6,
      targetSpend: 30000,
      returnAssumptions: deterministicAssumptions({ inflationMean: 0 }),
      tipsLadder: { enabled: true, years: 4, annualRealAmount: 40000, realYieldPercent: 2 }
    }),
    taxProfile: flatZeroSingleProfile()
  });

  const rungs = rungLots(plan.years[0].assets);
  assert.equal(rungs.length, 4);
  for (const rung of rungs) {
    assert.equal(rung.accountType, "traditional", `${rung.id} belongs in tax-deferred space`);
  }

  const year1 = plan.years[1];
  assert.equal(year1.tipsLadder.maturedCash, 40000);
  const rungSale = year1.sales.find((sale) => String(sale.assetId).startsWith("tips-ladder-"));
  assert.ok(rungSale);
  assert.equal(rungSale.accountType, "traditional");
  assert.equal(rungSale.taxType, "ordinary");
  // The maturity is the year's only AGI source under the flat-zero profile.
  assertClose(year1.federalAgi, 40000, 0.01);
});

// ─── RMD credit ──────────────────────────────────────────────────────────────

test("traditional maturities credit against the forced RMD instead of stacking on it", () => {
  // Age 74, RMD already active. Inflation 0 + cash mean 2% + real yield 2%
  // keep the traditional balance path identical with and without the ladder,
  // so per-year RMD requirements line up exactly.
  const assets = () => [
    { id: "trad-cash", accountType: "traditional", assetClass: "cash", units: 2000000, price: 1, costBasisPerUnit: 1 },
    { id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 500000, price: 1, costBasisPerUnit: 1 }
  ];
  const base = quietScenario({
    currentAge: 74,
    planYears: 6,
    targetSpend: 20000,
    returnAssumptions: deterministicAssumptions({ inflationMean: 0 })
  });
  const taxProfile = flatZeroSingleProfile();
  const without = simulatePlan({ assets: assets(), scenario: base, taxProfile });
  const withLadder = simulatePlan({
    assets: assets(),
    scenario: { ...base, tipsLadder: { enabled: true, years: 4, annualRealAmount: 20000, realYieldPercent: 2 } },
    taxProfile
  });

  for (let k = 1; k <= 4; k += 1) {
    const on = withLadder.years[k];
    const off = without.years[k];
    assertClose(on.rmdRequired, off.rmdRequired, 0.001, `same RMD requirement (year ${k})`);
    assert.equal(on.tipsLadder.maturedCash, 20000);
    // RMD > maturity: forced sale shrinks by exactly the maturity, so the
    // total traditional distribution equals the requirement — not required +
    // maturity.
    assertClose(on.rmdAmount + on.tipsLadder.maturedCash, on.rmdRequired, 0.001, `no double-forcing (year ${k})`);
    assert.ok(on.rmdAmount <= off.rmdAmount + 0.001, `ladder never increases the forced RMD sale (year ${k})`);
    // Ordinary-income consistency: total traditional distributions match, so
    // AGI matches the no-ladder plan.
    assertClose(on.federalAgi, off.federalAgi, 0.001, `AGI consistency (year ${k})`);
  }
  // rmdAmount excludes the ladder cash; the year result carries it separately.
  assert.ok(withLadder.years[1].rmdAmount < withLadder.years[1].rmdRequired);
});

test("spouse-owned traditional maturities credit against the spouse RMD bucket", () => {
  const plan = simulatePlan({
    assets: [
      { id: "trad-spouse", accountType: "traditional", assetClass: "cash", units: 2_000_000, price: 1, costBasisPerUnit: 1, owner: "spouse" },
      { id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 500_000, price: 1, costBasisPerUnit: 1 }
    ],
    scenario: quietScenario({
      currentAge: 74,
      spouseAge: 76,
      planYears: 3,
      targetSpend: 20_000,
      returnAssumptions: deterministicAssumptions({ inflationMean: 0 }),
      tipsLadder: { enabled: true, years: 2, annualRealAmount: 20_000, realYieldPercent: 2 }
    }),
    taxProfile: { ...flatZeroSingleProfile(), filingStatus: "marriedFilingJointly" }
  });

  const year1 = plan.years[1];
  assert.equal(year1.tipsLadder.maturedCash, 20_000);
  assert.ok(year1.rmdByOwner.spouse.amount > year1.tipsLadder.maturedCash);
  assertClose(
    year1.rmdAmount + year1.tipsLadder.maturedCash,
    year1.rmdRequired,
    0.001,
    "spouse ladder maturity must reduce spouse forced RMD sale"
  );
  assert.ok(year1.rmdAmount < year1.rmdByOwner.spouse.amount);
});

// ─── Rebalance exclusion ─────────────────────────────────────────────────────

test("allocation rebalancing leaves ladder rungs untouched", () => {
  const plan = simulatePlan({
    assets: [
      { id: "trad-stock", accountType: "traditional", assetClass: "stock", units: 700000, price: 1, costBasisPerUnit: 1 },
      { id: "trad-bond", accountType: "traditional", assetClass: "bond", units: 700000, price: 1, costBasisPerUnit: 1 },
      { id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 300000, price: 1, costBasisPerUnit: 1 }
    ],
    scenario: quietScenario({
      currentAge: 62,
      planYears: 3,
      targetSpend: 20000,
      returnAssumptions: deterministicAssumptions({ inflationMean: 0 }),
      allocationStrategy: { rebalanceEnabled: true, targetStockPercent: 70, rebalanceBandPercent: 0 },
      tipsLadder: { enabled: true, years: 5, annualRealAmount: 50000, realYieldPercent: 2 }
    }),
    taxProfile: flatZeroSingleProfile()
  });

  const year0 = plan.years[0];
  const rungs = rungLots(year0.assets);
  assert.equal(rungs.length, 5, "all five rungs survive the year-0 rebalance");
  const rungValue = rungs.reduce((sum, rung) => sum + rung.value, 0);
  assertClose(rungValue, year0.tipsLadder.value, 0.01, "ladder value is exactly the surviving rung lots");
  assert.ok(rungValue > 0);
  // The rebalance hit its stock target on the NON-rung portfolio.
  const nonRung = year0.assets.filter((asset) => !asset.id.startsWith("tips-ladder-"));
  const nonRungTotal = nonRung.reduce((sum, asset) => sum + asset.value, 0);
  const nonRungStock = nonRung.filter((asset) => asset.assetClass === "stock").reduce((sum, asset) => sum + asset.value, 0);
  assertClose(nonRungStock / nonRungTotal, 0.7, 0.02, "stock target measured ex-ladder");
});

// ─── Insufficient funds ──────────────────────────────────────────────────────

test("a portfolio too small for the ladder reports a shortfall and never goes negative", () => {
  const plan = simulatePlan({
    assets: [{ id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 50000, price: 1, costBasisPerUnit: 1 }],
    scenario: quietScenario({
      currentAge: 62,
      planYears: 3,
      targetSpend: 10000,
      tipsLadder: { enabled: true, years: 10, annualRealAmount: 60000, realYieldPercent: 2 }
    }),
    taxProfile: flatZeroSingleProfile()
  });

  const build = plan.years[0].tipsLadder.build;
  assert.equal(build.requestedYears, 10);
  assert.ok(build.fundedYears < build.requestedYears, "cannot fund 10 × $60k from $50k");
  assert.ok(build.shortfall > 0);
  assert.ok(build.totalCost > 0);
  // No negative lots anywhere; the partially-funded rung is a real, positive lot.
  for (const year of plan.years) {
    for (const asset of year.assets) {
      assert.ok(asset.units >= 0, `${asset.id} units never negative`);
      assert.ok(asset.value >= 0, `${asset.id} value never negative`);
    }
  }
  // The forced last-resort path may break rungs rather than leave year 0
  // unfunded: spending is still met.
  assert.equal(plan.years[0].unfunded, 0);
});

// ─── Post-mortality stub years ───────────────────────────────────────────────

test("year.tipsLadder is null on post-mortality stub years even when enabled", () => {
  const plan = simulatePlan({
    assets: [{ id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 500000, price: 1, costBasisPerUnit: 1 }],
    scenario: quietScenario({
      currentAge: 80,
      planYears: 4,
      targetSpend: 20000,
      primaryMortalityAge: 81,
      heirType: "nonSpouse10Yr",
      tipsLadder: { enabled: true, years: 2, annualRealAmount: 10000, realYieldPercent: 2 }
    }),
    taxProfile: flatZeroSingleProfile()
  });
  // Ages 80–81 are living years; the portfolio freezes after death at 81.
  assert.ok(plan.years[0].tipsLadder !== null);
  assert.ok(plan.years[1].tipsLadder !== null);
  assert.equal(plan.years[2].postMortality, true);
  assert.equal(plan.years[2].tipsLadder, null);
  assert.equal(plan.years[3].tipsLadder, null);
});

// ─── Heir / terminal valuation ───────────────────────────────────────────────

test("rung lots count toward endingPortfolioValue like any other asset", () => {
  const assets = () => [
    { id: "trad-cash", accountType: "traditional", assetClass: "cash", units: 1000000, price: 1, costBasisPerUnit: 1 },
    { id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 500000, price: 1, costBasisPerUnit: 1 }
  ];
  const base = quietScenario({ currentAge: 62, planYears: 2, targetSpend: 20000 });
  const taxProfile = flatZeroSingleProfile();
  const off = simulatePlan({ assets: assets(), scenario: base, taxProfile });
  const on = simulatePlan({
    assets: assets(),
    // Traditional-only funding (in-account conversion, no taxable sales), so
    // the carve-out must be value-neutral at year-end.
    scenario: { ...base, tipsLadder: { enabled: true, years: 5, annualRealAmount: 40000, realYieldPercent: 2 } },
    taxProfile
  });

  const year0 = on.years[0];
  const rungValue = rungLots(year0.assets).reduce((sum, rung) => sum + rung.value, 0);
  assert.ok(rungValue > 0);
  // endingPortfolioValue is the sum of ending lots INCLUDING the rungs…
  assertClose(year0.assets.reduce((sum, asset) => sum + asset.value, 0), year0.endingPortfolioValue, 0.01);
  // …and matches the no-ladder plan within rounding (nothing leaked).
  assertClose(year0.endingPortfolioValue, off.years[0].endingPortfolioValue, 0.01);
});
