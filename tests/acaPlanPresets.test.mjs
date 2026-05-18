import assert from "node:assert/strict";
import test from "node:test";

import {
  massachusettsConnectorCareEstimate,
  massachusettsConnectorCarePlanOptions
} from "../src/data/acaPlanPresets.mjs";

test("Massachusetts ConnectorCare preset estimates plan type and combined OOP max", () => {
  const estimate = massachusettsConnectorCareEstimate({
    income: 60000,
    householdSize: 2,
    marketplaceMembers: 2
  });

  assert.equal(estimate.eligible, true);
  assert.equal(estimate.planName, "ConnectorCare Plan Type 3B");
  assert.equal(estimate.selectedPlanMonthlyPremium, 304);
  assert.equal(estimate.medicalOopMaximum, 3000);
  assert.equal(estimate.rxOopMaximum, 1500);
  assert.equal(estimate.selectedPlanOopMaximum, 4500);
  assert.equal(estimate.premiumInputMode, "net");
});

test("Massachusetts ConnectorCare preset can use an explicit public plan type", () => {
  const estimate = massachusettsConnectorCareEstimate({
    income: 60000,
    householdSize: 2,
    marketplaceMembers: 2,
    planTypeName: "ConnectorCare Plan Type 3C"
  });

  assert.equal(estimate.eligible, true);
  assert.equal(estimate.planName, "ConnectorCare Plan Type 3C");
  assert.equal(estimate.automaticPlanName, "ConnectorCare Plan Type 3B");
  assert.equal(estimate.userSelectedPlanType, true);
  assert.equal(massachusettsConnectorCarePlanOptions().length, 5);
});

test("Massachusetts ConnectorCare preset reports ineligible incomes above 400 percent FPL", () => {
  const estimate = massachusettsConnectorCareEstimate({
    income: 90000,
    householdSize: 2,
    marketplaceMembers: 2
  });

  assert.equal(estimate.eligible, false);
  assert.match(estimate.reason, /400% FPL/);
});
