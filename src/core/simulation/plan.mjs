// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: plan. No behavior changes — pure code movement.

import { accountBreakdown, clonePortfolio, portfolioValue } from "../portfolio.mjs";
import { DEFAULT_TAX_PROFILE } from "../tax.mjs?v=20260604-qbi";
import { createRng, normalRandom, percentile, round } from "../utils.mjs";
import { DEFAULT_MONTE_CARLO_RUNS, MONTE_CARLO_ASSUMPTION_PRESETS } from "./constants.mjs";
import { estimateHeirValueBreakdown } from "./heirEstate.mjs?v=20260604-qbi";
import { buildSurvivorTaxProfile, isMarriedFiling, mortalityStatus } from "./household.mjs";
import { hsaStrategyConfig } from "./hsa.mjs";
import { normalizeLossCarryforward } from "./income.mjs?v=20260604-qbi";
import { annualInflation, annualMedicalInflation, annualReturns, medicalInflationPremium, sampleReturnsForYear } from "./market.mjs";
import { assetClassValue } from "./portfolioQueries.mjs";
import { ensureReturnAssumptionsForAssets, mergeScenario } from "./scenario.mjs";
import { advanceSpendingGuardrailMarketState, initialSpendingGuardrailMarketState, spendingGuardrailStateForYear, spendingStrategyConfig } from "./spending.mjs";
import { buildPostMortalityYearResult, simulateYear } from "./yearEngine.mjs?v=20260604-qbi";

export function simulatePlan({
  assets,
  scenario = {},
  taxProfile = DEFAULT_TAX_PROFILE,
  returnSequence,
  inflationSequence,
  medicalInflationSequence
}) {
  const mergedScenario = ensureReturnAssumptionsForAssets(mergeScenario(scenario), assets);
  const portfolio = clonePortfolio(assets);
  const years = [];
  let lossCarryforward = { shortTerm: 0, longTerm: 0 };
  let rothBasisRemaining = Math.max(0, mergedScenario.rothBasis ?? 0);
  let hsaQualifiedExpenseBalance = hsaStrategyConfig(mergedScenario).startingQualifiedExpenseBalance;
  let success = true;
  let inflationIndex = 1;
  let medicalInflationIndex = 1;

  // Whether the caller explicitly modeled a separate medical-inflation stream
  // is detected from the RAW scenario (mergeScenario fills a default from the
  // preset, so the merged value can't distinguish "explicit" from "inherited").
  // - explicit sequence supplied      → use it (Monte Carlo / historical).
  // - explicit medical, no sequence   → null → general + configured premium.
  // - no explicit medical             → track the general inflation sequence
  //                                      exactly (backward-compatible).
  const explicitMedicalInflation = scenario.returnAssumptions?.medicalInflation !== undefined;
  const medInflationSeq = medicalInflationSequence
    ?? (explicitMedicalInflation ? null : inflationSequence);

  let guytonKlingerBaseSpend = null;
  let guytonKlingerInitialWr = null;
  let kitcesBaseSpend = null;
  let kitcesHighWaterMark = null;
  const irmaaMagiHistory = [];
  let spendingGuardrailMarketState = initialSpendingGuardrailMarketState();

  const wasMarried = isMarriedFiling(taxProfile?.filingStatus);
  // Hoist: rebuilding the survivor profile is independent of yearIndex and
  // doesn't need to run inside simulateYear every survivor year.
  const survivorTaxProfile = wasMarried ? buildSurvivorTaxProfile(taxProfile) : null;

  for (let yearIndex = 0; yearIndex < mergedScenario.planYears; yearIndex += 1) {
    const { primaryDeceased, spouseDeceased, spouseAge } = mortalityStatus(mergedScenario, yearIndex);
    // bothDeceased gates the post-mortality stub. For an unmarried filer or
    // an MFJ filer with no spouse data, "both deceased" reduces to "primary
    // is deceased" — there's no second life to wait on.
    const bothDeceased = wasMarried && spouseAge !== null
      ? (primaryDeceased && spouseDeceased)
      : primaryDeceased;

    if (yearIndex > 0) {
      inflationIndex *= 1 + annualInflation(mergedScenario, inflationSequence, yearIndex - 1);
      medicalInflationIndex *= 1 + annualMedicalInflation(mergedScenario, medInflationSeq, yearIndex - 1, inflationSequence);
    }

    if (bothDeceased) {
      // Post-mortality stub: keep plan.years.length === planYears so charts,
      // year sliders, and audit bundles don't drop years off the end. The
      // portfolio is frozen at the death-year balance; income, spending, and
      // taxes are all zero. Flagged with postMortality:true so UI can mask
      // or annotate these rows.
      years.push(buildPostMortalityYearResult({
        scenario: mergedScenario,
        yearIndex,
        portfolio,
        inflationIndex,
        medicalInflationIndex
      }));
      continue;
    }

    const beginningPortfolioVal = portfolioValue(portfolio);
    const strategy = spendingStrategyConfig(mergedScenario);
    let passedBaseSpend = null;

    // Guyton-Klinger is modeled with documented simplifications vs the full
    // published ruleset: the inflation-skip (modified withdrawal) rule keys off
    // the prior year's STOCK return as a proxy for total portfolio return and
    // does not also require current WR > initial WR; and the prosperity /
    // capital-preservation guardrails are NOT suspended in the final ~15 years
    // of the plan as G-K prescribe. These approximations make the strategy
    // slightly more reactive than canonical G-K.
    if (strategy.mode === "guytonKlinger") {
      if (yearIndex === 0) {
        guytonKlingerBaseSpend = mergedScenario.targetSpend ?? 0;
        guytonKlingerInitialWr = beginningPortfolioVal > 0 ? guytonKlingerBaseSpend / beginningPortfolioVal : 0;
      } else {
        const priorYearReturnSequence = returnSequence?.[yearIndex - 1] ?? {};
        const priorStockReturn = priorYearReturnSequence.stock ?? 0;
        const priorYearInflation = annualInflation(mergedScenario, inflationSequence, yearIndex - 1);
        
        let inflatedSpend = guytonKlingerBaseSpend;
        if (priorStockReturn >= 0) {
          inflatedSpend = guytonKlingerBaseSpend * (1 + priorYearInflation);
        }
        
        const currentWr = beginningPortfolioVal > 0 ? inflatedSpend / beginningPortfolioVal : 0;
        if (guytonKlingerInitialWr > 0) {
          if (currentWr > 1.2 * guytonKlingerInitialWr) {
            inflatedSpend *= 0.9;
          } else if (currentWr < 0.8 * guytonKlingerInitialWr) {
            inflatedSpend *= 1.1;
          }
        }
        guytonKlingerBaseSpend = inflatedSpend;
      }
      passedBaseSpend = guytonKlingerBaseSpend;
    } else if (strategy.mode === "kitces") {
      if (yearIndex === 0) {
        kitcesBaseSpend = mergedScenario.targetSpend ?? 0;
        kitcesHighWaterMark = beginningPortfolioVal;
      } else {
        const priorYearInflation = annualInflation(mergedScenario, inflationSequence, yearIndex - 1);
        let inflatedSpend = kitcesBaseSpend * (1 + priorYearInflation);
        
        if (beginningPortfolioVal > 1.5 * kitcesHighWaterMark) {
          inflatedSpend *= 1.1;
          kitcesHighWaterMark = beginningPortfolioVal;
        }
        kitcesBaseSpend = inflatedSpend;
      }
      passedBaseSpend = kitcesBaseSpend;
    } else if (strategy.mode === "vpw") {
      const remainingYears = mergedScenario.planYears - yearIndex;
      let weightedExpectedReturn = 0;
      let totalVal = 0;
      for (const asset of portfolio) {
        const val = Math.max(0, asset.units ?? 0) * Math.max(0, asset.price ?? 0);
        const cls = asset.assetClass;
        const expectedReturn = mergedScenario.returnAssumptions[cls]?.mean ?? 0.05;
        weightedExpectedReturn += val * expectedReturn;
        totalVal += val;
      }
      const avgExpectedReturn = totalVal > 0 ? weightedExpectedReturn / totalVal : 0.05;
      const inflationMean = mergedScenario.returnAssumptions.inflation?.mean ?? 0.024;
      const realExpectedReturn = Math.max(0.01, avgExpectedReturn - inflationMean);
      
      let p = 1.0;
      if (remainingYears > 1) {
        p = realExpectedReturn / (1 - Math.pow(1 + realExpectedReturn, -remainingYears));
      } else {
        p = 1.0;
      }
      passedBaseSpend = beginningPortfolioVal * p;
    }

    const returnByAssetClass = annualReturns(mergedScenario, returnSequence, yearIndex);
    const currentInflationRate = annualInflation(mergedScenario, inflationSequence, yearIndex);
    const spendingGuardrail = spendingGuardrailStateForYear({
      scenario: mergedScenario,
      marketState: spendingGuardrailMarketState
    });
    const result = simulateYear({
      portfolio,
      scenario: mergedScenario,
      taxProfile,
      survivorTaxProfile,
      yearIndex,
      inflationIndex,
      medicalInflationIndex,
      returnByAssetClass,
      annualInflationRate: currentInflationRate,
      spendingGuardrail,
      lossCarryforward,
      rothBasisRemaining,
      hsaQualifiedExpenseBalance,
      magiHistory: irmaaMagiHistory,
      passedBaseSpend
    });
    spendingGuardrailMarketState = advanceSpendingGuardrailMarketState({
      scenario: mergedScenario,
      marketState: spendingGuardrailMarketState,
      returnByAssetClass
    });

    lossCarryforward = result.lossCarryforwardDetail ?? normalizeLossCarryforward(result.lossCarryforward);
    rothBasisRemaining = result.rothBasisRemaining;
    hsaQualifiedExpenseBalance = result.hsaQualifiedExpenseBalance ?? hsaQualifiedExpenseBalance;
    irmaaMagiHistory.push(result.irmaaMagi);
    success = success && !isPortfolioDepleted(result);
    years.push(result);
  }

  const endingAccounts = accountBreakdown(portfolio);
  const endingValue = portfolioValue(portfolio);
  const heirValueBreakdown = estimateHeirValueBreakdown(portfolio, mergedScenario.heirOrdinaryTaxRate, {
    heirType: mergedScenario.heirType,
    nonSpouse10YrTaxDrag: mergedScenario.nonSpouse10YrTaxDrag,
    eligibleDesignatedTaxDiscount: mergedScenario.eligibleDesignatedTaxDiscount,
    heirBaseIncome: mergedScenario.heirBaseIncome,
    heirAge: mergedScenario.heirAge,
    state: mergedScenario.state,
    taxProfile
  });
  return {
    success,
    years,
    endingValue,
    endingAccounts,
    heirValue: heirValueBreakdown.afterTaxValue,
    heirValueBreakdown,
    rothBasisRemaining,
    hsaQualifiedExpenseBalance,
    finalPortfolio: clonePortfolio(portfolio)
  };
}

export function runMonteCarlo({
  assets,
  scenario = {},
  taxProfile = DEFAULT_TAX_PROFILE,
  runs = DEFAULT_MONTE_CARLO_RUNS,
  seed = 42,
  onProgress = null,
  onBatch = null,
  progressInterval = 25,
  scenarioTimelineLimit = Number.POSITIVE_INFINITY
}) {
  const mergedScenario = ensureReturnAssumptionsForAssets(mergeScenario(scenario), assets);
  const rng = createRng(seed);
  // Note: medical inflation is sampled from the same seeded `rng` below.
  // Reproducibility is version-scoped — same seed + same code version always
  // reproduces the same paths — but adding this stochastic dimension shifted
  // seeded results relative to versions before two-stream inflation existed.
  // That is an inherent, one-time consequence of a new random input (data/model
  // changes already break cross-version determinism); the audit bundle records
  // the seed and data versions so any run remains reproducible against its own version.
  const scenarios = [];
  const reportEvery = Math.max(1, Math.trunc(progressInterval) || 25);
  const timelineLimit = normalizeScenarioTimelineLimit(scenarioTimelineLimit);
  let batchStart = 0;

  for (let run = 0; run < runs; run += 1) {
    const returnSequence = [];
    const inflationSequence = [];
    const medicalInflationSequence = [];
    for (let year = 0; year < mergedScenario.planYears; year += 1) {
      returnSequence.push(sampleReturnsForYear(mergedScenario, rng));
      inflationSequence.push(Math.max(-0.08, normalRandom(
        rng,
        mergedScenario.returnAssumptions.inflation?.mean ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.inflation.mean,
        mergedScenario.returnAssumptions.inflation?.stdev ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.inflation.stdev
      )));
      medicalInflationSequence.push(Math.max(-0.08, normalRandom(
        rng,
        mergedScenario.returnAssumptions.medicalInflation?.mean ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.medicalInflation.mean,
        mergedScenario.returnAssumptions.medicalInflation?.stdev ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.medicalInflation.stdev
      )));
    }

    const plan = simulatePlan({
      assets,
      scenario: mergedScenario,
      taxProfile,
      returnSequence,
      inflationSequence,
      medicalInflationSequence
    });

    const depletion = firstDepletionDetails(plan.years);
    scenarios.push(monteCarloScenarioResult({
      id: run + 1,
      plan,
      depletion,
      includeTimeline: run < timelineLimit
    }));

    if ((run + 1) % reportEvery === 0 || run + 1 === runs) {
      if (typeof onBatch === "function") {
        onBatch({
          scenarios: scenarios.slice(batchStart, run + 1),
          done: run + 1,
          total: runs
        });
        batchStart = run + 1;
      }
      if (typeof onProgress === "function") {
        onProgress({ done: run + 1, total: runs });
      }
    }
  }

  const endingValues = scenarios.map((scenarioResult) => scenarioResult.endingValue);
  const heirValues = scenarios.map((scenarioResult) => scenarioResult.heirValue);
  return {
    scenarios,
    summary: {
      runs,
      successRate: round(scenarios.filter((scenarioResult) => scenarioResult.success).length / runs, 4),
      medianEndingValue: round(percentile(endingValues, 0.5), 2),
      p10EndingValue: round(percentile(endingValues, 0.1), 2),
      p90EndingValue: round(percentile(endingValues, 0.9), 2),
      medianHeirValue: round(percentile(heirValues, 0.5), 2)
    }
  };
}

function normalizeScenarioTimelineLimit(value) {
  if (value === Number.POSITIVE_INFINITY || value === Infinity) return Number.POSITIVE_INFINITY;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.trunc(numeric));
}

function analyzeFailedScenario(years = []) {
  let consecutiveDownYears = 0;
  let maxConsecutiveDownYears = 0;
  let earlyDownYearsCount = 0;
  let totalDownYearsCount = 0;
  let inflationSumFirstDecade = 0;
  let inflationCountFirstDecade = 0;
  let stockReturnSumFirstDecade = 0;
  let stockReturnCountFirstDecade = 0;
  let taxTotal = 0;
  let medicalTotal = 0;
  let spendingTotal = 0;
  let requiredCashTotal = 0;
  let beginningPortfolioTotal = 0;
  let withdrawalRateSum = 0;
  let withdrawalRateCount = 0;
  let riskShareSum = 0;
  let riskShareCount = 0;
  let negativeStockYears = 0;
  let defensiveShortfallYears = 0;

  const depletionIndex = years.findIndex(isPortfolioDepleted);
  const analyzedYears = years.slice(0, depletionIndex >= 0 ? depletionIndex + 1 : years.length);

  for (let i = 0; i < analyzedYears.length; i++) {
    const yr = analyzedYears[i];
    const stockReturn = yr?.assetClassReturns?.stock ?? 0;
    const inflation = yr?.assetClassReturns?.inflation ?? 0;
    const requiredCash = Math.max(0, Number(yr?.totalCashRequired) || 0);
    const beginningPortfolio = Math.max(0, Number(yr?.beginningPortfolioValue) || 0);
    const assets = Array.isArray(yr?.beginningAssets) ? yr.beginningAssets : [];
    const riskValue = assetClassValue(assets, ["stock", "realEstate", "crypto"]);
    const defensiveValue = assetClassValue(assets, ["cash", "bond", "tips"]);
    const totalAssetValue = riskValue + defensiveValue;

    taxTotal += Math.max(0, Number(yr?.taxes?.totalTax) || 0);
    medicalTotal += Math.max(0, Number(yr?.medicalCost) || 0);
    spendingTotal += Math.max(0, Number(yr?.plannedSpending) || 0);
    requiredCashTotal += requiredCash;
    beginningPortfolioTotal += beginningPortfolio;
    if (beginningPortfolio > 0 && requiredCash > 0) {
      withdrawalRateSum += requiredCash / beginningPortfolio;
      withdrawalRateCount++;
    }
    if (totalAssetValue > 0) {
      riskShareSum += riskValue / totalAssetValue;
      riskShareCount++;
    }

    if (stockReturn < 0) {
      consecutiveDownYears++;
      if (consecutiveDownYears > maxConsecutiveDownYears) {
        maxConsecutiveDownYears = consecutiveDownYears;
      }
      totalDownYearsCount++;
      negativeStockYears++;
      if (requiredCash > 0 && defensiveValue < requiredCash * 2) {
        defensiveShortfallYears++;
      }
      if (i < 10) {
        earlyDownYearsCount++;
      }
    } else {
      consecutiveDownYears = 0;
    }

    if (i < 10) {
      inflationSumFirstDecade += inflation;
      inflationCountFirstDecade++;
      stockReturnSumFirstDecade += stockReturn;
      stockReturnCountFirstDecade++;
    }
  }

  const avgInflationFirstDecade = inflationCountFirstDecade > 0 ? inflationSumFirstDecade / inflationCountFirstDecade : 0;
  const avgStockReturnFirstDecade = stockReturnCountFirstDecade > 0 ? stockReturnSumFirstDecade / stockReturnCountFirstDecade : 0;
  const avgWithdrawalRate = withdrawalRateCount > 0 ? withdrawalRateSum / withdrawalRateCount : 0;
  const avgRiskShare = riskShareCount > 0 ? riskShareSum / riskShareCount : 0;
  const taxShareOfNeed = requiredCashTotal > 0 ? taxTotal / requiredCashTotal : 0;
  const healthcareShareOfNeed = requiredCashTotal > 0 ? medicalTotal / requiredCashTotal : 0;
  const spendingRate = beginningPortfolioTotal > 0 ? spendingTotal / beginningPortfolioTotal : 0;
  const stressors = failureStressors({
    taxShareOfNeed,
    healthcareShareOfNeed,
    avgWithdrawalRate,
    spendingRate,
    avgRiskShare,
    negativeStockYears,
    defensiveShortfallYears,
    earlyDownYearsCount,
    avgStockReturnFirstDecade
  });

  // Outflow composition: each category's share of total lifetime cash need on
  // failed paths. This is NOT a causal attribution of depletion (it does not
  // isolate the marginal driver or break down by year) — it answers "where did
  // the money go," and the per-category `actions` are the levers that address
  // that category. `basis` names the semantics so the UI/labels stay honest.
  const cumulativeNeed = taxTotal + medicalTotal + spendingTotal;
  const outflowComposition = {
    basis: "lifetime-outflow-share",
    tax: {
      total: round(taxTotal, 6),
      percent: cumulativeNeed > 0 ? round(taxTotal / cumulativeNeed, 4) : 0,
      actions: ["traditionalWithdrawal", "rothConversion"]
    },
    healthcare: {
      total: round(medicalTotal, 6),
      percent: cumulativeNeed > 0 ? round(medicalTotal / cumulativeNeed, 4) : 0,
      actions: ["magiManagement", "hsaContribution"]
    },
    spending: {
      total: round(spendingTotal, 6),
      percent: cumulativeNeed > 0 ? round(spendingTotal / cumulativeNeed, 4) : 0,
      actions: ["safeSpending", "discretionaryCut"]
    },
    cumulativeNeed: round(cumulativeNeed, 6)
  };

  return {
    maxConsecutiveDownYears,
    earlyDownYearsCount,
    totalDownYearsCount,
    avgInflationFirstDecade: round(avgInflationFirstDecade, 6),
    avgStockReturnFirstDecade: round(avgStockReturnFirstDecade, 6),
    taxShareOfNeed: round(taxShareOfNeed, 6),
    healthcareShareOfNeed: round(healthcareShareOfNeed, 6),
    avgWithdrawalRate: round(avgWithdrawalRate, 6),
    spendingRate: round(spendingRate, 6),
    avgRiskShare: round(avgRiskShare, 6),
    defensiveShortfallRate: negativeStockYears > 0 ? round(defensiveShortfallYears / negativeStockYears, 6) : 0,
    stressors,
    outflowComposition
  };
}

function failureStressors({
  taxShareOfNeed,
  healthcareShareOfNeed,
  avgWithdrawalRate,
  spendingRate,
  avgRiskShare,
  negativeStockYears,
  defensiveShortfallYears,
  earlyDownYearsCount,
  avgStockReturnFirstDecade
}) {
  const stressors = [];
  if (taxShareOfNeed >= 0.12) {
    stressors.push({ id: "taxDrag", value: round(taxShareOfNeed, 4), metric: "tax share of required cash" });
  }
  if (healthcareShareOfNeed >= 0.12) {
    stressors.push({ id: "healthcareDrag", value: round(healthcareShareOfNeed, 4), metric: "healthcare share of required cash" });
  }
  if (avgWithdrawalRate >= 0.055 || spendingRate >= 0.05) {
    stressors.push({ id: "spendingPressure", value: round(Math.max(avgWithdrawalRate, spendingRate), 4), metric: "cash need / portfolio" });
  }
  if (negativeStockYears > 0 && defensiveShortfallYears / negativeStockYears >= 0.5) {
    stressors.push({ id: "reserveShortfall", value: round(defensiveShortfallYears / negativeStockYears, 4), metric: "down-market years with <2 years defensive cash" });
  }
  if ((avgRiskShare >= 0.8 && earlyDownYearsCount >= 3) || (avgRiskShare <= 0.35 && avgStockReturnFirstDecade < 0.03)) {
    stressors.push({ id: "allocationMismatch", value: round(avgRiskShare, 4), metric: "average risk-asset share" });
  }
  return stressors;
}

function monteCarloScenarioResult({ id, plan, depletion, includeTimeline }) {
  const result = {
    id,
    success: plan.success,
    endingValue: plan.endingValue,
    heirValue: plan.heirValue,
    heirValueBreakdown: plan.heirValueBreakdown,
    ...depletion,
    diagnostics: plan.success ? null : analyzeFailedScenario(plan.years)
  };
  if (includeTimeline) {
    return {
      ...result,
      years: plan.years
    };
  }
  return {
    ...result,
    lastYear: lastYearThumbnail(plan.years.at(-1))
  };
}

function lastYearThumbnail(year) {
  if (!year) return null;
  return {
    year: year.year,
    yearIndex: year.yearIndex,
    inflationIndex: year.inflationIndex
  };
}

export function runHistoricalBacktests({
  assets,
  scenario = {},
  taxProfile = DEFAULT_TAX_PROFILE,
  sequences = []
}) {
  const medicalPremium = medicalInflationPremium(scenario);
  return sequences.map((sequence, index) => {
    // Project a medical-inflation series onto each historical general-inflation
    // path by adding the scenario's configured medical premium, so the
    // historical and Monte Carlo paths use a consistent medical-vs-general gap.
    const medicalInflationSequence = sequence.inflation.map(inf => inf + medicalPremium);
    const plan = simulatePlan({
      assets,
      scenario,
      taxProfile,
      returnSequence: sequence.returns,
      inflationSequence: sequence.inflation,
      medicalInflationSequence
    });
    const annotatedPlan = withHistoricalSourceYears(plan, sequence.sourceYears ?? [], sequence.paddedYears ?? 0);
    const depletion = firstDepletionDetails(annotatedPlan.years);
    return {
      id: sequence.name ?? `Sequence ${index + 1}`,
      sourceYears: sequence.sourceYears ?? [],
      sourceStartYear: sequence.startYear ?? null,
      sourceEndYear: sequence.endYear ?? null,
      paddedYears: Math.max(0, Math.trunc(sequence.paddedYears) || 0),
      ...depletion,
      ...annotatedPlan
    };
  });
}

function withHistoricalSourceYears(plan, sourceYears = [], paddedYears = 0) {
  if (!sourceYears.length) return plan;
  // Mark which year-index is "padded" (re-using earlier source-year data
  // because the historical window was shorter than the plan horizon).
  const total = plan.years.length;
  const firstPaddedIndex = Math.max(0, total - paddedYears);
  return {
    ...plan,
    years: plan.years.map((year, index) => ({
      ...year,
      historicalSourceYear: sourceYears[index % sourceYears.length] ?? null,
      historicalPaddedYear: paddedYears > 0 && index >= firstPaddedIndex
    }))
  };
}

function firstDepletionDetails(years) {
  const depleted = years.find(isPortfolioDepleted);
  return {
    depletionYear: depleted?.year ?? null,
    depletionYearIndex: depleted?.yearIndex ?? null,
    depletionAge: depleted?.age ?? null
  };
}

function isPortfolioDepleted(year) {
  // Post-mortality stubs have a zero ending value by construction but are
  // not failures — the simulation is just past the modeled life span.
  if (year?.postMortality) return false;
  return (year?.endingPortfolioValue ?? 0) <= 0;
}

export function generateSingleMonteCarloPath({
  assets,
  scenario,
  taxProfile,
  seed = "finance",
  scenarioId
}) {
  const mergedScenario = ensureReturnAssumptionsForAssets(mergeScenario(scenario), assets);
  const rng = createRng(seed);
  
  for (let run = 0; run < scenarioId; run += 1) {
    const returnSequence = [];
    const inflationSequence = [];
    const medicalInflationSequence = [];
    for (let year = 0; year < mergedScenario.planYears; year += 1) {
      returnSequence.push(sampleReturnsForYear(mergedScenario, rng));
      inflationSequence.push(Math.max(-0.08, normalRandom(
        rng,
        mergedScenario.returnAssumptions.inflation?.mean ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.inflation.mean,
        mergedScenario.returnAssumptions.inflation?.stdev ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.inflation.stdev
      )));
      medicalInflationSequence.push(Math.max(-0.08, normalRandom(
        rng,
        mergedScenario.returnAssumptions.medicalInflation?.mean ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.medicalInflation.mean,
        mergedScenario.returnAssumptions.medicalInflation?.stdev ?? MONTE_CARLO_ASSUMPTION_PRESETS.marketNeutral.medicalInflation.stdev
      )));
    }
    
    if (run === scenarioId - 1) {
      const plan = simulatePlan({
        assets,
        scenario: mergedScenario,
        taxProfile,
        returnSequence,
        inflationSequence,
        medicalInflationSequence
      });
      return plan;
    }
  }
  return null;
}
