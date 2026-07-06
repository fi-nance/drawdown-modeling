import assert from "node:assert/strict";
import test from "node:test";

import {
  acaAgeRatingFactor,
  computeAca,
  contributionRateForFplPercent,
  inflateAcaConfig
} from "../src/core/aca.mjs";
import { buildAcaConfig, getFplGuideline } from "../src/data/taxData.mjs";
import { slcspMonthlyFor } from "../src/data/acaRatingArea.mjs";

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

test("2025 FPL is available for prior-year ACA lookups (Treas. Reg. §1.36B-1(h))", () => {
  // PTC for 2026 coverage uses the FPL "in effect on the first day of the
  // regular enrollment period for coverage" — i.e. the 2025 HHS guidelines.
  assert.equal(getFplGuideline({ taxYear: 2025, state: "Florida", householdSize: 2 }), 21150);
  assert.equal(getFplGuideline({ taxYear: 2025, state: "Alaska", householdSize: 1 }), 19550);
  assert.equal(getFplGuideline({ taxYear: 2025, state: "Alaska", householdSize: 2 }), 26430);
  assert.equal(getFplGuideline({ taxYear: 2025, state: "Hawaii", householdSize: 4 }), 36980);
});

test("buildAcaConfig uses prior-year FPL for PTC", () => {
  // For 2026 coverage, the config's FPL should be the 2025 HHS value.
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 2,
    marketplaceMembers: 2
  });
  assert.equal(config.fpl, 21150);
});

test("buildAcaConfig carries ZIP into the ACA benchmark lookup", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 1,
    marketplaceMembers: 1,
    currentAge: 40,
    memberAges: [40],
    zip: "33101"
  });
  const result = computeAca({ magi: 40000, config });

  assert.equal(config.zip, "33101");
  assert.equal(result.benchmarkPremium, 684.37 * 12);
  assert.equal(result.ratingArea.areaCode, 43);
  assert.equal(result.benchmarkFallback, null);
});

test("ZIP benchmark path age-rates and inflates future-year premiums", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Texas",
    householdSize: 1,
    marketplaceMembers: 1,
    currentAge: 40,
    memberAges: [40],
    zip: "77002"
  });
  const nextYear = inflateAcaConfig(config, 1.1, { age: 41, yearIndex: 1 });
  const expected = slcspMonthlyFor({ zip: "77002", householdAges: [41] }).monthlyPremium * 12 * 1.1;
  const result = computeAca({ magi: 40000, config: nextYear });

  assert.deepEqual(nextYear.currentMemberAges, [41]);
  assert.equal(result.benchmarkPremium, round6(expected));
  assert.equal(result.grossPremium, round6(expected));
  assert.equal(result.benchmarkFallback, null);
});

test("ACA is ineligible below 100% FPL by default (IRC §36B)", () => {
  const config = {
    enabled: true,
    fpl: 25000,
    benchmarkPremium: 12000,
    selectedPlanPremium: 12000,
    applicablePercentageTable: [
      { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
    ],
    requiredContributionPercentage: 0.0996,
    maxEligibleFplPercent: 400
  };
  // Below 100% FPL → ineligible (Medicaid territory).
  const below = computeAca({ magi: 20000, config });
  assert.equal(below.eligible, false);
  assert.equal(below.subsidy, 0);

  // Just at 100% FPL → eligible.
  const at = computeAca({ magi: 25000, config });
  assert.equal(at.eligible, true);
});

test("ACA min eligibility floor is configurable for non-citizen exceptions", () => {
  const config = {
    enabled: true,
    fpl: 25000,
    benchmarkPremium: 12000,
    selectedPlanPremium: 12000,
    applicablePercentageTable: [
      { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
    ],
    requiredContributionPercentage: 0.0996,
    maxEligibleFplPercent: 400,
    minEligibleFplPercent: 0
  };
  const below = computeAca({ magi: 20000, config });
  assert.equal(below.eligible, true);
});

test("2026 ACA benchmark and applicable percentages are versioned", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 2,
    marketplaceMembers: 2
  });

  // PTC uses prior-year HHS guidelines (2025 for 2026 coverage)
  assert.equal(config.fpl, 21150);
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

test("quoted net ACA premiums bypass subsidy recalculation", () => {
  const result = computeAca({
    magi: 30000,
    config: {
      enabled: true,
      premiumInputMode: "net",
      fpl: 20000,
      benchmarkPremium: 18000,
      selectedPlanPremium: 1200,
      maxEligibleFplPercent: 400,
      applicablePercentageTable: [
        { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
      ]
    }
  });

  assert.equal(result.premiumInputMode, "net");
  assert.equal(result.expectedContribution, 0);
  assert.equal(result.subsidy, 0);
  assert.equal(result.netPremium, 1200);
});

test("ACA backup plan activates when MAGI crosses the configured FPL trigger", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Massachusetts",
    householdSize: 2,
    marketplaceMembers: 2,
    fplOverride: 20000,
    planCostMode: "selectedPlan",
    premiumInputMode: "net",
    selectedPlanPremiumOverride: 3600,
    selectedPlanOopMaximumOverride: 4500,
    backupPlanPremiumOverride: 12000,
    backupPlanBenchmarkPremiumOverride: 10000,
    backupPlanOopMaximumOverride: 9000,
    backupTriggerFplPercent: 400,
    backupPlanName: "Backup silver plan"
  });
  const below = computeAca({ magi: 79000, config });
  const above = computeAca({ magi: 81000, config });

  assert.equal(below.activePlanRole, "primary");
  assert.equal(below.premiumInputMode, "net");
  assert.equal(below.netPremium, 3600);
  assert.equal(below.oopMaximum, 4500);
  assert.equal(above.activePlanRole, "backup");
  assert.equal(above.planName, "Backup silver plan");
  assert.equal(above.eligible, false);
  assert.equal(above.benchmarkPremium, 10000);
  assert.equal(above.grossPremium, 12000);
  assert.equal(above.netPremium, 12000);
  assert.equal(above.oopMaximum, 9000);
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
  assert.equal(nextYear.oopMaximum, 14000);
});

test("manual ACA premiums can opt out of age-rating", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 1,
    marketplaceMembers: 1,
    currentAge: 50,
    memberAges: [50],
    planCostMode: "selectedPlan",
    ageRateManualPremiums: false,
    benchmarkPremiumOverride: 12000,
    selectedPlanPremiumOverride: 18000,
    selectedPlanOopMaximumOverride: 9000
  });
  const nextYear = inflateAcaConfig(config, 1, { age: 51, yearIndex: 1 });

  assert.equal(nextYear.benchmarkPremium, 12000);
  assert.equal(nextYear.selectedPlanPremium, 18000);
  assert.equal(nextYear.oopMaximum, 9000);
});

test("ACA backup plan premiums can age-rate while OOP max only inflates", () => {
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 1,
    marketplaceMembers: 1,
    currentAge: 40,
    memberAges: [40],
    backupPlanPremiumOverride: 12000,
    backupPlanOopMaximumOverride: 9000
  });
  const nextYear = inflateAcaConfig(config, 1.1, { age: 41, yearIndex: 1 });

  assert.equal(nextYear.backupPlan.selectedPlanPremium, round6(12000 * (1.302 / 1.278) * 1.1));
  assert.equal(nextYear.backupPlan.oopMaximum, 9900);
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
