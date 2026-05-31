import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.document = {
  readyState: "loading",
  addEventListener() {},
  getElementById() {
    return null;
  }
};

const { rescueChangeList, rescueOptimizationText } = await import("../src/redesign.mjs?rescue-comparison-text-test");

test("rescue comparison text names changed workspace knobs", () => {
  const baseScenario = {
    targetSpend: 100000,
    spendingStrategy: {
      mode: "fixed",
      correctionDiscretionaryPercent: 0.5,
      bearDiscretionaryPercent: 0
    },
    withdrawalStrategy: { mode: "heuristic" },
    withdrawalOrder: ["taxable", "traditional", "hsa", "roth"],
    rothConversion: {
      enabled: true,
      optimizeForAca: false,
      applyMagiGuardrails: false,
      maxAcaFplPercent: 400,
      magiBuffer: 0
    },
    rothBasisOptimization: {
      enabled: false,
      opportunityCostMode: "fixed",
      magiBuffer: 0
    },
    taxGainHarvesting: { enabled: true, magiBuffer: 0 },
    medicare: { irmaaEnabled: true }
  };
  const option = {
    kind: "rothBasisCliffRescue",
    label: "Use Roth basis",
    metadata: {},
    scenario: {
      ...baseScenario,
      withdrawalStrategy: { mode: "lifetime" },
      rothConversion: {
        ...baseScenario.rothConversion,
        optimizeForAca: true,
        maxAcaFplPercent: 250,
        magiBuffer: 1000
      },
      rothBasisOptimization: {
        enabled: true,
        opportunityCostMode: "dynamic",
        magiBuffer: 1000
      },
      taxGainHarvesting: { enabled: false, magiBuffer: 1000 }
    }
  };

  const changes = rescueChangeList(option, baseScenario);
  assert.ok(changes.some((change) => change.includes("Withdrawal strategy")));
  assert.ok(changes.some((change) => change.includes("ACA-aware Roth conversions")));
  assert.ok(changes.some((change) => change.includes("Roth basis optimization")));
  assert.ok(changes.some((change) => change.includes("Roth basis hurdle")));
  assert.ok(changes.some((change) => change.includes("Gain harvest MAGI buffer")));

  const text = rescueOptimizationText(option, baseScenario);
  assert.match(text, /Changes:/);
  assert.match(text, /ACA-aware Roth conversions/);
});

test("rescue comparison text names added income bridge cash flow", () => {
  const baseScenario = { oneOffExpenses: [] };
  const option = {
    kind: "incomeBridge",
    label: "Earn bridge income",
    metadata: { durationYears: 2 },
    scenario: {
      oneOffExpenses: [{
        name: "Decision engine income bridge",
        cashFlowType: "medicareWages",
        startYear: 1,
        endYear: 2,
        amount: 50000,
        inflationAdjusted: false
      }]
    }
  };

  const changes = rescueChangeList(option, baseScenario);
  assert.deepEqual(changes, ["One-off cash flows: add Decision engine income bridge $50k years 1-2"]);
});

test("rescue scenario workspace knobs are visible and persisted", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
  ]);
  const rescueControlIds = [
    "withdrawalOrder",
    "guardrailCorrectionDiscretionaryPercent",
    "guardrailBearDiscretionaryPercent",
    "maxIrmaaTier",
    "taxGainMagiBuffer",
    "rothConversionOptimizeForAca",
    "rothConversionMagiGuardrails",
    "rothConversionMaxAcaFplPercent",
    "rothConversionMagiBuffer",
    "rothBasisOptimization",
    "rothBasisMagiBuffer",
    "rothBasisOpportunityCostMode"
  ];

  for (const id of rescueControlIds) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should be visible in the workspace`);
    assert.match(appSource, new RegExp(`"${id}"`), `${id} should be part of app control wiring`);
  }
});

test("rescue comparison table includes per-option confidence labels", async () => {
  const source = await readFile(new URL("../src/redesign.mjs", import.meta.url), "utf8");

  assert.match(source, /rescueConfidenceFor/, "rescue rows should use core rescue confidence mapping");
  assert.match(source, /"Confidence"/, "rescue comparison table should expose a Confidence column");
});

test("decision panel includes ranked sensitivity output", async () => {
  const source = await readFile(new URL("../src/redesign.mjs", import.meta.url), "utf8");

  assert.match(source, /sensitivityCardHtml/, "decision panel should render sensitivity results");
  assert.match(source, /What moves this/, "sensitivity card should use plain-language heading");
});

test("workspace ZIP feeds the offline ACA benchmark path", async () => {
  const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8");

  assert.match(appSource, /const marketplaceZip = String\(els\.marketplaceZip\?\.value \|\| ""\)\.trim\(\)/);
  assert.match(appSource, /zip: marketplaceZip \|\| null/);
});

test("confidence report receives the simulated plan for year-specific ACA flags", async () => {
  const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8");

  assert.match(appSource, /plan: latest\?\.plan \?\? buffered\.plan/);
  assert.match(appSource, /latest\.confidence = buildConfidenceReport\(confidenceContext\(\)\)/);
  assert.match(appSource, /plan: buffered\.plan/);
});

test("decision failure anatomy surfaces top stressors in the results UI", async () => {
  const source = await readFile(new URL("../src/redesign.mjs", import.meta.url), "utf8");

  assert.match(source, /failureStressText/);
  assert.match(source, /Top stressors:/);
  assert.match(source, /topStressors/);
});
