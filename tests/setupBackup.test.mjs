import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createSetupBackup,
  parseSetupBackup,
  SETUP_BACKUP_PRIVACY_NOTICE,
  SETUP_BACKUP_SCHEMA_VERSION,
  SETUP_BACKUP_TYPE
} from "../src/core/setupBackup.mjs";

const setupState = {
  controls: {
    planYears: "35",
    includeTaxes: true,
    filingStatus: "marriedFilingJointly"
  },
  assets: [{
    id: "cash",
    name: "Cash",
    accountType: "taxable",
    assetClass: "cash",
    units: 1000,
    price: 1
  }],
  oneOffExpenses: [{
    name: "Car",
    startYear: 2030,
    endYear: 2030,
    amount: 35000,
    inflationAdjusted: true
  }],
  conditionalAssetSales: [{
    name: "Second home",
    triggerPortfolioValue: 500000,
    saleProceeds: 250000,
    taxableLongTermGain: 50000,
    inflationAdjusted: true
  }],
  decisionProfile: {
    mode: "recentlyLeftWork",
    requiredSpend: 72000,
    flexibleSpend: 28000,
    targetSuccessRate: 0.9
  },
  redesign: {
    persona: "preRetiree",
    outcome: "willItLast",
    enabledModules: ["basics", "portfolio", "strategy"]
  }
};

test("setup backup wraps full setup state with metadata", () => {
  const backup = createSetupBackup(setupState, { exportedAt: "2026-05-01T00:00:00.000Z" });

  assert.equal(backup.type, SETUP_BACKUP_TYPE);
  assert.equal(backup.schemaVersion, SETUP_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.exportedAt, "2026-05-01T00:00:00.000Z");
  assert.equal(backup.privacyNotice, SETUP_BACKUP_PRIVACY_NOTICE);
  // Normalization fills in the (empty) income-streams array.
  assert.deepEqual(backup.state, { ...setupState, incomeStreams: [] });
});

test("setup backup parser accepts wrapped and legacy saved-state JSON", () => {
  const wrapped = createSetupBackup(setupState, { exportedAt: "2026-05-01T00:00:00.000Z" });
  const legacy = { ...setupState, activeScreen: "setup" };

  assert.deepEqual(parseSetupBackup(JSON.stringify(wrapped)), { ...setupState, incomeStreams: [] });
  assert.deepEqual(parseSetupBackup(JSON.stringify(legacy)), { ...setupState, incomeStreams: [] });
});

test("backups without dynamic lists normalize to empty arrays so restores clear current lists", () => {
  // Older backups may carry no incomeStreams or conditionalAssetSales fields;
  // restoring one must replace the workspace's lists with [], not keep them.
  const legacyState = { ...setupState };
  delete legacyState.incomeStreams;
  delete legacyState.conditionalAssetSales;
  const restored = parseSetupBackup(JSON.stringify({ type: SETUP_BACKUP_TYPE, state: legacyState }));
  assert.deepEqual(restored.incomeStreams, []);
  assert.deepEqual(restored.conditionalAssetSales, []);
  assert.throws(
    () => parseSetupBackup(JSON.stringify({ ...setupState, incomeStreams: "bad" })),
    /income streams/i
  );
  assert.throws(
    () => parseSetupBackup(JSON.stringify({ ...setupState, conditionalAssetSales: "bad" })),
    /conditional asset sales/i
  );
});

test("setup backup parser rejects malformed backups clearly", () => {
  assert.throws(() => parseSetupBackup("{"), /Invalid setup backup JSON/);
  assert.throws(() => parseSetupBackup(JSON.stringify({ controls: {} })), /assets array/);
  assert.throws(
    () => parseSetupBackup(JSON.stringify({ ...setupState, oneOffExpenses: "bad" })),
    /one-off expenses/i
  );
  assert.throws(
    () => parseSetupBackup(JSON.stringify({ ...setupState, redesign: [] })),
    /redesign state/i
  );
  assert.throws(
    () => parseSetupBackup(JSON.stringify({ ...setupState, decisionProfile: [] })),
    /decision profile/i
  );
});

test("setup backup export is privacy-gated and wired", async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.mjs", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="downloadSetup"/);
  assert.match(appSource, /els\.downloadSetup\.addEventListener\("click", downloadSetupBackup\)/);
  assert.match(appSource, /async function downloadSetupBackup\(\)/);
  assert.match(appSource, /body: SETUP_BACKUP_PRIVACY_NOTICE/);
  assert.match(appSource, /confirmLabel: "Export setup"/);
  assert.match(appSource, /createSetupBackup/);
  assert.match(appSource, /ensureUniqueAssetIds\(stored\.assets\.map\(\(asset\) => \(\{ \.\.\.asset \}\)\)\)/);
});
