// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: withdrawalExecution. No behavior changes — pure code movement.

import { marketValue, removeEmptyLots, sellFromLot } from "../portfolio.mjs";
import { round } from "../utils.mjs";
import { allocationWithdrawalStateForPortfolio } from "./allocation.mjs";
import { accountLabel, saleSortForWithdrawalContext } from "./saleComparators.mjs";
import { expectedReturnForAsset } from "./scenario.mjs";

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
  let rothBasisRemaining = Math.max(0, context.rothBasisRemaining ?? 0);
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
  const isEarly = age < penaltyAge;
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
    const saleSort = saleSortForWithdrawalContext({ accountType, isEarly, maxRothProceeds, context: saleContext });
    const candidates = portfolio
      .filter((asset) => asset.accountType === accountType && marketValue(asset) > 0)
      .sort(saleSort);

    for (const asset of candidates) {
      if (remaining <= 0) break;
      let requestedSale = remaining;
      if (accountType === "roth") {
        const rothRoom = maxRothProceeds - result.rothProceeds;
        if (rothRoom <= 0.000001) break;
        requestedSale = Math.min(requestedSale, rothRoom);
      } else if (accountType === "hsa") {
        const hsaRoom = maxHsaProceeds - result.hsaProceeds;
        if (hsaRoom <= 0.000001) break;
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
        isEarly,
        penaltyRate,
        calendarYear,
        rothFiveYearRuleSatisfied,
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

  if (sale.accountType !== "roth") {
    sale.ordinaryIncome = 0;
    sale.penaltyBase = 0;
    sale.penaltyExceptionUsed = 0;
    sale.penaltyTax = 0;
    return;
  }

  if (!context.isEarly && context.rothFiveYearRuleSatisfied !== false) {
    sale.ordinaryIncome = 0;
    sale.penaltyBase = 0;
    sale.penaltyExceptionUsed = 0;
    sale.penaltyTax = 0;
    return;
  }

  let remaining = sale.proceeds;
  const basisUsed = context.useRothBasis(remaining);
  remaining -= basisUsed;

  const conversionPrincipal = sale.rothSource === "conversion"
    ? Math.min(remaining, sale.costBasisSold ?? remaining)
    : 0;
  const conversionIsInsideFiveYears = sale.rothSource === "conversion"
    && Number.isFinite(sale.conversionYear)
    && context.calendarYear - sale.conversionYear < 5;
  const conversionPenaltyBase = conversionIsInsideFiveYears ? conversionPrincipal : 0;
  remaining -= conversionPrincipal;

  const taxableEarnings = Math.max(0, remaining);
  const penalty = applyPenaltyException(context, context.isEarly ? conversionPenaltyBase + taxableEarnings : 0);
  sale.rothBasisUsed = basisUsed;
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
  let remaining = Math.max(0, requestedAmount);
  let converted = 0;

  for (const asset of [...portfolio]) {
    if (remaining <= 0) break;
    if (asset.accountType !== "traditional" || marketValue(asset) <= 0) continue;

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
    remaining -= amount;
    converted += amount;
  }

  removeEmptyLots(portfolio);
  return round(converted, 6);
}

export function rothBasisSummaryForYear(portfolio, { age, calendarYear, penaltyAge }) {
  const isEarly = Number(age) < Number(penaltyAge);
  let conversionPrincipal = 0;
  let penaltyFreeConversionPrincipal = 0;

  for (const asset of portfolio) {
    if (asset?.accountType !== "roth" || asset.rothSource !== "conversion") continue;
    const principal = Math.max(0, Math.min(marketValue(asset), (asset.units ?? 0) * (asset.costBasisPerUnit ?? 0)));
    if (!(principal > 0)) continue;
    conversionPrincipal += principal;
    const conversionYear = Number(asset.conversionYear);
    const conversionFiveYearClockMet = Number.isFinite(conversionYear) && calendarYear - conversionYear >= 5;
    if (!isEarly || conversionFiveYearClockMet) {
      penaltyFreeConversionPrincipal += principal;
    }
  }

  return {
    conversionPrincipal: round(conversionPrincipal, 6),
    penaltyFreeConversionPrincipal: round(penaltyFreeConversionPrincipal, 6)
  };
}

export function rothBasisAvailableForWithdrawal(portfolio, { rothBasisRemaining = 0, age, calendarYear, penaltyAge }) {
  if (Number(age) >= Number(penaltyAge)) return Infinity;
  const summary = rothBasisSummaryForYear(portfolio, { age, calendarYear, penaltyAge });
  return round(Math.max(0, Number(rothBasisRemaining) || 0) + summary.penaltyFreeConversionPrincipal, 6);
}
