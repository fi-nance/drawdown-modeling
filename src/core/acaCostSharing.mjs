// Silver variants apply to enrollment eligibility, not to a tax refund. These
// annual planning estimates assume Marketplace income estimates stay current.
export function acaCostSharing(config, result, magi = null) {
  const csr = config?.csr;
  if (!config?.enabled || !csr?.enabled || result.activePlanRole === 'backup') return null;
  const calendar = (config.coverageCalendar ?? []).filter(row => Number(row.year) === Number(config.coverageYear ?? config.year ?? 2026));
  const confirmed = calendar.length ? calendar.every(row => row.eligibility === 'eligible') : config.ptcEligibility === 'eligible';
  const fplPercent = Number.isFinite(magi) && config.fpl > 0 ? magi / config.fpl * 100 : result.fplPercent;
  const qualifies = result.eligible && confirmed && fplPercent >= 100 && fplPercent <= 250;
  const band = qualifies ? fplPercent <= 150 ? 'silver94' : fplPercent <= 200 ? 'silver87' : 'silver73' : 'standard';
  const variant = csr[band];
  if (!variant || !Number.isFinite(variant.oopMaximum) || !Number.isFinite(variant.expectedOop)
    || variant.oopMaximum <= 0 || variant.expectedOop < 0 || variant.expectedOop > variant.oopMaximum) {
    throw new RangeError(`ACA ${band}: enter a nonnegative annual OOP maximum and expected cost no greater than that maximum.`);
  }
  const index = config.premiumInflationIndex ?? 1;
  return { band, eligible: qualifies, oopMaximum: variant.oopMaximum * index,
    expectedOop: variant.expectedOop * index,
    eligibilityReason: qualifies ? 'confirmed-silver-variant' : !confirmed ? 'eligibility-unconfirmed-or-mixed' : 'income-or-filing-ineligible' };
}

export function validateAcaCostSharing(config) {
  if (!config?.csr?.enabled) return;
  for (const fplPercent of [125, 175, 225, 300]) acaCostSharing({ ...config, enabled: true, ptcEligibility: 'eligible', coverageCalendar: [] }, { eligible: true, fplPercent });
}
