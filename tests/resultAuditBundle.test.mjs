import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RESULT_AUDIT_BUNDLE_PRIVACY_NOTICE,
  RESULT_AUDIT_BUNDLE_SCHEMA_VERSION,
  RESULT_AUDIT_SUMMARY_SCHEMA_VERSION,
  RESULT_AUDIT_BUNDLE_TYPE,
  createResultAuditBundle,
  createResultAuditSummary
} from "../src/core/resultAuditBundle.mjs";

const setupState = {
  controls: { seed: "42", runs: "1000" },
  assets: [{
    id: "asset-1",
    name: "Taxable stock",
    accountType: "taxable",
    assetClass: "stock",
    units: 10,
    price: 100,
    costBasisPerUnit: 60
  }],
  oneOffExpenses: []
};

const latest = {
  scenario: {
    taxYear: 2026,
    startYear: 2026,
    planYears: 35,
    state: "Florida",
    filingStatus: "marriedFilingJointly",
    privacyMode: true,
    currentAge: 55,
    spouseAge: 54,
    targetSpend: 90000,
    targetSpendIncludesTaxes: true,
    targetSpendIncludesMedical: false,
    withdrawalStrategy: { mode: "lifetime" },
    spendingStrategy: { mode: "fixed" },
    aca: {
      enabled: true,
      planCostMode: "stateBenchmark",
      premiumInputMode: "gross",
      zip: "33101",
      householdSize: 2,
      marketplaceMembers: 2
    },
    heirType: "nonSpouse10Yr",
    heirState: "PA",
    heirBaseIncome: 120000,
    heirAge: 45,
    heirOrdinaryTaxRate: 0.3
  },
  plan: {
    success: true,
    endingValue: 1000,
    years: [{ year: 2026, yearIndex: 0, endingPortfolioValue: 1000 }]
  },
  confidence: {
    headline: "Known exclusions",
    flags: [{ id: "legacy-tax-out-of-model", title: "Legacy tax detail needs estate review" }]
  },
  decision: {
    status: "complete",
    profile: { targetSuccessRate: 0.9 },
    sensitivity: {
      top: [{ id: "spending-5pct-higher", label: "Spending 5% higher", impact: 0.08 }]
    }
  },
  monteCarlo: {
    summary: { runs: 1000, successRate: 0.92 },
    scenarios: [{
      id: "mc-1",
      success: true,
      endingValue: 1000,
      heirValue: 900,
      years: [{ year: 2026, yearIndex: 0, inflationIndex: 1 }]
    }]
  },
  backtests: [{
    id: "1928",
    success: true,
    endingValue: 900,
    heirValue: 800,
    sourceStartYear: 1928,
    sourceEndYear: 1962,
    years: [{ year: 2026, yearIndex: 0, inflationIndex: 1 }]
  }]
};

test("result audit bundle wraps setup, compact result, audit rows, and source versions", () => {
  const bundle = createResultAuditBundle({
    latest,
    setupState,
    auditRows: [
      ["Tax assumptions", "2026 federal and Florida state"],
      { label: "Simulation inputs", value: "1000 Monte Carlo runs" }
    ],
    sourceVersions: {
      taxDataVersion: "2026.1",
      historicalReturnDataVersion: "2026.1",
      seed: 42
    },
    exportedAt: "2026-05-30T00:00:00.000Z"
  });

  assert.equal(bundle.type, RESULT_AUDIT_BUNDLE_TYPE);
  assert.equal(bundle.schemaVersion, RESULT_AUDIT_BUNDLE_SCHEMA_VERSION);
  assert.equal(bundle.privacyNotice, RESULT_AUDIT_BUNDLE_PRIVACY_NOTICE);
  assert.equal(bundle.exportedAt, "2026-05-30T00:00:00.000Z");
  // Setup normalization fills in empty dynamic arrays.
  assert.deepEqual(bundle.setup, { ...setupState, conditionalAssetSales: [], incomeStreams: [] });
  assert.deepEqual(bundle.audit, [
    { label: "Tax assumptions", value: "2026 federal and Florida state" },
    { label: "Simulation inputs", value: "1000 Monte Carlo runs" }
  ]);
  assert.equal(bundle.sourceVersions.taxDataVersion, "2026.1");
  assert.equal(bundle.reviewSummary.scenario.targetSpend, 90000);
  assert.equal(bundle.reviewSummary.scenario.privacyMode, true);
  assert.equal(bundle.reviewSummary.scenario.healthcare.zip, "33101");
  assert.equal(bundle.reviewSummary.scenario.legacy.heirState, "PA");
  assert.equal(bundle.reviewSummary.scenario.legacy.heirOrdinaryTaxRate, 0.3);
  assert.equal(bundle.reviewSummary.verdict.planSuccess, true);
  assert.equal(bundle.reviewSummary.verdict.monteCarloSuccessRate, 0.92);
  assert.equal(bundle.reviewSummary.verdict.decisionTargetSuccessRate, 0.9);
  assert.equal(bundle.reviewSummary.reproducibility.seed, 42);
  assert.equal(bundle.reviewSummary.sourceVersions.taxDataVersion, "2026.1");
  assert.equal(bundle.reviewSummary.confidence.flags[0].id, "legacy-tax-out-of-model");
  assert.equal(bundle.reviewSummary.sensitivity[0].impact, 0.08);
  assert.deepEqual(bundle.reviewSummary.audit[0], { label: "Tax assumptions", value: "2026 federal and Florida state" });
  assert.equal(bundle.reviewSummary.result, undefined);
  assert.equal(bundle.reviewSummary.setup, undefined);
  assert.equal(bundle.reviewSummary.monteCarlo, undefined);
  assert.equal(bundle.result._compact, true);
  assert.equal(bundle.result.monteCarlo.scenarios[0].years, undefined);
  assert.deepEqual(bundle.result.monteCarlo.scenarios[0].lastYear, { year: 2026, yearIndex: 0, inflationIndex: 1 });
  assert.equal(bundle.result.confidence.headline, "Known exclusions");
});

test("result audit summary is a compact CPA and engineering review surface", () => {
  const summary = createResultAuditSummary({
    latest,
    auditRows: [["Tax assumptions", "2026 federal and Florida state"]],
    sourceVersions: { taxDataVersion: "2026.1", seed: 42 },
    exportedAt: "2026-05-30T00:00:00.000Z"
  });

  assert.equal(summary.schemaVersion, RESULT_AUDIT_SUMMARY_SCHEMA_VERSION);
  assert.equal(summary.exportedAt, "2026-05-30T00:00:00.000Z");
  assert.equal(summary.scenario.state, "Florida");
  assert.equal(summary.scenario.legacy.heirState, "PA");
  assert.equal(summary.scenario.privacyMode, true);
  assert.equal(summary.scenario.healthcare.householdSize, 2);
  assert.equal(summary.verdict.historicalBacktestCount, 1);
  assert.equal(summary.reproducibility.seed, 42);
  assert.equal(summary.tax.taxYear, 2026);
  assert.equal(summary.tax.state.state, "Florida");
  assert.equal(summary.tax.capitalLosses.hasActivity, false);
  assert.equal(summary.sourceVersions.taxDataVersion, "2026.1");
  assert.deepEqual(summary.audit, [{ label: "Tax assumptions", value: "2026 federal and Florida state" }]);
  assert.equal(summary.setup, undefined);
  assert.equal(summary.result, undefined);
});

test("result audit summary includes capital-loss carryforward and state-review years", () => {
  const summary = createResultAuditSummary({
    latest: {
      ...latest,
      taxProfile: {
        year: 2026,
        filingStatus: "marriedFilingJointly",
        standardDeduction: 32200,
        capitalLossOrdinaryIncomeOffset: 3000,
        state: {
          state: "California",
          source: "Tax Foundation 2026 state income tax compilation",
          capitalGainsTreatment: "ordinary",
          capitalLossConformity: "federal-agi-approximation"
        }
      },
      plan: {
        success: true,
        years: [{
          year: 2026,
          yearIndex: 0,
          taxes: {
            ordinaryLossOffset: 3000,
            lossCarryforward: 3500,
            lossCarryforwardShort: 0,
            lossCarryforwardLong: 3500,
            federalAgi: 3500,
            taxableOrdinaryIncome: 0,
            stateTax: 135,
            stateTaxBreakdown: {
              ordinaryTaxableBase: 2700,
              capitalLossTreatment: {
                assumption: "federal-agi-approximation",
                reviewRequired: true
              }
            }
          }
        }, {
          year: 2027,
          yearIndex: 1,
          lossCarryforwardDetail: { shortTerm: 500, longTerm: 1000 },
          taxes: {
            ordinaryLossOffset: 1500,
            lossCarryforward: 1500,
            federalAgi: 42000,
            taxableOrdinaryIncome: 6000,
            stateTax: 900
          }
        }]
      }
    },
    sourceVersions: { taxDataVersion: "2026.11", seed: 42 },
    exportedAt: "2026-05-30T00:00:00.000Z"
  });

  assert.equal(summary.tax.federal.standardDeduction, 32200);
  assert.equal(summary.tax.federal.capitalLossOrdinaryIncomeOffset, 3000);
  assert.equal(summary.tax.state.state, "California");
  assert.equal(summary.tax.state.capitalLossConformity, "federal-agi-approximation");
  assert.equal(summary.tax.capitalLosses.hasActivity, true);
  assert.equal(summary.tax.capitalLosses.yearCount, 2);
  assert.equal(summary.tax.capitalLosses.stateReviewRequired, true);
  assert.equal(summary.tax.capitalLosses.stateReviewYearCount, 1);
  assert.equal(summary.tax.capitalLosses.finalCarryforward, 1500);
  assert.equal(summary.tax.capitalLosses.finalCarryforwardShortTerm, 500);
  assert.equal(summary.tax.capitalLosses.finalCarryforwardLongTerm, 1000);
  assert.deepEqual(summary.tax.capitalLosses.years[0], {
    year: 2026,
    yearIndex: 0,
    ordinaryLossOffset: 3000,
    lossCarryforward: 3500,
    lossCarryforwardShortTerm: 0,
    lossCarryforwardLongTerm: 3500,
    federalAgi: 3500,
    taxableOrdinaryIncome: 0,
    stateTax: 135,
    stateReviewRequired: true,
    stateCapitalLossAssumption: "federal-agi-approximation",
    stateOrdinaryTaxableBase: 2700
  });
});

test("result audit summary includes compact risk-based guardrail assumptions", () => {
  const summary = createResultAuditSummary({
    latest: {
      ...latest,
      scenario: {
        ...latest.scenario,
        spendingStrategy: {
          mode: "riskBasedGuardrails",
          riskBasedGuardrails: {
            targetSuccessRate: 0.9,
            lowerSuccessRate: 0.75,
            upperSuccessRate: 1,
            minimumAdjustmentPercent: 0.05,
            incomeFloor: 40000,
            incomeCeiling: 120000,
            table: {
              sequenceCount: 64,
              fixedFailsafeSpend: 50000,
              initialSpend: 65000,
              lowerGuardrailPortfolioValue: 900000,
              lowerAdjustedSpend: 58000,
              upperGuardrailPortfolioValue: 1200000,
              upperAdjustedSpend: 72000
            }
          }
        }
      }
    },
    auditRows: [],
    sourceVersions: { seed: 42 },
    exportedAt: "2026-05-30T00:00:00.000Z"
  });

  assert.equal(summary.scenario.spendingStrategy, "riskBasedGuardrails");
  assert.equal(summary.scenario.riskBasedGuardrails.targetSuccessRate, 0.9);
  assert.equal(summary.scenario.riskBasedGuardrails.incomeFloor, 40000);
  assert.equal(summary.scenario.riskBasedGuardrails.table.sequenceCount, 64);
  assert.equal(summary.scenario.riskBasedGuardrails.table.initialSpend, 65000);
  assert.equal(summary.scenario.riskBasedGuardrails.table.upperAdjustedSpend, 72000);
});

test("result audit summary includes compact Monte Carlo sampling assumptions", () => {
  const summary = createResultAuditSummary({
    latest: {
      ...latest,
      scenario: {
        ...latest.scenario,
        monteCarlo: {
          assumptionPreset: "custom",
          samplingMode: "meanRevertingCorrelated",
          meanReversion: {
            shortTermStrength: 0.25,
            longTermStrength: 0.45,
            longTermYears: 12
          }
        }
      }
    },
    auditRows: [],
    sourceVersions: { seed: 42 },
    exportedAt: "2026-05-30T00:00:00.000Z"
  });

  assert.equal(summary.scenario.monteCarlo.assumptionPreset, "custom");
  assert.equal(summary.scenario.monteCarlo.samplingMode, "meanRevertingCorrelated");
  assert.deepEqual(summary.scenario.monteCarlo.meanReversion, {
    shortTermStrength: 0.25,
    longTermStrength: 0.45,
    longTermYears: 12
  });
});

test("legacy fields are null when absent from scenario", () => {
  const minScenario = {
    planYears: 10,
    state: "Florida",
    aca: { enabled: false }
  };
  const minLatest = {
    ...latest,
    scenario: minScenario
  };
  const summary = createResultAuditSummary({ latest: minLatest });
  assert.equal(summary.scenario.legacy.heirState, null);
  assert.equal(summary.scenario.legacy.heirOrdinaryTaxRate, null);
  assert.equal(summary.scenario.legacy.heirType, null);
  assert.equal(summary.scenario.legacy.heirBaseIncome, null);
  assert.equal(summary.scenario.legacy.heirAge, null);
});

test("heirOrdinaryTaxRate: NaN and Infinity are normalized to null in the audit summary", () => {
  const summary = createResultAuditSummary({
    latest: { ...latest, scenario: { ...latest.scenario, heirOrdinaryTaxRate: NaN } }
  });
  assert.equal(summary.scenario.legacy.heirOrdinaryTaxRate, null);

  const infSummary = createResultAuditSummary({
    latest: { ...latest, scenario: { ...latest.scenario, heirOrdinaryTaxRate: Infinity } }
  });
  assert.equal(infSummary.scenario.legacy.heirOrdinaryTaxRate, null);
});

test("heirState null is passed through as null in the audit summary", () => {
  const summary = createResultAuditSummary({
    latest: { ...latest, scenario: { ...latest.scenario, heirState: null } }
  });
  assert.equal(summary.scenario.legacy.heirState, null);
});

test("result audit bundle rejects incomplete results", () => {
  assert.throws(
    () => createResultAuditBundle({ latest: { plan: {} }, setupState }),
    /completed plan and Monte Carlo/
  );
});

test("result audit bundle export is visible and wired", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="downloadResultAuditBundle"/);
  assert.match(appSource, /createResultAuditBundle/);
  assert.match(appSource, /RESULT_AUDIT_BUNDLE_PRIVACY_NOTICE/);
});
