// Opt-in TIPS bond ladder: a one-time carve-out at plan start (the "first
// rebalance") of N held-to-maturity, inflation-indexed rungs — one per plan
// year 1..N — each paying a fixed REAL amount at maturity.
//
// Modeling choices (see docs/KNOWN_LIMITATIONS.md):
// - Rungs are real portfolio lots (accountType inherited from the funding
//   account, assetClass "tips") carrying a `tipsLadderYear` maturity tag, so
//   RMD bases, heir valuation, terminal portfolio value, and failure checks
//   see them with zero extra wiring.
// - Rungs are DETERMINISTIC: they are exempt from market-return sampling and
//   are repriced each year from the closed form
//       price = inflationIndex / (1 + realYield)^(yearsToMaturity)
//   with units = the rung's real face amount. At maturity the rung's nominal
//   value is exactly face × inflationIndex — a held-to-maturity TIPS with the
//   real yield locked at purchase. (The bundled "tips" asset CLASS is a
//   mark-to-market fund and stays fully stochastic; using ladder rungs does
//   NOT restrict historical backtest coverage to the 2004+ TIPS fund data.)
// - Placement is penalty-aware: rungs maturing before the early-withdrawal
//   penalty age are funded taxable-first (then Roth, then traditional —
//   accepting the penalty only as a last resort); rungs maturing at or after
//   the penalty age are funded traditional-first (TIPS income belongs in
//   tax-deferred space, and maturities then count toward RMDs). HSA assets
//   are never used (they are earmarked for medical costs).
// - Funding inside sheltered accounts is an in-account conversion (no tax
//   event); funding from taxable sells through the normal lot machinery so
//   realized gains land in the year's tax math exactly like rebalance sales.
// - Rung maturities are withdrawn through `withdrawForCash` before RMDs and
//   merged into the year's base withdrawal: ordinary income, MAGI (ACA /
//   IRMAA), state retirement-income treatment, and penalties all flow through
//   the existing pipeline, and traditional maturities reduce that owner's
//   forced RMD sale.
// - Rungs are excluded from rebalancing, asset-location swaps, sequence-risk
//   reserve counting, Roth conversions, and ordinary withdrawals. The forced
//   last-resort funding path may still break the ladder (rungs sort last) so
//   a plan never fails while ladder value remains.

import { marketValue, sellFromLot } from "../portfolio.mjs";
import { round } from "../utils.mjs";
import { withdrawForCash } from "./withdrawalExecution.mjs";
import { assetOwner } from "./portfolioQueries.mjs";

// Defensive funding sources are consumed before growth assets so the carve-out
// disturbs the equity sleeve as little as possible.
const FUNDING_CLASS_PRIORITY = { bond: 0, tips: 1, cash: 2, realEstate: 3, stock: 4, crypto: 5 };

export function tipsLadderConfig(scenario) {
  const config = scenario?.tipsLadder ?? {};
  const years = Number(config.years);
  const annualRealAmount = Number(config.annualRealAmount);
  const realYieldPercent = Number(config.realYieldPercent);
  return {
    enabled: config.enabled === true,
    years: Number.isFinite(years) ? Math.max(1, Math.min(40, Math.trunc(years))) : 10,
    annualRealAmount: Number.isFinite(annualRealAmount) && annualRealAmount > 0 ? annualRealAmount : null,
    // Locked real yield at purchase. Clamped to a plausible TIPS range —
    // deeply negative or double-digit real yields are input errors.
    realYield: Number.isFinite(realYieldPercent) ? Math.max(-2, Math.min(8, realYieldPercent)) / 100 : 0.02
  };
}

export function isTipsLadderRung(asset) {
  return asset?.tipsLadderYear != null;
}

export function tipsLadderValue(portfolio = []) {
  return round(portfolio
    .filter((asset) => isTipsLadderRung(asset))
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
}

// Deterministic annual repricing from the closed form. Called once per
// simulated year right after market returns are applied (which skip rungs).
export function repriceTipsLadderRungs(portfolio, { scenario, yearIndex, inflationIndex }) {
  const { realYield } = tipsLadderConfig(scenario);
  for (const asset of portfolio) {
    if (!isTipsLadderRung(asset)) continue;
    const yearsToMaturity = Math.max(0, Number(asset.tipsLadderYear) - yearIndex);
    asset.price = round(Math.max(0, inflationIndex) / Math.pow(1 + realYield, yearsToMaturity), 8);
  }
}

// One-time carve-out at plan start. Mutates the portfolio: shaves value off
// funding lots (selling through `sellFromLot` in taxable so gains are real)
// and pushes one rung lot per (maturity year, accountType, owner).
// `baseAnnualSpending` is the year-1 base spending target used when the
// household did not enter an explicit annual rung amount.
export function buildTipsLadder({ portfolio, scenario, age, baseAnnualSpending = 0, inflationIndex = 1 }) {
  const config = tipsLadderConfig(scenario);
  if (!config.enabled) return null;

  const annualRealAmount = config.annualRealAmount
    ?? (Number.isFinite(baseAnnualSpending) && baseAnnualSpending > 0 ? round(baseAnnualSpending, 6) : 0);
  if (!(annualRealAmount > 0)) {
    return { ...emptyBuildResult(config), annualRealAmount: 0, shortfall: 0 };
  }

  const penaltyAge = Number(scenario.retirementPenaltyAge ?? 59.5);
  const result = { ...emptyBuildResult(config), annualRealAmount };

  // Nearest rungs first: when the portfolio cannot fund the full ladder, the
  // early years — the ones that defuse sequence risk — win.
  for (let maturityYear = 1; maturityYear <= config.years; maturityYear += 1) {
    const rungCost = round(annualRealAmount * inflationIndex / Math.pow(1 + config.realYield, maturityYear), 6);
    const ageAtMaturity = (Number.isFinite(age) ? age : 0) + maturityYear;
    const accountOrder = ageAtMaturity < penaltyAge
      ? ["taxable", "roth", "traditional"]
      : ["traditional", "taxable", "roth"];
    const funded = fundRung({
      portfolio,
      rungCost,
      maturityYear,
      accountOrder,
      realYield: config.realYield,
      annualRealAmount,
      result
    });
    if (funded > 0) result.fundedYears += 1;
    result.totalCost = round(result.totalCost + funded, 6);
    result.shortfall = round(result.shortfall + Math.max(0, rungCost - funded), 6);
  }
  return result;
}

function emptyBuildResult(config) {
  return {
    enabled: true,
    requestedYears: config.years,
    fundedYears: 0,
    annualRealAmount: null,
    realYield: config.realYield,
    totalCost: 0,
    shortfall: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    sales: [],
    flows: []
  };
}

function fundRung({ portfolio, rungCost, maturityYear, accountOrder, realYield, annualRealAmount, result }) {
  let remaining = rungCost;
  // Accumulate funded value per (accountType, owner) so each rung lot lands
  // in the account space — and on the owner's RMD clock — that funded it.
  const rungBuckets = new Map();

  for (const accountType of accountOrder) {
    if (remaining <= 0.000001) break;
    const candidates = portfolio
      .filter((asset) => asset.accountType === accountType
        && !isTipsLadderRung(asset)
        && marketValue(asset) > 0)
      .sort((a, b) => (FUNDING_CLASS_PRIORITY[a.assetClass] ?? 9) - (FUNDING_CLASS_PRIORITY[b.assetClass] ?? 9)
        || marketValue(b) - marketValue(a));
    for (const asset of candidates) {
      if (remaining <= 0.000001) break;
      const take = Math.min(remaining, marketValue(asset));
      if (!(take > 0.000001)) continue;
      const owner = assetOwner(asset);
      if (accountType === "taxable") {
        // Real sale: realized gains/losses join the year's strategy tax math.
        const sale = sellFromLot(asset, take);
        if (!(sale.proceeds > 0)) continue;
        applyBuildSaleTaxCharacter(result, sale);
        result.sales.push(sale);
        remaining = round(remaining - sale.proceeds, 6);
        bumpBucket(rungBuckets, accountType, owner, sale.proceeds);
      } else {
        // Sheltered conversion: no tax event, just shave units.
        const units = take / asset.price;
        asset.units = Math.max(0, round(asset.units - units, 8));
        remaining = round(remaining - take, 6);
        bumpBucket(rungBuckets, accountType, owner, take);
      }
    }
  }

  const funded = round(rungCost - Math.max(0, remaining), 6);
  if (!(funded > 0.000001)) return 0;

  for (const [key, value] of rungBuckets) {
    const [accountType, owner] = key.split("|");
    // units = the rung's real face share; price reproduces the funded cost at
    // build time and follows the closed-form repricing thereafter.
    const faceShare = round(annualRealAmount * (value / rungCost), 6);
    if (!(faceShare > 0.000001) || !(value > 0.000001)) continue;
    const price = round(value / faceShare, 8);
    const rung = {
      id: `tips-ladder-${maturityYear}-${accountType}${owner === "spouse" ? "-spouse" : ""}`,
      name: `TIPS ladder rung (year ${maturityYear})`,
      accountType,
      assetClass: "tips",
      beneficiaryType: "default",
      units: faceShare,
      price,
      costBasisPerUnit: price,
      holdingPeriod: "long",
      dividendYield: 0,
      tipsLadderYear: maturityYear,
      expectedReturn: round(realYield, 6)
    };
    if (owner === "spouse") rung.owner = "spouse";
    portfolio.push(rung);
    result.flows.push({
      from: accountLabelFor(accountType),
      to: "TIPS ladder",
      amount: round(value, 6),
      type: "rebalance"
    });
  }
  return funded;
}

function bumpBucket(buckets, accountType, owner, amount) {
  const key = `${accountType}|${owner === "spouse" ? "spouse" : "primary"}`;
  buckets.set(key, round((buckets.get(key) ?? 0) + amount, 6));
}

function applyBuildSaleTaxCharacter(result, sale) {
  if (sale.accountType !== "taxable") return;
  if (sale.taxType === "ordinary") {
    result.shortTermCapitalGains = round(result.shortTermCapitalGains + Math.max(0, sale.gain), 6);
  } else if (sale.taxType === "capital-gains") {
    result.longTermCapitalGains = round(result.longTermCapitalGains + Math.max(0, sale.gain), 6);
  } else if (sale.taxType === "capital-loss-short") {
    result.capitalLosses = round(result.capitalLosses + Math.max(0, -sale.gain), 6);
    result.shortTermCapitalLosses = round(result.shortTermCapitalLosses + Math.max(0, -sale.gain), 6);
  } else if (sale.taxType === "capital-loss-long") {
    result.capitalLosses = round(result.capitalLosses + Math.max(0, -sale.gain), 6);
    result.longTermCapitalLosses = round(result.longTermCapitalLosses + Math.max(0, -sale.gain), 6);
  }
}

function accountLabelFor(accountType) {
  if (accountType === "traditional") return "Traditional accounts";
  if (accountType === "roth") return "Roth accounts";
  if (accountType === "hsa") return "HSA accounts";
  return "Taxable accounts";
}

// Sell every rung whose maturity year has arrived, through the standard
// withdrawal machinery (taxes, penalties, Roth basis, flows). Returns the
// withdrawal aggregate plus per-owner traditional proceeds so the caller can
// credit them against forced RMD sales.
export function matureTipsLadderRungs({ portfolio, yearIndex, context }) {
  const maturing = portfolio.filter((asset) => isTipsLadderRung(asset)
    && Number(asset.tipsLadderYear) <= yearIndex
    && marketValue(asset) > 0);
  if (!maturing.length) return null;

  const ownerByAssetId = new Map(maturing.map((asset) => [asset.id, assetOwner(asset)]));
  const total = maturing.reduce((sum, asset) => sum + marketValue(asset), 0);
  const withdrawal = withdrawForCash(maturing, total * 1.000001, ["taxable", "traditional", "roth", "hsa"], {
    ...context,
    includeTipsLadderRungs: true
  });

  const traditionalByOwner = { primary: 0, spouse: 0 };
  for (const sale of withdrawal.sales) {
    if (sale.accountType !== "traditional") continue;
    const owner = ownerByAssetId.get(sale.assetId) === "spouse" ? "spouse" : "primary";
    traditionalByOwner[owner] = round(traditionalByOwner[owner] + sale.proceeds, 6);
  }
  return { withdrawal, traditionalByOwner, maturedCash: withdrawal.cashRaised };
}
