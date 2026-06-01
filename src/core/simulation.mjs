// Public facade for the drawdown simulation engine.
//
// The implementation was split into single-responsibility modules under
// ./simulation/. This barrel re-exports the stable public API so existing
// importers (src/app.mjs, src/core/decisionEngine.mjs, and the test suite)
// keep working unchanged, including the ?v= cache-bust query string used by
// the browser entrypoint.
export {
  simulatePlan,
  runMonteCarlo,
  runHistoricalBacktests,
  generateSingleMonteCarloPath
} from "./simulation/plan.mjs";
export { DEFAULT_SCENARIO } from "./simulation/scenario.mjs";
export {
  MONTE_CARLO_ASSUMPTION_PRESETS,
  DEFAULT_MONTE_CARLO_RUNS,
  MEDICAL_INFLATION_PREMIUM
} from "./simulation/constants.mjs";
