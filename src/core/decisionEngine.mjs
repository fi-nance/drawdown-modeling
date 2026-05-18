import {
  DEFAULT_SCENARIO,
  runHistoricalBacktests,
  runMonteCarlo,
  simulatePlan
} from "./simulation.mjs";
import { round } from "./utils.mjs";

export const DEFAULT_DECISION_PROFILE = Object.freeze({
  mode: "recentlyLeftWork",
  targetSuccessRate: 0.9,
  targetSuccessRateUserOverridden: false,
  verdictObjective: "avoidDepletion",
  evidenceWeights: Object.freeze({
    monteCarlo: 0.5,
    historical: 0.5
  }),
  incomeBridge: Object.freeze({
    enabled: true,
    maxYears: 6,
    maxAnnualIncome: 500000,
    incomeType: "medicareWages"
  }),
  healthcarePriority: "preserveConnectorCare",
  healthcarePlanSelection: Object.freeze({
    mode: "maConnectorCarePlanType",
    selectedPlanId: null
  })
});

const SOLVER_ITERATIONS = 6;
const SEARCH_RUN_CAP = 50;
const EPSILON = 0.00001;

export function normalizeDecisionProfile(profile = {}, scenario = {}) {
  const targetSuccessRate = clampNumber(
    Number(profile.targetSuccessRate),
    0.01,
    0.99,
    DEFAULT_DECISION_PROFILE.targetSuccessRate
  );
  const split = spendingSplit(profile, scenario);
  const incomeBridge = {
    ...DEFAULT_DECISION_PROFILE.incomeBridge,
    ...(plainObject(profile.incomeBridge) ? profile.incomeBridge : {})
  };

  return {
    ...DEFAULT_DECISION_PROFILE,
    ...(plainObject(profile) ? profile : {}),
    targetSuccessRate,
    targetSuccessRateUserOverridden: profile.targetSuccessRateUserOverridden === true
      || Math.abs(targetSuccessRate - DEFAULT_DECISION_PROFILE.targetSuccessRate) > EPSILON,
    requiredSpend: split.requiredSpend,
    flexibleSpend: split.flexibleSpend,
    targetSpend: split.targetSpend,
    verdictObjective: "avoidDepletion",
    evidenceWeights: { monteCarlo: 0.5, historical: 0.5 },
    incomeBridge: {
      enabled: incomeBridge.enabled !== false,
      maxYears: clampInteger(incomeBridge.maxYears, 1, 10, DEFAULT_DECISION_PROFILE.incomeBridge.maxYears),
      maxAnnualIncome: clampNumber(
        Number(incomeBridge.maxAnnualIncome),
        0,
        1000000,
        DEFAULT_DECISION_PROFILE.incomeBridge.maxAnnualIncome
      ),
      incomeType: normalizedIncomeType(incomeBridge.incomeType)
    },
    healthcarePlanSelection: {
      ...DEFAULT_DECISION_PROFILE.healthcarePlanSelection,
      ...(plainObject(profile.healthcarePlanSelection) ? profile.healthcarePlanSelection : {})
    }
  };
}

export function runDecisionBatch({
  assets,
  scenario = {},
  taxProfile,
  runs = 500,
  seed = 42,
  sequences = [],
  decisionProfile = {},
  basePlan = null,
  baseMonteCarlo = null,
  baseBacktests = null,
  onProgress = null
} = {}) {
  const profile = normalizeDecisionProfile(decisionProfile, scenario);
  const tracker = progressTracker(onProgress);
  const base = summarizeCandidate({
    id: "base",
    kind: "base",
    label: "Base plan",
    scenario,
    plan: basePlan ?? simulatePlan({ assets, scenario, taxProfile }),
    monteCarlo: baseMonteCarlo ?? runMonteCarlo({ assets, scenario, taxProfile, runs, seed }),
    backtests: baseBacktests ?? runHistoricalBacktests({ assets, scenario, taxProfile, sequences }),
    profile
  });

  const discretionaryCut = findDiscretionaryCut({
    assets,
    scenario,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    base,
    tracker
  });
  const incomeBridge = findIncomeBridge({
    assets,
    scenario,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    base,
    tracker
  });
  const combined = buildCombinedRescue({
    assets,
    scenario,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    base,
    discretionaryCut,
    incomeBridge,
    tracker
  });

  const rescueOptions = [discretionaryCut, incomeBridge, combined].filter(Boolean);
  const bestOption = [...rescueOptions].sort((a, b) => rescueSortScore(b, profile) - rescueSortScore(a, profile))[0] ?? null;
  const verdict = classifyDecisionEvidence({
    monteCarloSuccessRate: base.monteCarlo.successRate,
    historicalSuccessRate: base.historical.successRate,
    historicalCount: base.historical.count,
    targetSuccessRate: profile.targetSuccessRate
  });

  return {
    status: "ready",
    profile,
    verdict,
    targetSuccessRate: profile.targetSuccessRate,
    base,
    rescueOptions,
    bestOption,
    failureAnatomy: base.failureAnatomy,
    healthcare: healthcareSummary(base.planFirstYear, profile),
    generatedAt: new Date().toISOString()
  };
}

export function classifyDecisionEvidence({
  monteCarloSuccessRate,
  historicalSuccessRate,
  historicalCount = 0,
  targetSuccessRate = DEFAULT_DECISION_PROFILE.targetSuccessRate
} = {}) {
  const mc = Number.isFinite(monteCarloSuccessRate) ? monteCarloSuccessRate : 0;
  const hasHistory = historicalCount > 0 && Number.isFinite(historicalSuccessRate);
  const history = hasHistory ? historicalSuccessRate : null;
  const monteCarloPasses = mc + EPSILON >= targetSuccessRate;
  const historicalPasses = !hasHistory || history + EPSILON >= targetSuccessRate;
  const combinedSuccessRate = hasHistory ? round((mc + history) / 2, 4) : round(mc, 4);

  if (monteCarloPasses && historicalPasses) {
    return {
      label: "safe",
      tone: "ok",
      monteCarloPasses,
      historicalPasses,
      historicalKnown: hasHistory,
      combinedSuccessRate,
      reason: hasHistory
        ? "Monte Carlo and historical evidence both meet the target."
        : "Monte Carlo meets the target; historical evidence is unavailable for this setup."
    };
  }

  if (monteCarloPasses || historicalPasses) {
    return {
      label: "fragile",
      tone: "warn",
      monteCarloPasses,
      historicalPasses,
      historicalKnown: hasHistory,
      combinedSuccessRate,
      reason: hasHistory
        ? "Monte Carlo and historical evidence disagree, so the plan stays fragile."
        : "Monte Carlo misses the target."
    };
  }

  return {
    label: "unsafe",
    tone: "risk",
    monteCarloPasses,
    historicalPasses,
    historicalKnown: hasHistory,
    combinedSuccessRate,
    reason: "The plan misses the target in the tested evidence."
  };
}

export function scenarioWithDiscretionaryCut(scenario = {}, profile = {}, cutAmount = 0) {
  const normalized = normalizeDecisionProfile(profile, scenario);
  const flexibleSpend = Math.max(0, normalized.flexibleSpend);
  const cut = Math.max(0, Math.min(flexibleSpend, Number(cutAmount) || 0));
  const remainingPercent = flexibleSpend > 0 ? (flexibleSpend - cut) / flexibleSpend : 1;
  const correctionPercent = flexibleSpend > 0
    ? 1 - ((cut / flexibleSpend) * defaultCorrectionCutShare())
    : 1;
  return {
    ...scenario,
    targetSpend: round(normalized.requiredSpend + flexibleSpend, 2),
    spendingStrategy: {
      ...(scenario.spendingStrategy ?? {}),
      mode: "discretionaryGuardrails",
      essentialSpend: round(normalized.requiredSpend, 2),
      discretionarySpend: round(flexibleSpend, 2),
      essentialInflationAdjusted: true,
      discretionaryInflationAdjusted: false,
      correctionDrawdownThreshold: 0.1,
      bearDrawdownThreshold: 0.2,
      correctionDiscretionaryPercent: round(correctionPercent, 4),
      bearDiscretionaryPercent: round(remainingPercent, 4),
      marketAssetClass: "stock"
    }
  };
}

function defaultCorrectionCutShare() {
  const defaultCorrection = Number(DEFAULT_SCENARIO.spendingStrategy.correctionDiscretionaryPercent);
  const defaultBear = Number(DEFAULT_SCENARIO.spendingStrategy.bearDiscretionaryPercent);
  const correctionCutShare = 1 - (Number.isFinite(defaultCorrection) ? defaultCorrection : 0.5);
  const bearCutShare = 1 - (Number.isFinite(defaultBear) ? defaultBear : 0);
  return bearCutShare > 0 ? Math.max(0, Math.min(1, correctionCutShare / bearCutShare)) : 0.5;
}

export function scenarioWithIncomeBridge(scenario = {}, {
  annualIncome = 0,
  durationYears = 0,
  incomeType = DEFAULT_DECISION_PROFILE.incomeBridge.incomeType
} = {}) {
  const amount = Math.max(0, Number(annualIncome) || 0);
  const years = Math.max(0, Math.trunc(Number(durationYears) || 0));
  if (!(amount > 0) || !(years > 0)) return { ...scenario };
  return {
    ...scenario,
    oneOffExpenses: [
      ...(scenario.oneOffExpenses ?? []),
      {
        name: "Decision engine income bridge",
        cashFlowType: normalizedIncomeType(incomeType),
        startYear: 1,
        endYear: years,
        amount: round(amount, 2),
        inflationAdjusted: false
      }
    ]
  };
}

function findDiscretionaryCut({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  if (!(profile.flexibleSpend > 0)) return null;
  const searchRuns = solverSearchRuns(runs);
  const maxCut = profile.flexibleSpend;
  const fullCut = runCandidate({
    id: "discretionary-max",
    kind: "discretionaryCut",
    label: "Cut flexible spending",
    scenario: scenarioWithDiscretionaryCut(scenario, profile, maxCut),
    assets,
    taxProfile,
    runs: searchRuns,
    seed,
    sequences,
    profile,
    metadata: { cutAmount: maxCut, cutWhen: "earlyMarketStress" },
    includeHistorical: false,
    tracker
  });
  if (!meetsTarget(fullCut, profile)) {
    return optionWithDelta(finalizeCandidate({ candidate: fullCut, assets, taxProfile, runs, seed, sequences, profile }), base, { status: "best-tested" });
  }

  let low = 0;
  let high = maxCut;
  let best = fullCut;
  for (let index = 0; index < SOLVER_ITERATIONS; index += 1) {
    const cut = (low + high) / 2;
    const candidate = runCandidate({
      id: `discretionary-${index + 1}`,
      kind: "discretionaryCut",
      label: "Cut flexible spending",
      scenario: scenarioWithDiscretionaryCut(scenario, profile, cut),
      assets,
      taxProfile,
      runs: searchRuns,
      seed,
      sequences,
      profile,
      metadata: { cutAmount: cut, cutWhen: "earlyMarketStress" },
      includeHistorical: false,
      tracker
    });
    if (meetsTarget(candidate, profile)) {
      best = candidate;
      high = cut;
    } else {
      low = cut;
    }
  }
  return optionWithDelta(finalizeCandidate({ candidate: best, assets, taxProfile, runs, seed, sequences, profile }), base, { status: "target-met" });
}

function findIncomeBridge({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  if (profile.incomeBridge.enabled === false || !(profile.incomeBridge.maxAnnualIncome > 0)) return null;
  const candidates = [];
  const searchRuns = solverSearchRuns(runs);
  const maxYears = Math.max(1, profile.incomeBridge.maxYears);
  for (let duration = 1; duration <= maxYears; duration += 1) {
    const bestForDuration = binarySearchIncomeForDuration({
      assets,
      scenario,
      taxProfile,
      runs: searchRuns,
      seed,
      sequences,
      profile,
      duration,
      tracker
    });
    candidates.push(bestForDuration);
  }
  const passing = candidates.filter((candidate) => meetsTarget(candidate, profile));
  const winner = (passing.length ? passing : candidates)
    .sort((a, b) => incomeSortScore(a, profile) - incomeSortScore(b, profile))[0] ?? null;
  if (!winner) return null;
  const finalized = finalizeCandidate({ candidate: winner, assets, taxProfile, runs, seed, sequences, profile });
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function binarySearchIncomeForDuration({ assets, scenario, taxProfile, runs, seed, sequences, profile, duration, tracker }) {
  const maxIncome = profile.incomeBridge.maxAnnualIncome;
  const highCandidate = runIncomeCandidate({
    assets,
    scenario,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    duration,
    annualIncome: maxIncome,
    tracker
  });
  if (!meetsTarget(highCandidate, profile)) return highCandidate;

  let low = 0;
  let high = maxIncome;
  let best = highCandidate;
  for (let index = 0; index < SOLVER_ITERATIONS; index += 1) {
    const annualIncome = (low + high) / 2;
    const candidate = runIncomeCandidate({
      assets,
      scenario,
      taxProfile,
      runs,
      seed,
      sequences,
      profile,
      duration,
      annualIncome,
      tracker
    });
    if (meetsTarget(candidate, profile)) {
      best = candidate;
      high = annualIncome;
    } else {
      low = annualIncome;
    }
  }
  return best;
}

function runIncomeCandidate({ assets, scenario, taxProfile, runs, seed, sequences, profile, duration, annualIncome, tracker }) {
  return runCandidate({
    id: `income-${duration}-${Math.round(annualIncome)}`,
    kind: "incomeBridge",
    label: "Earn bridge income",
    scenario: scenarioWithIncomeBridge(scenario, {
      annualIncome,
      durationYears: duration,
      incomeType: profile.incomeBridge.incomeType
    }),
    assets,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    metadata: {
      annualIncome: round(annualIncome, 2),
      durationYears: duration,
      totalIncome: round(annualIncome * duration, 2),
      incomeType: profile.incomeBridge.incomeType
    },
    includeHistorical: false,
    tracker
  });
}

function buildCombinedRescue({
  assets,
  scenario,
  taxProfile,
  runs,
  seed,
  sequences,
  profile,
  base,
  discretionaryCut,
  incomeBridge,
  tracker
}) {
  if (!(discretionaryCut?.metadata?.cutAmount > 0) || !(incomeBridge?.metadata?.annualIncome > 0)) return null;
  let combinedScenario = scenario;
  if (discretionaryCut?.metadata?.cutAmount > 0) {
    combinedScenario = scenarioWithDiscretionaryCut(combinedScenario, profile, discretionaryCut.metadata.cutAmount);
  }
  if (incomeBridge?.metadata?.annualIncome > 0) {
    combinedScenario = scenarioWithIncomeBridge(combinedScenario, {
      annualIncome: incomeBridge.metadata.annualIncome,
      durationYears: incomeBridge.metadata.durationYears,
      incomeType: profile.incomeBridge.incomeType
    });
  }
  const candidate = runCandidate({
    id: "combined-rescue",
    kind: "combined",
    label: "Cut spending and earn bridge income",
    scenario: combinedScenario,
    assets,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    metadata: {
      cutAmount: discretionaryCut?.metadata?.cutAmount ?? 0,
      annualIncome: incomeBridge?.metadata?.annualIncome ?? 0,
      durationYears: incomeBridge?.metadata?.durationYears ?? 0,
      totalIncome: incomeBridge?.metadata?.totalIncome ?? 0
    },
    tracker
  });
  return optionWithDelta(candidate, base, { status: meetsTarget(candidate, profile) ? "target-met" : "best-tested" });
}

function runCandidate({
  id,
  kind,
  label,
  scenario,
  assets,
  taxProfile,
  runs,
  seed,
  sequences,
  profile,
  metadata = {},
  includeHistorical = true,
  tracker
}) {
  const candidate = summarizeCandidate({
    id,
    kind,
    label,
    scenario,
    plan: simulatePlan({ assets, scenario, taxProfile }),
    monteCarlo: runMonteCarlo({ assets, scenario, taxProfile, runs, seed }),
    backtests: includeHistorical ? runHistoricalBacktests({ assets, scenario, taxProfile, sequences }) : [],
    profile,
    metadata
  });
  tracker?.(candidate);
  return candidate;
}

function finalizeCandidate({ candidate, assets, taxProfile, runs, seed, sequences, profile }) {
  return runCandidate({
    id: candidate.id,
    kind: candidate.kind,
    label: candidate.label,
    scenario: candidate.scenario,
    assets,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    metadata: candidate.metadata,
    includeHistorical: true
  });
}

function summarizeCandidate({ id, kind, label, scenario, plan, monteCarlo, backtests, profile, metadata = {} }) {
  const mcScenarios = monteCarlo?.scenarios ?? [];
  const historical = historicalEvidence(backtests);
  const monteCarloSuccessRate = Number.isFinite(monteCarlo?.summary?.successRate)
    ? monteCarlo.summary.successRate
    : successRate(mcScenarios);
  const verdict = classifyDecisionEvidence({
    monteCarloSuccessRate,
    historicalSuccessRate: historical.successRate,
    historicalCount: historical.count,
    targetSuccessRate: profile.targetSuccessRate
  });
  const planFirstYear = plan?.years?.[0] ?? null;

  return {
    id,
    kind,
    label,
    status: "tested",
    metadata,
    scenario,
    scenarioSummary: {
      targetSpend: round(scenario?.targetSpend ?? profile.targetSpend ?? 0, 2),
      requiredSpend: round(profile.requiredSpend ?? 0, 2),
      flexibleSpend: round(profile.flexibleSpend ?? 0, 2)
    },
    verdict,
    monteCarlo: {
      successRate: round(monteCarloSuccessRate, 4),
      runs: monteCarlo?.summary?.runs ?? mcScenarios.length,
      medianEndingValue: monteCarlo?.summary?.medianEndingValue ?? percentile(mcScenarios.map((item) => item.endingValue), 0.5),
      p10EndingValue: monteCarlo?.summary?.p10EndingValue ?? percentile(mcScenarios.map((item) => item.endingValue), 0.1),
      p90EndingValue: monteCarlo?.summary?.p90EndingValue ?? percentile(mcScenarios.map((item) => item.endingValue), 0.9)
    },
    historical,
    failureAnatomy: failureAnatomy(mcScenarios),
    planFirstYear: planFirstYear ? {
      year: planFirstYear.year,
      magi: round(planFirstYear.magi ?? 0, 2),
      acaMagiCeiling: Number.isFinite(planFirstYear.acaMagiCeiling) ? round(planFirstYear.acaMagiCeiling, 2) : null,
      acaMagiCeilingFplPercent: Number.isFinite(planFirstYear.acaMagiCeilingFplPercent)
        ? round(planFirstYear.acaMagiCeilingFplPercent, 2)
        : null,
      acaSubsidy: round(planFirstYear.aca?.subsidy ?? 0, 2),
      acaNetPremium: round(planFirstYear.aca?.netPremium ?? 0, 2),
      acaFplPercent: Number.isFinite(planFirstYear.aca?.fplPercent)
        ? round(planFirstYear.aca.fplPercent * 100, 2)
        : null,
      earnedIncome: round(planFirstYear.earnedIncome ?? 0, 2),
      discretionaryTrim: round(Math.max(0, (planFirstYear.discretionarySpendingBudget ?? 0) - (planFirstYear.discretionarySpending ?? 0)), 2)
    } : null
  };
}

function optionWithDelta(option, base, extra = {}) {
  return {
    ...option,
    ...extra,
    delta: {
      monteCarloSuccessRate: round(option.monteCarlo.successRate - base.monteCarlo.successRate, 4),
      historicalSuccessRate: Number.isFinite(option.historical.successRate) && Number.isFinite(base.historical.successRate)
        ? round(option.historical.successRate - base.historical.successRate, 4)
        : null,
      combinedSuccessRate: round(option.verdict.combinedSuccessRate - base.verdict.combinedSuccessRate, 4),
      firstYearSubsidy: option.planFirstYear && base.planFirstYear
        ? round((option.planFirstYear.acaSubsidy ?? 0) - (base.planFirstYear.acaSubsidy ?? 0), 2)
        : null
    }
  };
}

function meetsTarget(candidate, profile) {
  return candidate?.verdict?.monteCarloPasses === true
    && (candidate.verdict.historicalKnown === false || candidate.verdict.historicalPasses === true)
    && candidate.monteCarlo.successRate + EPSILON >= profile.targetSuccessRate;
}

function incomeSortScore(candidate, profile) {
  const passPenalty = meetsTarget(candidate, profile) ? 0 : 10_000_000_000;
  const total = candidate?.metadata?.totalIncome ?? Number.MAX_SAFE_INTEGER;
  const annual = candidate?.metadata?.annualIncome ?? Number.MAX_SAFE_INTEGER;
  const duration = candidate?.metadata?.durationYears ?? 99;
  const qualityPenalty = Math.max(0, profile.targetSuccessRate - (candidate?.verdict?.combinedSuccessRate ?? 0)) * 1_000_000_000;
  return passPenalty + qualityPenalty + total + annual * 0.01 + duration;
}

function rescueSortScore(candidate, profile) {
  const targetBonus = meetsTarget(candidate, profile) ? 1_000_000 : 0;
  const combined = candidate?.verdict?.combinedSuccessRate ?? 0;
  const disruption = disruptionPenalty(candidate);
  return targetBonus + combined * 1000 - disruption;
}

function disruptionPenalty(candidate) {
  if (!candidate) return 0;
  const cut = (candidate.metadata?.cutAmount ?? 0) / 1000000;
  const income = (candidate.metadata?.totalIncome ?? 0) / 1000000;
  return cut + income;
}

function historicalEvidence(backtests = []) {
  const list = Array.isArray(backtests) ? backtests : [];
  const endings = list.map((item) => item.endingValue).filter(Number.isFinite).sort((a, b) => a - b);
  const worst = endings[0] ?? null;
  const best = endings[endings.length - 1] ?? null;
  return {
    count: list.length,
    successRate: list.length ? round(successRate(list), 4) : null,
    medianEndingValue: endings.length ? percentile(endings, 0.5) : null,
    worstEndingValue: worst,
    bestEndingValue: best
  };
}

function failureAnatomy(scenarios = []) {
  const failed = scenarios.filter((item) => item && item.success === false);
  if (!failed.length) {
    return {
      failedCount: 0,
      earliestFailureYear: null,
      medianFailureYear: null,
      commonTrigger: "No failures in tested paths"
    };
  }
  const failureYears = failed
    .map((item) => item.depletionYearIndex)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const earlyFailures = failureYears.filter((index) => index <= 10).length;
  const trigger = earlyFailures / failed.length >= 0.5
    ? "Early sequence risk"
    : "Long-horizon depletion";
  return {
    failedCount: failed.length,
    earliestFailureYear: failureYears.length ? failureYears[0] + 1 : null,
    medianFailureYear: failureYears.length ? percentile(failureYears, 0.5) + 1 : null,
    commonTrigger: trigger
  };
}

function healthcareSummary(firstYear, profile) {
  if (!firstYear) {
    return {
      available: false,
      priority: profile.healthcarePriority
    };
  }
  const ceiling = firstYear.acaMagiCeiling;
  const magi = firstYear.magi;
  return {
    available: Number.isFinite(ceiling) || Number.isFinite(magi),
    priority: profile.healthcarePriority,
    magi: Number.isFinite(magi) ? round(magi, 2) : null,
    magiCeiling: Number.isFinite(ceiling) ? round(ceiling, 2) : null,
    magiBuffer: Number.isFinite(ceiling) && Number.isFinite(magi) ? round(ceiling - magi, 2) : null,
    fplCeilingPercent: Number.isFinite(firstYear.acaMagiCeilingFplPercent)
      ? round(firstYear.acaMagiCeilingFplPercent, 2)
      : null,
    subsidy: round(firstYear.acaSubsidy ?? 0, 2),
    netPremium: round(firstYear.acaNetPremium ?? 0, 2)
  };
}

function spendingSplit(profile, scenario) {
  const scenarioStrategy = scenario?.spendingStrategy ?? {};
  const totalSpend = Math.max(0, Number(scenario?.targetSpend) || 0);
  const scenarioEssential = Math.max(0, Number(scenarioStrategy.essentialSpend) || 0);
  const scenarioDiscretionary = Math.max(0, Number(scenarioStrategy.discretionarySpend) || 0);
  let requiredSpend = profile.requiredSpend != null && Number.isFinite(Number(profile.requiredSpend))
    ? Math.max(0, Number(profile.requiredSpend))
    : scenarioEssential;
  let flexibleSpend = profile.flexibleSpend != null && Number.isFinite(Number(profile.flexibleSpend))
    ? Math.max(0, Number(profile.flexibleSpend))
    : scenarioDiscretionary;

  if (!(requiredSpend + flexibleSpend > 0) && totalSpend > 0) {
    requiredSpend = round(totalSpend * 0.75, 2);
    flexibleSpend = round(totalSpend - requiredSpend, 2);
  } else if (totalSpend > 0 && !(flexibleSpend > 0)) {
    flexibleSpend = Math.max(0, totalSpend - requiredSpend);
  }

  return {
    requiredSpend: round(requiredSpend, 2),
    flexibleSpend: round(flexibleSpend, 2),
    targetSpend: round(requiredSpend + flexibleSpend || totalSpend, 2)
  };
}

function progressTracker(onProgress) {
  if (typeof onProgress !== "function") return null;
  let done = 0;
  return (candidate) => {
    done += 1;
    onProgress({
      done,
      candidateId: candidate.id,
      candidateKind: candidate.kind,
      label: candidate.label
    });
  };
}

function successRate(items = []) {
  return items.length ? items.filter((item) => item?.success === true).length / items.length : 0;
}

function percentile(values = [], pct = 0.5) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * pct)));
  return sorted[index];
}

function normalizedIncomeType(value) {
  return ["medicareWages", "selfEmploymentIncome", "rrtaCompensation", "taxableOrdinaryIncome", "taxFreeIncome"].includes(value)
    ? value
    : DEFAULT_DECISION_PROFILE.incomeBridge.incomeType;
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function solverSearchRuns(runs) {
  return Math.max(10, Math.min(SEARCH_RUN_CAP, Math.trunc(Number(runs) || SEARCH_RUN_CAP)));
}
