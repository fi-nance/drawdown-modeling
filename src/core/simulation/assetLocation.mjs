// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: assetLocation. No behavior changes — pure code movement.

import { marketValue, removeEmptyLots, sellFromLot } from "../portfolio.mjs";
import { round } from "../utils.mjs";
import { applyRebalanceTaxCharacter } from "./allocation.mjs";
import { CASH_RAISED_EPSILON, GROWTH_ASSET_CLASSES } from "./constants.mjs";
import { hsaStrategyConfig } from "./hsa.mjs";
import { assetClassLabel } from "./portfolioQueries.mjs";
import { accountLabel, embeddedGainRatio } from "./saleComparators.mjs";
import { expectedReturnForAsset } from "./scenario.mjs";

export function assetLocationStateForYear({ scenario, portfolio, calendarYear }) {
  const config = hsaStrategyConfig(scenario);
  if (!config.assetLocationEnabled) return emptyAssetLocationResult();
  return applyTaxEfficientAssetLocation(portfolio, { calendarYear });
}

export function emptyAssetLocationResult() {
  return {
    enabled: false,
    relocatedAmount: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    sales: [],
    flows: []
  };
}

function applyTaxEfficientAssetLocation(portfolio, { calendarYear = null } = {}) {
  const result = { ...emptyAssetLocationResult(), enabled: true };
  let guard = 0;

  while (guard < 50) {
    guard += 1;
    // TIPS ladder rungs are excluded on both sides: a taxable rung must not
    // be swapped into traditional (its maturity placement is deliberate).
    const taxableIncomeAsset = portfolio
      .filter((asset) => (
        asset.accountType === "taxable"
        && ["bond", "tips"].includes(asset.assetClass)
        && asset.tipsLadderYear == null
        && marketValue(asset) > CASH_RAISED_EPSILON
      ))
      .sort(assetLocationTaxableIncomeSort)[0];
    const traditionalGrowthAsset = portfolio
      .filter((asset) => (
        asset.accountType === "traditional"
        && GROWTH_ASSET_CLASSES.includes(asset.assetClass)
        && asset.tipsLadderYear == null
        && marketValue(asset) > CASH_RAISED_EPSILON
      ))
      .sort((a, b) => expectedReturnForAsset(b) - expectedReturnForAsset(a))[0];

    if (!taxableIncomeAsset || !traditionalGrowthAsset) break;
    const amount = Math.min(marketValue(taxableIncomeAsset), marketValue(traditionalGrowthAsset));
    if (amount <= CASH_RAISED_EPSILON) break;

    const taxableSale = sellFromLot(taxableIncomeAsset, amount);
    const shelteredSale = sellFromLot(traditionalGrowthAsset, amount);
    const swapAmount = Math.min(taxableSale.proceeds, shelteredSale.proceeds);
    if (swapAmount <= CASH_RAISED_EPSILON) break;

    result.relocatedAmount += swapAmount;
    result.sales.push(taxableSale, shelteredSale);
    applyRebalanceTaxCharacter(result, taxableSale);
    addReplacementLot(portfolio, {
      accountType: "taxable",
      assetClass: shelteredSale.assetClass,
      amount: swapAmount,
      source: traditionalGrowthAsset,
      calendarYear,
      label: "asset location"
    });
    addReplacementLot(portfolio, {
      accountType: "traditional",
      assetClass: taxableSale.assetClass,
      amount: swapAmount,
      source: taxableIncomeAsset,
      calendarYear,
      label: "asset location"
    });
    result.flows.push({
      from: taxableSale.name ?? taxableSale.assetId,
      to: "Asset location swap",
      amount: round(swapAmount, 6),
      type: "rebalance"
    });
    result.flows.push({
      from: "Asset location swap",
      to: `${accountLabel("taxable")} ${assetClassLabel(shelteredSale.assetClass)}`,
      amount: round(swapAmount, 6),
      type: "rebalance"
    });
  }

  result.relocatedAmount = round(result.relocatedAmount, 6);
  result.shortTermCapitalGains = round(result.shortTermCapitalGains, 6);
  result.longTermCapitalGains = round(result.longTermCapitalGains, 6);
  result.capitalLosses = round(result.capitalLosses, 6);
  result.shortTermCapitalLosses = round(result.shortTermCapitalLosses, 6);
  result.longTermCapitalLosses = round(result.longTermCapitalLosses, 6);
  removeEmptyLots(portfolio);
  return result;
}

function assetLocationTaxableIncomeSort(a, b) {
  const aIncome = Number(a.dividendYield) || 0;
  const bIncome = Number(b.dividendYield) || 0;
  if (aIncome !== bIncome) return bIncome - aIncome;
  return embeddedGainRatio(a) - embeddedGainRatio(b);
}

function addReplacementLot(portfolio, {
  accountType,
  assetClass,
  amount,
  source = {},
  calendarYear = null,
  label = "replacement"
}) {
  const price = Math.max(CASH_RAISED_EPSILON, Number(source.price) || 1);
  portfolio.push({
    id: `${label.replace(/\s+/g, "-")}-${calendarYear ?? "na"}-${accountType}-${assetClass}-${portfolio.length + 1}`,
    name: `${assetClassLabel(assetClass)} ${label}`,
    accountType,
    assetClass,
    beneficiaryType: source.beneficiaryType ?? "default",
    units: round(amount / price, 8),
    price: round(price, 8),
    costBasisPerUnit: round(price, 8),
    holdingPeriod: accountType === "taxable" ? "short" : "long",
    ...(accountType === "taxable" && Number.isFinite(calendarYear)
      ? { holdingPeriodResetCalendarYear: calendarYear }
      : {}),
    ...(Number.isFinite(Number(source.expectedReturn)) ? { expectedReturn: Number(source.expectedReturn) } : {}),
    ...(Number.isFinite(Number(source.dividendYield)) ? { dividendYield: Number(source.dividendYield) } : {}),
    ...(Number.isFinite(Number(source.qualifiedDividendShare))
      ? { qualifiedDividendShare: Number(source.qualifiedDividendShare) }
      : {})
  });
}
