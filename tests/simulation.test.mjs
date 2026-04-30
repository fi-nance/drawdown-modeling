import assert from "node:assert/strict";
import test from "node:test";

import { runMonteCarlo, simulatePlan } from "../src/core/simulation.mjs";

const noTaxProfile = {
  standardDeduction: 0,
  capitalLossOrdinaryIncomeOffset: 3000,
  ordinaryBrackets: [{ upTo: Infinity, rate: 0 }],
  capitalGainsBrackets: [{ upTo: Infinity, rate: 0 }],
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
    flow.from === "Roth conversion" && flow.to === "Roth conversion tax"
  ));

  assert.equal(Math.round(conversionTax.amount), 10);
  assert.equal(Math.round(conversionTaxFlow.amount), 10);
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
      targetSpendIncludesMedical: true,
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
      targetSpendIncludesMedical: true,
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

function round6(value) {
  return Math.round(value * 1000000) / 1000000;
}
