import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioWithSocialSecurityBridge, runDecisionBatch } from '../src/core/decisionEngine.mjs';
import { DEFAULT_SCENARIO } from '../src/core/simulation.mjs';
import { buildTaxProfile } from '../src/data/taxData.mjs';

test('a past Social Security award cannot become a delayed claim in a bridge rescue', () => {
  for (const currentAge of [64, 68, 75]) {
    const scenario = { currentAge, socialSecurityStartAge: 62, socialSecurityAnnualBenefit: 24000 };
    assert.deepEqual(scenarioWithSocialSecurityBridge(scenario, 70), scenario);
  }
});

import { feasibleSocialSecurityClaimAges, scenarioWithSocialSecurityClaimAge } from '../src/core/simulation/socialSecurity.mjs';
import { validateUserPlanningScenario } from '../src/core/planningInputValidation.mjs';

test('unclaimed candidates are prospective and existing spouse awards remain fixed', () => {
  const scenario = { currentAge: 68, socialSecurityClaimStatus: 'unclaimed', socialSecurityStartAge: 70,
    spouseAge: 64, spouseSocialSecurityClaimStatus: 'claimed', spouseSocialSecurityStartAge: 62,
    spouseSocialSecurityAnnualBenefit: 24000 };
  assert.deepEqual(feasibleSocialSecurityClaimAges(scenario), [68, 70]);
  assert.deepEqual(feasibleSocialSecurityClaimAges(scenario, 'spouse'), [62]);
  assert.deepEqual(scenarioWithSocialSecurityClaimAge(scenario, 'spouse', 70), scenario);
  assert.deepEqual(feasibleSocialSecurityClaimAges({ currentAge: 75, socialSecurityClaimStatus: 'unclaimed' }), [75]);
  assert.ok(feasibleSocialSecurityClaimAges({ currentAge: 65.5, socialSecurityStartAge: 70 }).every(age => age >= 65.5));
});

test('explicit receiving status locks the award even in the current claim year', () => {
  const scenario = { currentAge: 62, socialSecurityStartAge: 62, socialSecurityAnnualBenefit: 24000, socialSecurityClaimStatus: 'claimed' };
  assert.deepEqual(scenarioWithSocialSecurityBridge(scenario), scenario);
});

test('setup rejects contradictory current claim status and start age', () => {
  assert.equal(validateUserPlanningScenario({ targetSpend: 30000, currentAge: 68, socialSecurityStartAge: 62, socialSecurityClaimStatus: 'unclaimed' }).ok, false);
});

test('decision engine cannot rescue a 75-year-old by rewriting an age-62 election', () => {
  const returns = Object.fromEntries(['cash', 'stock', 'bond', 'tips', 'realEstate', 'crypto', 'inflation', 'medicalInflation'].map(key => [key, { mean: 0, stdev: 0 }]));
  const result = runDecisionBatch({ assets: [{ id: 'cash', accountType: 'taxable', assetClass: 'cash', units: 100000, price: 1, costBasisPerUnit: 1 }],
    taxProfile: buildTaxProfile({ filingStatus: 'single', state: 'Florida' }), runs: 1, seed: 42,
    scenario: { ...DEFAULT_SCENARIO, startYear: 2026, currentAge: 75, spouseAge: null, planYears: 10, targetSpend: 40000,
      socialSecurityAnnualBenefit: 24000, socialSecurityStartAge: 62, returnAssumptions: returns,
      aca: { enabled: false }, medicare: { premiumsEnabled: false, irmaaEnabled: false }, rothConversion: { enabled: false }, taxLossHarvesting: { enabled: false }, taxGainHarvesting: { enabled: false } },
    decisionProfile: { requiredSpend: 40000, flexibleSpend: 0, incomeBridge: { enabled: false } }
  });
  assert.equal(result.rescueOptions.find(option => option.kind === 'socialSecurityBridge'), undefined);
});

test('unclaimed fractional ages above 70 share a feasible next-month boundary', () => {
  const scenario = { currentAge: 75.01, socialSecurityStartAge: 76, socialSecurityClaimStatus: 'unclaimed', socialSecurityAnnualBenefit: 30000 };
  const [target] = feasibleSocialSecurityClaimAges(scenario);
  assert.equal(scenarioWithSocialSecurityClaimAge(scenario, 'primary', target).socialSecurityStartAge, target);
});
