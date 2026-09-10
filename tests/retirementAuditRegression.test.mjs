import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SCENARIO, simulatePlan, runMonteCarlo } from "../src/core/simulation.mjs";
import { runDecisionBatch, buildTradeoffFrontier } from "../src/core/decisionEngine.mjs";
import { buildTaxProfile, buildAcaConfig } from "../src/data/taxData.mjs";
import { normalizeIncomeStream, incomeStreamsForYear } from "../src/core/simulation/incomeStreams.mjs";
import { medicalCostForYear, computeAcaForYear } from "../src/core/simulation/medical.mjs";
import { buildConfidenceReport, actionConfidenceFor, rescueConfidenceFor } from "../src/core/confidence.mjs";
import { computeIncomeTax } from "../src/core/tax.mjs";
import { federalAgiForIncome } from "../src/core/simulation/income.mjs";
import { estimateHeirValueBreakdown, inheritanceTaxStateForScenario } from "../src/core/simulation/heirEstate.mjs";
import { parsePortfolioJson, parsePortfolioCsv } from "../src/core/importers.mjs";
import { allocationStrategyStateForYear } from "../src/core/simulation/allocation.mjs";
import { assetLocationStateForYear } from "../src/core/simulation/assetLocation.mjs";
import { marketValue } from "../src/core/portfolio.mjs";
import { runHistoricalBacktests } from "../src/core/simulation.mjs";
import { lifetimeHorizonForScenario } from "../src/core/simulation/household.mjs";
import { buildTipsLadder, payTipsLadderCoupons } from "../src/core/simulation/tipsLadder.mjs";
import { compactLatestForCache, restoreCachedLatest, RESULTS_CACHE_KEY } from "../src/core/resultsCache.mjs";
import { validateUserPlanningScenario } from "../src/core/planningInputValidation.mjs";

const classes = ["cash", "stock", "bond", "tips", "realEstate", "crypto"];
const returns = (mean = 0) => Object.fromEntries([
  ...classes.map((key) => [key, { mean, stdev: 0 }]),
  ["inflation", { mean: 0, stdev: 0 }], ["medicalInflation", { mean: 0, stdev: 0 }]
]);
const taxProfile = buildTaxProfile({ filingStatus: "marriedFilingJointly", state: "Florida" });
const scenario = (overrides = {}) => ({
  ...DEFAULT_SCENARIO, planYears: 3, currentAge: 60, spouseAge: 60, targetSpend: 30000,
  rothBasis: 0, returnAssumptions: returns(), aca: { enabled: false },
  medicare: { irmaaEnabled: false }, rothConversion: { enabled: false },
  taxLossHarvesting: { enabled: false }, taxGainHarvesting: { enabled: false }, ...overrides
});
const asset = (overrides = {}) => ({
  id: "cash", accountType: "taxable", assetClass: "cash", units: 100000,
  price: 1, costBasisPerUnit: 1, ...overrides
});
const close = (actual, expected, epsilon = 0.01) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

test("audit scope: HSA-funded plans disclose expense qualification before acting", () => {
  const report = buildConfidenceReport({ assets: [asset({ accountType: "hsa" })], scenario: scenario(), taxProfile });
  assert.match(report.flags.find((f) => f.id === "hsa-expense-qualification").detail, /ACA and Medigap/);
  assert.equal(actionConfidenceFor("hsaWithdrawal", report).level, "cpa-review-recommended");
  assert.equal(actionConfidenceFor("hsaContribution", report).level, "cpa-review-recommended");
  assert.ok(buildConfidenceReport({ assets: [], scenario: scenario({ taxEfficiencyStrategy: {
    hsaContributionEnabled: true } }), taxProfile }).flags.some((f) => f.id === "hsa-expense-qualification"));
  assert.ok(!buildConfidenceReport({ assets: [asset()], scenario: scenario(), taxProfile }).flags
    .some((f) => f.id === "hsa-expense-qualification"));
});

test("audit scope: first-death non-spouse transfers warn for either death order", () => {
  for (const owner of ["primary", "spouse"]) {
    const s = scenario({ primaryMortalityAge: owner === "primary" ? 60 : 95,
      spouseMortalityAge: owner === "spouse" ? 60 : 95 });
    const report = buildConfidenceReport({ assets: [asset({ owner, beneficiaryType: "nonSpouse10Yr" })], scenario: s, taxProfile });
    assert.match(report.flags.find((f) => f.id === "household-beneficiary-lifecycle").detail, /first-death transition/);
    assert.equal(rescueConfidenceFor({ kind: "vpwRescue", historical: { count: 10 } }, report).level, "out-of-model");
    assert.equal(actionConfidenceFor("legacy", report).level, "out-of-model");
  }
});

test("audit scope: final-death spouse designations require contingent beneficiary review", () => {
  const assets = [asset({ beneficiaryType: "spouse" })];
  const complete = scenario({ primaryMortalityAge: 61, spouseMortalityAge: 62 });
  const report = buildConfidenceReport({ assets, scenario: complete, taxProfile });
  assert.match(report.flags.find((f) => f.id === "household-beneficiary-lifecycle").detail, /contingent beneficiaries/);
  const partial = buildConfidenceReport({ assets, scenario: scenario(), taxProfile });
  assert.ok(!partial.flags.some((f) => f.id === "household-beneficiary-lifecycle"));
  const single = buildConfidenceReport({ assets, scenario: complete, taxProfile: { filingStatus: "single" } });
  assert.ok(!single.flags.some((f) => f.id === "household-beneficiary-lifecycle"));
});

test("audit F1: a rescue below required spending cannot be target-met", () => {
  const s = scenario({ planYears: 20, returnAssumptions: returns(0.04) });
  const assets = [asset({ accountType: "roth" })];
  const decision = runDecisionBatch({ assets, scenario: s, taxProfile, runs: 2, seed: 42,
    decisionProfile: { requiredSpend: 30000, flexibleSpend: 0, incomeBridge: { enabled: false } } });
  const vpw = decision.rescueOptions.find((option) => option.kind === "vpwRescue");
  assert.ok(vpw);
  assert.notEqual(vpw.status, "target-met");
  assert.equal(vpw.scenarioSummary.requiredSpend, 30000);
  assert.ok(vpw.spendingOutcome.totalEssentialShortfall > 0);
  assert.ok(decision.rescueOptions.every((option) => option.status !== "target-met"));
  for (const option of decision.rescueOptions) {
    const applied = simulatePlan({ assets, scenario: option.scenario, taxProfile });
    assert.deepEqual(applied.spendingOutcome, option.spendingOutcome, option.id);
    const rerun = runMonteCarlo({ assets, scenario: option.scenario, taxProfile, runs: 2, seed: 42 });
    assert.equal(rerun.summary.planningSuccessRate, option.monteCarlo.planningSuccessRate, option.id);
    assert.equal(rerun.summary.medianHeirValue, option.monteCarlo.medianHeirValue, option.id);
  }
});

test("audit integration: adverse sequences, longevity and care shocks reconcile through both deaths", () => {
  const assets = [asset({ id: "taxable", assetClass: "stock", units: 700000 }),
    asset({ id: "ira", accountType: "traditional", owner: "spouse", assetClass: "bond", units: 1000000 }),
    asset({ id: "roth", accountType: "roth", units: 300000 })];
  const s = scenario({ planYears: 35, currentAge: 65, spouseAge: 63,
    primaryMortalityAge: 80, spouseMortalityAge: 92, requiredSpendingFloor: 30000,
    medicare: { irmaaEnabled: true, annualOopBase: 5000 },
    socialSecurityAnnualBenefit: 30000, socialSecurityStartAge: 67,
    spouseSocialSecurityAnnualBenefit: 18000, spouseSocialSecurityStartAge: 67,
    incomeStreams: [{ type: "pension", owner: "primary", startAge: 65, endAge: null,
      annualAmount: 20000, survivorPercent: 50, inflationAdjusted: false }],
    ltcStress: { enabled: true, member: "spouse", startAge: 87, years: 4, annualCost: 80000 },
    oneOffExpenses: [{ amount: 50000, startYear: 4, endYear: 4, inflationAdjusted: true }] });
  for (const shockYear of [0, 20, -1]) {
    const plan = simulatePlan({ assets, scenario: s, taxProfile,
      returnSequence: Array.from({ length: 35 }, (_, year) => Object.fromEntries(
        classes.map((key) => [key, year === shockYear ? -0.35 : 0.005]))),
      inflationSequence: Array(35).fill(0.06), medicalInflationSequence: Array(35).fill(0.08) });
    assert.equal(plan.lifetimeHorizon.complete, true);
    assert.ok(plan.years.some((year) => year.ltcCost > 0));
    assert.ok(plan.years.some((year) => year.filingStatus === "single"));
    assert.ok(plan.years.some((year) => year.postMortality));
    for (const year of plan.years.filter((year) => !year.postMortality)) {
      for (const field of ["endingPortfolioValue", "cashAvailable", "totalCashRequired", "unfunded", "requiredEssentialSpending", "essentialShortfall"]) {
        assert.ok(Number.isFinite(year[field]) && year[field] >= 0, `${year.year}: ${field}`);
      }
      close(year.unfunded, Math.max(0, year.totalCashRequired - year.cashAvailable), 0.011);
      close(year.essentialShortfall, Math.max(0, year.requiredEssentialSpending - year.fundedCoreSpending));
    }
    assert.equal(plan.planningSuccess, plan.success && plan.spendingOutcome.essentialSatisfied);
  }
});

test("audit F2: null/blank/omitted pension end ages all mean for life", () => {
  const stream = { type: "pension", owner: "primary", startAge: 65,
    annualAmount: 30000, inflationAdjusted: false };
  for (const endAge of [null, undefined, "", " ", 95]) {
    const s = scenario({ currentAge: 65, spouseAge: 65, incomeStreams: [{ ...stream, endAge }] });
    assert.equal(normalizeIncomeStream({ ...stream, endAge }).endAge, endAge === 95 ? 95 : null);
    assert.equal(incomeStreamsForYear({ scenario: s, yearIndex: 0 }).cash, 30000);
    close(simulatePlan({ assets: [asset()], scenario: s, taxProfile }).endingValue, 100000);
  }
  assert.throws(() => normalizeIncomeStream({ ...stream, endAge: 64 }), /end age/i);
});

test("audit F3: spouse RMDs survive allocation rebalancing", () => {
  const s = scenario({ planYears: 2, currentAge: 70, spouseAge: 76, targetSpend: 1000,
    allocationStrategy: { rebalanceEnabled: true, targetStockPercent: 0, rebalanceBandPercent: 0 } });
  const plan = simulatePlan({ assets: [asset({ owner: "spouse", accountType: "traditional",
    assetClass: "stock", units: 500000 })], scenario: s, taxProfile });
  close(plan.years[0].rmdRequired, 500000 / 23.7);
  close(plan.years[0].rmdAmount, plan.years[0].rmdRequired);
  assert.ok(plan.years[1].rmdRequired > 0);
  assert.ok(plan.finalPortfolio.filter((lot) => lot.accountType === "traditional")
    .every((lot) => lot.owner === "spouse"));
});

test("audit F3: rebalanced Roth conversions keep tax clocks and beneficiaries", () => {
  const portfolio = [asset({ accountType: "roth", assetClass: "stock", owner: "spouse",
    beneficiaryType: "nonSpouse10Yr", rothSource: "conversion", conversionYear: 2025 }),
  asset({ id: "other", accountType: "roth", assetClass: "bond", owner: "primary",
    beneficiaryType: "spouse", units: 100 })];
  allocationStrategyStateForYear({ portfolio, scenario: scenario({ allocationStrategy: {
    rebalanceEnabled: true, targetStockPercent: 0, rebalanceBandPercent: 0 } }), yearIndex: 0, calendarYear: 2026 });
  const replacement = portfolio.find((lot) => lot.id.startsWith("rebalance-"));
  assert.equal(replacement.owner, "spouse");
  assert.equal(replacement.beneficiaryType, "nonSpouse10Yr");
  assert.equal(replacement.rothSource, "conversion");
  assert.equal(replacement.conversionYear, 2025);
  close(marketValue(replacement), 100000);
});

test("audit F3: asset-location swaps securities, not owners or beneficiaries", () => {
  const portfolio = [asset({ assetClass: "bond", owner: "joint", beneficiaryType: "spouse" }),
    asset({ id: "ira", accountType: "traditional", assetClass: "stock", owner: "spouse",
      beneficiaryType: "nonSpouse10Yr" })];
  assetLocationStateForYear({ portfolio, scenario: scenario({ taxEfficiencyStrategy: {
    assetLocationEnabled: true } }), calendarYear: 2026 });
  assert.equal(portfolio.find((lot) => lot.accountType === "taxable").owner, "joint");
  assert.equal(portfolio.find((lot) => lot.accountType === "taxable").beneficiaryType, "spouse");
  assert.equal(portfolio.find((lot) => lot.accountType === "traditional").owner, "spouse");
  assert.equal(portfolio.find((lot) => lot.accountType === "traditional").beneficiaryType, "nonSpouse10Yr");
  close(portfolio.reduce((sum, lot) => sum + marketValue(lot), 0), 200000);
});

test("audit F4: absent OOP override uses the plan; explicit zero remains zero", () => {
  const config = buildAcaConfig({ currentAge: 60, memberAges: [60, 60], state: "Florida" });
  const aca = computeAcaForYear({ age: 60, spouseAge: 60, magi: 40000, config,
    filingStatus: "marriedFilingJointly" });
  const calculate = (oopMaxOverride) => medicalCostForYear({ scenario: scenario({ oopMaxOverride }),
    aca, yearAcaConfig: config, inflationIndex: 1, age: 60, spouseAge: 60, yearIndex: 0,
    filingStatus: "marriedFilingJointly", irmaaMagi: 40000, magiHistory: [] }).total;
  for (const value of [null, undefined, "", " "]) close(calculate(value), aca.netPremium + 5300);
  close(calculate(0), aca.netPremium);
  close(calculate(21200), aca.netPremium + 5300);
});

test("audit F4: missing Medicare OOP always warns, including null and ACA-off", () => {
  for (const annualOopBase of [null, undefined, "", " "]) {
    const s = scenario({ currentAge: 65, spouseAge: 65,
      medicare: { ...DEFAULT_SCENARIO.medicare, annualOopBase } });
    assert.ok(buildConfidenceReport({ scenario: s, taxProfile }).flags.some((f) => f.id === "medicare-oop-inputs"));
  }
  const s = scenario({ currentAge: 65, medicare: { ...DEFAULT_SCENARIO.medicare, annualOopBase: 0 } });
  assert.ok(!buildConfidenceReport({ scenario: s, taxProfile }).flags.some((f) => f.id === "medicare-oop-inputs"));
});

test("audit F5: no aged-survivor entitlement at 51", () => {
  const s = scenario({ planYears: 5, currentAge: 70, spouseAge: 50, primaryMortalityAge: 70,
    socialSecurityAnnualBenefit: 30000, socialSecurityStartAge: 67,
    socialSecurityInflationAdjusted: false, spouseSocialSecurityAnnualBenefit: 0 });
  const plan = simulatePlan({ assets: [asset({ units: 1000000 })], scenario: s, taxProfile });
  assert.equal(plan.years[1].age, 51);
  assert.equal(plan.years[1].socialSecurityBenefits, 0);
});

test("audit F5: death before claiming starts the eligible survivor's PIA, not posthumous credits", () => {
  // 1961-born deceased: FRA 67; $37,200 at 70 implies a $30,000 PIA.
  const s = scenario({ planYears: 6, currentAge: 65, spouseAge: 67, primaryMortalityAge: 65,
    socialSecurityAnnualBenefit: 37200, socialSecurityStartAge: 70,
    socialSecurityInflationAdjusted: false, spouseSocialSecurityAnnualBenefit: 0 });
  const plan = simulatePlan({ assets: [asset({ units: 1000000 })], scenario: s, taxProfile });
  assert.equal(plan.years[1].age, 68);
  for (const year of plan.years.slice(1)) close(year.socialSecurityBenefits, 30000);
});

test("audit F6: bequest comparison preserves after-tax Monte Carlo summaries", () => {
  const s = scenario({ planYears: 1, currentAge: 70, spouseAge: 70, targetSpend: 1000,
    heirType: "nonSpouse10Yr", heirBaseIncome: 80000 });
  const assets = [asset({ accountType: "traditional", units: 500000 })];
  const mc = runMonteCarlo({ assets, scenario: s, taxProfile, runs: 10, seed: 42 });
  const base = buildTradeoffFrontier({ assets, scenario: s, taxProfile, runs: 10,
    seed: 42, sequences: [] }).find((p) => p.id === "base-reference");
  close(base.bequest, 387600);
  assert.equal(base.candidate.monteCarlo.medianHeirValue, mc.summary.medianHeirValue);
});

test("audit F7: all taxable cash return is current interest, including imported cash", () => {
  // IRS Topic 403: bank/money-market interest is taxable when available.
  const s = scenario({ planYears: 1, targetSpend: 1000, returnAssumptions: returns(0.05) });
  for (const dividendYield of [undefined, 0, 0.05]) {
    const assets = parsePortfolioJson(JSON.stringify([asset({ units: 2000000, dividendYield })]));
    const year = simulatePlan({ assets, scenario: s, taxProfile }).years[0];
    close(year.federalAgi, 100000);
    close(year.taxes.totalTax, 7640);
  }
});

test("audit F8: reject ambiguous after-tax accounts rather than treating them as Roth", () => {
  // IRS Notice 2014-54: non-Roth after-tax basis does not make its earnings Roth.
  for (const accountType of ["after-tax", "aftertax", "after tax 401(k)", "after-tax 401k"]) {
    assert.throws(() => parsePortfolioJson(JSON.stringify([asset({ accountType })])), /after.tax|unsupported/i);
    assert.throws(() => parsePortfolioCsv(`accountType,units,price\n${accountType},100,1`), /after.tax|unsupported/i);
  }
  assert.equal(parsePortfolioJson(JSON.stringify([asset({ accountType: "Roth 401(k)" })]))[0].accountType, "roth");
});

test("audit F9: capital losses reduce dividend-only AGI and income tax", () => {
  // IRS Schedule D/1040 QD worksheet: 100,000 - 3,000 - 16,100 = 80,900 taxable;
  // 2026 Single 0% threshold 49,450, then 15%: (80,900 - 49,450) * .15 = 4,717.50.
  const profile = buildTaxProfile({ filingStatus: "single", state: "Florida" });
  const income = { ordinaryIncome: 0, qualifiedDividends: 100000, capitalLosses: 3000,
    shortTermCapitalGains: 0, longTermCapitalGains: 0 };
  const tax = computeIncomeTax({ ...income, profile });
  assert.equal(tax.federalAgi, 97000);
  assert.equal(federalAgiForIncome(income, 0, 3000, profile), tax.federalAgi);
  close(tax.totalTax, 4717.5);
  assert.equal(tax.lossCarryforward, 0);
});

test("audit F10: inheritance jurisdiction is the decedent's, not the heir's", () => {
  const assets = [asset({ units: 1000000 })];
  const pa = inheritanceTaxStateForScenario({ state: "Pennsylvania", heirState: null });
  const fl = inheritanceTaxStateForScenario({ state: "Florida", heirState: "PA" });
  close(estimateHeirValueBreakdown(assets, .24, { heirType: "nonSpouse10Yr", state: pa }).stateInheritanceTax, 45000);
  close(estimateHeirValueBreakdown(assets, .24, { heirType: "nonSpouse10Yr", state: fl }).stateInheritanceTax, 0);
});

test("audit F10: Nebraska adult lineal heir gets the $100,000 exemption", () => {
  // Nebraska statute 77-2004: 1% of the excess over $100,000 per qualifying heir.
  for (const [units, tax] of [[1000000, 9000], [100000, 0], [50000, 0]]) {
    close(estimateHeirValueBreakdown([asset({ units })], .24,
      { heirType: "nonSpouse10Yr", state: "Nebraska", heirAge: 30 }).stateInheritanceTax, tax);
  }
});

test("audit C1: a finite horizon short of the last death is prominently flagged", () => {
  const s = scenario({ currentAge: 55, spouseAge: 55, planYears: 35,
    primaryMortalityAge: 95, spouseMortalityAge: 95, targetSpend: 1000 });
  const plan = simulatePlan({ assets: [asset({ units: 1000000 })], scenario: s, taxProfile });
  assert.equal(plan.years.at(-1).age, 89);
  assert.ok(buildConfidenceReport({ scenario: s, taxProfile, plan }).flags
    .some((f) => f.id === "lifetime-horizon-incomplete"));
});

test("audit F1: compact MC and historical paths retain spending-floor failure despite portfolio survival", () => {
  const s = scenario({ planYears: 5, targetSpend: 30000, requiredSpendingFloor: 30000,
    spendingStrategy: { mode: "vpw", essentialSpend: 30000 }, returnAssumptions: returns(.04) });
  const assets = [asset({ accountType: "roth", units: 50000 })];
  const mc = runMonteCarlo({ assets, scenario: s, taxProfile, runs: 3, scenarioTimelineLimit: 0 });
  assert.equal(mc.summary.successRate, 1);
  assert.equal(mc.summary.planningSuccessRate, 0);
  assert.equal(mc.scenarios[0].years, undefined);
  assert.equal(mc.scenarios[0].spendingOutcome.essentialSatisfied, false);
  const history = runHistoricalBacktests({ assets, scenario: s, taxProfile,
    sequences: [{ returns: Array(5).fill({ cash: .04 }), inflation: Array(5).fill(0) }] });
  assert.equal(history[0].success, true);
  assert.equal(history[0].planningSuccess, false);
  const cached = compactLatestForCache({ monteCarlo: mc, backtests: history });
  assert.deepEqual(cached.monteCarlo.scenarios[0].spendingOutcome, mc.scenarios[0].spendingOutcome);
  assert.equal(cached.backtests[0].planningSuccess, false);
});

test("audit F1: essential floors use explicit inflation rules and exclude post-death years", () => {
  const assets = [asset({ accountType: "roth", units: 1000000 })];
  const s = scenario({ planYears: 4, requiredSpendingFloor: 30000, targetSpendInflationAdjusted: false,
    primaryMortalityAge: 61, spouseMortalityAge: 61 });
  const indexed = simulatePlan({ assets, scenario: s, taxProfile, inflationSequence: [.1,.1,.1,.1] });
  close(indexed.years[1].requiredEssentialSpending, 33000);
  close(indexed.spendingOutcome.totalEssentialShortfall, 3000/1.1);
  assert.equal(indexed.spendingOutcome.yearsBelowEssentialFloor, 1);
  assert.equal(indexed.years[2].postMortality, true);
  const nominal = simulatePlan({ assets, scenario: { ...s, requiredSpendingInflationAdjusted: false },
    taxProfile, inflationSequence: [.1,.1,.1,.1] });
  assert.equal(nominal.spendingOutcome.essentialSatisfied, true);
});

test("audit F3: ladder purchases, coupons and imports retain account identity", () => {
  const portfolio = parsePortfolioJson(JSON.stringify([
    asset({ id: "a", accountType: "roth", owner: "spouse", units: 30000,
      beneficiaryType: "nonSpouse10Yr", beneficiaryId: "child-a", beneficiaryAge: 30,
      rothSource: "conversion", conversionYear: 2025 }),
    asset({ id: "b", accountType: "roth", owner: "spouse", units: 30000,
      beneficiaryType: "spouse", beneficiaryId: "primary" })
  ]));
  const s = scenario({ tipsLadder: { enabled: true, years: 1, annualRealAmount: 60000, realYieldPercent: 2 } });
  buildTipsLadder({ portfolio, scenario: s, age: 60, spouseAge: 60, yearIndex: 0, inflationIndex: 1, baseAnnualSpending: 60000 });
  const rungs = portfolio.filter((lot) => lot.tipsLadderYear);
  assert.equal(rungs.length, 2);
  assert.equal(new Set(rungs.map((lot) => lot.id)).size, 2);
  assert.ok(rungs.every((lot) => lot.owner === "spouse"));
  assert.equal(rungs.find((lot) => lot.beneficiaryId === "child-a").conversionYear, 2025);
  payTipsLadderCoupons(portfolio, { scenario: s, inflationIndex: 1 });
  const coupons = portfolio.filter((lot) => lot.id.startsWith("tips-coupon-cash"));
  assert.equal(coupons.length, 2);
  assert.ok(coupons.every((lot) => lot.owner === "spouse" && lot.rothSource === undefined));
  assert.equal(coupons.find((lot) => lot.beneficiaryId === "child-a").beneficiaryType, "nonSpouse10Yr");
  payTipsLadderCoupons(portfolio, { scenario: s, inflationIndex: 1 });
  assert.equal(portfolio.filter((lot) => lot.id.startsWith("tips-coupon-cash")).length, 2);
});

test("audit C1: include the last death year and use the younger spouse's lifetime", () => {
  assert.equal(lifetimeHorizonForScenario({ currentAge: 55, planYears: 40, primaryMortalityAge: 95 }, "single").complete, false);
  assert.equal(lifetimeHorizonForScenario({ currentAge: 55, planYears: 41, primaryMortalityAge: 95 }, "single").complete, true);
  const joint = lifetimeHorizonForScenario({ currentAge: 70, spouseAge: 50, planYears: 26,
    primaryMortalityAge: 95, spouseMortalityAge: 95 });
  assert.equal(joint.requiredYears, 46);
  assert.equal(joint.missingYears, 20);
});

test("audit: stale pre-fix recommendations cannot be restored", () => {
  const oldKey = "portfolio-success-lab:results-cache:current";
  assert.notEqual(RESULTS_CACHE_KEY, oldKey);
  assert.equal(restoreCachedLatest({ getItem: (key) => key === oldKey ? '{"plan":{},"monteCarlo":{}}' : null }), null);
});

test("audit: workspace validates income age ranges and aged-survivor eligibility", () => {
  assert.equal(validateUserPlanningScenario({ targetSpend: 30000, incomeStreams: [
    { annualAmount: 10000, startAge: 65, endAge: 64 }] }).ok, false);
  assert.equal(validateUserPlanningScenario({ targetSpend: 30000, spouseSocialSecuritySurvivorStartAge: 50 }).ok, false);
  assert.equal(validateUserPlanningScenario({ targetSpend: 30000, spouseSocialSecuritySurvivorStartAge: null }).ok, true);
  for (const endAge of [NaN, Infinity, "unknown"]) assert.throws(() => normalizeIncomeStream({ startAge: 65, endAge }), /end age/);
});

test("audit F3: CSV retains conversion clocks and invalid metadata cannot erase tax", () => {
  const [lot] = parsePortfolioCsv("accountType,units,price,owner,beneficiaryId,beneficiaryAge,rothSource,conversionYear\nroth,100,1,spouse,child,30,conversion,2025");
  assert.equal(lot.conversionYear, 2025);
  assert.equal(lot.rothSource, "conversion");
  assert.equal(lot.beneficiaryId, "child");
  for (const conversionYear of [null, "bad", 2025.5, -1]) {
    assert.throws(() => parsePortfolioJson(JSON.stringify([asset({ accountType: "roth", rothSource: "conversion", conversionYear })])), /conversion year/);
  }
  assert.throws(() => parsePortfolioJson(JSON.stringify([asset({ beneficiaryAge: -1 })])), /beneficiary age/);
});
