import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

globalThis.document = {
  readyState: "loading",
  addEventListener() {},
  getElementById() {
    return null;
  }
};

const [redesignSource, appSource, readme, dataSources, html, redesignCss] = await Promise.all([
  readFile(new URL("src/redesign.mjs", root), "utf8"),
  readFile(new URL("src/app.mjs", root), "utf8"),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("docs/DATA_SOURCES.md", root), "utf8"),
  readFile(new URL("index.html", root), "utf8"),
  readFile(new URL("src/redesign.css", root), "utf8"),
]);
const { withdrawalMixBreakdown } = await import("../src/redesign.mjs?review-findings-regression");

test("withdrawal-mix chart uses canonical Social Security data without double-counting RMDs", () => {
  assert.doesNotMatch(redesignSource, /y\.socialSecurity\?\.benefit/);
  assert.match(redesignSource, /const socialSecurity = Math\.max\(0, Number\(year\.socialSecurityBenefits\) \|\| 0\);/);
  assert.match(redesignSource, /const traditionalSales = Math\.max\(0, Number\(year\.sales\?\.filter/);
  assert.match(redesignSource, /const traditional = Math\.max\(0, traditionalSales - rmd\);/);
});

test("action plan does not repeat tagged RMD sales as ordinary withdrawals", () => {
  assert.match(appSource, /if \(sale\.withdrawalPurpose === "rmd"\) continue;/);
});

test("strategy descriptions match the implemented approximation rules", () => {
  assert.doesNotMatch(appSource, /Mathematically maximizes/);
  assert.doesNotMatch(appSource, /ensuring zero chance of premature depletion/);
  assert.match(appSource, /prior year's stock return is negative/i);
  assert.match(appSource, /1\.5× its previous high-water mark/i);
  assert.match(appSource, /remaining plan horizon and expected real return/i);
});

test("withdrawal-strategy documentation identifies lifetime as the default", () => {
  assert.match(readme, /default withdrawal strategy uses the lifetime optimizer/i);
  assert.doesNotMatch(readme, /default withdrawal strategy keeps the current heuristic/i);
  assert.match(dataSources, /default lifetime optimizer/i);
});

test("state-tax documentation exposes the current provenance limitation", () => {
  assert.match(dataSources, /secondary cross-check/i);
  assert.match(dataSources, /primary-source audit pending/i);
});

test("results screen keeps year controls near the cash-flow graph", () => {
  assert.match(html, /id="cashFlowYearPrev"/);
  assert.match(html, /id="cashFlowYearRange"/);
  assert.match(html, /id="cashFlowYearNext"/);
  assert.match(appSource, /cashFlowYearRange: document\.querySelector\("#cashFlowYearRange"\)/);
  assert.match(appSource, /cashFlowYearPrev: document\.querySelector\("#cashFlowYearPrev"\)/);
  assert.match(appSource, /cashFlowYearNext: document\.querySelector\("#cashFlowYearNext"\)/);
  assert.match(appSource, /els\.cashFlowYearRange\?\.addEventListener\("input"/);
});

test("withdrawal mix shows all visible years with absolute-scale details and distinct Social Security color", () => {
  assert.match(html, /id="withdrawalMixDetail"/);
  assert.match(html, /Cash in, out &amp; conversions per year/);
  assert.match(redesignSource, /export function withdrawalMixBreakdown/);
  assert.match(redesignSource, /root\.style\.setProperty\("--mix-cols", String\(years\.length\)\)/);
  assert.match(redesignSource, /displayedAmount\(breakdown\.cashIn, y\)/);
  assert.match(redesignSource, /class="mix-bar mix-bar-out"/);
  assert.match(redesignSource, /class="mix-bar mix-bar-conversion"/);
  assert.match(redesignCss, /\.mix-stack \.mix-ss\s+\{\s*background: #f08c3a;/);
  assert.match(redesignCss, /\.withdrawal-mix-detail/);
});

test("withdrawal mix totals cash inflows, cash outflows, reserve transfers, and conversions without double-counting", () => {
  const breakdown = withdrawalMixBreakdown({
    sales: [
      { accountType: "taxable", proceeds: 20_000 },
      { accountType: "traditional", proceeds: 15_000 }
    ],
    socialSecurityBenefits: 10_000,
    rmdAmount: 5_000,
    rothConversionAmount: 7_500,
    flows: [
      { from: "Taxable accounts", to: "Spending reserve", amount: 20_000, type: "withdrawal" },
      { from: "Traditional accounts", to: "Spending reserve", amount: 15_000, type: "withdrawal" },
      { from: "Social Security", to: "Spending reserve", amount: 10_000, type: "income" },
      { from: "Taxable account dividends", to: "Spending reserve", amount: 4_000, type: "income" },
      { from: "Spending reserve", to: "Lifestyle", amount: 42_000, type: "spending" },
      { from: "Spending reserve", to: "Medical", amount: 4_000, type: "medical" },
      { from: "Spending reserve", to: "Taxable cash reserve", amount: 3_000, type: "balance" }
    ]
  });

  assert.deepEqual(
    {
      taxable: breakdown.taxable,
      traditional: breakdown.traditional,
      rmd: breakdown.rmd,
      socialSecurity: breakdown.socialSecurity,
      otherIncome: breakdown.otherIncome,
      cashIn: breakdown.cashIn,
      cashOut: breakdown.cashOut,
      reserveTransfer: breakdown.reserveTransfer,
      rothConversion: breakdown.rothConversion
    },
    {
      taxable: 20_000,
      traditional: 10_000,
      rmd: 5_000,
      socialSecurity: 10_000,
      otherIncome: 4_000,
      cashIn: 49_000,
      cashOut: 46_000,
      reserveTransfer: 3_000,
      rothConversion: 7_500
    }
  );
});

test("decision rescue cards open the relevant workspace controls instead of being static cards", () => {
  assert.match(redesignSource, /const RESCUE_KIND_MODULE_FALLBACK = \{/);
  assert.match(redesignSource, /function openRescueOptionInWorkspace/);
  assert.match(redesignSource, /data-rescue-open="\$\{index\}"/);
  assert.match(redesignSource, /data-rescue-apply="\$\{index\}"/);
  assert.match(redesignSource, /function applyRescueOptionFromDecision/);
  assert.match(redesignSource, /__pslApplyRescueScenarioToWorkspace/);
  assert.match(redesignSource, /Apply &amp; rerun/);
  assert.match(redesignCss, /\.decision-rescue-apply/);
});
