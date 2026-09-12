// Read-only financial audit reproductions. Run with:
// node docs/reviews/2026-09-11/reproduce.mjs
// These print current behavior beside the economic invariant; no source edits.
import { hsaContributionForYear } from '../../../src/core/simulation/hsa.mjs';
import { parsePortfolioCsv } from '../../../src/core/importers.mjs';
import { sellFromLot } from '../../../src/core/portfolio.mjs';
import { simulatePlan, DEFAULT_SCENARIO } from '../../../src/core/simulation.mjs';
import { buildTaxProfile } from '../../../src/data/taxData.mjs';

const observations = [];
const report = observation => observations.push(observation);

const hsa = hsaContributionForYear({ scenario: { taxEfficiencyStrategy: {
  hsaContributionEnabled: true, hsaCoverage: 'family', hsaPrimaryEligibleMonths: 12,
  hsaSpouseEligibleMonths: 12, hsaSpouseBaseShare: 0, hsaSpouseEmployerContribution: 3000
} }, age: 50, spouseAge: 50, inflationIndex: 1 });
report({ finding: 'HSA family limit must include BOTH employers',
  sources: ['https://www.irs.gov/publications/p969', 'https://www.irs.gov/irb/2025-21_IRB'],
  personalContribution: hsa.amount, employerContribution: 3000, combined: hsa.amount + 3000,
  expectedMaximumCombined: 8750, safe: hsa.amount + 3000 <= 8750 });

try {
  const [asset] = parsePortfolioCsv('Name,Account Type,Shares,Price,Cost Basis\nStock,Taxable,100,100,5000');
  const sale = sellFromLot(asset, 10000);
  report({ finding: 'Broker total Cost Basis cannot silently mean per-share basis',
    source: 'https://www.irs.gov/faqs/capital-gains-losses-and-sale-of-home/stocks-options-splits-traders/stocks-options-splits-traders-1',
    observedGain: sale.gain, observedCostBasisSold: sale.costBasisSold,
    expectedGainIfTotalBasis: 5000, expectedCostBasisSoldIfTotalBasis: 5000,
    safe: sale.gain === 5000 });
} catch (error) {
  report({ finding: 'Ambiguous Cost Basis import rejected safely', error: error.message, safe: true });
}

const assets = [{ id: 'cash', accountType: 'taxable', assetClass: 'cash', units: 100000, price: 1, costBasisPerUnit: 1 }];
const shared = { ...DEFAULT_SCENARIO, startYear: 2026, currentAge: 62, spouseAge: 62,
  planYears: 6, targetSpend: 1000, requiredSpendingFloor: 1000,
  socialSecurityStartAge: 62, spouseSocialSecurityStartAge: 62,
  estimateSocialSecurityFromEarnings: false, aca: { enabled: false },
  medicare: { premiumsEnabled: false }, rothConversion: { enabled: false },
  taxLossHarvesting: { enabled: false }, taxGainHarvesting: { enabled: false } };
for (const survivor of ['primary', 'spouse']) {
  const result = {};
  for (const otherDies of [false, true]) {
    const plan = simulatePlan({ assets,
      scenario: { ...shared, socialSecurityAnnualBenefit: survivor === 'primary' ? 24000 : 0,
        spouseSocialSecurityAnnualBenefit: survivor === 'spouse' ? 24000 : 0,
        medicareWages: survivor === 'primary' ? 100000 : 0,
        spouseMedicareWages: survivor === 'spouse' ? 100000 : 0,
        primaryMortalityAge: otherDies && survivor === 'spouse' ? 66 : 95,
        spouseMortalityAge: otherDies && survivor === 'primary' ? 66 : 95 },
      taxProfile: buildTaxProfile({ state: 'Florida', filingStatus: 'marriedFilingJointly' }),
      returnSequence: Array.from({ length: 6 }, () => ({ cash: 0, stock: 0 })), inflationSequence: Array(6).fill(0) });
    const final = plan.years.at(-1);
    result[otherDies ? 'otherSpouseDied' : 'bothLiving'] = { benefit: final.socialSecurityBenefits,
      earningsTest: final.socialSecurityEarningsTest[survivor] };
  }
  report({ finding: 'Own-record FRA earnings credit must survive spouse death', survivor,
    source: 'https://www.ssa.gov/benefits/retirement/planner/whileworking.html',
    ...result, annualUnderstatement: result.bothLiving.benefit - result.otherSpouseDied.benefit,
    safe: result.bothLiving.benefit === result.otherSpouseDied.benefit });
}

console.log(JSON.stringify(observations, null, 2));
