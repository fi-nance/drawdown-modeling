import { runMonteCarlo } from './simulation.mjs';
import { isMarriedFiling, lifetimeHorizonForScenario } from './simulation/household.mjs';

export function longevityStressScenarios(scenario, filingStatus, extraYears = 5) {
  const increment = Math.max(1, Math.min(20, Math.trunc(extraYears) || 5));
  const married = isMarriedFiling(filingStatus) && scenario.spouseAge != null;
  const variants = [{ id: 'baseline', label: 'Current lifetimes', owners: [] },
    { id: 'primary', label: `You live ${increment} years longer`, owners: ['primary'] },
    ...(married ? [{ id: 'spouse', label: `Spouse lives ${increment} years longer`, owners: ['spouse'] },
      { id: 'both', label: `Both live ${increment} years longer`, owners: ['primary', 'spouse'] }] : [])];
  return variants.map(({ owners, ...variant }) => {
    const next = { ...scenario };
    for (const owner of owners) {
      const field = `${owner}MortalityAge`;
      next[field] = Number(scenario[field] ?? 95) + increment;
    }
    next.planYears = Math.max(Number(scenario.planYears) || 1, lifetimeHorizonForScenario(next, filingStatus).requiredYears);
    return { ...variant, scenario: next };
  });
}

// A full-horizon baseline makes every comparison meaningful even when the
// original setup ended before the configured death ages. Shared seed and
// horizon give corresponding runs the same market/inflation draws.
export function runLongevityStress({ assets, scenario, taxProfile, runs = 1000, seed = 42, extraYears = 5, onProgress }) {
  const variants = longevityStressScenarios(scenario, taxProfile.filingStatus, extraYears);
  const commonYears = Math.max(...variants.map(row => row.scenario.planYears));
  return variants.map((variant, index) => {
    const testedScenario = { ...variant.scenario, planYears: commonYears };
    const result = runMonteCarlo({ assets, scenario: testedScenario, taxProfile, runs, seed, scenarioTimelineLimit: 0,
      onProgress: progress => onProgress?.({ ...progress, variant: variant.label, index, totalVariants: variants.length }) });
    return { id: variant.id, label: variant.label, scenario: testedScenario, summary: result.summary };
  });
}
