import { EPSILON, round, sumBy } from "./utils.mjs";

const MIN_PRICE_FACTOR_AFTER_INCOME_SPLIT = 1e-8;

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
    const annualReturn = totalReturnForAsset(asset, returnsByAssetClass);
    asset.price = round(Math.max(0, Math.max(0, asset.price ?? 0) * (1 + annualReturn)), 8);
  }
}

export function applyTotalReturnsWithIncome(assets = [], returnsByAssetClass = {}) {
  const result = emptyDividendResult();

  for (const asset of assets) {
    const startingPrice = Math.max(0, asset.price ?? 0);
    const startingUnits = Math.max(0, asset.units ?? 0);
    const totalReturn = totalReturnForAsset(asset, returnsByAssetClass);

    if (startingPrice <= EPSILON || startingUnits <= EPSILON) {
      asset.price = round(Math.max(0, startingPrice * (1 + totalReturn)), 8);
      continue;
    }

    const incomeReturn = incomeReturnForTotalReturn(asset, totalReturn);
    const priceReturn = totalReturn - incomeReturn;
    asset.price = round(Math.max(0, startingPrice * (1 + priceReturn)), 8);

    const dividend = round(startingPrice * startingUnits * incomeReturn, 6);
    if (dividend <= EPSILON) continue;

    if (asset.accountType === "taxable") {
      addTaxableDividend(result, asset, dividend);
    } else if (asset.price > EPSILON) {
      asset.units = round(asset.units + dividend / asset.price, 8);
    }
  }

  return finalizeDividendResult(result);
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
    assetClass: lot.assetClass,
    beneficiaryType: lot.beneficiaryType,
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
  const result = emptyDividendResult();

  for (const asset of assets) {
    const dividend = marketValue(asset) * (asset.dividendYield ?? 0);
    if (dividend <= EPSILON) continue;

    if (asset.accountType === "taxable") {
      addTaxableDividend(result, asset, dividend);
    } else if ((asset.price ?? 0) > EPSILON) {
      asset.units += dividend / asset.price;
    }
  }

  return finalizeDividendResult(result);
}

function totalReturnForAsset(asset, returnsByAssetClass) {
  return returnsByAssetClass[asset.assetClass] ?? returnsByAssetClass.default ?? 0;
}

function incomeReturnForTotalReturn(asset, totalReturn) {
  const rawIncomeReturn = Math.max(0, Number(asset.dividendYield) || 0);
  if (rawIncomeReturn <= EPSILON) return 0;
  if (1 + totalReturn <= 0) return 0;
  const maxIncomeReturn = Math.max(0, 1 + totalReturn - MIN_PRICE_FACTOR_AFTER_INCOME_SPLIT);
  return Math.min(rawIncomeReturn, maxIncomeReturn);
}

function emptyDividendResult() {
  return {
    cash: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    flows: [],
    details: []
  };
}

function addTaxableDividend(result, asset, dividend) {
  const qualified = dividend * qualifiedDividendShareFor(asset);
  const ordinary = dividend - qualified;
  result.cash += dividend;
  result.ordinaryDividends += ordinary;
  result.qualifiedDividends += qualified;
  result.details.push({
    assetId: asset.id,
    name: asset.name ?? asset.id,
    accountType: asset.accountType,
    dividend: round(dividend, 6),
    ordinaryDividends: round(ordinary, 6),
    qualifiedDividends: round(qualified, 6)
  });
}

function qualifiedDividendShareFor(asset) {
  return Math.max(0, Math.min(1, Number(asset.qualifiedDividendShare ?? 0) || 0));
}

function finalizeDividendResult(result) {
  result.cash = round(result.cash, 6);
  result.ordinaryDividends = round(result.ordinaryDividends, 6);
  result.qualifiedDividends = round(result.qualifiedDividends, 6);
  if (result.cash > EPSILON) {
    result.flows.push({
      from: "Taxable account dividends",
      to: "Spending reserve",
      amount: result.cash,
      type: "income"
    });
  }
  return result;
}

export function harvestTaxLosses(assets = [], maxLoss = Infinity, { calendarYear = null } = {}) {
  let remaining = Math.max(0, maxLoss);
  let realizedLosses = 0;
  let shortTermLosses = 0;
  let longTermLosses = 0;
  const flows = [];

  for (let index = 0; index < assets.length && remaining > EPSILON; index += 1) {
    const asset = assets[index];
    if (asset.accountType !== "taxable" || asset.assetClass === "cash" || marketValue(asset) <= EPSILON) continue;
    const lossPerUnit = (asset.costBasisPerUnit ?? asset.price) - asset.price;
    if (lossPerUnit <= EPSILON) continue;

    const fullLoss = lossPerUnit * asset.units;
    const lossToHarvest = Math.min(fullLoss, remaining);
    const unitsToHarvest = lossToHarvest / lossPerUnit;
    const isShort = asset.holdingPeriod === "short";
    resetBasisForHarvestedUnits(assets, asset, unitsToHarvest, asset.price, "tlh", calendarYear);

    realizedLosses += lossToHarvest;
    if (isShort) shortTermLosses += lossToHarvest;
    else longTermLosses += lossToHarvest;
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
    shortTermLosses: round(shortTermLosses, 6),
    longTermLosses: round(longTermLosses, 6),
    flows
  };
}

export function harvestTaxGains(assets = [], maxGain = Infinity, { calendarYear = null } = {}) {
  let remaining = Math.max(0, maxGain);
  let realizedGains = 0;
  const flows = [];

  for (let index = 0; index < assets.length && remaining > EPSILON; index += 1) {
    const asset = assets[index];
    if (asset.accountType !== "taxable" || asset.assetClass === "cash" || asset.holdingPeriod === "short" || marketValue(asset) <= EPSILON) {
      continue;
    }
    const gainPerUnit = asset.price - (asset.costBasisPerUnit ?? asset.price);
    if (gainPerUnit <= EPSILON) continue;

    const fullGain = gainPerUnit * asset.units;
    const gainToHarvest = Math.min(fullGain, remaining);
    const unitsToHarvest = gainToHarvest / gainPerUnit;
    resetBasisForHarvestedUnits(assets, asset, unitsToHarvest, asset.price, "tgh", calendarYear);

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

// Promote "short" lots that were created by a prior-year TLH/TGH back to
// "long" once at least one full simulation year has elapsed since the
// reset. Lots without `holdingPeriodResetCalendarYear` are user-classified
// (or pre-existing) and left untouched — the simulator does not have
// acquisition-date info for those.
export function ageHoldingPeriods(assets = [], calendarYear) {
  if (!Number.isFinite(calendarYear)) return;
  for (const asset of assets) {
    if (asset.holdingPeriod !== "short") continue;
    const resetYear = asset.holdingPeriodResetCalendarYear;
    if (Number.isFinite(resetYear) && resetYear < calendarYear) {
      asset.holdingPeriod = "long";
      delete asset.holdingPeriodResetCalendarYear;
    }
  }
}

// Opt-in basis step-up at the FIRST death of a married couple (IRS Pub 551:
// inherited-property basis is FMV at the date of death — up OR down).
// Applies only to TAXABLE lots:
// - lots owned by the deceased: basis reset fully to current price;
// - jointly-owned lots: `jointStepUpPercent` of the gap between basis and
//   price is recognized (50% = common-law half step-up; community-property
//   households can set 100%);
// - survivor-owned lots: unchanged.
// Untagged lots default to owner "primary". Inherited property is long-term
// by law, so adjusted lots are marked long with any TLH reset-clock cleared.
export function applySurvivorBasisStepUp(assets = [], { deceasedOwner = "primary", jointStepUpPercent = 50 } = {}) {
  const jointShare = Math.max(0, Math.min(100, Number.isFinite(Number(jointStepUpPercent)) ? Number(jointStepUpPercent) : 50)) / 100;
  const deceased = deceasedOwner === "spouse" ? "spouse" : "primary";
  let adjustedLots = 0;

  for (const asset of assets) {
    if (asset.accountType !== "taxable") continue;
    const owner = asset.owner === "spouse" ? "spouse" : asset.owner === "joint" ? "joint" : "primary";
    const price = Math.max(0, asset.price ?? 0);
    const basis = asset.costBasisPerUnit ?? price;
    let nextBasis = null;
    if (owner === deceased) {
      nextBasis = price;
    } else if (owner === "joint") {
      nextBasis = basis + (price - basis) * jointShare;
    }
    if (nextBasis === null || Math.abs(nextBasis - basis) <= EPSILON) continue;
    asset.costBasisPerUnit = round(nextBasis, 8);
    asset.holdingPeriod = "long";
    delete asset.holdingPeriodResetCalendarYear;
    adjustedLots += 1;
  }
  return { adjustedLots };
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
  if (lot.assetClass === "cash" || Math.abs(taxableGain) <= EPSILON) return "none";
  if (taxableGain < -EPSILON) {
    return lot.holdingPeriod === "short" ? "capital-loss-short" : "capital-loss-long";
  }
  return lot.holdingPeriod === "short" ? "ordinary" : "capital-gains";
}

function emptySale(lot) {
  return {
    assetId: lot?.id,
    name: lot?.name ?? lot?.id,
    accountType: lot?.accountType,
    assetClass: lot?.assetClass,
    beneficiaryType: lot?.beneficiaryType,
    proceeds: 0,
    unitsSold: 0,
    costBasisSold: 0,
    gain: 0,
    taxType: "none"
  };
}

function resetBasisForHarvestedUnits(assets, asset, unitsToHarvest, newBasis, suffix, calendarYear = null) {
  // After TLH/TGH the harvested units are effectively re-purchased today, so
  // the holding period clock restarts. Without this reset a sale within one
  // year of harvesting would still be taxed as long-term gains. We tag the
  // lot with `holdingPeriodResetCalendarYear` so a later call to
  // `ageHoldingPeriods` can promote it back to "long" once a full year has
  // elapsed.
  if (unitsToHarvest >= asset.units - EPSILON) {
    asset.costBasisPerUnit = round(newBasis, 8);
    asset.holdingPeriod = "short";
    if (Number.isFinite(calendarYear)) {
      asset.holdingPeriodResetCalendarYear = calendarYear;
    }
    return;
  }

  asset.units = round(asset.units - unitsToHarvest, 8);
  assets.push({
    ...asset,
    id: `${asset.id}-${suffix}-${assets.length + 1}`,
    name: `${asset.name ?? asset.id} ${suffix.toUpperCase()}`,
    units: round(unitsToHarvest, 8),
    costBasisPerUnit: round(newBasis, 8),
    holdingPeriod: "short",
    ...(Number.isFinite(calendarYear) ? { holdingPeriodResetCalendarYear: calendarYear } : {})
  });
}
