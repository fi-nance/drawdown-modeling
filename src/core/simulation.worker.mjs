/* Simulation Web Worker.
   Receives a single { type: "run", id, payload } message, runs simulatePlan +
   runMonteCarlo + runHistoricalBacktests off the main thread, and posts
   progress + result/error messages back. */

import {
  runHistoricalBacktests,
  runMonteCarlo,
  simulatePlan
} from "./simulation.mjs";

self.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "run") return;
  const { id, payload } = msg;
  try {
    const { assets, scenario, taxProfile, runs, seed, sequences } = payload;
    const plan = simulatePlan({ assets, scenario, taxProfile });
    const monteCarlo = runMonteCarlo({
      assets,
      scenario,
      taxProfile,
      runs,
      seed,
      onProgress: ({ done, total }) => {
        self.postMessage({ type: "progress", id, phase: "monteCarlo", done, total });
      }
    });
    const backtests = runHistoricalBacktests({ assets, scenario, taxProfile, sequences });
    self.postMessage({ type: "result", id, plan, monteCarlo, backtests });
  } catch (err) {
    self.postMessage({
      type: "error",
      id,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null
    });
  }
});
