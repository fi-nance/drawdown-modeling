// Tests for the offline rating-area SLCSP resolver and its computeAca shim.
//
// Coverage targets (Engineering lens, docs/REVIEW_BAR.md):
//   - Federal-platform states resolve to a rating-area SLCSP (FL, TX, NC).
//   - State-based-exchange states fall back to the state benchmark (CA, NY, MA, CO).
//   - Multi-county ZIPs pick the highest-land-area primary county.
//   - Military / territory / unknown ZIPs are out-of-model (no marketplace).
//   - ZIP-based rating-area states (AK) resolve via 3-digit ZIP.
//   - Household aggregation applies the ACA under-21 child cap.
//   - The computeAca shim swaps in the rating-area benchmark when given a ZIP.

import assert from "node:assert/strict";
import test from "node:test";

import {
  slcspMonthlyFor,
  ACA_RATING_AREA_DATA_SOURCES,
  ACA_RATING_AREA_DATA_VERSION
} from "../src/data/acaRatingArea.mjs";
import {
  ACA_SLCSP_BY_RATING_AREA_2026,
  ACA_SLCSP_COVERED_STATES
} from "../src/data/acaRatingArea2026.generated.mjs";
import { computeAca, benchmarkPremiumForZip } from "../src/core/aca.mjs";
import { buildAcaConfig } from "../src/data/taxData.mjs";

// ─── federal-platform rating-area resolution ────────────────────────────────

test("federal-platform ZIPs resolve to a rating-area SLCSP (no fallback)", () => {
  const fl = slcspMonthlyFor({ zip: "33101", age: 40 });
  assert.equal(fl.fallback, null);
  assert.equal(fl.ratingArea.state, "FL");
  assert.equal(fl.ratingArea.areaCode, 43);
  assert.equal(fl.ratingArea.methodology, "county");

  const tx = slcspMonthlyFor({ zip: "77002", age: 40 });
  assert.equal(tx.fallback, null);
  assert.equal(tx.ratingArea.areaCode, 10);

  const nc = slcspMonthlyFor({ zip: "27601", age: 40 });
  assert.equal(nc.fallback, null);
  assert.equal(nc.ratingArea.areaCode, 13);
});

test("ZIP-based rating-area states resolve via 3-digit ZIP (Alaska)", () => {
  const ak = slcspMonthlyFor({ zip: "99501", age: 55 }); // Anchorage, 995 → AK-1
  assert.equal(ak.fallback, null);
  assert.equal(ak.ratingArea.state, "AK");
  assert.equal(ak.ratingArea.areaCode, 1);
  assert.equal(ak.ratingArea.methodology, "zip3");
  assert.equal(ak.countyFips, null); // county is not used for ZIP-based states
});

test("multi-county ZIP picks the highest-land-area primary county", () => {
  // ZIP 32024 spans Columbia (12023, ~307M m² land) and Suwannee (12121, ~70M);
  // Columbia wins, mapping to FL rating area 12.
  const r = slcspMonthlyFor({ zip: "32024", age: 40 });
  assert.equal(r.fallback, null);
  assert.equal(r.countyFips, "12023");
  assert.equal(r.ratingArea.areaCode, 12);
});

// ─── fallbacks ───────────────────────────────────────────────────────────────

test("state-based-exchange states not in SBE database fall back to the state-level benchmark", () => {
  for (const [zip, state] of [["60601", "IL"], ["30301", "GA"]]) {
    const r = slcspMonthlyFor({ zip, age: 40 });
    assert.equal(r.fallback, "state", `${state} should be a state fallback`);
    assert.equal(r.ratingArea.state, state);
    assert.equal(r.ratingArea.areaCode, null);
    assert.equal(r.ratingArea.methodology, "state-benchmark");
    assert.ok(r.monthlyPremium > 0);
  }
});

test("territory and military ZIPs are out-of-model (no marketplace)", () => {
  const pr = slcspMonthlyFor({ zip: "00901", age: 45 }); // San Juan, PR
  assert.equal(pr.fallback, "out-of-model");
  assert.equal(pr.monthlyPremium, null);
  assert.equal(pr.ratingArea, null);

  const gu = slcspMonthlyFor({ zip: "96910", age: 45 }); // Guam
  assert.equal(gu.fallback, "out-of-model");

  const apo = slcspMonthlyFor({ zip: "09001", age: 45 }); // APO Europe
  assert.equal(apo.fallback, "out-of-model");
  assert.equal(apo.fallbackReason, "military");
});

test("unrecognizable ZIPs are out-of-model", () => {
  const r = slcspMonthlyFor({ zip: "ABCDE", age: 40 });
  assert.equal(r.fallback, "out-of-model");
  assert.equal(r.monthlyPremium, null);
});

// ─── household composition ─────────────────────────────────────────────────

test("household premium sums per-member SLCSP across ages", () => {
  const single = slcspMonthlyFor({ zip: "77002", age: 60 }).monthlyPremium;
  const single40 = slcspMonthlyFor({ zip: "77002", age: 40 }).monthlyPremium;
  const couple = slcspMonthlyFor({ zip: "77002", householdAges: [60, 40] });
  assert.equal(couple.monthlyPremium, single + single40);
});

test("ACA under-21 child cap counts only the three oldest children", () => {
  // Four children → the 4th (youngest) is not counted in the benchmark.
  const fourKids = slcspMonthlyFor({ zip: "27601", householdAges: [45, 43, 10, 8, 6, 4] });
  const threeKids = slcspMonthlyFor({ zip: "27601", householdAges: [45, 43, 10, 8, 6] });
  assert.equal(fourKids.monthlyPremium, threeKids.monthlyPremium);
  // Adding a fifth adult, by contrast, does change the total.
  const withAdult = slcspMonthlyFor({ zip: "27601", householdAges: [45, 43, 10, 8, 6, 25] });
  assert.ok(withAdult.monthlyPremium > threeKids.monthlyPremium);
});

test("householdComposition adults/children arrays feed member ages", () => {
  const viaComposition = slcspMonthlyFor({ zip: "77002", householdComposition: { adults: [60], children: [40] } });
  const viaAges = slcspMonthlyFor({ zip: "77002", householdAges: [60, 40] });
  assert.equal(viaComposition.monthlyPremium, viaAges.monthlyPremium);
});

test("ageRatingFactorTotal is consistent with the per-member premiums", () => {
  const r = slcspMonthlyFor({ zip: "33101", householdAges: [60, 45] });
  // monthlyPremium ≈ referenceMonthlyPremium (age-21) × ageRatingFactorTotal
  assert.ok(Math.abs(r.monthlyPremium - r.referenceMonthlyPremium * r.ageRatingFactorTotal) < 0.05);
});

test("throws when no usable age is supplied", () => {
  assert.throws(() => slcspMonthlyFor({ zip: "33101" }), /requires/);
});

test("Medicare-eligible (65+) members are excluded from the marketplace premium", () => {
  // A 65+ member is NOT clamped to the age-64 rate — they leave the
  // marketplace for Medicare, so charging them an ACA premium would
  // double-count against the simulator's Part B/D billing.
  const at64 = slcspMonthlyFor({ zip: "33101", age: 64 });
  assert.ok(at64.monthlyPremium > 0);
  assert.equal(at64.medicareExcludedMemberCount, 0);

  const at70 = slcspMonthlyFor({ zip: "33101", age: 70 });
  assert.equal(at70.monthlyPremium, 0);
  assert.equal(at70.medicareExcludedMemberCount, 1);

  // Mixed-age couple: only the under-65 member is priced.
  const couple = slcspMonthlyFor({ zip: "33101", householdAges: [62, 70] });
  const aloneAt62 = slcspMonthlyFor({ zip: "33101", age: 62 });
  assert.equal(couple.monthlyPremium, aloneAt62.monthlyPremium);
  assert.equal(couple.medicareExcludedMemberCount, 1);

  // All-65+ household: zero marketplace premium, no throw.
  const bothOnMedicare = slcspMonthlyFor({ zip: "33101", householdAges: [70, 68] });
  assert.equal(bothOnMedicare.monthlyPremium, 0);
  assert.equal(bothOnMedicare.medicareExcludedMemberCount, 2);
  assert.equal(bothOnMedicare.fallback, null);
});

// ─── data integrity ──────────────────────────────────────────────────────────

test("covered states are the federal-platform set and exclude state-based exchanges", () => {
  assert.equal(ACA_SLCSP_COVERED_STATES.length, 30);
  for (const sbm of ["CA", "NY", "MA", "CO", "WA", "CT", "DC", "ID", "PA", "VA", "IL", "GA"]) {
    assert.ok(!ACA_SLCSP_COVERED_STATES.includes(sbm), `${sbm} should not be in the bundled set`);
  }
  for (const fed of ["FL", "TX", "NC", "AZ", "AK", "OH"]) {
    assert.ok(ACA_SLCSP_COVERED_STATES.includes(fed), `${fed} should be bundled`);
  }
});

test("every SLCSP entry has a full 0..64 age schedule and a plan id", () => {
  let entries = 0;
  const seenStates = new Set();
  for (const [key, v] of Object.entries(ACA_SLCSP_BY_RATING_AREA_2026)) {
    entries++;
    seenStates.add(key.split("-")[0]);
    assert.equal(v.a.length, 65, `${key} should have 65 age points`);
    assert.ok(typeof v.p === "string" && v.p.length >= 14, `${key} should name an SLCSP plan`);
    assert.ok(v.a[21] > 0 && v.a[64] > v.a[21], `${key} premiums should rise with age`);
  }
  assert.ok(entries >= 300, "expected the full federal-platform rating-area set");
  // Every covered state contributes at least one rating area.
  for (const st of ACA_SLCSP_COVERED_STATES) {
    assert.ok(seenStates.has(st), `${st} should have at least one rating area`);
  }
});

test("data sources are well-formed for the coverage test", () => {
  assert.equal(ACA_RATING_AREA_DATA_VERSION, "2026.1");
  assert.equal(ACA_RATING_AREA_DATA_SOURCES.length, 3);
  for (const s of ACA_RATING_AREA_DATA_SOURCES) {
    assert.ok(typeof s.name === "string" && s.name.length > 0);
    assert.ok(/^https?:\/\//.test(s.url));
  }
});

// ─── computeAca shim ─────────────────────────────────────────────────────────

test("benchmarkPremiumForZip returns the annual household benchmark + metadata", () => {
  const b = benchmarkPremiumForZip({ zip: "33101", age: 40 });
  assert.equal(b.monthlyBenchmarkPremium, 684.37);
  assert.equal(b.annualBenchmarkPremium, 684.37 * 12);
  assert.equal(b.ratingArea.areaCode, 43);
  assert.equal(b.fallback, null);
});

test("computeAca uses the rating-area SLCSP when given a ZIP", () => {
  const config = buildAcaConfig({ taxYear: 2026, state: "Florida", householdSize: 1, marketplaceMembers: 1 });
  const withZip = computeAca({ magi: 40000, config, zip: "33101", householdAges: [40] });
  // Benchmark now reflects Miami-Dade SLCSP (684.37/mo × 12), not the FL average.
  assert.equal(withZip.benchmarkPremium, 684.37 * 12);
  assert.equal(withZip.ratingArea.areaCode, 43);
  assert.equal(withZip.benchmarkFallback, null);

  // Without a ZIP, behavior is unchanged (state-level benchmark).
  const withoutZip = computeAca({ magi: 40000, config });
  assert.equal(withoutZip.ratingArea, null);
  assert.notEqual(withoutZip.benchmarkPremium, withZip.benchmarkPremium);
});

test("computeAca falls through to the state path for state-based-exchange ZIPs not in database", () => {
  const config = buildAcaConfig({ taxYear: 2026, state: "Illinois", householdSize: 1, marketplaceMembers: 1 });
  const r = computeAca({ magi: 40000, config, zip: "60601", householdAges: [40] });
  assert.equal(r.benchmarkFallback, "state");
  assert.equal(r.ratingArea.methodology, "state-benchmark");
});
