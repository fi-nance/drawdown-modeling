import { EPSILON, round, sumBy } from "./utils.mjs";

export function clonePortfolio(assets = []) {
  return assets.map((asset) => ({ ...asset }));
}

export function portfolioValue(assets = []) {
  return round(sumBy(assets, (asset) => marketValue(asset)), 6);
}

export function marketValue(asset) {
  return Math.max(0, asset.units ?? 0) * Math.max(0, asset.price ?? 0);
}

export function accountBreakdown(assets = []) {
  return assets.reduce((accounts, asset) => {
    accounts[asset.accountType] = round((accounts[asset.accountType] ?? 0) + marketValue(asset), 6);
    return accounts;
  }, {});
}

export function applyReturns(assets = [], returnsByAssetClass = {}) {
  for (const asset of assets) {
    const annualReturn = returnsByAssetClass[asset.assetClass] ?? returnsByAssetClass.default ?? 0;
    asset.price = round(Math.max(0, asset.price * (1 + annualReturn)), 8);
  }
}

export function sellFromLot(lot, requestedProceeds) {
  if ((lot.price ?? 0) <= 0 || (lot.units ?? 0) <= 0 || requestedProceeds <= 0) {
    return emptySale(lot);
  }

  const available = marketValue(lot);
  const proceeds = Math.min(requestedProceeds, available);
  const unitsSold = proceeds / lot.price;
  const costBasisSold = unitsSold * (lot.costBasisPerUnit ?? lot.price);
  lot.units = Math.max(0, lot.units - unitsSold);

  if (lot.units < EPSILON) lot.units = 0;

  const taxableGain = proceeds - costBasisSold;
  const taxType = classifySale(lot, taxableGain, proceeds);
  const gain = taxType === "ordinary" && lot.accountType === "traditional"
    ? proceeds
    : taxType === "none"
      ? 0
      : taxableGain;

  return {
    assetId: lot.id,
    name: lot.name ?? lot.id,
    accountType: lot.accountType,
    proceeds: round(proceeds, 6),
    unitsSold: round(unitsSold, 8),
    costBasisSold: round(costBasisSold, 6),
    gain: round(gain, 6),
    taxType,
    rothSource: lot.rothSource,
    conversionYear: lot.conversionYear
  };
}

export function dividendIncome(assets = []) {
  const result = {
    cash: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    flows: []
  };

  for (const asset of assets) {
    const dividend = marketValue(asset) * (asset.dividendYield ?? 0);
    if (dividend <= EPSILON) continue;

    if (asset.accountType === "taxable") {
      const qualified = dividend * (asset.qualifiedDividendShare ?? 0);
      const ordinary = dividend - qualified;
      result.cash += dividend;
      result.ordinaryDividends += ordinary;
      result.qualifiedDividends += qualified;
      result.flows.push({
        from: asset.name ?? asset.id,
        to: "Taxable dividends",
        amount: round(dividend, 6),
        type: "income"
      });
    } else {
      asset.units += dividend / asset.price;
    }
  }

  result.cash = round(result.cash, 6);
  result.ordinaryDividends = round(result.ordinaryDividends, 6);
  result.qualifiedDividends = round(result.qualifiedDividends, 6);
  return result;
}

export function harvestTaxLosses(assets = [], maxLoss = Infinity) {
  let remaining = Math.max(0, maxLoss);
  let realizedLosses = 0;
  const flows = [];

  for (let index = 0; index < assets.length && remaining > EPSILON; index += 1) {
    const asset = assets[index];
    if (asset.accountType !== "taxable" || marketValue(asset) <= EPSILON) continue;
    const lossPerUnit = (asset.costBasisPerUnit ?? asset.price) - asset.price;
    if (lossPerUnit <= EPSILON) continue;

    const fullLoss = lossPerUnit * asset.units;
    const lossToHarvest = Math.min(fullLoss, remaining);
    const unitsToHarvest = lossToHarvest / lossPerUnit;
    resetBasisForHarvestedUnits(assets, asset, unitsToHarvest, asset.price, "tlh");

    realizedLosses += lossToHarvest;
    remaining -= lossToHarvest;
    flows.push({
      from: asset.name ?? asset.id,
      to: "Tax loss harvesting",
      amount: round(lossToHarvest, 6),
      type: "tax"
    });
  }

  return {
    realizedLosses: round(realizedLosses, 6),
    flows
  };
}

export function harvestTaxGains(assets = [], maxGain = Infinity) {
  let remaining = Math.max(0, maxGain);
  let realizedGains = 0;
  const flows = [];

  for (let index = 0; index < assets.length && remaining > EPSILON; index += 1) {
    const asset = assets[index];
    if (asset.accountType !== "taxable" || asset.holdingPeriod === "short" || marketValue(asset) <= EPSILON) {
      continue;
    }
    const gainPerUnit = asset.price - (asset.costBasisPerUnit ?? asset.price);
    if (gainPerUnit <= EPSILON) continue;

    const fullGain = gainPerUnit * asset.units;
    const gainToHarvest = Math.min(fullGain, remaining);
    const unitsToHarvest = gainToHarvest / gainPerUnit;
    resetBasisForHarvestedUnits(assets, asset, unitsToHarvest, asset.price, "tgh");

    realizedGains += gainToHarvest;
    remaining -= gainToHarvest;
    flows.push({
      from: asset.name ?? asset.id,
      to: "Tax gain harvesting",
      amount: round(gainToHarvest, 6),
      type: "tax"
    });
  }

  return {
    realizedGains: round(realizedGains, 6),
    flows
  };
}

export function removeEmptyLots(assets) {
  for (let index = assets.length - 1; index >= 0; index -= 1) {
    if ((assets[index].units ?? 0) <= EPSILON || (assets[index].price ?? 0) <= 0) {
      assets.splice(index, 1);
    }
  }
}

function classifySale(lot, taxableGain, proceeds) {
  if (lot.accountType === "traditional") return "ordinary";
  if (lot.accountType === "roth" || lot.accountType === "hsa") return "none";
  if (lot.accountType !== "taxable") return "none";
  if (taxableGain < -EPSILON) return "capital-loss";
  if (lot.assetClass === "cash" || Math.abs(taxableGain) <= EPSILON) return "none";
  return lot.holdingPeriod === "short" ? "ordinary" : "capital-gains";
}

function emptySale(lot) {
  return {
    assetId: lot?.id,
    name: lot?.name ?? lot?.id,
    accountType: lot?.accountType,
    proceeds: 0,
    unitsSold: 0,
    costBasisSold: 0,
    gain: 0,
    taxType: "none"
  };
}

function resetBasisForHarvestedUnits(assets, asset, unitsToHarvest, newBasis, suffix) {
  if (unitsToHarvest >= asset.units - EPSILON) {
    asset.costBasisPerUnit = round(newBasis, 8);
    return;
  }

  asset.units = round(asset.units - unitsToHarvest, 8);
  assets.push({
    ...asset,
    id: `${asset.id}-${suffix}-${assets.length + 1}`,
    name: `${asset.name ?? asset.id} ${suffix.toUpperCase()}`,
    units: round(unitsToHarvest, 8),
    costBasisPerUnit: round(newBasis, 8)
  });
}
