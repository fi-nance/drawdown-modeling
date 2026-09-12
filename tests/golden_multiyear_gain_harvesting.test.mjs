import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatePlan, runMonteCarlo, runHistoricalBacktests, generateSingleMonteCarloPath, DEFAULT_SCENARIO } from '../src/core/simulation.mjs';
import { buildTaxProfile } from '../src/data/taxData.mjs';
import { DEFAULT_ACA_CONFIG } from '../src/core/aca.mjs';
import { createResultAuditSummary } from '../src/core/resultAuditBundle.mjs';

// Current law: IRC 36B/IRS PTC FAQs, 2026 400% FPL eligibility ceiling.
// https://www.irs.gov/affordable-care-act/individuals-and-families/questions-and-answers-on-the-premium-tax-credit
// Economic regression: cash funds the early years; later low-basis equity
// withdrawals threaten PTC. Harvesting now must value the future basis reset.
const assets = [
  { id: 'cash', accountType: 'taxable', assetClass: 'cash', units: 300000, price: 1, costBasisPerUnit: 1 },
  { id: 'stock', accountType: 'taxable', assetClass: 'stock', units: 10000, price: 100, costBasisPerUnit: 10, holdingPeriod: 'long', dividendYield: 0 }
];
const taxProfile = buildTaxProfile({ filingStatus: 'marriedFilingJointly', state: 'Florida' });
const scenario = { ...DEFAULT_SCENARIO, startYear: 2026, currentAge: 57, spouseAge: 57,
  planYears: 8, targetSpend: 110000, requiredSpendingFloor: 110000,
  returnAssumptions: Object.fromEntries(['stock', 'bond', 'cash', 'inflation', 'medicalInflation'].map(key => [key, { mean: 0, stdev: 0 }])),
  rothConversion: { enabled: false }, taxLossHarvesting: { enabled: false }, taxGainHarvesting: { enabled: true },
  aca: { ...DEFAULT_ACA_CONFIG, enabled: true, ptcEligibility: 'eligible', householdSize: 2,
    marketplaceMembers: 2, memberAges: [57, 57], fpl: 21150,
    benchmarkPremium: 32000, selectedPlanPremium: 32000,
    ageRatedBenchmarkPremium: false, ageRatedSelectedPlanPremium: false, magiBuffer: 1000 },
  medicare: { premiumsEnabled: false }, expectedOopMaxUsePercent: 0
};
const inputs = { assets, scenario, taxProfile };

test('paying more during three early years preserves later $20k+ credits and increases wealth', () => {
  const before = structuredClone(inputs);
  const plan = simulatePlan(inputs);
  const { baseline, selected, candidates, projectedRealBenefit } = plan.gainHarvestingOptimization;
  const earlyCost = value => value.years.slice(0, 3).reduce((sum, year) => sum + year.taxes + year.netPremium, 0);
  assert.ok(earlyCost(selected) > earlyCost(baseline) + 1000);
  assert.ok(selected.years.some((year, index) => index >= 3 && year.ptc > 20000 && baseline.years[index].ptc === 0));
  assert.ok(selected.ptcYears > baseline.ptcYears);
  assert.ok(projectedRealBenefit > 20000);
  assert.equal(selected.fundedSpending, baseline.fundedSpending);
  assert.ok(plan.planningSuccess);
  const fourHundred = candidates.find(candidate => candidate.label === 'Up to 400% FPL');
  assert.ok(fourHundred.realHeirValue > baseline.realHeirValue + 20000);
  assert.ok(selected.realHeirValue >= fourHundred.realHeirValue);
  assert.deepEqual(inputs, before);
});

test('additional sales to pay harvest costs stay below the reconciled MAGI ceiling', () => {
  const plan = simulatePlan({ ...inputs, gainHarvestingPolicy: { enabled: true, targets: Array(8).fill(400) } });
  assert.ok(plan.years.some(year => year.taxGainHarvested > 0 && year.sales.some(sale => sale.gain > 0)));
  for (const year of plan.years) {
    if (year.taxGainHarvested > 0) assert.ok(year.acaMagi <= year.taxGainHarvestingTarget.magiCeiling + 0.000001,
      `${year.year}: ${year.acaMagi} > ${year.taxGainHarvestingTarget.magiCeiling}`);
    assert.equal(year.unfunded, 0);
  }
});

test('policy search may defer harvesting when spending never needs the taxable gains', () => {
  const plan = simulatePlan({ ...inputs, assets: [{ ...assets[0], units: 2000000 }, assets[1]],
    scenario: { ...scenario, targetSpend: 1000, requiredSpendingFloor: 1000, medicareWages: 40000 } });
  assert.equal(plan.gainHarvestingOptimization.selectedPolicy, 'Defer ACA-year harvesting');
  assert.ok(plan.years.every(year => year.taxGainHarvested === 0));
});

test('manual gain override, disabled harvesting and heuristic mode retain their controls', () => {
  for (const change of [ { taxGainHarvesting: { enabled: false } },
    { taxGainHarvesting: { enabled: true, mode: 'manual', overrideMaxGain: 5000 } },
    { withdrawalStrategy: { mode: 'heuristic' } } ]) {
    const plan = simulatePlan({ ...inputs, scenario: { ...scenario, ...change } });
    assert.equal(plan.gainHarvestingOptimization, null);
    if (change.taxGainHarvesting) assert.ok(plan.years.every(year => year.taxGainHarvested <= 5000));
  }
});

test('Monte Carlo, historical tests and regenerated paths use the same policy without knowing future returns', () => {
  const deterministic = simulatePlan(inputs);
  const mc = runMonteCarlo({ ...inputs, runs: 2, seed: 47 });
  assert.deepEqual(mc.gainHarvestingOptimization, deterministic.gainHarvestingOptimization);
  assert.equal(mc.scenarios[0].endingValue, deterministic.endingValue);
  const differentFuture = simulatePlan({ ...inputs, returnSequence: Array.from({ length: 8 }, () => ({ stock: -0.1, cash: 0 })) });
  assert.deepEqual(differentFuture.gainHarvestingOptimization, deterministic.gainHarvestingOptimization);
  const history = runHistoricalBacktests({ ...inputs, sequences: [{ name: 'Adverse known sequence',
    returns: Array.from({ length: 8 }, () => ({ stock: -0.1, cash: 0 })), inflation: Array(8).fill(0) }] });
  assert.deepEqual(history[0].gainHarvestingOptimization, deterministic.gainHarvestingOptimization);
  const regenerated = generateSingleMonteCarloPath({ ...inputs, seed: 47, scenarioId: 1 });
  assert.equal(regenerated.endingValue, mc.scenarios[0].endingValue);
  const audit = createResultAuditSummary({ latest: { plan: deterministic, scenario, taxProfile, monteCarlo: mc } });
  assert.deepEqual(audit.gainHarvestingOptimization, deterministic.gainHarvestingOptimization);
});

test('all-in spending cannot hide lost subsidies or taxes as a lifestyle cut', () => {
  for (const flags of [{ targetSpendIncludesMedical: true }, { targetSpendIncludesTaxes: true },
    { targetSpendIncludesMedical: true, targetSpendIncludesTaxes: true }]) {
    const plan = simulatePlan({ ...inputs, scenario: { ...scenario, ...flags } });
    const result = plan.gainHarvestingOptimization;
    assert.ok(result.selected.fundedSpending >= result.baseline.fundedSpending - 1);
    if (flags.targetSpendIncludesMedical) {
      assert.ok(plan.years[0].medicalCostIncludedInSpending > 0);
      assert.ok(result.selected.fundedSpending < 880000);
      assert.notEqual(result.selectedPolicy, 'Defer ACA-year harvesting');
    }
  }
});

test('newly purchased stock still participates because future returns create gains', () => {
  const plan = simulatePlan({ ...inputs, assets: [{ ...assets[1], costBasisPerUnit: 100 }],
    scenario: { ...scenario, returnAssumptions: { ...scenario.returnAssumptions, stock: { mean: 0.08, stdev: 0 } } } });
  assert.ok(plan.gainHarvestingOptimization);
  assert.ok(plan.gainHarvestingOptimization.candidates.length >= 7);
});
