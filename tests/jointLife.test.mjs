import assert from "node:assert/strict";
import test from "node:test";

import { simulatePlan } from "../src/core/simulation.mjs";
import { buildTaxProfile } from "../src/data/taxData.mjs";

const noTaxProfile = {
  filingStatus: "marriedFilingJointly",
  standardDeduction: 12000,
  capitalLossOrdinaryIncomeOffset: 3000,
  ordinaryBrackets: [{ upTo: Infinity, rate: 0.1 }],
  capitalGainsBrackets: [{ upTo: Infinity, rate: 0.1 }],
  state: {
    standardDeduction: 0,
    brackets: [{ upTo: Infinity, rate: 0 }],
    treatCapitalGainsAsOrdinary: true
  }
};

test("joint-life transition: year of death is still MFJ; the year AFTER death is the first Single year", () => {
  // Base MFJ standard deduction is 32200 for 2026. Single is 16100.
  const baseProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "marriedFilingJointly",
    state: "Florida"
  });

  const plan = simulatePlan({
    assets: [
      {
        id: "traditional-cash",
        accountType: "traditional",
        assetClass: "cash",
        units: 100000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 5,
      targetSpend: 10000,
      targetSpendIncludesTaxes: true,
      currentAge: 80,
      spouseAge: 80,
      primaryMortalityAge: 120, // Lives through the plan
      spouseMortalityAge: 82,    // Dies at age 82 (year index 2)
      withdrawalOrder: ["traditional"],
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: baseProfile,
    returnSequence: [{ cash: 0 }, { cash: 0 }, { cash: 0 }, { cash: 0 }, { cash: 0 }],
    inflationSequence: [0, 0, 0, 0, 0]
  });

  assert.equal(plan.years.length, 5);

  // Year 0 (Age 80, spouse 80) -> MFJ
  assert.equal(plan.years[0].filingStatus, "marriedFilingJointly");
  assert.equal(plan.years[0].taxProfileSummary.standardDeduction, 32200);

  // Year 1 (Age 81, spouse 81) -> MFJ
  assert.equal(plan.years[1].filingStatus, "marriedFilingJointly");
  assert.equal(plan.years[1].taxProfileSummary.standardDeduction, 32200);

  // Year 2 (Age 82, spouse hits mortality age 82) — year of death is still MFJ.
  assert.equal(plan.years[2].filingStatus, "marriedFilingJointly");
  assert.equal(plan.years[2].taxProfileSummary.standardDeduction, 32200);

  // Year 3 (Age 83, spouse deceased) -> first Single year
  assert.equal(plan.years[3].filingStatus, "single");
  assert.equal(plan.years[3].taxProfileSummary.standardDeduction, 16100);
});

test("surviving spouse Social Security: year of death keeps combined benefits; year after applies Math.max survivor rule", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-cash",
        accountType: "taxable",
        assetClass: "cash",
        units: 100000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 4,
      targetSpend: 0,
      currentAge: 70,
      spouseAge: 70,
      primaryMortalityAge: 120,
      spouseMortalityAge: 72, // Year of death is index 2; survivor phase begins index 3
      socialSecurityAnnualBenefit: 30000,
      socialSecurityStartAge: 62,
      socialSecurityInflationAdjusted: true,
      spouseSocialSecurityAnnualBenefit: 20000,
      spouseSocialSecurityStartAge: 62,
      spouseSocialSecurityInflationAdjusted: true,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }, { cash: 0 }, { cash: 0 }, { cash: 0 }],
    inflationSequence: [0, 0, 0, 0]
  });

  assert.equal(plan.years.length, 4);

  // Year 0, 1, 2 (year of death is still MFJ, both benefits paid) -> Combined 50000
  assert.equal(plan.years[0].socialSecurityBenefits, 50000);
  assert.equal(plan.years[1].socialSecurityBenefits, 50000);
  assert.equal(plan.years[2].socialSecurityBenefits, 50000);

  // Year 3 (survivor phase): keeps max(30000, 20000) = 30000
  assert.equal(plan.years[3].socialSecurityBenefits, 30000);
});

test("plan.years.length stays equal to planYears: post-mortality years are emitted as flagged stubs, not dropped", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-cash",
        accountType: "taxable",
        assetClass: "cash",
        units: 100000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 10,
      targetSpend: 0,
      currentAge: 80,
      spouseAge: 80,
      primaryMortalityAge: 83, // Both die at age 83 (year index 3 is year of death; index 4+ is post-mortality)
      spouseMortalityAge: 83,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: Array.from({ length: 10 }, () => ({ cash: 0 })),
    inflationSequence: Array.from({ length: 10 }, () => 0)
  });

  // Length matches planYears — no early break.
  assert.equal(plan.years.length, 10);

  // Year 3 is the year of death, still simulated.
  assert.equal(plan.years[3].postMortality, undefined);

  // Years 4–9 are post-mortality stubs.
  for (let i = 4; i < 10; i += 1) {
    assert.equal(plan.years[i].postMortality, true, `year ${i} should be post-mortality`);
    assert.equal(plan.years[i].plannedSpending, 0);
    assert.equal(plan.years[i].socialSecurityBenefits, 0);
    assert.equal(plan.years[i].taxes.total, 0);
    assert.equal(plan.years[i].filingStatus, null);
  }

  // Post-mortality years don't count as failures.
  assert.equal(plan.success, true);
});

test("heir tax drag is opt-in via user-set rates: defaults to 0 (no bracket-compression adjustment)", () => {
  const assetsSample = [
    {
      id: "traditional-cash",
      accountType: "traditional",
      assetClass: "cash",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }
  ];

  // Default: nonSpouse10Yr with NO drag set -> effective rate = base rate.
  const planNonSpouseDefault = simulatePlan({
    assets: assetsSample,
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.3,
      heirType: "nonSpouse10Yr",
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  assert.equal(planNonSpouseDefault.heirValueBreakdown.assumedOrdinaryTaxRate, 0.3);
  assert.equal(planNonSpouseDefault.heirValueBreakdown.effectiveTraditionalTaxRate, 0.3);
  assert.equal(planNonSpouseDefault.heirValueBreakdown.totalIncomeTaxEstimate, 300);

  // Opt-in: user sets nonSpouse10YrTaxDrag=0.05 -> effective rate = 0.35.
  const planNonSpouseWithDrag = simulatePlan({
    assets: assetsSample,
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.3,
      heirType: "nonSpouse10Yr",
      nonSpouse10YrTaxDrag: 0.05,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  assert.equal(planNonSpouseWithDrag.heirValueBreakdown.effectiveTraditionalTaxRate, 0.35);
  assert.equal(planNonSpouseWithDrag.heirValueBreakdown.totalIncomeTaxEstimate, 350);

  // Opt-in: user sets eligibleDesignatedTaxDiscount=0.02 -> effective rate = 0.28.
  const planStretchWithDiscount = simulatePlan({
    assets: assetsSample,
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.3,
      heirType: "eligibleDesignated",
      eligibleDesignatedTaxDiscount: 0.02,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  assert.equal(planStretchWithDiscount.heirValueBreakdown.effectiveTraditionalTaxRate, 0.28);
  assert.equal(planStretchWithDiscount.heirValueBreakdown.totalIncomeTaxEstimate, 280);

  // Spousal rollover: drag/discount inputs are ignored and inherited-account
  // income tax is deferred rather than haircut immediately.
  const planSpouseWithIgnoredDrag = simulatePlan({
    assets: assetsSample,
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.3,
      heirType: "spouse",
      nonSpouse10YrTaxDrag: 0.05,
      eligibleDesignatedTaxDiscount: 0.02,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });
  assert.equal(planSpouseWithIgnoredDrag.heirValueBreakdown.effectiveTraditionalTaxRate, 0);
  assert.equal(planSpouseWithIgnoredDrag.heirValueBreakdown.totalIncomeTaxEstimate, 0);
  assert.equal(planSpouseWithIgnoredDrag.heirValueBreakdown.spouseRolloverValue, 1000);
});

test("MFJ filing with no spouseAge does not enter the survivor branch (prevents age=null propagation)", () => {
  // Regression: previously, MFJ + no spouseAge + primary past mortality would
  // set age=null and propagate through downstream age comparisons.
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-cash",
        accountType: "taxable",
        assetClass: "cash",
        units: 100000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 5,
      targetSpend: 0,
      currentAge: 60,
      // Explicitly null out spouseAge to override DEFAULT_SCENARIO's 55. This
      // mirrors a hand-built or legacy scenario that lacks spouse data.
      spouseAge: undefined,
      primaryMortalityAge: 62, // Year of death is index 2; "both deceased" reduces to "primary deceased" without a spouse life.
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: Array.from({ length: 5 }, () => ({ cash: 0 })),
    inflationSequence: Array.from({ length: 5 }, () => 0)
  });

  assert.equal(plan.years.length, 5);

  // Years 0–2 live (year 2 = year of death), years 3–4 post-mortality.
  for (let i = 0; i <= 2; i += 1) {
    assert.equal(plan.years[i].postMortality, undefined, `year ${i} should be live`);
    assert.notEqual(plan.years[i].age, null, `year ${i} age should be finite`);
  }
  for (let i = 3; i < 5; i += 1) {
    assert.equal(plan.years[i].postMortality, true, `year ${i} should be post-mortality`);
  }
});
