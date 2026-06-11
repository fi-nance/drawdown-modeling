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

test("SBM-PUF states resolve offline through the main rate-derived path with no fallback", () => {
  // Phase 4: these values are the CMS SBM QHP PUF filed rates, not the old
  // hand-maintained estimates.
  // California Los Angeles (90012 → CA-16 via the GRA zip3 split).
  const ca = slcspMonthlyFor({ zip: "90012", age: 40 });
  assert.equal(ca.fallback, null);
  assert.equal(ca.ratingArea.state, "CA");
  assert.equal(ca.ratingArea.areaCode, 16);
  assert.equal(ca.ratingArea.methodology, "zip3");
  assert.equal(ca.monthlyPremium, 459.46); // Covered CA filed age-40 SLCSP
  assert.match(ca.sources.slcsp, /State-Based Marketplace/);

  // New York NYC (10001 → NY-4 per the CMS GRA federal-systems numbering).
  const ny = slcspMonthlyFor({ zip: "10001", age: 40 });
  assert.equal(ny.fallback, null);
  assert.equal(ny.ratingArea.state, "NY");
  assert.equal(ny.ratingArea.areaCode, 4);
  assert.equal(ny.monthlyPremium, 585.20); // flat community premium

  // Washington Snohomish (98201 → WA-8) — a COUNTY-level benchmark: the
  // county's available silver plan set differs from its rating area's.
  const wa = slcspMonthlyFor({ zip: "98201", age: 40 });
  assert.equal(wa.fallback, null);
  assert.equal(wa.ratingArea.state, "WA");
  assert.equal(wa.benchmarkLevel, "county");
  assert.equal(wa.monthlyPremium, 649.99);
});

test("NY and VT apply flat community rating (no age penalization)", () => {
  // NY NYC (10001) - age 21 vs age 60: identical filed rates at every adult age.
  const ny21 = slcspMonthlyFor({ zip: "10001", age: 21 });
  const ny60 = slcspMonthlyFor({ zip: "10001", age: 60 });
  assert.equal(ny21.monthlyPremium, 585.20);
  assert.equal(ny60.monthlyPremium, 585.20);
  assert.equal(ny21.ageRatingFactorTotal, 1);
  assert.equal(ny60.ageRatingFactorTotal, 1);

  // VT Burlington (05401) - age 21 vs age 64. VT files family-tier rates; the
  // adult schedule is the flat INDIVIDUAL RATE and children carry the
  // tier-derived marginal dependent cost (P+1-dependent minus individual).
  const vt21 = slcspMonthlyFor({ zip: "05401", age: 21 });
  const vt64 = slcspMonthlyFor({ zip: "05401", age: 64 });
  assert.equal(vt21.monthlyPremium, 1298.94);
  assert.equal(vt64.monthlyPremium, 1298.94);
  const vtChild = slcspMonthlyFor({ zip: "05401", age: 10 });
  assert.equal(vtChild.monthlyPremium, 1208.01);
  assert.ok(vtChild.monthlyPremium < vt21.monthlyPremium, "VT child rate derives from the family tiers");
});

test("age-rated SBM states (like CA) use the issuer's filed per-age rates", () => {
  // Phase 4 replaced the federal-default-curve approximation with the actual
  // filed per-age schedule from the SBM Rate PUF.
  const ca21 = slcspMonthlyFor({ zip: "90012", age: 21 });
  const ca40 = slcspMonthlyFor({ zip: "90012", age: 40 });
  const ca60 = slcspMonthlyFor({ zip: "90012", age: 60 });
  assert.equal(ca21.monthlyPremium, 359.52);
  assert.equal(ca40.monthlyPremium, 459.46);
  assert.equal(ca60.monthlyPremium, 975.73);
  assert.ok(ca60.monthlyPremium > ca21.monthlyPremium * 2.5, "filed rates rise steeply with age");
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

test("marketplaces without any bundled table report fallback:'state' (MD)", () => {
  // Maryland published no 2026 SBM PUF and has no ZIP3 rating-area map in the
  // hand-built fallback, so it resolves to the state default. That is a
  // state-level benchmark and must be labeled honestly so the confidence
  // layer does not present it as rating-area-accurate. (MA and VT, formerly
  // in this bucket, are now fully covered by the SBM QHP PUFs.)
  const r = slcspMonthlyFor({ zip: "21201", age: 40 });
  assert.equal(r.fallback, "state", "MD should be a state fallback");
  assert.equal(r.ratingArea.areaCode, null);
  assert.equal(r.ratingArea.methodology, "state-benchmark");

  // CO also lacks a 2026 SBM PUF but retains a hand-built ZIP3 map.
  const co = slcspMonthlyFor({ zip: "80202", age: 40 });
  assert.equal(co.fallback, null);
  assert.equal(co.ratingArea.state, "CO");
  assert.equal(co.sources.slcsp, "SBE Public Rate Bulletins");
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

test("computeAca uses the SBM-PUF rating-area SLCSP offline when an SBE ZIP is supplied", () => {
  const config = buildAcaConfig({ taxYear: 2026, state: "California", householdSize: 1, marketplaceMembers: 1 });
  const withZip = computeAca({ magi: 40000, config, zip: "90012", householdAges: [40] });

  // Benchmark now reflects the Covered CA LA filed SLCSP (459.46/mo × 12),
  // not the CA state average ($570/mo × 12).
  assert.equal(withZip.benchmarkPremium, Math.round(459.46 * 12 * 1e6) / 1e6);
  assert.equal(withZip.ratingArea.state, "CA");
  assert.equal(withZip.ratingArea.areaCode, 16);
  assert.equal(withZip.ratingArea.methodology, "zip3");
  assert.equal(withZip.benchmarkFallback, null);
});
