import { ensureRothLedger } from "../rothLedger.mjs";
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

import { accountMetadata, marketValue, sellFromLot } from "../portfolio.mjs";
import { round } from "../utils.mjs";
import { withdrawForCash } from "./withdrawalExecution.mjs";
import { assetOwner } from "./portfolioQueries.mjs";

// Defensive funding sources are consumed before growth assets so the carve-out
// disturbs the equity sleeve as little as possible.
const FUNDING_CLASS_PRIORITY = { bond: 0, tips: 1, cash: 2, realEstate: 3, stock: 4, crypto: 5 };
// Replenishment after an UP year inverts the priority: the point of the
// policy is to harvest appreciated stock into the inflation-protected floor.
const REPLENISH_UP_CLASS_PRIORITY = { stock: 0, crypto: 1, realEstate: 2, bond: 3, tips: 4, cash: 5 };

const MAINTENANCE_MODES = ["none", "always", "stocks-up", "spend-on-stress"];

export function tipsLadderConfig(scenario) {
  const config = scenario?.tipsLadder ?? {};
  const years = Number(config.years);
  const annualRealAmount = Number(config.annualRealAmount);
  const realYieldPercent = Number(config.realYieldPercent);
  const trigger = Number(config.triggerStockReturnPercent);
  return {
    enabled: config.enabled === true,
    years: Number.isFinite(years) ? Math.max(1, Math.min(40, Math.trunc(years))) : 10,
    annualRealAmount: Number.isFinite(annualRealAmount) && annualRealAmount > 0 ? annualRealAmount : null,
    // Locked real yield at purchase. Clamped to a plausible TIPS range —
    // deeply negative or double-digit real yields are input errors.
    realYield: Number.isFinite(realYieldPercent) ? Math.max(-2, Math.min(8, realYieldPercent)) / 100 : 0.02,
    // Post-build maintenance policy (see DEFAULT_SCENARIO doc comment):
    // "none" | "always" | "stocks-up" | "spend-on-stress".
    maintenanceMode: MAINTENANCE_MODES.includes(config.maintenanceMode) ? config.maintenanceMode : "none",
    replenishCatchUp: config.replenishCatchUp === true,
    // Trigger threshold on the year's REALIZED stock return, mirroring the
    // sequence-risk reserve convention: stress when stock <= trigger.
    // Percent input: 0 = any down year; -10 = down at least 10%.
    triggerStockReturn: Number.isFinite(trigger) ? Math.max(-95, Math.min(95, trigger)) / 100 : 0
  };
}

export function isTipsLadderRung(asset) {
  return asset?.tipsLadderYear != null;
}

// The value of the ladder's BONDS (the rungs). Coupon cash a rung has thrown
// off is deliberately NOT counted here — once paid, it is ordinary account cash
// (reported separately as couponIncome, and included in portfolioValue / heir /
// RMD math like any other cash), not part of the held-to-maturity ladder.
export function tipsLadderValue(portfolio = []) {
  return round(portfolio
    .filter((asset) => isTipsLadderRung(asset))
    .reduce((total, asset) => total + marketValue(asset), 0), 6);
}

// Deterministic annual repricing. Called once per simulated year right after
// market returns are applied (which skip rungs). Rungs are PAR coupon bonds:
// the price tracks the inflation-adjusted principal (real face × cumulative
// inflation index) and the locked real yield is paid out as a cash coupon (see
// payTipsLadderCoupons), NOT baked into price accretion.
//
// Returns the year's TAXABLE-rung phantom income: the annual inflation
// adjustment to a taxable rung's principal is ORDINARY income (OID) every year,
// owed even though no cash is received until maturity. We recognize it annually
// and step the rung's basis up to match, so the eventual sale/maturity realizes
// ~0 capital gain. The accretion is floored at zero so a deflation year never
// steps basis backward (which would manufacture a spurious gain on the later
// recovery); a net-negative inflation adjustment reduces the year's interest in
// reality, never an unrelated deduction. Sheltered rungs accrue no annual tax.
export function repriceTipsLadderRungs(portfolio, { yearIndex, inflationIndex }) {
  let taxablePhantomIncome = 0;
  for (const asset of portfolio) {
    if (!isTipsLadderRung(asset)) continue;
    // Par value = inflation-adjusted principal per unit of real face.
    const newPrice = round(Math.max(0, inflationIndex), 8);
    if (asset.accountType === "taxable") {
      const accretion = Math.max(0, (newPrice - Math.max(0, asset.price ?? 0)) * Math.max(0, asset.units ?? 0));
      if (accretion > 0) {
        taxablePhantomIncome = round(taxablePhantomIncome + accretion, 6);
        // Basis tracks the taxed accretion (monotonic) so a later sale has ~0 gain.
        asset.costBasisPerUnit = newPrice;
      }
    }
    asset.price = newPrice;
  }
  return round(taxablePhantomIncome, 6);
}

// Annual coupon = locked real yield × inflation-adjusted principal, paid in cash
// on every rung. Mutates the portfolio for SHELTERED rungs (the coupon is
// deposited as cash inside the same account+owner) and RETURNS the taxable-rung
// coupon total for the caller to add to household spendable cash and ordinary
// (interest) income.
//
// By design the coupon cash is ORDINARY account cash from this point on: only
// the rungs themselves are carved out of rebalancing / asset-location / Roth
// conversions, NOT the cash they throw off. So a sheltered coupon-cash lot is
// a normal defensive-cash holding — free to be rebalanced (per the allocation
// strategy), counted in the sequence-risk reserve and RMD base, withdrawn, or
// bequeathed — exactly the "usable for rebalancing or other purposes" behavior
// the coupon model is meant to provide.
export function payTipsLadderCoupons(portfolio, { scenario, inflationIndex }) {
  const { realYield } = tipsLadderConfig(scenario);
  const couponRate = Math.max(0, realYield); // a negative real yield pays no coupon
  if (!(couponRate > 0)) return { taxableCouponCash: 0, shelteredCouponCash: 0, flows: [] };

  let taxableCouponCash = 0;
  let shelteredCouponCash = 0;
  const shelteredByAccount = new Map();
  for (const asset of portfolio) {
    if (!isTipsLadderRung(asset)) continue;
    const coupon = round(couponRate * marketValue(asset), 6);
    if (!(coupon > 0)) continue;
    if (asset.accountType === "taxable") {
      taxableCouponCash = round(taxableCouponCash + coupon, 6);
    } else {
      // Coupons are earnings, not converted principal, but retain ownership
      // and beneficiary identity within the receiving account.
      const { rothSource, conversionYear, ...metadata } = accountMetadata(asset);
      bumpBucket(shelteredByAccount, { accountType: asset.accountType, ...metadata }, coupon);
      shelteredCouponCash = round(shelteredCouponCash + coupon, 6);
    }
  }

  const flows = [];
  // Deposit each sheltered account's coupon into a reusable cash lot in that
  // same account+owner so it compounds and stays available there.
  for (const { accountType, metadata, value: amount } of shelteredByAccount.values()) {
    if (!(amount > 0)) continue;
    const baseId = `tips-coupon-cash-${accountType}${metadata.owner === "spouse" ? "-spouse" : ""}`;
    let lot = portfolio.find((asset) => String(asset.id).startsWith(baseId)
      && asset.accountType === accountType && JSON.stringify(accountMetadata(asset)) === JSON.stringify(metadata));
    if (!lot) {
      lot = {
        id: unusedLotId(portfolio, baseId),
        name: `TIPS coupon cash (${accountLabelFor(accountType)})`,
        accountType,
        assetClass: "cash",
        ...metadata,
        units: 0,
        price: 1,
        costBasisPerUnit: 1,
        holdingPeriod: "long",
        dividendYield: 0
      };
      portfolio.push(lot);
    }
    lot.units = round(Math.max(0, lot.units ?? 0) + amount, 8);
    flows.push({ from: "TIPS ladder coupons", to: `${accountLabelFor(accountType)} cash`, amount, type: "income" });
  }
  if (taxableCouponCash > 0) {
    flows.push({ from: "TIPS ladder coupons", to: "Spending reserve", amount: taxableCouponCash, type: "income" });
  }
  return { taxableCouponCash, shelteredCouponCash, flows };
}

// One-time carve-out at plan start. Mutates the portfolio: shaves value off
// funding lots (selling through `sellFromLot` in taxable so gains are real)
// and pushes one rung lot per (maturity year, accountType, owner).
// `baseAnnualSpending` is the year-1 base spending target used when the
// household did not enter an explicit annual rung amount.
export function buildTipsLadder({ portfolio, scenario, age, ownerAges = null, baseAnnualSpending = 0, inflationIndex = 1 }) {
  const config = tipsLadderConfig(scenario);
  if (!config.enabled) return null;

  const annualRealAmount = config.annualRealAmount
    ?? (Number.isFinite(baseAnnualSpending) && baseAnnualSpending > 0 ? round(baseAnnualSpending, 6) : 0);
  if (!(annualRealAmount > 0)) {
    return { ...emptyBuildResult(config), annualRealAmount: 0, shortfall: 0 };
  }

  const penaltyAge = Number(scenario.retirementPenaltyAge ?? 59.5);
  const resolvedOwnerAges = ownerAges ?? { primary: age, spouse: age };
  const result = { ...emptyBuildResult(config), annualRealAmount };

  // Nearest rungs first: when the portfolio cannot fund the full ladder, the
  // early years — the ones that defuse sequence risk — win.
  for (let maturityYear = 1; maturityYear <= config.years; maturityYear += 1) {
    // Par coupon bond: pay the inflation-adjusted principal up front (no
    // zero-coupon discount), since the real yield is returned as a cash coupon.
    const rungCost = round(annualRealAmount * inflationIndex, 6);
    const ageAtMaturity = (Number.isFinite(age) ? age : 0) + maturityYear;
    const accountOrder = ageAtMaturity < penaltyAge
      ? ["taxable", "roth", "traditional"]
      : ["traditional", "taxable", "roth"];
    const funded = fundRung({
      portfolio,
      rungCost,
      maturityYear,
      yearsToMaturity: maturityYear,
      accountOrder,
      realYield: config.realYield,
      annualRealAmount,
      result,
      ownerAges: resolvedOwnerAges,
      penaltyAge
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

function fundRung({ portfolio, rungCost, maturityYear, yearsToMaturity = maturityYear, accountOrder, realYield, annualRealAmount, result, classPriority = FUNDING_CLASS_PRIORITY, idSuffix = "", ownerAges = null, penaltyAge = 59.5 }) {
  let remaining = rungCost;
  // Keep distinct ownership, beneficiaries and conversion clocks separate.
  const rungBuckets = new Map();

  // A sheltered lot is a PENALIZED placement when ITS OWNER would still be
  // under the early-withdrawal penalty age at the rung's maturity — a
  // younger spouse's IRA must not fund a rung the primary's age clock says
  // is penalty-free. Penalized lots are a household-wide last resort: they
  // are consumed only after every other account type has been exhausted.
  const penalizedPlacement = (asset, accountType) => {
    if (accountType === "taxable") return false;
    const owner = assetOwner(asset) === "spouse" ? "spouse" : "primary";
    const ownerAge = Number(ownerAges?.[owner]);
    if (!Number.isFinite(ownerAge)) return false;
    return ownerAge + yearsToMaturity < penaltyAge;
  };

  for (const allowPenalized of [false, true]) {
    if (remaining <= 0.000001) break;
    for (const accountType of accountOrder) {
      if (remaining <= 0.000001) break;
      const candidates = portfolio
        .filter((asset) => asset.accountType === accountType
          && !isTipsLadderRung(asset)
          && marketValue(asset) > 0
          && penalizedPlacement(asset, accountType) === allowPenalized)
        .sort((a, b) => (classPriority[a.assetClass] ?? 9) - (classPriority[b.assetClass] ?? 9)
          || marketValue(b) - marketValue(a));
      for (const asset of candidates) {
        if (remaining <= 0.000001) break;
        const take = Math.min(remaining, marketValue(asset));
        if (!(take > 0.000001)) continue;
        if (accountType === "taxable") {
          // Real sale: realized gains/losses join the year's strategy tax math.
          const sale = sellFromLot(asset, take);
          if (!(sale.proceeds > 0)) continue;
          applyBuildSaleTaxCharacter(result, sale);
          result.sales.push(sale);
          remaining = round(remaining - sale.proceeds, 6);
          bumpBucket(rungBuckets, asset, sale.proceeds);
        } else {
          // Sheltered conversion: no tax event, just shave units.
          const units = take / asset.price;
          asset.units = Math.max(0, round(asset.units - units, 8));
          remaining = round(remaining - take, 6);
          bumpBucket(rungBuckets, asset, take);
        }
      }
    }
  }

  const funded = round(rungCost - Math.max(0, remaining), 6);
  if (!(funded > 0.000001)) return 0;

  for (const { accountType, metadata, value } of rungBuckets.values()) {
    // units = the rung's real face share; price reproduces the funded cost at
    // build time and follows the closed-form repricing thereafter.
    const faceShare = round(annualRealAmount * (value / rungCost), 6);
    if (!(faceShare > 0.000001) || !(value > 0.000001)) continue;
    const price = round(value / faceShare, 8);
    const rung = {
      id: unusedLotId(portfolio, `tips-ladder-${maturityYear}${idSuffix}-${accountType}${metadata.owner === "spouse" ? "-spouse" : ""}`),
      name: `TIPS ladder rung (year ${maturityYear})`,
      accountType,
      assetClass: "tips",
      ...metadata,
      units: faceShare,
      price,
      costBasisPerUnit: price,
      holdingPeriod: "long",
      dividendYield: 0,
      tipsLadderYear: maturityYear,
      expectedReturn: round(realYield, 6)
    };
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

function bumpBucket(buckets, asset, amount) {
  const metadata = accountMetadata(asset);
  const key = JSON.stringify([asset.accountType, metadata]);
  buckets.set(key, { accountType: asset.accountType, metadata,
    value: round((buckets.get(key)?.value ?? 0) + amount, 6) });
}

function unusedLotId(portfolio, base) {
  let id = base;
  let index = 2;
  while (portfolio.some((lot) => lot.id === id)) id = `${base}-${index++}`;
  return id;
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

// Yearly ladder maintenance (runs years >= 1, before the maturity-spend step
// and the allocation rebalance). Policy by maintenanceMode:
//   "always"          buy every missing rung out to `years` of coverage.
//   "stocks-up"       same purchase, but only when the year's realized stock
//                     return is ABOVE the trigger; replenishCatchUp=false
//                     limits the purchase to the single far rung (missed
//                     years stay missed — the ladder shrinks after bad runs).
//   "spend-on-stress" no purchases ever; in NON-stress years the maturing
//                     rung rolls `years` forward (reinvested at the locked
//                     real yield — its real face grows by (1+y)^years), so it
//                     is only consumed when stocks are at or below the
//                     trigger.
// Purchases after an up year sell appreciated stock first; purchases in
// "always" mode during a down year fall back to defensive-first funding.
export function maintainTipsLadder({ portfolio, scenario, age, ownerAges = null, yearIndex, inflationIndex, stockReturn, baseAnnualSpending = 0 }) {
  const config = tipsLadderConfig(scenario);
  if (!config.enabled || config.maintenanceMode === "none" || yearIndex < 1) return null;

  // Stress when the realized stock return is AT OR BELOW the trigger —
  // matching the sequence-risk reserve convention and the UI copy.
  const stressYear = Number(stockReturn ?? 0) <= config.triggerStockReturn;
  const result = {
    mode: config.maintenanceMode,
    stressYear,
    rolledCount: 0,
    rolledValue: 0,
    replenishedCount: 0,
    replenishedCost: 0,
    shortfall: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    sales: [],
    flows: []
  };

  if (config.maintenanceMode === "spend-on-stress") {
    // Stress year: leave maturing rungs alone — the maturity step spends them.
    if (stressYear) return result;
    for (const asset of [...portfolio]) {
      if (!isTipsLadderRung(asset)) continue;
      if (Number(asset.tipsLadderYear) > yearIndex) continue;
      const value = marketValue(asset);
      if (!(value > 0.000001)) continue;
      const newMaturity = yearIndex + config.years;
      // Par coupon bonds: the matured principal rolls forward at par (real face
      // preserved); the real yield is harvested as cash coupons each year, not
      // accreted into the face — so no (1+y)^years growth.
      const growth = 1;
      if (asset.accountType === "taxable") {
        // A taxable roll is a sale + repurchase: the accrued gain is realized
        // now and the new rung starts at a fresh basis.
        const sale = sellFromLot(asset, value * 1.000001);
        if (!(sale.proceeds > 0)) continue;
        applyBuildSaleTaxCharacter(result, sale);
        result.sales.push(sale);
        const units = round(Math.max(0, sale.unitsSold) * growth, 8);
        if (!(units > 0)) continue;
        const price = round(sale.proceeds / units, 8);
        portfolio.push({
          ...assetShellForRoll(asset, yearIndex),
          units,
          price,
          costBasisPerUnit: price,
          tipsLadderYear: newMaturity
        });
        result.rolledValue = round(result.rolledValue + sale.proceeds, 6);
      } else {
        // Sheltered roll: no tax event — retag and reinvest in place.
        asset.tipsLadderYear = newMaturity;
        asset.units = round(asset.units * growth, 8);
        asset.price = round(value / asset.units, 8);
        result.rolledValue = round(result.rolledValue + value, 6);
      }
      result.rolledCount += 1;
      result.flows.push({
        from: "TIPS ladder",
        to: "TIPS ladder roll",
        amount: round(value, 6),
        type: "rebalance"
      });
    }
    return result;
  }

  // Replenishment modes ("always" / "stocks-up").
  if (config.maintenanceMode === "stocks-up" && stressYear) {
    return result;
  }
  const face = resolveRungFace(portfolio, config, baseAnnualSpending);
  if (!(face > 0)) return result;
  const existingYears = new Set(
    portfolio.filter((asset) => isTipsLadderRung(asset)).map((asset) => Number(asset.tipsLadderYear))
  );
  const fullCoverage = config.maintenanceMode === "always" || config.replenishCatchUp;
  const targets = [];
  for (let k = yearIndex + 1; k <= yearIndex + config.years; k += 1) {
    if (existingYears.has(k)) continue;
    if (fullCoverage || k === yearIndex + config.years) targets.push(k);
  }
  if (!targets.length) return result;

  const penaltyAge = Number(scenario.retirementPenaltyAge ?? 59.5);
  const classPriority = Number(stockReturn ?? 0) > config.triggerStockReturn
    ? REPLENISH_UP_CLASS_PRIORITY
    : FUNDING_CLASS_PRIORITY;
  for (const k of targets) {
    // Par coupon bond: pay the inflation-adjusted principal up front (no discount).
    const rungCost = round(face * inflationIndex, 6);
    const ageAtMaturity = (Number.isFinite(age) ? age : 0) + (k - yearIndex);
    const accountOrder = ageAtMaturity < penaltyAge
      ? ["taxable", "roth", "traditional"]
      : ["traditional", "taxable", "roth"];
    const funded = fundRung({
      portfolio,
      rungCost,
      maturityYear: k,
      yearsToMaturity: k - yearIndex,
      accountOrder,
      realYield: config.realYield,
      annualRealAmount: face,
      result,
      classPriority,
      idSuffix: `-r${yearIndex}`,
      ownerAges: ownerAges ?? { primary: age, spouse: age },
      penaltyAge
    });
    if (funded > 0) result.replenishedCount += 1;
    result.replenishedCost = round(result.replenishedCost + funded, 6);
    result.shortfall = round(result.shortfall + Math.max(0, rungCost - funded), 6);
  }
  return result;
}

// The rung's real face: derived from the largest existing per-maturity-year
// face (replenishment matches the built ladder), else the explicit config
// amount, else the year's base spending target.
function resolveRungFace(portfolio, config, baseAnnualSpending) {
  const byYear = new Map();
  for (const asset of portfolio) {
    if (!isTipsLadderRung(asset)) continue;
    const year = Number(asset.tipsLadderYear);
    byYear.set(year, (byYear.get(year) ?? 0) + Math.max(0, asset.units ?? 0));
  }
  const existingFace = byYear.size ? Math.max(...byYear.values()) : 0;
  if (existingFace > 0.000001) return round(existingFace, 6);
  if (config.annualRealAmount) return config.annualRealAmount;
  return Number.isFinite(baseAnnualSpending) && baseAnnualSpending > 0 ? round(baseAnnualSpending, 6) : 0;
}

function assetShellForRoll(asset, yearIndex) {
  const shell = {
    id: `${asset.id}-roll-${yearIndex}`,
    name: asset.name,
    accountType: asset.accountType,
    assetClass: "tips",
    ...accountMetadata(asset),
    holdingPeriod: "long",
    dividendYield: 0,
    expectedReturn: asset.expectedReturn
  };
  return shell;
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
    includeTipsLadderRungs: true,
    rothLedger: ensureRothLedger(portfolio, context)
  });

  const traditionalByOwner = { primary: 0, spouse: 0 };
  for (const sale of withdrawal.sales) {
    if (sale.accountType !== "traditional") continue;
    const owner = ownerByAssetId.get(sale.assetId) === "spouse" ? "spouse" : "primary";
    traditionalByOwner[owner] = round(traditionalByOwner[owner] + sale.proceeds, 6);
  }
  return { withdrawal, traditionalByOwner, maturedCash: withdrawal.cashRaised };
}
