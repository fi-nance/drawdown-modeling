import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { finiteNumberOr } from "../src/core/utils.mjs";

test("finiteNumberOr preserves deliberate zero values and defaults only missing or invalid input", () => {
  assert.equal(finiteNumberOr(0, 70), 0);
  assert.equal(finiteNumberOr("0", 70), 0);
  assert.equal(finiteNumberOr("", 70), 70);
  assert.equal(finiteNumberOr("not-a-number", 70), 70);
});

test("workspace scenario reader preserves zero-valued planning controls", async () => {
  const appSource = await readFile(new URL("../src/app.mjs", import.meta.url), "utf8");
  const readScenarioSource = appSource.slice(
    appSource.indexOf("function readScenario()"),
    appSource.indexOf("function readWithdrawalOrder()")
  );

  for (const expected of [
    /heirBaseIncome: finiteNumberOr\(els\.heirBaseIncome\.value, 80000\)/,
    /heirAge: finiteNumberOr\(els\.heirAge\.value, 30\)/,
    /retirementPenaltyAge: finiteNumberOr\(els\.retirementPenaltyAge\.value, DEFAULT_SCENARIO\.retirementPenaltyAge\)/,
    /targetStockPercent: Math\.max\(0, Math\.min\(100, finiteNumberOr\(els\.targetStockAllocation\?\.value, 70\)\)\)/,
    /rebalanceBandPercent: Math\.max\(0, Math\.min\(50, finiteNumberOr\(els\.rebalanceBand\?\.value, 5\)\)\)/,
    /glidepathStartStockPercent: Math\.max\(0, Math\.min\(100, finiteNumberOr\(els\.glidepathStartStockAllocation\?\.value, 60\)\)\)/,
    /glidepathEndStockPercent: Math\.max\(0, Math\.min\(100, finiteNumberOr\(els\.glidepathEndStockAllocation\?\.value, 80\)\)\)/,
    /targetMarginalRate: Math\.max\(0, finiteNumberOr\(els\.rothTargetRate\.value, 12\) \/ 100\)/,
    /magiBuffer: Math\.max\(0, finiteNumberOr\(els\.rothBasisMagiBuffer\?\.value, 1000\)\)/
  ]) {
    assert.match(readScenarioSource, expected);
  }
});

test("seed zero, income start age zero, and Social Security boundaries stay honest", async () => {
  const [html, appSource, redesignSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/redesign.mjs", import.meta.url), "utf8")
  ]);

  assert.match(appSource, /const seed = finiteNumberOr\(els\.seed\.value, 42\)/);
  assert.match(appSource, /seed: finiteNumberOr\(els\.seed\?\.value, 42\)/);
  assert.match(appSource, /const activeSeed = latest\.seed \?\? finiteNumberOr\(els\.seed\?\.value, 42\)/);
  assert.match(appSource, /startAge: finiteNumberOr\(els\.incomeStreamStartAge\?\.value, 65\)/);
  assert.match(redesignSource, /finiteNumberOr\(document\.getElementById\("rothTargetRate"\)\?\.value, 12\)/);
  assert.match(appSource, /core\/utils\.mjs\?v=20260622-zero-inputs/);
  assert.match(redesignSource, /core\/utils\.mjs\?v=20260622-zero-inputs/);
  assert.match(html, /id="socialSecurityStartAge"[^>]*min="62"[^>]*max="70"/);
  assert.match(html, /id="spouseSocialSecurityStartAge"[^>]*min="62"[^>]*max="70"/);
  assert.match(html, /src\/app\.mjs\?v=20260622-zero-inputs/);
  assert.match(html, /src\/redesign\.mjs\?v=20260622-zero-inputs/);
});

test("conditional sale copy distinguishes proceeds from separately modeled tax", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Sale proceeds before tax/);
  assert.match(html, /The taxable gain below is taxed separately by the model/);
  assert.match(html, /Taxable LT gain included above/);
  assert.doesNotMatch(html, /Net sale proceeds/);
});
