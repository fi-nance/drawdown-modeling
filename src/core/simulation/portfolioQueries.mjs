// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: portfolioQueries. No behavior changes — pure code movement.

import { clonePortfolio, marketValue } from "../portfolio.mjs";
import { round } from "../utils.mjs";

export function assetClassValue(assets, classes) {
  const wanted = new Set(classes);
  return assets.reduce((total, asset) => {
    return wanted.has(asset?.assetClass) ? total + Math.max(0, Number(asset.value) || 0) : total;
  }, 0);
}

export function assetClassLabel(assetClass) {
  return {
    stock: "Stock",
    bond: "Bond",
    cash: "Cash",
    tips: "TIPS",
    realEstate: "Real estate",
    crypto: "Crypto"
  }[assetClass] ?? "Allocation";
}

export function traditionalAccountValue(portfolio) {
  return round(portfolio
    .filter((asset) => asset.accountType === "traditional")
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
}

// Canonical owner for an asset. Untagged assets belong to the primary (the
// pre-owner-dimension behavior); "joint" only applies to taxable accounts —
// retirement accounts are individually owned, so a stray joint tag on one
// resolves to primary.
export function assetOwner(asset) {
  if (asset?.owner === "spouse") return "spouse";
  if (asset?.owner === "joint" && asset?.accountType === "taxable") return "joint";
  return "primary";
}

// Traditional balances split by owner for per-owner RMD math. Joint never
// applies to traditional accounts, so the split is primary/spouse only.
export function traditionalAccountValueByOwner(portfolio) {
  const byOwner = { primary: 0, spouse: 0 };
  for (const asset of portfolio) {
    if (asset.accountType !== "traditional") continue;
    const owner = assetOwner(asset) === "spouse" ? "spouse" : "primary";
    byOwner[owner] += marketValue(asset);
  }
  return { primary: round(byOwner.primary, 6), spouse: round(byOwner.spouse, 6) };
}

export function addTaxableCash(portfolio, amount, calendarYear) {
  const cashAmount = round(Math.max(0, amount), 6);
  if (cashAmount <= 0) return;

  const existingCash = portfolio.find((asset) => (
    asset.accountType === "taxable"
    && asset.assetClass === "cash"
    && (asset.price ?? 0) > 0
  ));
  if (existingCash) {
    existingCash.units = round((existingCash.units ?? 0) + cashAmount / existingCash.price, 8);
    return;
  }

  portfolio.push({
    id: `taxable-cash-${calendarYear}`,
    name: "Taxable cash reserve",
    accountType: "taxable",
    assetClass: "cash",
    holdingPeriod: "long",
    units: cashAmount,
    price: 1,
    costBasisPerUnit: 1,
    dividendYield: 0,
    qualifiedDividendShare: 0
  });
}

export function embeddedTaxableGains(portfolio) {
  return round(portfolio.reduce((total, asset) => {
    if (asset.accountType !== "taxable" || asset.assetClass === "cash") return total;
    return total + Math.max(0, (asset.price - (asset.costBasisPerUnit ?? asset.price)) * asset.units);
  }, 0), 6);
}

export function assetSnapshot(portfolio) {
  return clonePortfolio(portfolio).map((asset) => {
    const value = marketValue(asset);
    const costBasis = (asset.costBasisPerUnit ?? asset.price) * (asset.units ?? 0);
    return {
      id: asset.id,
      name: asset.name ?? asset.id,
      accountType: asset.accountType,
      assetClass: asset.assetClass,
      units: round(asset.units ?? 0, 6),
      price: round(asset.price ?? 0, 6),
      costBasis: round(costBasis, 6),
      value: round(value, 6),
      unrealizedGain: round(value - costBasis, 6)
    };
  });
}
