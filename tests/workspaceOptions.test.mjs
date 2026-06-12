// Regression tests for the opt-in workspace options added to close the deep
// review's feature gaps. EVERY option defaults to current behavior — the
// first test family in each section pins the off-state, the rest pin the
// opt-in behavior.

import assert from "node:assert/strict";
import test from "node:test";

import { simulatePlan, runMonteCarlo, generateSingleMonteCarloPath } from "../src/core/simulation.mjs?v=20260612-aca-conversions";
import { withdrawForCash } from "../src/core/simulation/withdrawalExecution.mjs?v=20260612-aca-conversions";
import { incomeStreamsForYear } from "../src/core/simulation/incomeStreams.mjs";
import { householdRmdForYear } from "../src/core/simulation/rmd.mjs";
import { mergeScenario } from "../src/core/simulation/scenario.mjs";
import { applySurvivorBasisStepUp } from "../src/core/portfolio.mjs";
import { computeIncomeTax } from "../src/core/tax.mjs?v=20260612-aca-conversions";
import { buildTaxProfile } from "../src/data/taxData.mjs";
import { parsePortfolioCsv } from "../src/core/importers.mjs";
import { createSetupBackup, parseSetupBackup } from "../src/core/setupBackup.mjs";

const flatZeroProfile = (filingStatus = "marriedFilingJointly") => ({
  filingStatus,
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

const cashAsset = (overrides = {}) => ({
  id: "cash",
  accountType: "taxable",
  assetClass: "cash",
  units: 2000000,
  price: 1,
  costBasisPerUnit: 1,
  ...overrides
});

const zeroSequences = (years) => ({
  returnSequence: Array.from({ length: years }, () => ({ cash: 0, stock: 0 })),
  inflationSequence: Array.from({ length: years }, () => 0)
});

const quietScenario = (overrides = {}) => ({
  startYear: 2026,
  targetSpend: 10000,
  rothConversion: { enabled: false },
  taxLossHarvesting: { enabled: false },
  taxGainHarvesting: { enabled: false },
  aca: { enabled: false },
  medicare: { irmaaEnabled: false },
  ...overrides
});

// ─── AR(1) inflation persistence ─────────────────────────────────────────────

test("inflation persistence 0 (or absent) is bit-identical to the historical i.i.d. draws", () => {
  const assets = [cashAsset()];
  const scenario = quietScenario({ planYears: 30, currentAge: 60, targetSpend: 20000 });
  const absent = runMonteCarlo({ assets, scenario, runs: 5, seed: 11 });
  const explicitZero = runMonteCarlo({ assets, scenario: { ...scenario, monteCarlo: { inflationPersistence: 0 } }, runs: 5, seed: 11 });
  assert.deepEqual(explicitZero.summary, absent.summary);
});

test("inflation persistence produces serially correlated inflation paths", () => {
  const assets = [cashAsset({ units: 5000000 })];
  const base = quietScenario({ planYears: 60, currentAge: 30, targetSpend: 1000 });
  const inflationSeries = (phi) => generateSingleMonteCarloPath({
    assets,
    scenario: { ...base, monteCarlo: { inflationPersistence: phi } },
    seed: 7,
    scenarioId: 1
  }).years.map((year) => year.assetClassReturns.inflation);
  const lag1 = (xs) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i += 1) {
      den += (xs[i] - mean) ** 2;
      if (i < xs.length - 1) num += (xs[i] - mean) * (xs[i + 1] - mean);
    }
    return num / den;
  };
  assert.ok(Math.abs(lag1(inflationSeries(0))) < 0.25, "i.i.d. draws should have ~zero autocorrelation");
  assert.ok(lag1(inflationSeries(0.85)) > 0.5, "phi=0.85 paths should be strongly autocorrelated");
});

// ─── Medigap / Medicare Advantage premium ────────────────────────────────────

test("medigapMonthlyPremium bills per Part B enrollee with no IRMAA adjustment", () => {
  const taxProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" });
  const base = quietScenario({
    planYears: 1,
    currentAge: 66,
    spouseAge: 67,
    targetSpend: 40000,
    medicare: {} // IRMAA enabled (default)
  });
  const run = (scenario) => simulatePlan({
    assets: [cashAsset()],
    scenario,
    taxProfile,
    ...zeroSequences(1)
  }).years[0];

  const without = run(base);
  const withMedigap = run({ ...base, medicare: { medigapMonthlyPremium: 200 } });
  assert.equal(withMedigap.medicare.medigapAnnualPremium, 200 * 12 * 2);
  assert.equal(
    Math.round((withMedigap.medicare.totalAnnualPremium - without.medicare.totalAnnualPremium) * 100) / 100,
    4800
  );
  assert.equal(without.medicare.medigapAnnualPremium, 0);
});

// ─── Long-term-care stress ───────────────────────────────────────────────────

test("LTC stress applies the medical-inflated cost only inside the member's age window", () => {
  const run = (scenario) => simulatePlan({
    assets: [cashAsset()],
    scenario,
    taxProfile: flatZeroProfile(),
    ...zeroSequences(4)
  }).years;

  const base = quietScenario({ planYears: 4, currentAge: 84, spouseAge: 84, targetSpend: 10000 });
  const off = run(base);
  assert.deepEqual(off.map((year) => year.ltcCost), [0, 0, 0, 0]);

  const on = run({ ...base, ltcStress: { enabled: true, startAge: 85, years: 2, annualCost: 50000 } });
  assert.deepEqual(on.map((year) => year.ltcCost), [0, 50000, 50000, 0]);
  assert.equal(on[1].medicalCost - off[1].medicalCost, 50000);

  // Spouse member uses the spouse's age clock.
  const spouse = run({
    ...base,
    currentAge: 60,
    spouseAge: 84,
    ltcStress: { enabled: true, member: "spouse", startAge: 85, years: 2, annualCost: 50000 }
  });
  assert.deepEqual(spouse.map((year) => year.ltcCost), [0, 50000, 50000, 0]);
});

test("LTC stress reports no cost when targetSpendIncludesMedical bypasses medical cash flow", () => {
  const run = (scenario) => simulatePlan({
    assets: [cashAsset()],
    scenario,
    taxProfile: flatZeroProfile(),
    ...zeroSequences(2)
  }).years;
  const base = quietScenario({ planYears: 2, currentAge: 85, targetSpend: 10000, targetSpendIncludesMedical: true });
  const off = run(base);
  const on = run({ ...base, ltcStress: { enabled: true, startAge: 85, years: 2, annualCost: 50000 } });
  // The stress cost never reaches spending under targetSpendIncludesMedical
  // (see KNOWN_LIMITATIONS), so the year rows must not report a phantom charge.
  assert.deepEqual(on.map((year) => year.ltcCost), [0, 0]);
  assert.deepEqual(
    on.map((year) => year.endingPortfolioValue),
    off.map((year) => year.endingPortfolioValue)
  );
});

// ─── Age-banded spending (retirement smile) ──────────────────────────────────

test("age-banded spending scales fixed-mode spending by phase and is off by default", () => {
  const run = (scenario) => simulatePlan({
    assets: [cashAsset()],
    scenario,
    taxProfile: flatZeroProfile(),
    ...zeroSequences(3)
  }).years;

  const base = quietScenario({ planYears: 3, currentAge: 74, targetSpend: 10000 });
  assert.deepEqual(run(base).map((year) => year.plannedSpending), [10000, 10000, 10000]);

  const smile = run({
    ...base,
    agePhasedSpending: { enabled: true, slowGoAge: 75, slowGoPercent: 80, noGoAge: 76, noGoPercent: 60 }
  });
  assert.deepEqual(smile.map((year) => year.plannedSpending), [10000, 8000, 6000]);
  assert.deepEqual(smile.map((year) => year.spendingPhase?.phase ?? null), ["go-go", "slow-go", "no-go"]);
});

test("age-banded spending does not alter dynamic strategies (Guyton-Klinger)", () => {
  const base = quietScenario({
    planYears: 3,
    currentAge: 74,
    targetSpend: 10000,
    spendingStrategy: { mode: "guytonKlinger" }
  });
  const run = (scenario) => simulatePlan({
    assets: [cashAsset()],
    scenario,
    taxProfile: flatZeroProfile(),
    ...zeroSequences(3)
  }).years.map((year) => year.plannedSpending);
  assert.deepEqual(
    run({ ...base, agePhasedSpending: { enabled: true, slowGoAge: 75, slowGoPercent: 50, noGoAge: 76, noGoPercent: 25 } }),
    run(base)
  );
});

// ─── Heir tax-law indexing control ───────────────────────────────────────────

test("heirTaxIndexing frozen2026 pins heir tax parameters at index 1", () => {
  const run = (heirTaxIndexing) => simulatePlan({
    assets: [{ id: "roth", accountType: "roth", assetClass: "cash", units: 100000, price: 1, costBasisPerUnit: 1 }],
    scenario: quietScenario({ planYears: 3, currentAge: 70, heirType: "nonSpouse10Yr", targetSpend: 1000, heirTaxIndexing }),
    taxProfile: buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Florida" }),
    returnSequence: Array.from({ length: 3 }, () => ({ cash: 0 })),
    inflationSequence: [0.1, 0.1, 0.1]
  }).heirValueBreakdown.heirTaxInflationIndex;

  assert.equal(run("indexed"), Math.round(1.1 * 1.1 * 1e6) / 1e6);
  assert.equal(run("frozen2026"), 1);
});

// ─── Account owner: per-owner RMDs ───────────────────────────────────────────

test("spouse-owned traditional accounts use the spouse's RMD age and factor", () => {
  // Spouse 76 (born 1950 → start 73, Uniform Lifetime factor 23.7); primary 70
  // (born 1956 → start 73, not yet required).
  const scenario = { startYear: 2026, currentAge: 70, spouseAge: 76, rmd: { enabled: true } };
  const rmd = householdRmdForYear({
    scenario,
    primaryAge: 70,
    spouseAge: 76,
    traditionalByOwner: { primary: 50000, spouse: 100000 }
  });
  assert.equal(rmd.byOwner.primary.amount, 0);
  assert.equal(rmd.byOwner.spouse.amount, Math.round((100000 / 23.7) * 1e6) / 1e6);
  assert.equal(rmd.amount, rmd.byOwner.spouse.amount);

  // No spouse age → single pooled bucket (the pre-owner behavior).
  const pooled = householdRmdForYear({
    scenario: { startYear: 2026, currentAge: 70, rmd: { enabled: true } },
    primaryAge: 70,
    spouseAge: null,
    traditionalByOwner: { primary: 50000, spouse: 100000 }
  });
  assert.equal(pooled.amount, 0); // primary 70 is below the start age for the whole pool
  assert.equal(pooled.byOwner.spouse, null);
});

test("simulatePlan withdraws the spouse RMD from spouse-owned traditional lots only", () => {
  const plan = simulatePlan({
    assets: [
      { id: "trad-primary", accountType: "traditional", assetClass: "cash", units: 50000, price: 1, costBasisPerUnit: 1 },
      { id: "trad-spouse", accountType: "traditional", assetClass: "cash", units: 100000, price: 1, costBasisPerUnit: 1, owner: "spouse" },
      cashAsset({ id: "spend-cash", units: 500000 })
    ],
    scenario: quietScenario({ planYears: 1, currentAge: 70, spouseAge: 76, targetSpend: 5000 }),
    taxProfile: flatZeroProfile(),
    ...zeroSequences(1)
  });
  const year = plan.years[0];
  const expectedSpouseRmd = Math.round((100000 / 23.7) * 1e6) / 1e6;
  assert.equal(year.rmdRequired, expectedSpouseRmd);
  assert.equal(year.rmdByOwner.spouse.amount, expectedSpouseRmd);
  assert.equal(year.rmdByOwner.primary.amount, 0);
  // The RMD sale came from the spouse-owned lot.
  const rmdSale = year.sales.find((sale) => sale.assetId === "trad-spouse");
  assert.ok(rmdSale && rmdSale.proceeds >= expectedSpouseRmd - 0.01);
});

test("survivor years pool the RMD clock under the SURVIVING spouse's start age", () => {
  // Primary born 1956 (start age 73); spouse born 1960 (SECURE 2.0 start 75).
  const scenario = { startYear: 2026, currentAge: 70, spouseAge: 66 };
  // Survivor years pass the spouse's age as primaryAge with spouseAge null.
  const survivorAt73 = householdRmdForYear({
    scenario,
    primaryAge: 73,
    spouseAge: null,
    traditionalByOwner: { primary: 100000, spouse: 100000 },
    survivorOwner: "spouse"
  });
  assert.equal(survivorAt73.startAge, 75);
  assert.equal(survivorAt73.amount, 0);
  const survivorAt75 = householdRmdForYear({
    scenario,
    primaryAge: 75,
    spouseAge: null,
    traditionalByOwner: { primary: 100000, spouse: 100000 },
    survivorOwner: "spouse"
  });
  assert.equal(survivorAt75.startAge, 75);
  assert.ok(survivorAt75.amount > 0);
  // No survivor hint (single household or surviving primary): primary clock.
  const survivingPrimary = householdRmdForYear({
    scenario,
    primaryAge: 73,
    spouseAge: null,
    traditionalByOwner: { primary: 100000, spouse: 100000 }
  });
  assert.equal(survivingPrimary.startAge, 73);
  assert.ok(survivingPrimary.amount > 0);
});

test("simulatePlan: after the primary's death, pooled RMDs wait for the spouse's start age", () => {
  const plan = simulatePlan({
    assets: [
      { id: "trad-spouse", accountType: "traditional", assetClass: "cash", units: 500000, price: 1, costBasisPerUnit: 1, owner: "spouse" },
      cashAsset({ id: "spend-cash", units: 200000 })
    ],
    scenario: quietScenario({
      planYears: 10,
      currentAge: 70, // primary born 1956 → start age 73
      spouseAge: 66, // spouse born 1960 → SECURE 2.0 start age 75
      primaryMortalityAge: 71, // dies at index 1; survivor years from index 2
      targetSpend: 1000
    }),
    taxProfile: buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" }),
    ...zeroSequences(10)
  });
  const required = plan.years.map((year) => year.rmdRequired);
  // The spouse turns 73 at index 7 — under the primary's (deceased) clock the
  // pooled IRA would start there. The spouse's own clock starts at 75.
  assert.deepEqual(required.slice(0, 9), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(required[9] > 0, `RMD must start at spouse age 75 (got ${required[9]})`);
});

// ─── Account owner: per-asset penalty and HSA ages ───────────────────────────

test("spouse-owned retirement lots use the spouse's age for the early-withdrawal penalty", () => {
  const portfolio = [
    { id: "trad-primary", accountType: "traditional", assetClass: "cash", units: 10000, price: 1, costBasisPerUnit: 1 },
    { id: "trad-spouse", accountType: "traditional", assetClass: "cash", units: 10000, price: 1, costBasisPerUnit: 1, owner: "spouse" }
  ];
  const withdrawal = withdrawForCash(portfolio, 20000, ["traditional"], {
    age: 50,
    ownerAges: { primary: 50, spouse: 62 },
    calendarYear: 2026,
    penaltyAge: 59.5,
    penaltyRate: 0.1
  });
  assert.equal(withdrawal.cashRaised, 20000);
  // Only the primary-owned $10,000 is penalized.
  assert.equal(withdrawal.penaltyBase, 10000);
  assert.equal(withdrawal.penaltyTax, 1000);
});

test("spouse-owned HSA lots use the spouse's age for the 65+ ordinary-distribution rule", () => {
  const portfolio = [
    { id: "hsa-spouse", accountType: "hsa", assetClass: "cash", units: 10000, price: 1, costBasisPerUnit: 1, owner: "spouse" }
  ];
  const withdrawal = withdrawForCash(portfolio, 5000, ["hsa"], {
    age: 60,
    ownerAges: { primary: 60, spouse: 66 },
    calendarYear: 2026,
    hsaQualifiedExpenseAvailable: 1000
  });
  // The 66-year-old spouse's HSA can distribute beyond the qualified pool as
  // ordinary income even though the primary is only 60.
  assert.equal(withdrawal.cashRaised, 5000);
  assert.equal(withdrawal.hsaQualifiedExpenseUsed, 1000);
  assert.equal(withdrawal.ordinaryIncome, 4000);
});

// ─── Account owner: survivor basis step-up ───────────────────────────────────

test("survivor step-up adjusts deceased-owned and joint taxable lots at the first death", () => {
  const assets = [
    { id: "tx-primary", accountType: "taxable", assetClass: "stock", units: 1, price: 100, costBasisPerUnit: 50 },
    { id: "tx-joint", accountType: "taxable", assetClass: "stock", units: 1, price: 100, costBasisPerUnit: 50, owner: "joint" },
    { id: "tx-spouse", accountType: "taxable", assetClass: "stock", units: 1, price: 100, costBasisPerUnit: 50, owner: "spouse" },
    cashAsset({ id: "spend-cash", units: 100000 })
  ];
  const scenario = quietScenario({
    planYears: 4,
    currentAge: 80,
    spouseAge: 70,
    primaryMortalityAge: 81,
    targetSpend: 1000,
    survivorStepUp: { enabled: true, jointBasisStepUpPercent: 50 }
  });
  const plan = simulatePlan({
    assets,
    scenario,
    taxProfile: buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" }),
    returnSequence: Array.from({ length: 4 }, () => ({ stock: 0, cash: 0 })),
    inflationSequence: [0, 0, 0, 0]
  });
  // Primary dies after age 81 → first survivor year is index 2; the snapshot
  // there reflects the step-up applied at the start of that year.
  const basisById = Object.fromEntries(
    plan.years[2].beginningAssets.map((asset) => [asset.id, asset.costBasis])
  );
  assert.equal(basisById["tx-primary"], 100); // full step-up (deceased-owned)
  assert.equal(basisById["tx-joint"], 75);    // half step-up
  assert.equal(basisById["tx-spouse"], 50);   // survivor-owned unchanged

  // Disabled (default): bases unchanged.
  const off = simulatePlan({
    assets,
    scenario: { ...scenario, survivorStepUp: { enabled: false } },
    taxProfile: buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" }),
    returnSequence: Array.from({ length: 4 }, () => ({ stock: 0, cash: 0 })),
    inflationSequence: [0, 0, 0, 0]
  });
  const offBasis = Object.fromEntries(off.years[2].beginningAssets.map((asset) => [asset.id, asset.costBasis]));
  assert.equal(offBasis["tx-primary"], 50);
  assert.equal(offBasis["tx-joint"], 50);
});

test("survivor step-up keeps a joint lot's holding period (only deceased-owned lots go long)", () => {
  const lots = [
    { id: "p", accountType: "taxable", assetClass: "stock", units: 1, price: 100, costBasisPerUnit: 50, holdingPeriod: "short", holdingPeriodResetCalendarYear: 2027 },
    { id: "j", accountType: "taxable", assetClass: "stock", units: 1, price: 100, costBasisPerUnit: 50, owner: "joint", holdingPeriod: "short", holdingPeriodResetCalendarYear: 2027 }
  ];
  applySurvivorBasisStepUp(lots, { deceasedOwner: "primary", jointStepUpPercent: 50 });
  // Deceased-owned lot: full step-up, §1223(9) long-term, TLH clock cleared.
  assert.equal(lots[0].costBasisPerUnit, 100);
  assert.equal(lots[0].holdingPeriod, "long");
  assert.equal(lots[0].holdingPeriodResetCalendarYear, undefined);
  // Joint lot: basis adjusts, but the survivor's half is NOT inherited — the
  // lot keeps its actual holding period and reset clock.
  assert.equal(lots[1].costBasisPerUnit, 75);
  assert.equal(lots[1].holdingPeriod, "short");
  assert.equal(lots[1].holdingPeriodResetCalendarYear, 2027);
});

// ─── Spouse earned income: per-person payroll taxes ──────────────────────────

test("spouse wages get their own Social Security wage base; combined AMT-A threshold", () => {
  const profile = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" });
  const pooled = computeIncomeTax({ ordinaryIncome: 300000, medicareWages: 300000, profile });
  const twoEarner = computeIncomeTax({ ordinaryIncome: 300000, medicareWages: 150000, spouseMedicareWages: 150000, profile });

  // One earner: SS tax caps at the $184,500 wage base. Two earners at $150k
  // each: both fully taxed (no cap binds).
  assert.equal(pooled.employeeSocialSecurityTax, Math.round(0.062 * 184500 * 1e6) / 1e6);
  assert.equal(
    twoEarner.employeeSocialSecurityTax + twoEarner.spouseEmployeeSocialSecurityTax,
    Math.round(0.062 * 300000 * 1e6) / 1e6
  );
  // Additional Medicare Tax applies to COMBINED wages either way (Form 8959).
  assert.equal(pooled.additionalMedicareTax, twoEarner.additionalMedicareTax);
  // Zero spouse inputs are bit-identical to the historical single-earner path.
  const zeroSpouse = computeIncomeTax({ ordinaryIncome: 300000, medicareWages: 300000, spouseMedicareWages: 0, profile });
  assert.equal(zeroSpouse.totalTax, pooled.totalTax);
});

test("spouse self-employment income gets its own Schedule SE computation and deduction", () => {
  const profile = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" });
  const result = computeIncomeTax({ ordinaryIncome: 60000, selfEmploymentIncome: 30000, spouseSelfEmploymentIncome: 30000, profile });
  const single = computeIncomeTax({ ordinaryIncome: 60000, selfEmploymentIncome: 30000, profile });
  // Two equal SE incomes below the wage base → exactly double the SE tax/deduction.
  assert.equal(result.selfEmploymentTax + result.spouseSelfEmploymentTax, single.selfEmploymentTax * 2);
  assert.equal(result.adjustmentsToIncome, single.adjustmentsToIncome * 2);
});

test("a deceased earner's wages stop in the first survivor year", () => {
  const run = (scenario) => simulatePlan({
    assets: [cashAsset()],
    scenario,
    taxProfile: buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" }),
    ...zeroSequences(4)
  }).years;
  const base = quietScenario({
    planYears: 4,
    currentAge: 60,
    spouseAge: 60,
    earnedIncomeInflationAdjusted: false,
    medicareWages: 30000,
    spouseMedicareWages: 50000
  });
  // Spouse dies at 61 (year index 1); survivor years from index 2 carry only
  // the primary's wages — earned income is life-gated per earner, like
  // recurring income streams.
  const spouseDies = run({ ...base, primaryMortalityAge: 120, spouseMortalityAge: 61 });
  assert.deepEqual(spouseDies.map((year) => year.earnedIncome), [80000, 80000, 30000, 30000]);
  // Symmetric: the primary's wages stop when the primary dies first.
  const primaryDies = run({ ...base, primaryMortalityAge: 61, spouseMortalityAge: 120 });
  assert.deepEqual(primaryDies.map((year) => year.earnedIncome), [80000, 80000, 50000, 50000]);
  assert.deepEqual(primaryDies.map((year) => year.medicareWages), [30000, 30000, 0, 0]);
});

// ─── Recurring income streams ────────────────────────────────────────────────

test("pension streams start at the owner's age, apply COLA, and continue at the survivor share", () => {
  const scenario = quietScenario({
    planYears: 4,
    currentAge: 64,
    spouseAge: 60,
    primaryMortalityAge: 65,
    incomeStreams: [{
      name: "County pension",
      type: "pension",
      owner: "primary",
      startAge: 65,
      annualAmount: 12000,
      inflationAdjusted: false,
      survivorPercent: 50
    }]
  });
  const plan = simulatePlan({
    assets: [cashAsset()],
    scenario,
    taxProfile: buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" }),
    ...zeroSequences(4)
  });
  const streamCash = plan.years.map((year) => year.streamIncome.cash);
  // Age 64: not started; 65: full; 66+ (owner deceased): 50% survivor share.
  assert.deepEqual(streamCash, [0, 12000, 6000, 6000]);
  assert.equal(plan.years[2].streamIncome.details[0].survivorShare, true);
});

test("tax-free streams add cash without entering AGI or ACA MAGI", () => {
  const plan = simulatePlan({
    assets: [cashAsset()],
    scenario: quietScenario({
      planYears: 1,
      currentAge: 60,
      targetSpend: 5000,
      incomeStreams: [{ type: "other", owner: "primary", startAge: 55, annualAmount: 12000, taxCharacter: "taxFree", inflationAdjusted: false }]
    }),
    taxProfile: buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Florida" }),
    ...zeroSequences(1)
  });
  const year = plan.years[0];
  assert.equal(year.streamIncome.cash, 12000);
  assert.equal(year.streamIncome.taxFreeIncome, 12000);
  assert.equal(year.federalAgi, 0);
  assert.equal(year.acaMagi, 0);
});

test("pension streams are state retirement income (Illinois excludes them); rent is not", () => {
  const ilProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Illinois" });
  const run = (stream) => simulatePlan({
    assets: [cashAsset()],
    scenario: quietScenario({ planYears: 1, currentAge: 70, targetSpend: 5000, incomeStreams: [stream] }),
    taxProfile: ilProfile,
    ...zeroSequences(1)
  }).years[0];

  const pensionYear = run({ type: "pension", owner: "primary", startAge: 65, annualAmount: 50000, inflationAdjusted: false });
  const rentYear = run({ type: "rent", owner: "primary", startAge: 65, annualAmount: 50000, inflationAdjusted: false });
  assert.equal(pensionYear.taxes.stateTax, 0, "Illinois excludes pension income");
  assert.ok(rentYear.taxes.stateTax > 0, "rental income stays state-taxable");
  // Federal treatment is identical for both.
  assert.equal(pensionYear.federalAgi, rentYear.federalAgi);
});

test("incomeStreamsForYear ignores spouse-owned streams when no spouse is modeled", () => {
  const result = incomeStreamsForYear({
    scenario: { currentAge: 70, spouseAge: null, incomeStreams: [{ type: "pension", owner: "spouse", startAge: 65, annualAmount: 10000 }] },
    yearIndex: 0,
    inflationIndex: 1
  });
  assert.equal(result.cash, 0);
});

// ─── Owner import aliases and setup round-trip ───────────────────────────────

test("portfolio imports map owner aliases and normalize joint retirement accounts", () => {
  const csv = [
    "name,accountType,units,price,owner",
    "Brokerage,taxable,10,100,JTWROS",
    "Spouse IRA,traditional,10,100,Spouse",
    "Bad joint IRA,traditional,10,100,Joint",
    "Untagged,taxable,10,100,"
  ].join("\n");
  const assets = parsePortfolioCsv(csv);
  assert.equal(assets[0].owner, "joint");
  assert.equal(assets[1].owner, "spouse");
  assert.equal(assets[2].owner, "primary", "joint retirement accounts normalize to primary");
  assert.equal(assets[3].owner, "primary");
});

test("setup backups round-trip income streams", () => {
  const backup = createSetupBackup({
    controls: {},
    assets: [],
    oneOffExpenses: [],
    incomeStreams: [{ name: "Pension", type: "pension", owner: "primary", startAge: 65, annualAmount: 24000 }]
  });
  const restored = parseSetupBackup(JSON.stringify(backup));
  assert.equal(restored.incomeStreams.length, 1);
  assert.equal(restored.incomeStreams[0].annualAmount, 24000);
});

// ─── TIPS bond ladder ────────────────────────────────────────────────────────

test("tipsLadder absent (or explicitly disabled with defaults) is bit-identical to the historical path", () => {
  const assets = [
    cashAsset({ id: "tx-cash", units: 800000 }),
    { id: "trad-bond", accountType: "traditional", assetClass: "bond", units: 400000, price: 1, costBasisPerUnit: 1 }
  ];
  const run = (scenario) => simulatePlan({
    assets,
    scenario,
    taxProfile: flatZeroProfile("single"),
    returnSequence: Array.from({ length: 3 }, () => ({ cash: 0, bond: 0 })),
    inflationSequence: [0, 0, 0]
  });
  const base = quietScenario({ planYears: 3, currentAge: 62, targetSpend: 20000 });
  const absent = run(base);
  const explicitOff = run({
    ...base,
    tipsLadder: { enabled: false, years: 10, annualRealAmount: null, realYieldPercent: 2 }
  });
  assert.deepEqual(explicitOff, absent);
  for (const year of absent.years) assert.equal(year.tipsLadder, null);
  for (const year of explicitOff.years) assert.equal(year.tipsLadder, null);
});

test("enabled tipsLadder builds the full ladder at year 0 and matures face × inflation index", () => {
  // Verified reference: single 62-year-old, 8 × $60k real at a 2% locked real
  // yield under deterministic 2.5% inflation.
  const plan = simulatePlan({
    assets: [
      { id: "trad-stock", accountType: "traditional", assetClass: "stock", units: 900000, price: 1, costBasisPerUnit: 1 },
      { id: "trad-bond", accountType: "traditional", assetClass: "bond", units: 400000, price: 1, costBasisPerUnit: 1 },
      { id: "tx-stock", accountType: "taxable", assetClass: "stock", units: 500000, price: 1, costBasisPerUnit: 0.6 }
    ],
    scenario: quietScenario({
      planYears: 15,
      currentAge: 62,
      targetSpend: 80000,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: false,
      returnAssumptions: {
        stock: { mean: 0.05, stdev: 0 },
        bond: { mean: 0.03, stdev: 0 },
        cash: { mean: 0.02, stdev: 0 },
        tips: { mean: 0.02, stdev: 0 },
        inflation: { mean: 0.025, stdev: 0 }
      },
      tipsLadder: { enabled: true, years: 8, annualRealAmount: 60000, realYieldPercent: 2 }
    }),
    taxProfile: {
      filingStatus: "single",
      standardDeduction: 15000,
      capitalLossOrdinaryIncomeOffset: 3000,
      ordinaryBrackets: [{ upTo: Infinity, rate: 0.1 }],
      capitalGainsBrackets: [{ upTo: 50000, rate: 0 }, { upTo: Infinity, rate: 0.15 }],
      state: { standardDeduction: 0, brackets: [{ upTo: Infinity, rate: 0 }], treatCapitalGainsAsOrdinary: true }
    }
  });

  const build = plan.years[0].tipsLadder.build;
  assert.equal(build.requestedYears, 8);
  assert.equal(build.fundedYears, 8);
  assert.equal(build.shortfall, 0);
  // Annuity closed form: 60000 × (1 − 1.02^−8) / 0.02 ≈ 439528.88643.
  const expectedCost = 60000 * (1 - Math.pow(1.02, -8)) / 0.02;
  assert.ok(Math.abs(build.totalCost - expectedCost) <= 0.001);
  assert.ok(plan.years[0].tipsLadder.value > 0);
  assert.ok(Math.abs(plan.years[0].tipsLadder.value - expectedCost) <= 0.001);

  // Maturities equal annualRealAmount × inflationIndex (60000 × 1.025^k).
  assert.ok(Math.abs(plan.years[1].tipsLadder.maturedCash - 61500) <= 0.01);
  assert.ok(Math.abs(plan.years[2].tipsLadder.maturedCash - 63037.5) <= 0.01);
  assert.ok(Math.abs(plan.years[3].tipsLadder.maturedCash - 64613.4378) <= 0.01);
  // Exhausted by yearIndex 8; quiet afterwards.
  assert.equal(plan.years[8].tipsLadder.value, 0);
  assert.equal(plan.years[9].tipsLadder.maturedCash, 0);
});

test("tipsLadder annualRealAmount null auto-sizes to the base annual spending target", () => {
  const plan = simulatePlan({
    assets: [cashAsset()],
    scenario: quietScenario({
      planYears: 2,
      currentAge: 50,
      targetSpend: 25000,
      tipsLadder: { enabled: true, years: 3, annualRealAmount: null, realYieldPercent: 2 }
    }),
    taxProfile: flatZeroProfile("single"),
    ...zeroSequences(2)
  });
  const build = plan.years[0].tipsLadder.build;
  assert.equal(build.annualRealAmount, 25000);
  assert.equal(build.fundedYears, 3);
});

test("mergeScenario fills tipsLadder defaults for partial and absent configs", () => {
  const defaults = {
    enabled: false,
    years: 10,
    annualRealAmount: null,
    realYieldPercent: 2,
    maintenanceMode: "none",
    replenishCatchUp: true,
    triggerStockReturnPercent: 0
  };
  assert.deepEqual(mergeScenario({}).tipsLadder, defaults);
  assert.deepEqual(
    mergeScenario({ tipsLadder: { enabled: true, years: 5 } }).tipsLadder,
    { ...defaults, enabled: true, years: 5 }
  );
});
