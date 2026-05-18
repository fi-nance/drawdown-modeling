export const sampleAssets = [
  {
    id: "taxable-us-total-market",
    name: "Taxable US Total Market",
    accountType: "taxable",
    assetClass: "stock",
    holdingPeriod: "long",
    units: 6300,
    price: 100,
    costBasisPerUnit: 62,
    dividendYield: 0.018,
    qualifiedDividendShare: 0.95
  },
  {
    id: "taxable-international",
    name: "Taxable International",
    accountType: "taxable",
    assetClass: "stock",
    holdingPeriod: "long",
    units: 3150,
    price: 80,
    costBasisPerUnit: 92,
    dividendYield: 0.032,
    qualifiedDividendShare: 0.75
  },
  {
    id: "taxable-cash",
    name: "Taxable Cash Reserve",
    accountType: "taxable",
    assetClass: "cash",
    holdingPeriod: "long",
    units: 245000,
    price: 1,
    costBasisPerUnit: 1,
    dividendYield: 0.02,
    qualifiedDividendShare: 0
  },
  {
    id: "traditional-balanced",
    name: "Traditional Balanced Fund",
    accountType: "traditional",
    assetClass: "bond",
    units: 9100,
    price: 100,
    costBasisPerUnit: 100,
    dividendYield: 0.025,
    qualifiedDividendShare: 0
  },
  {
    id: "roth-growth",
    name: "Roth Growth Fund",
    accountType: "roth",
    assetClass: "stock",
    units: 3850,
    price: 120,
    costBasisPerUnit: 120,
    dividendYield: 0.005,
    qualifiedDividendShare: 1
  },
  {
    id: "hsa-index",
    name: "HSA Index Fund",
    accountType: "hsa",
    assetClass: "stock",
    units: 630,
    price: 100,
    costBasisPerUnit: 100,
    dividendYield: 0.01,
    qualifiedDividendShare: 1
  }
];

export const defaultOneOffExpenses = [];

export function makeStressSequences(years) {
  return [
    {
      name: "Mean return path",
      returns: sequence(years, [
        { stock: 0.071, bond: 0.049, cash: 0.033, realEstate: 0.081 }
      ]),
      inflation: repeat(years, 0.024)
    },
    {
      name: "Early bear market",
      returns: sequence(years, [
        { stock: -0.32, bond: 0.04, cash: 0.02, realEstate: -0.18 },
        { stock: -0.18, bond: 0.02, cash: 0.02, realEstate: -0.08 },
        { stock: 0.09, bond: 0.01, cash: 0.015, realEstate: 0.02 },
        { stock: 0.12, bond: 0.025, cash: 0.015, realEstate: 0.05 }
      ]),
      inflation: sequenceValues(years, [0.035, 0.032, 0.028, 0.025])
    },
    {
      name: "Lost decade",
      returns: sequence(years, [
        { stock: -0.08, bond: 0.045, cash: 0.02, realEstate: 0.01 },
        { stock: 0.02, bond: 0.035, cash: 0.018, realEstate: 0.0 },
        { stock: -0.04, bond: 0.04, cash: 0.018, realEstate: -0.02 },
        { stock: 0.06, bond: 0.03, cash: 0.016, realEstate: 0.03 }
      ]),
      inflation: sequenceValues(years, [0.03, 0.028, 0.026, 0.024])
    },
    {
      name: "Inflation shock",
      returns: sequence(years, [
        { stock: -0.12, bond: -0.08, cash: 0.035, realEstate: 0.02 },
        { stock: 0.04, bond: -0.02, cash: 0.04, realEstate: 0.04 },
        { stock: 0.08, bond: 0.025, cash: 0.03, realEstate: 0.05 }
      ]),
      inflation: sequenceValues(years, [0.075, 0.065, 0.045, 0.032, 0.028])
    }
  ];
}

function sequence(years, pattern) {
  return Array.from({ length: years }, (_, index) => pattern[index % pattern.length]);
}

function repeat(years, value) {
  return Array.from({ length: years }, () => value);
}

function sequenceValues(years, pattern) {
  return Array.from({ length: years }, (_, index) => pattern[index % pattern.length]);
}
