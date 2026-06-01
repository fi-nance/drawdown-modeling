// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: withdrawalOrders. No behavior changes — pure code movement.

import { round } from "../utils.mjs";

const FULL_WITHDRAWAL_ORDER = ["taxable", "traditional", "hsa", "roth"];

export function normalizedWithdrawalOrder(withdrawalOrder = []) {
  return [...new Set((withdrawalOrder ?? []).filter(Boolean))];
}

export function forcedWithdrawalOrder(withdrawalOrder = []) {
  const preferred = normalizedWithdrawalOrder(withdrawalOrder);
  return [
    ...preferred,
    ...FULL_WITHDRAWAL_ORDER.filter((accountType) => !preferred.includes(accountType))
  ];
}

export function rothPreservingWithdrawalOrder(withdrawalOrder) {
  return [
    ...withdrawalOrder.filter((accountType) => accountType !== "roth"),
    ...withdrawalOrder.filter((accountType) => accountType === "roth")
  ];
}

export function rothFirstWithdrawalOrder(withdrawalOrder) {
  return [
    ...withdrawalOrder.filter((accountType) => accountType === "roth"),
    ...withdrawalOrder.filter((accountType) => accountType !== "roth")
  ];
}

export function earlyPenaltyAvoidanceWithdrawalOrder(withdrawalOrder) {
  const normalized = normalizedWithdrawalOrder(withdrawalOrder);
  return [
    ...normalized.filter((accountType) => accountType !== "traditional" && accountType !== "roth"),
    ...normalized.filter((accountType) => accountType === "roth"),
    ...normalized.filter((accountType) => accountType === "traditional")
  ];
}

export function sameWithdrawalOrder(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isBeforePenaltyAge(withdrawalContext = {}) {
  return (withdrawalContext.age ?? 99) < (withdrawalContext.penaltyAge ?? 59.5);
}

export function withdrawalPenaltyBurden(withdrawal) {
  return Math.max(0, withdrawal?.penaltyTax ?? 0);
}

export function hasLowerPenaltyBurden(candidateWithdrawal, baselineWithdrawal) {
  return withdrawalPenaltyBurden(candidateWithdrawal) + 0.01 < withdrawalPenaltyBurden(baselineWithdrawal);
}

export function betterPenaltyAvoidancePlan(candidate, incumbent) {
  if (!incumbent) return true;
  const candidatePenalty = withdrawalPenaltyBurden(candidate.withdrawal);
  const incumbentPenalty = withdrawalPenaltyBurden(incumbent.withdrawal);
  if (candidatePenalty + 0.01 < incumbentPenalty) return true;
  if (candidatePenalty > incumbentPenalty + 0.01) return false;
  if (candidate.modeledCost + 0.01 < incumbent.modeledCost) return true;
  if (candidate.modeledCost > incumbent.modeledCost + 0.01) return false;
  return rothWithdrawalProceeds(candidate.withdrawal) + 0.000001 < rothWithdrawalProceeds(incumbent.withdrawal);
}

export function optimizedRothProceedsLimit(withdrawalContext) {
  if ((withdrawalContext.age ?? 99) >= (withdrawalContext.penaltyAge ?? 59.5)) return Infinity;
  const available = Number(withdrawalContext.rothBasisAvailable);
  if (Number.isFinite(available)) return Math.max(0, available);
  return Math.max(0, Number(withdrawalContext.rothBasisRemaining) || 0);
}

export function rothWithdrawalProceeds(withdrawal) {
  return round(withdrawal?.sales?.reduce((total, sale) => (
    sale.accountType === "roth" ? total + Math.max(0, sale.proceeds ?? 0) : total
  ), 0) ?? 0, 6);
}
