import assert from "node:assert/strict";
import test from "node:test";

import { runMonteCarlo, simulatePlan, runHistoricalBacktests } from "../src/core/simulation.mjs";
import { buildAcaConfig, buildTaxProfile } from "../src/data/taxData.mjs";

const noTaxProfile = {
  filingStatus: "marriedFilingJointly",
  standardDeduction: 0,
  capitalLossOrdinaryIncomeOffset: 3000,
  ordinaryBrackets: [{ upTo: Infinity, rate: 0 }],
  capitalGainsBrackets: [{ upTo: Infinity, rate: 0 }],
  additionalMedicareTax: {
    rate: 0.009,
    thresholds: {
      single: 200000,
      marriedFilingJointly: 250000,
      marriedFilingSeparately: 125000,
      headOfHousehold: 200000
    }
  },
  state: {
    standardDeduction: 0,
    brackets: [{ upTo: Infinity, rate: 0 }],
    treatCapitalGainsAsOrdinary: true
  }
};

const flatOrdinaryTaxProfile = {
  ...noTaxProfile,
  ordinaryBrackets: [{ upTo: Infinity, rate: 0.1 }]
};

const flatCapitalGainsTaxProfile = {
  ...noTaxProfile,
  capitalGainsBrackets: [{ upTo: Infinity, rate: 0.15 }]
};

const employeePayrollOnlyTaxProfile = {
  ...noTaxProfile,
  employeePayrollTax: {
    socialSecurityRate: 0.062,
    medicareRate: 0.0145,
    socialSecurityWageBase: 184500
  }
};

const selfEmploymentOnlyTaxProfile = {
  ...noTaxProfile,
  selfEmploymentTax: {
    minimumNetEarnings: 400,
    netEarningsMultiplier: 0.9235,
    socialSecurityRate: 0.124,
    medicareRate: 0.029,
    socialSecurityWageBase: 184500
  }
};

function assertNear(actual, expected, tolerance = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

test("after-tax bequest estimate taxes non-spouse inherited traditional and HSA balances and surfaces taxable step-up", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-stock",
        accountType: "taxable",
        assetClass: "stock",
        units: 10,
        price: 100,
        costBasisPerUnit: 10
      },
      {
        id: "traditional-cash",
        accountType: "traditional",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "roth-cash",
        accountType: "roth",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "hsa-cash",
        accountType: "hsa",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.3,
      heirType: "nonSpouse10Yr",
      rmd: { enabled: false },
      rothConversion: { enabled: false },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      aca: { enabled: false },
      returnAssumptions: {
        stock: { mean: 0, stdev: 0 },
        cash: { mean: 0, stdev: 0 }
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ stock: 0, cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.endingValue, 4000);
  assert.equal(plan.heirValue, 3400);
  assert.equal(plan.heirValueBreakdown.grossValue, 4000);
  assert.equal(plan.heirValueBreakdown.afterTaxValue, 3400);
  assert.equal(plan.heirValueBreakdown.assumedOrdinaryTaxRate, 0.3);
  assert.equal(plan.heirValueBreakdown.taxableUnrealizedGain, 900);
  assert.equal(plan.heirValueBreakdown.taxableStepUpGainAssumed, 900);
  assert.equal(plan.heirValueBreakdown.traditionalIncomeTaxEstimate, 300);
  assert.equal(plan.heirValueBreakdown.hsaIncomeTaxEstimate, 300);
  assert.equal(plan.heirValueBreakdown.totalIncomeTaxEstimate, 600);
});

test("spouse beneficiary rolls inherited traditional and HSA balances without immediate heir income tax", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "traditional-cash",
        accountType: "traditional",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "hsa-cash",
        accountType: "hsa",
        assetClass: "cash",
        units: 500,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.3,
      heirType: "spouse",
      rmd: { enabled: false },
      rothConversion: { enabled: false },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      aca: { enabled: false },
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 }
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.endingValue, 1500);
  assert.equal(plan.heirValue, 1500);
  assert.equal(plan.heirValueBreakdown.traditionalIncomeTaxEstimate, 0);
  assert.equal(plan.heirValueBreakdown.hsaIncomeTaxEstimate, 0);
  assert.equal(plan.heirValueBreakdown.totalIncomeTaxEstimate, 0);
  assert.equal(plan.heirValueBreakdown.spouseRolloverValue, 1500);
  assert.equal(plan.heirValueBreakdown.effectiveTraditionalTaxRate, 0);
});

test("per-account beneficiary overrides split inherited account taxation and inheritance tax", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "spouse-ira",
        accountType: "traditional",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1,
        beneficiaryType: "spouse"
      },
      {
        id: "child-ira",
        accountType: "traditional",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1,
        beneficiaryType: "nonSpouse10Yr"
      },
      {
        id: "spouse-hsa",
        accountType: "hsa",
        assetClass: "cash",
        units: 500,
        price: 1,
        costBasisPerUnit: 1,
        beneficiaryType: "spouse"
      },
      {
        id: "child-hsa",
        accountType: "hsa",
        assetClass: "cash",
        units: 500,
        price: 1,
        costBasisPerUnit: 1,
        beneficiaryType: "nonSpouse10Yr"
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.3,
      heirType: "spouse",
      state: "PA",
      rmd: { enabled: false },
      rothConversion: { enabled: false },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      aca: { enabled: false },
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 }
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.endingValue, 3000);
  assert.equal(plan.heirValueBreakdown.spouseRolloverValue, 1500);
  assert.equal(plan.heirValueBreakdown.spouseBeneficiaryValue, 1500);
  assert.equal(plan.heirValueBreakdown.nonSpouse10YrBeneficiaryValue, 1500);
  assert.equal(plan.heirValueBreakdown.perAccountBeneficiaryOverrideCount, 2);
  assert.equal(plan.heirValueBreakdown.traditionalIncomeTaxEstimate, 300);
  assert.equal(plan.heirValueBreakdown.hsaIncomeTaxEstimate, 150);
  assert.equal(plan.heirValueBreakdown.stateInheritanceTax, 67.5);
  assert.equal(plan.heirValueBreakdown.afterTaxValue, 2482.5);
  // Effective traditional rate reflects only the taxed (non-spouse) portion of
  // the traditional balance; the spouse-rolled-over $1000 is excluded from the
  // denominator so the reported rate is the 30% actually applied, not a 15%
  // dilution across the tax-free spouse share.
  assert.equal(plan.heirValueBreakdown.effectiveTraditionalTaxRate, 0.3);
});

test("decedent state controls inheritance tax regardless of legacy heir residence", () => {
  const assets = [{
    id: "child-roth",
    accountType: "roth",
    assetClass: "cash",
    units: 1_000_000,
    price: 1,
    costBasisPerUnit: 1
  }];
  const baseScenario = {
    planYears: 1,
    targetSpend: 0,
    currentAge: 60,
    heirType: "nonSpouse10Yr",
    rmd: { enabled: false },
    rothConversion: { enabled: false },
    taxGainHarvesting: { enabled: false },
    taxLossHarvesting: { enabled: false },
    aca: { enabled: false },
    returnAssumptions: {
      cash: { mean: 0, stdev: 0 }
    }
  };
  const run = (scenario) => simulatePlan({
    assets,
    scenario: { ...baseScenario, ...scenario },
    taxProfile: { ...noTaxProfile, state: { ...noTaxProfile.state, state: "PA" } },
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(run({ state: "Massachusetts", heirState: "PA" }).heirValueBreakdown.stateInheritanceTax, 0);
  assert.equal(run({ state: "PA", heirState: null }).heirValueBreakdown.stateInheritanceTax, 45_000);
  assert.equal(run({ state: "PA" }).heirValueBreakdown.stateInheritanceTax, 45_000);
  assert.equal(run({}).heirValueBreakdown.stateInheritanceTax, 45_000);
});

test("non-canonical household heir type does not inflate per-account override count", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "trad-default-a",
        accountType: "traditional",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1,
        beneficiaryType: "default"
      },
      {
        id: "trad-default-b",
        accountType: "traditional",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.3,
      // Non-canonical heir type, reachable via an imported/legacy JSON scenario.
      heirType: "child",
      rmd: { enabled: false },
      rothConversion: { enabled: false },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      aca: { enabled: false },
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 }
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  // No account names an explicit per-account beneficiary override, so the count
  // must be 0 even though "child" is not one of the canonical beneficiary types.
  assert.equal(plan.heirValueBreakdown.perAccountBeneficiaryOverrideCount, 0);
});

test("non-canonical household heir type is taxed as a non-spouse heir, not rolled over tax-free", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "trad-default-a",
        accountType: "traditional",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "trad-default-b",
        accountType: "traditional",
        assetClass: "cash",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      currentAge: 60,
      heirOrdinaryTaxRate: 0.3,
      // A "child"/lineal heir is NOT a surviving spouse. The importer
      // canonicalizes the same string to nonSpouse10Yr; the bequest engine must
      // agree and not grant a tax-free spousal rollover that zeroes heir tax.
      heirType: "child",
      rmd: { enabled: false },
      rothConversion: { enabled: false },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      aca: { enabled: false },
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 }
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  const breakdown = plan.heirValueBreakdown;
  // $2,000 traditional, taxed at the 30% heir ordinary rate as a non-spouse
  // inheritance — none of it rolls over tax-free.
  assert.equal(breakdown.spouseRolloverValue, 0);
  assert.equal(breakdown.traditionalIncomeTaxEstimate, 600);
  assert.equal(breakdown.afterTaxValue, 1400);
});

test("withdrawal engine grosses up spending when taxes are excluded from target spend", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      name: "Traditional IRA",
      accountType: "traditional",
      assetClass: "bond",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 65,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.ok(plan.years[0].cashRaised > 110);
  assert.ok(plan.years[0].taxes.totalTax > 10);
});

test("taxes can remain inside target spend when configured that way", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 65,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].cashRaised), 100);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 10);
});

test("discretionary spending guardrails trim nonessential spend by stock-market drawdown", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 4,
      targetSpend: 999,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      currentAge: 65,
      spendingStrategy: {
        mode: "discretionaryGuardrails",
        essentialSpend: 100,
        discretionarySpend: 100
      },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [
      { cash: 0, stock: -0.1 },
      { cash: 0, stock: -0.12 },
      { cash: 0, stock: 0.4 },
      { cash: 0, stock: 0 }
    ],
    inflationSequence: [0.05, 0.05, 0.05, 0.05]
  });

  assertNear(plan.years[0].plannedSpending, 200);
  assertNear(plan.years[1].plannedSpending, 155);
  assertNear(plan.years[2].plannedSpending, 110.25);
  assertNear(plan.years[3].plannedSpending, 215.7625);
  assert.deepEqual(plan.years.map((year) => year.spendingGuardrail.discretionaryPercent), [1, 0.5, 0, 1]);
  assert.deepEqual(plan.years.map((year) => year.discretionarySpending), [100, 50, 0, 100]);
  assertNear(plan.years[2].spendingGuardrail.marketDrawdown, 0.208);
});

test("risk-based historical guardrails switch spending at solved portfolio thresholds", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      units: 1_000_000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 3,
      targetSpend: 50_000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      currentAge: 65,
      spendingStrategy: {
        mode: "riskBasedGuardrails",
        riskBasedGuardrails: {
          targetSuccessRate: 0.9,
          lowerSuccessRate: 0.75,
          upperSuccessRate: 1,
          minimumAdjustmentPercent: 0.05,
          table: {
            method: "historical",
            sequenceCount: 64,
            initialPortfolioValue: 1_000_000,
            fixedFailsafeSpend: 45_000,
            initialSpend: 50_000,
            targetSuccessRate: 0.9,
            lowerSuccessRate: 0.75,
            upperSuccessRate: 1,
            lowerGuardrailPortfolioValue: 900_000,
            lowerAdjustedSpend: 40_000,
            upperGuardrailPortfolioValue: 1_100_000,
            upperAdjustedSpend: 60_000
          }
        }
      },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [
      { cash: -0.2 },
      { cash: 0 },
      { cash: 0 }
    ],
    inflationSequence: [0, 0, 0]
  });

  assert.equal(plan.years[0].plannedSpending, 50_000);
  assert.equal(plan.years[0].spendingGuardrail.action, "none");
  assert.equal(plan.years[1].plannedSpending, 40_000);
  assert.equal(plan.years[1].spendingGuardrail.action, "lower");
  assert.equal(plan.years[2].plannedSpending, 40_000);
  assert.equal(plan.years[2].spendingGuardrail.action, "none");
});

test("earned income creates cash, MAGI, and Additional Medicare Tax", () => {
  const plan = simulatePlan({
    assets: [],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      medicareWages: 300000,
      earnedIncomeInflationAdjusted: false,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{}],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].earnedIncome, 300000);
  assert.equal(plan.years[0].cashAvailable, 300000);
  assert.equal(plan.years[0].magi, 300000);
  assert.equal(plan.years[0].taxes.additionalMedicareTax, 450);
  assert.equal(plan.years[0].taxes.totalTax, 450);
  assert.equal(Math.round(plan.endingValue), 299550);
  assert.ok(plan.years[0].taxAttribution.some((item) => item.source === "Earned income"));
});

test("W-2 wages apply employee FICA without reducing MAGI", () => {
  const plan = simulatePlan({
    assets: [],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      medicareWages: 100000,
      earnedIncomeInflationAdjusted: false,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: employeePayrollOnlyTaxProfile,
    returnSequence: [{}],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].earnedIncome, 100000);
  assert.equal(plan.years[0].cashAvailable, 100000);
  assert.equal(plan.years[0].magi, 100000);
  assert.equal(plan.years[0].taxes.employeePayrollTax, 7650);
  assert.equal(plan.years[0].taxes.employeeSocialSecurityTax, 6200);
  assert.equal(plan.years[0].taxes.employeeMedicareTax, 1450);
  assert.equal(plan.years[0].taxes.totalTax, 7650);
  assert.equal(Math.round(plan.endingValue), 92350);
  assert.ok(plan.years[0].taxAttribution.some((item) => item.source === "Earned income"));
});

test("self-employment income applies SECA tax and half-tax AGI deduction", () => {
  const plan = simulatePlan({
    assets: [],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      selfEmploymentIncome: 100000,
      earnedIncomeInflationAdjusted: false,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: selfEmploymentOnlyTaxProfile,
    returnSequence: [{}],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].earnedIncome, 100000);
  assert.equal(plan.years[0].cashAvailable, 100000);
  assertNear(plan.years[0].magi, 92935.225);
  assert.equal(plan.years[0].taxes.selfEmploymentTax, 14129.55);
  assert.equal(plan.years[0].taxes.selfEmploymentTaxDeduction, 7064.775);
  assert.equal(plan.years[0].taxes.totalTax, 14129.55);
  assertNear(plan.endingValue, 85870.45);
  assert.ok(plan.years[0].taxAttribution.some((item) => item.source === "Earned income"));
});

test("self-employment QBI planning flows into yearly tax results", () => {
  const taxProfile = buildTaxProfile({
    taxYear: 2026,
    filingStatus: "single",
    state: "Florida",
    qbiSourceMode: "selfEmployment"
  });
  const plan = simulatePlan({
    assets: [],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      selfEmploymentIncome: 100000,
      earnedIncomeInflationAdjusted: false,
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile,
    returnSequence: [{}],
    inflationSequence: [0]
  });

  assertNear(plan.years[0].magi, 92935.225);
  assert.equal(plan.years[0].taxes.qbiDeductionBreakdown.sourceMode, "selfEmployment");
  assert.equal(plan.years[0].taxes.qbiDeductionBreakdown.qualifiedBusinessIncome, 92935.225);
  assert.equal(plan.years[0].taxes.taxableOrdinaryIncomeBeforeQbi, 76835.225);
  assert.equal(plan.years[0].taxes.qbiDeduction, 15367.045);
  assert.equal(plan.years[0].taxes.taxableOrdinaryIncome, 61468.18);
  assert.equal(plan.years[0].taxes.federalIncomeTax, 8234.9996);
  assert.equal(plan.years[0].taxes.totalTax, 22364.5496);
});

test("yearly cash audit distinguishes withdrawals from taxable dividend cash", () => {
  const plan = simulatePlan({
    assets: [{
      id: "dividend-stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 10,
      price: 100,
      costBasisPerUnit: 100,
      dividendYield: 0.1,
      qualifiedDividendShare: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].cashRaised, 0);
  assert.equal(plan.years[0].taxableDividendsCash, 100);
  assert.equal(plan.years[0].cashAvailable, 100);
  assert.equal(plan.years[0].totalCashRequired, 100);
});

test("yearly cash flow aggregates taxable dividend inputs", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "dividend-stock-a",
        name: "Dividend Stock A",
        accountType: "taxable",
        assetClass: "stock",
        holdingPeriod: "long",
        units: 10,
        price: 100,
        costBasisPerUnit: 100,
        dividendYield: 0.02,
        qualifiedDividendShare: 1
      },
      {
        id: "dividend-stock-b",
        name: "Dividend Stock B",
        accountType: "taxable",
        assetClass: "stock",
        holdingPeriod: "long",
        units: 5,
        price: 100,
        costBasisPerUnit: 100,
        dividendYield: 0.04,
        qualifiedDividendShare: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 40,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  const dividendInputs = plan.years[0].flows.filter((flow) => flow.from === "Taxable account dividends");

  assert.equal(dividendInputs.length, 1);
  assert.equal(dividendInputs[0].to, "Spending reserve");
  assert.equal(dividendInputs[0].amount, 40);
  assert.equal(plan.years[0].taxableDividendDetails.length, 2);
});

test("taxable dividend yield is split out of total return without double counting", () => {
  const plan = simulatePlan({
    assets: [{
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 1,
      price: 100,
      costBasisPerUnit: 100,
      dividendYield: 0.05,
      qualifiedDividendShare: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ stock: 0.1 }],
    inflationSequence: [0]
  });

  const stock = plan.years[0].assets.find((asset) => asset.id === "stock");
  assertNear(plan.years[0].taxableDividendsCash, 5);
  assertNear(plan.years[0].afterReturnPortfolioValue, 105);
  assertNear(stock.price, 105);
  assertNear(plan.years[0].endingPortfolioValue, 110);
});

test("non-taxable dividends reinvest while preserving the total return path", () => {
  const plan = simulatePlan({
    assets: [{
      id: "roth-stock",
      accountType: "roth",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 1,
      price: 100,
      costBasisPerUnit: 100,
      dividendYield: 0.05,
      qualifiedDividendShare: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth"],
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ stock: 0.1 }],
    inflationSequence: [0]
  });

  const stock = plan.years[0].assets.find((asset) => asset.id === "roth-stock");
  assert.equal(plan.years[0].taxableDividendsCash, 0);
  assertNear(stock.price, 105);
  assertNear(stock.units, 1.04761905, 0.000001);
  assertNear(plan.years[0].endingPortfolioValue, 110);
});

test("income split caps dividends when a severe total loss would imply a negative price", () => {
  const plan = simulatePlan({
    assets: [{
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 1,
      price: 100,
      costBasisPerUnit: 100,
      dividendYield: 0.1,
      qualifiedDividendShare: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ stock: -0.95 }],
    inflationSequence: [0]
  });

  const stock = plan.years[0].assets.find((asset) => asset.id === "stock");
  assert.ok(stock.price >= 0);
  assertNear(plan.years[0].taxableDividendsCash, 5);
  assertNear(plan.years[0].endingPortfolioValue, 5);
});

test("Roth conversions move assets and create ordinary income", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira-bond",
      accountType: "traditional",
      assetClass: "bond",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 65,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, annualAmount: 100 },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].rothConversionAmount), 100);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 10);
  assert.ok(plan.endingAccounts.roth > 99);
  assert.ok(plan.endingAccounts.traditional < 901);
});

test("automatic Roth conversions cross ACA bands when federal benefit exceeds clawback", () => {
  // With targetMarginalRate 0.12, the optimizer should admit crossing
  // intra-table bands whose average marginal subsidy clawback is below 12%
  // and stop at the band where the clawback first exceeds it.
  // For this scenario:
  //   - Band 0–133 (flat 0.02): marginal cost ~2% ✓ cross
  //   - Band 133–150 (0.03→0.04): marginal cost ~11.8% ✓ cross
  //   - Band 150–200 (0.04→0.06): marginal cost = 12% (boundary) → admit
  //   - Band 200–400 (0.06→0.10): marginal cost = 14% ✗ stop
  // The conversion lands at 200% FPL = MAGI 40000.
  const plan = simulatePlan({
    assets: [{
      id: "ira-bond",
      accountType: "traditional",
      assetClass: "bond",
      units: 100000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      withdrawalStrategy: { mode: "heuristic" },
      currentAge: 65,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, mode: "auto", targetMarginalRate: 0.12 },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 18000,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 133, initialRate: 0.02, finalRate: 0.02 },
          { minFplPercent: 133, maxFplPercent: 150, initialRate: 0.03, finalRate: 0.04 },
          { minFplPercent: 150, maxFplPercent: 200, initialRate: 0.04, finalRate: 0.06 },
          { minFplPercent: 200, maxFplPercent: 400, initialRate: 0.06, finalRate: 0.1 }
        ],
        maxEligibleFplPercent: 400
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].rothConversionAmount, 40000);
  assert.equal(plan.years[0].acaMagiCeilingFplPercent, 200);
});

test("automatic Roth conversions skip when even the cheapest band is too expensive", () => {
  // With targetMarginalRate 0.01, even the cheap band 0–133 (flat 0.02 = 2%
  // marginal) costs more than the 1% federal benefit, so the optimizer
  // should not initiate any conversion at all.
  const plan = simulatePlan({
    assets: [{
      id: "ira-bond",
      accountType: "traditional",
      assetClass: "bond",
      units: 100000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      withdrawalStrategy: { mode: "heuristic" },
      currentAge: 65,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, mode: "auto", targetMarginalRate: 0.01 },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 18000,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 133, initialRate: 0.02, finalRate: 0.02 },
          { minFplPercent: 133, maxFplPercent: 150, initialRate: 0.03, finalRate: 0.04 },
          { minFplPercent: 150, maxFplPercent: 200, initialRate: 0.04, finalRate: 0.06 },
          { minFplPercent: 200, maxFplPercent: 400, initialRate: 0.06, finalRate: 0.1 }
        ],
        maxEligibleFplPercent: 400
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].rothConversionAmount, 0);
});

test("automatic Roth conversions can use enhanced senior deduction room", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira-bond",
      accountType: "traditional",
      assetClass: "bond",
      units: 100_000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      startYear: 2026,
      targetSpend: 1_000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      withdrawalStrategy: { mode: "heuristic" },
      currentAge: 65,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, mode: "auto", targetMarginalRate: 0.12, optimizeForAca: false },
      aca: { enabled: false }
    },
    taxProfile: {
      ...noTaxProfile,
      filingStatus: "single",
      ordinaryBrackets: [
        { upTo: 10_000, rate: 0.1 },
        { upTo: Infinity, rate: 0.22 }
      ],
      enhancedSeniorDeduction: {
        effectiveStartYear: 2025,
        effectiveEndYear: 2028,
        amountPerEligiblePerson: 6_000,
        phaseoutRate: 0.06,
        phaseoutThresholds: {
          single: 75_000,
          marriedFilingJointly: 150_000,
          marriedFilingSeparately: null,
          headOfHousehold: 75_000
        }
      }
    },
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].enhancedSeniorDeduction, 6000);
  // Spending-aware sizing: the $1,000 spending withdrawal from traditional
  // consumes bracket room, so the conversion fills the REMAINDER and total
  // taxable ordinary income lands exactly at the 12%-target ceiling
  // (10,000 + 6,000 senior deduction − 1,000 withdrawal = 15,000 converted).
  assert.equal(plan.years[0].rothConversionAmount, 15000);
  assert.equal(plan.years[0].taxes.taxableOrdinaryIncome, 10000);
});

test("automatic Roth conversions can use itemized deduction room", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira-bond",
      accountType: "traditional",
      assetClass: "bond",
      units: 100_000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      startYear: 2026,
      targetSpend: 1_000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      withdrawalStrategy: { mode: "heuristic" },
      currentAge: 50,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, mode: "auto", targetMarginalRate: 0.12, optimizeForAca: false },
      aca: { enabled: false }
    },
    taxProfile: {
      ...noTaxProfile,
      filingStatus: "single",
      ordinaryBrackets: [
        { upTo: 10_000, rate: 0.1 },
        { upTo: Infinity, rate: 0.22 }
      ],
      itemizedDeductions: {
        mode: "itemized",
        stateLocalTaxes: 0,
        mortgageInterest: 6_000,
        charitableContributions: 0,
        medicalExpenses: 0
      }
    },
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].taxes.federalDeductionKind, "itemized");
  assert.equal(plan.years[0].taxes.itemizedDeduction, 6000);
  // Spending-aware sizing: the $1,000 spending withdrawal consumes bracket
  // room, so the conversion fills the remainder and taxable ordinary income
  // lands exactly at the 12%-target ceiling instead of $1,000 past it.
  assert.equal(plan.years[0].rothConversionAmount, 15000);
  assert.equal(plan.years[0].taxes.taxableOrdinaryIncome, 10000);
});

test("tax attribution identifies tax created by Roth conversions", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira-bond",
      accountType: "traditional",
      assetClass: "bond",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 65,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, annualAmount: 100 },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });
  const conversionTax = plan.years[0].taxAttribution.find((item) => item.source === "Roth conversion");
  const conversionTaxFlow = plan.years[0].flows.find((flow) => (
    flow.to === "Tax payment"
  ));

  assert.equal(Math.round(conversionTax.amount), 10);
  assert.equal(conversionTaxFlow.from, "Spending reserve");
  assert.equal(Math.round(conversionTaxFlow.amount), 10);
  assert.equal(plan.years[0].flows.filter((flow) => flow.type === "tax-source").length, 0);
});

test("traditional early withdrawals create ordinary income and a 10 percent penalty", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 50,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].cashRaised), 100);
  assert.equal(Math.round(plan.years[0].taxes.incomeTax), 10);
  assert.equal(Math.round(plan.years[0].penaltyTax), 10);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 20);
});

test("annual early-withdrawal penalty exceptions reduce the penalty base", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 50,
      earlyWithdrawalPenaltyExceptionAmount: 60,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].cashRaised), 100);
  assert.equal(Math.round(plan.years[0].taxes.incomeTax), 10);
  assert.equal(Math.round(plan.years[0].penaltyBase), 40);
  assert.equal(Math.round(plan.years[0].penaltyExceptionUsed), 60);
  assert.equal(Math.round(plan.years[0].penaltyTax), 4);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 14);
});

test("Roth contribution basis is tax-free and penalty-free before penalty-free age", () => {
  const plan = simulatePlan({
    assets: [{
      id: "roth",
      accountType: "roth",
      assetClass: "stock",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth"],
      currentAge: 50,
      rothBasis: 150,
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].cashRaised), 100);
  assert.equal(Math.round(plan.years[0].rothBasisUsed), 100);
  assert.equal(Math.round(plan.years[0].rothBasisRemaining), 50);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 0);
  assert.equal(Math.round(plan.years[0].penaltyTax), 0);
  assert.deepEqual(plan.years[0].flows.filter((flow) => flow.from === "Roth basis used"), [{
    from: "Roth basis used",
    to: "Spending reserve",
    amount: 100,
    type: "withdrawal"
  }]);
});

test("Roth earnings after penalty-free age stay taxable when the five-year rule is not met", () => {
  const plan = simulatePlan({
    assets: [{
      id: "roth",
      accountType: "roth",
      assetClass: "stock",
      units: 100,
      price: 2,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 200,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth"],
      currentAge: 60,
      rothBasis: 100,
      rothFiveYearRuleSatisfied: false,
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].rothBasisUsed), 100);
  assert.equal(Math.round(plan.years[0].magi), 100);
  assert.equal(Math.round(plan.years[0].penaltyTax), 0);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 10);
});

test("Roth withdrawals after penalty-free age default to qualified distributions", () => {
  const plan = simulatePlan({
    assets: [{
      id: "roth",
      accountType: "roth",
      assetClass: "stock",
      units: 100,
      price: 2,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 200,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth"],
      currentAge: 60,
      rothBasis: 0,
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].magi), 0);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 0);
  assert.equal(plan.years[0].rothFiveYearRuleSatisfied, true);
});

test("Roth basis is preserved when income-tax savings are below the dynamic hurdle", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "traditional",
        accountType: "traditional",
        assetClass: "bond",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "roth",
        accountType: "roth",
        assetClass: "bond",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth", "traditional"],
      withdrawalStrategy: { mode: "heuristic" },
      currentAge: 65,
      rothBasis: 500,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].cashRaised), 100);
  assert.equal(Math.round(plan.years[0].magi), 100);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 10);
  assert.equal(Math.round(plan.years[0].rothWithdrawals), 0);
  assert.equal(Math.round(plan.years[0].rothBasisUsed), 0);
  assert.equal(plan.years[0].rothBasisOptimization.accepted, false);
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.modeledSavings), 10);
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.requiredSavings), 12);
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.opportunityCostRate * 1000), 119);
});

test("Roth basis is used before an avoidable early traditional withdrawal penalty", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "traditional",
        accountType: "traditional",
        assetClass: "bond",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "roth",
        accountType: "roth",
        assetClass: "bond",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth", "traditional"],
      currentAge: 50,
      rothBasis: 500,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].cashRaised), 100);
  assert.equal(Math.round(plan.years[0].magi), 0);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 0);
  assert.equal(Math.round(plan.years[0].penaltyTax), 0);
  assert.equal(Math.round(plan.years[0].rothWithdrawals), 100);
  assert.equal(Math.round(plan.years[0].rothBasisUsed), 100);
  assert.equal(plan.years[0].rothBasisOptimization.accepted, true);
  assert.equal(plan.years[0].rothBasisOptimization.reason, "early-penalty-avoidance");
});

test("early penalty avoidance sells taxable room before Roth basis", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-cash",
        accountType: "taxable",
        assetClass: "cash",
        holdingPeriod: "long",
        units: 50,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "traditional",
        accountType: "traditional",
        assetClass: "cash",
        units: 100,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "roth",
        accountType: "roth",
        assetClass: "cash",
        units: 100,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable", "traditional", "roth"],
      currentAge: 50,
      rothBasis: 100,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].penaltyTax), 0);
  assert.equal(Math.round(plan.years[0].rothBasisUsed), 50);
  assert.deepEqual(plan.years[0].sales.map((sale) => [sale.assetId, sale.accountType, Math.round(sale.proceeds)]), [
    ["taxable-cash", "taxable", 50],
    ["roth", "roth", 50]
  ]);
  assert.equal(plan.years[0].rothBasisOptimization.reason, "early-penalty-avoidance");
});

test("taxable sales stay ahead of Roth basis when they cover spending within MAGI room", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-cash",
        accountType: "taxable",
        assetClass: "cash",
        holdingPeriod: "long",
        units: 150,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "traditional",
        accountType: "traditional",
        assetClass: "cash",
        units: 100,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "roth",
        accountType: "roth",
        assetClass: "cash",
        units: 100,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable", "traditional", "roth"],
      currentAge: 50,
      rothBasis: 100,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].penaltyTax), 0);
  assert.equal(Math.round(plan.years[0].rothBasisUsed), 0);
  assert.deepEqual(plan.years[0].sales.map((sale) => [sale.assetId, sale.accountType, Math.round(sale.proceeds)]), [
    ["taxable-cash", "taxable", 100]
  ]);
});

test("Roth basis can replace taxable sales when taxable room is too expensive", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-gain",
        accountType: "taxable",
        assetClass: "stock",
        holdingPeriod: "long",
        units: 1,
        price: 100,
        costBasisPerUnit: 0
      },
      {
        id: "roth",
        accountType: "roth",
        assetClass: "cash",
        units: 100,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable", "roth"],
      currentAge: 50,
      rothBasis: 100,
      returnAssumptions: { stock: { mean: 0, stdev: 0 }, cash: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: {
      ...noTaxProfile,
      capitalGainsBrackets: [{ upTo: Infinity, rate: 1 }]
    },
    returnSequence: [{ stock: 0, cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].taxes.totalTax), 0);
  assert.equal(Math.round(plan.years[0].rothBasisUsed), 100);
  assert.deepEqual(plan.years[0].sales.map((sale) => [sale.assetId, sale.accountType, Math.round(sale.proceeds)]), [
    ["roth", "roth", 100]
  ]);
  assert.equal(plan.years[0].rothBasisOptimization.accepted, true);
});

test("Roth basis is used when ACA savings clear the dynamic opportunity-cost hurdle", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "traditional",
        accountType: "traditional",
        assetClass: "cash",
        units: 200000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "roth",
        accountType: "roth",
        assetClass: "cash",
        units: 200000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 90000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional", "roth"],
      withdrawalStrategy: { mode: "heuristic" },
      currentAge: 50,
      rothBasis: 90000,
      earlyWithdrawalPenaltyRate: 0,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 60000,
        selectedPlanPremium: 60000,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0, finalRate: 0 }
        ],
        requiredContributionPercentage: 0.1,
        maxEligibleFplPercent: 400,
        minEligibleFplPercent: 0
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].cashRaised), 90000);
  assert.equal(Math.round(plan.years[0].magi), 0);
  assert.equal(Math.round(plan.years[0].aca.netPremium), 0);
  assert.equal(Math.round(plan.years[0].rothWithdrawals), 90000);
  assert.equal(Math.round(plan.years[0].rothBasisUsed), 90000);
  assert.equal(plan.years[0].rothBasisOptimization.accepted, true);
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.modeledSavings), 60000);
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.requiredSavings), 10693);
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.opportunityCostRate * 1000), 119);
});

test("early Roth basis withdrawals sell low-return Roth assets before growth assets", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "traditional",
        accountType: "traditional",
        assetClass: "cash",
        units: 200000,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "roth-stock",
        accountType: "roth",
        assetClass: "stock",
        units: 30000,
        price: 1,
        costBasisPerUnit: 1,
        expectedReturn: 0.08
      },
      {
        id: "roth-bond",
        accountType: "roth",
        assetClass: "bond",
        units: 30000,
        price: 1,
        costBasisPerUnit: 1,
        expectedReturn: 0.03
      },
      {
        id: "roth-cash",
        accountType: "roth",
        assetClass: "cash",
        units: 30000,
        price: 1,
        costBasisPerUnit: 1,
        expectedReturn: 0.01
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 90000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional", "roth"],
      withdrawalStrategy: { mode: "heuristic" },
      currentAge: 50,
      rothBasis: 90000,
      earlyWithdrawalPenaltyRate: 0,
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 },
        bond: { mean: 0, stdev: 0 },
        stock: { mean: 0, stdev: 0 }
      },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 60000,
        selectedPlanPremium: 60000,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0, finalRate: 0 }
        ],
        requiredContributionPercentage: 0.1,
        maxEligibleFplPercent: 400,
        minEligibleFplPercent: 0
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0, bond: 0, stock: 0 }],
    inflationSequence: [0]
  });

  const rothSaleIds = plan.years[0].sales
    .filter((sale) => sale.accountType === "roth")
    .map((sale) => sale.assetId);

  assert.deepEqual(rothSaleIds, ["roth-cash", "roth-bond", "roth-stock"]);
  assert.equal(plan.years[0].rothBasisOptimization.accepted, true);
});

test("lifetime optimizer sells lower expected return taxable assets first", () => {
  const plan = simulatePlan({
    assets: [{
      id: "stock-growth",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }, {
      id: "bond-low-return",
      accountType: "taxable",
      assetClass: "bond",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 1,
      targetSpend: 1000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      withdrawalStrategy: { mode: "lifetime" },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: {
        stock: { mean: 0.08, stdev: 0 },
        bond: { mean: 0.02, stdev: 0 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ stock: 0, bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].sales[0].assetId, "bond-low-return");
});

test("lifetime optimizer does not preserve Roth basis by taking avoidable early penalties", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-cash",
        accountType: "taxable",
        assetClass: "cash",
        holdingPeriod: "long",
        units: 50,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "traditional",
        accountType: "traditional",
        assetClass: "cash",
        units: 100,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "roth-growth",
        accountType: "roth",
        assetClass: "stock",
        units: 100,
        price: 1,
        costBasisPerUnit: 1,
        expectedReturn: 0.12
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable", "traditional", "roth"],
      withdrawalStrategy: { mode: "lifetime", expectedReturnPenaltyYears: 25 },
      currentAge: 50,
      rothBasis: 100,
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 },
        stock: { mean: 0, stdev: 0 }
      },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ cash: 0, stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].penaltyTax), 0);
  assert.equal(Math.round(plan.years[0].rothBasisUsed), 50);
  assert.deepEqual(plan.years[0].sales.map((sale) => [sale.assetId, sale.accountType, Math.round(sale.proceeds)]), [
    ["taxable-cash", "taxable", 50],
    ["roth-growth", "roth", 50]
  ]);
  assert.equal(plan.years[0].rothBasisOptimization.reason, "early-penalty-avoidance");
});

test("lifetime optimizer can harvest gains beyond the zero percent bracket", () => {
  const gainProfile = {
    ...noTaxProfile,
    capitalGainsBrackets: [
      { upTo: 0, rate: 0 },
      { upTo: 10000, rate: 0.15 },
      { upTo: Infinity, rate: 0.2 }
    ],
    niit: {
      rate: 0.038,
      thresholds: { marriedFilingJointly: 250000 }
    }
  };
  const input = {
    assets: [{
      id: "taxable-gain",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 100,
      price: 200,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      withdrawalStrategy: { mode: "heuristic" },
      taxGainHarvesting: { enabled: true, mode: "auto" },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      aca: { enabled: false }
    },
    taxProfile: gainProfile,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  };

  const heuristic = simulatePlan(input);
  const optimized = simulatePlan({
    ...input,
    scenario: {
      ...input.scenario,
      withdrawalStrategy: { mode: "lifetime" }
    }
  });

  assert.equal(heuristic.years[0].taxGainHarvested, 0);
  assert.equal(optimized.years[0].taxGainHarvested, 10000);
  assert.equal(optimized.years[0].taxes.federalPreferentialTax, 1500);
});

test("lifetime optimizer gain harvesting crosses cheap ACA bands when future tax savings exceed clawback", () => {
  const plan = simulatePlan({
    assets: [{
      id: "taxable-gain",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 500,
      price: 200,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      withdrawalStrategy: { mode: "lifetime" },
      taxGainHarvesting: { enabled: true, mode: "auto" },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 18000,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 133, initialRate: 0.02, finalRate: 0.02 },
          { minFplPercent: 133, maxFplPercent: 150, initialRate: 0.04, finalRate: 0.04 },
          { minFplPercent: 150, maxFplPercent: 200, initialRate: 0.05, finalRate: 0.05 },
          { minFplPercent: 200, maxFplPercent: 400, initialRate: 0.09, finalRate: 0.09 }
        ],
        maxEligibleFplPercent: 400
      }
    },
    taxProfile: {
      ...noTaxProfile,
      capitalGainsBrackets: [
        { upTo: 0, rate: 0 },
        { upTo: 100000, rate: 0.15 },
        { upTo: Infinity, rate: 0.2 }
      ],
      niit: {
        rate: 0.038,
        thresholds: { marriedFilingJointly: 250000 }
      }
    },
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].taxGainHarvested, 40000);
  assert.equal(plan.years[0].aca.fplPercent, 200);
});

test("lifetime optimizer bunches gains in years where ACA eligibility is already lost", () => {
  const plan = simulatePlan({
    assets: [{
      id: "taxable-gain",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 500,
      price: 200,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      medicareWages: 90000,
      earnedIncomeInflationAdjusted: false,
      withdrawalOrder: ["taxable"],
      withdrawalStrategy: { mode: "lifetime" },
      taxGainHarvesting: { enabled: true, mode: "auto" },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 18000,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
        ],
        maxEligibleFplPercent: 400
      }
    },
    taxProfile: {
      ...noTaxProfile,
      capitalGainsBrackets: [
        { upTo: 0, rate: 0 },
        { upTo: 100000, rate: 0.15 },
        { upTo: Infinity, rate: 0.2 }
      ],
      niit: {
        rate: 0.038,
        thresholds: { marriedFilingJointly: 250000 }
      }
    },
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].aca.eligible, false);
  assert.equal(plan.years[0].taxGainHarvested, 10000);
});

test("lifetime optimizer avoids pushing extra harvested gains into NIIT", () => {
  const plan = simulatePlan({
    assets: [{
      id: "taxable-gain",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 500,
      price: 200,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      medicareWages: 245000,
      earnedIncomeInflationAdjusted: false,
      withdrawalOrder: ["taxable"],
      withdrawalStrategy: { mode: "lifetime" },
      taxGainHarvesting: { enabled: true, mode: "auto" },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 18000,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
        ],
        maxEligibleFplPercent: 400
      }
    },
    taxProfile: {
      ...noTaxProfile,
      capitalGainsBrackets: [
        { upTo: 0, rate: 0 },
        { upTo: 400000, rate: 0.15 },
        { upTo: Infinity, rate: 0.2 }
      ],
      niit: {
        rate: 0.038,
        thresholds: { marriedFilingJointly: 250000 }
      }
    },
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].taxGainHarvested, 5000);
  assert.equal(plan.years[0].magi, 250000);
});

test("ACA-lost-year gain harvesting can improve next-year subsidy and ending value", () => {
  const input = {
    assets: [{
      id: "taxable-gain",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 500,
      price: 200,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 2,
      targetSpend: 90000,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: false,
      medicalExpensesBase: 0,
      expectedOopMaxUsePercent: 0,
      withdrawalOrder: ["taxable"],
      withdrawalStrategy: { mode: "lifetime" },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 18000,
        selectedPlanPremium: 18000,
        oopMaximum: 0,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
        ],
        maxEligibleFplPercent: 400,
        minEligibleFplPercent: 0
      },
      oneOffExpenses: [
        {
          name: "Year 1 ordinary income",
          cashFlowType: "taxableOrdinaryIncome",
          startYear: 1,
          endYear: 1,
          amount: 90000,
          inflationAdjusted: false
        },
        {
          name: "Year 2 ordinary income",
          cashFlowType: "taxableOrdinaryIncome",
          startYear: 2,
          endYear: 2,
          amount: 25000,
          inflationAdjusted: false
        }
      ]
    },
    taxProfile: {
      ...noTaxProfile,
      capitalGainsBrackets: [
        { upTo: 0, rate: 0 },
        { upTo: 200000, rate: 0.15 },
        { upTo: Infinity, rate: 0.2 }
      ],
      niit: {
        rate: 0.038,
        thresholds: { marriedFilingJointly: 250000 }
      }
    },
    returnSequence: [{ stock: 0 }, { stock: 0 }],
    inflationSequence: [0, 0]
  };
  const withoutHarvesting = simulatePlan({
    ...input,
    scenario: {
      ...input.scenario,
      taxGainHarvesting: { enabled: false }
    }
  });
  const withHarvesting = simulatePlan({
    ...input,
    scenario: {
      ...input.scenario,
      taxGainHarvesting: { enabled: true, mode: "auto" }
    }
  });

  assert.ok(withHarvesting.years[0].taxGainHarvested > 0);
  assert.ok(withHarvesting.years[1].aca.subsidy > withoutHarvesting.years[1].aca.subsidy);
  assert.ok(withHarvesting.endingValue > withoutHarvesting.endingValue);
});

test("lifetime optimizer Roth conversion pressure uses default RMD age", () => {
  const plan = simulatePlan({
    assets: [{
      id: "large-traditional",
      accountType: "traditional",
      assetClass: "bond",
      units: 500000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      startYear: 2026,
      planYears: 1,
      currentAge: 60,
      targetSpend: 10000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      withdrawalStrategy: { mode: "lifetime" },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      rothConversion: {
        enabled: true,
        mode: "auto",
        targetMarginalRate: 0.12,
        optimizeForAca: true
      },
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      aca: { enabled: false }
    },
    taxProfile: {
      ...noTaxProfile,
      standardDeduction: 0,
      ordinaryBrackets: [
        { upTo: 20000, rate: 0.1 },
        { upTo: 80000, rate: 0.22 },
        { upTo: Infinity, rate: 0.24 }
      ]
    },
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].rmdStartAge, 75);
  // Spending-aware sizing: the $10,000 spending withdrawal stacks first, so
  // the RMD-pressure conversion fills to the 22% ceiling minus that income
  // (70,000 + 10,000 = 80,000 — exactly at the bracket top, not past it).
  assert.equal(plan.years[0].rothConversionAmount, 70000);
});

test("sequence-risk cash reserve is preserved in positive early years", () => {
  const plan = simulatePlan({
    assets: [{
      id: "reserve-cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }, {
      id: "growth-stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 1,
      targetSpend: 1000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      sequenceRiskReserve: {
        enabled: true,
        mode: "cash",
        targetYears: 3,
        tentYears: 10,
        triggerStockReturn: 0
      },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 },
        stock: { mean: 0.08, stdev: 0 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0, stock: 0.1 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].sequenceRiskReserve.preserveReserve, true);
  assert.equal(plan.years[0].sales[0].assetId, "growth-stock");
});

test("sequence-risk cash reserve is spent first in negative early years", () => {
  const plan = simulatePlan({
    assets: [{
      id: "reserve-cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }, {
      id: "growth-stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 1,
      targetSpend: 1000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      sequenceRiskReserve: {
        enabled: true,
        mode: "cash",
        targetYears: 3,
        tentYears: 10,
        triggerStockReturn: 0
      },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 },
        stock: { mean: 0.08, stdev: 0 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0, stock: -0.1 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].sequenceRiskReserve.spendReserveFirst, true);
  assert.equal(plan.years[0].sales[0].assetId, "reserve-cash");
});

test("tax-aware annual rebalancing uses sheltered stock before taxable gains", () => {
  const plan = simulatePlan({
    assets: [{
      id: "traditional-stock",
      accountType: "traditional",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 50,
      price: 1,
      costBasisPerUnit: 1
    }, {
      id: "taxable-stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 25,
      price: 2,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable", "traditional"],
      allocationStrategy: {
        rebalanceEnabled: true,
        targetStockPercent: 50,
        rebalanceBandPercent: 0
      },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].allocationStrategy.rebalancedAmount, 50);
  assert.equal(plan.years[0].allocationStrategy.sales[0].assetId, "traditional-stock");
  assert.equal(plan.years[0].realizedLongTermGains, 0);
  assert.equal(plan.years[0].allocationStrategy.stockShareAfterPercent, 50);
});

test("allocation-aware withdrawals sell overweight stock before cash", () => {
  const input = {
    assets: [{
      id: "overweight-stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 90,
      price: 1,
      costBasisPerUnit: 1
    }, {
      id: "cash-buffer",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 10,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 20,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      withdrawalStrategy: { mode: "lifetime" },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 },
        stock: { mean: 0.08, stdev: 0 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0, stock: 0 }],
    inflationSequence: [0]
  };
  const ordinary = simulatePlan(input);
  const allocationAware = simulatePlan({
    ...input,
    scenario: {
      ...input.scenario,
      allocationStrategy: {
        withdrawalBiasEnabled: true,
        targetStockPercent: 70,
        rebalanceBandPercent: 0
      }
    }
  });

  assert.equal(ordinary.years[0].sales[0].assetId, "cash-buffer");
  assert.equal(allocationAware.years[0].sales[0].assetId, "overweight-stock");
});

test("equity glidepath moves the stock target and rebalances toward it", () => {
  const plan = simulatePlan({
    assets: [{
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 60,
      price: 1,
      costBasisPerUnit: 1
    }, {
      id: "bond",
      accountType: "taxable",
      assetClass: "bond",
      holdingPeriod: "long",
      units: 40,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 3,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      allocationStrategy: {
        rebalanceEnabled: true,
        glidepathEnabled: true,
        glidepathStartStockPercent: 60,
        glidepathEndStockPercent: 80,
        glidepathYears: 3,
        rebalanceBandPercent: 0
      },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: {
        bond: { mean: 0, stdev: 0 },
        stock: { mean: 0, stdev: 0 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ bond: 0, stock: 0 }, { bond: 0, stock: 0 }, { bond: 0, stock: 0 }],
    inflationSequence: [0, 0, 0]
  });

  assert.deepEqual(plan.years.map((year) => year.allocationStrategy.targetStockPercent), [60, 70, 80]);
  assert.deepEqual(plan.years.map((year) => year.allocationStrategy.rebalancedAmount), [0, 10, 10]);
});

test("unified marginal optimizer limits Roth conversions through the Social Security tax torpedo", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 100000,
      price: 1,
      costBasisPerUnit: 1
    }, {
      id: "spending-cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 20000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 20000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      withdrawalStrategy: { mode: "lifetime" },
      currentAge: 67,
      socialSecurityAnnualBenefit: 40000,
      socialSecurityStartAge: 67,
      socialSecurityInflationAdjusted: false,
      rothConversion: { enabled: true, mode: "auto", targetMarginalRate: 0.12 },
      taxEfficiencyStrategy: { marginalRateOptimizationEnabled: true },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      returnAssumptions: { bond: { mean: 0, stdev: 0 }, cash: { mean: 0, stdev: 0 } },
      aca: { enabled: false }
    },
    taxProfile: {
      ...noTaxProfile,
      ordinaryBrackets: [{ upTo: 100000, rate: 0.1 }, { upTo: Infinity, rate: 0.5 }],
      socialSecurityTaxation: {
        baseAmounts: { marriedFilingJointly: 32000 },
        adjustedBaseAmounts: { marriedFilingJointly: 44000 },
        taxableShareLow: 0.5,
        taxableShareHigh: 0.85
      }
    },
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].rothConversionAmount, 12000);
  assert.equal(plan.years[0].taxableSocialSecurity, 0);
});

test("asset-location swaps move taxable bonds into traditional accounts", () => {
  const plan = simulatePlan({
    assets: [{
      id: "taxable-bond",
      accountType: "taxable",
      assetClass: "bond",
      holdingPeriod: "long",
      units: 1000,
      price: 100,
      costBasisPerUnit: 100,
      dividendYield: 0.05,
      qualifiedDividendShare: 0
    }, {
      id: "traditional-stock",
      accountType: "traditional",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 1000,
      price: 100,
      costBasisPerUnit: 100,
      dividendYield: 0,
      qualifiedDividendShare: 1
    }],
    scenario: {
      planYears: 2,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable", "traditional"],
      taxEfficiencyStrategy: { assetLocationEnabled: true },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: {
        bond: { mean: 0, stdev: 0 },
        stock: { mean: 0, stdev: 0 }
      },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0, stock: 0 }, { bond: 0, stock: 0 }],
    inflationSequence: [0, 0]
  });

  assert.equal(plan.years[0].assetLocation.relocatedAmount, 95000);
  assert.equal(plan.years[1].taxableDividendsCash, 0);
  assert.ok(plan.finalPortfolio.some((asset) => asset.accountType === "taxable" && asset.assetClass === "stock"));
  assert.ok(plan.finalPortfolio.some((asset) => asset.accountType === "traditional" && asset.assetClass === "bond"));
});

test("HSA contribution strategy creates an above-the-line deduction and invested HSA lot", () => {
  const plan = simulatePlan({
    assets: [],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      currentAge: 55,
      spouseAge: 55,
      medicareWages: 10000,
      earnedIncomeInflationAdjusted: false,
      taxEfficiencyStrategy: {
        hsaContributionEnabled: true,
        hsaCoverage: "self",
        hsaAnnualContribution: 4000,
        hsaCatchUpEnabled: false,
        hsaInvestmentAssetClass: "stock"
      },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].hsaContribution.amount, 4000);
  assert.equal(plan.years[0].federalAgi, 6000);
  assert.equal(plan.years[0].taxes.totalTax, 600);
  assert.equal(plan.endingAccounts.hsa, 4000);
});

test("Roth earnings above contribution basis are taxable and penalized when withdrawn early", () => {
  const plan = simulatePlan({
    assets: [{
      id: "roth",
      accountType: "roth",
      assetClass: "stock",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 200,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth"],
      currentAge: 50,
      rothBasis: 100,
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].rothBasisUsed), 100);
  assert.equal(Math.round(plan.years[0].magi), 100);
  assert.equal(Math.round(plan.years[0].penaltyTax), 10);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 10);
});

test("Roth conversion principal inside five years has penalty recapture but no income tax", () => {
  const plan = simulatePlan({
    assets: [{
      id: "recent-conversion",
      accountType: "roth",
      assetClass: "bond",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1,
      rothSource: "conversion",
      conversionYear: 2026
    }],
    scenario: {
      startYear: 2028,
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth"],
      currentAge: 50,
      rothBasis: 0,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].magi), 0);
  assert.equal(Math.round(plan.years[0].taxes.incomeTax), 0);
  assert.equal(Math.round(plan.years[0].penaltyTax), 10);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 10);
});

test("Roth basis available includes conversion principal after the five-year clock", () => {
  const plan = simulatePlan({
    assets: [{
      id: "seasoned-conversion",
      accountType: "roth",
      assetClass: "bond",
      units: 100,
      price: 1,
      costBasisPerUnit: 1,
      rothSource: "conversion",
      conversionYear: 2026
    }],
    scenario: {
      startYear: 2031,
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth"],
      currentAge: 50,
      rothBasis: 50,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].rothContributionBasisRemaining, 50);
  assert.equal(plan.years[0].rothConversionPrincipalRemaining, 100);
  assert.equal(plan.years[0].rothPenaltyFreeConversionPrincipal, 100);
  assert.equal(plan.years[0].rothBasisAvailable, 150);
});

test("Roth basis available excludes early conversion principal still inside five years", () => {
  const plan = simulatePlan({
    assets: [{
      id: "recent-conversion-remaining",
      accountType: "roth",
      assetClass: "bond",
      units: 100,
      price: 1,
      costBasisPerUnit: 1,
      rothSource: "conversion",
      conversionYear: 2026
    }],
    scenario: {
      startYear: 2028,
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth"],
      currentAge: 50,
      rothBasis: 50,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].rothContributionBasisRemaining, 50);
  assert.equal(plan.years[0].rothConversionPrincipalRemaining, 100);
  assert.equal(plan.years[0].rothPenaltyFreeConversionPrincipal, 0);
  assert.equal(plan.years[0].rothBasisAvailable, 50);
});

test("seasoned Roth conversion principal can protect ACA MAGI without contribution basis", () => {
  const plan = simulatePlan({
    assets: [{
      id: "traditional",
      accountType: "traditional",
      assetClass: "cash",
      units: 100000,
      price: 1,
      costBasisPerUnit: 1
    }, {
      id: "seasoned-conversion",
      accountType: "roth",
      assetClass: "cash",
      units: 10000,
      price: 1,
      costBasisPerUnit: 1,
      rothSource: "conversion",
      conversionYear: 2020
    }],
    scenario: {
      startYear: 2026,
      planYears: 1,
      targetSpend: 81000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional", "roth"],
      withdrawalStrategy: { mode: "lifetime" },
      currentAge: 50,
      heirType: "nonSpouse10Yr",
      heirOrdinaryTaxRate: 0.3,
      rothBasis: 0,
      earlyWithdrawalPenaltyRate: 0,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 60000,
        selectedPlanPremium: 60000,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0, finalRate: 0 }
        ],
        requiredContributionPercentage: 0.1,
        maxEligibleFplPercent: 400,
        minEligibleFplPercent: 0
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].cashRaised), 81000);
  assert.equal(Math.round(plan.years[0].rothWithdrawals), 2000);
  assert.equal(Math.round(plan.years[0].magi), 79000);
  assert.equal(Math.round(plan.years[0].aca.subsidy), 60000);
  assert.equal(plan.years[0].rothBasisOptimization.accepted, true);
});

test("manual Roth conversion guardrails cap conversions below the ACA cliff buffer", () => {
  const plan = simulatePlan({
    assets: [{
      id: "traditional",
      accountType: "traditional",
      assetClass: "cash",
      units: 100000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      withdrawalStrategy: { mode: "lifetime" },
      currentAge: 50,
      medicareWages: 70000,
      earnedIncomeInflationAdjusted: false,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: {
        enabled: true,
        annualAmount: 50000,
        applyMagiGuardrails: true,
        optimizeForAca: true,
        maxAcaFplPercent: 400,
        magiBuffer: 1000
      },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 60000,
        selectedPlanPremium: 60000,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0, finalRate: 0 }
        ],
        requiredContributionPercentage: 0.1,
        maxEligibleFplPercent: 400,
        minEligibleFplPercent: 0
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].rothConversionAmount), 9000);
  assert.equal(Math.round(plan.years[0].magi), 79000);
  assert.equal(Math.round(plan.years[0].aca.subsidy), 60000);
});

test("one-off expenses can be inflation adjusted by year", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 10000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 2,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: false,
      withdrawalOrder: ["taxable"],
      oneOffExpenses: [{
        name: "Car",
        startYear: 2,
        endYear: 2,
        amount: 100,
        inflationAdjusted: true
      }],
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }, { cash: 0 }],
    inflationSequence: [0.1, 0]
  });

  assert.equal(plan.years[1].plannedSpending, 110);
});

test("one-off taxable income adds cash and MAGI for the configured years", () => {
  const plan = simulatePlan({
    assets: [],
    scenario: {
      planYears: 3,
      targetSpend: 0,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      oneOffExpenses: [{
        name: "Consulting",
        cashFlowType: "taxableOrdinaryIncome",
        startYear: 1,
        endYear: 2,
        amount: 100,
        inflationAdjusted: false
      }],
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{}, {}, {}],
    inflationSequence: [0, 0, 0]
  });

  assert.equal(plan.years[0].oneOffIncome, 100);
  assert.equal(plan.years[0].magi, 100);
  assert.equal(plan.years[0].taxes.totalTax, 10);
  assert.equal(plan.years[1].oneOffIncome, 100);
  assert.equal(plan.years[2].oneOffIncome, 0);
  assert.ok(plan.years[0].taxAttribution.some((item) => item.source === "One-off income"));
});

test("one-off tax-free income adds cash without MAGI", () => {
  const plan = simulatePlan({
    assets: [],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      oneOffExpenses: [{
        name: "Gift",
        cashFlowType: "taxFreeIncome",
        startYear: 1,
        endYear: 1,
        amount: 100,
        inflationAdjusted: false
      }],
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{}],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].oneOffIncome, 100);
  assert.equal(plan.years[0].magi, 0);
  assert.equal(plan.years[0].taxes.totalTax, 0);
  assert.equal(Math.round(plan.endingValue), 100);
});

test("conditional asset sale can rescue a year when portfolio value breaches the trigger", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      units: 100,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 150,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      conditionalAssetSales: [{
        name: "Second home",
        triggerPortfolioValue: 100,
        saleProceeds: 75,
        taxableLongTermGain: 0,
        inflationAdjusted: false
      }],
      rothConversion: { enabled: false },
      aca: { enabled: false },
      returnAssumptions: { cash: { mean: 0, stdev: 0 } }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.success, true);
  assert.equal(plan.years[0].conditionalAssetSaleProceeds, 75);
  assert.equal(plan.years[0].conditionalAssetSaleDetails[0].name, "Second home");
  assert.equal(plan.years[0].cashAvailable, 150);
  assert.equal(plan.years[0].cashRaised, 75);
  assert.equal(plan.endingValue, 25);
});

test("conditional asset sale trigger is real-dollar based and fires only once per path", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      units: 200,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 3,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      conditionalAssetSales: [{
        name: "Cabin",
        triggerPortfolioValue: 175,
        saleProceeds: 20,
        taxableLongTermGain: 0
      }],
      rothConversion: { enabled: false },
      aca: { enabled: false },
      returnAssumptions: { cash: { mean: 0, stdev: 0 } }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }, { cash: 0 }, { cash: 0 }],
    inflationSequence: [1, 0, 0]
  });

  assert.deepEqual(plan.years.map((year) => year.conditionalAssetSaleProceeds), [0, 40, 0]);
  assert.equal(plan.years[1].conditionalAssetSaleDetails[0].realPortfolioValue, 100);
  assert.equal(plan.endingValue, 240);
});

test("conditional asset sale taxable gain flows through long-term gains and tax attribution", () => {
  const plan = simulatePlan({
    assets: [],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      conditionalAssetSales: [{
        name: "Second home",
        triggerPortfolioValue: 0,
        saleProceeds: 100,
        taxableLongTermGain: 80,
        inflationAdjusted: false
      }],
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatCapitalGainsTaxProfile,
    returnSequence: [{}],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].conditionalAssetSaleProceeds, 100);
  assert.equal(plan.years[0].conditionalAssetSaleTaxableLongTermGain, 80);
  assert.equal(plan.years[0].realizedLongTermGains, 80);
  assert.equal(plan.years[0].magi, 80);
  assert.equal(plan.years[0].taxes.totalTax, 12);
  assert.equal(plan.endingValue, 88);
  assert.ok(plan.years[0].taxAttribution.some((item) => item.source === "Contingent asset sale"));
});

test("ACA premiums age-rate by simulated year on top of inflation", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 10000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 2,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: false,
      withdrawalOrder: ["taxable"],
      currentAge: 40,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      aca: {
        enabled: true,
        householdSize: 1,
        marketplaceMembers: 1,
        fpl: 20000,
        benchmarkPremium: 12780,
        ageRatedBenchmarkPremium: true,
        benchmarkPremiumReferenceAge: 40
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }, { cash: 0 }],
    inflationSequence: [0.1, 0]
  });

  assert.equal(plan.years[0].aca.grossPremium, 12780);
  assert.equal(plan.years[1].aca.grossPremium, round6(12780 * (1.302 / 1.278) * 1.1));
});

test("manual ACA OOP max inflates without age-rating", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 50000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 2,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: false,
      medicalExpensesBase: 0,
      expectedOopMaxUsePercent: 1,
      withdrawalOrder: ["taxable"],
      currentAge: 40,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      aca: {
        enabled: true,
        householdSize: 1,
        marketplaceMembers: 1,
        fpl: 20000,
        benchmarkPremium: 0,
        selectedPlanPremium: 0,
        oopMaximum: 10000,
        manualOopMaximum: true
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }, { cash: 0 }],
    inflationSequence: [0.1, 0]
  });

  assert.equal(plan.years[0].medicalCost, 10000);
  assert.equal(plan.years[1].medicalCost, 11000);
});

test("ACA backup plan changes medical premium and OOP when modeled MAGI exceeds trigger", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "cash",
      units: 200000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 85000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: false,
      medicalExpensesBase: 0,
      expectedOopMaxUsePercent: 1,
      withdrawalOrder: ["traditional"],
      currentAge: 55,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: {
        enabled: true,
        fpl: 20000,
        premiumInputMode: "net",
        benchmarkPremium: 0,
        selectedPlanPremium: 3600,
        oopMaximum: 4500,
        backupPlan: {
          enabled: true,
          triggerFplPercent: 400,
          premiumInputMode: "gross",
          benchmarkPremium: 10000,
          selectedPlanPremium: 12000,
          oopMaximum: 9000,
          planName: "Backup silver plan"
        },
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
        ],
        maxEligibleFplPercent: 400
      }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].aca.activePlanRole, "backup");
  assert.equal(plan.years[0].aca.netPremium, 12000);
  assert.equal(plan.years[0].medicalCost, 21000);
});

test("ACA plan switches from primary to backup mid-simulation when MAGI crosses trigger", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "cash",
      units: 500000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 2,
      targetSpend: 50000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: false,
      medicalExpensesBase: 0,
      expectedOopMaxUsePercent: 1,
      withdrawalOrder: ["traditional"],
      currentAge: 55,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: {
        enabled: true,
        fpl: 20000,
        premiumInputMode: "net",
        benchmarkPremium: 0,
        selectedPlanPremium: 3600,
        oopMaximum: 4500,
        manualOopMaximum: true,
        backupPlan: {
          enabled: true,
          triggerFplPercent: 400,
          premiumInputMode: "net",
          benchmarkPremium: 0,
          selectedPlanPremium: 12000,
          oopMaximum: 9000,
          manualOopMaximum: true,
          planName: "Backup silver plan"
        },
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.05, finalRate: 0.05 }
        ],
        maxEligibleFplPercent: 400
      },
      oneOffExpenses: [{
        name: "Large expense pushing MAGI up",
        startYear: 2,
        endYear: 2,
        amount: 50000,
        inflationAdjusted: false
      }]
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }, { cash: 0 }],
    inflationSequence: [0, 0]
  });

  // Year 1: MAGI is around 50k + 8100 (medical) = 58k. FPL=20k. FPL% ~290%. So primary plan used.
  assert.equal(plan.years[0].aca.activePlanRole, "primary");
  assert.equal(plan.years[0].aca.netPremium, 3600);
  assert.equal(plan.years[0].medicalCost, 8100);

  // Year 2: oneOffExpense adds 50k to target spend. MAGI > 100k. FPL=20k. FPL% > 500%. Switch to backup.
  assert.equal(plan.years[1].aca.activePlanRole, "backup");
  assert.equal(plan.years[1].aca.netPremium, 12000);
  assert.equal(plan.years[1].medicalCost, 21000);
});

test("child tax credit counts children by age each simulated year", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 5000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 2,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 40,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, annualAmount: 1000 },
      aca: { enabled: false }
    },
    taxProfile: {
      ...flatOrdinaryTaxProfile,
      filingStatus: "single",
      childAges: [16],
      qualifyingChildren: 1,
      childTaxCredit: {
        perChild: 100,
        refundablePerChild: 0,
        phaseoutThresholds: { single: 999999 },
        phaseoutPerThousand: 0
      }
    },
    returnSequence: [{ bond: 0 }, { bond: 0 }],
    inflationSequence: [0, 0]
  });

  assert.equal(plan.years[0].qualifyingChildren, 1);
  assert.equal(plan.years[0].taxes.totalTax, 0);
  assert.equal(plan.years[1].qualifyingChildren, 0);
  assert.equal(plan.years[1].taxes.totalTax, 100);
});

test("Additional Child Tax Credit appears as refundable cash in simulated years", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      units: 50_000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 30_000,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      currentAge: 40,
      medicareWages: 20_000,
      earnedIncomeInflationAdjusted: false,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      aca: { enabled: false }
    },
    taxProfile: buildTaxProfile({
      taxYear: 2026,
      filingStatus: "marriedFilingJointly",
      state: "Florida",
      qualifyingChildren: 2
    }),
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  const year = plan.years[0];
  assert.equal(year.taxes.additionalChildTaxCredit, 2625);
  assert.equal(year.taxes.federalRefundableCredits, 2625);
  assert.equal(year.taxes.employeePayrollTax, 1530);
  assert.equal(year.taxes.totalTax, -1095);
  assert.equal(year.taxRefundCash, 1095);
  assert.ok(year.flows.some((flow) => (
    flow.from === "Tax refund"
    && flow.to === "Spending reserve"
    && flow.amount === 1095
  )));
});

test("age 65 additional standard deduction applies by simulated age", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 5000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 2,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 64,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, annualAmount: 2000 },
      aca: { enabled: false }
    },
    taxProfile: {
      ...flatOrdinaryTaxProfile,
      filingStatus: "single",
      additionalStandardDeduction65: { unmarried: 1000, married: 800 }
    },
    returnSequence: [{ bond: 0 }, { bond: 0 }],
    inflationSequence: [0, 0]
  });

  assert.equal(plan.years[0].age65AdditionalDeduction, 0);
  assert.equal(plan.years[0].taxes.totalTax, 200);
  assert.equal(plan.years[1].age65AdditionalDeduction, 1000);
  assert.equal(plan.years[1].taxes.totalTax, 100);
});

test("enhanced senior deduction is MAGI-based and expires after 2028", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 60_000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 4,
      startYear: 2026,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 64,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, annualAmount: 10_000 },
      aca: { enabled: false }
    },
    taxProfile: {
      ...flatOrdinaryTaxProfile,
      filingStatus: "single",
      additionalStandardDeduction65: { unmarried: 1_000, married: 800 },
      enhancedSeniorDeduction: {
        effectiveStartYear: 2025,
        effectiveEndYear: 2028,
        amountPerEligiblePerson: 6_000,
        phaseoutRate: 0.06,
        phaseoutThresholds: {
          single: 75_000,
          marriedFilingJointly: 150_000,
          marriedFilingSeparately: null,
          headOfHousehold: 75_000
        }
      }
    },
    returnSequence: [{ bond: 0 }, { bond: 0 }, { bond: 0 }, { bond: 0 }],
    inflationSequence: [0, 0, 0, 0]
  });

  assert.equal(plan.years[0].year, 2026);
  assert.equal(plan.years[0].age65AdditionalDeduction, 0);
  assert.equal(plan.years[0].enhancedSeniorDeduction, 0);
  assert.equal(plan.years[0].taxes.totalTax, 1000);

  assert.equal(plan.years[1].year, 2027);
  assert.equal(plan.years[1].age65AdditionalDeduction, 1000);
  assert.equal(plan.years[1].enhancedSeniorDeduction, 6000);
  assert.equal(plan.years[1].taxes.totalTax, 300);

  assert.equal(plan.years[2].year, 2028);
  assert.equal(plan.years[2].enhancedSeniorDeduction, 6000);
  assert.equal(plan.years[2].taxes.totalTax, 300);

  assert.equal(plan.years[3].year, 2029);
  assert.equal(plan.years[3].age65AdditionalDeduction, 1000);
  assert.equal(plan.years[3].enhancedSeniorDeduction, 0);
  assert.equal(plan.years[3].taxes.totalTax, 900);
});

test("RMDs force traditional-account distributions and retain unspent cash", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 2650,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 73,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].rmdAmount, 100);
  assert.deepEqual(
    plan.years[0].sales.map((sale) => sale.withdrawalPurpose),
    ["rmd"],
    "forced RMD sales must retain their purpose so user-facing actions can avoid duplicate instructions"
  );
  assert.equal(plan.years[0].unspentCash, 100);
  assert.equal(plan.endingAccounts.traditional, 2550);
  assert.equal(plan.endingAccounts.taxable, 100);
});

test("RMD sale tagging preserves additional traditional withdrawal actions", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 2650,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 150,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 73,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.deepEqual(
    plan.years[0].sales.map((sale) => [sale.proceeds, sale.withdrawalPurpose ?? null]),
    [[100, "rmd"], [50, null]]
  );
});

test("Social Security benefits create cash and taxable ordinary income by provisional income", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 50000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 62,
      socialSecurityAnnualBenefit: 20000,
      socialSecurityStartAge: 62,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, annualAmount: 30000 },
      aca: { enabled: false }
    },
    taxProfile: {
      ...flatOrdinaryTaxProfile,
      filingStatus: "single",
      socialSecurityTaxation: {
        baseAmounts: { single: 25000 },
        adjustedBaseAmounts: { single: 34000 },
        taxableShareLow: 0.5,
        taxableShareHigh: 0.85
      }
    },
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].socialSecurityBenefits, 20000);
  assert.equal(plan.years[0].taxableSocialSecurity, 9600);
  assert.equal(plan.years[0].cashAvailable, 20000);
  assert.ok(plan.years[0].taxAttribution.some((item) => item.source === "Social Security benefits"));
});

test("Medicare IRMAA uses two-year lookback MAGI once Medicare age starts", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 20000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: false,
      withdrawalOrder: ["taxable"],
      currentAge: 65,
      spouseAge: 65,
      medicalExpensesBase: 0,
      expectedOopMaxUsePercent: 0,
      oopMaxOverride: 0,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false },
      medicare: {
        irmaaEnabled: true,
        twoYearsPriorMagi: 300000
      }
    },
    taxProfile: {
      ...noTaxProfile,
      filingStatus: "marriedFilingJointly"
    },
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].medicare.lookbackMagi, 300000);
  assert.equal(Math.round(plan.years[0].medicare.totalAnnualPremium), 10639);
  assert.equal(Math.round(plan.years[0].medicalCost), 10639);
});

test("Social Security separates ACA MAGI from IRMAA MAGI for Medicare lookback", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 200000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: false,
      withdrawalOrder: ["taxable"],
      currentAge: 65,
      medicalExpensesBase: 0,
      expectedOopMaxUsePercent: 0,
      oopMaxOverride: 0,
      socialSecurityAnnualBenefit: 20000,
      socialSecurityStartAge: 65,
      socialSecurityInflationAdjusted: false,
      oneOffExpenses: [{
        name: "Consulting",
        cashFlowType: "taxableOrdinaryIncome",
        startYear: 1,
        endYear: 1,
        amount: 89500,
        inflationAdjusted: false
      }],
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false },
      rothConversion: { enabled: false },
      aca: { enabled: false },
      medicare: { irmaaEnabled: true }
    },
    taxProfile: {
      ...noTaxProfile,
      filingStatus: "single",
      socialSecurityTaxation: {
        baseAmounts: { single: 25000 },
        adjustedBaseAmounts: { single: 34000 },
        taxableShareLow: 0.5,
        taxableShareHigh: 0.85
      }
    },
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].taxableSocialSecurity, 17000);
  assert.equal(plan.years[0].federalAgi, 106500);
  assert.equal(plan.years[0].irmaaMagi, 106500);
  assert.equal(plan.years[0].acaMagi, 109500);
  assert.equal(plan.years[0].magi, plan.years[0].acaMagi);
  assert.equal(plan.years[0].medicare.lookbackMagi, 106500);
  assert.equal(plan.years[0].medicare.partBMonthlyIrmaa, 0);
});

test("yearly results include beginning and ending asset snapshots", () => {
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      name: "Cash Reserve",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      aca: { enabled: false },
      rothConversion: { enabled: false },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].beginningAssets[0].value, 1000);
  assert.equal(plan.years[0].assets[0].value, 900);
  assert.equal(plan.years[0].assets[0].name, "Cash Reserve");
});

test("yearly results preserve asset class return and inflation assumptions", () => {
  const plan = simulatePlan({
    assets: [{
      id: "tips",
      accountType: "taxable",
      assetClass: "tips",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      aca: { enabled: false },
      rothConversion: { enabled: false },
      taxLossHarvesting: { enabled: false },
      taxGainHarvesting: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ tips: 0.04, crypto: -0.2 }],
    inflationSequence: [0.03]
  });

  assert.equal(plan.years[0].assetClassReturns.tips, 0.04);
  assert.equal(plan.years[0].assetClassReturns.crypto, -0.2);
  assert.equal(plan.years[0].assetClassReturns.inflation, 0.03);
  assert.equal(Math.round(plan.years[0].endingPortfolioValue), 10400);
});

test("Monte Carlo scenarios are deterministic with the same seed", () => {
  const input = {
    assets: [{
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 5,
      targetSpend: 1000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: {
        stock: { mean: 0.05, stdev: 0.1 },
        inflation: { mean: 0.02, stdev: 0.01 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    runs: 5,
    seed: 77
  };

  const first = runMonteCarlo(input);
  const second = runMonteCarlo(input);

  assert.deepEqual(first.summary, second.summary);
  assert.equal(first.scenarios.length, 5);
});

test("Monte Carlo can limit retained scenario timelines without changing summary fields", () => {
  const input = {
    assets: [{
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 2,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: {
        stock: { mean: 0.05, stdev: 0.1 },
        inflation: { mean: 0.02, stdev: 0.01 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    runs: 3,
    seed: 77
  };

  const limited = runMonteCarlo({ ...input, scenarioTimelineLimit: 1 });
  assert.equal(limited.scenarios.length, 3);
  assert.ok(Array.isArray(limited.scenarios[0].years), "first retained path should keep its timeline");
  const expectedLastYearIndex = limited.scenarios[0].years.at(-1).yearIndex;
  assert.equal(limited.scenarios[1].years, undefined, "later paths should be compact");
  assert.equal(limited.scenarios[2].years, undefined, "later paths should be compact");
  assert.equal(limited.scenarios[1].lastYear.yearIndex, expectedLastYearIndex);
  assert.equal(limited.summary.runs, 3);
  assert.equal(typeof limited.summary.successRate, "number");

  const compact = runMonteCarlo({ ...input, scenarioTimelineLimit: 0 });
  assert.ok(compact.scenarios.every((scenarioResult) => scenarioResult.years === undefined));
  assert.ok(compact.scenarios.every((scenarioResult) => scenarioResult.lastYear?.yearIndex === expectedLastYearIndex));
  assert.deepEqual(
    compact.scenarios.map(({ id, success, endingValue, heirValue, depletionYear }) => ({
      id,
      success,
      endingValue,
      heirValue,
      depletionYear
    })),
    runMonteCarlo(input).scenarios.map(({ id, success, endingValue, heirValue, depletionYear }) => ({
      id,
      success,
      endingValue,
      heirValue,
      depletionYear
    }))
  );
});

test("Monte Carlo correlated sampling stays deterministic and changes the sampled path", () => {
  const baseInput = {
    assets: [
      {
        id: "stock",
        accountType: "taxable",
        assetClass: "stock",
        holdingPeriod: "long",
        units: 100,
        price: 100,
        costBasisPerUnit: 100
      },
      {
        id: "bond",
        accountType: "taxable",
        assetClass: "bond",
        holdingPeriod: "long",
        units: 100,
        price: 100,
        costBasisPerUnit: 100
      }
    ],
    scenario: {
      planYears: 2,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: {
        stock: { mean: 0.05, stdev: 0.1 },
        bond: { mean: 0.02, stdev: 0.04 },
        inflation: { mean: 0.02, stdev: 0.01 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    runs: 2,
    seed: 91
  };

  const correlated = runMonteCarlo({
    ...baseInput,
    scenario: {
      ...baseInput.scenario,
      monteCarlo: { samplingMode: "correlated" }
    }
  });
  const correlatedAgain = runMonteCarlo({
    ...baseInput,
    scenario: {
      ...baseInput.scenario,
      monteCarlo: { samplingMode: "correlated" }
    }
  });
  const independent = runMonteCarlo({
    ...baseInput,
    scenario: {
      ...baseInput.scenario,
      monteCarlo: { samplingMode: "independent" }
    }
  });

  assert.deepEqual(correlated, correlatedAgain);
  assert.notDeepEqual(
    correlated.scenarios[0].years[0].assetClassReturns,
    independent.scenarios[0].years[0].assetClassReturns
  );
});

test("Monte Carlo mean-reverting correlated sampling pulls against prior excess returns", () => {
  const baseInput = {
    assets: [
      {
        id: "stock",
        accountType: "taxable",
        assetClass: "stock",
        holdingPeriod: "long",
        units: 100,
        price: 100,
        costBasisPerUnit: 100
      },
      {
        id: "bond",
        accountType: "taxable",
        assetClass: "bond",
        holdingPeriod: "long",
        units: 100,
        price: 100,
        costBasisPerUnit: 100
      }
    ],
    scenario: {
      planYears: 3,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: {
        stock: { mean: 0.05, stdev: 0.1 },
        bond: { mean: 0.02, stdev: 0.04 },
        inflation: { mean: 0.02, stdev: 0.01 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    runs: 1,
    seed: 91
  };

  const correlated = runMonteCarlo({
    ...baseInput,
    scenario: {
      ...baseInput.scenario,
      monteCarlo: { samplingMode: "correlated" }
    }
  });
  const meanReverting = runMonteCarlo({
    ...baseInput,
    scenario: {
      ...baseInput.scenario,
      monteCarlo: {
        samplingMode: "meanRevertingCorrelated",
        meanReversion: {
          shortTermStrength: 1,
          longTermStrength: 0,
          longTermYears: 10
        }
      }
    }
  });

  const correlatedYears = correlated.scenarios[0].years;
  const meanRevertingYears = meanReverting.scenarios[0].years;
  assert.deepEqual(meanRevertingYears[0].assetClassReturns, correlatedYears[0].assetClassReturns);
  assert.notDeepEqual(meanRevertingYears[1].assetClassReturns, correlatedYears[1].assetClassReturns);

  const firstYearStockExcess = correlatedYears[0].assetClassReturns.stock - baseInput.scenario.returnAssumptions.stock.mean;
  const secondYearPlainStock = correlatedYears[1].assetClassReturns.stock;
  const secondYearMeanRevertingStock = meanRevertingYears[1].assetClassReturns.stock;
  assertNear(
    secondYearMeanRevertingStock - secondYearPlainStock,
    -firstYearStockExcess,
    0.000002
  );
});

test("Monte Carlo depletion metadata includes failure year index and age", () => {
  const result = runMonteCarlo({
    assets: [{
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 3,
      startYear: 2030,
      currentAge: 60,
      targetSpend: 7000,
      targetSpendInflationAdjusted: false,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: {
        stock: { mean: 0, stdev: 0 },
        inflation: { mean: 0, stdev: 0 }
      },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    runs: 1,
    seed: 1
  });

  const scenario = result.scenarios[0];
  assert.equal(scenario.success, false);
  assert.equal(scenario.depletionYear, 2031);
  assert.equal(scenario.depletionYearIndex, 2);
  assert.equal(scenario.depletionAge, 61);
  assert.ok(Array.isArray(scenario.diagnostics.stressors));
  assert.ok(scenario.diagnostics.stressors.some((item) => item.id === "spendingPressure"));
  assert.equal(typeof scenario.diagnostics.avgWithdrawalRate, "number");
});

test("cash top-up sells non-preferred accounts before leaving a year unfunded", () => {
  const input = {
    assets: [
      {
        id: "taxable-cash",
        accountType: "taxable",
        assetClass: "cash",
        holdingPeriod: "long",
        units: 100,
        price: 1,
        costBasisPerUnit: 1
      },
      {
        id: "traditional-bond",
        accountType: "traditional",
        assetClass: "bond",
        holdingPeriod: "long",
        units: 1000,
        price: 1,
        costBasisPerUnit: 1
      }
    ],
    scenario: {
      planYears: 2,
      startYear: 2030,
      currentAge: 60,
      targetSpend: 200,
      targetSpendInflationAdjusted: false,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: {
        cash: { mean: 0, stdev: 0 },
        bond: { mean: 0, stdev: 0 },
        inflation: { mean: 0, stdev: 0 }
      },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile
  };

  const plan = simulatePlan({
    ...input,
    returnSequence: [{ cash: 0, bond: 0 }, { cash: 0, bond: 0 }],
    inflationSequence: [0, 0]
  });
  assert.equal(plan.years[0].unfunded, 0);
  assert.equal(plan.years[0].cashAvailable, plan.years[0].totalCashRequired);
  assert.ok(plan.years[0].sales.some((sale) => sale.accountType === "traditional"));
  assert.equal(plan.endingValue, 700);
  assert.equal(plan.success, true);

  const monteCarlo = runMonteCarlo({ ...input, runs: 1, seed: 1 });
  assert.equal(monteCarlo.scenarios[0].success, true);
  assert.equal(monteCarlo.scenarios[0].depletionYear, null);
});

test("cash top-up pays early withdrawal penalties rather than leaving spend unfunded", () => {
  const plan = simulatePlan({
    assets: [{
      id: "traditional-bond",
      accountType: "traditional",
      assetClass: "bond",
      holdingPeriod: "long",
      units: 200,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      startYear: 2030,
      currentAge: 40,
      targetSpend: 100,
      targetSpendInflationAdjusted: false,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: {
        bond: { mean: 0, stdev: 0 },
        inflation: { mean: 0, stdev: 0 }
      },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(plan.years[0].unfunded, 0);
  assert.ok(plan.years[0].penaltyTax > 0);
  assert.ok(plan.years[0].cashAvailable >= plan.years[0].totalCashRequired - 0.01);
  assert.ok(plan.years[0].sales.some((sale) => sale.accountType === "traditional"));
  assert.equal(plan.success, true);
});

test("Roth conversion with earnings withdrawn inside five years is penalized and earnings are taxable", () => {
  const plan = simulatePlan({
    assets: [{
      id: "recent-conversion-with-gain",
      accountType: "roth",
      assetClass: "bond",
      units: 1000,
      price: 2, // doubled
      costBasisPerUnit: 1,
      rothSource: "conversion",
      conversionYear: 2026
    }],
    scenario: {
      startYear: 2028,
      planYears: 1,
      targetSpend: 2000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["roth"],
      currentAge: 50,
      rothBasis: 0,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatOrdinaryTaxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  assert.equal(Math.round(plan.years[0].magi), 1000);
  assert.equal(Math.round(plan.years[0].penaltyTax), 200);
});

test("runHistoricalBacktests processes multiple return sequences", () => {
  const results = runHistoricalBacktests({
    assets: [{
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 1,
      targetSpend: 100,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    sequences: [
      { name: "Seq 1", sourceYears: [1960], returns: [{ stock: 0.1 }], inflation: [0] },
      { name: "Seq 2", sourceYears: [1961], returns: [{ stock: -0.1 }], inflation: [0] }
    ]
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].id, "Seq 1");
  assert.equal(results[1].id, "Seq 2");
  assert.equal(results[0].years[0].historicalSourceYear, 1960);
  assert.equal(Math.round(results[0].endingValue), 10900);
  assert.equal(Math.round(results[1].endingValue), 8900);
});

test("tax attribution includes multiple tax sources", () => {
  const plan = simulatePlan({
    assets: [{
      id: "ira",
      accountType: "traditional",
      assetClass: "bond",
      units: 1000,
      price: 1,
      costBasisPerUnit: 1
    }, {
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      units: 100,
      price: 200,
      costBasisPerUnit: 100,
      dividendYield: 0.05,
      qualifiedDividendShare: 1,
      holdingPeriod: "long"
    }],
    scenario: {
      planYears: 1,
      targetSpend: 5000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional", "taxable"],
      withdrawalStrategy: { mode: "heuristic" },
      currentAge: 65,
      returnAssumptions: { bond: { mean: 0, stdev: 0 }, stock: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: true, annualAmount: 500 },
      taxGainHarvesting: { enabled: true, maxGain: 1000 },
      aca: { enabled: false }
    },
    taxProfile: {
      ...noTaxProfile,
      ordinaryBrackets: [{ upTo: Infinity, rate: 0.1 }],
      capitalGainsBrackets: [{ upTo: Infinity, rate: 0.1 }]
    },
    returnSequence: [{ bond: 0, stock: 0 }],
    inflationSequence: [0]
  });

  const attributionSources = plan.years[0].taxAttribution.map(a => a.source);
  assert.ok(attributionSources.includes("Roth conversion"));
  assert.ok(attributionSources.includes("Traditional withdrawals"));
});

test("harvested lots age back to long-term after a full simulation year", () => {
  // Year 1: tax-gain harvest forces a basis step-up and holding-period
  // reset on the lot. Year 1 sale (also in year 1) would be short.
  // Year 2: the simulator's beginning-of-year aging promotes the lot back
  // to long, so a sale in year 2 is taxed as LTCG.
  // We verify by selling the entire taxable account in year 2 and looking
  // at the realized gain character.
  const flatTax = {
    ...flatOrdinaryTaxProfile,
    capitalGainsBrackets: [{ upTo: Infinity, rate: 0.15 }]
  };
  const plan = simulatePlan({
    assets: [{
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 1000,
      price: 100,
      costBasisPerUnit: 50
    }],
    scenario: {
      planYears: 2,
      targetSpend: 80000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      currentAge: 65,
      startYear: 2026,
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      // Force a tax-gain harvest in year 1 to reset the lot's basis to
      // current price, switching it to "short".
      taxGainHarvesting: { enabled: true, maxGain: 50000 },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: flatTax,
    returnSequence: [{ stock: 0 }, { stock: 0 }],
    inflationSequence: [0, 0]
  });

  // Year 2's sale should produce LT gains, not ST gains, because the
  // harvested lot has aged back to long-term.
  assert.equal(plan.years[1].realizedShortTermGains, 0);
  assert.ok(plan.years[1].realizedLongTermGains > 0);
});

test("missing return assumptions for an asset class are filled with safe defaults (no NaN)", () => {
  // Asset class "private-equity" has no entry in returnAssumptions or
  // DEFAULT_SCENARIO. The simulator must not propagate NaN into prices.
  const plan = simulatePlan({
    assets: [{
      id: "pe",
      accountType: "taxable",
      assetClass: "private-equity",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 3,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      currentAge: 50,
      returnAssumptions: { stock: { mean: 0.05, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    inflationSequence: [0, 0, 0]
  });

  for (const year of plan.years) {
    assert.ok(Number.isFinite(year.endingPortfolioValue), "endingPortfolioValue must be finite");
    assert.ok(year.endingPortfolioValue > 0);
  }
});

test("historical backtests expose paddedYears for short-window sequences", () => {
  const sequences = [
    {
      name: "short-window",
      sourceYears: [2000, 2001, 2002, 2003, 2004, 2000, 2001, 2002, 2003, 2004],
      paddedYears: 5,
      returns: Array.from({ length: 10 }, () => ({ stock: 0.05, bond: 0.03, cash: 0.02 })),
      inflation: Array.from({ length: 10 }, () => 0.02)
    }
  ];
  const results = runHistoricalBacktests({
    assets: [{
      id: "stock",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 1000,
      price: 100,
      costBasisPerUnit: 100
    }],
    scenario: {
      planYears: 10,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      currentAge: 60,
      returnAssumptions: { stock: { mean: 0.05, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false }
    },
    taxProfile: noTaxProfile,
    sequences
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].paddedYears, 5);
  // The last 5 years should be flagged as padded.
  assert.equal(results[0].years[4].historicalPaddedYear, false);
  assert.equal(results[0].years[5].historicalPaddedYear, true);
  assert.equal(results[0].years[9].historicalPaddedYear, true);
});

test("combined target marginal rate deducts state marginal from federal ceiling", () => {
  // With combinedTargetMarginalRate=0.20 and a state rate of 0.05, the
  // optimizer should target the federal bracket boundary at <= 0.15, not
  // 0.20. With a 0.10/0.20/0.30 ordinary bracket schedule, that means
  // converting up to the top of the 0.10 bracket — not the 0.20 bracket.
  const taxProfile = {
    ...noTaxProfile,
    ordinaryBrackets: [
      { upTo: 10000, rate: 0.1 },
      { upTo: 50000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 }
    ],
    state: {
      standardDeduction: 0,
      brackets: [{ upTo: Infinity, rate: 0.05 }],
      treatCapitalGainsAsOrdinary: true
    }
  };
  const plan = simulatePlan({
    assets: [{
      id: "ira-bond",
      accountType: "traditional",
      assetClass: "bond",
      units: 200000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["traditional"],
      currentAge: 65,
      returnAssumptions: { bond: { mean: 0, stdev: 0 } },
      rothConversion: {
        enabled: true,
        mode: "auto",
        combinedTargetMarginalRate: 0.20
      },
      aca: { enabled: false }
    },
    taxProfile,
    returnSequence: [{ bond: 0 }],
    inflationSequence: [0]
  });

  // Federal target = 0.20 - 0.05 = 0.15. Highest bracket ≤ 0.15 is the 0.10
  // bracket whose ceiling is 10000. Conversion ≈ 10000.
  assert.equal(plan.years[0].rothConversionAmount, 10000);
});

test("capital loss netting on AGI in simulation", () => {
  // Verify that AGI, ACA MAGI, and IRMAA MAGI correctly net capital gains and losses,
  // applying the Schedule D $3,000 ordinary income offset ceiling, and carrying forward.
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-loss",
        accountType: "taxable",
        assetClass: "stock",
        holdingPeriod: "long",
        units: 100,
        price: 1,
        costBasisPerUnit: 100 // $99 loss per unit * 100 = $9900 unrealized loss
      }
    ],
    scenario: {
      planYears: 2,
      targetSpend: 50, // sells 50 units, realizing $4950 of long-term capital loss
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: false,
      withdrawalOrder: ["taxable"],
      currentAge: 60,
      oneOffExpenses: [
        {
          name: "Consulting Year 1",
          cashFlowType: "taxableOrdinaryIncome",
          startYear: 1,
          endYear: 1,
          amount: 10000,
          inflationAdjusted: false
        },
        {
          name: "Expense Year 1",
          cashFlowType: "expense",
          startYear: 1,
          endYear: 1,
          amount: 10000,
          inflationAdjusted: false
        },
        {
          name: "Consulting Year 2",
          cashFlowType: "taxableOrdinaryIncome",
          startYear: 2,
          endYear: 2,
          amount: 10000,
          inflationAdjusted: false
        },
        {
          name: "Expense Year 2",
          cashFlowType: "expense",
          startYear: 2,
          endYear: 2,
          amount: 10000,
          inflationAdjusted: false
        }
      ],
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false },
      taxLossHarvesting: { enabled: false }
    },
    taxProfile: {
      ...noTaxProfile,
      capitalLossOrdinaryIncomeOffset: 3000,
      ordinaryBrackets: [{ upTo: Infinity, rate: 0 }]
    },
    returnSequence: [{ stock: 0 }, { stock: 0 }],
    inflationSequence: [0, 0]
  });

  // Year 1:
  // Ordinary Income = 10000
  // Realized Loss = 50 * (100 - 1) = 4950.
  // Netting: offsets ordinary income up to 3000.
  // AGI/MAGI = 10000 - 3000 = 7000.
  // Carryforward remaining loss = 4950 - 3000 = 1950.
  assert.equal(plan.years[0].magi, 7000);
  assert.equal(plan.years[0].taxes.lossCarryforward, 1950);

  // Year 2:
  // Start with 1950 loss carryforward.
  // Ordinary Income = 10000
  // Sells remaining 50 units (under 0 return assumption).
  // Realized Loss = 50 * (100 - 1) = 4950.
  // Total long-term loss pool = 1950 (carryforward) + 4950 (new loss) = 6900.
  // Offset ordinary income = 3000.
  // AGI/MAGI = 10000 - 3000 = 7000.
  // New carryforward = 6900 - 3000 = 3900.
  assert.equal(plan.years[1].magi, 7000);
  assert.equal(plan.years[1].taxes.lossCarryforward, 3900);
});

test("capital loss carryforward in simulation preserves loss unused after deductions", () => {
  const plan = simulatePlan({
    assets: [
      {
        id: "taxable-loss",
        accountType: "taxable",
        assetClass: "stock",
        holdingPeriod: "long",
        units: 100,
        price: 1,
        costBasisPerUnit: 101
      }
    ],
    scenario: {
      planYears: 1,
      targetSpend: 60,
      targetSpendIncludesTaxes: false,
      targetSpendIncludesMedical: false,
      withdrawalOrder: ["taxable"],
      currentAge: 60,
      oneOffExpenses: [
        {
          name: "Consulting",
          cashFlowType: "taxableOrdinaryIncome",
          startYear: 1,
          endYear: 1,
          amount: 6500,
          inflationAdjusted: false
        },
        {
          name: "Living expense bridge",
          cashFlowType: "expense",
          startYear: 1,
          endYear: 1,
          amount: 6500,
          inflationAdjusted: false
        }
      ],
      returnAssumptions: { stock: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false },
      taxLossHarvesting: { enabled: false }
    },
    taxProfile: {
      ...noTaxProfile,
      standardDeduction: 4000,
      capitalLossOrdinaryIncomeOffset: 3000,
      ordinaryBrackets: [{ upTo: Infinity, rate: 0 }]
    },
    returnSequence: [{ stock: 0 }],
    inflationSequence: [0]
  });

  // The $60 sale realizes a $6,000 LT loss. Schedule D line 21 deducts $3,000,
  // but the $4,000 standard deduction means only $2,500 of that loss is
  // absorbed on the carryover worksheet; $3,500 remains long-term carryforward.
  assert.equal(plan.years[0].magi, 3500);
  assert.equal(plan.years[0].taxes.lossCarryforward, 3500);
  assert.deepEqual(plan.years[0].lossCarryforwardDetail, { shortTerm: 0, longTerm: 3500 });
});

test("Medicare split-eligibility premium computation (65+ spouse when primary is under 65)", () => {
  // Primary (62) is not eligible, spouse (65) is eligible.
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 20000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: false,
      withdrawalOrder: ["taxable"],
      currentAge: 62,
      spouseAge: 65,
      medicalExpensesBase: 0,
      expectedOopMaxUsePercent: 0,
      oopMaxOverride: 0,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: { enabled: false },
      medicare: {
        irmaaEnabled: true,
        twoYearsPriorMagi: 100000 // In the base bracket
      }
    },
    taxProfile: {
      ...noTaxProfile,
      filingStatus: "marriedFilingJointly"
    },
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  // Only the spouse is 65+, so the premium covers 1 enrollee at the base bracket
  // (twoYearsPriorMagi 100000 is below the MFJ first-tier threshold of 218000).
  // 2026 Part B standard premium = 202.9/mo, Part D base premium unset (0).
  // Annual = 202.9 * 12 * 1 = 2434.8.
  assert.equal(plan.years[0].medicare.partBEnrollees, 1);
  assert.equal(plan.years[0].medicare.partDEnrollees, 1);
  assert.equal(plan.years[0].medicare.partBMonthlyIrmaa, 0);
  assert.equal(plan.years[0].medicare.totalAnnualPremium, 2434.8);
});

test("ACA split-eligibility household transition (younger spouse rating factor preserved; 65+ partner rating factor excluded)", () => {
  // With spouse Age 65+, their rating factor must be excluded (treated as 0) from the ACA premium rating curve,
  // while the younger spouse (64) is rated.
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 20000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 1,
      targetSpend: 0,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      currentAge: 64,
      spouseAge: 65,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      rothConversion: { enabled: false },
      aca: {
        enabled: true,
        fpl: 20000,
        benchmarkPremium: 10000, // base premium for a reference age of 21
        ageRatedBenchmarkPremium: true,
        benchmarkPremiumReferenceAge: 21,
        memberAges: [64, 65],
        benchmarkPremiumReferenceAges: [21, 21],
        maxEligibleFplPercent: 400,
        applicablePercentageTable: [
          { minFplPercent: 0, maxFplPercent: 400, initialRate: 0.1, finalRate: 0.1 }
        ]
      }
    },
    taxProfile: {
      ...noTaxProfile,
      filingStatus: "marriedFilingJointly"
    },
    returnSequence: [{ cash: 0 }],
    inflationSequence: [0]
  });

  // Because spouse is 65, they are excluded from the current rating curve factor.
  // Only the 64-year-old rating factor is counted.
  // Reference ages are [21, 21] (both under 65, so both counted).
  // Total current rating / total reference rating will be ageRating(64) / (ageRating(21) + ageRating(21)).
  // Age 64 rating factor is 3.0. Age 21 rating factor is 1.0.
  // So currentRatingTotal = 3.0. referenceRatingTotal = 1.0 + 1.0 = 2.0.
  // Ratio is 3.0 / 2.0 = 1.5.
  // Adjusted premium = 10000 * 1.5 = 15000.
  assert.equal(plan.years[0].aca.benchmarkPremium, 15000);
});

test("ACA survivor years shrink tax-family size and marketplace-covered members after spouse death", () => {
  const aca = buildAcaConfig({
    taxYear: 2026,
    state: "Florida",
    householdSize: 2,
    marketplaceMembers: 2,
    currentAge: 62,
    memberAges: [62, 62]
  });
  const plan = simulatePlan({
    assets: [{
      id: "cash",
      accountType: "taxable",
      assetClass: "cash",
      holdingPeriod: "long",
      units: 500000,
      price: 1,
      costBasisPerUnit: 1
    }],
    scenario: {
      planYears: 2,
      targetSpend: 90000,
      targetSpendIncludesTaxes: true,
      targetSpendIncludesMedical: true,
      withdrawalOrder: ["taxable"],
      currentAge: 62,
      spouseAge: 62,
      primaryMortalityAge: 95,
      spouseMortalityAge: 62,
      medicareWages: 30000,
      earnedIncomeInflationAdjusted: false,
      returnAssumptions: { cash: { mean: 0, stdev: 0 } },
      rmd: { enabled: false },
      rothConversion: { enabled: false },
      taxGainHarvesting: { enabled: false },
      taxLossHarvesting: { enabled: false },
      aca
    },
    taxProfile: {
      ...noTaxProfile,
      filingStatus: "marriedFilingJointly"
    },
    returnSequence: [{ cash: 0 }, { cash: 0 }],
    inflationSequence: [0, 0]
  });

  assert.equal(plan.years[0].filingStatus, "marriedFilingJointly");
  assert.equal(plan.years[1].filingStatus, "single");
  assert.equal(plan.years[0].aca.householdSize, 2);
  assert.equal(plan.years[1].aca.householdSize, 1);
  assert.equal(plan.years[0].aca.marketplaceMembers, 2);
  assert.equal(plan.years[1].aca.marketplaceMembers, 1);
  assertNear(plan.years[0].aca.fplPercent, 30000 / 21150 * 100, 0.001);
  assertNear(plan.years[1].aca.fplPercent, 30000 / 15650 * 100, 0.001);
  assert.ok(plan.years[1].aca.benchmarkPremium < plan.years[0].aca.benchmarkPremium);
  assert.equal(plan.years[1].aca.oopMaximum, aca.costSharingLimit.selfOnly);
});

function round6(value) {
  return Math.round(value * 1000000) / 1000000;
}
