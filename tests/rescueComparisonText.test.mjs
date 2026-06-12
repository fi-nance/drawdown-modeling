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
  const [html, appSource, redesignSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/redesign.mjs", import.meta.url), "utf8")
  ]);
  const rescueControlIds = [
    "withdrawalOrder",
    "guardrailCorrectionDiscretionaryPercent",
    "guardrailBearDiscretionaryPercent",
    "sequenceReserveMode",
    "sequenceReserveTargetYears",
    "tipsLadderEnabled",
    "tipsLadderYears",
    "tipsLadderAnnualAmount",
    "tipsLadderRealYieldPercent",
    "tipsLadderMaintenanceMode",
    "tipsLadderReplenishCatchUp",
    "tipsLadderTriggerStockReturnPercent",
    "maxIrmaaTier",
    "taxGainMagiBuffer",
    "rothConversionOptimizeForAca",
    "rothConversionMagiGuardrails",
    "rothConversionMaxAcaFplPercent",
    "rothConversionMagiBuffer",
    "rothBasisOptimization",
    "rothBasisMagiBuffer",
    "rothBasisOpportunityCostMode",
    "medicareAnnualOopBase",
    "spouseMedicareWages",
    "spouseSocialSecurityWages",
    "spouseSelfEmploymentIncome",
    "estimateSocialSecurityFromEarnings",
    "hsaQualifiedExpenseLimit"
  ];

  for (const id of rescueControlIds) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should be visible in the workspace`);
    assert.match(appSource, new RegExp(`"${id}"`), `${id} should be part of app control wiring`);
  }

  assert.match(html, /id="tipsLadderRealYieldPercent"[^>]*max="8"/);
  assert.match(html, /Stress trigger % \(0 = any down year, -10 = down 10% or worse\)/);
  assert.doesNotMatch(html, /Down-year trigger \(stock return %, at or below = stress\)/);
  assert.match(redesignSource, /bindRescueAppliedModuleVisibility/);
  assert.match(redesignSource, /psl:rescue-scenario-applied/);
  assert.match(redesignSource, /modulesForRescueChanges/);
  assert.match(redesignSource, /TIPS ladder\|Ladder /);
  assert.match(redesignSource, /expandWorkspaceModules/);
  // rescueTitle values are embedded mid-sentence in the decision verdict, so
  // they must be lowercase phrases (display sites apply capitalizeFirst), and
  // a resize of an already-enabled ladder must not read as a fresh carve-out.
  assert.match(redesignSource, /`carve out a \$\{meta\.ladderYears \?\? 0\}-year TIPS ladder`/);
  assert.match(redesignSource, /`resize the TIPS ladder to \$\{meta\.ladderYears \?\? 0\} years`/);
  assert.match(redesignSource, /meta\.previousLadderYears != null/);

  assert.match(appSource, /setOptionalNumberControl\("medicareAnnualOopBase", scenario\.medicare\?\.annualOopBase\)/);
  assert.match(appSource, /setValueControl\("sequenceReserveMode", reserve\.enabled === false \? "none" : reserve\.mode\)/);
  assert.match(appSource, /setCheckedControl\("tipsLadderEnabled", scenario\.tipsLadder\?\.enabled\)/);
  assert.match(appSource, /setOptionalNumberControl\("tipsLadderYears", scenario\.tipsLadder\?\.years\)/);
  assert.match(appSource, /setOptionalNumberControl\("tipsLadderAnnualAmount", scenario\.tipsLadder\?\.annualRealAmount\)/);
  assert.match(appSource, /setOptionalNumberControl\("tipsLadderRealYieldPercent", scenario\.tipsLadder\?\.realYieldPercent\)/);
  assert.match(appSource, /setNumberControl\("spouseMedicareWages", scenario\.spouseMedicareWages\)/);
  assert.match(appSource, /setOptionalNumberControl\("spouseSocialSecurityWages", scenario\.spouseSocialSecurityWages\)/);
  assert.match(appSource, /setNumberControl\("spouseSelfEmploymentIncome", scenario\.spouseSelfEmploymentIncome\)/);
  assert.match(appSource, /setCheckedControl\("estimateSocialSecurityFromEarnings", scenario\.estimateSocialSecurityFromEarnings\)/);
  assert.match(appSource, /setCheckedControl\("hsaQualifiedExpenseLimit", taxEfficiency\.hsaUseForQualifiedExpenses\)/);
});

test("module library counts match expanded module cards", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/redesign.mjs", import.meta.url), "utf8")
  ]);

  assert.match(html, /data-module="medicare"[\s\S]*<span class="controls-pill">12 controls<\/span>/);
  assert.match(source, /id: "medicare"[\s\S]*controls: 12/);
  assert.match(html, /data-module="other-income"[\s\S]*<span class="controls-pill">22\+ controls<\/span>/);
  assert.match(source, /id: "other-income"[\s\S]*controls: 22/);
  assert.match(html, /data-module="strategy"[\s\S]*<span class="controls-pill">41 controls<\/span>/);
  assert.match(source, /id: "strategy"[\s\S]*controls: 41/);
  assert.match(html, /data-module="reserve"[\s\S]*<span class="controls-pill">11 controls<\/span>/);
  assert.match(source, /id: "reserve"[\s\S]*controls: 11/);
});

test("module library can scroll to reveal disabled-module knobs", async () => {
  const [html, css] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/redesign.css", import.meta.url), "utf8")
  ]);

  assert.match(css, /\.module-library\s*\{[\s\S]*max-height: calc\(100vh - 2rem\)/);
  assert.match(css, /\.module-library\s*\{[\s\S]*overflow-y: auto/);
  assert.match(html, /src\/redesign\.css\?v=20260612-coverage-report/);
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

test("after-tax bequest control is visible, persisted, and audited", async () => {
  const [html, appSource, redesignSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/redesign.mjs", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="heirOrdinaryTaxRate"/);
  assert.match(html, /Heir ordinary tax rate %/);
  assert.match(appSource, /"heirOrdinaryTaxRate"/);
  assert.match(appSource, /heirOrdinaryTaxRate: document\.querySelector\("#heirOrdinaryTaxRate"\)/);
  assert.match(appSource, /heirOrdinaryTaxRate: percentInputValue\("heirOrdinaryTaxRate", DEFAULT_SCENARIO\.heirOrdinaryTaxRate\)/);
  assert.match(appSource, /legacyAuditLine/);
  assert.match(appSource, /Median after-tax bequest/);
  assert.match(appSource, /After-tax heirs/);
  assert.match(appSource, /beneficiaryOptions/);
  assert.match(appSource, /selectHtml\(index, "beneficiaryType", beneficiaryOptions/);
  assert.match(appSource, /Household default/);
  assert.match(appSource, /Non-spouse 10-year/);
  assert.match(appSource, /lineal state inheritance tax/);
  assert.match(appSource, /Non-lineal relationship classes/);
  assert.doesNotMatch(appSource, /estate\/inheritance tax are not modeled/);
  assert.match(redesignSource, /After-tax bequest/);
  assert.match(redesignSource, /pickHeirValue/);
});

test("heir inheritance-tax state does not overwrite household state", async () => {
  const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8");
  const readScenarioSource = appSource.slice(
    appSource.indexOf("function readScenario()"),
    appSource.indexOf("function readWithdrawalOrder()")
  );

  assert.match(readScenarioSource, /\n\s+state,\n/);
  assert.match(readScenarioSource, /heirState: els\.heirState\.value \|\| null/);
  assert.doesNotMatch(readScenarioSource, /state: els\.heirState\.value \|\| state/);
});

test("workspace planning runs validate realistic spend before launching workers", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="targetSpend" type="number" min="1000"/);
  assert.match(appSource, /validateUserPlanningScenario/);
  assert.match(appSource, /if \(!planningValidation\.ok\)/);
  assert.match(appSource, /run-progress", \{ detail: \{ error: true, validation: true \} \}/);
  assert.match(appSource, /focusPlanningValidationError/);
  assert.match(appSource, /runSimulationsInWorker/);
});

test("itemized deduction controls are visible, persisted, and disclosed in results", async () => {
  const [html, appSource, redesignSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/redesign.mjs", import.meta.url), "utf8")
  ]);
  const controlIds = [
    "itemizedDeductionMode",
    "itemizedStateLocalTaxes",
    "itemizedMortgageInterest",
    "itemizedCharitableContributions",
    "itemizedMedicalExpenses",
    "amtPreferenceItems",
    "qbiSourceMode",
    "qbiAmount",
    "qbiSpecifiedServiceBusiness",
    "qbiW2Wages",
    "qbiUbiaQualifiedProperty"
  ];

  for (const id of controlIds) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should be visible in the tax controls`);
    assert.match(appSource, new RegExp(`"${id}"`), `${id} should be part of saved control state`);
    assert.match(appSource, new RegExp(`${id}: document\\.querySelector\\("#${id}"\\)`), `${id} should be queried`);
  }

  assert.match(appSource, /itemizedDeductionMode: els\.itemizedDeductionMode\?\.value \|\| "auto"/);
  assert.match(appSource, /itemizedStateLocalTaxes: Number\(els\.itemizedStateLocalTaxes\?\.value\) \|\| 0/);
  assert.match(appSource, /amtPreferenceItems: Number\(els\.amtPreferenceItems\?\.value\) \|\| 0/);
  assert.match(appSource, /qbiSourceMode: els\.qbiSourceMode\?\.value \|\| "none"/);
  assert.match(appSource, /qbiAmount: Number\(els\.qbiAmount\?\.value\) \|\| 0/);
  assert.match(appSource, /qbiSpecifiedServiceBusiness: els\.qbiSpecifiedServiceBusiness\?\.checked === true/);
  assert.match(appSource, /qbiW2Wages: Number\(els\.qbiW2Wages\?\.value\) \|\| 0/);
  assert.match(appSource, /qbiUbiaQualifiedProperty: Number\(els\.qbiUbiaQualifiedProperty\?\.value\) \|\| 0/);
  assert.match(appSource, /AMT preference\/addback estimate/);
  assert.match(appSource, /AMT is a CPA-review tripwire/);
  assert.match(appSource, /QBI\/Form 8995/);
  assert.match(appSource, /"Deduction", "Itemized ded"/);
  assert.match(appSource, /"Senior bonus", "QBI ded"/);
  assert.match(appSource, /"Credits", "Refundable credits", "State tax"/);
  assert.match(appSource, /"CL offset", "ST loss carry", "LT loss carry", "Loss carry", "State loss review"/);
  assert.match(appSource, /federalDeductionKind/);
  assert.match(appSource, /Capital-loss ordinary offset/);
  assert.match(appSource, /Capital-loss carryforward/);
  assert.match(appSource, /verify resident-state loss carryforward rules/);
  assert.match(redesignSource, /Itemized deductions/);
  assert.match(redesignSource, /Refundable additional child tax credit/);
  assert.match(redesignSource, /Capital-loss carryforward after this year/);
  assert.match(redesignSource, /short-term ·/);
  assert.match(redesignSource, /federalDeductionKind/);
  assert.match(redesignSource, /id: "tax-overrides"[\s\S]*controls: 23/);
});

test("workspace scenario construction preserves every advertised spending mode", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
  ]);

  for (const mode of ["fixed", "discretionaryGuardrails", "riskBasedGuardrails", "guytonKlinger", "kitces", "vpw"]) {
    assert.match(html, new RegExp(`<option value="${mode}"`), `${mode} should remain selectable`);
  }
  assert.match(appSource, /normalizeUserPlanningSpendingMode\(els\.spendingStrategyMode\?\.value\)/);
  assert.match(appSource, /riskBasedGuardrails/);
  assert.doesNotMatch(appSource, /els\.spendingStrategyMode\?\.value === "discretionaryGuardrails"[\s\S]{0,120}\? "discretionaryGuardrails"[\s\S]{0,120}: "fixed"/);
});
