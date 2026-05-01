import assert from "node:assert/strict";
import test from "node:test";

import {
  createSetupBackup,
  parseSetupBackup,
  SETUP_BACKUP_SCHEMA_VERSION,
  SETUP_BACKUP_TYPE
} from "../src/core/setupBackup.mjs";

const setupState = {
  activeScreen: "setup",
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
  }]
};

test("setup backup wraps full setup state with metadata", () => {
  const backup = createSetupBackup(setupState, { exportedAt: "2026-05-01T00:00:00.000Z" });

  assert.equal(backup.type, SETUP_BACKUP_TYPE);
  assert.equal(backup.schemaVersion, SETUP_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.exportedAt, "2026-05-01T00:00:00.000Z");
  assert.deepEqual(backup.state, setupState);
});

test("setup backup parser accepts wrapped and legacy saved-state JSON", () => {
  const wrapped = createSetupBackup(setupState, { exportedAt: "2026-05-01T00:00:00.000Z" });

  assert.deepEqual(parseSetupBackup(JSON.stringify(wrapped)), setupState);
  assert.deepEqual(parseSetupBackup(JSON.stringify(setupState)), setupState);
});

test("setup backup parser rejects malformed backups clearly", () => {
  assert.throws(() => parseSetupBackup("{"), /Invalid setup backup JSON/);
  assert.throws(() => parseSetupBackup(JSON.stringify({ controls: {} })), /assets array/);
  assert.throws(
    () => parseSetupBackup(JSON.stringify({ ...setupState, oneOffExpenses: "bad" })),
    /one-off expenses/i
  );
});
