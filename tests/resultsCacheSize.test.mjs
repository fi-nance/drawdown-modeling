/* Sizing check: how big is the serialized `latest` blob for realistic Monte
   Carlo run counts? sessionStorage typically caps at ~5 MB in browsers, so
   anything larger than that means the cache silently fails and the
   results-screen refresh falls back to the (slow) recompute path. */

import assert from "node:assert/strict";
import test from "node:test";

import { compactLatestForCache } from "../src/core/resultsCache.mjs";
import { runHistoricalBacktests, runMonteCarlo, simulatePlan } from "../src/core/simulation.mjs";
import { sampleAssets } from "../src/data/sample.mjs";

function buildLatest(runs, monteCarloOptions = {}) {
  const assets = sampleAssets.map((asset) => ({ ...asset }));
  const scenario = { planYears: 35, currentAge: 55, targetSpend: 90_000 };
  const plan = simulatePlan({ assets, scenario });
  const monteCarlo = runMonteCarlo({ assets, scenario, runs, seed: 42, ...monteCarloOptions });
  const backtests = runHistoricalBacktests({ assets, scenario, sequences: [] });
  return { scenario, plan, monteCarlo, backtests };
}

function sizeKb(value) {
  return Math.round(JSON.stringify(value).length / 1024);
}

const BROWSER_QUOTA_KB = 5 * 1024; // ~5 MB typical sessionStorage quota

test("real-world: 50-run latest exceeds the sessionStorage quota when stored uncompacted (regression check)", () => {
  // Documents WHY we compact: at just 50 runs the uncompacted blob is already
  // multiple times the typical 5 MB quota. If this ever stops being true the
  // compaction layer can be reconsidered.
  const latest = buildLatest(50);
  const kb = sizeKb(latest);
  console.log(`  uncompacted 50 runs → ${kb} KB`);
  assert.ok(kb > BROWSER_QUOTA_KB, `expected uncompacted 50 runs (${kb} KB) to exceed ~5 MB quota`);
});

test("real-world: 250-run latest exceeds quota too — compaction is required", () => {
  const latest = buildLatest(250);
  const kb = sizeKb(latest);
  console.log(`  uncompacted 250 runs → ${kb} KB`);
  assert.ok(kb > BROWSER_QUOTA_KB);
});

test("real-world: compact 250-run latest fits under the sessionStorage quota", () => {
  const latest = buildLatest(250);
  const fullKb = sizeKb(latest);
  const compactKb = sizeKb(compactLatestForCache(latest));
  console.log(`  250 runs · full ${fullKb} KB · compact ${compactKb} KB · ratio ${(fullKb/Math.max(1,compactKb)).toFixed(1)}x`);
  assert.ok(compactKb < BROWSER_QUOTA_KB, `compact form ${compactKb} KB must fit under ~5 MB quota`);
});

test("real-world: compact 1000-run latest still fits under the sessionStorage quota", () => {
  const latest = buildLatest(1000);
  const compactKb = sizeKb(compactLatestForCache(latest));
  console.log(`  compact 1000 runs → ${compactKb} KB`);
  assert.ok(compactKb < BROWSER_QUOTA_KB, `compact 1000-run form ${compactKb} KB must fit under ~5 MB quota`);
});

test("real-world: worker-style 1000-run latest avoids the uncompacted live payload", () => {
  const latest = buildLatest(1000, { scenarioTimelineLimit: 5 });
  const kb = sizeKb(latest);
  console.log(`  worker-style 1000 runs → ${kb} KB`);
  assert.ok(kb < 15 * 1024, `worker-style 1000-run payload (${kb} KB) should stay comfortably below crash-prone sizes`);
});
