// Tests for the offline State-Based Exchange (SBE) rating area resolver and its computeAca shim.
//
// Coverage targets (Engineering lens, docs/REVIEW_BAR.md):
//   - SBE states resolve to a rating-area SLCSP offline with no fallback (CA, NY, WA, CO, PA, NJ).
//   - New York (NY) and Vermont (VT) apply flat community rating (no age penalty).
//   - Standard SBE states (CA, CO, WA) apply standard federal age curve rating.
//   - Household aggregation applies the ACA under-21 child cap.
//   - The computeAca shim swaps in the SBE rating-area benchmark when given an SBE ZIP.

import assert from "node:assert/strict";
import test from "node:test";

import {
  slcspMonthlyFor,
  ACA_RATING_AREA_DATA_VERSION
} from "../src/data/acaRatingArea.mjs";
import { isSbeState, sbeSlcspMonthlyFor, SBE_COVERED_STATES } from "../src/data/sbeRatingArea.mjs";
import { acaAgeRatingFactor } from "../src/core/aca.mjs";
import { computeAca, benchmarkPremiumForZip } from "../src/core/aca.mjs";
import { buildAcaConfig } from "../src/data/taxData.mjs";

test("isSbeState correctly flags SBE and FFM states", () => {
  assert.equal(isSbeState("CA"), true);
  assert.equal(isSbeState("NY"), true);
  assert.equal(isSbeState("WA"), true);
  assert.equal(isSbeState("VT"), true);
  assert.equal(isSbeState("FL"), false);
  assert.equal(isSbeState("TX"), false);
  assert.equal(isSbeState("NC"), false);
});

test("SBE ZIPs resolve offline to SBE rating-area SLCSPs with no fallback", () => {
  // California Los Angeles (90012 -> CA-15)
  const ca = slcspMonthlyFor({ zip: "90012", age: 40 });
  assert.equal(ca.fallback, null);
  assert.equal(ca.ratingArea.state, "CA");
  assert.equal(ca.ratingArea.areaCode, 15);
  assert.equal(ca.ratingArea.source, "SBE Rating Area Mapping");
  assert.equal(ca.monthlyPremium, 515.00); // 2026 LA SLCSP at age 40

  // New York NYC (10001 -> NY-6)
  const ny = slcspMonthlyFor({ zip: "10001", age: 40 });
  assert.equal(ny.fallback, null);
  assert.equal(ny.ratingArea.state, "NY");
  assert.equal(ny.ratingArea.areaCode, 6);
  assert.equal(ny.monthlyPremium, 835.00); // flat community premium

  // Washington Snohomish (98201 -> WA-4)
  const wa = slcspMonthlyFor({ zip: "98201", age: 40 });
  assert.equal(wa.fallback, null);
  assert.equal(wa.ratingArea.state, "WA");
  assert.equal(wa.ratingArea.areaCode, 4);
  assert.equal(wa.monthlyPremium, 595.00);
});

test("NY and VT apply flat community rating (no age penalization)", () => {
  // NY NYC (10001) - age 21 vs age 60
  const ny21 = slcspMonthlyFor({ zip: "10001", age: 21 });
  const ny60 = slcspMonthlyFor({ zip: "10001", age: 60 });
  assert.equal(ny21.monthlyPremium, 835.00);
  assert.equal(ny60.monthlyPremium, 835.00);
  assert.equal(ny21.ageRatingFactorTotal, 1);
  assert.equal(ny60.ageRatingFactorTotal, 1);

  // VT Burlington (05401) - age 21 vs age 64
  const vt21 = slcspMonthlyFor({ zip: "05401", age: 21 });
  const vt64 = slcspMonthlyFor({ zip: "05401", age: 64 });
  assert.equal(vt21.monthlyPremium, 1299.00);
  assert.equal(vt64.monthlyPremium, 1299.00);
});

test("Standard SBE states (like CA) apply standard federal age curve", () => {
  // CA (90012) at age 40 is $515.
  // Age 40 factor is 1.278. Age 21 factor is 1.0.
  // base21 = 515 / 1.278 ≈ 402.97
  const ca21 = slcspMonthlyFor({ zip: "90012", age: 21 });
  assert.equal(ca21.monthlyPremium, Math.round((515 / 1.278) * 100) / 100);

  // Age 60 factor is 2.714.
  // premium at 60 = base21 * 2.714 ≈ 402.97 * 2.714 ≈ 1093.67
  const ca60 = slcspMonthlyFor({ zip: "90012", age: 60 });
  assert.ok(ca60.monthlyPremium > ca21.monthlyPremium * 2.5);
  assert.equal(ca60.monthlyPremium, Math.round(( (515 / 1.278) * 2.714 ) * 100) / 100);
});

test("SBE multi-member household sums individual premiums and obeys minors cap", () => {
  const ca40 = slcspMonthlyFor({ zip: "90012", age: 40 }).monthlyPremium;
  const ca45 = slcspMonthlyFor({ zip: "90012", age: 45 }).monthlyPremium;
  const caCouple = slcspMonthlyFor({ zip: "90012", householdAges: [40, 45] });
  assert.equal(caCouple.monthlyPremium, Math.round((ca40 + ca45) * 100) / 100);

  // Minors child cap (only 3 oldest counted)
  const fiveKids = slcspMonthlyFor({ zip: "90012", householdAges: [40, 45, 10, 8, 6, 4, 2] });
  const threeKids = slcspMonthlyFor({ zip: "90012", householdAges: [40, 45, 10, 8, 6] });
  assert.equal(fiveKids.monthlyPremium, threeKids.monthlyPremium);
});

test("community-rated states do not charge children the full adult flat rate", () => {
  // NY (community rated): two adults + one child. Adults pay the flat reference;
  // the child falls in the under-21 band (factor < 1), so the family premium is
  // strictly less than 3x the adult rate.
  const adult = sbeSlcspMonthlyFor({ state: "NY", zip: "10001", age: 40 }).monthlyPremium;
  const family = sbeSlcspMonthlyFor({ state: "NY", zip: "10001", householdAges: [40, 40, 10] });
  assert.ok(family.monthlyPremium < adult * 3, "child should not be charged the full adult community rate");
  const childFactor = acaAgeRatingFactor(10);
  assert.equal(family.monthlyPremium, Math.round(adult * (2 + childFactor) * 100) / 100);
  assert.equal(family.ageRatingFactorTotal, Math.round((2 + childFactor) * 1e6) / 1e6);
});

test("default-only SBE states report fallback:'state' rather than a phantom rating area", () => {
  // MA / VT have no ZIP3 rating-area map, so they resolve to the state default.
  // That is a state-level benchmark and must be labeled honestly so the
  // confidence layer does not present it as rating-area-accurate.
  for (const zip of ["02139", "05401"]) {
    const r = slcspMonthlyFor({ zip, age: 40 });
    assert.equal(r.fallback, "state", `${zip} should be a state fallback`);
    assert.equal(r.ratingArea.areaCode, null);
    assert.equal(r.ratingArea.methodology, "state-benchmark");
  }
});

test("every covered SBE state has a bundled rate table (no California impersonation)", () => {
  // Parity guard: isSbeState() and the rate table must agree, otherwise the old
  // `|| ...CA` fallback would silently charge an unconfigured state CA premiums.
  // The fixed code throws instead; this proves no covered state hits that path.
  for (const state of SBE_COVERED_STATES) {
    const r = sbeSlcspMonthlyFor({ state, zip: "00000", age: 40 });
    assert.ok(Number.isFinite(r.monthlyPremium) && r.monthlyPremium > 0, `${state} must resolve a premium`);
    assert.equal(r.ratingArea.state, state);
  }
});

test("sbeSlcspMonthlyFor throws for a state with no bundled rate table", () => {
  assert.throws(() => sbeSlcspMonthlyFor({ state: "ZZ", zip: "00000", age: 40 }), /no bundled SBE rate table/);
});

test("computeAca uses the SBE rating-area SLCSP offline when SBE ZIP is supplied", () => {
  const config = buildAcaConfig({ taxYear: 2026, state: "California", householdSize: 1, marketplaceMembers: 1 });
  const withZip = computeAca({ magi: 40000, config, zip: "90012", householdAges: [40] });

  // Benchmark now reflects Covered CA LA rating area (515.00/mo × 12), not the CA average ($570/mo × 12)
  assert.equal(withZip.benchmarkPremium, 515.00 * 12);
  assert.equal(withZip.ratingArea.state, "CA");
  assert.equal(withZip.ratingArea.areaCode, 15);
  assert.equal(withZip.ratingArea.methodology, "zip3");
  assert.equal(withZip.benchmarkFallback, null);
});
