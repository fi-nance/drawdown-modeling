// Regression tests for HSA distribution modeling.
//
// Bug fixed: with qualified-expense tracking off (the old default), every HSA
// withdrawal was unlimited and tax-free at any age — strictly more generous
// than a Roth and far more generous than IRC §223. The default is now:
// - HSA withdrawals are tax-free only against the tracked qualified-expense
//   pool (starting balance + accrued modeled medical costs).
// - Before 65 the engine never sells beyond the pool (a penalized
//   nonqualified distribution is never a planning recommendation).
// - At 65+ the excess IS distributable, taxed as ordinary income with no
//   additional tax (IRC §223(f)(4)(C)) — the standard "HSA behaves like a
//   traditional IRA after 65" planning treatment.
// - Explicit `hsaUseForQualifiedExpenses: false` keeps the legacy unlimited
//   tax-free behavior as a documented escape hatch.

import assert from "node:assert/strict";
import test from "node:test";

import { withdrawForCash } from "../src/core/simulation/withdrawalExecution.mjs?v=20260612-aca-conversions";
import { hsaQualifiedExpenseAvailableForWithdrawal, hsaStrategyConfig } from "../src/core/simulation/hsa.mjs";
import { simulatePlan, DEFAULT_SCENARIO } from "../src/core/simulation.mjs?v=20260612-aca-conversions";
import { buildTaxProfile } from "../src/data/taxData.mjs";

const hsaLot = () => [
  { id: "hsa-stock", accountType: "hsa", assetClass: "stock", units: 100, price: 100, costBasisPerUnit: 50 }
];

// ─── strategy config defaults ────────────────────────────────────────────────

test("qualified-expense tracking is the default; explicit false is the legacy opt-out", () => {
  assert.equal(hsaStrategyConfig({}).useForQualifiedExpenses, true);
  assert.equal(DEFAULT_SCENARIO.taxEfficiencyStrategy.hsaUseForQualifiedExpenses, true);
  assert.equal(
    hsaStrategyConfig({ taxEfficiencyStrategy: { hsaUseForQualifiedExpenses: false } }).useForQualifiedExpenses,
    false
  );
  // Contribution strategy still forces tracking on even with the opt-out.
  assert.equal(
    hsaStrategyConfig({ taxEfficiencyStrategy: { hsaUseForQualifiedExpenses: false, hsaContributionEnabled: true } }).useForQualifiedExpenses,
    true
  );
});

test("hsaQualifiedExpenseAvailableForWithdrawal caps by default and is unlimited only on opt-out", () => {
  assert.equal(
    hsaQualifiedExpenseAvailableForWithdrawal({ scenario: {}, hsaQualifiedExpenseBalance: 1000, medicalEstimate: 500 }),
    1500
  );
  assert.equal(
    hsaQualifiedExpenseAvailableForWithdrawal({
      scenario: { taxEfficiencyStrategy: { hsaUseForQualifiedExpenses: false } },
      hsaQualifiedExpenseBalance: 1000,
      medicalEstimate: 500
    }),
    Infinity
  );
});

// ─── withdrawForCash unit behavior ──────────────────────────────────────────

test("before 65, HSA withdrawals stop at the qualified-expense pool", () => {
  const withdrawal = withdrawForCash(hsaLot(), 5000, ["hsa"], {
    age: 60,
    calendarYear: 2026,
    hsaQualifiedExpenseAvailable: 2000
  });
  assert.equal(withdrawal.cashRaised, 2000);
  assert.equal(withdrawal.hsaProceeds, 2000);
  assert.equal(withdrawal.hsaQualifiedExpenseUsed, 2000);
  assert.equal(withdrawal.ordinaryIncome, 0);
  assert.equal(withdrawal.penaltyTax, 0);
});

test("at 65+, the excess over the qualified pool is ordinary income with no penalty (IRC §223(f)(4)(C))", () => {
  const withdrawal = withdrawForCash(hsaLot(), 5000, ["hsa"], {
    age: 66,
    calendarYear: 2026,
    hsaQualifiedExpenseAvailable: 2000
  });
  assert.equal(withdrawal.cashRaised, 5000);
  assert.equal(withdrawal.hsaProceeds, 5000);
  assert.equal(withdrawal.hsaQualifiedExpenseUsed, 2000);
  assert.equal(withdrawal.ordinaryIncome, 3000);
  assert.equal(withdrawal.penaltyTax, 0);
  const sale = withdrawal.sales.find((entry) => entry.accountType === "hsa");
  assert.equal(sale.taxType, "hsa-ordinary");
  assert.equal(sale.ordinaryIncome, 3000);
});

test("at 65+ with no qualified pool, the whole distribution is ordinary income", () => {
  const withdrawal = withdrawForCash(hsaLot(), 4000, ["hsa"], {
    age: 70,
    calendarYear: 2026,
    hsaQualifiedExpenseAvailable: 0
  });
  assert.equal(withdrawal.cashRaised, 4000);
  assert.equal(withdrawal.ordinaryIncome, 4000);
  assert.equal(withdrawal.penaltyTax, 0);
});

test("legacy opt-out (unlimited availability) stays tax-free at any age", () => {
  const withdrawal = withdrawForCash(hsaLot(), 5000, ["hsa"], {
    age: 60,
    calendarYear: 2026,
    hsaQualifiedExpenseAvailable: Infinity
  });
  assert.equal(withdrawal.cashRaised, 5000);
  assert.equal(withdrawal.ordinaryIncome, 0);
  assert.equal(withdrawal.penaltyTax, 0);
});

// ─── end-to-end via simulatePlan ────────────────────────────────────────────

const flatTenPercentProfile = {
  filingStatus: "single",
  standardDeduction: 0,
  capitalLossOrdinaryIncomeOffset: 3000,
  ordinaryBrackets: [{ upTo: Infinity, rate: 0.1 }],
  capitalGainsBrackets: [{ upTo: Infinity, rate: 0.1 }],
  state: {
    standardDeduction: 0,
    brackets: [{ upTo: Infinity, rate: 0 }],
    treatCapitalGainsAsOrdinary: true
  }
};

const hsaOnlyScenario = (overrides = {}) => ({
  planYears: 1,
  startYear: 2026,
  targetSpend: 10000,
  withdrawalOrder: ["hsa"],
  rothConversion: { enabled: false },
  taxLossHarvesting: { enabled: false },
  taxGainHarvesting: { enabled: false },
  aca: { enabled: false },
  medicare: { irmaaEnabled: false },
  ...overrides
});

const hsaCash = () => [
  { id: "hsa-cash", accountType: "hsa", assetClass: "cash", units: 100000, price: 1, costBasisPerUnit: 1 }
];

test("before 65, spending cannot be funded from an HSA beyond tracked qualified expenses", () => {
  const plan = simulatePlan({
    assets: hsaCash(),
    scenario: hsaOnlyScenario({ currentAge: 60 }),
    taxProfile: flatTenPercentProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  const year = plan.years[0];
  // No medical costs modeled → qualified pool is empty → HSA is unspendable.
  assert.equal(year.hsaWithdrawals, 0);
  assert.equal(year.unfunded, 10000);

  // A starting qualified-expense balance opens exactly that much room.
  const withReceipts = simulatePlan({
    assets: hsaCash(),
    scenario: hsaOnlyScenario({
      currentAge: 60,
      taxEfficiencyStrategy: { startingHsaQualifiedExpenseBalance: 4000 }
    }),
    taxProfile: flatTenPercentProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  assert.equal(withReceipts.years[0].hsaWithdrawals, 4000);
  assert.equal(withReceipts.years[0].unfunded, 6000);
  assert.equal(withReceipts.years[0].taxes.totalTax, 0);
});

test("at 65+, HSA spending beyond the qualified pool is grossed up and taxed as ordinary income", () => {
  const plan = simulatePlan({
    assets: hsaCash(),
    scenario: hsaOnlyScenario({ currentAge: 66 }),
    taxProfile: flatTenPercentProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  const year = plan.years[0];
  // Need $10,000 of spending plus 10% flat tax on the ordinary HSA income:
  // x = 10000 + 0.1x → x ≈ 11,111.11.
  assert.ok(Math.abs(year.hsaWithdrawals - 11111.11) < 2, `hsaWithdrawals ${year.hsaWithdrawals}`);
  assert.ok(Math.abs(year.taxes.totalTax - 1111.11) < 2, `totalTax ${year.taxes.totalTax}`);
  assert.equal(year.unfunded, 0);
  assert.equal(year.penaltyTax, 0);
  // The tax attribution names the HSA as the source.
  assert.ok(year.taxAttribution.some((entry) => entry.source === "HSA nonqualified withdrawals"));
});

test("65+ nonqualified HSA income is NOT state retirement income (Illinois still taxes it)", () => {
  // Illinois excludes pension/IRA retirement income, but a nonqualified HSA
  // distribution is ordinary income with no retirement character — it must
  // stay in the state base rather than ride the retirement exclusion.
  const plan = simulatePlan({
    assets: hsaCash(),
    scenario: hsaOnlyScenario({ currentAge: 66 }),
    taxProfile: buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Illinois" }),
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  const year = plan.years[0];
  assert.ok(year.hsaWithdrawals > 10000, `expected grossed-up HSA withdrawal, got ${year.hsaWithdrawals}`);
  assert.ok(year.taxes.stateTax > 0, `Illinois must tax HSA ordinary income (stateTax ${year.taxes.stateTax})`);
});

test("legacy opt-out scenario flag preserves unlimited tax-free HSA spending", () => {
  const plan = simulatePlan({
    assets: hsaCash(),
    scenario: hsaOnlyScenario({
      currentAge: 60,
      taxEfficiencyStrategy: { hsaUseForQualifiedExpenses: false }
    }),
    taxProfile: flatTenPercentProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  const year = plan.years[0];
  assert.equal(year.hsaWithdrawals, 10000);
  assert.equal(year.taxes.totalTax, 0);
  assert.equal(year.unfunded, 0);
});

test("the qualified-expense pool accrues modeled medical costs and is drawn down by qualified use", () => {
  const plan = simulatePlan({
    assets: hsaCash(),
    scenario: hsaOnlyScenario({
      currentAge: 60,
      planYears: 2,
      targetSpend: 3000,
      medicalExpensesBase: 5000
    }),
    taxProfile: flatTenPercentProfile,
    returnSequence: [{ cash: 0 }, { cash: 0 }],
    inflationSequence: [0, 0]
  });
  const [year1, year2] = plan.years;
  // Year 1 needs $3,000 spending + $5,000 medical = $8,000, but only $5,000
  // (this year's medical) is qualified-available — the engine withdraws up to
  // the pool and leaves the rest unfunded.
  assert.equal(year1.hsaWithdrawals, 5000);
  assert.equal(year1.unfunded, 3000);
  assert.equal(year1.hsaQualifiedExpenseBalance, 0);
  // Year 2 accrues another $5,000 of qualified medical room.
  assert.equal(year2.hsaWithdrawals, 5000);
});
