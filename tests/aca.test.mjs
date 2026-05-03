import assert from "node:assert/strict";
import test from "node:test";

import {
  acaAgeRatingFactor,
  computeAca,
  contributionRateForFplPercent,
  inflateAcaConfig
} from "../src/core/aca.mjs";
import { buildAcaConfig, getFplGuideline } from "../src/data/taxData.mjs";

const acaConfig = {
  enabled: true,
  householdSize: 2,
  fpl: 20000,
  benchmarkPremium: 18000,
  contributionCurve: [
    { upToFplPercent: 150, contributionRate: 0 },
    { upToFplPercent: 200, contributionRate: 0.02 },
    { upToFplPercent: 300, contributionRate: 0.06 },
    { upToFplPercent: Infinity, contributionRate: 0.085 }
  ]
};

test("ACA subsidy falls as MAGI rises", () => {
  const low = computeAca({ magi: 30000, config: acaConfig });
  const high = computeAca({ magi: 90000, config: acaConfig });

  assert.ok(low.subsidy > high.subsidy);
  assert.ok(low.netPremium < high.netPremium);
});

test("ACA can be disabled for non-marketplace coverage", () => {
  const result = computeAca({
    magi: 30000,
    config: { ...acaConfig, enabled: false }
  });

  assert.equal(result.subsidy, 0);
  assert.equal(result.netPremium, 0);
});

test("2026 FPL is calculated from household size and state", () => {
  assert.equal(getFplGuideline({ taxYear: 2026, state: "Florida", householdSize: 2 }), 21640);
  assert.equal(getFplGuideline({ taxYear: 2026, state: "Alaska", householdSize: 3 }), 34150);
  assert.equal(getFplGuideline({ taxYear: 2026, state: "Hawaii", householdSize: 9 }), 70600);
});

test("2026 ACA benchmark and applicable percentages are versioned", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 2,
    marketplaceMembers: 2
  });

  assert.equal(config.fpl, 21640);
  assert.equal(config.benchmarkPremium, 16392);
  assert.equal(config.oopMaximum, 21200);
  assert.equal(contributionRateForFplPercent(200, config.applicablePercentageTable), 0.066);
  assert.equal(contributionRateForFplPercent(400, config.applicablePercentageTable), 0.0996);
});

test("ACA benchmark premiums use the federal default age rating curve", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 1,
    marketplaceMembers: 1
  });
  const age40 = inflateAcaConfig(config, 1, { age: 40 });
  const age50 = inflateAcaConfig(config, 1, { age: 50 });

  assert.equal(acaAgeRatingFactor(40), 1.278);
  assert.equal(acaAgeRatingFactor(50), 1.786);
  assert.equal(age40.benchmarkPremium, config.benchmarkPremium);
  assert.equal(age50.benchmarkPremium, round6(config.benchmarkPremium * (1.786 / 1.278)));
});

test("selected ACA plan premium is separate from the subsidy benchmark", () => {
  const config = {
    enabled: true,
    fpl: 20000,
    benchmarkPremium: 18000,
    selectedPlanPremium: 24000,
    maxEligibleFplPercent: 400,
    applicablePercentageTable: [
      { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
    ]
  };

  const result = computeAca({ magi: 30000, config });

  assert.equal(result.benchmarkPremium, 18000);
  assert.equal(result.grossPremium, 24000);
  assert.equal(result.expectedContribution, 1500);
  assert.equal(result.maxPremiumTaxCredit, 16500);
  assert.equal(result.subsidy, 16500);
  assert.equal(result.netPremium, 7500);
});

test("selected ACA plan subsidy is capped at actual plan premium", () => {
  const result = computeAca({
    magi: 30000,
    config: {
      enabled: true,
      fpl: 20000,
      benchmarkPremium: 18000,
      selectedPlanPremium: 12000,
      maxEligibleFplPercent: 400,
      applicablePercentageTable: [
        { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
      ]
    }
  });

  assert.equal(result.maxPremiumTaxCredit, 16500);
  assert.equal(result.subsidy, 12000);
  assert.equal(result.netPremium, 0);
});

test("selected ACA plan exact premiums age-rate from current household ages", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 2,
    marketplaceMembers: 2,
    currentAge: 50,
    memberAges: [50, 55],
    planCostMode: "selectedPlan",
    benchmarkPremiumOverride: 18000,
    selectedPlanPremiumOverride: 24000,
    selectedPlanOopMaximumOverride: 14000
  });
  const current = inflateAcaConfig(config, 1, { age: 50, yearIndex: 0 });
  const nextYear = inflateAcaConfig(config, 1, { age: 51, yearIndex: 1 });
  const currentRatingTotal = acaAgeRatingFactor(50) + acaAgeRatingFactor(55);
  const nextRatingTotal = acaAgeRatingFactor(51) + acaAgeRatingFactor(56);

  assert.equal(config.oopMaximum, 14000);
  assert.equal(current.benchmarkPremium, 18000);
  assert.equal(current.selectedPlanPremium, 24000);
  assert.equal(nextYear.selectedPlanPremium, round6(24000 * (nextRatingTotal / currentRatingTotal)));
});

test("ACA benchmark overrides are treated as current-age premiums", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 1,
    marketplaceMembers: 1,
    currentAge: 50,
    benchmarkPremiumOverride: 12000
  });
  const age50 = inflateAcaConfig(config, 1, { age: 50 });
  const age51 = inflateAcaConfig(config, 1, { age: 51 });

  assert.equal(age50.benchmarkPremium, 12000);
  assert.equal(age51.benchmarkPremium, round6(12000 * (1.865 / 1.786)));
});

test("2026 ACA cost-sharing limit switches between self-only and family coverage", () => {
  const selfOnly = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 1,
    marketplaceMembers: 1
  });
  const family = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 4,
    marketplaceMembers: 2
  });

  assert.equal(selfOnly.oopMaximum, 10600);
  assert.equal(family.oopMaximum, 21200);
});

test("2026 ACA subsidies stop above 400 percent FPL", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 2,
    marketplaceMembers: 2
  });
  const below = computeAca({ magi: config.fpl * 4, config });
  const above = computeAca({ magi: config.fpl * 4 + 1, config });

  assert.equal(below.eligible, true);
  assert.equal(above.eligible, false);
  assert.equal(above.subsidy, 0);
  assert.equal(above.netPremium, config.benchmarkPremium);
});

function round6(value) {
  return Math.round(value * 1000000) / 1000000;
}
