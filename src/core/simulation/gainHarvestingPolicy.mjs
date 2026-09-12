import { round } from '../utils.mjs';

// Compare complete expected-return plans, never a realized Monte Carlo or
// historical future. Targets are income ceilings, not unconditional sales.
// This is a bounded policy search, not a claim of a global optimum.
export function selectGainHarvestingPolicy({ assets, scenario, evaluate }) {
  const disabled = { enabled: false };
  if (!scenario.taxGainHarvesting?.enabled || scenario.taxGainHarvesting.mode === 'manual'
      || scenario.withdrawalStrategy?.mode !== 'lifetime' || !scenario.aca?.enabled
      || scenario.planYears < 2 || !assets.some(asset => asset.accountType === 'taxable'
        && asset.units > 0 && asset.price > 0
        && (asset.assetClass !== 'cash' || scenario.allocationStrategy?.rebalanceEnabled))) return disabled;

  const baselinePlan = evaluate(disabled);
  const baseline = summarize(baselinePlan, scenario);
  const coverageYears = baselinePlan.years.map(year => !year.postMortality
    && year.aca?.grossPremium > 0);
  if (!coverageYears.some(Boolean)) return disabled;
  const candidates = [{ label: 'Current-year heuristic', targets: null, admissible: true, ...baseline }];
  let selected = candidates[0];
  const patterns = [0, 200, 250, 300, 350, 400].map(target => ({
    label: target ? `Up to ${target}% FPL` : 'Defer ACA-year harvesting',
    targets: coverageYears.map(covered => covered ? target : null)
  }));
  for (const years of [1, 3, 5]) {
    if (years >= coverageYears.filter(Boolean).length) continue;
    let coveredYear = 0;
    patterns.push({ label: `Up to 400% FPL for ${years} ${years === 1 ? 'year' : 'years'}, then defer`,
      targets: coverageYears.map(covered => covered ? (++coveredYear <= years ? 400 : 0) : null) });
  }
  for (const pattern of patterns) {
    const result = summarize(evaluate({ enabled: true, targets: pattern.targets }), scenario);
    const admissible = result.essentialShortfall <= baseline.essentialShortfall + 0.01
      && result.fundedSpending >= baseline.fundedSpending - 1
      && (!baseline.planningSuccess || result.planningSuccess);
    const candidate = { ...pattern, ...result, admissible };
    candidates.push(candidate);
    // Never buy a larger bequest by cutting the household's funded spending
    // or introducing an essential shortfall. Compare real after-tax wealth;
    // taxes, premiums, cash funding and future basis are in the same rollout.
    if (!admissible) continue;
    if (candidate.realHeirValue > selected.realHeirValue + 1
        || (Math.abs(candidate.realHeirValue - selected.realHeirValue) <= 1
          && candidate.fundedSpending > selected.fundedSpending + 1)) selected = candidate;
  }
  return {
    enabled: true,
    targets: selected.targets,
    summary: {
      method: 'expected-return-policy-comparison',
      selectedPolicy: selected.label,
      projectedRealBenefit: round(selected.realHeirValue - baseline.realHeirValue, 2),
      projectedRealSpendingBenefit: round(selected.fundedSpending - baseline.fundedSpending, 2),
      projectedPtcYearsChange: selected.ptcYears - baseline.ptcYears,
      baseline,
      selected: { ...selected },
      candidates
    }
  };
}

function summarize(plan, scenario) {
  const years = plan.years.filter(year => !year.postMortality);
  const sum = field => round(years.reduce((total, year) => total + field(year) / year.inflationIndex, 0), 2);
  return {
    planningSuccess: plan.planningSuccess,
    essentialShortfall: plan.spendingOutcome.totalEssentialShortfall,
    fundedSpending: sum(year => Math.max(0, year.fundedCoreSpending
      - (year.medicalCostIncludedInSpending ?? 0)
      - (scenario.targetSpendIncludesTaxes ? Math.max(0, year.taxes.totalTax) : 0))),
    realHeirValue: round(plan.heirValue / (years.at(-1)?.inflationIndex ?? 1), 2),
    taxes: sum(year => year.taxes.totalTax),
    medical: sum(year => year.medicalCost + (year.medicalCostIncludedInSpending ?? 0)),
    ptc: sum(year => year.aca?.subsidy ?? 0),
    ptcYears: years.filter(year => year.aca?.subsidy > 1).length,
    years: years.map(year => ({ year: year.year, magi: year.acaMagi,
      harvested: year.taxGainHarvested, taxes: year.taxes.totalTax,
      netPremium: year.aca?.netPremium ?? 0, ptc: year.aca?.subsidy ?? 0 }))
  };
}
