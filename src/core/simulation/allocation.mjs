// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: allocation. No behavior changes — pure code movement.

import { marketValue, sellFromLot } from "../portfolio.mjs";
import { round } from "../utils.mjs";
import { CASH_RAISED_EPSILON, DEFENSIVE_ASSET_CLASSES } from "./constants.mjs";
import { finitePercent } from "./guards.mjs";
import { assetClassLabel } from "./portfolioQueries.mjs";
import { taxAwareSaleSort } from "./saleComparators.mjs";

function allocationStrategyConfig(scenario, yearIndex = 0) {
  const config = scenario.allocationStrategy ?? {};
  const targetStockPercent = finitePercent(config.targetStockPercent, 70);
  const rebalanceBandPercent = finitePercent(config.rebalanceBandPercent, 5);
  const glidepathStartStockPercent = finitePercent(config.glidepathStartStockPercent, 60);
  const glidepathEndStockPercent = finitePercent(config.glidepathEndStockPercent, 80);
  const glidepathYears = Number.isFinite(Number(config.glidepathYears))
    ? Math.max(1, Math.trunc(Number(config.glidepathYears)))
    : 15;
  const glidepathEnabled = config.glidepathEnabled === true;
  const progress = glidepathEnabled
    ? Math.min(1, Math.max(0, yearIndex) / Math.max(1, glidepathYears - 1))
    : 0;
  const activeTargetStockPercent = glidepathEnabled
    ? glidepathStartStockPercent + ((glidepathEndStockPercent - glidepathStartStockPercent) * progress)
    : targetStockPercent;
  const preferredDefensiveAssetClass = DEFENSIVE_ASSET_CLASSES.includes(config.preferredDefensiveAssetClass)
    ? config.preferredDefensiveAssetClass
    : "bond";

  return {
    rebalanceEnabled: config.rebalanceEnabled === true,
    withdrawalBiasEnabled: config.withdrawalBiasEnabled === true,
    glidepathEnabled,
    targetStockPercent,
    activeTargetStockPercent,
    targetStockShare: activeTargetStockPercent / 100,
    rebalanceBandPercent,
    rebalanceBandShare: rebalanceBandPercent / 100,
    glidepathStartStockPercent,
    glidepathEndStockPercent,
    glidepathYears,
    preferredDefensiveAssetClass
  };
}

export function allocationStrategyStateForYear({ scenario, portfolio, yearIndex, calendarYear }) {
  const config = allocationStrategyConfig(scenario, yearIndex);
  const before = managedStockAllocationSnapshot(portfolio);
  const rebalancing = config.rebalanceEnabled
    ? rebalancePortfolioToStockTarget(portfolio, config, { calendarYear })
    : emptyRebalanceResult();
  const after = managedStockAllocationSnapshot(portfolio);

  return {
    enabled: config.rebalanceEnabled || config.withdrawalBiasEnabled || config.glidepathEnabled,
    rebalanceEnabled: config.rebalanceEnabled,
    withdrawalBiasEnabled: config.withdrawalBiasEnabled,
    glidepathEnabled: config.glidepathEnabled,
    targetStockPercent: round(config.activeTargetStockPercent, 6),
    baseTargetStockPercent: round(config.targetStockPercent, 6),
    rebalanceBandPercent: round(config.rebalanceBandPercent, 6),
    glidepathStartStockPercent: round(config.glidepathStartStockPercent, 6),
    glidepathEndStockPercent: round(config.glidepathEndStockPercent, 6),
    glidepathYears: config.glidepathYears,
    stockShareBeforePercent: before.managedValue > 0 ? round(before.stockShare * 100, 6) : null,
    stockShareAfterPercent: after.managedValue > 0 ? round(after.stockShare * 100, 6) : null,
    managedValueBefore: before.managedValue,
    managedValueAfter: after.managedValue,
    ...rebalancing
  };
}

function managedStockAllocationSnapshot(portfolio = []) {
  // TIPS ladder rungs (tipsLadderYear != null) are a carved-out liability
  // match, not part of the managed allocation: the remaining portfolio
  // rebalances to its stock target without them.
  const stockValue = round(portfolio
    .filter((asset) => asset.assetClass === "stock" && asset.tipsLadderYear == null)
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
  const defensiveValue = round(portfolio
    .filter((asset) => DEFENSIVE_ASSET_CLASSES.includes(asset.assetClass) && asset.tipsLadderYear == null)
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
  const managedValue = round(stockValue + defensiveValue, 6);
  return {
    stockValue,
    defensiveValue,
    managedValue,
    stockShare: managedValue > 0 ? stockValue / managedValue : 0
  };
}

export function emptyRebalanceResult() {
  return {
    rebalancedAmount: 0,
    direction: null,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    sales: [],
    flows: []
  };
}

function rebalancePortfolioToStockTarget(portfolio, config, { calendarYear = null } = {}) {
  const snapshot = managedStockAllocationSnapshot(portfolio);
  if (!(snapshot.managedValue > 0)) return emptyRebalanceResult();

  const lowerBand = Math.max(0, config.targetStockShare - config.rebalanceBandShare);
  const upperBand = Math.min(1, config.targetStockShare + config.rebalanceBandShare);
  if (snapshot.stockShare >= lowerBand - 0.000001 && snapshot.stockShare <= upperBand + 0.000001) {
    return emptyRebalanceResult();
  }

  const sellStock = snapshot.stockShare > upperBand;
  const targetStockValue = snapshot.managedValue * config.targetStockShare;
  const requestedAmount = sellStock
    ? Math.max(0, snapshot.stockValue - targetStockValue)
    : Math.max(0, targetStockValue - snapshot.stockValue);
  if (!(requestedAmount > CASH_RAISED_EPSILON)) return emptyRebalanceResult();

  const result = emptyRebalanceResult();
  result.direction = sellStock ? "sell-stock" : "buy-stock";
  let remaining = requestedAmount;
  const candidates = portfolio
    .filter((asset) => asset.tipsLadderYear == null && (sellStock
      ? asset.assetClass === "stock" && marketValue(asset) > 0
      : DEFENSIVE_ASSET_CLASSES.includes(asset.assetClass) && marketValue(asset) > 0))
    .sort(rebalanceSaleSort);

  for (const asset of candidates) {
    if (remaining <= CASH_RAISED_EPSILON) break;
    const sale = sellFromLot(asset, remaining);
    if (sale.proceeds <= CASH_RAISED_EPSILON) continue;

    remaining -= sale.proceeds;
    result.rebalancedAmount += sale.proceeds;
    result.sales.push(sale);
    applyRebalanceTaxCharacter(result, sale);
    addRebalancedLot(portfolio, sale, {
      destinationGroup: sellStock ? "defensive" : "stock",
      preferredDefensiveAssetClass: config.preferredDefensiveAssetClass,
      calendarYear
    });
    result.flows.push({
      from: sale.name ?? sale.assetId,
      to: "Allocation rebalance",
      amount: round(sale.proceeds, 6),
      type: "rebalance"
    });
    result.flows.push({
      from: "Allocation rebalance",
      to: sellStock ? "Defensive sleeve" : "Stock sleeve",
      amount: round(sale.proceeds, 6),
      type: "rebalance"
    });
  }

  result.rebalancedAmount = round(result.rebalancedAmount, 6);
  result.shortTermCapitalGains = round(result.shortTermCapitalGains, 6);
  result.longTermCapitalGains = round(result.longTermCapitalGains, 6);
  result.capitalLosses = round(result.capitalLosses, 6);
  result.shortTermCapitalLosses = round(result.shortTermCapitalLosses, 6);
  result.longTermCapitalLosses = round(result.longTermCapitalLosses, 6);
  return result;
}

function rebalanceSaleSort(a, b) {
  const aTaxable = a.accountType === "taxable";
  const bTaxable = b.accountType === "taxable";
  if (aTaxable !== bTaxable) return aTaxable ? 1 : -1;
  return taxAwareSaleSort(a, b);
}

export function applyRebalanceTaxCharacter(result, sale) {
  if (sale.accountType !== "taxable") return;
  if (sale.taxType === "ordinary") {
    result.shortTermCapitalGains += Math.max(0, sale.gain);
  } else if (sale.taxType === "capital-gains") {
    result.longTermCapitalGains += Math.max(0, sale.gain);
  } else if (sale.taxType === "capital-loss-short") {
    const loss = Math.abs(Math.min(0, sale.gain));
    result.capitalLosses += loss;
    result.shortTermCapitalLosses += loss;
  } else if (sale.taxType === "capital-loss-long") {
    const loss = Math.abs(Math.min(0, sale.gain));
    result.capitalLosses += loss;
    result.longTermCapitalLosses += loss;
  }
}

function addRebalancedLot(portfolio, sale, {
  destinationGroup,
  preferredDefensiveAssetClass = "bond",
  calendarYear = null
} = {}) {
  const accountType = sale.accountType ?? "taxable";
  const assetClass = destinationGroup === "stock"
    ? "stock"
    : preferredDefensiveClassForAccount(portfolio, accountType, preferredDefensiveAssetClass);
  const template = portfolio.find((asset) => (
    asset.accountType === accountType
    && asset.assetClass === assetClass
    && marketValue(asset) > CASH_RAISED_EPSILON
  ));
  const price = Math.max(CASH_RAISED_EPSILON, Number(template?.price) || 1);
  portfolio.push({
    id: `rebalance-${calendarYear ?? "na"}-${assetClass}-${portfolio.length + 1}`,
    name: `${assetClassLabel(assetClass)} rebalance`,
    accountType,
    assetClass,
    beneficiaryType: template?.beneficiaryType ?? sale.beneficiaryType ?? "default",
    units: round(sale.proceeds / price, 8),
    price: round(price, 8),
    costBasisPerUnit: round(price, 8),
    holdingPeriod: accountType === "taxable" ? "short" : "long",
    ...(accountType === "taxable" && Number.isFinite(calendarYear)
      ? { holdingPeriodResetCalendarYear: calendarYear }
      : {}),
    ...(Number.isFinite(Number(template?.expectedReturn)) ? { expectedReturn: Number(template.expectedReturn) } : {}),
    ...(Number.isFinite(Number(template?.dividendYield)) ? { dividendYield: Number(template.dividendYield) } : {}),
    ...(Number.isFinite(Number(template?.qualifiedDividendShare))
      ? { qualifiedDividendShare: Number(template.qualifiedDividendShare) }
      : {})
  });
}

function preferredDefensiveClassForAccount(portfolio, accountType, fallback) {
  const candidates = portfolio
    .filter((asset) => asset.accountType === accountType && DEFENSIVE_ASSET_CLASSES.includes(asset.assetClass))
    .sort((a, b) => marketValue(b) - marketValue(a));
  return candidates[0]?.assetClass ?? fallback;
}

export function allocationWithdrawalStateForPortfolio(portfolio, allocationStrategy) {
  if (!allocationStrategy?.withdrawalBiasEnabled) {
    return { enabled: false, direction: null };
  }
  const snapshot = managedStockAllocationSnapshot(portfolio);
  if (!(snapshot.managedValue > 0)) {
    return { enabled: true, direction: null };
  }
  const targetShare = Math.max(0, Math.min(1, (allocationStrategy.targetStockPercent ?? 70) / 100));
  const bandShare = Math.max(0, Math.min(1, (allocationStrategy.rebalanceBandPercent ?? 5) / 100));
  if (snapshot.stockShare > Math.min(1, targetShare + bandShare) + 0.000001) {
    return { enabled: true, direction: "sell-stock" };
  }
  if (snapshot.stockShare < Math.max(0, targetShare - bandShare) - 0.000001) {
    return { enabled: true, direction: "sell-defensive" };
  }
  return { enabled: true, direction: null };
}
