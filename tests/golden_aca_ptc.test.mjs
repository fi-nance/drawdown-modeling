// Golden test: ACA premium tax credit math.
//
// Primary sources:
//   - IRC §36B (premium tax credit).
//   - IRS Rev. Proc. 2025-25 / IRB 2025-32: 2026 plan-year applicable
//     percentage table and required contribution percentage. Cited in
//     `src/data/taxData.mjs` ACA_2026.source.
//   - 26 CFR §1.36B-1(h): "Federal poverty line" — PTC for the plan year
//     uses the FPL guidelines in effect on the first day of the regular
//     enrollment period. The 2026 plan year therefore uses the 2025 HHS
//     FPL guidelines, which is why `buildAcaConfig({ taxYear: 2026 })`
//     loads `FPL_2025`.
//   - HHS 2025 FPL: $21,150 for a household of 2 in the 48 contiguous
//     states + DC (Federal Register 2025-01644).
//
// The test exercises the published 2026 applicable percentage curve at
// known FPL anchors and computes the expected PTC by hand from the
// statutory formula:
//
//     PTC = max(0, benchmark_premium − (household_income × applicable_pct))
//
// If the underlying tables are updated for a new plan year, the expected
// values below change. Add a new golden test for the new year rather than
// rewriting these.

import assert from "node:assert/strict";
import test from "node:test";

import { computeAca, contributionRateForFplPercent } from "../src/core/aca.mjs";
import { ACA_2026, buildAcaConfig, getFplGuideline } from "../src/data/taxData.mjs";

const APPLICABLE = ACA_2026.applicablePercentageTable;

test("Rev. Proc. 2025-25: 2026 applicable percentages at FPL anchors", () => {
  // Anchor values verified against Rev. Proc. 2025-25 Table 2.
  assert.equal(contributionRateForFplPercent(100, APPLICABLE), 0.021);
  assert.equal(contributionRateForFplPercent(133, APPLICABLE), 0.021);
  assert.equal(contributionRateForFplPercent(150, APPLICABLE), 0.0419);
  assert.equal(contributionRateForFplPercent(200, APPLICABLE), 0.066);
  assert.equal(contributionRateForFplPercent(250, APPLICABLE), 0.0844);
  assert.equal(contributionRateForFplPercent(300, APPLICABLE), 0.0996);
  assert.equal(contributionRateForFplPercent(400, APPLICABLE), 0.0996);
});

test("IRC §36B PTC at exactly 200% FPL, contiguous MFJ household of 2", () => {
  // Plan year 2026 → uses 2025 HHS FPL (per 26 CFR §1.36B-1(h)).
  // Household of 2 in the 48 contiguous states + DC: $21,150.
  const fpl = getFplGuideline({ taxYear: 2025, state: "Florida", householdSize: 2 });
  assert.equal(fpl, 21150);

  const magi = fpl * 2; // exactly 200% FPL
  const benchmarkAnnual = 12000; // $1,000/mo SLCSP, age-rated to household

  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 2,
    marketplaceMembers: 2
  });
  assert.equal(config.fpl, fpl);

  const result = computeAca({
    magi,
    config: {
      ...config,
      benchmarkPremium: benchmarkAnnual,
      selectedPlanPremium: benchmarkAnnual,
      ageRatedBenchmarkPremium: false,
      ageRatedSelectedPlanPremium: false
    }
  });

  // At exactly 200% FPL the applicable percentage is 6.6% (end of the
  // 150–200% band).
  assert.equal(result.contributionRate, 0.066);

  // Expected contribution = MAGI × 6.6% = $42,300 × 0.066 = $2,791.80
  assert.equal(result.expectedContribution, 2791.8);

  // PTC = max(0, $12,000 − $2,791.80) = $9,208.20
  assert.equal(result.subsidy, 9208.2);
  assert.equal(result.netPremium, 2791.8);
  assert.equal(result.eligible, true);
});

test("IRC §36B: below 100% FPL the household is ineligible for PTC", () => {
  // Below 100% FPL the citizen household generally falls to Medicaid
  // territory (or the coverage gap in non-expansion states). The model
  // returns no subsidy.
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 2,
    marketplaceMembers: 2
  });
  const fpl = config.fpl;

  const result = computeAca({
    magi: Math.floor(fpl * 0.5), // 50% FPL
    config: {
      ...config,
      benchmarkPremium: 12000,
      selectedPlanPremium: 12000,
      ageRatedBenchmarkPremium: false,
      ageRatedSelectedPlanPremium: false
    }
  });

  assert.equal(result.eligible, false);
  assert.equal(result.subsidy, 0);
});

test("Rev. Proc. 2025-25: above 400% FPL, contribution falls back to 9.96% required-contribution rate", () => {
  // The 2026 maxEligibleFplPercent is 400; above that the household pays
  // the full unsubsidized premium. The model uses the required-contribution
  // percentage (9.96%) as the fallback expected-contribution rate but
  // returns zero subsidy because the household is over the cliff.
  const config = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 2,
    marketplaceMembers: 2
  });

  const magi = config.fpl * 5; // 500% FPL
  const result = computeAca({
    magi,
    config: {
      ...config,
      benchmarkPremium: 12000,
      selectedPlanPremium: 12000,
      ageRatedBenchmarkPremium: false,
      ageRatedSelectedPlanPremium: false
    }
  });

  assert.equal(result.eligible, false);
  assert.equal(result.subsidy, 0);
  assert.equal(result.netPremium, 12000);
  assert.equal(result.contributionRate, 0.0996);
});
