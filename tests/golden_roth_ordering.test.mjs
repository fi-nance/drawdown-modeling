// Golden ordering examples: IRS Publication 590-B, Ordering Rules for Distributions.
// https://www.irs.gov/publications/p590b
import test from 'node:test';
import assert from 'node:assert/strict';
import { clonePortfolio } from '../src/core/portfolio.mjs';
import { withdrawForCash } from '../src/core/simulation/withdrawalExecution.mjs';

const conversion = (id, amount, year, price = 1, owner = 'primary') => ({ id, owner, accountType: 'roth', assetClass: 'stock', units: amount, price, costBasisPerUnit: 1, rothSource: 'conversion', conversionYear: year });
const context = { age: 50, calendarYear: 2026, penaltyAge: 59.5, rothBasisRemaining: 0 };

test('partial appreciated Roth distribution consumes conversion dollars before earnings', () => {
  const portfolio = [conversion('old', 100000, 2020, 1.2)];
  const first = withdrawForCash(portfolio, 60000, ['roth'], context);
  assert.equal(first.ordinaryIncome, 0);
  assert.equal(first.penaltyTax, 0);
  const next = withdrawForCash(portfolio, 50000, ['roth'], { ...context, calendarYear: 2027 });
  assert.equal(next.ordinaryIncome, 10000);
  assert.equal(next.penaltyTax, 1000);
});

test('conversion ordering follows the owner history, independently of the security sold', () => {
  const portfolio = [conversion('old', 10000, 2020), conversion('new', 10000, 2025)];
  // A sale preference cannot override statutory ordering.
  portfolio[0].expectedReturn = 1;
  const result = withdrawForCash(portfolio, 15000, ['roth'], context);
  assert.equal(result.ordinaryIncome, 0);
  assert.equal(result.penaltyTax, 500);
});

test('withdrawal candidate clones retain independent Roth history after partial sales', () => {
  const portfolio = [conversion('old', 100000, 2020, 1.2)];
  withdrawForCash(portfolio, 60000, ['roth'], context);
  const candidate = clonePortfolio(portfolio);
  assert.equal(withdrawForCash(candidate, 50000, ['roth'], context).ordinaryIncome, 10000);
  assert.equal(withdrawForCash(portfolio, 40000, ['roth'], context).ordinaryIncome, 0);
});

test('one spouse cannot spend the other spouse regular contribution basis', () => {
  const portfolio = [{ ...conversion('spouse', 10000, 2026, 1, 'spouse'), rothSource: 'regular' }];
  const result = withdrawForCash(portfolio, 10000, ['roth'], { ...context, rothBasisRemaining: 10000, ownerAges: { primary: 50, spouse: 50 } });
  assert.equal(result.rothBasisUsed, 0);
  assert.equal(result.ordinaryIncome, 10000);
});

import { ensureRothLedger, rothLedgerSummary, parseRothConversionHistory, rolloverRothLedger } from '../src/core/rothLedger.mjs';
import { applyTotalReturnsWithIncome } from '../src/core/portfolio.mjs';
import { matureTipsLadderRungs } from '../src/core/simulation/tipsLadder.mjs';
import { simulatePlan } from '../src/core/simulation.mjs';

test('explicit history orders taxable then nontaxable principal within a conversion year', () => {
  const portfolio = [{ id: 'new-security', accountType: 'roth', assetClass: 'cash', units: 20000, price: 1 }];
  ensureRothLedger(portfolio, { rothBasis: 1000, rothConversionHistory: [
    { owner: 'primary', year: 2025, taxableAmount: 5000, nontaxableAmount: 2000 },
    { owner: 'primary', year: 2020, taxableAmount: 3000, nontaxableAmount: 1000 }
  ] });
  const first = withdrawForCash(portfolio, 7000, ['roth'], context);
  assert.equal(first.rothBasisUsed, 1000);
  assert.equal(first.ordinaryIncome, 0);
  assert.equal(first.penaltyTax, 200);
  const next = withdrawForCash(portfolio, 6000, ['roth'], context);
  assert.equal(next.ordinaryIncome, 1000);
  assert.equal(next.penaltyTax, 400);
});

test('investment losses and reinvested income do not rewrite conversion principal', () => {
  const portfolio = [conversion('old', 10000, 2020, 0.5)];
  ensureRothLedger(portfolio);
  portfolio[0].dividendYield = 0.1;
  applyTotalReturnsWithIncome(portfolio, { stock: 2 });
  assert.equal(rothLedgerSummary(portfolio, context).conversionPrincipal, 10000);
  assert.equal(withdrawForCash(portfolio, 10000, ['roth'], context).ordinaryIncome, 0);
});

test('a Roth ladder maturity shares history with unmatured securities', () => {
  const portfolio = [conversion('rung', 6000, 2025), conversion('seasoned', 10000, 2020)];
  portfolio[0].tipsLadderYear = 0;
  const matured = matureTipsLadderRungs({ portfolio, yearIndex: 0, context });
  assert.equal(matured.withdrawal.penaltyTax, 0);
  assert.equal(withdrawForCash(portfolio, 5000, ['roth'], context).penaltyTax, 100);
});

test('surviving spouses combine inherited Roth history only on rollover, in either death order', () => {
  for (const deceased of ['primary', 'spouse']) {
    const portfolio = [conversion('primary', 2000, 2020), conversion('spouse', 2000, 2025, 1, 'spouse')];
    ensureRothLedger(portfolio, { rothBasis: 1000, spouseRothBasis: 1000 });
    rolloverRothLedger(portfolio, deceased);
    rolloverRothLedger(portfolio, deceased);
    assert.equal(withdrawForCash(portfolio, 4000, ['roth'], context).penaltyTax, 0);
  }
});

test('Roth opening history validation rejects ambiguous and negative inputs', () => {
  assert.deepEqual(parseRothConversionHistory('spouse, 2020, 5000, 200'), [{ owner: 'spouse', year: 2020, taxableAmount: 5000, nontaxableAmount: 200 }]);
  for (const text of ['joint, 2020, 500', 'primary, 2020, -100', 'primary, 2020, 1,000,000', 'primary, , 100']) assert.throws(() => parseRothConversionHistory(text));
});

test('multi-year plan preserves remaining conversion principal in audit results', () => {
  const plan = simulatePlan({ assets: [conversion('old', 100000, 2020, 1.2)], scenario: {
    startYear: 2026, currentAge: 50, planYears: 2, targetSpend: 60000,
    targetSpendIncludesTaxes: true, targetSpendIncludesMedical: true, withdrawalOrder: ['roth'],
    rothBasis: 0, aca: { enabled: false }, rothConversion: { enabled: false },
    rothBasisOptimization: { enabled: false }, returnAssumptions: { stock: { mean: 0, stdev: 0 } }
  }, returnSequence: [{ stock: 0 }, { stock: 0 }], inflationSequence: [0, 0] });
  assert.equal(plan.years[0].rothConversionPrincipalRemaining, 40000);
  assert.equal(plan.years[0].penaltyTax, 0);
  assert.equal(plan.years[1].penaltyTax, 2000);
  assert.equal(plan.rothLedger.primary.conversions[0].taxableAmount, 0);
});

test('spousal own-IRA rollover uses the earlier spouse five-year clock for either original asset owner', () => {
  for (const deceased of ['primary', 'spouse']) {
    const portfolio = [conversion('primary', 10000, 2020, 1.2), conversion('spouse', 10000, 2020, 1.2, 'spouse')];
    ensureRothLedger(portfolio);
    rolloverRothLedger(portfolio, deceased);
    const result = withdrawForCash(portfolio, 24000, ['roth'], { ...context, age: 65, ownerAges: { primary: 65, spouse: 65 }, rothFiveYearRuleSatisfied: false, spouseRothFiveYearRuleSatisfied: true });
    assert.equal(result.ordinaryIncome, 0);
    assert.equal(result.penaltyTax, 0);
  }
});

test('mixed-age history summaries apply each owner age without transferring unused basis', () => {
  const portfolio = [conversion('primary', 1000, 2025), conversion('spouse', 5000, 2025, 1, 'spouse')];
  const options = { ...context, age: 65, ownerAges: { primary: 65, spouse: 50 } };
  const result = rothLedgerSummary(portfolio, options);
  assert.equal(result.penaltyFreeConversionPrincipal, 1000);
  assert.equal(result.available, 1000);
});

import { scalePortfolioToValue } from '../src/core/simulation/riskBasedGuardrails.mjs';
test('guardrail probes preserve tax history when hypothetical portfolio values are scaled', () => {
  const portfolio = [conversion('old', 100000, 2020, 1.2)];
  withdrawForCash(portfolio, 60000, ['roth'], context);
  const scaled = scalePortfolioToValue(portfolio, 60000);
  assert.equal(withdrawForCash(scaled, 50000, ['roth'], context).ordinaryIncome, 10000);
});
