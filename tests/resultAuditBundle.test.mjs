import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RESULT_AUDIT_BUNDLE_PRIVACY_NOTICE,
  RESULT_AUDIT_BUNDLE_SCHEMA_VERSION,
  RESULT_AUDIT_BUNDLE_TYPE,
  createResultAuditBundle
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
  scenario: { taxYear: 2026, state: "Florida" },
  plan: {
    endingValue: 1000,
    years: [{ year: 2026, yearIndex: 0, endingPortfolioValue: 1000 }]
  },
  confidence: {
    headline: "Known exclusions",
    flags: [{ id: "legacy-tax-out-of-model", title: "Legacy strategy is residual-value only today" }]
  },
  decision: {
    sensitivity: {
      top: [{ id: "spending-5pct-higher", label: "Spending 5% higher" }]
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
  assert.deepEqual(bundle.setup, setupState);
  assert.deepEqual(bundle.audit, [
    { label: "Tax assumptions", value: "2026 federal and Florida state" },
    { label: "Simulation inputs", value: "1000 Monte Carlo runs" }
  ]);
  assert.equal(bundle.sourceVersions.taxDataVersion, "2026.1");
  assert.equal(bundle.result._compact, true);
  assert.equal(bundle.result.monteCarlo.scenarios[0].years, undefined);
  assert.deepEqual(bundle.result.monteCarlo.scenarios[0].lastYear, { year: 2026, yearIndex: 0, inflationIndex: 1 });
  assert.equal(bundle.result.confidence.headline, "Known exclusions");
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
