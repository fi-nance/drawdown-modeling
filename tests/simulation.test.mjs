import assert from "node:assert/strict";
import test from "node:test";

import { runMonteCarlo, simulatePlan, runHistoricalBacktests } from "../src/core/simulation.mjs";

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

test("automatic Roth conversions stop at the next ACA MAGI band", () => {
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

  assert.equal(plan.years[0].rothConversionAmount, 26600);
  assert.equal(plan.years[0].acaMagiCeilingFplPercent, 133);
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

test("Roth basis is preserved when modeled savings are below the hurdle", () => {
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
  assert.equal(Math.round(plan.years[0].magi), 100);
  assert.equal(Math.round(plan.years[0].taxes.totalTax), 20);
  assert.equal(Math.round(plan.years[0].rothWithdrawals), 0);
  assert.equal(Math.round(plan.years[0].rothBasisUsed), 0);
  assert.equal(plan.years[0].rothBasisOptimization.accepted, false);
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.modeledSavings), 20);
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.requiredSavings), 50);
});

test("Roth basis is used when ACA savings clear the 50 percent hurdle", () => {
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
        maxEligibleFplPercent: 400
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
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.requiredSavings), 45000);
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
        maxEligibleFplPercent: 400
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
  assert.equal(plan.years[0].unspentCash, 100);
  assert.equal(plan.endingAccounts.traditional, 2550);
  assert.equal(plan.endingAccounts.taxable, 100);
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
      { name: "Seq 1", returns: [{ stock: 0.1 }], inflation: [0] },
      { name: "Seq 2", returns: [{ stock: -0.1 }], inflation: [0] }
    ]
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].id, "Seq 1");
  assert.equal(results[1].id, "Seq 2");
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

function round6(value) {
  return Math.round(value * 1000000) / 1000000;
}
