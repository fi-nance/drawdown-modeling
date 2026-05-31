// Golden test: rating-area-level Second Lowest Cost Silver Plan (SLCSP).
//
// Primary sources
//   - CMS Marketplace Rate PUF, plan year 2026 (per-age silver premiums by
//     rating area). https://www.cms.gov/marketplace/resources/data/public-use-files
//   - CMS Marketplace Plan Attributes PUF, plan year 2026 (metal level, market,
//     on-exchange flag — used to filter to individual on-exchange silver plans).
//   - CMS state geographic rating areas, 2026 (county / 3-digit-ZIP → rating area).
//   - Census 2020 ZCTA↔county relationship file + national county FIPS list
//     (ZIP5 → primary county FIPS).
//
// Worked examples
//   SLCSP = the second-lowest IndividualRate among individual on-exchange silver
//   plans filed in a rating area. The ACA age curve is uniform across issuers in
//   a state, so the ranking is age-invariant; the values below are taken
//   directly from the Rate PUF rows for the named plans. If CMS republishes the
//   PUFs, regenerate the tables (scripts/generateAcaRatingArea.mjs) and update
//   these expectations from the new source rows.
//
//   FL Rating Area 43 (Miami-Dade), 72 silver plans:
//     lowest   30252FL0070061 "myBlue Silver 26M03-02"   age21 533.63
//     2nd/SLCSP 21525FL0020012 "Silver Simple PCP Saver"  age21 535.51  age40 684.37  age60 1453.34
//   TX Rating Area 10 (Harris/Houston), 46 silver plans:
//     SLCSP    87226TX0100011 "Standard Silver VALUE"     age21 463.27  age40 592.05  age60 1257.29
//   NC Rating Area 13 (Wake/Raleigh), 16 silver plans:
//     SLCSP    11512NC0390025 "Blue Home Silver Standard" age21 462.25  age40 590.76  age60 1254.55
//   AZ Rating Area 4, 30 silver plans:
//     SLCSP    85533AZ0020001 "Imperial Preferred Silver" age21 378.64  age40 483.90  age60 1027.64

import assert from "node:assert/strict";
import test from "node:test";

import { ACA_SLCSP_BY_RATING_AREA_2026 } from "../src/data/acaRatingArea2026.generated.mjs";
import { slcspMonthlyFor } from "../src/data/acaRatingArea.mjs";

const CASES = [
  { key: "FL-43", plan: "21525FL0020012", lo: "30252FL0070061", a21: 535.51, a40: 684.37, a60: 1453.34 },
  { key: "TX-10", plan: "87226TX0100011", a21: 463.27, a40: 592.05, a60: 1257.29 },
  { key: "NC-13", plan: "11512NC0390025", a21: 462.25, a40: 590.76, a60: 1254.55 },
  { key: "AZ-4", plan: "85533AZ0020001", a21: 378.64, a40: 483.90, a60: 1027.64 }
];

test("SLCSP table matches the Rate PUF worked examples", () => {
  for (const c of CASES) {
    const entry = ACA_SLCSP_BY_RATING_AREA_2026[c.key];
    assert.ok(entry, `${c.key} should be present in the SLCSP table`);
    assert.equal(entry.p, c.plan, `${c.key} SLCSP plan id`);
    if (c.lo) assert.equal(entry.lo, c.lo, `${c.key} lowest plan id`);
    assert.equal(entry.a[21], c.a21, `${c.key} SLCSP age-21 premium`);
    assert.equal(entry.a[40], c.a40, `${c.key} SLCSP age-40 premium`);
    assert.equal(entry.a[60], c.a60, `${c.key} SLCSP age-60 premium`);
  }
});

test("federal age-rating curve is recoverable from the filed silver rates (adult ages)", () => {
  // 26 CFR §147.102 default age curve: age-40 factor 1.278, age-60 factor 2.714,
  // both relative to age 21. The Rate PUF stores cent-rounded rates, so allow a
  // small rounding tolerance.
  for (const c of CASES) {
    const a = ACA_SLCSP_BY_RATING_AREA_2026[c.key].a;
    assert.ok(Math.abs(a[40] / a[21] - 1.278) < 0.001, `${c.key} age40/age21 ≈ 1.278`);
    assert.ok(Math.abs(a[60] / a[21] - 2.714) < 0.001, `${c.key} age60/age21 ≈ 2.714`);
  }
});

test("Healthcare.gov cross-check ZIPs resolve to the worked-example benchmark", () => {
  // Each ZIP → county FIPS → CMS rating area → SLCSP, derived offline from the
  // same Rate PUF that HealthCare.gov displays. monthlyPremium for a single
  // 40-year-old equals the SLCSP plan's age-40 filed rate.
  const miami = slcspMonthlyFor({ zip: "33101", age: 40 }); // Miami-Dade → FL-43
  assert.equal(miami.fallback, null);
  assert.equal(miami.ratingArea.state, "FL");
  assert.equal(miami.ratingArea.areaCode, 43);
  assert.equal(miami.countyFips, "12086");
  assert.equal(miami.monthlyPremium, 684.37);

  const houston = slcspMonthlyFor({ zip: "77002", age: 40 }); // Harris → TX-10
  assert.equal(houston.fallback, null);
  assert.equal(houston.ratingArea.areaCode, 10);
  assert.equal(houston.countyFips, "48201");
  assert.equal(houston.monthlyPremium, 592.05);

  const raleigh = slcspMonthlyFor({ zip: "27601", age: 40 }); // Wake → NC-13
  assert.equal(raleigh.fallback, null);
  assert.equal(raleigh.ratingArea.areaCode, 13);
  assert.equal(raleigh.countyFips, "37183");
  assert.equal(raleigh.monthlyPremium, 590.76);
});

test("household benchmark sums per-member SLCSP at each age", () => {
  // Two adults at the Houston (TX-10) rating area: 60 and 40.
  const couple = slcspMonthlyFor({ zip: "77002", householdAges: [60, 40] });
  assert.equal(couple.monthlyPremium, 1257.29 + 592.05);
  assert.equal(couple.ratingArea.areaCode, 10);
});
