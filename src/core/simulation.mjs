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
} from "./simulation/plan.mjs?v=20260613-portfolio-prices";
export { DEFAULT_SCENARIO } from "./simulation/scenario.mjs?v=20260613-portfolio-prices";
export {
  MONTE_CARLO_ASSUMPTION_PRESETS,
  DEFAULT_MONTE_CARLO_MEAN_REVERSION,
  DEFAULT_MONTE_CARLO_RUNS,
  MEDICAL_INFLATION_PREMIUM
} from "./simulation/constants.mjs?v=20260613-portfolio-prices";
