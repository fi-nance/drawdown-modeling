import { clonePortfolio, portfolioValue } from "../portfolio.mjs";
import { round } from "../utils.mjs";

export const RISK_BASED_GUARDRAILS_MODE = "riskBasedGuardrails";

export const DEFAULT_RISK_BASED_GUARDRAILS = Object.freeze({
  targetSuccessRate: 0.9,
  lowerSuccessRate: 0.75,
  upperSuccessRate: 1,
  minimumAdjustmentPercent: 0.05,
  incomeFloor: null,
  incomeCeiling: null,
  inflationAdjusted: true,
  solverIterations: 7
});

export function isRiskBasedGuardrailsMode(mode) {
  return mode === RISK_BASED_GUARDRAILS_MODE;
}

export function normalizeRiskBasedGuardrails(raw = {}) {
  const table = plainObject(raw.table) ? normalizeRiskBasedGuardrailTable(raw.table) : null;
  return {
    targetSuccessRate: boundedRate(raw.targetSuccessRate, DEFAULT_RISK_BASED_GUARDRAILS.targetSuccessRate),
    lowerSuccessRate: boundedRate(raw.lowerSuccessRate, DEFAULT_RISK_BASED_GUARDRAILS.lowerSuccessRate),
    upperSuccessRate: boundedRate(raw.upperSuccessRate, DEFAULT_RISK_BASED_GUARDRAILS.upperSuccessRate),
    minimumAdjustmentPercent: boundedRate(raw.minimumAdjustmentPercent, DEFAULT_RISK_BASED_GUARDRAILS.minimumAdjustmentPercent),
    incomeFloor: optionalNonNegative(raw.incomeFloor),
    incomeCeiling: optionalNonNegative(raw.incomeCeiling),
    inflationAdjusted: raw.inflationAdjusted !== false,
    solverIterations: boundedInteger(raw.solverIterations, 3, 12, DEFAULT_RISK_BASED_GUARDRAILS.solverIterations),
    table
  };
}

export function normalizeRiskBasedGuardrailTable(table = {}) {
  const initialPortfolioValue = nonNegative(table.initialPortfolioValue);
  const fixedFailsafeSpend = nonNegative(table.fixedFailsafeSpend);
  const initialSpend = nonNegative(table.initialSpend);
  const lowerGuardrailPortfolioValue = optionalNonNegative(table.lowerGuardrailPortfolioValue);
  const lowerAdjustedSpend = optionalNonNegative(table.lowerAdjustedSpend);
  const upperGuardrailPortfolioValue = optionalNonNegative(table.upperGuardrailPortfolioValue);
  const upperAdjustedSpend = optionalNonNegative(table.upperAdjustedSpend);

  return {
    method: table.method === "monteCarlo" ? "monteCarlo" : "historical",
    sequenceCount: Math.max(0, Math.trunc(Number(table.sequenceCount) || 0)),
    initialPortfolioValue,
    fixedFailsafeSpend,
    initialSpend,
    lowerGuardrailPortfolioValue,
    lowerAdjustedSpend,
    upperGuardrailPortfolioValue,
    upperAdjustedSpend,
    targetSuccessRate: boundedRate(table.targetSuccessRate, DEFAULT_RISK_BASED_GUARDRAILS.targetSuccessRate),
    lowerSuccessRate: boundedRate(table.lowerSuccessRate, DEFAULT_RISK_BASED_GUARDRAILS.lowerSuccessRate),
    upperSuccessRate: boundedRate(table.upperSuccessRate, DEFAULT_RISK_BASED_GUARDRAILS.upperSuccessRate),
    fixedWithdrawalRate: rate(fixedFailsafeSpend, initialPortfolioValue),
    initialWithdrawalRate: rate(initialSpend, initialPortfolioValue),
    lowerAdjustmentAmount: lowerAdjustedSpend == null ? null : round(initialSpend - lowerAdjustedSpend, 2),
    lowerAdjustmentPercent: lowerAdjustedSpend == null || initialSpend <= 0
      ? null
      : round((initialSpend - lowerAdjustedSpend) / initialSpend, 6),
    upperAdjustmentAmount: upperAdjustedSpend == null ? null : round(upperAdjustedSpend - initialSpend, 2),
    upperAdjustmentPercent: upperAdjustedSpend == null || initialSpend <= 0
      ? null
      : round((upperAdjustedSpend - initialSpend) / initialSpend, 6),
    lowerPortfolioDeltaPercent: lowerGuardrailPortfolioValue == null || initialPortfolioValue <= 0
      ? null
      : round((lowerGuardrailPortfolioValue - initialPortfolioValue) / initialPortfolioValue, 6),
    upperPortfolioDeltaPercent: upperGuardrailPortfolioValue == null || initialPortfolioValue <= 0
      ? null
      : round((upperGuardrailPortfolioValue - initialPortfolioValue) / initialPortfolioValue, 6)
  };
}

export function scalePortfolioToValue(assets = [], targetValue = 0) {
  const currentValue = portfolioValue(assets);
  const nextValue = Math.max(0, Number(targetValue) || 0);
  if (!(currentValue > 0)) return clonePortfolio(assets);
  const factor = nextValue / currentValue;
  return clonePortfolio(assets).map((asset) => ({
    ...asset,
    units: round(Math.max(0, Number(asset.units) || 0) * factor, 8)
  }));
}

export function scenarioWithRiskBasedSpend(scenario = {}, spend = 0) {
  return {
    ...scenario,
    targetSpend: round(Math.max(0, Number(spend) || 0), 2),
    spendingStrategy: {
      ...(plainObject(scenario.spendingStrategy) ? scenario.spendingStrategy : {}),
      mode: "fixed"
    }
  };
}

export function scenarioWithRiskBasedGuardrailTable(scenario = {}, table = {}, rawConfig = {}) {
  const normalizedTable = normalizeRiskBasedGuardrailTable(table);
  const config = normalizeRiskBasedGuardrails(rawConfig);
  return {
    ...scenario,
    targetSpend: normalizedTable.initialSpend,
    spendingStrategy: {
      ...(plainObject(scenario.spendingStrategy) ? scenario.spendingStrategy : {}),
      mode: RISK_BASED_GUARDRAILS_MODE,
      riskBasedGuardrails: {
        ...config,
        table: normalizedTable
      }
    }
  };
}

export function buildRiskBasedGuardrailTable({
  assets = [],
  scenario = {},
  config = {},
  evaluateHistoricalSuccess,
  iterations = null
} = {}) {
  if (typeof evaluateHistoricalSuccess !== "function") {
    throw new Error("Risk-based guardrail solver requires evaluateHistoricalSuccess.");
  }

  const normalized = normalizeRiskBasedGuardrails(config);
  const solverIterations = iterations == null ? normalized.solverIterations : boundedInteger(iterations, 3, 12, normalized.solverIterations);
  const initialPortfolioValue = portfolioValue(assets);
  if (!(initialPortfolioValue > 0)) return null;

  const evaluate = ({ probeAssets = assets, spend }) => evaluateHistoricalSuccess({
    assets: probeAssets,
    scenario: scenarioWithRiskBasedSpend(scenario, spend)
  });

  const targetSuccessRate = normalized.targetSuccessRate;
  const lowerSuccessRate = Math.min(targetSuccessRate, normalized.lowerSuccessRate);
  const upperSuccessRate = Math.max(targetSuccessRate, normalized.upperSuccessRate);
  const currentSpend = Math.max(0, Number(scenario.targetSpend) || 0);

  const fixedFailsafeSpend = solveSpendForSuccess({
    assets,
    currentSpend,
    targetSuccessRate: 1,
    evaluate,
    iterations: solverIterations
  }).spend;
  const initialSpend = solveSpendForSuccess({
    assets,
    currentSpend: Math.max(currentSpend, fixedFailsafeSpend),
    targetSuccessRate,
    evaluate,
    iterations: solverIterations
  }).spend;

  const lowerGuardrailPortfolioValue = solvePortfolioForSuccess({
    assets,
    spend: initialSpend,
    targetSuccessRate: lowerSuccessRate,
    direction: "lower",
    evaluate,
    iterations: solverIterations
  }).portfolioValue;
  const lowerAdjustedSpend = lowerGuardrailPortfolioValue > 0
    ? solveSpendForSuccess({
        assets: scalePortfolioToValue(assets, lowerGuardrailPortfolioValue),
        currentSpend: initialSpend,
        targetSuccessRate,
        evaluate,
        iterations: solverIterations
      }).spend
    : null;

  const upperGuardrailPortfolioValue = solvePortfolioForSuccess({
    assets,
    spend: initialSpend,
    targetSuccessRate: upperSuccessRate,
    direction: "upper",
    evaluate,
    iterations: solverIterations
  }).portfolioValue;
  const upperAdjustedSpend = upperGuardrailPortfolioValue > 0
    ? solveSpendForSuccess({
        assets: scalePortfolioToValue(assets, upperGuardrailPortfolioValue),
        currentSpend: initialSpend,
        targetSuccessRate,
        evaluate,
        iterations: solverIterations
      }).spend
    : null;

  return normalizeRiskBasedGuardrailTable({
    method: "historical",
    sequenceCount: Math.max(
      0,
      evaluate({ probeAssets: assets, spend: Math.max(1, initialSpend || currentSpend || 1) }).count ?? 0
    ),
    initialPortfolioValue,
    fixedFailsafeSpend,
    initialSpend,
    lowerGuardrailPortfolioValue,
    lowerAdjustedSpend: boundedSpendByConfig(lowerAdjustedSpend, normalized),
    upperGuardrailPortfolioValue,
    upperAdjustedSpend: boundedSpendByConfig(upperAdjustedSpend, normalized),
    targetSuccessRate,
    lowerSuccessRate,
    upperSuccessRate
  });
}

export function riskBasedGuardrailSpendForYear({
  currentRealPortfolioValue,
  currentRealSpend,
  config = {},
  table = null
} = {}) {
  const normalized = normalizeRiskBasedGuardrails(config);
  const normalizedTable = table ? normalizeRiskBasedGuardrailTable(table) : normalized.table;
  const realPortfolio = Math.max(0, Number(currentRealPortfolioValue) || 0);
  const realSpend = boundedSpendByConfig(currentRealSpend, normalized);
  if (!normalizedTable) {
    return {
      realSpend,
      guardrail: null
    };
  }

  const lowerPortfolio = normalizedTable.lowerGuardrailPortfolioValue;
  const upperPortfolio = normalizedTable.upperGuardrailPortfolioValue;
  const lowerSpend = boundedSpendByConfig(normalizedTable.lowerAdjustedSpend, normalized);
  const upperSpend = boundedSpendByConfig(normalizedTable.upperAdjustedSpend, normalized);

  let action = "none";
  let nextRealSpend = realSpend;
  if (lowerPortfolio != null && lowerSpend != null && realPortfolio <= lowerPortfolio && meaningfulAdjustment(realSpend, lowerSpend, normalized.minimumAdjustmentPercent)) {
    action = "lower";
    nextRealSpend = lowerSpend;
  } else if (upperPortfolio != null && upperSpend != null && realPortfolio >= upperPortfolio && meaningfulAdjustment(realSpend, upperSpend, normalized.minimumAdjustmentPercent)) {
    action = "upper";
    nextRealSpend = upperSpend;
  }

  const adjustmentAmount = round(nextRealSpend - realSpend, 2);
  const adjustmentPercent = realSpend > 0 ? round(adjustmentAmount / realSpend, 6) : 0;
  return {
    realSpend: nextRealSpend,
    guardrail: {
      enabled: true,
      mode: RISK_BASED_GUARDRAILS_MODE,
      action,
      targetSuccessRate: normalizedTable.targetSuccessRate,
      lowerSuccessRate: normalizedTable.lowerSuccessRate,
      upperSuccessRate: normalizedTable.upperSuccessRate,
      currentRealPortfolioValue: round(realPortfolio, 2),
      currentRealSpend: round(realSpend, 2),
      nextRealSpend: round(nextRealSpend, 2),
      adjustmentAmount,
      adjustmentPercent,
      lowerGuardrailPortfolioValue: lowerPortfolio,
      lowerAdjustedSpend: lowerSpend,
      upperGuardrailPortfolioValue: upperPortfolio,
      upperAdjustedSpend: upperSpend,
      fixedFailsafeSpend: normalizedTable.fixedFailsafeSpend,
      initialSpend: normalizedTable.initialSpend,
      sequenceCount: normalizedTable.sequenceCount
    }
  };
}

function solveSpendForSuccess({
  assets,
  currentSpend = 0,
  targetSuccessRate,
  evaluate,
  iterations
}) {
  const value = portfolioValue(assets);
  let low = 0;
  let high = Math.max(1, Number(currentSpend) || 0, value * 0.08);
  let highResult = evaluate({ probeAssets: assets, spend: high });
  let expansions = 0;
  while (passesTarget(highResult, targetSuccessRate) && expansions < 6) {
    high *= 1.6;
    highResult = evaluate({ probeAssets: assets, spend: high });
    expansions += 1;
  }

  if (passesTarget(highResult, targetSuccessRate)) {
    return { spend: round(high, 2), capped: true, evidence: highResult };
  }

  let best = 0;
  let bestEvidence = null;
  for (let index = 0; index < iterations; index += 1) {
    const mid = (low + high) / 2;
    const evidence = evaluate({ probeAssets: assets, spend: mid });
    if (passesTarget(evidence, targetSuccessRate)) {
      best = mid;
      bestEvidence = evidence;
      low = mid;
    } else {
      high = mid;
    }
  }
  return { spend: round(best, 2), capped: false, evidence: bestEvidence };
}

function solvePortfolioForSuccess({
  assets,
  spend,
  targetSuccessRate,
  direction,
  evaluate,
  iterations
}) {
  const initialValue = portfolioValue(assets);
  if (!(initialValue > 0) || !(spend > 0)) {
    return { portfolioValue: 0, capped: false, evidence: null };
  }

  if (direction === "lower") {
    let low = 0;
    let high = initialValue;
    let best = initialValue;
    let bestEvidence = evaluate({ probeAssets: assets, spend });
    for (let index = 0; index < iterations; index += 1) {
      const mid = (low + high) / 2;
      const probeAssets = scalePortfolioToValue(assets, mid);
      const evidence = evaluate({ probeAssets, spend });
      if (passesTarget(evidence, targetSuccessRate)) {
        best = mid;
        bestEvidence = evidence;
        high = mid;
      } else {
        low = mid;
      }
    }
    return { portfolioValue: round(best, 2), capped: false, evidence: bestEvidence };
  }

  let low = initialValue;
  let high = initialValue;
  let highEvidence = evaluate({ probeAssets: assets, spend });
  let expansions = 0;
  while (!passesTarget(highEvidence, targetSuccessRate) && expansions < 8) {
    low = high;
    high *= 1.35;
    highEvidence = evaluate({ probeAssets: scalePortfolioToValue(assets, high), spend });
    expansions += 1;
  }
  if (!passesTarget(highEvidence, targetSuccessRate)) {
    return { portfolioValue: round(high, 2), capped: true, evidence: highEvidence };
  }

  let best = high;
  let bestEvidence = highEvidence;
  for (let index = 0; index < iterations; index += 1) {
    const mid = (low + high) / 2;
    const evidence = evaluate({ probeAssets: scalePortfolioToValue(assets, mid), spend });
    if (passesTarget(evidence, targetSuccessRate)) {
      best = mid;
      bestEvidence = evidence;
      high = mid;
    } else {
      low = mid;
    }
  }
  return { portfolioValue: round(best, 2), capped: false, evidence: bestEvidence };
}

function passesTarget(evidence, targetSuccessRate) {
  return Number.isFinite(evidence?.successRate) && evidence.successRate + 0.000001 >= targetSuccessRate;
}

function boundedSpendByConfig(value, config) {
  let spend = optionalNonNegative(value);
  if (spend == null) return null;
  if (config.incomeFloor != null) spend = Math.max(config.incomeFloor, spend);
  if (config.incomeCeiling != null) spend = Math.min(config.incomeCeiling, spend);
  return round(spend, 2);
}

function meaningfulAdjustment(currentSpend, nextSpend, minimumPercent) {
  const current = Math.max(0, Number(currentSpend) || 0);
  const next = Math.max(0, Number(nextSpend) || 0);
  if (current <= 0) return next > 0;
  return Math.abs(next - current) / current + 0.000001 >= minimumPercent;
}

function boundedRate(value, fallback) {
  const numeric = Number(value);
  const usable = Number.isFinite(numeric) ? numeric : fallback;
  return round(Math.max(0, Math.min(1, usable)), 6);
}

function boundedInteger(value, min, max, fallback) {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function optionalNonNegative(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return round(Math.max(0, numeric), 2);
}

function nonNegative(value) {
  const numeric = Number(value);
  return round(Math.max(0, Number.isFinite(numeric) ? numeric : 0), 2);
}

function rate(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator, 6) : null;
}

function plainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
