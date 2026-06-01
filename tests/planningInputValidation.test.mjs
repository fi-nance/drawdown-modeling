import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_USER_PLANNING_ANNUAL_SPEND,
  normalizeUserPlanningSpendingMode,
  validateUserPlanningScenario
} from "../src/core/planningInputValidation.mjs";

test("workspace planning validation rejects zero and test-scale fixed target spending", () => {
  const zero = validateUserPlanningScenario({
    targetSpend: 0,
    spendingStrategy: { mode: "fixed" }
  });
  assert.equal(zero.ok, false);
  assert.equal(zero.errors[0].controlId, "targetSpend");
  assert.match(zero.errors[0].message, /at least \$1,000\/yr/);

  const belowFloor = validateUserPlanningScenario({
    targetSpend: MIN_USER_PLANNING_ANNUAL_SPEND - 1,
    spendingStrategy: { mode: "fixed" }
  });
  assert.equal(belowFloor.ok, false);
});

test("workspace planning validation accepts realistic fixed target spending", () => {
  const validation = validateUserPlanningScenario({
    targetSpend: MIN_USER_PLANNING_ANNUAL_SPEND,
    spendingStrategy: { mode: "fixed" }
  });

  assert.equal(validation.ok, true);
  assert.deepEqual(validation.errors, []);
});

test("workspace planning validation checks combined guardrail spending", () => {
  const missingSpend = validateUserPlanningScenario({
    targetSpend: 0,
    spendingStrategy: {
      mode: "discretionaryGuardrails",
      essentialSpend: 0,
      discretionarySpend: 0
    }
  });
  assert.equal(missingSpend.ok, false);
  assert.equal(missingSpend.errors[0].controlId, "essentialSpend");

  const validSpend = validateUserPlanningScenario({
    targetSpend: MIN_USER_PLANNING_ANNUAL_SPEND,
    spendingStrategy: {
      mode: "discretionaryGuardrails",
      essentialSpend: 0,
      discretionarySpend: MIN_USER_PLANNING_ANNUAL_SPEND
    }
  });
  assert.equal(validSpend.ok, true);
});

test("workspace planning validation preserves advanced spending strategy modes", () => {
  assert.equal(normalizeUserPlanningSpendingMode("guytonKlinger"), "guytonKlinger");
  assert.equal(normalizeUserPlanningSpendingMode("kitces"), "kitces");
  assert.equal(normalizeUserPlanningSpendingMode("vpw"), "vpw");
  assert.equal(normalizeUserPlanningSpendingMode("unknown"), "fixed");

  for (const mode of ["guytonKlinger", "kitces", "vpw"]) {
    const valid = validateUserPlanningScenario({
      targetSpend: MIN_USER_PLANNING_ANNUAL_SPEND,
      spendingStrategy: { mode }
    });
    assert.equal(valid.ok, true, `${mode} should accept realistic target spending`);

    const invalid = validateUserPlanningScenario({
      targetSpend: 0,
      spendingStrategy: { mode }
    });
    assert.equal(invalid.ok, false, `${mode} should reject zero target spending`);
  }
});
