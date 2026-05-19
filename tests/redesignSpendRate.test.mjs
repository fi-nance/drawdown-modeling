import assert from "node:assert/strict";
import test from "node:test";

let elements = {};

globalThis.document = {
  readyState: "loading",
  addEventListener() {},
  getElementById(id) {
    return elements[id] ?? null;
  }
};

const { allInAnnualSpend, allInSpendRate } = await import("../src/redesign.mjs?redesign-spend-rate-test");

const latest = {
  plan: {
    years: [
      {
        beginningPortfolioValue: 2_000_000,
        inflationIndex: 1,
        taxes: { totalTax: 20_000 },
        medicalCost: 10_000
      },
      {
        beginningPortfolioValue: 1_900_000,
        inflationIndex: 1.1,
        taxes: { totalTax: 22_000 },
        medicalCost: 11_000
      }
    ]
  }
};

test("all-in spend rate includes average yearly taxes and healthcare", () => {
  elements = {
    targetSpend: { value: "90000" },
    viewMode: { value: "real" },
    includeTaxes: { checked: false },
    includeMedical: { checked: false }
  };

  assert.equal(allInAnnualSpend(latest), 120_000);
  assert.equal(allInSpendRate(latest), 0.06);
});

test("all-in spend rate does not double-count costs already included in target spend", () => {
  elements = {
    targetSpend: { value: "90000" },
    viewMode: { value: "real" },
    includeTaxes: { checked: true },
    includeMedical: { checked: false }
  };

  assert.equal(allInAnnualSpend(latest), 100_000);
  assert.equal(allInSpendRate(latest), 0.05);
});

test("all-in spend rate follows nominal display mode for averaged costs", () => {
  elements = {
    targetSpend: { value: "90000" },
    viewMode: { value: "nominal" },
    includeTaxes: { checked: false },
    includeMedical: { checked: false }
  };

  assert.equal(allInAnnualSpend(latest), 121_500);
  assert.equal(allInSpendRate(latest), 0.06075);
});
