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
// Post-build maintenance (scenario.tipsLadder.maintenanceMode) runs on years
// >= 1, before the allocation rebalance and the maturity-spend step:
//   "none"            (default) build once, deplete.
//   "always"          buy every missing rung out to `years` of coverage.
//   "stocks-up"       same purchase, but only when the year's stock return is
//                     ABOVE triggerStockReturnPercent; replenishCatchUp=false
//                     limits it to the single far rung (gaps stay gaps).
//   "spend-on-stress" never purchases; a maturing rung is spent only when
//                     stock return <= trigger, otherwise it rolls `years`
//                     ahead at the locked real yield.
//
// Everything here is deterministic (stdev 0 or explicit sequences, no Monte
// Carlo).

import assert from "node:assert/strict";
import test from "node:test";

import { simulatePlan } from "../src/core/simulation.mjs";
import { mergeScenario } from "../src/core/simulation/scenario.mjs";
import {
  buildTipsLadder,
  isTipsLadderRung,
  payTipsLadderCoupons,
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
    realYield: 0.02,
    maintenanceMode: "none",
    // Like `enabled`, the raw normalizer requires a literal true; the
    // user-facing "defaults on" lives in DEFAULT_SCENARIO (see the
    // maintenance-defaults test below).
    replenishCatchUp: false,
    triggerStockReturn: 0
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
  // Par coupon bonds: each rung costs its inflation-adjusted principal (face ×
  // inflationIndex), no zero-coupon discount, since the real yield is paid as a
  // cash coupon rather than baked into the purchase price.
  assertClose(build.totalCost, 10000 + 10000, 0.001);

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

  // Deterministic repricing: at cumulative inflation 1.03 every rung is worth
  // exactly its inflation-adjusted principal (face × inflationIndex) — par,
  // with no real-yield discounting (the yield comes out as coupons).
  repriceTipsLadderRungs(portfolio, { yearIndex: 1, inflationIndex: 1.03 });
  const [rung1, rung2] = rungs;
  assertClose(rung1.price * rung1.units, 10300, 0.001);
  assertClose(rung2.price * rung2.units, 10300, 0.001);

  // The locked 2% real yield is paid as a cash coupon on the inflation-adjusted
  // principal — usable, taxable income, not trapped in the bond.
  const coupons = payTipsLadderCoupons(portfolio, { scenario, inflationIndex: 1.03 });
  assertClose(coupons.taxableCouponCash, 0.02 * (10300 + 10300), 0.001);
});

// ─── Golden ladder math (verified reference numbers) ─────────────────────────

test("golden: 8-year $60k ladder build cost, value path, and maturities", () => {
  const plan = simulatePlan({ assets: goldenAssets(), scenario: goldenScenario(), taxProfile: goldenProfile() });
  const year0 = plan.years[0];

  // Build: par coupon bonds — total cost is 8 years of inflation-adjusted
  // principal at the year-0 index (1.0), i.e. 8 × 60000. The real yield is paid
  // out as cash coupons over the life rather than discounting the purchase.
  const expectedTotalCost = 8 * 60000; // 480000
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

  // Maturity at age 51: penalty-free, and a ~0-gain sale. The rung is a par
  // coupon bond, so with zero inflation its principal doesn't change (no phantom
  // income) and the maturity returns par at ~0 capital gain — the locked 2% real
  // yield was paid out as a usable cash coupon along the way instead.
  const year1 = plan.years[1];
  assert.equal(year1.tipsLadder.maturedCash, 40000);
  assert.equal(year1.penaltyTax, 0);
  assert.equal(year1.penaltyBase, 0);
  assert.ok(year1.tipsLadder.taxableCouponCash > 0, "the real yield is paid as a usable, taxable cash coupon");
  const rungSale = year1.sales.find((sale) => String(sale.assetId).startsWith("tips-ladder-"));
  assert.ok(rungSale, "maturity sells through the withdrawal machinery");
  assert.equal(rungSale.accountType, "taxable");
  assert.equal(rungSale.taxType, "none");
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
  // The $1.5M taxable cash sleeve also earns 2% current interest.
  assertClose(year1.federalAgi, 40000 + 30000, 0.01);
});

test("the real-yield coupon is taxed on taxable rungs every year, but not on sheltered rungs", () => {
  const base = {
    currentAge: 62,
    planYears: 4,
    targetSpend: 0,
    // Isolate ladder coupons from interest on retained maturity proceeds.
    returnAssumptions: { ...deterministicAssumptions({ inflationMean: 0 }), cash: { mean: 0, stdev: 0 } },
    tipsLadder: { enabled: true, years: 3, annualRealAmount: 40000, realYieldPercent: 2 }
  };

  // Sheltered (Roth) rungs: the coupon is reinvested as cash INSIDE the Roth, so
  // it is never taxable income (and, with zero inflation, there is no phantom
  // income either).
  const roth = simulatePlan({
    assets: [{ id: "roth-cash", accountType: "roth", assetClass: "cash", units: 1500000, price: 1, costBasisPerUnit: 1 }],
    scenario: quietScenario(base),
    taxProfile: flatZeroSingleProfile()
  });
  assert.ok(rungLots(roth.years[0].assets).every((rung) => rung.accountType === "roth"));
  for (let k = 1; k <= 3; k += 1) {
    assert.equal(roth.years[k].tipsLadder.phantomIncome, 0, `Roth rung accrues no phantom income (year ${k})`);
    assert.equal(roth.years[k].federalAgi, 0, `Roth ladder produces no taxable income (year ${k})`);
  }

  // Taxable rungs: the locked 2% real yield is paid as a cash coupon and taxed as
  // ordinary interest every year. With zero inflation (no phantom income), zero
  // spending and 0-gain maturities, that coupon is the ONLY thing in AGI —
  // proving the real yield is realized as usable, taxed cash, not trapped.
  const taxable = simulatePlan({
    assets: [{ id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 1500000, price: 1, costBasisPerUnit: 1 }],
    scenario: quietScenario(base),
    taxProfile: flatZeroSingleProfile()
  });
  assert.ok(rungLots(taxable.years[0].assets).every((rung) => rung.accountType === "taxable"));
  for (let k = 1; k <= 3; k += 1) {
    const y = taxable.years[k];
    assert.equal(y.tipsLadder.phantomIncome, 0, `no phantom income with zero inflation (year ${k})`);
    assert.ok(y.tipsLadder.taxableCouponCash > 0, `the real yield is paid as a taxable cash coupon (year ${k})`);
    assertClose(y.federalAgi, y.tipsLadder.taxableCouponCash, 0.01, `the coupon is the only taxed income (year ${k})`);
  }
});

test("sheltered rungs pay their coupon into in-account cash, and the build year pays none", () => {
  const plan = simulatePlan({
    assets: [{ id: "trad-cash", accountType: "traditional", assetClass: "cash", units: 2000000, price: 1, costBasisPerUnit: 1 }],
    scenario: quietScenario({
      currentAge: 65,
      planYears: 5,
      targetSpend: 20000,
      returnAssumptions: deterministicAssumptions({ inflationMean: 0 }),
      tipsLadder: { enabled: true, years: 3, annualRealAmount: 30000, realYieldPercent: 2 }
    }),
    taxProfile: flatZeroSingleProfile()
  });

  // Year 0 is the build year — rungs are created AFTER the coupon step, so no
  // coupon is paid (and none would be on bonds bought that instant anyway).
  assert.equal(plan.years[0].tipsLadder.couponIncome, 0);

  // Year 1: 3 par rungs of 30000 each → a 2% coupon on 90000 = 1800, entirely
  // sheltered (a traditional rung's coupon is not household cash).
  assertClose(plan.years[1].tipsLadder.couponIncome, 1800, 0.5);
  assert.equal(plan.years[1].tipsLadder.taxableCouponCash, 0);

  // The coupon is deposited as ordinary cash inside the traditional account —
  // a growing, rebalanceable/withdrawable lot, not trapped in the bond.
  const couponLot = plan.years[2].assets.find((asset) => String(asset.id).startsWith("tips-coupon-cash-traditional"));
  assert.ok(couponLot && couponLot.units > 0, "sheltered coupon accrues to an in-account cash lot");
  assert.equal(couponLot.accountType, "traditional");
  assert.equal(couponLot.assetClass, "cash");
});

// ─── RMD credit ──────────────────────────────────────────────────────────────

test("traditional maturities credit against the forced RMD instead of stacking on it", () => {
  // Age 74, RMD already active. A traditional rung's maturity is itself a
  // distribution, so it COUNTS toward the year's RMD: the forced (non-rung) sale
  // shrinks by exactly the maturity, and the household is never forced to
  // distribute requirement + maturity.
  const withLadder = simulatePlan({
    assets: [
      { id: "trad-cash", accountType: "traditional", assetClass: "cash", units: 2000000, price: 1, costBasisPerUnit: 1 },
      { id: "tx-cash", accountType: "taxable", assetClass: "cash", units: 500000, price: 1, costBasisPerUnit: 1 }
    ],
    scenario: quietScenario({
      currentAge: 74,
      planYears: 6,
      targetSpend: 20000,
      returnAssumptions: deterministicAssumptions({ inflationMean: 0 }),
      tipsLadder: { enabled: true, years: 4, annualRealAmount: 20000, realYieldPercent: 2 }
    }),
    taxProfile: flatZeroSingleProfile()
  });

  for (let k = 1; k <= 4; k += 1) {
    const on = withLadder.years[k];
    assert.equal(on.tipsLadder.maturedCash, 20000);
    // The maturity covers part of the RMD, so the forced sale is positive but
    // strictly below the requirement.
    assert.ok(on.rmdAmount > 0 && on.rmdAmount < on.rmdRequired, `maturity covers part of the RMD (year ${k})`);
    // No double-forcing: forced sale + maturity equals the requirement exactly,
    // not requirement + maturity.
    assertClose(on.rmdAmount + on.tipsLadder.maturedCash, on.rmdRequired, 0.001, `no double-forcing (year ${k})`);
  }
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

// ─── Maintenance modes (verified reference trace) ────────────────────────────
//
// Reference setup: 65-year-old single filer, $1.2M traditional stock + $600k
// traditional bond, a 5-year $50k-real ladder at a 2% locked real yield, 2%
// deterministic inflation, and an explicit stock sequence of +10% with a
// three-year -15% drawdown in years 1-3 (stress under the default trigger 0).
// Bonds 3%, cash 2%, tips 2% every year. All rungs land traditional (age 65 →
// traditional-first), so build/replenish/roll are in-account conversions and
// the trace is tax-free and exactly reproducible.

const maintenanceProfile = () => ({
  filingStatus: "single",
  standardDeduction: 15000,
  brackets: [{ rate: 0.1, upTo: null }],
  capitalGainsBrackets: [{ rate: 0, upTo: null }],
  state: { type: "none" }
});

const maintenanceAssets = () => [
  { id: "trad-stock", accountType: "traditional", assetClass: "stock", units: 1200000, price: 1, costBasisPerUnit: 1 },
  { id: "trad-bond", accountType: "traditional", assetClass: "bond", units: 600000, price: 1, costBasisPerUnit: 1 }
];

// Stock crashes -15% in years 1-3 and gains +10% otherwise.
const crashThenRecover = (yearIndex) => (yearIndex >= 1 && yearIndex <= 3 ? -0.15 : 0.10);

const runMaintenance = ({
  ladder = {},
  overrides = {},
  assets = maintenanceAssets(),
  stockFor = crashThenRecover,
  years = 12
} = {}) => simulatePlan({
  assets,
  scenario: quietScenario({
    currentAge: 65,
    spouseAge: null,
    planYears: years,
    returnAssumptions: {
      stock: { mean: 0.06, stdev: 0 },
      bond: { mean: 0.03, stdev: 0 },
      cash: { mean: 0.02, stdev: 0 },
      tips: { mean: 0.02, stdev: 0 },
      inflation: { mean: 0.02, stdev: 0 }
    },
    tipsLadder: { enabled: true, years: 5, annualRealAmount: 50000, realYieldPercent: 2, ...ladder },
    ...overrides
  }),
  taxProfile: maintenanceProfile(),
  returnSequence: Array.from({ length: years }, (_, yearIndex) => ({
    stock: stockFor(yearIndex),
    bond: 0.03,
    cash: 0.02,
    tips: 0.02
  })),
  inflationSequence: Array.from({ length: years }, () => 0.02)
});

const kRound = (value) => Math.round(value / 1000);
// Ladder value and maturity cash for years 0..8, rounded to k$ — the verified
// reference trace format.
const ladderTrace = (plan) => ({
  value: plan.years.slice(0, 9).map((year) => kRound(year.tipsLadder.value)),
  maturedCash: plan.years.slice(0, 9).map((year) => kRound(year.tipsLadder.maturedCash))
});

test("maintenance defaults: no mode → maintenance null everywhere, ladder depletes", () => {
  const plan = runMaintenance();
  // Without a maintenanceMode every year reports maintenance: null…
  for (const year of plan.years) {
    assert.equal(year.tipsLadder.maintenance, null);
  }
  // …and the ladder builds once and depletes (the pre-maintenance behavior).
  assert.deepEqual(ladderTrace(plan), {
    value: [250, 204, 156, 106, 54, 0, 0, 0, 0],
    maturedCash: [0, 51, 52, 53, 54, 55, 0, 0, 0]
  });

  // Config layering: the raw normalizer falls back to mode "none" / trigger 0
  // and (like `enabled`) only honors a literal replenishCatchUp: true, while
  // DEFAULT_SCENARIO — applied by mergeScenario inside simulatePlan — makes
  // catch-up the user-facing default.
  const raw = tipsLadderConfig({});
  assert.equal(raw.maintenanceMode, "none");
  assert.equal(raw.replenishCatchUp, false);
  assert.equal(raw.triggerStockReturn, 0);
  const merged = tipsLadderConfig(mergeScenario({}));
  assert.equal(merged.maintenanceMode, "none");
  assert.equal(merged.replenishCatchUp, true);
  assert.equal(merged.triggerStockReturn, 0);
  // Unknown modes collapse to "none"; the trigger is a clamped percent input.
  assert.equal(tipsLadderConfig({ tipsLadder: { maintenanceMode: "sometimes" } }).maintenanceMode, "none");
  assert.equal(tipsLadderConfig({ tipsLadder: { triggerStockReturnPercent: -20 } }).triggerStockReturn, -0.2);
  assert.equal(tipsLadderConfig({ tipsLadder: { triggerStockReturnPercent: -200 } }).triggerStockReturn, -0.95);
  assert.equal(tipsLadderConfig({ tipsLadder: { triggerStockReturnPercent: 200 } }).triggerStockReturn, 0.95);
});

test("always: one new far rung per year — coverage and maturities never lapse", () => {
  const plan = runMaintenance({ ladder: { maintenanceMode: "always" } });
  assert.deepEqual(ladderTrace(plan), {
    value: [250, 255, 260, 265, 271, 276, 282, 287, 293],
    maturedCash: [0, 51, 52, 53, 54, 55, 56, 57, 59]
  });
  // Maintenance never runs on year 0, even with a mode set.
  assert.equal(plan.years[0].tipsLadder.maintenance, null);
  for (let k = 1; k <= 8; k += 1) {
    const maintenance = plan.years[k].tipsLadder.maintenance;
    assert.equal(maintenance.mode, "always");
    assert.equal(maintenance.replenishedCount, 1, `one replacement rung per year (year ${k})`);
    assert.ok(maintenance.replenishedCost > 0);
    assert.equal(maintenance.rolledCount, 0, "always-mode buys, never rolls");
    assert.equal(maintenance.shortfall, 0);
    // The stress flag mirrors the stock sequence under the default trigger 0.
    assert.equal(maintenance.stressYear, k <= 3, `stress flag (year ${k})`);
    // Maturity cash is exactly face × cumulative inflation, uninterrupted.
    assertClose(plan.years[k].tipsLadder.maturedCash, 50000 * Math.pow(1.02, k), 0.01, `maturity year ${k}`);
  }
  // Down-year purchases fund defensive-first: year 1's purchase leaves the
  // stock lot exactly on its -15% path.
  const stock0 = plan.years[0].assets.find((asset) => asset.id === "trad-stock");
  const stock1 = plan.years[1].assets.find((asset) => asset.id === "trad-stock");
  assertClose(stock1.value, stock0.value * 0.85, 0.01, "down-year replenishment does not touch stock");
});

test("stocks-up without catch-up: stress years skip purchases and leave permanent gaps", () => {
  const plan = runMaintenance({ ladder: { maintenanceMode: "stocks-up", replenishCatchUp: false } });
  assert.deepEqual(ladderTrace(plan), {
    value: [250, 204, 156, 106, 108, 110, 169, 230, 293],
    maturedCash: [0, 51, 52, 53, 54, 55, 0, 0, 0]
  });
  // Stress years 1-3 (-15% <= trigger 0): no purchase at all.
  for (let k = 1; k <= 3; k += 1) {
    const maintenance = plan.years[k].tipsLadder.maintenance;
    assert.equal(maintenance.stressYear, true, `year ${k} is a stress year`);
    assert.equal(maintenance.replenishedCount, 0, `no purchase in stress year ${k}`);
    assert.equal(maintenance.replenishedCost, 0);
  }
  // Recovery years 4+: exactly one far rung each — no buying back years 6-8.
  for (let k = 4; k <= 8; k += 1) {
    const maintenance = plan.years[k].tipsLadder.maintenance;
    assert.equal(maintenance.stressYear, false);
    assert.equal(maintenance.replenishedCount, 1, `single far rung in year ${k}`);
  }
  // The skipped stress years are permanent maturity gaps (years 6-8)…
  for (let k = 6; k <= 8; k += 1) {
    assert.equal(plan.years[k].tipsLadder.maturedCash, 0, `gap year ${k}`);
  }
  // …while the ladder rebuilds at the far end (rungs for years 9+).
  assert.ok(plan.years[8].tipsLadder.value > plan.years[5].tipsLadder.value, "far-end rebuild");
});

test("stocks-up with catch-up (the merged default): the first up year buys back every missed rung", () => {
  const explicit = runMaintenance({ ladder: { maintenanceMode: "stocks-up", replenishCatchUp: true } });
  assert.deepEqual(ladderTrace(explicit), {
    value: [250, 204, 156, 106, 271, 276, 282, 287, 293],
    maturedCash: [0, 51, 52, 53, 54, 55, 56, 57, 59]
  });
  // Year 4 — the first recovery year — catches up all three missed rungs
  // (years 6-8) plus the regular far rung (year 9).
  assert.equal(explicit.years[4].tipsLadder.maintenance.replenishedCount, 4, "catch-up purchase");
  for (let k = 5; k <= 8; k += 1) {
    assert.equal(explicit.years[k].tipsLadder.maintenance.replenishedCount, 1, `steady state (year ${k})`);
  }
  // Maturities are uninterrupted through year 8.
  for (let k = 1; k <= 8; k += 1) {
    assert.ok(explicit.years[k].tipsLadder.maturedCash > 0, `maturity in year ${k}`);
  }
  // Leaving replenishCatchUp out reproduces the same plan: catch-up defaults
  // ON through the DEFAULT_SCENARIO merge.
  const defaulted = runMaintenance({ ladder: { maintenanceMode: "stocks-up" } });
  assert.deepEqual(ladderTrace(defaulted), ladderTrace(explicit));
  assert.equal(defaulted.years[4].tipsLadder.maintenance.replenishedCount, 4);
});

test("spend-on-stress: maturing rungs are spent in stress years and rolled forward otherwise", () => {
  const plan = runMaintenance({ ladder: { maintenanceMode: "spend-on-stress" } });
  assert.deepEqual(ladderTrace(plan), {
    value: [250, 204, 156, 106, 108, 110, 113, 115, 117],
    maturedCash: [0, 51, 52, 53, 0, 0, 0, 0, 0]
  });
  // Stress years 1-3: the maturing rung is consumed normally — and the mode
  // never purchases anything.
  for (let k = 1; k <= 3; k += 1) {
    const maintenance = plan.years[k].tipsLadder.maintenance;
    assert.equal(maintenance.stressYear, true);
    assert.equal(maintenance.rolledCount, 0, `stress year ${k} spends, not rolls`);
    assert.equal(maintenance.replenishedCount, 0, "spend-on-stress never purchases");
    assert.ok(plan.years[k].tipsLadder.maturedCash > 0, `maturity spent in stress year ${k}`);
  }
  // Recovery years 4-5: the maturing rung rolls 5 years ahead instead of
  // maturing into cash.
  for (const k of [4, 5]) {
    const maintenance = plan.years[k].tipsLadder.maintenance;
    assert.equal(maintenance.stressYear, false);
    assert.equal(maintenance.rolledCount, 1, `roll in year ${k}`);
    assert.ok(maintenance.rolledValue > 0);
    assert.equal(maintenance.replenishedCount, 0);
    assert.equal(plan.years[k].tipsLadder.maturedCash, 0, `no maturity cash in roll year ${k}`);
  }
  // Years 6-8: nothing matures (rungs 4-5 rolled out to years 9-10) — no
  // rolls, no maturities, but the ladder persists.
  for (let k = 6; k <= 8; k += 1) {
    assert.equal(plan.years[k].tipsLadder.maintenance.rolledCount, 0, `nothing to roll in year ${k}`);
    assert.equal(plan.years[k].tipsLadder.maturedCash, 0);
  }
  assert.ok(plan.years[8].tipsLadder.value > 0, "ladder persists through year 8");
  // A sheltered roll preserves value at roll time: year 4's ladder value
  // continues year 3's path (repricing drift only — no jump down).
  const ratio = plan.years[4].tipsLadder.value / plan.years[3].tipsLadder.value;
  assert.ok(ratio > 1 && ratio < 1.06, `value continuity across the roll (ratio ${ratio})`);
});

test("taxable rolls realize ~0 capital gain because accretion is taxed annually as phantom income", () => {
  // Taxable-only portfolio (age 65 prefers traditional space, but none
  // exists, so rungs land taxable), zero spending, all up years: every
  // maturing rung rolls. Because a taxable rung accretes ordinary phantom
  // income each year (basis stepped up to match), the roll SALE realizes ~0
  // capital gain — the appreciation was already taxed, year by year, not
  // deferred to the roll.
  const plan = runMaintenance({
    assets: [{ id: "tx-stock", accountType: "taxable", assetClass: "stock", units: 1500000, price: 1, costBasisPerUnit: 1 }],
    ladder: { maintenanceMode: "spend-on-stress" },
    overrides: { targetSpend: 0 },
    stockFor: () => 0.10
  });
  for (const rung of rungLots(plan.years[0].assets)) {
    assert.equal(rung.accountType, "taxable", `${rung.id} lands taxable`);
  }

  // Year 1: rung 1 (par cost 50000, matured value 50000 × 1.02) rolls. Its basis
  // tracks the inflation accretion (taxed as phantom income), so the roll's
  // realized capital gain is ~0 rather than the old deferred ≈1980 LTCG.
  const year1 = plan.years[1];
  assert.equal(year1.tipsLadder.maintenance.rolledCount, 1);
  assertClose(year1.tipsLadder.maintenance.rolledValue, 51000, 0.01);
  assertClose(year1.realizedLongTermGains, 0, 0.5, "roll realizes ~0 LTCG (accretion already taxed annually)");
  // Taxable rungs recognize their inflation adjustment as phantom income AND pay
  // the real yield as a cash coupon — both taxable, neither trapped in the bond.
  assert.ok(year1.tipsLadder.phantomIncome > 0, "taxable rungs recognize the inflation accretion as phantom income");
  assert.ok(year1.tipsLadder.taxableCouponCash > 0, "the real yield is paid as a cash coupon");

  // The repurchase is a NEW par lot at a fresh basis: the real face is PRESERVED
  // (the yield is harvested as coupons, not accreted into face), value preserved,
  // embedded gain zero.
  const rolled = year1.assets.find((asset) => asset.id === "tips-ladder-1-taxable-roll-1");
  assert.ok(rolled, "rolled rung repurchased as a new lot");
  assertClose(rolled.units, 50000, 0.01, "real face preserved at par (no (1+y)^years accretion)");
  assertClose(rolled.value, 51000, 0.01, "roll preserves the matured value");
  assertClose(rolled.unrealizedGain, 0, 0.01, "fresh basis after the roll");

  // Year 6: that rolled rung matures again and re-rolls — again ~0 realized
  // gain, because its interim (years 1→6) accretion was taxed annually.
  const year6 = plan.years[6];
  assert.equal(year6.tipsLadder.maintenance.rolledCount, 1);
  assertClose(year6.realizedLongTermGains, 0, 0.5, "second roll also realizes ~0 LTCG");
});

test("trigger semantics: stress means stock return <= triggerStockReturnPercent", () => {
  // Trigger -20%: a -15% year is NOT stress — stocks-up replenishment
  // proceeds straight through the drawdown…
  const lenient = runMaintenance({
    ladder: { maintenanceMode: "stocks-up", triggerStockReturnPercent: -20 },
    years: 5
  });
  for (let k = 1; k <= 3; k += 1) {
    const maintenance = lenient.years[k].tipsLadder.maintenance;
    assert.equal(maintenance.stressYear, false, `-15% is above the -20% trigger (year ${k})`);
    assert.equal(maintenance.replenishedCount, 1, `replenishment proceeds (year ${k})`);
  }
  // …and a spend-on-stress rung rolls instead of being spent.
  const lenientRoll = runMaintenance({
    ladder: { maintenanceMode: "spend-on-stress", triggerStockReturnPercent: -20 },
    years: 5
  });
  assert.equal(lenientRoll.years[1].tipsLadder.maintenance.stressYear, false);
  assert.equal(lenientRoll.years[1].tipsLadder.maintenance.rolledCount, 1, "rung rolls through the -15% year");
  assert.equal(lenientRoll.years[1].tipsLadder.maturedCash, 0);

  // Trigger +5%: a +4% year IS stress (4 <= 5) — stocks-up skips the
  // purchase…
  const mildYearOne = (yearIndex) => (yearIndex === 1 ? 0.04 : 0.10);
  const strict = runMaintenance({
    ladder: { maintenanceMode: "stocks-up", triggerStockReturnPercent: 5 },
    stockFor: mildYearOne,
    years: 5
  });
  assert.equal(strict.years[1].tipsLadder.maintenance.stressYear, true, "+4% is at-or-below the +5% trigger");
  assert.equal(strict.years[1].tipsLadder.maintenance.replenishedCount, 0);
  assert.equal(strict.years[2].tipsLadder.maintenance.stressYear, false, "+10% clears the +5% trigger");
  // …and spend-on-stress spends the maturing rung.
  const strictSpend = runMaintenance({
    ladder: { maintenanceMode: "spend-on-stress", triggerStockReturnPercent: 5 },
    stockFor: mildYearOne,
    years: 5
  });
  assert.equal(strictSpend.years[1].tipsLadder.maintenance.stressYear, true);
  assert.equal(strictSpend.years[1].tipsLadder.maintenance.rolledCount, 0);
  assert.ok(strictSpend.years[1].tipsLadder.maturedCash > 0, "the +4% stress year spends the rung");
});

test("replenishment after an up year harvests stock first", () => {
  // All up years, zero spending: year 1's only portfolio activity is the
  // maintenance purchase of the new far rung (maturity year 6) at par —
  // its inflation-adjusted principal 50000 × 1.02 = 51000 (no discount).
  const plan = runMaintenance({
    ladder: { maintenanceMode: "always" },
    overrides: { targetSpend: 0 },
    stockFor: () => 0.10,
    years: 4
  });
  const year0 = plan.years[0];
  const year1 = plan.years[1];
  const maintenance = year1.tipsLadder.maintenance;
  assert.equal(maintenance.replenishedCount, 1);
  assertClose(maintenance.replenishedCost, 50000 * 1.02, 0.01);

  const stock0 = year0.assets.find((asset) => asset.id === "trad-stock");
  const bond0 = year0.assets.find((asset) => asset.id === "trad-bond");
  const stock1 = year1.assets.find((asset) => asset.id === "trad-stock");
  const bond1 = year1.assets.find((asset) => asset.id === "trad-bond");
  // The purchase came out of STOCK (REPLENISH_UP_CLASS_PRIORITY inverts the
  // defensive-first build order to harvest the appreciated sleeve)…
  assertClose(stock1.value, stock0.value * 1.10 - maintenance.replenishedCost, 0.01, "stock funds the up-year purchase");
  // …while the bond lot rides its +3% return untouched.
  assertClose(bond1.value, bond0.value * 1.03, 0.01, "bond is left alone");
  // The funded value is reported as a traditional → ladder flow.
  const flow = year1.flows.find((entry) => entry.to === "TIPS ladder");
  assert.ok(flow, "maintenance purchase reports a flow");
  assert.equal(flow.from, "Traditional accounts");
  assertClose(flow.amount, maintenance.replenishedCost, 0.01);
});

// ─── deep-review regression pins ─────────────────────────────────────────────

const reviewTaxProfile = (filingStatus = "single") => ({
  filingStatus,
  standardDeduction: 15000,
  brackets: [{ rate: 0.1, upTo: null }],
  capitalGainsBrackets: [{ rate: 0, upTo: null }],
  state: { type: "none" }
});

const flatAssumptions = {
  stock: { mean: 0.05, stdev: 0 },
  bond: { mean: 0.03, stdev: 0 },
  cash: { mean: 0.02, stdev: 0 },
  tips: { mean: 0.02, stdev: 0 },
  inflation: { mean: 0.02, stdev: 0 }
};

test("legal RMDs are satisfied from ladder rungs when the non-rung sleeve runs dry (spend-on-stress)", () => {
  // Deep-review critical: with the IRA dominated by rolled rungs and stocks
  // up every year, the forced RMD sale used to find nothing sellable and
  // silently distributed $0 while an RMD was owed. The fallback pass now
  // breaks rungs (sorted last) for the unmet remainder.
  const plan = simulatePlan({
    assets: [
      { id: "ira", name: "IRA", accountType: "traditional", assetClass: "bond", units: 1, price: 800000, costBasisPerUnit: 800000 },
      { id: "tax", name: "Taxable", accountType: "taxable", assetClass: "stock", units: 1, price: 600000, costBasisPerUnit: 600000 }
    ],
    scenario: {
      startYear: 2026, planYears: 12, currentAge: 75, spouseAge: null, targetSpend: 60000,
      targetSpendIncludesTaxes: false, targetSpendIncludesMedical: false, aca: { enabled: false },
      returnAssumptions: flatAssumptions,
      tipsLadder: { enabled: true, years: 10, annualRealAmount: 80000, realYieldPercent: 2, maintenanceMode: "spend-on-stress" }
    },
    taxProfile: reviewTaxProfile()
  });
  for (const year of plan.years) {
    if (year.postMortality) continue;
    const distributed = (year.rmdAmount ?? 0) + (year.tipsLadder?.maturedCash ?? 0);
    assert.ok(
      distributed >= (year.rmdRequired ?? 0) - 0.01,
      `year ${year.calendarYear}: RMD ${year.rmdRequired} but only ${distributed} distributed`
    );
  }
});

test("rung placement is penalty-aware per OWNER: a younger spouse's IRA never funds penalty-bound rungs while taxable money exists", () => {
  // Deep-review major: placement keyed on the primary's age only, so a
  // 65/45 couple put rungs in the 45-year-old's IRA and ate a 10% penalty
  // at every maturity despite $1M of taxable funds.
  const plan = simulatePlan({
    assets: [
      { id: "sp-ira", name: "Spouse IRA", accountType: "traditional", assetClass: "bond", units: 1, price: 600000, costBasisPerUnit: 600000, owner: "spouse" },
      { id: "tax", name: "Taxable", accountType: "taxable", assetClass: "stock", units: 1, price: 1000000, costBasisPerUnit: 1000000 }
    ],
    scenario: {
      startYear: 2026, planYears: 7, currentAge: 65, spouseAge: 45, targetSpend: 60000,
      targetSpendIncludesTaxes: false, targetSpendIncludesMedical: false, aca: { enabled: false },
      returnAssumptions: flatAssumptions,
      tipsLadder: { enabled: true, years: 5, annualRealAmount: 50000, realYieldPercent: 2 }
    },
    taxProfile: reviewTaxProfile("marriedFilingJointly")
  });
  const totalPenalty = plan.years.reduce((sum, year) => sum + (year.penaltyTax ?? 0), 0);
  assert.equal(Math.round(totalPenalty * 100) / 100, 0, "no early-withdrawal penalties");
  const rungAccounts = [...new Set(
    plan.years[0].assets.filter((asset) => asset.id?.startsWith("tips-ladder")).map((asset) => asset.accountType)
  )];
  assert.deepEqual(rungAccounts, ["taxable"], "rungs avoid the under-59.5 spouse's IRA");
});

test("auto-sized replenishment falls back to the deflated base spending target after full depletion", () => {
  // Deep-review major: yearEngine used to pass baseAnnualSpending: 0, so a
  // ladder with annualRealAmount null could never replenish once no rungs
  // remained to derive a face from.
  const ladder = { enabled: true, years: 2, annualRealAmount: null, realYieldPercent: 2, maintenanceMode: "always" };
  const plan = simulatePlan({
    assets: [
      { id: "ira", name: "IRA", accountType: "traditional", assetClass: "bond", units: 1, price: 2000000, costBasisPerUnit: 2000000 }
    ],
    scenario: {
      startYear: 2026, planYears: 6, currentAge: 70, spouseAge: null, targetSpend: 40000,
      targetSpendIncludesTaxes: false, targetSpendIncludesMedical: false, aca: { enabled: false },
      returnAssumptions: flatAssumptions,
      tipsLadder: ladder
    },
    taxProfile: reviewTaxProfile()
  });
  for (const year of plan.years.slice(1, 5)) {
    assert.ok(year.tipsLadder.maintenance.replenishedCost > 0, "replenishment is sized from the base spending target");
  }
});
