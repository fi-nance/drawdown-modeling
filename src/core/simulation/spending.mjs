// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: spending. No behavior changes — pure code movement.

import { round } from "../utils.mjs";
import { oneOffCashFlowsForYear } from "./cashFlows.mjs";
import { nonNegativeNumber, normalizedPercent } from "./guards.mjs";
import { DEFAULT_SCENARIO } from "./scenario.mjs";

export function spendingStrategyConfig(scenario = {}) {
  const raw = scenario.spendingStrategy ?? {};
  const mode = ["discretionaryGuardrails", "guytonKlinger", "kitces", "vpw"].includes(raw.mode) ? raw.mode : "fixed";
  const targetSpend = Math.max(0, Number(scenario.targetSpend) || 0);
  const essentialFallback = mode === "discretionaryGuardrails" ? targetSpend : DEFAULT_SCENARIO.spendingStrategy.essentialSpend;
  const discretionaryFallback = mode === "discretionaryGuardrails" ? 0 : DEFAULT_SCENARIO.spendingStrategy.discretionarySpend;
  const correctionThreshold = normalizedPercent(
    raw.correctionDrawdownThreshold,
    DEFAULT_SCENARIO.spendingStrategy.correctionDrawdownThreshold
  );
  const bearThreshold = Math.max(
    correctionThreshold,
    normalizedPercent(raw.bearDrawdownThreshold, DEFAULT_SCENARIO.spendingStrategy.bearDrawdownThreshold)
  );

  return {
    mode,
    essentialSpend: nonNegativeNumber(raw.essentialSpend, essentialFallback),
    discretionarySpend: nonNegativeNumber(raw.discretionarySpend, discretionaryFallback),
    essentialInflationAdjusted: raw.essentialInflationAdjusted !== false,
    discretionaryInflationAdjusted: raw.discretionaryInflationAdjusted === true,
    correctionDrawdownThreshold: correctionThreshold,
    bearDrawdownThreshold: bearThreshold,
    correctionDiscretionaryPercent: normalizedPercent(
      raw.correctionDiscretionaryPercent,
      DEFAULT_SCENARIO.spendingStrategy.correctionDiscretionaryPercent
    ),
    bearDiscretionaryPercent: normalizedPercent(
      raw.bearDiscretionaryPercent,
      DEFAULT_SCENARIO.spendingStrategy.bearDiscretionaryPercent
    ),
    marketAssetClass: raw.marketAssetClass || DEFAULT_SCENARIO.spendingStrategy.marketAssetClass
  };
}

export function initialSpendingGuardrailMarketState() {
  return { marketIndex: 1, highWaterMark: 1 };
}

export function spendingGuardrailStateForYear({ scenario, marketState }) {
  const config = spendingStrategyConfig(scenario);
  if (config.mode !== "discretionaryGuardrails") return null;

  const index = Math.max(0.000001, Number(marketState?.marketIndex) || 1);
  const high = Math.max(index, Number(marketState?.highWaterMark) || 1);
  const drawdown = high > 0 ? Math.max(0, 1 - (index / high)) : 0;
  const discretionaryPercent = drawdown + 0.0000001 >= config.bearDrawdownThreshold
    ? config.bearDiscretionaryPercent
    : drawdown + 0.0000001 >= config.correctionDrawdownThreshold
      ? config.correctionDiscretionaryPercent
      : 1;

  return {
    enabled: true,
    marketAssetClass: config.marketAssetClass,
    marketIndex: round(index, 6),
    marketHighWaterMark: round(high, 6),
    marketDrawdown: round(drawdown, 6),
    correctionDrawdownThreshold: config.correctionDrawdownThreshold,
    bearDrawdownThreshold: config.bearDrawdownThreshold,
    discretionaryPercent: round(discretionaryPercent, 6)
  };
}

export function advanceSpendingGuardrailMarketState({ scenario, marketState, returnByAssetClass = {} }) {
  const config = spendingStrategyConfig(scenario);
  const currentIndex = Math.max(0.000001, Number(marketState?.marketIndex) || 1);
  const currentHigh = Math.max(currentIndex, Number(marketState?.highWaterMark) || 1);
  const marketReturn = guardrailMarketReturn({
    scenario,
    returnByAssetClass,
    marketAssetClass: config.marketAssetClass
  });
  const nextIndex = Math.max(0.000001, currentIndex * (1 + Math.max(-0.99, marketReturn)));
  return {
    marketIndex: nextIndex,
    highWaterMark: Math.max(currentHigh, nextIndex)
  };
}

function guardrailMarketReturn({ scenario, returnByAssetClass = {}, marketAssetClass = "stock" }) {
  const candidates = [
    returnByAssetClass?.[marketAssetClass],
    returnByAssetClass?.default,
    scenario?.returnAssumptions?.[marketAssetClass]?.mean,
    DEFAULT_SCENARIO.returnAssumptions?.[marketAssetClass]?.mean,
    0
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function plannedSpendingForYear(scenario, planYear, inflationIndex, oneOffCashFlows = null, spendingGuardrail = null) {
  return plannedSpendingDetailForYear(scenario, planYear, inflationIndex, oneOffCashFlows, spendingGuardrail).total;
}

export function plannedSpendingDetailForYear(scenario, planYear, inflationIndex, oneOffCashFlows = null, spendingGuardrail = null, passedBaseSpend = null) {
  const scheduled = oneOffCashFlows ?? oneOffCashFlowsForYear(scenario, planYear, inflationIndex);
  const strategy = spendingStrategyConfig(scenario);
  const oneOffExpenses = round(scheduled.expenses, 6);

  if (passedBaseSpend !== null) {
    const total = round(passedBaseSpend + oneOffExpenses, 6);
    return {
      total,
      baseSpend: round(passedBaseSpend, 6),
      essentialSpend: round(passedBaseSpend, 6),
      discretionaryBudget: 0,
      discretionarySpend: 0,
      oneOffExpenses,
      guardrail: spendingGuardrail,
      strategy: {
        mode: strategy.mode,
        discretionaryPercent: 1
      }
    };
  }

  if (strategy.mode === "discretionaryGuardrails") {
    const essentialSpend = round(strategy.essentialSpend * (strategy.essentialInflationAdjusted ? inflationIndex : 1), 6);
    const discretionaryBudget = round(strategy.discretionarySpend * (strategy.discretionaryInflationAdjusted ? inflationIndex : 1), 6);
    const discretionaryPercent = Number.isFinite(Number(spendingGuardrail?.discretionaryPercent))
      ? Math.max(0, Math.min(1, Number(spendingGuardrail.discretionaryPercent)))
      : 1;
    const discretionarySpend = round(discretionaryBudget * discretionaryPercent, 6);
    const total = round(essentialSpend + discretionarySpend + oneOffExpenses, 6);
    return {
      total,
      baseSpend: round(essentialSpend + discretionaryBudget, 6),
      essentialSpend,
      discretionaryBudget,
      discretionarySpend,
      oneOffExpenses,
      guardrail: spendingGuardrail,
      strategy: {
        mode: strategy.mode,
        essentialInflationAdjusted: strategy.essentialInflationAdjusted,
        discretionaryInflationAdjusted: strategy.discretionaryInflationAdjusted,
        discretionaryPercent
      }
    };
  }

  const baseSpend = (scenario.targetSpend ?? 0)
    * (scenario.targetSpendInflationAdjusted === false ? 1 : inflationIndex);
  const total = round(baseSpend + oneOffExpenses, 6);
  return {
    total,
    baseSpend: round(baseSpend, 6),
    essentialSpend: round(baseSpend, 6),
    discretionaryBudget: 0,
    discretionarySpend: 0,
    oneOffExpenses,
    guardrail: null,
    strategy: { mode: "fixed", discretionaryPercent: 1 }
  };
}
