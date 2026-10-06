// Golden tests for the federal quarterly estimated-tax safe harbors modeled in
// src/core/quarterlyTax.mjs, traced to primary sources:
// - 2026 Form 1040-ES, Estimated Tax for Individuals ("Who Must Make Estimated
//   Tax Payments", "When To Pay Estimated Tax" and the Estimated Tax
//   Worksheet lines 12b/12c/14a-14c): https://www.irs.gov/pub/irs-pdf/f1040es.pdf
// - IRS Publication 505, Tax Withholding and Estimated Tax (chapter 2):
//   https://www.irs.gov/publications/p505
// - IRC §6654(d)(1) (required annual payment: lesser of 90% current year or
//   100%/110% prior year), §6654(e)(1) ($1,000 de-minimis), §6654(e)(2)
//   (prior-year no-tax exception), §6654(g) (withholding deemed paid evenly):
//   https://uscode.house.gov/view.xhtml?req=(title:26%20section:6654%20edition:prelim)
// Each case asserts 2026-law-year values, not "current" values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUARTERLY_DUE_DATES, calculateQuarterlyTax } from '../src/core/quarterlyTax.mjs';

const plan = (overrides = {}, payments = []) => ({
  version: 1, taxYear: 2026, through: '2026-09-22',
  reviewedSourceExportedAt: '2026-09-22T00:00:00Z',
  filingStatus: 'single', priorYearMethod: 'Full-year return',
  priorYearAgi: 160000, priorYearTax: 10000,
  projectedFederalTax: 20000, remainingWithholding: 0,
  coverageReviewed: true, regularInstallmentsReviewed: true,
  payments, ...overrides
});
const withholding = amount => [{ id: 'w1', jurisdiction: 'Federal', kind: 'Withholding', date: '2026-03-01', amount, status: 'Paid' }];

test('golden: 2026 regular-installment due dates match Form 1040-ES "When To Pay Estimated Tax"', () => {
  // 2026 Form 1040-ES payment due dates: April 15, 2026; June 15, 2026;
  // Sept. 15, 2026; Jan. 15, 2027. These are year-specific — a different law
  // year must not reuse them (validateQuarterlyTax pins taxYear 2026).
  assert.deepEqual(QUARTERLY_DUE_DATES, ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15']);
  const result = calculateQuarterlyTax(plan({}, withholding(4000)));
  assert.deepEqual(result.quarters.map(q => q.dueDate), QUARTERLY_DUE_DATES);
  assert.equal(result.taxYear, 2026);
});

test('golden: required annual payment is the lesser of 90% current-year or 110% prior-year above $150,000 AGI (§6654(d)(1)(C), worksheet lines 12b/14a)', () => {
  // Worked example per Pub 505 ch. 2: 2026 projected tax $20,000 → 90% =
  // $18,000. 2025 tax $10,000 with 2025 AGI $160,000 (> $150,000) → 110% =
  // $11,000. Required annual payment = lesser = $11,000.
  const result = calculateQuarterlyTax(plan({}, withholding(4000)));
  assert.equal(result.currentYearTarget, 18000);
  assert.equal(result.priorYearMultiplier, 110);
  assert.equal(result.priorYearTarget, 11000);
  assert.equal(result.annualTarget, 11000);
  assert.equal(result.basis, 'Prior-year 110%');
  // Cumulative installment targets are 25% of the required annual payment at
  // each due date (1040-ES: "pay in four equal amounts").
  assert.deepEqual(result.quarters.map(q => q.cumulativeTarget), [2750, 5500, 8250, 11000]);
  // §6654(g): withholding is treated as paid in four equal installments.
  assert.deepEqual(result.quarters.map(q => q.forecastCoverage), [1000, 2000, 3000, 4000]);
  assert.deepEqual(result.quarters.map(q => q.forecastGap), [1750, 3500, 5250, 7000]);
  assert.equal(result.nextDueDate, '2027-01-15');
  assert.equal(result.nextAdditionalPayment, 7000);
  // Catch-up through the 2026-09-15 installment: 3/4 of $11,000 minus 3/4 of
  // $4,000 withholding = $8,250 − $3,000 = $5,250.
  assert.equal(result.catchUpForecast, 5250);
});

test('golden: the 110% substitution applies only when prior-year AGI EXCEEDS $150,000 ($75,000 MFS) (1040-ES line 12b instruction)', () => {
  // At exactly $150,000 the 100% safe harbor still applies.
  const at = calculateQuarterlyTax(plan({ priorYearAgi: 150000 }, withholding(4000)));
  assert.equal(at.priorYearMultiplier, 100);
  assert.equal(at.priorYearTarget, 10000);
  assert.equal(at.basis, 'Prior-year 100%');
  // Married filing separately halves the threshold to $75,000.
  const mfsOver = calculateQuarterlyTax(plan({ filingStatus: 'marriedFilingSeparately', priorYearAgi: 75001 }, withholding(4000)));
  assert.equal(mfsOver.priorYearMultiplier, 110);
  const mfsAt = calculateQuarterlyTax(plan({ filingStatus: 'marriedFilingSeparately', priorYearAgi: 75000 }, withholding(4000)));
  assert.equal(mfsAt.priorYearMultiplier, 100);
});

test('golden: no installments are required when the balance after withholding is under $1,000 (§6654(e)(1), 1040-ES "Who Must Make")', () => {
  // Projected tax $20,000 with $19,100 withholding → $900 expected balance,
  // below the $1,000 statutory floor → no required payments.
  const result = calculateQuarterlyTax(plan({}, withholding(19100)));
  assert.equal(result.annualTarget, 0);
  assert.equal(result.basis, 'Projected balance after withholding below $1,000');
  assert.deepEqual(result.quarters.map(q => q.cumulativeTarget), [0, 0, 0, 0]);
  assert.deepEqual(result.quarters.map(q => q.forecastGap), [0, 0, 0, 0]);
  // At exactly $1,000 owed the safe-harbor targets apply again.
  const atFloor = calculateQuarterlyTax(plan({}, withholding(19000)));
  assert.equal(atFloor.annualTarget, 11000);
});

test('golden: without a prior-year return only the 90% current-year standard applies (§6654(d)(1)(B))', () => {
  const result = calculateQuarterlyTax(plan({ priorYearMethod: 'Unavailable', priorYearAgi: null, priorYearTax: null }, withholding(4000)));
  assert.equal(result.priorYearTarget, null);
  assert.equal(result.annualTarget, 18000);
  assert.equal(result.basis, 'Projected current-year 90%');
});

test('golden: zero prior-year liability for a full 12-month year requires no estimated payments (§6654(e)(2))', () => {
  const result = calculateQuarterlyTax(plan({ priorYearMethod: 'No-tax exception', priorYearAgi: null, priorYearTax: 0 }, withholding(4000)));
  assert.equal(result.annualTarget, 0);
  assert.equal(result.basis, 'Reviewed prior-year no-tax exception');
  assert.deepEqual(result.quarters.map(q => q.cumulativeTarget), [0, 0, 0, 0]);
});
