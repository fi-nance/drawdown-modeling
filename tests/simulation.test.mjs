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

function assertNear(actual, expected, tolerance = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

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

test("Roth basis is preserved when only income-tax savings are below the hurdle", () => {
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
  assert.equal(Math.round(plan.years[0].rothBasisOptimization.requiredSavings), 50);
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
  assert.equal(plan.years[0].rothConversionAmount, 80000);
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

function round6(value) {
  return Math.round(value * 1000000) / 1000000;
}
