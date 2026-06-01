// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: sequenceRiskReserve. No behavior changes — pure code movement.

import { marketValue } from "../portfolio.mjs";
import { round } from "../utils.mjs";

function sequenceRiskReserveConfig(scenario) {
  const config = scenario.sequenceRiskReserve ?? {};
  const targetYears = Number(config.targetYears);
  const tentYears = Number(config.tentYears);
  const triggerStockReturn = Number(config.triggerStockReturn);
  const mode = ["cash", "bond", "hybrid"].includes(config.mode) ? config.mode : "cash";
  return {
    enabled: config.enabled === true,
    mode,
    assetClasses: reserveAssetClassesForMode(mode),
    targetYears: Number.isFinite(targetYears) && targetYears > 0 ? targetYears : 3,
    tentYears: Number.isFinite(tentYears) && tentYears > 0 ? tentYears : 10,
    triggerStockReturn: Number.isFinite(triggerStockReturn) ? triggerStockReturn : 0
  };
}

export function sequenceRiskReserveStateForYear({ scenario, portfolio, plannedSpending, returnByAssetClass, yearIndex }) {
  const config = sequenceRiskReserveConfig(scenario);
  if (!config.enabled) {
    return {
      enabled: false,
      mode: config.mode,
      assetClasses: config.assetClasses,
      targetValue: 0,
      currentValue: 0,
      spendReserveFirst: false,
      preserveReserve: false
    };
  }

  const targetValue = round(Math.max(0, plannedSpending) * config.targetYears, 6);
  const currentValue = reserveAssetValue(portfolio, config.assetClasses);
  const inTentWindow = yearIndex < config.tentYears;
  const stockReturn = Number(returnByAssetClass?.stock);
  const stressYear = Number.isFinite(stockReturn) && stockReturn <= config.triggerStockReturn;
  return {
    enabled: true,
    mode: config.mode,
    assetClasses: config.assetClasses,
    targetValue,
    currentValue,
    stockReturn: Number.isFinite(stockReturn) ? round(stockReturn, 6) : null,
    spendReserveFirst: inTentWindow && stressYear && currentValue > 0,
    preserveReserve: inTentWindow && !stressYear && currentValue < targetValue
  };
}

function reserveAssetClassesForMode(mode) {
  if (mode === "bond") return ["bond", "tips"];
  if (mode === "hybrid") return ["cash", "bond", "tips"];
  return ["cash"];
}

function reserveAssetValue(portfolio = [], assetClasses = []) {
  const reserveClasses = new Set(assetClasses);
  return round(portfolio
    .filter((asset) => reserveClasses.has(asset.assetClass))
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
}
