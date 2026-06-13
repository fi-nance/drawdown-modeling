// Regression tests for the ACA ↔ Medicare transition fixes.
//
// Bug fixed: the ZIP/rating-area SLCSP paths clamped members age 65+ to the
// age-64 rate instead of excluding them, so a mixed-age household was charged
// a full marketplace premium for a Medicare-eligible spouse WHILE the
// simulator also billed that spouse's Part B/D premiums (a double count).
// 65+ members are now excluded from the marketplace premium in both the
// federal-platform table (src/data/acaRatingArea.mjs) and the SBE table
// (src/data/sbeRatingArea.mjs), matching the exclude65Plus behavior of the
// manual age-rated path in src/core/aca.mjs.
//
// Also covered here:
// - computeAcaForYear derives fallback household ages [age, spouseAge] for the
//   ZIP path when the ACA config has no member ages, so the benchmark prices
//   the actual covered members.
// - computeAcaForYear marks fully-Medicare households so medical-cost logic
//   can switch from the ACA-plan OOP proxy to scenario.medicare.annualOopBase.
// - The "medicare-oop-inputs" confidence flag fires when a plan reaches
//   Medicare years without an entered Medicare OOP estimate.

import assert from "node:assert/strict";
import test from "node:test";

import { slcspMonthlyFor } from "../src/data/acaRatingArea.mjs";
import { sbeSlcspMonthlyFor } from "../src/data/sbeRatingArea.mjs";
import { inflateAcaConfig } from "../src/core/aca.mjs";
import { computeAcaForYear } from "../src/core/simulation/medical.mjs";
import { simulatePlan } from "../src/core/simulation.mjs?v=20260613-portfolio-prices";
import { buildAcaConfig, buildTaxProfile } from "../src/data/taxData.mjs";
import { buildConfidenceReport } from "../src/core/confidence.mjs";

// ─── SBE path: 65+ exclusion ────────────────────────────────────────────────

test("SBE SLCSP excludes Medicare-eligible members like the federal-platform path", () => {
  const couple = sbeSlcspMonthlyFor({ state: "CA", zip: "94110", householdAges: [62, 70] });
  const alone62 = sbeSlcspMonthlyFor({ state: "CA", zip: "94110", householdAges: [62] });
  assert.equal(couple.monthlyPremium, alone62.monthlyPremium);
  assert.equal(couple.medicareExcludedMemberCount, 1);
  assert.equal(alone62.medicareExcludedMemberCount, 0);

  const bothOnMedicare = sbeSlcspMonthlyFor({ state: "CA", zip: "94110", householdAges: [70, 67] });
  assert.equal(bothOnMedicare.monthlyPremium, 0);
  assert.equal(bothOnMedicare.medicareExcludedMemberCount, 2);
});

test("community-rated SBE states (NY) also exclude 65+ members", () => {
  const couple = sbeSlcspMonthlyFor({ state: "NY", zip: "10001", householdAges: [60, 68] });
  const alone60 = sbeSlcspMonthlyFor({ state: "NY", zip: "10001", householdAges: [60] });
  assert.equal(couple.monthlyPremium, alone60.monthlyPremium);
  assert.equal(couple.medicareExcludedMemberCount, 1);
});

test("SBE state-default states without a ZIP3 map (MA) also exclude 65+ members", () => {
  const couple = sbeSlcspMonthlyFor({ state: "MA", zip: "02101", householdAges: [60, 70] });
  const alone60 = sbeSlcspMonthlyFor({ state: "MA", zip: "02101", householdAges: [60] });
  assert.equal(couple.fallback, "state");
  assert.equal(couple.monthlyPremium, alone60.monthlyPremium);
  assert.equal(couple.medicareExcludedMemberCount, 1);
});

test("non-SBE state-level fallback path (IL) also excludes 65+ members", () => {
  const couple = slcspMonthlyFor({ zip: "60601", householdAges: [60, 70] });
  const alone60 = slcspMonthlyFor({ zip: "60601", householdAges: [60] });
  assert.equal(couple.fallback, "state");
  assert.equal(couple.monthlyPremium, alone60.monthlyPremium);
  assert.equal(couple.medicareExcludedMemberCount, 1);
});

// ─── computeAcaForYear: fallback household ages for the ZIP path ────────────

test("ZIP-mode ACA without member ages prices [age, spouseAge] and drops the 65+ spouse", () => {
  const config = inflateAcaConfig(
    buildAcaConfig({ taxYear: 2026, state: "Florida", householdSize: 2, marketplaceMembers: 2, zip: "33101" }),
    1,
    { age: 60, yearIndex: 0 }
  );

  // 60/70 couple: only the 60-year-old is marketplace-rated.
  const mixed = computeAcaForYear({ age: 60, spouseAge: 70, magi: 40000, config, filingStatus: "marriedFilingJointly" });
  const single60Benchmark = slcspMonthlyFor({ zip: "33101", householdAges: [60] }).monthlyPremium * 12;
  assert.equal(mixed.benchmarkPremium, Math.round(single60Benchmark * 1e6) / 1e6);
  assert.equal(mixed.benchmarkMedicareExcludedMembers, 1);
  assert.equal(mixed.medicareEligibleHousehold, undefined);

  // 60/59 couple: both members are rated.
  const bothUnder65 = computeAcaForYear({ age: 60, spouseAge: 59, magi: 40000, config, filingStatus: "marriedFilingJointly" });
  const coupleBenchmark = slcspMonthlyFor({ zip: "33101", householdAges: [60, 59] }).monthlyPremium * 12;
  assert.equal(bothUnder65.benchmarkPremium, Math.round(coupleBenchmark * 1e6) / 1e6);
  assert.ok(bothUnder65.benchmarkPremium > mixed.benchmarkPremium);
});

test("entered member ages still win over the [age, spouseAge] fallback", () => {
  const config = inflateAcaConfig(
    buildAcaConfig({ taxYear: 2026, state: "Florida", householdSize: 2, marketplaceMembers: 2, zip: "33101", memberAges: [55, 50] }),
    1,
    { age: 60, yearIndex: 0 }
  );
  const result = computeAcaForYear({ age: 60, spouseAge: 70, magi: 40000, config, filingStatus: "marriedFilingJointly" });
  const enteredAgesBenchmark = slcspMonthlyFor({ zip: "33101", householdAges: [55, 50] }).monthlyPremium * 12;
  assert.equal(result.benchmarkPremium, Math.round(enteredAgesBenchmark * 1e6) / 1e6);
});

test("fully-Medicare households are marked and pay no ACA premium", () => {
  const config = inflateAcaConfig(
    buildAcaConfig({ taxYear: 2026, state: "Florida", householdSize: 2, marketplaceMembers: 2 }),
    1,
    { age: 66, yearIndex: 0 }
  );
  const result = computeAcaForYear({ age: 66, spouseAge: 67, magi: 60000, config, filingStatus: "marriedFilingJointly" });
  assert.equal(result.medicareEligibleHousehold, true);
  assert.equal(result.netPremium, 0);
  assert.equal(result.eligible, false);
});

// ─── end-to-end: no ACA/Medicare double charge in a simulated year ──────────

test("mixed-age ZIP household pays ACA for the under-65 member and Medicare for the 65+ member — not both", () => {
  const taxProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" });
  const plan = simulatePlan({
    assets: [{ id: "cash", accountType: "taxable", assetClass: "cash", units: 2000000, price: 1, costBasisPerUnit: 1 }],
    scenario: {
      planYears: 1,
      startYear: 2026,
      currentAge: 64,
      spouseAge: 66,
      targetSpend: 40000,
      rothConversion: { enabled: false },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      aca: buildAcaConfig({ taxYear: 2026, state: "Florida", householdSize: 2, marketplaceMembers: 2, zip: "33101" })
    },
    taxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  const year = plan.years[0];
  // ACA prices ONLY the 64-year-old (the 66-year-old is Medicare-excluded).
  const single64Benchmark = slcspMonthlyFor({ zip: "33101", householdAges: [64] }).monthlyPremium * 12;
  assert.equal(year.aca.benchmarkPremium, Math.round(single64Benchmark * 1e6) / 1e6);
  // Medicare bills exactly the one 65+ spouse.
  assert.equal(year.medicare.partBEnrollees, 1);
  assert.ok(year.medicare.totalAnnualPremium > 0);
});

// ─── medicare.annualOopBase replaces the ACA-plan OOP proxy after 65 ────────

test("medicare.annualOopBase replaces the ACA-plan OOP proxy once the household is fully on Medicare", () => {
  const taxProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" });
  const baseScenario = {
    planYears: 1,
    startYear: 2026,
    currentAge: 66,
    spouseAge: 67,
    targetSpend: 40000,
    medicalExpensesBase: 1000,
    // Engage the legacy ACA-plan OOP proxy explicitly: a $20,000 plan OOP max
    // at 25% expected use → $5,000/yr of modeled OOP that previously persisted
    // into Medicare years.
    oopMaxOverride: 20000,
    expectedOopMaxUsePercent: 0.25,
    rothConversion: { enabled: false },
    taxLossHarvesting: { enabled: false },
    taxGainHarvesting: { enabled: false },
    aca: buildAcaConfig({ taxYear: 2026, state: "Florida", householdSize: 2, marketplaceMembers: 2 })
  };
  const assets = [{ id: "cash", accountType: "taxable", assetClass: "cash", units: 2000000, price: 1, costBasisPerUnit: 1 }];
  const run = (scenario) => simulatePlan({
    assets,
    scenario,
    taxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  }).years[0];

  // Legacy proxy: 25% of the $20,000 ACA-era plan OOP max = $5,000.
  const proxyYear = run(baseScenario);
  // Explicit Medicare OOP input: $3,000 — replaces the proxy entirely.
  const explicitYear = run({ ...baseScenario, medicare: { annualOopBase: 3000 } });

  assert.equal(
    Math.round((proxyYear.medicalCost - explicitYear.medicalCost) * 100) / 100,
    5000 - 3000
  );
  // Premiums are unchanged — the input only replaces the OOP estimate.
  assert.equal(proxyYear.medicare.totalAnnualPremium, explicitYear.medicare.totalAnnualPremium);

  // Without ANY OOP input (no plan OOP, no override, no annualOopBase), the
  // legacy default models $0 post-65 OOP — the input-limited confidence flag
  // exists precisely because both legacy behaviors are wrong anchors.
  const { oopMaxOverride: _ignored, ...noOopScenario } = baseScenario;
  const zeroOopYear = run(noOopScenario);
  assert.equal(
    Math.round((zeroOopYear.medicalCost - zeroOopYear.medicare.totalAnnualPremium) * 100) / 100,
    1000
  );
});

// ─── confidence flag for the missing Medicare OOP input ─────────────────────

test("medicare-oop-inputs confidence flag fires for plans reaching Medicare years without an OOP input", () => {
  const taxProfile = buildTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly", state: "Florida" });
  const flagIds = (scenario) => buildConfidenceReport({ scenario, taxProfile }).flags.map((flag) => flag.id);

  // 60-year-old with a 10-year plan crosses 65 → flag.
  assert.ok(flagIds({ currentAge: 60, planYears: 10, state: "Florida", aca: { enabled: true }, medicare: {} })
    .includes("medicare-oop-inputs"));

  // Entered OOP estimate → no flag.
  assert.ok(!flagIds({ currentAge: 60, planYears: 10, state: "Florida", aca: { enabled: true }, medicare: { annualOopBase: 4000 } })
    .includes("medicare-oop-inputs"));

  // Plan ends before 65 → no flag.
  assert.ok(!flagIds({ currentAge: 40, planYears: 10, state: "Florida", aca: { enabled: true }, medicare: {} })
    .includes("medicare-oop-inputs"));

  // IRMAA disabled (Medicare modeling off) → no flag.
  assert.ok(!flagIds({ currentAge: 60, planYears: 10, state: "Florida", aca: { enabled: true }, medicare: { irmaaEnabled: false } })
    .includes("medicare-oop-inputs"));
});
