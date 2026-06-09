// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: market. No behavior changes — pure code movement.

import { normalRandom, round } from "../utils.mjs";
import { DEFAULT_MONTE_CARLO_MEAN_REVERSION, MEDICAL_INFLATION_PREMIUM } from "./constants.mjs";
import { finiteReturnOrNull } from "./guards.mjs";
import { DEFAULT_SCENARIO } from "./scenario.mjs";

export const MEAN_REVERTING_CORRELATED_SAMPLING_MODE = "meanRevertingCorrelated";

const MONTE_CARLO_FACTOR_LOADINGS = Object.freeze({
  stock: Object.freeze({ market: 0.65, rates: 0.05 }),
  bond: Object.freeze({ market: 0.15, rates: 0.6 }),
  cash: Object.freeze({ market: 0.05, rates: 0.45 }),
  realEstate: Object.freeze({ market: 0.55, rates: 0.15 }),
  tips: Object.freeze({ market: 0.1, rates: 0.6 }),
  crypto: Object.freeze({ market: 0.6, rates: 0.05 })
});

export function annualReturns(scenario, returnSequence, yearIndex) {
  if (returnSequence?.[yearIndex]) return returnSequence[yearIndex];
  const assumptions = scenario.returnAssumptions ?? {};
  return Object.fromEntries(
    Object.entries(assumptions)
      .filter(([assetClass]) => assetClass !== "inflation")
      .map(([assetClass, assumption]) => [assetClass, assumption.mean ?? 0])
  );
}

export function annualInflation(scenario, inflationSequence, yearIndex) {
  if (Number.isFinite(inflationSequence?.[yearIndex])) return inflationSequence[yearIndex];
  return scenario.returnAssumptions.inflation?.mean ?? 0;
}

export function annualMedicalInflation(scenario, medicalInflationSequence, yearIndex, inflationSequence) {
  // A finite medical sequence value covers both an explicit sampled/historical
  // medical sequence AND the backward-compatible "track general" case (where the
  // caller passes the general inflationSequence as the medical sequence).
  if (Number.isFinite(medicalInflationSequence?.[yearIndex])) {
    return medicalInflationSequence[yearIndex];
  }
  // Reached only for an explicit medical assumption with no per-year sequence:
  // apply the configured medical-over-general premium on top of this year's
  // general inflation.
  const genInflation = annualInflation(scenario, inflationSequence, yearIndex);
  return genInflation + medicalInflationPremium(scenario);
}

// The fixed premium by which the bundled medical-inflation stream exceeds
// general inflation for a scenario, derived from its assumptions (medical mean
// minus general mean), defaulting to MEDICAL_INFLATION_PREMIUM. Used to project
// a medical-inflation series onto historical general-inflation sequences.
export function medicalInflationPremium(scenario = {}) {
  const ra = scenario.returnAssumptions ?? {};
  const genMean = ra.inflation?.mean ?? DEFAULT_SCENARIO.returnAssumptions.inflation.mean;
  const medMean = ra.medicalInflation?.mean ?? (genMean + MEDICAL_INFLATION_PREMIUM);
  return Math.max(0, round(medMean - genMean, 6));
}

export function sampleReturnsForYear(scenario, rng) {
  return sampleReturnsForYearWithState(scenario, rng, null);
}

export function createMonteCarloSamplingState(scenario = {}) {
  if (scenario.monteCarlo?.samplingMode !== MEAN_REVERTING_CORRELATED_SAMPLING_MODE) return null;
  return {
    config: normalizeMeanReversionConfig(scenario.monteCarlo?.meanReversion),
    previousDeviation: {},
    cumulativeDeviation: {}
  };
}

export function sampleReturnsForYearWithState(scenario, rng, samplingState = null) {
  const result = {};
  const meanReverting = scenario.monteCarlo?.samplingMode === MEAN_REVERTING_CORRELATED_SAMPLING_MODE;
  const correlated = scenario.monteCarlo?.samplingMode === "correlated" || meanReverting;
  const factorShocks = correlated
    ? {
        market: standardNormal(rng),
        rates: standardNormal(rng)
      }
    : null;
  const nextDeviation = {};
  for (const [assetClass, assumption] of Object.entries(scenario.returnAssumptions ?? {})) {
    if (assetClass === "inflation") continue;
    const mean = assumption.mean ?? 0;
    const stdev = assumption.stdev ?? 0;
    let sampledReturn = correlated
      ? mean + (stdev * correlatedStandardNormal(rng, assetClass, factorShocks))
      : normalRandom(rng, mean, stdev);
    if (meanReverting) {
      sampledReturn = applyMeanReversionAdjustment({
        sampledReturn,
        mean,
        assetClass,
        samplingState
      });
    }
    result[assetClass] = Math.max(-0.95, sampledReturn);
    nextDeviation[assetClass] = result[assetClass] - mean;
  }
  if (meanReverting && samplingState) {
    for (const [assetClass, deviation] of Object.entries(nextDeviation)) {
      samplingState.previousDeviation[assetClass] = deviation;
      samplingState.cumulativeDeviation[assetClass] = (samplingState.cumulativeDeviation[assetClass] ?? 0) + deviation;
    }
  }
  return result;
}

export function normalizeMeanReversionConfig(raw = {}) {
  return {
    shortTermStrength: boundedRate(raw.shortTermStrength, DEFAULT_MONTE_CARLO_MEAN_REVERSION.shortTermStrength),
    longTermStrength: boundedRate(raw.longTermStrength, DEFAULT_MONTE_CARLO_MEAN_REVERSION.longTermStrength),
    longTermYears: boundedInteger(raw.longTermYears, 2, 30, DEFAULT_MONTE_CARLO_MEAN_REVERSION.longTermYears)
  };
}

function applyMeanReversionAdjustment({
  sampledReturn,
  mean,
  assetClass,
  samplingState
}) {
  if (!samplingState) return sampledReturn;
  const config = samplingState.config ?? DEFAULT_MONTE_CARLO_MEAN_REVERSION;
  const previousDeviation = samplingState.previousDeviation?.[assetClass] ?? 0;
  const cumulativeDeviation = samplingState.cumulativeDeviation?.[assetClass] ?? 0;
  const shortAdjustment = -config.shortTermStrength * previousDeviation;
  const longAdjustment = -config.longTermStrength * (cumulativeDeviation / config.longTermYears);
  return sampledReturn + shortAdjustment + longAdjustment;
}

function correlatedStandardNormal(rng, assetClass, factorShocks) {
  const loadings = MONTE_CARLO_FACTOR_LOADINGS[assetClass];
  if (!loadings) return standardNormal(rng);
  const market = loadings.market ?? 0;
  const rates = loadings.rates ?? 0;
  const idiosyncraticWeight = Math.sqrt(Math.max(0, 1 - (market ** 2) - (rates ** 2)));
  return (market * factorShocks.market)
    + (rates * factorShocks.rates)
    + (idiosyncraticWeight * standardNormal(rng));
}

function standardNormal(rng) {
  return normalRandom(rng, 0, 1);
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

export function summarizeAssetClassReturns(returnsByAssetClass = {}, inflationRate = null) {
  const summary = {};
  for (const assetClass of ["stock", "bond", "cash", "realEstate", "tips", "crypto"]) {
    summary[assetClass] = finiteReturnOrNull(returnsByAssetClass[assetClass]);
  }
  summary.inflation = finiteReturnOrNull(inflationRate);
  return summary;
}
