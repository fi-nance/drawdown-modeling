// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: cashFlows. No behavior changes — pure code movement.

import { round } from "../utils.mjs";
import { CASH_RAISED_EPSILON } from "./constants.mjs";

export function earnedIncomeForYear(scenario, inflationIndex) {
  const index = scenario.earnedIncomeInflationAdjusted === false ? 1 : inflationIndex;
  const medicareWages = round(Math.max(0, Number(scenario.medicareWages) || 0) * index, 6);
  const socialSecurityWages = scenario.socialSecurityWages != null && Number.isFinite(Number(scenario.socialSecurityWages))
    ? round(Math.max(0, Number(scenario.socialSecurityWages) || 0) * index, 6)
    : null;
  const selfEmploymentIncome = round(Math.max(0, Number(scenario.selfEmploymentIncome) || 0) * index, 6);
  const rrtaCompensation = round(Math.max(0, Number(scenario.rrtaCompensation) || 0) * index, 6);
  const cash = round(medicareWages + selfEmploymentIncome + rrtaCompensation, 6);
  return {
    cash,
    ordinaryIncome: cash,
    medicareWages,
    socialSecurityWages,
    selfEmploymentIncome,
    rrtaCompensation
  };
}

export function emptyEarnedIncome() {
  return {
    cash: 0,
    ordinaryIncome: 0,
    medicareWages: 0,
    socialSecurityWages: null,
    selfEmploymentIncome: 0,
    rrtaCompensation: 0
  };
}

export function mergeEarnedIncome(left = emptyEarnedIncome(), right = emptyEarnedIncome()) {
  const leftSocialSecurityWages = left.socialSecurityWages;
  const rightSocialSecurityWages = right.socialSecurityWages;
  const leftHasEarnedIncome = (left.cash ?? 0) > CASH_RAISED_EPSILON;
  const rightHasEarnedIncome = (right.cash ?? 0) > CASH_RAISED_EPSILON;
  let socialSecurityWages = null;
  if (leftSocialSecurityWages != null && rightSocialSecurityWages != null) {
    socialSecurityWages = round((leftSocialSecurityWages ?? 0) + (rightSocialSecurityWages ?? 0), 6);
  } else if (leftSocialSecurityWages != null && !rightHasEarnedIncome) {
    socialSecurityWages = round(leftSocialSecurityWages, 6);
  } else if (rightSocialSecurityWages != null && !leftHasEarnedIncome) {
    socialSecurityWages = round(rightSocialSecurityWages, 6);
  }
  return {
    cash: round((left.cash ?? 0) + (right.cash ?? 0), 6),
    ordinaryIncome: round((left.ordinaryIncome ?? 0) + (right.ordinaryIncome ?? 0), 6),
    medicareWages: round((left.medicareWages ?? 0) + (right.medicareWages ?? 0), 6),
    socialSecurityWages,
    selfEmploymentIncome: round((left.selfEmploymentIncome ?? 0) + (right.selfEmploymentIncome ?? 0), 6),
    rrtaCompensation: round((left.rrtaCompensation ?? 0) + (right.rrtaCompensation ?? 0), 6)
  };
}

export function oneOffCashFlowsForYear(scenario, planYear, inflationIndex) {
  const result = emptyOneOffCashFlows();
  for (const entry of scenario.oneOffExpenses ?? []) {
    const start = entry.startYear ?? entry.year ?? 1;
    const end = entry.endYear ?? start;
    if (planYear < start || planYear > end) continue;

    const inflationAdjusted = entry.inflationAdjusted === true;
    const amount = round(Math.max(0, Number(entry.amount) || 0) * (inflationAdjusted ? inflationIndex : 1), 6);
    if (amount <= 0) continue;

    const detail = {
      name: entry.name ?? oneOffTypeLabel(entry.cashFlowType),
      cashFlowType: normalizedOneOffCashFlowType(entry.cashFlowType),
      amount,
      inflationAdjusted
    };

    switch (detail.cashFlowType) {
      case "taxableOrdinaryIncome":
        result.income += amount;
        result.taxableOrdinaryIncome += amount;
        result.incomeDetails.push(detail);
        break;
      case "medicareWages":
        result.income += amount;
        result.earnedIncome = mergeEarnedIncome(result.earnedIncome, {
          cash: amount,
          ordinaryIncome: amount,
          medicareWages: amount,
          socialSecurityWages: amount,
          selfEmploymentIncome: 0,
          rrtaCompensation: 0
        });
        result.incomeDetails.push(detail);
        break;
      case "selfEmploymentIncome":
        result.income += amount;
        result.earnedIncome = mergeEarnedIncome(result.earnedIncome, {
          cash: amount,
          ordinaryIncome: amount,
          medicareWages: 0,
          socialSecurityWages: 0,
          selfEmploymentIncome: amount,
          rrtaCompensation: 0
        });
        result.incomeDetails.push(detail);
        break;
      case "rrtaCompensation":
        result.income += amount;
        result.earnedIncome = mergeEarnedIncome(result.earnedIncome, {
          cash: amount,
          ordinaryIncome: amount,
          medicareWages: 0,
          socialSecurityWages: 0,
          selfEmploymentIncome: 0,
          rrtaCompensation: amount
        });
        result.incomeDetails.push(detail);
        break;
      case "taxFreeIncome":
        result.income += amount;
        result.taxFreeIncome += amount;
        result.incomeDetails.push(detail);
        break;
      default:
        result.expenses += amount;
        result.expenseDetails.push(detail);
        break;
    }
  }

  result.income = round(result.income, 6);
  result.expenses = round(result.expenses, 6);
  result.taxableOrdinaryIncome = round(result.taxableOrdinaryIncome, 6);
  result.taxFreeIncome = round(result.taxFreeIncome, 6);
  return result;
}

export function emptyOneOffCashFlows() {
  return {
    income: 0,
    expenses: 0,
    taxableOrdinaryIncome: 0,
    taxFreeIncome: 0,
    earnedIncome: emptyEarnedIncome(),
    incomeDetails: [],
    expenseDetails: []
  };
}

function normalizedOneOffCashFlowType(type) {
  return [
    "taxableOrdinaryIncome",
    "medicareWages",
    "selfEmploymentIncome",
    "rrtaCompensation",
    "taxFreeIncome"
  ].includes(type) ? type : "expense";
}

function oneOffTypeLabel(type) {
  return normalizedOneOffCashFlowType(type) === "expense" ? "One-off expense" : "One-off income";
}
