// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: heirEstate. No behavior changes — pure code movement.

import { marketValue } from "../portfolio.mjs";
import { DEFAULT_TAX_PROFILE, taxFromBrackets } from "../tax.mjs?v=20260531-ssa-pia";
import { round } from "../utils.mjs";
import { DEFAULT_SCENARIO } from "./scenario.mjs";

// Federal estate tax: the 2026 exclusion is $15,000,000 per decedent. OBBBA
// (2025) made the higher TCJA exclusion permanent and set it to $15M (indexed);
// the pre-OBBBA scheduled sunset to ~$7.1M did NOT occur. 40% top rate. This is
// consistent with the OBBBA law basis documented for FEDERAL_TAX_2026. Source:
// IRS 2026 inflation adjustments incl. OBBBA — see docs/DATA_SOURCES.md.
const FEDERAL_ESTATE_EXCLUSION_2026 = 15000000;

const FEDERAL_ESTATE_TAX_RATE = 0.40;

// State inheritance tax on a LINEAL-descendant (child) heir — the relationship
// the legacy model implicitly assumes (heir defaults skew to a child). Only PA
// and NE tax lineal descendants; NJ Class A (children/grandchildren/parents),
// MD lineal descendants, and KY Class A are EXEMPT. Non-lineal heirs (siblings,
// unrelated) face higher rates that are out of model because the engine does
// not capture heir relationship class. Sources: state revenue depts — see
// docs/DATA_SOURCES.md and KNOWN_LIMITATIONS.md.
const STATE_INHERITANCE_TAX_LINEAL = Object.freeze({
  PA: 0.045,
  NE: 0.01
});

function getSingleLifeExpectancy(age) {
  const table = [
    { age: 0, le: 84.6 },
    { age: 10, le: 74.8 },
    { age: 20, le: 65.0 },
    { age: 30, le: 55.3 },
    { age: 40, le: 45.7 },
    { age: 50, le: 36.2 },
    { age: 60, le: 27.1 },
    { age: 70, le: 18.8 },
    { age: 80, le: 11.2 },
    { age: 90, le: 5.5 },
    { age: 100, le: 2.3 },
    { age: 110, le: 1.0 }
  ];
  if (age <= 0) return table[0].le;
  if (age >= 110) return 1.0;
  for (let i = 0; i < table.length - 1; i++) {
    const p1 = table[i];
    const p2 = table[i + 1];
    if (age >= p1.age && age <= p2.age) {
      const ratio = (age - p1.age) / (p2.age - p1.age);
      return p1.le + ratio * (p2.le - p1.le);
    }
  }
  return 1.0;
}

function calculateHeirOrdinaryTax(amount, baseIncome, standardDeduction, brackets) {
  const baseTaxable = Math.max(0, baseIncome - standardDeduction);
  const totalTaxable = Math.max(0, baseIncome + amount - standardDeduction);
  const baseTax = taxFromBrackets(baseTaxable, brackets);
  const totalTax = taxFromBrackets(totalTaxable, brackets);
  return Math.max(0, totalTax - baseTax);
}

export function estimateHeirValueBreakdown(portfolio, ordinaryTaxRate = 0.24, options = {}) {
  const opts = typeof options === "string" ? { heirType: options } : (options || {});
  const {
    heirType = DEFAULT_SCENARIO.heirType || "spouse",
    nonSpouse10YrTaxDrag = 0,
    eligibleDesignatedTaxDiscount = 0,
    heirBaseIncome = 80000,
    heirAge = 30
  } = opts;

  const assumedOrdinaryTaxRate = Math.max(0, Math.min(1, Number(ordinaryTaxRate) || 0));

  const drag = Math.max(-1, Math.min(1, Number(nonSpouse10YrTaxDrag) || 0));
  const discount = Math.max(-1, Math.min(1, Number(eligibleDesignatedTaxDiscount) || 0));

  // Determine state of residence from options/taxProfile
  const state = opts.state ?? opts.taxProfile?.state?.state ?? null;

  // Extract Single standard deduction and brackets
  let singleBrackets = DEFAULT_TAX_PROFILE?.ordinaryBrackets?.single;
  if (opts.taxProfile?.ordinaryBrackets) {
    if (Array.isArray(opts.taxProfile.ordinaryBrackets)) {
      singleBrackets = opts.taxProfile.ordinaryBrackets;
    } else if (opts.taxProfile.ordinaryBrackets.single) {
      singleBrackets = opts.taxProfile.ordinaryBrackets.single;
    }
  }
  if (!singleBrackets) {
    singleBrackets = [
      { upTo: 12400, rate: 0.1 },
      { upTo: 50400, rate: 0.12 },
      { upTo: 105700, rate: 0.22 },
      { upTo: 201775, rate: 0.24 },
      { upTo: 256225, rate: 0.32 },
      { upTo: 640600, rate: 0.35 },
      { upTo: Infinity, rate: 0.37 }
    ];
  }

  let singleDeduction = DEFAULT_TAX_PROFILE?.standardDeduction?.single ?? 16100;
  if (opts.taxProfile?.standardDeduction != null) {
    if (typeof opts.taxProfile.standardDeduction === "number") {
      singleDeduction = opts.taxProfile.standardDeduction;
    } else if (opts.taxProfile.standardDeduction.single != null) {
      singleDeduction = opts.taxProfile.standardDeduction.single;
    }
  }

  // Apply drag or discount to the bracket rates for the heir
  const adjustment = heirType === "nonSpouse10Yr" ? drag : (heirType === "eligibleDesignated" ? -discount : 0);
  const adjustedBrackets = singleBrackets.map(b => ({
    ...b,
    rate: Math.max(0, Math.min(1, b.rate + adjustment))
  }));

  // Group portfolio assets
  let grossValue = 0;
  let taxableValue = 0;
  let taxableUnrealizedGain = 0;
  let traditionalValue = 0;
  let rothValue = 0;
  let hsaValue = 0;
  let otherValue = 0;

  for (const asset of portfolio) {
    const value = marketValue(asset);
    grossValue += value;

    if (asset.accountType === "taxable") {
      const basis = (asset.costBasisPerUnit ?? asset.price) * (asset.units ?? 0);
      const unrealizedGain = Math.max(0, value - basis);
      taxableValue += value;
      taxableUnrealizedGain += unrealizedGain;
    } else if (asset.accountType === "traditional") {
      traditionalValue += value;
    } else if (asset.accountType === "hsa") {
      hsaValue += value;
    } else if (asset.accountType === "roth") {
      rothValue += value;
    } else {
      otherValue += value;
    }
  }

  let traditionalIncomeTaxEstimate = 0;
  let hsaIncomeTaxEstimate = 0;

  if (singleBrackets.length === 1) {
    let effectiveTraditionalTaxRate = assumedOrdinaryTaxRate;
    if (heirType === "nonSpouse10Yr") {
      effectiveTraditionalTaxRate = Math.max(0, Math.min(1, assumedOrdinaryTaxRate + drag));
    } else if (heirType === "eligibleDesignated") {
      effectiveTraditionalTaxRate = Math.max(0, Math.min(1, assumedOrdinaryTaxRate - discount));
    }
    traditionalIncomeTaxEstimate = traditionalValue * effectiveTraditionalTaxRate;
    hsaIncomeTaxEstimate = hsaValue * effectiveTraditionalTaxRate;
  } else {
    if (heirType === "spouse") {
      traditionalIncomeTaxEstimate = traditionalValue * assumedOrdinaryTaxRate;
      hsaIncomeTaxEstimate = hsaValue * assumedOrdinaryTaxRate;
    } else if (heirType === "nonSpouse10Yr") {
      const traditional10th = traditionalValue / 10;
      const year1Dist = traditional10th + hsaValue;
      const year1TaxDrag = calculateHeirOrdinaryTax(year1Dist, heirBaseIncome, singleDeduction, adjustedBrackets);
      
      if (year1Dist > 0) {
        traditionalIncomeTaxEstimate += year1TaxDrag * (traditional10th / year1Dist);
        hsaIncomeTaxEstimate += year1TaxDrag * (hsaValue / year1Dist);
      }

      const yearOtherDist = traditional10th;
      const yearOtherTaxDrag = calculateHeirOrdinaryTax(yearOtherDist, heirBaseIncome, singleDeduction, adjustedBrackets);
      traditionalIncomeTaxEstimate += 9 * yearOtherTaxDrag;
    } else if (heirType === "eligibleDesignated") {
      const expectancy = getSingleLifeExpectancy(heirAge);
      const N = Math.max(1, Math.min(30, Math.ceil(expectancy)));
      let remainingTraditional = traditionalValue;

      // Year 1 (includes HSA)
      const d1 = expectancy > 0 ? remainingTraditional / expectancy : remainingTraditional;
      const year1Dist = d1 + hsaValue;
      const year1TaxDrag = calculateHeirOrdinaryTax(year1Dist, heirBaseIncome, singleDeduction, adjustedBrackets);
      
      if (year1Dist > 0) {
        traditionalIncomeTaxEstimate += year1TaxDrag * (d1 / year1Dist);
        hsaIncomeTaxEstimate += year1TaxDrag * (hsaValue / year1Dist);
      }
      remainingTraditional = Math.max(0, remainingTraditional - d1);

      // Years 2 to N
      for (let t = 2; t <= N; t++) {
        const ft = getSingleLifeExpectancy(heirAge + t - 1);
        const dt = t === N ? remainingTraditional : (ft > 0 ? remainingTraditional / ft : remainingTraditional);
        const taxDrag = calculateHeirOrdinaryTax(dt, heirBaseIncome, singleDeduction, adjustedBrackets);
        traditionalIncomeTaxEstimate += taxDrag;
        remainingTraditional = Math.max(0, remainingTraditional - dt);
      }
    }
  }

  // Federal estate tax: 40% above the 2026 $15M exclusion. Transfers to a
  // surviving spouse are estate-tax-free under the unlimited marital deduction.
  const federalEstateTax = heirType === "spouse"
    ? 0
    : (grossValue > FEDERAL_ESTATE_EXCLUSION_2026
        ? (grossValue - FEDERAL_ESTATE_EXCLUSION_2026) * FEDERAL_ESTATE_TAX_RATE
        : 0);

  // State inheritance tax assuming a lineal-descendant (child) heir. Spouses
  // are exempt in every inheritance-tax state; among the rest, only PA (4.5%)
  // and NE (1%) tax lineal descendants — NJ and MD exempt them. Non-lineal
  // heirs face higher rates not modeled (relationship class isn't captured).
  let stateInheritanceTax = 0;
  if (heirType !== "spouse" && state) {
    const rate = STATE_INHERITANCE_TAX_LINEAL[String(state).toUpperCase()] ?? 0;
    stateInheritanceTax = grossValue * rate;
  }

  const totalIncomeTaxEstimate = traditionalIncomeTaxEstimate + hsaIncomeTaxEstimate;
  const afterTaxValue = grossValue - (totalIncomeTaxEstimate + federalEstateTax + stateInheritanceTax);
  const effectiveTraditionalTaxRate = traditionalValue > 0 ? traditionalIncomeTaxEstimate / traditionalValue : assumedOrdinaryTaxRate;

  const breakdown = {
    grossValue,
    afterTaxValue,
    assumedOrdinaryTaxRate,
    effectiveTraditionalTaxRate,
    taxableValue,
    taxableUnrealizedGain,
    taxableStepUpGainAssumed: taxableUnrealizedGain,
    traditionalValue,
    traditionalIncomeTaxEstimate,
    rothValue,
    hsaValue,
    hsaIncomeTaxEstimate,
    otherValue,
    totalIncomeTaxEstimate,
    federalEstateTax,
    stateInheritanceTax
  };

  return Object.fromEntries(
    Object.entries(breakdown).map(([key, value]) => [
      key,
      key === "assumedOrdinaryTaxRate" || key === "effectiveTraditionalTaxRate" ? round(value, 6) : round(value, 2)
    ])
  );
}
