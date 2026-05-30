// Golden test: Social Security benefit taxation.
//
// Primary sources:
//   - IRC §86 (taxation of Social Security benefits).
//   - IRS Publication 915, "Social Security and Equivalent Railroad
//     Retirement Benefits," Worksheet 1.
//
// The statutory thresholds are not indexed for inflation and are reflected
// in `FEDERAL_TAX_2026.socialSecurityTaxation` in `src/data/taxData.mjs`:
//
//   filing status        base       adjusted base
//   single, HoH, MFS¹    $25,000    $34,000
//   MFJ                  $32,000    $44,000
//
//   ¹ MFS living together gets 0/0 thresholds → 85% taxable.
//
// Worksheet 1 ordering, summarized:
//   Let B = total SS benefits, O = other income, P = O + B/2.
//   If P ≤ base:           taxable SS = 0
//   If base < P ≤ adjusted: taxable SS = min(B × 50%, (P − base) × 50%)
//   If P > adjusted:        taxable SS = min(B × 85%,
//                                            (adjusted − base) × 50%
//                                          + (P − adjusted) × 85%)
//   Capped at B × 85% in all cases.

import assert from "node:assert/strict";
import test from "node:test";

import { computeTaxableSocialSecurityBenefits } from "../src/core/tax.mjs";
import { buildFederalTaxProfile } from "../src/data/taxData.mjs";

const profileMfj = buildFederalTaxProfile({ taxYear: 2026, filingStatus: "marriedFilingJointly" });
const profileSingle = buildFederalTaxProfile({ taxYear: 2026, filingStatus: "single" });

test("Pub 915 worksheet: MFJ with provisional income below the $32,000 base", () => {
  // SS benefits = $20,000, other income = $15,000.
  // Provisional income = $15,000 + $10,000 = $25,000, which is below the
  // $32,000 base, so no Social Security benefits are taxable.
  const taxable = computeTaxableSocialSecurityBenefits({
    benefits: 20000,
    otherIncome: 15000,
    filingStatus: "marriedFilingJointly",
    profile: profileMfj
  });
  assert.equal(taxable, 0);
});

test("Pub 915 worksheet: MFJ in the 50% band between base and adjusted base", () => {
  // SS benefits = $20,000, other income = $25,000.
  // Provisional income = $25,000 + $10,000 = $35,000.
  // Base = $32,000, adjusted base = $44,000.
  // Provisional income is above the base but below the adjusted base, so the
  // taxable amount is the lesser of:
  //   (a) 50% of benefits = $10,000
  //   (b) 50% of (provisional − base) = 50% × $3,000 = $1,500
  // → $1,500 taxable.
  const taxable = computeTaxableSocialSecurityBenefits({
    benefits: 20000,
    otherIncome: 25000,
    filingStatus: "marriedFilingJointly",
    profile: profileMfj
  });
  assert.equal(taxable, 1500);
});

test("Pub 915 worksheet: MFJ over the $44,000 adjusted base", () => {
  // SS benefits = $20,000, other income = $35,000.
  // Provisional income = $35,000 + $10,000 = $45,000.
  // Base = $32,000, adjusted base = $44,000.
  // Lower-band contribution = 50% × ($44,000 − $32,000) = $6,000.
  // Upper-band contribution = 85% × ($45,000 − $44,000) = $850.
  // Total = $6,850, capped at 85% × $20,000 = $17,000 → $6,850 taxable.
  const taxable = computeTaxableSocialSecurityBenefits({
    benefits: 20000,
    otherIncome: 35000,
    filingStatus: "marriedFilingJointly",
    profile: profileMfj
  });
  assert.equal(taxable, 6850);
});

test("Pub 915 worksheet: single filer hits the 85% cap at high other income", () => {
  // SS benefits = $20,000, other income = $100,000.
  // Provisional income = $100,000 + $10,000 = $110,000.
  // Single base = $25,000, adjusted base = $34,000.
  // Lower-band contribution = 50% × ($34,000 − $25,000) = $4,500.
  // Upper-band contribution = 85% × ($110,000 − $34,000) = $64,600.
  // Sum = $69,100, capped at 85% × $20,000 = $17,000 → $17,000 taxable.
  const taxable = computeTaxableSocialSecurityBenefits({
    benefits: 20000,
    otherIncome: 100000,
    filingStatus: "single",
    profile: profileSingle
  });
  assert.equal(taxable, 17000);
});

test("IRC §86(c)(1)(C): MFS living together with spouse uses 85% with no thresholds", () => {
  // Married filing separately and lived with spouse at any time during the
  // year → 85% of benefits are taxable regardless of provisional income.
  const taxable = computeTaxableSocialSecurityBenefits({
    benefits: 20000,
    otherIncome: 0,
    filingStatus: "marriedFilingSeparately",
    marriedFilingSeparatelyLivedTogether: true
  });
  assert.equal(taxable, 17000);
});
