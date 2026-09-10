// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: withdrawalExecution. No behavior changes — pure code movement.

import { ensureRothLedger, consumeRothDistribution, recordRothConversion, rothContributionBalance, rothLedgerSummary } from "../rothLedger.mjs";
import { marketValue, removeEmptyLots, sellFromLot } from "../portfolio.mjs";
import { round } from "../utils.mjs";
import { allocationWithdrawalStateForPortfolio } from "./allocation.mjs";
import { accountLabel, saleSortForWithdrawalContext } from "./saleComparators.mjs";
import { expectedReturnForAsset } from "./scenario.mjs";

// IRC §223(f)(4)(C): the 20% additional tax on nonqualified HSA distributions
// no longer applies once the account holder reaches 65 — the distribution is
// simply ordinary income. Before 65 the withdrawal engine never sells beyond
// the tracked qualified-expense pool (a penalized nonqualified distribution
// is never a planning recommendation), so the 20% additional tax is not modeled.
const HSA_ORDINARY_DISTRIBUTION_AGE = 65;

export function earlyWithdrawalPenaltyExceptionAmountForYear(scenario) {
  const amount = Number(scenario.earlyWithdrawalPenaltyExceptionAmount);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function mergeWithdrawals(base, addition) {
  return {
    cashRaised: round(base.cashRaised + addition.cashRaised, 6),
    ordinaryIncome: round(base.ordinaryIncome + addition.ordinaryIncome, 6),
    shortTermCapitalGains: round(base.shortTermCapitalGains + addition.shortTermCapitalGains, 6),
    longTermCapitalGains: round(base.longTermCapitalGains + addition.longTermCapitalGains, 6),
    capitalLosses: round(base.capitalLosses + addition.capitalLosses, 6),
    shortTermCapitalLosses: round((base.shortTermCapitalLosses ?? 0) + (addition.shortTermCapitalLosses ?? 0), 6),
    longTermCapitalLosses: round((base.longTermCapitalLosses ?? 0) + (addition.longTermCapitalLosses ?? 0), 6),
    penaltyTax: round(base.penaltyTax + addition.penaltyTax, 6),
    penaltyBase: round(base.penaltyBase + addition.penaltyBase, 6),
    penaltyExceptionUsed: round((base.penaltyExceptionUsed ?? 0) + (addition.penaltyExceptionUsed ?? 0), 6),
    penaltyExceptionRemaining: round(Math.max(0, addition.penaltyExceptionRemaining ?? base.penaltyExceptionRemaining ?? 0), 6),
    rothProceeds: round((base.rothProceeds ?? 0) + (addition.rothProceeds ?? 0), 6),
    rothBasisUsed: round(base.rothBasisUsed + addition.rothBasisUsed, 6),
    rothBasisRemaining: addition.rothBasisRemaining,
    hsaProceeds: round((base.hsaProceeds ?? 0) + (addition.hsaProceeds ?? 0), 6),
    hsaQualifiedExpenseUsed: round((base.hsaQualifiedExpenseUsed ?? 0) + (addition.hsaQualifiedExpenseUsed ?? 0), 6),
    saleOpportunityCost: round((base.saleOpportunityCost ?? 0) + (addition.saleOpportunityCost ?? 0), 6),
    sales: [...base.sales, ...addition.sales],
    flows: [...base.flows, ...addition.flows]
  };
}

export function emptyWithdrawal(rothBasisRemaining = 0, penaltyExceptionRemaining = 0) {
  return {
    cashRaised: 0,
    ordinaryIncome: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    penaltyTax: 0,
    penaltyBase: 0,
    penaltyExceptionUsed: 0,
    penaltyExceptionRemaining: round(Math.max(0, penaltyExceptionRemaining), 6),
    rothProceeds: 0,
    rothBasisUsed: 0,
    rothBasisRemaining: round(Math.max(0, rothBasisRemaining), 6),
    hsaProceeds: 0,
    hsaQualifiedExpenseUsed: 0,
    saleOpportunityCost: 0,
    sales: [],
    flows: []
  };
}

export function withdrawForCash(portfolio, amount, withdrawalOrder = [], context = {}) {
  let remaining = Math.max(0, amount);
  const rothLedger = context.rothLedger ?? ensureRothLedger(portfolio, context);
  let rothBasisRemaining = rothContributionBalance(rothLedger);
  let penaltyExceptionRemaining = Math.max(0, context.penaltyExceptionRemaining ?? 0);
  const allocationWithdrawal = allocationWithdrawalStateForPortfolio(portfolio, context.allocationStrategy);
  const saleContext = {
    ...context,
    allocationWithdrawal
  };
  const age = context.age ?? 99;
  const calendarYear = context.calendarYear ?? 0;
  const penaltyAge = context.penaltyAge ?? 59.5;
  const penaltyRate = context.penaltyRate ?? 0.1;
  const rothFiveYearRuleSatisfied = context.rothFiveYearRuleSatisfied !== false;
  const maxRothProceeds = Number.isFinite(Number(context.maxRothProceeds))
    ? Math.max(0, Number(context.maxRothProceeds))
    : Infinity;
  const maxHsaProceeds = Number.isFinite(Number(context.hsaQualifiedExpenseAvailable))
    ? Math.max(0, Number(context.hsaQualifiedExpenseAvailable))
    : Infinity;
  // Household-level isEarly drives the lot-sort heuristic; the penalty and
  // HSA-age rules themselves are applied per asset via ageForAsset below.
  const isEarly = age < penaltyAge;
  // Per-asset owner ages: when the caller supplies ownerAges, spouse-owned
  // accounts apply the SPOUSE's age to the early-withdrawal penalty and the
  // HSA age-65 ordinary-distribution rule. Without ownerAges (or for untagged
  // assets) everything uses the household `age` — the pre-owner behavior.
  const ownerAges = context.ownerAges ?? null;
  const ageForAsset = (asset) => {
    if (!ownerAges || asset?.owner !== "spouse") return age;
    const spouseOwnerAge = Number(ownerAges.spouse);
    return Number.isFinite(spouseOwnerAge) ? spouseOwnerAge : age;
  };
  const result = {
    cashRaised: 0,
    ordinaryIncome: 0,
    shortTermCapitalGains: 0,
    longTermCapitalGains: 0,
    capitalLosses: 0,
    shortTermCapitalLosses: 0,
    longTermCapitalLosses: 0,
    penaltyTax: 0,
    penaltyBase: 0,
    penaltyExceptionUsed: 0,
    penaltyExceptionRemaining,
    rothProceeds: 0,
    rothBasisUsed: 0,
    rothBasisRemaining,
    hsaProceeds: 0,
    hsaQualifiedExpenseUsed: 0,
    saleOpportunityCost: 0,
    sales: [],
    flows: []
  };

  for (const accountType of withdrawalOrder) {
    const baseSaleSort = saleSortForWithdrawalContext({ accountType, isEarly, maxRothProceeds, context: saleContext });
    // TIPS ladder rungs are reserved for their maturity year: ordinary
    // withdrawals skip them entirely. The forced last-resort funding path
    // passes includeTipsLadderRungs so a plan can break the ladder rather
    // than fail — rungs then sort LAST within their account bucket.
    const saleSort = (a, b) => {
      const aRung = a.tipsLadderYear != null;
      const bRung = b.tipsLadderYear != null;
      if (aRung !== bRung) return aRung ? 1 : -1;
      return baseSaleSort(a, b);
    };
    const candidates = portfolio
      .filter((asset) => asset.accountType === accountType
        && marketValue(asset) > 0
        && (context.includeTipsLadderRungs === true || asset.tipsLadderYear == null))
      .sort(saleSort);

    for (const asset of candidates) {
      if (remaining <= 0) break;
      const assetAge = ageForAsset(asset);
      const assetIsEarly = assetAge < penaltyAge;
      const assetHsaOrdinaryEligible = assetAge >= HSA_ORDINARY_DISTRIBUTION_AGE;
      let requestedSale = remaining;
      if (accountType === "roth") {
        const rothRoom = maxRothProceeds - result.rothProceeds;
        if (rothRoom <= 0.000001) break;
        requestedSale = Math.min(requestedSale, rothRoom);
        if (Number.isFinite(maxRothProceeds)) {
          const key = rothLedger.ownerAliases[asset.owner === "spouse" ? "spouse" : "primary"] ?? (asset.owner === "spouse" ? "spouse" : "primary");
          const safe = rothLedgerSummary(portfolio, context).ownerAvailable[key] ?? 0;
          requestedSale = Math.min(requestedSale, safe);
          if (requestedSale <= 0.000001) continue;
        }
      } else if (accountType === "hsa" && !assetHsaOrdinaryEligible) {
        // Before the owner is 65, HSA sales are capped at the tracked
        // qualified-expense pool. At 65+, the cap lifts: the excess is sold
        // and taxed as ordinary income in applyRetirementDistributionTax.
        const hsaRoom = maxHsaProceeds - result.hsaProceeds;
        if (hsaRoom <= 0.000001) continue;
        requestedSale = Math.min(requestedSale, hsaRoom);
      }
      const sale = sellFromLot(asset, requestedSale);
      if (sale.proceeds <= 0) continue;

      remaining -= sale.proceeds;
      result.cashRaised += sale.proceeds;
      sale.expectedReturn = expectedReturnForAsset(asset, saleContext.returnAssumptions);
      sale.opportunityCost = round(Math.max(0, sale.proceeds * Math.max(0, sale.expectedReturn ?? 0)), 6);
      result.saleOpportunityCost += sale.opportunityCost;
      if (sale.accountType === "roth") result.rothProceeds += sale.proceeds;
      if (sale.accountType === "hsa") {
        const qualified = Math.min(sale.proceeds, Math.max(0, maxHsaProceeds - result.hsaQualifiedExpenseUsed));
        sale.hsaQualifiedExpenseUsed = round(qualified, 6);
        result.hsaProceeds += sale.proceeds;
        result.hsaQualifiedExpenseUsed += qualified;
      }
      applyRetirementDistributionTax(sale, {
        result,
        isEarly: assetIsEarly,
        hsaOrdinaryEligible: assetHsaOrdinaryEligible,
        penaltyRate,
        calendarYear,
        rothFiveYearRuleSatisfied: Object.keys(rothLedger.ownerAliases).length ? rothFiveYearRuleSatisfied || (context.spouseRothFiveYearRuleSatisfied ?? rothFiveYearRuleSatisfied) !== false : asset.owner === "spouse" ? context.spouseRothFiveYearRuleSatisfied ?? rothFiveYearRuleSatisfied : rothFiveYearRuleSatisfied,
        rothLedger,
        getRothBasis: () => rothBasisRemaining,
        useRothBasis: (amountUsed) => {
          const used = Math.min(rothBasisRemaining, Math.max(0, amountUsed));
          rothBasisRemaining = round(rothBasisRemaining - used, 6);
          result.rothBasisUsed += used;
          result.rothBasisRemaining = rothBasisRemaining;
          return used;
        },
        usePenaltyException: (penaltyBase) => {
          const rawPenaltyBase = Math.max(0, penaltyBase);
          const used = Math.min(penaltyExceptionRemaining, rawPenaltyBase);
          penaltyExceptionRemaining = round(penaltyExceptionRemaining - used, 6);
          result.penaltyExceptionUsed = round(result.penaltyExceptionUsed + used, 6);
          result.penaltyExceptionRemaining = penaltyExceptionRemaining;
          return {
            exceptionUsed: round(used, 6),
            penaltyBase: round(rawPenaltyBase - used, 6)
          };
        }
      });
      result.sales.push(sale);
      result.flows.push(...withdrawalFlowsForSale(sale));

      if (sale.accountType === "taxable" && sale.taxType === "ordinary") {
        result.shortTermCapitalGains += Math.max(0, sale.gain);
      } else if (sale.accountType === "taxable" && sale.taxType === "capital-gains") {
        result.longTermCapitalGains += Math.max(0, sale.gain);
      } else if (sale.accountType === "taxable" && sale.taxType === "capital-loss-short") {
        const loss = Math.abs(Math.min(0, sale.gain));
        result.capitalLosses += loss;
        result.shortTermCapitalLosses += loss;
      } else if (sale.accountType === "taxable" && sale.taxType === "capital-loss-long") {
        const loss = Math.abs(Math.min(0, sale.gain));
        result.capitalLosses += loss;
        result.longTermCapitalLosses += loss;
      }
    }
  }

  result.cashRaised = round(result.cashRaised, 6);
  result.ordinaryIncome = round(result.ordinaryIncome, 6);
  result.shortTermCapitalGains = round(result.shortTermCapitalGains, 6);
  result.longTermCapitalGains = round(result.longTermCapitalGains, 6);
  result.capitalLosses = round(result.capitalLosses, 6);
  result.shortTermCapitalLosses = round(result.shortTermCapitalLosses, 6);
  result.longTermCapitalLosses = round(result.longTermCapitalLosses, 6);
  result.penaltyTax = round(result.penaltyTax, 6);
  result.penaltyBase = round(result.penaltyBase, 6);
  result.penaltyExceptionUsed = round(result.penaltyExceptionUsed, 6);
  result.penaltyExceptionRemaining = round(penaltyExceptionRemaining, 6);
  result.rothProceeds = round(result.rothProceeds, 6);
  result.rothBasisUsed = round(result.rothBasisUsed, 6);
  result.rothBasisRemaining = round(rothBasisRemaining, 6);
  result.hsaProceeds = round(result.hsaProceeds, 6);
  result.hsaQualifiedExpenseUsed = round(result.hsaQualifiedExpenseUsed, 6);
  result.saleOpportunityCost = round(result.saleOpportunityCost, 6);
  return result;
}

function withdrawalFlowsForSale(sale) {
  if (sale.accountType !== "roth" || !(sale.rothBasisUsed > 0)) {
    return [{
      from: accountLabel(sale.accountType),
      to: "Spending reserve",
      amount: sale.proceeds,
      type: "withdrawal"
    }];
  }

  const basisAmount = Math.min(sale.proceeds, sale.rothBasisUsed);
  const remaining = Math.max(0, sale.proceeds - basisAmount);
  return [
    {
      from: "Roth basis used",
      to: "Spending reserve",
      amount: basisAmount,
      type: "withdrawal"
    },
    ...(remaining > 0.000001 ? [{
      from: "Roth accounts",
      to: "Spending reserve",
      amount: remaining,
      type: "withdrawal"
    }] : [])
  ];
}

function applyRetirementDistributionTax(sale, context) {
  if (sale.accountType === "traditional") {
    const penalty = applyPenaltyException(context, context.isEarly ? sale.proceeds : 0);
    sale.ordinaryIncome = sale.proceeds;
    sale.penaltyBase = penalty.penaltyBase;
    sale.penaltyExceptionUsed = penalty.exceptionUsed;
    sale.penaltyTax = sale.penaltyBase * context.penaltyRate;
    context.result.ordinaryIncome += sale.proceeds;
    context.result.penaltyBase += sale.penaltyBase;
    context.result.penaltyTax += sale.penaltyTax;
    return;
  }

  if (sale.accountType === "hsa") {
    // The qualified-expense portion is tax-free. At 65+, proceeds beyond the
    // tracked qualified pool are taxed as ordinary income with no additional
    // tax (IRC §223(f)(4)(C)). Before 65 the sale is already capped at the
    // qualified pool, so the taxable portion is always zero there.
    const qualified = Math.max(0, Math.min(sale.proceeds, sale.hsaQualifiedExpenseUsed ?? sale.proceeds));
    const taxableHsaIncome = context.hsaOrdinaryEligible ? Math.max(0, sale.proceeds - qualified) : 0;
    sale.ordinaryIncome = taxableHsaIncome;
    sale.penaltyBase = 0;
    sale.penaltyExceptionUsed = 0;
    sale.penaltyTax = 0;
    if (taxableHsaIncome > 0.000001) sale.taxType = "hsa-ordinary";
    context.result.ordinaryIncome += taxableHsaIncome;
    return;
  }

  if (sale.accountType !== "roth") {
    sale.ordinaryIncome = 0;
    sale.penaltyBase = 0;
    sale.penaltyExceptionUsed = 0;
    sale.penaltyTax = 0;
    return;
  }

  const distribution = consumeRothDistribution(context.rothLedger, sale.owner, sale.proceeds, {
    calendarYear: context.calendarYear,
    isEarly: context.isEarly,
    qualified: !context.isEarly && context.rothFiveYearRuleSatisfied !== false
  });
  const basisUsed = context.useRothBasis(distribution.contributions);
  const taxableEarnings = distribution.earnings;
  const conversionPenaltyBase = distribution.penaltyBase;
  const penalty = applyPenaltyException(context, distribution.penaltyBase);
  sale.rothBasisUsed = basisUsed;
  sale.rothConversionPrincipalUsed = distribution.conversionPrincipal;
  sale.ordinaryIncome = taxableEarnings;
  sale.penaltyBase = penalty.penaltyBase;
  sale.penaltyExceptionUsed = penalty.exceptionUsed;
  sale.penaltyTax = sale.penaltyBase * context.penaltyRate;
  sale.taxType = taxableEarnings > 0
    ? context.isEarly ? "roth-earnings" : "roth-nonqualified-earnings"
    : conversionPenaltyBase > 0
      ? "roth-conversion-penalty"
      : "roth-basis";

  context.result.ordinaryIncome += taxableEarnings;
  context.result.penaltyBase += sale.penaltyBase;
  context.result.penaltyTax += sale.penaltyTax;
}

function applyPenaltyException(context, rawPenaltyBase) {
  if (!(rawPenaltyBase > 0)) {
    return { penaltyBase: 0, exceptionUsed: 0 };
  }
  return context.usePenaltyException?.(rawPenaltyBase) ?? {
    penaltyBase: rawPenaltyBase,
    exceptionUsed: 0
  };
}

export function convertTraditionalToRoth(portfolio, requestedAmount, calendarYear) {
  ensureRothLedger(portfolio);
  let remaining = Math.max(0, requestedAmount);
  let converted = 0;

  for (const asset of [...portfolio]) {
    if (remaining <= 0) break;
    if (asset.accountType !== "traditional" || marketValue(asset) <= 0) continue;
    // TIPS ladder rungs stay on their maturity schedule — converting one to
    // Roth would silently dismantle the ladder (and clone its maturity tag).
    if (asset.tipsLadderYear != null) continue;

    const amount = Math.min(remaining, marketValue(asset));
    const units = amount / asset.price;
    asset.units = Math.max(0, asset.units - units);
    portfolio.push({
      ...asset,
      id: `${asset.id}-roth-${portfolio.length + 1}`,
      name: `${asset.name ?? asset.id} Roth`,
      accountType: "roth",
      units,
      costBasisPerUnit: asset.price,
      holdingPeriod: "long",
      rothSource: "conversion",
      conversionYear: calendarYear
    });
    recordRothConversion(portfolio, asset.owner, calendarYear, amount);
    remaining -= amount;
    converted += amount;
  }

  removeEmptyLots(portfolio);
  return round(converted, 6);
}

export function rothBasisSummaryForYear(portfolio, options) {
  const { conversionPrincipal, penaltyFreeConversionPrincipal } = rothLedgerSummary(portfolio, options);
  return { conversionPrincipal, penaltyFreeConversionPrincipal };
}

export function rothBasisAvailableForWithdrawal(portfolio, options) {
  return rothLedgerSummary(portfolio, options).available;
}
