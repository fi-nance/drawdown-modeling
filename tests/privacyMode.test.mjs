import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("privacy mode disables explicit external lookup helpers without hiding local imports", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="privacyMode"/);
  assert.match(html, /id="csvFile"[^>]*type="file"/);
  assert.match(html, /id="jsonFile"[^>]*type="file"/);
  assert.match(html, /id="restoreSetupFile"[^>]*type="file"/);
  assert.doesNotMatch(html, /id="csvFile"[^>]*data-external-lookup/);
  assert.doesNotMatch(html, /id="jsonFile"[^>]*data-external-lookup/);
  assert.doesNotMatch(html, /id="restoreSetupFile"[^>]*data-external-lookup/);
  assert.match(html, /id="loadSheet"[^>]*data-external-lookup/);
  assert.match(html, /id="loadPrivateSheet"[^>]*data-external-lookup/);
  assert.match(html, /id="findMarketplacePlans"[^>]*data-external-lookup/);
  assert.match(html, /external ticker\/CUSIP price lookups/);
  assert.match(html, /local I-bond pricing remain available/);

  assert.match(appSource, /function privacyModeEnabled/);
  assert.match(appSource, /function updatePrivacyModeControls/);
  assert.match(appSource, /event\?\.target\?\.id === "privacyMode"/);
  assert.match(appSource, /Privacy mode is on\. Turn it off before using/);
  assert.match(appSource, /privacyMode: privacyModeEnabled\(\)/);
  assert.match(appSource, /external ticker\/CUSIP price lookups were disabled/);
  assert.match(appSource, /external ticker\/CUSIP price lookup, or confirmed an export/);
  assert.match(appSource, /\["Data custody", dataCustodyAuditLine\(scenario\)\]/);
});
