import test from 'node:test';
import assert from 'node:assert/strict';
import { hsaContributionForYear } from '../src/core/simulation/hsa.mjs';
import { parsePortfolioCsv, normalizeImportedAsset } from '../src/core/importers.mjs';
import { sellFromLot } from '../src/core/portfolio.mjs';
import { simulatePlan, DEFAULT_SCENARIO } from '../src/core/simulation.mjs';
import { buildTaxProfile } from '../src/data/taxData.mjs';

// IRS Pub 969: employer contributions count against the shared family limit;
// each age-55 catch-up belongs in that person's own account.
// https://www.irs.gov/publications/p969 ; 2026 family cap: Rev Proc 2025-19.
test('both spouses employer deposits consume the family HSA cap regardless of allocation', () => {
  for (const spouseShare of [0, 0.5, 1]) for (const employerOwner of ['Primary', 'Spouse']) {
    const result = hsaContributionForYear({ scenario: { taxEfficiencyStrategy: {
      hsaContributionEnabled: true, hsaCoverage: 'family', hsaPrimaryEligibleMonths: 12,
      hsaSpouseEligibleMonths: 12, hsaSpouseBaseShare: spouseShare,
      [`hsa${employerOwner}EmployerContribution`]: 3000
    } }, age: 50, spouseAge: 50, inflationIndex: 1 });
    assert.equal(result.amount + 3000, 8750);
  }
});
test('family HSA cap preserves separate catch-ups and clamps employer excess', () => {
  const config = { hsaContributionEnabled: true, hsaCoverage: 'family', hsaPrimaryEligibleMonths: 12,
    hsaSpouseEligibleMonths: 12, hsaSpouseBaseShare: 0.5, hsaSpouseEmployerContribution: 3000 };
  const result = hsaContributionForYear({ scenario: { taxEfficiencyStrategy: config }, age: 55, spouseAge: 55, inflationIndex: 1 });
  assert.equal(result.amount + 3000, 10750);
  assert.equal(result.byOwner.primary, 5375);
  assert.equal(result.byOwner.spouse, 2375);
  const excess = hsaContributionForYear({ scenario: { taxEfficiencyStrategy: { ...config, hsaSpouseEmployerContribution: 15000 } }, age: 55, spouseAge: 55, inflationIndex: 1 });
  assert.equal(excess.amount, 0);
});

// Stock cost basis is total acquisition basis allocated across shares.
// https://www.irs.gov/faqs/capital-gains-losses-and-sale-of-home/stocks-options-splits-traders/stocks-options-splits-traders-1
test('broker total cost basis yields a $5000 gain instead of a fictitious $490000 loss', () => {
  for (const header of ['Cost Basis', 'Total Cost Basis', 'Total Basis']) {
    const [asset] = parsePortfolioCsv(`Name,Account Type,Shares,Price,${header}\nStock,Taxable,100,100,5000`);
    assert.equal(asset.costBasisPerUnit, 50);
    assert.equal(sellFromLot(asset, 10000).gain, 5000);
  }
  const [perShare] = parsePortfolioCsv('Name,Account Type,Shares,Price,Cost Basis / Share\nStock,Taxable,100,100,50');
  assert.equal(perShare.costBasisPerUnit, 50);
});
test('JSON total basis is supported and contradictory or invalid totals are rejected', () => {
  const lot = { accountType: 'taxable', units: 100, price: 100, costBasis: 5000 };
  assert.equal(normalizeImportedAsset(lot).costBasisPerUnit, 50);
  assert.throws(() => normalizeImportedAsset({ ...lot, costBasisPerUnit: 5000 }), /disagree/);
  assert.throws(() => normalizeImportedAsset({ ...lot, units: 0 }), /positive shares/);
  assert.throws(() => normalizeImportedAsset({ ...lot, costBasis: 'bad' }), /total cost basis/);
});

// SSA recomputes at FRA to credit months benefits were withheld for earnings.
// A spouse's death must not remove this own-record retirement adjustment.
// https://www.ssa.gov/benefits/retirement/planner/whileworking.html
test('own Social Security earnings credits survive either spouse death order', () => {
  const assets = [{ id: 'cash', accountType: 'taxable', assetClass: 'cash', units: 100000, price: 1, costBasisPerUnit: 1 }];
  for (const survivor of ['primary', 'spouse']) {
    const benefits = [];
    for (const dies of [false, true]) {
      const scenario = { ...DEFAULT_SCENARIO, startYear: 2026, currentAge: 62, spouseAge: 62, planYears: 6,
        targetSpend: 1000, requiredSpendingFloor: 1000, socialSecurityStartAge: 62, spouseSocialSecurityStartAge: 62,
        socialSecurityAnnualBenefit: survivor === 'primary' ? 24000 : 0,
        spouseSocialSecurityAnnualBenefit: survivor === 'spouse' ? 24000 : 0,
        medicareWages: survivor === 'primary' ? 100000 : 0, spouseMedicareWages: survivor === 'spouse' ? 100000 : 0,
        primaryMortalityAge: dies && survivor === 'spouse' ? 66 : 95,
        spouseMortalityAge: dies && survivor === 'primary' ? 66 : 95,
        aca: { enabled: false }, medicare: { premiumsEnabled: false },
        rothConversion: { enabled: false }, taxGainHarvesting: { enabled: false }, taxLossHarvesting: { enabled: false } };
      const plan = simulatePlan({ assets, scenario, taxProfile: buildTaxProfile({ state: 'Florida', filingStatus: 'marriedFilingJointly' }),
        returnSequence: Array.from({ length: 6 }, () => ({ cash: 0, stock: 0 })), inflationSequence: Array(6).fill(0) });
      benefits.push(plan.years.at(-1).socialSecurityBenefits);
    }
    assert.ok(Math.abs(benefits[0] - 24000 / 0.7) < 0.01);
    assert.equal(benefits[1], benefits[0]);
  }
});
