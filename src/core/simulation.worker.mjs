/* Simulation Web Worker.
   Streams partial results back: plan → backtests → batched Monte Carlo
   scenarios → final result with summary. */

import {
  runHistoricalBacktests,
  runMonteCarlo,
  simulatePlan
} from "./simulation.mjs?v=20260613-rescue-precision";
import { runDecisionBatch } from "./decisionEngine.mjs?v=20260613-long-horizon-progress-b";

const UI_MONTE_CARLO_TIMELINE_LIMIT = 5;

self.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "run") return;
  const { id, payload } = msg;
  try {
    const { assets, scenario, taxProfile, runs, seed, sequences, decisionProfile } = payload;

    const plan = simulatePlan({ assets, scenario, taxProfile });
    self.postMessage({ type: "plan-ready", id, plan });

    const backtests = runHistoricalBacktests({ assets, scenario, taxProfile, sequences });
    self.postMessage({ type: "backtests-ready", id, backtests });

    const monteCarlo = runMonteCarlo({
      assets,
      scenario,
      taxProfile,
      runs,
      seed,
      scenarioTimelineLimit: UI_MONTE_CARLO_TIMELINE_LIMIT,
      onBatch: ({ scenarios, done, total }) => {
        self.postMessage({
          type: "scenarios-batch",
          id,
          scenarios,
          done,
          total
        });
      }
    });
    const decision = runDecisionBatch({
      assets,
      scenario,
      taxProfile,
      runs,
      seed,
      sequences,
      decisionProfile,
      basePlan: plan,
      baseMonteCarlo: monteCarlo,
      baseBacktests: backtests,
      onProgress: (progress) => {
        self.postMessage({
          type: "decision-progress",
          id,
          progress
        });
      }
    });
    self.postMessage({ type: "decision-ready", id, decision });
    self.postMessage({ type: "result", id, summary: monteCarlo.summary });
  } catch (err) {
    self.postMessage({
      type: "error",
      id,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null
    });
  }
});
