// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: saleComparators. No behavior changes — pure code movement.

import { marketValue } from "../portfolio.mjs";
import { DEFENSIVE_ASSET_CLASSES } from "./constants.mjs";
import { expectedReturnForAsset } from "./scenario.mjs";

const ROTH_BASIS_ASSET_CLASS_PRIORITY = Object.freeze({
  cash: 0,
  bond: 1,
  tips: 2,
  realEstate: 3,
  stock: 4,
  crypto: 5
});

export function accountLabel(accountType) {
  return {
    taxable: "Taxable account sales",
    traditional: "Traditional accounts",
    roth: "Roth accounts",
    hsa: "HSA"
  }[accountType] ?? accountType;
}

export function saleSortForWithdrawalContext({ accountType, isEarly, maxRothProceeds, context }) {
  if (accountType === "roth") return rothSaleSortForContext({ isEarly, maxRothProceeds, context });
  return context.optimizedLotSelection
    ? (a, b) => optimizedTaxAwareSaleSort(a, b, context)
    : taxAwareSaleSort;
}

export function taxAwareSaleSort(a, b) {
  if (a.assetClass === "cash" && b.assetClass !== "cash") return -1;
  if (a.assetClass !== "cash" && b.assetClass === "cash") return 1;
  const aGainRatio = embeddedGainRatio(a);
  const bGainRatio = embeddedGainRatio(b);
  if (a.accountType === "taxable" && b.accountType === "taxable" && aGainRatio !== bGainRatio) {
    return aGainRatio - bGainRatio;
  }
  if (a.holdingPeriod === "long" && b.holdingPeriod === "short") return -1;
  if (a.holdingPeriod === "short" && b.holdingPeriod === "long") return 1;
  return (b.expectedReturn ?? 0) - (a.expectedReturn ?? 0);
}

function optimizedTaxAwareSaleSort(a, b, context = {}) {
  const reserveCompare = sequenceRiskReserveSaleCompare(a, b, context.sequenceRiskReserve);
  if (reserveCompare !== 0) return reserveCompare;
  const allocationCompare = allocationWithdrawalSaleCompare(a, b, context.allocationWithdrawal);
  if (allocationCompare !== 0) return allocationCompare;
  if (a.assetClass === "cash" && b.assetClass !== "cash") return -1;
  if (a.assetClass !== "cash" && b.assetClass === "cash") return 1;
  const aExpectedReturn = expectedReturnForAsset(a, context.returnAssumptions);
  const bExpectedReturn = expectedReturnForAsset(b, context.returnAssumptions);
  if (a.accountType === "taxable" && b.accountType === "taxable") {
    const aGainRatio = embeddedGainRatio(a);
    const bGainRatio = embeddedGainRatio(b);
    if (Math.abs(aGainRatio - bGainRatio) > 0.01) return aGainRatio - bGainRatio;
    if (a.holdingPeriod === "long" && b.holdingPeriod === "short") return -1;
    if (a.holdingPeriod === "short" && b.holdingPeriod === "long") return 1;
  }
  if (aExpectedReturn !== bExpectedReturn) return aExpectedReturn - bExpectedReturn;
  const aPriority = ROTH_BASIS_ASSET_CLASS_PRIORITY[a.assetClass] ?? 99;
  const bPriority = ROTH_BASIS_ASSET_CLASS_PRIORITY[b.assetClass] ?? 99;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return taxAwareSaleSort(a, b);
}

function sequenceRiskReserveSaleCompare(a, b, reserveState) {
  if (!reserveState?.enabled) return 0;
  const reserveClasses = new Set(reserveState.assetClasses ?? []);
  const aReserve = reserveClasses.has(a.assetClass);
  const bReserve = reserveClasses.has(b.assetClass);
  if (aReserve === bReserve) return 0;
  if (reserveState.spendReserveFirst) return aReserve ? -1 : 1;
  if (reserveState.preserveReserve) return aReserve ? 1 : -1;
  return 0;
}

function allocationWithdrawalSaleCompare(a, b, allocationState) {
  if (!allocationState?.enabled || !allocationState.direction) return 0;
  const aStock = a.assetClass === "stock";
  const bStock = b.assetClass === "stock";
  const aDefensive = DEFENSIVE_ASSET_CLASSES.includes(a.assetClass);
  const bDefensive = DEFENSIVE_ASSET_CLASSES.includes(b.assetClass);
  if (allocationState.direction === "sell-stock" && aStock !== bStock) return aStock ? -1 : 1;
  if (allocationState.direction === "sell-defensive" && aDefensive !== bDefensive) return aDefensive ? -1 : 1;
  return 0;
}

function rothDistributionSort(a, b) {
  if (a.rothSource === "conversion" && b.rothSource !== "conversion") return -1;
  if (a.rothSource !== "conversion" && b.rothSource === "conversion") return 1;
  if (a.rothSource === "conversion" && b.rothSource === "conversion") {
    return (a.conversionYear ?? Infinity) - (b.conversionYear ?? Infinity);
  }
  return taxAwareSaleSort(a, b);
}

function rothSaleSortForContext({ isEarly, maxRothProceeds, context = {} }) {
  return isEarly && Number.isFinite(maxRothProceeds)
    ? (a, b) => rothBasisWithdrawalSort(a, b, context)
    : context.optimizedLotSelection
      ? (a, b) => optimizedTaxAwareSaleSort(a, b, context)
      : rothDistributionSort;
}

function rothBasisWithdrawalSort(a, b, context = {}) {
  const aPenaltyFree = rothPenaltyFreePrincipalLot(a, context);
  const bPenaltyFree = rothPenaltyFreePrincipalLot(b, context);
  if (aPenaltyFree !== bPenaltyFree && !(context.rothBasisRemaining > 0)) return aPenaltyFree ? -1 : 1;

  const aExpectedReturn = Number(a.expectedReturn);
  const bExpectedReturn = Number(b.expectedReturn);
  if (Number.isFinite(aExpectedReturn) && Number.isFinite(bExpectedReturn) && aExpectedReturn !== bExpectedReturn) {
    return aExpectedReturn - bExpectedReturn;
  }
  if (Number.isFinite(aExpectedReturn) !== Number.isFinite(bExpectedReturn)) {
    return Number.isFinite(aExpectedReturn) ? -1 : 1;
  }

  const aPriority = ROTH_BASIS_ASSET_CLASS_PRIORITY[a.assetClass] ?? 99;
  const bPriority = ROTH_BASIS_ASSET_CLASS_PRIORITY[b.assetClass] ?? 99;
  if (aPriority !== bPriority) return aPriority - bPriority;

  const aValue = marketValue(a);
  const bValue = marketValue(b);
  if (aValue !== bValue) return aValue - bValue;
  return String(a.name ?? a.id ?? "").localeCompare(String(b.name ?? b.id ?? ""));
}

function rothPenaltyFreePrincipalLot(asset = {}, context = {}) {
  if (asset.accountType !== "roth" || asset.rothSource !== "conversion") return false;
  if ((context.age ?? 99) >= (context.penaltyAge ?? 59.5)) return true;
  const conversionYear = Number(asset.conversionYear);
  return Number.isFinite(conversionYear) && (context.calendarYear ?? 0) - conversionYear >= 5;
}

export function embeddedGainRatio(asset) {
  const value = marketValue(asset);
  if (value <= 0) return 0;
  return (value - (asset.costBasisPerUnit ?? asset.price) * asset.units) / value;
}
