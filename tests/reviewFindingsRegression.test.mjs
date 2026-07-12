import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

const [redesignSource, appSource, readme, dataSources] = await Promise.all([
  readFile(new URL("src/redesign.mjs", root), "utf8"),
  readFile(new URL("src/app.mjs", root), "utf8"),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("docs/DATA_SOURCES.md", root), "utf8"),
]);

test("withdrawal-mix chart uses canonical Social Security data without double-counting RMDs", () => {
  assert.doesNotMatch(redesignSource, /y\.socialSecurity\?\.benefit/);
  assert.match(redesignSource, /const ss = Math\.max\(0, Number\(y\.socialSecurityBenefits\) \|\| 0\);/);
  assert.match(redesignSource, /const traditionalSales = Math\.max\(0, Number\(y\.sales\?\.filter/);
  assert.match(redesignSource, /const trad = Math\.max\(0, traditionalSales - rmd\);/);
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
