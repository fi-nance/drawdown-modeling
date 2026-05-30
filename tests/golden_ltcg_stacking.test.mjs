// Golden test: long-term capital gains stacking under 2026 federal law.
//
// Primary sources:
//   - IRC §1(h) (maximum capital gains rates).
//   - IRS Rev. Proc. 2025-32 (2026 inflation adjustments): cited in
//     `src/data/taxData.mjs` FEDERAL_TAX_2026.source. Provides the 2026
//     ordinary brackets, standard deduction, and the LTCG breakpoints
//     ($98,900 / $613,700 MFJ; $49,450 / $545,500 single).
//   - 1040 Instructions, Qualified Dividends and Capital Gain Tax Worksheet
//     (the "stacking" worksheet that fills empty room in the 0% bracket
//     before taxing the rest at 15% / 20%).
//
// The model under test is `computeIncomeTax` in `src/core/tax.mjs`. It
// applies the standard deduction to ordinary income first, then stacks
// LTCG + qualified dividends on top.
//
// MFJ 2026 anchors used below:
//   standard deduction  $32,200
//   ordinary brackets   10/12/22/24/32/35/37 at
//                       $24,800 / $100,800 / $211,400 / $403,550 / $512,450 / $768,700
//   LTCG breakpoints    0% to $98,900, 15% to $613,700, 20% above

import assert from "node:assert/strict";
import test from "node:test";

import { computeIncomeTax } from "../src/core/tax.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

// Florida has no state income tax, so federalOrdinaryTax +
// federalPreferentialTax = totalTax. Use it to isolate the federal LTCG
// math.
function federalProfile() {
  return buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida"
  });
}

test("Rev. Proc. 2025-32: MFJ 2026 standard deduction is $32,200", () => {
  const profile = federalProfile();
  assert.equal(profile.standardDeduction, 32200);
});

test("IRC §1(h): all LTCG in the 0% bracket when stacked income stays below $98,900 (MFJ)", () => {
  // Ordinary $50,000 + LTCG $30,000, MFJ.
  //   Taxable ordinary = $50,000 − $32,200 = $17,800
  //   Ordinary tax: $17,800 × 10% = $1,780 (all inside the 10% bracket up
  //     to $24,800).
  //   Stacking: ordinary fills $0–$17,800, LTCG fills $17,800–$47,800,
  //     entirely below the $98,900 0%-bracket ceiling, so 0% applies to
  //     all $30,000.
  const tax = computeIncomeTax({
    ordinaryIncome: 50000,
    longTermCapitalGains: 30000,
    profile: federalProfile()
  });

  assert.equal(tax.federalOrdinaryTax, 1780);
  assert.equal(tax.federalPreferentialTax, 0);
  assert.equal(tax.federalIncomeTax, 1780);
});

test("IRC §1(h): LTCG split between 0% and 15% brackets at the $98,900 boundary (MFJ)", () => {
  // Ordinary $90,000 + LTCG $50,000, MFJ.
  //   Taxable ordinary = $90,000 − $32,200 = $57,800
  //   Ordinary tax:
  //     $24,800 × 10% = $2,480
  //     ($57,800 − $24,800) × 12% = $33,000 × 12% = $3,960
  //     Total ordinary tax = $6,440
  //   Stacking: ordinary $0–$57,800, LTCG starts at $57,800.
  //     0% room remaining = $98,900 − $57,800 = $41,100
  //     LTCG at 0% = $41,100
  //     LTCG at 15% = $50,000 − $41,100 = $8,900
  //     LTCG tax = $8,900 × 15% = $1,335
  //   Federal income tax = $6,440 + $1,335 = $7,775
  const tax = computeIncomeTax({
    ordinaryIncome: 90000,
    longTermCapitalGains: 50000,
    profile: federalProfile()
  });

  assert.equal(tax.federalOrdinaryTax, 6440);
  assert.equal(tax.federalPreferentialTax, 1335);
  assert.equal(tax.federalIncomeTax, 7775);
});

test("IRC §1(h): all LTCG in the 15% bracket when ordinary income exceeds the 0% ceiling (MFJ)", () => {
  // Ordinary $150,000 + LTCG $50,000, MFJ.
  //   Taxable ordinary = $150,000 − $32,200 = $117,800
  //   Ordinary tax:
  //     $24,800 × 10% = $2,480
  //     ($100,800 − $24,800) × 12% = $76,000 × 12% = $9,120
  //     ($117,800 − $100,800) × 22% = $17,000 × 22% = $3,740
  //     Total ordinary tax = $15,340
  //   Stacking: ordinary already exceeds $98,900, so all $50,000 of LTCG
  //     is in the 15% bracket (still well under $613,700).
  //     LTCG tax = $50,000 × 15% = $7,500
  //   Federal income tax = $15,340 + $7,500 = $22,840
  const tax = computeIncomeTax({
    ordinaryIncome: 150000,
    longTermCapitalGains: 50000,
    profile: federalProfile()
  });

  assert.equal(tax.federalOrdinaryTax, 15340);
  assert.equal(tax.federalPreferentialTax, 7500);
  assert.equal(tax.federalIncomeTax, 22840);
});

test("IRC §1(h): qualified dividends share the LTCG rate schedule (MFJ)", () => {
  // Qualified dividends stack with LTCG above ordinary income. The model
  // treats them as preferential income, and the IRS Qualified Dividends
  // and Capital Gain Tax Worksheet does the same.
  //
  // Ordinary $30,000 + LTCG $20,000 + QDI $10,000, MFJ.
  //   Taxable ordinary = $30,000 − $32,200 = $0; $2,200 of unused
  //     deduction spills over to reduce preferential income.
  //   Taxable preferential = $20,000 + $10,000 − $2,200 = $27,800
  //   Federal ordinary tax = $0
  //   Stacking: ordinary $0, preferential fills $0–$27,800, all below the
  //     $98,900 0% ceiling → 0% on all of it.
  const tax = computeIncomeTax({
    ordinaryIncome: 30000,
    longTermCapitalGains: 20000,
    qualifiedDividends: 10000,
    profile: federalProfile()
  });

  assert.equal(tax.federalOrdinaryTax, 0);
  assert.equal(tax.federalPreferentialTax, 0);
  assert.equal(tax.federalIncomeTax, 0);
});
