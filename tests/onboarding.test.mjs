import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  representativeAssets,
  portfolioFromTotal,
  essentialsToControls
} from "../src/core/onboarding.mjs";
import { simulatePlan } from "../src/core/simulation.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

const sumUnits = (assets) => assets.reduce((acc, a) => acc + a.units * a.price, 0);
const redesignSource = () => readFile(new URL("../src/redesign.mjs", import.meta.url), "utf8");
const htmlSource = () => readFile(new URL("../index.html", import.meta.url), "utf8");
const ONBOARDING_RESULTS_STREAM_ASSET_KEY = "20260622-zero-inputs";

function sourceSlice(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Could not find ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `Could not find ${endNeedle}`);
  return source.slice(start, end);
}

test("portfolioFromTotal: single number is modeled as a taxable stock/bond split summing to the total", () => {
  const assets = portfolioFromTotal({ total: 1_000_000, stockPercent: 60 });

  assert.equal(assets.length, 2, "one stock lot + one bond lot");
  assert.ok(assets.every((a) => a.accountType === "taxable"), "all taxable");
  assert.equal(sumUnits(assets), 1_000_000, "lots sum to the entered total");

  const stock = assets.find((a) => a.assetClass === "stock");
  const bond = assets.find((a) => a.assetClass === "bond");
  assert.equal(stock.units, 600_000);
  assert.equal(bond.units, 400_000);
  // Class income defaults are applied so the lots behave like broad funds.
  assert.equal(stock.qualifiedDividendShare, 0.95);
  assert.equal(bond.qualifiedDividendShare, 0);
});

test("representativeAssets: one stock+bond lot per non-empty bucket, empty buckets skipped, totals preserved", () => {
  const assets = representativeAssets({
    taxable: 500_000,
    traditional: 300_000,
    roth: 200_000,
    hsa: 0,
    stockPercent: 70
  });

  const byAccount = (type) => assets.filter((a) => a.accountType === type);
  assert.equal(byAccount("taxable").length, 2);
  assert.equal(byAccount("traditional").length, 2);
  assert.equal(byAccount("roth").length, 2);
  assert.equal(byAccount("hsa").length, 0, "zero bucket produces no lots");

  // Each bucket's lots sum back to its dollar amount exactly (no rounding drift).
  assert.equal(sumUnits(byAccount("taxable")), 500_000);
  assert.equal(sumUnits(byAccount("traditional")), 300_000);
  assert.equal(sumUnits(byAccount("roth")), 200_000);
  assert.equal(sumUnits(assets), 1_000_000);

  // 70% stock applied uniformly.
  const taxableStock = byAccount("taxable").find((a) => a.assetClass === "stock");
  assert.equal(taxableStock.units, 350_000);
});

test("taxable cost basis reflects the unrealized-gains assumption; sheltered buckets keep full basis", () => {
  // Default 50% gains → taxable basis 0.5; sheltered (traditional/Roth/HSA) basis 1.
  const mixed = representativeAssets({ taxable: 100_000, traditional: 100_000, roth: 100_000, hsa: 100_000, stockPercent: 50 });
  for (const a of mixed) {
    if (a.accountType === "taxable") assert.equal(a.costBasisPerUnit, 0.5);
    else assert.equal(a.costBasisPerUnit, 1);
  }

  // Explicit gains share maps to basis = 1 − gains.
  const g30 = representativeAssets({ taxable: 100_000, stockPercent: 100, taxableGainsPercent: 30 });
  assert.equal(g30[0].costBasisPerUnit, 0.7);

  // 0% gains → basis equals value (no embedded gain); 100% → basis 0.
  assert.equal(representativeAssets({ taxable: 100_000, stockPercent: 100, taxableGainsPercent: 0 })[0].costBasisPerUnit, 1);
  assert.equal(representativeAssets({ taxable: 100_000, stockPercent: 100, taxableGainsPercent: 100 })[0].costBasisPerUnit, 0);

  // portfolioFromTotal defaults to 50% gains.
  assert.equal(portfolioFromTotal({ total: 100_000, stockPercent: 100 })[0].costBasisPerUnit, 0.5);
});

test("representativeAssets: stockPercent extremes drop the empty class lot", () => {
  const allStock = representativeAssets({ taxable: 100_000, stockPercent: 100 });
  assert.equal(allStock.length, 1);
  assert.equal(allStock[0].assetClass, "stock");
  assert.equal(allStock[0].units, 100_000);

  const allBond = representativeAssets({ taxable: 100_000, stockPercent: 0 });
  assert.equal(allBond.length, 1);
  assert.equal(allBond[0].assetClass, "bond");
  assert.equal(allBond[0].units, 100_000);
});

test("representativeAssets: id factory is honored so synthesized lots get unique app ids", () => {
  let n = 0;
  const ids = representativeAssets({
    taxable: 100_000,
    traditional: 100_000,
    stockPercent: 50,
    makeId: () => `asset-new-${(n += 1)}`
  }).map((a) => a.id);
  assert.deepEqual(ids, ["asset-new-1", "asset-new-2", "asset-new-3", "asset-new-4"]);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});

test("essentialsToControls: married surfaces spouse age; single mirrors the primary age", () => {
  const married = essentialsToControls({
    currentAge: 62,
    spouseAge: 60,
    filingStatus: "marriedFilingJointly",
    state: "Massachusetts",
    householdSize: 2,
    planYears: 33,
    targetSpend: 90_000
  });
  assert.equal(married.spouseAge, 60);
  assert.equal(married.filingStatus, "marriedFilingJointly");
  assert.equal(married.stateSelect, "Massachusetts");
  assert.equal(married.targetSpend, 90_000);
  assert.equal(married.includeTaxes, false);
  assert.equal(married.includeMedical, false);

  const single = essentialsToControls({
    currentAge: 70,
    spouseAge: 60, // ignored for a single filer
    filingStatus: "single",
    state: "Florida",
    householdSize: 1,
    planYears: 25,
    targetSpend: 55_000,
    includeTaxes: true
  });
  // Spouse age mirrors the primary (harmless; spouse mechanics are gated off by
  // filing status), never the stray 60 passed in.
  assert.equal(single.spouseAge, 70);
  assert.equal(single.includeTaxes, true);
});

test("synthesized portfolios run cleanly through the engine (no per-holding detail required)", () => {
  const assets = representativeAssets({
    taxable: 500_000,
    traditional: 300_000,
    roth: 200_000,
    stockPercent: 60
  });
  const taxProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "single", state: "Florida" });
  const planYears = 5;
  const plan = simulatePlan({
    assets,
    scenario: {
      planYears,
      targetSpend: 40_000,
      currentAge: 65,
      spouseAge: 65,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile,
    returnSequence: Array.from({ length: planYears }, () => ({ stock: 0.05, bond: 0.03 })),
    inflationSequence: Array.from({ length: planYears }, () => 0.02)
  });

  assert.ok(plan && Array.isArray(plan.years), "plan has a years array");
  assert.equal(plan.years.length, planYears);
  const ending = plan.years.at(-1);
  assert.ok(Number.isFinite(ending.endingPortfolioValue ?? ending.portfolioValue ?? ending.endingValue),
    "final year reports a finite portfolio value");
});

test("wizard results handoff waits until the streaming run has renderable output", async () => {
  const source = await redesignSource();
  const finishWizard = sourceSlice(source, "function finishWizard({ run })", "function filingStatusLabel");
  const renderLatestListener = sourceSlice(
    source,
    'window.addEventListener("psl:render-latest"',
    'window.addEventListener("psl:path-selected"'
  );
  const advanceHelper = sourceSlice(
    source,
    "function advancePendingRunIfRenderable()",
    "function hookRunCompletion()"
  );

  assert.doesNotMatch(finishWizard, /setScreen\("results"\)/, "wizard should not navigate before the run publishes output");
  assert.match(finishWizard, /flagPendingRun\(\);\s*if \(!runModelFromRedesign\(\{ cancelActive: true, stream: true \}\)\)/);
  assert.match(renderLatestListener, /advancePendingRunIfRenderable\(\)/);
  assert.match(advanceHelper, /!window\.__pslLatest/, "pending navigation must wait for app.mjs to publish latest results");
  assert.match(advanceHelper, /state\.screen === "workspace" \|\| state\.screen === "persona"/);
  assert.match(advanceHelper, /setScreen\("results"\)/);
});

test("wizard results handoff clears pending navigation if the run cannot start or errors", async () => {
  const source = await redesignSource();
  const finishWizard = sourceSlice(source, "function finishWizard({ run })", "function filingStatusLabel");
  const hookRunCompletion = sourceSlice(source, "function hookRunCompletion()", "function rerenderResults()");

  assert.match(finishWizard, /clearPendingRun\(\);\s*showWizardError\(4, "The model is still loading\. Try again in a moment\."\)/);
  assert.match(hookRunCompletion, /window\.addEventListener\("psl:run-progress"/);
  assert.match(hookRunCompletion, /ev\.detail\?\.error\)\s*clearPendingRun\(\)/);
  assert.match(hookRunCompletion, /state\.screen === "workspace" \|\| state\.screen === "persona"/);
});

test("base Monte Carlo results refresh the results chrome before rescue solving completes", async () => {
  const app = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8");
  const redesign = await redesignSource();
  const scenarioBatchHandler = sourceSlice(
    app,
    "onScenarios: ({ scenarios, done, total }) => {",
    "onDecisionProgress: (progress) => {"
  );
  const hookRunCompletion = sourceSlice(redesign, "function hookRunCompletion()", "function rerenderResults()");
  const rerenderResults = sourceSlice(redesign, "function rerenderResults()", "// ─── Helpers");

  assert.match(scenarioBatchHandler, /latest\.monteCarlo\.summary = effectiveMonteCarloSummary\(\)/);
  assert.match(scenarioBatchHandler, /latest\.monteCarlo\.progress = \{ done, total, complete: true \}/);
  assert.match(scenarioBatchHandler, /psl:base-results-ready/);
  assert.match(hookRunCompletion, /window\.addEventListener\("psl:base-results-ready"/);
  assert.match(hookRunCompletion, /rerenderResults\(\)/);
  assert.match(hookRunCompletion, /advancePendingRunIfRenderable\(\)/);
  assert.match(rerenderResults, /progress && !progress\.complete/);
  assert.match(rerenderResults, /phase: "monteCarlo"/);
  assert.match(rerenderResults, /decision\?\.status === "running"/);
  assert.match(rerenderResults, /phase: "decision"/);
});

test("streamed Monte Carlo progress refreshes the KPI strip directly", async () => {
  const redesign = await redesignSource();
  const hookRunCompletion = sourceSlice(redesign, "function hookRunCompletion()", "function refreshStreamingKpisForRunProgress");
  const streamingKpiRefresh = sourceSlice(redesign, "function refreshStreamingKpisForRunProgress", "function rerenderResults()");

  assert.match(hookRunCompletion, /refreshStreamingKpisForRunProgress\(detail\)/);
  assert.match(streamingKpiRefresh, /phase !== "monteCarlo" && phase !== "decision"/);
  assert.match(streamingKpiRefresh, /monteCarloScenarios\(latest\)\.length > 0/);
  assert.match(streamingKpiRefresh, /Array\.isArray\(latest\?\.backtests\) && latest\.backtests\.length > 0/);
  assert.match(streamingKpiRefresh, /renderKpiStrip\(\)/);
});

test("streamed result data is published before coalesced paints", async () => {
  const app = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8");
  const renderLatest = sourceSlice(app, "function renderLatest(options = {})", "function paintLatest(");
  const publishIndex = renderLatest.indexOf("window.__pslLatest = latest");
  const rafIndex = renderLatest.indexOf("requestAnimationFrame");

  assert.ok(publishIndex > 0, "renderLatest should publish latest for redesign listeners");
  assert.ok(rafIndex > 0, "renderLatest should still coalesce streaming paints");
  assert.ok(publishIndex < rafIndex, "latest must publish before progress events can outrun the animation-frame paint");
});

test("deployed shell cache-busts the wizard streaming fix modules", async () => {
  const html = await htmlSource();

  assert.match(html, new RegExp(`src/redesign\\.css\\?v=${ONBOARDING_RESULTS_STREAM_ASSET_KEY}`));
  assert.match(html, new RegExp(`src/app\\.mjs\\?v=${ONBOARDING_RESULTS_STREAM_ASSET_KEY}`));
  assert.match(html, new RegExp(`src/redesign\\.mjs\\?v=${ONBOARDING_RESULTS_STREAM_ASSET_KEY}`));
  assert.doesNotMatch(html, /onboarding-wizard-e/, "deployed HTML must not keep the pre-fix asset key");
  assert.doesNotMatch(html, /onboarding-results-stream-a/, "deployed HTML must not keep the previous results-stream asset key");
  assert.doesNotMatch(html, /long-horizon-results-a/, "deployed HTML must not keep the intermediate long-horizon asset key");
  assert.doesNotMatch(html, /long-horizon-progress-a/, "deployed HTML must not keep the intermediate progress asset key");
  assert.doesNotMatch(html, /long-horizon-progress-b/, "deployed HTML must not keep the previous KPI-stream asset key");
  assert.doesNotMatch(html, /streaming-kpi-refresh-a/, "deployed HTML must not keep the first KPI-race asset key");
});
