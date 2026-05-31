import {
  DEFAULT_MONTE_CARLO_RUNS,
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
    maxAnnualIncome: 150000,
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

const RESERVE_MAX_YEARS = 5;
const RESERVE_MODES = ["cash", "hybrid"];
const ALLOCATION_TARGETS = [40, 55, 70, 85];
const DEFAULT_MAGI_BUFFER = 1000;
const SENSITIVITY_TOP_COUNT = 3;
const WITHDRAWAL_ORDERS = [
  ["taxable", "traditional", "hsa", "roth"],
  ["traditional", "taxable", "hsa", "roth"],
  ["taxable", "hsa", "traditional", "roth"]
];
const SUMMARY_ONLY_MONTE_CARLO_TIMELINES = 0;

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
  runs = DEFAULT_MONTE_CARLO_RUNS,
  seed = 42,
  sequences = [],
  decisionProfile = {},
  basePlan = null,
  baseMonteCarlo = null,
  baseBacktests = null,
  onProgress = null
} = {}) {
  const profile = normalizeDecisionProfile(decisionProfile, scenario);
  const base = summarizeCandidate({
    id: "base",
    kind: "base",
    label: "Base plan",
    scenario,
    plan: basePlan ?? simulatePlan({ assets, scenario, taxProfile }),
    monteCarlo: baseMonteCarlo ?? runMonteCarlo({
      assets,
      scenario,
      taxProfile,
      runs,
      seed,
      scenarioTimelineLimit: SUMMARY_ONLY_MONTE_CARLO_TIMELINES
    }),
    backtests: baseBacktests ?? runHistoricalBacktests({ assets, scenario, taxProfile, sequences }),
    profile
  });
  const testedRescueOptions = [];
  const tracker = progressTracker({ onProgress, base, candidates: testedRescueOptions });

  const solverContext = { assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker };

  const safeSpending = findSafeSpendingBoundary(solverContext);

  // The discretionary cut is the same lever a guardrails plan already owns,
  // so skip it as a distinct rescue when the base plan already guards spending.
  const baseUsesGuardrails = ["discretionaryGuardrails", "guytonKlinger", "kitces", "vpw"].includes(scenario?.spendingStrategy?.mode);
  const discretionaryCut = baseUsesGuardrails ? null : findDiscretionaryCut(solverContext);
  const guytonKlingerRescue = baseUsesGuardrails ? null : findGuytonKlingerRescue(solverContext);
  const vpwRescue = baseUsesGuardrails ? null : findVpwRescue(solverContext);
  const incomeBridge = findIncomeBridge(solverContext);
  const sequenceReserve = findSequenceReserve(solverContext);
  const allocationShift = findAllocationShift(solverContext);
  const withdrawalShift = findWithdrawalShift(solverContext);
  const healthcareRescue = findHealthcareRescue(solverContext);
  const rothBasisCliffRescue = findRothBasisCliffRescue(solverContext);
  const taxableLotRescue = findTaxableLotRescue(solverContext);
  const conversionGuardrail = findConversionGuardrail(solverContext);
  const magiSpendTrim = findMagiSpendTrim(solverContext);
  const irmaaLookbackRescue = findIrmaaLookbackRescue(solverContext);
  const socialSecurityBridge = findSocialSecurityBridge(solverContext);
  const combined = buildCombinedRescue({ ...solverContext, discretionaryCut, incomeBridge });

  const verdict = classifyDecisionEvidence({
    monteCarloSuccessRate: base.monteCarlo.successRate,
    historicalSuccessRate: base.historical.successRate,
    historicalCount: base.historical.count,
    targetSuccessRate: profile.targetSuccessRate
  });
  const diagnosis = diagnoseFailure({ base, safeSpending, profile });
  const sensitivity = buildSensitivityAnalysis({
    assets,
    scenario,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    base
  });

  const rescueOptions = [
    discretionaryCut,
    guytonKlingerRescue,
    vpwRescue,
    incomeBridge,
    sequenceReserve,
    allocationShift,
    withdrawalShift,
    healthcareRescue,
    rothBasisCliffRescue,
    taxableLotRescue,
    conversionGuardrail,
    magiSpendTrim,
    irmaaLookbackRescue,
    socialSecurityBridge,
    combined
  ].filter(Boolean);
  rescueOptions.sort((a, b) => rescueSortScore(b, profile, diagnosis) - rescueSortScore(a, profile, diagnosis));
  const bestOption = rescueOptions[0] ?? null;

  const tradeoffFrontier = buildTradeoffFrontier(solverContext);

  return {
    status: "ready",
    profile,
    verdict,
    diagnosis,
    safeSpending,
    targetSuccessRate: profile.targetSuccessRate,
    base,
    testedRescueOptions,
    rescueOptions,
    bestOption,
    failureAnatomy: base.failureAnatomy,
    healthcare: healthcareSummary(base.planFirstYear, profile),
    sensitivity,
    tradeoffFrontier,
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
    const finalized = finalizeCandidate({ candidate: fullCut, assets, taxProfile, runs, seed, sequences, profile });
    return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
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
  let finalized = finalizeCandidate({ candidate: best, assets, taxProfile, runs, seed, sequences, profile });
  // The bounded search picks `best` on noisy search-run evidence. If the
  // finalized full-run result misses the target, that pick is not
  // trustworthy: a smaller cut looked sufficient only by sampling noise.
  // Fall back to the full flexible-spend cut, the largest and genuinely
  // best cut the solver can offer, so the reported amount and success
  // rate stay consistent (and a target-meeting full cut is not hidden).
  if (!meetsTarget(finalized, profile) && best.metadata.cutAmount + EPSILON < maxCut) {
    finalized = finalizeCandidate({ candidate: fullCut, assets, taxProfile, runs, seed, sequences, profile });
  }
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findGuytonKlingerRescue({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  const searchRuns = solverSearchRuns(runs);
  const cand = runCandidate({
    id: "guyton-klinger-rescue",
    kind: "guytonKlingerRescue",
    label: "Switch to Guyton-Klinger spending rules",
    scenario: {
      ...scenario,
      spendingStrategy: {
        ...scenario.spendingStrategy,
        mode: "guytonKlinger",
        essentialSpend: profile.requiredSpend,
        discretionarySpend: profile.flexibleSpend
      }
    },
    assets,
    taxProfile,
    runs: searchRuns,
    seed,
    sequences,
    profile,
    metadata: { strategyMode: "guytonKlinger" },
    includeHistorical: true,
    tracker
  });
  const finalized = finalizeCandidate({ candidate: cand, assets, taxProfile, runs, seed, sequences, profile });
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findVpwRescue({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  const searchRuns = solverSearchRuns(runs);
  const cand = runCandidate({
    id: "vpw-rescue",
    kind: "vpwRescue",
    label: "Switch to VPW (Variable Percentage Withdrawal)",
    scenario: {
      ...scenario,
      spendingStrategy: {
        ...scenario.spendingStrategy,
        mode: "vpw"
      }
    },
    assets,
    taxProfile,
    runs: searchRuns,
    seed,
    sequences,
    profile,
    metadata: { strategyMode: "vpw" },
    includeHistorical: true,
    tracker
  });
  const finalized = finalizeCandidate({ candidate: cand, assets, taxProfile, runs, seed, sequences, profile });
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
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

export function scenarioWithFlatSpend(scenario = {}, totalSpend = 0) {
  const total = Math.max(0, Number(totalSpend) || 0);
  return {
    ...scenario,
    targetSpend: round(total, 2),
    spendingStrategy: {
      ...(plainObject(scenario.spendingStrategy) ? scenario.spendingStrategy : {}),
      mode: "fixed"
    }
  };
}

export function scenarioWithSequenceReserve(scenario = {}, { mode = "cash", targetYears = 3 } = {}) {
  const years = Math.max(1, Math.trunc(Number(targetYears) || 0));
  const reserveMode = RESERVE_MODES.includes(mode) || mode === "bond" ? mode : "cash";
  const existing = plainObject(scenario.sequenceRiskReserve) ? scenario.sequenceRiskReserve : {};
  return {
    ...scenario,
    sequenceRiskReserve: {
      tentYears: 10,
      triggerStockReturn: 0,
      ...existing,
      enabled: true,
      mode: reserveMode,
      targetYears: years
    }
  };
}

export function scenarioWithAllocationTarget(scenario = {}, targetStockPercent = 70) {
  const pct = clampNumber(Number(targetStockPercent), 0, 100, 70);
  const existing = plainObject(scenario.allocationStrategy) ? scenario.allocationStrategy : {};
  return {
    ...scenario,
    allocationStrategy: {
      ...existing,
      rebalanceEnabled: true,
      glidepathEnabled: false,
      targetStockPercent: round(pct, 2)
    }
  };
}

export function scenarioWithWithdrawalPlan(scenario = {}, { mode = null, order = null } = {}) {
  const next = { ...scenario };
  if (mode) {
    const existing = plainObject(scenario.withdrawalStrategy) ? scenario.withdrawalStrategy : {};
    next.withdrawalStrategy = { ...existing, mode };
  }
  if (Array.isArray(order) && order.length) {
    next.withdrawalOrder = [...order];
  }
  return next;
}

export function scenarioWithMagiDiscipline(scenario = {}, { maxAcaFplPercent = 400, disableGainHarvesting = true } = {}) {
  const next = { ...scenario };
  const existingRoth = plainObject(scenario.rothConversion) ? scenario.rothConversion : {};
  next.rothConversion = {
    ...existingRoth,
    enabled: true,
    optimizeForAca: true,
    maxAcaFplPercent: clampNumber(Number(maxAcaFplPercent), 100, 600, 400),
    magiBuffer: Math.max(0, Number(existingRoth.magiBuffer) || DEFAULT_MAGI_BUFFER)
  };
  if (disableGainHarvesting) {
    const existingGain = plainObject(scenario.taxGainHarvesting) ? scenario.taxGainHarvesting : {};
    next.taxGainHarvesting = { ...existingGain, enabled: false };
  }
  return next;
}

export function scenarioWithRothBasisCliffRescue(scenario = {}, { maxAcaFplPercent = 400, magiBuffer = DEFAULT_MAGI_BUFFER } = {}) {
  const next = scenarioWithWithdrawalPlan(scenario, {
    mode: "lifetime",
    order: ensureWithdrawalOrderIncludes(scenario.withdrawalOrder, "roth")
  });
  const existingRothBasis = plainObject(scenario.rothBasisOptimization) ? scenario.rothBasisOptimization : {};
  const existingRothConversion = plainObject(scenario.rothConversion) ? scenario.rothConversion : {};
  return {
    ...next,
    rothBasisOptimization: {
      ...existingRothBasis,
      enabled: true,
      opportunityCostMode: "dynamic",
      magiBuffer: Math.max(0, Number(magiBuffer) || 0)
    },
    rothConversion: {
      ...existingRothConversion,
      optimizeForAca: true,
      maxAcaFplPercent: clampNumber(Number(maxAcaFplPercent), 100, 600, 400),
      magiBuffer: Math.max(0, Number(magiBuffer) || 0)
    }
  };
}

export function scenarioWithTaxableLotRescue(scenario = {}) {
  const order = ["taxable", "hsa", "traditional", "roth"];
  const existingGain = plainObject(scenario.taxGainHarvesting) ? scenario.taxGainHarvesting : {};
  const existingLoss = plainObject(scenario.taxLossHarvesting) ? scenario.taxLossHarvesting : {};
  return {
    ...scenarioWithWithdrawalPlan(scenario, { mode: "lifetime", order }),
    taxLossHarvesting: { ...existingLoss, enabled: true },
    taxGainHarvesting: scenario.aca?.enabled === false
      ? { ...existingGain, enabled: existingGain.enabled !== false }
      : { ...existingGain, enabled: false }
  };
}

export function scenarioWithConversionGuardrails(scenario = {}, { maxAcaFplPercent = 400, magiBuffer = DEFAULT_MAGI_BUFFER } = {}) {
  const existingRoth = plainObject(scenario.rothConversion) ? scenario.rothConversion : {};
  const existingGain = plainObject(scenario.taxGainHarvesting) ? scenario.taxGainHarvesting : {};
  return {
    ...scenarioWithWithdrawalPlan(scenario, { mode: "lifetime" }),
    rothConversion: {
      ...existingRoth,
      enabled: existingRoth.enabled !== false,
      optimizeForAca: true,
      applyMagiGuardrails: true,
      maxAcaFplPercent: clampNumber(Number(maxAcaFplPercent), 100, 600, 400),
      magiBuffer: Math.max(0, Number(magiBuffer) || 0)
    },
    taxGainHarvesting: {
      ...existingGain,
      magiBuffer: Math.max(0, Number(magiBuffer) || 0)
    }
  };
}

export function scenarioWithMagiSpendTrim(scenario = {}, profile = {}, trimAmount = 0) {
  const normalized = normalizeDecisionProfile(profile, scenario);
  const flexible = Math.max(0, normalized.flexibleSpend);
  const trim = Math.max(0, Math.min(flexible, Number(trimAmount) || 0));
  const remainingFlexible = Math.max(0, flexible - trim);
  return {
    ...scenario,
    targetSpend: round(normalized.requiredSpend + remainingFlexible, 2),
    spendingStrategy: {
      ...(plainObject(scenario.spendingStrategy) ? scenario.spendingStrategy : {}),
      mode: "fixed",
      essentialSpend: round(normalized.requiredSpend, 2),
      discretionarySpend: round(remainingFlexible, 2)
    }
  };
}

export function scenarioWithIrmaaLookbackGuardrails(scenario = {}, { maxIrmaaTier = 0 } = {}) {
  const existingMedicare = plainObject(scenario.medicare) ? scenario.medicare : {};
  const existingGain = plainObject(scenario.taxGainHarvesting) ? scenario.taxGainHarvesting : {};
  return {
    ...scenarioWithConversionGuardrails(scenario, { maxAcaFplPercent: scenario.rothConversion?.maxAcaFplPercent ?? 400, magiBuffer: 0 }),
    medicare: {
      ...existingMedicare,
      irmaaEnabled: true,
      maxIrmaaTier: Math.max(0, Math.trunc(Number(maxIrmaaTier) || 0))
    },
    taxGainHarvesting: {
      ...existingGain,
      enabled: false
    }
  };
}

export function scenarioWithSocialSecurityBridge(scenario = {}, claimAge = 70) {
  const currentStart = Number(scenario.socialSecurityStartAge ?? 67);
  const targetStart = clampNumber(Number(claimAge), 62, 70, 70);
  if (!(targetStart > currentStart)) return { ...scenario };
  const annualBenefit = Math.max(0, Number(scenario.socialSecurityAnnualBenefit) || 0);
  const adjustedBenefit = annualBenefit > 0
    ? annualBenefit / socialSecurityClaimFactor(currentStart) * socialSecurityClaimFactor(targetStart)
    : annualBenefit;
  return {
    ...scenario,
    socialSecurityStartAge: targetStart,
    socialSecurityAnnualBenefit: round(adjustedBenefit, 2)
  };
}

function findSafeSpendingBoundary({ assets, scenario, taxProfile, runs, seed, sequences, profile, tracker }) {
  const requiredSpend = Math.max(0, Number(profile.requiredSpend) || 0);
  const flexibleSpend = Math.max(0, Number(profile.flexibleSpend) || 0);
  const currentTargetSpend = round(requiredSpend + flexibleSpend, 2);
  if (!(currentTargetSpend > 0)) return null;
  const searchRuns = solverSearchRuns(runs);

  const probe = (spend) => runCandidate({
    id: `safe-spend-${Math.round(spend)}`,
    kind: "safeSpending",
    label: "Safe spending boundary",
    scenario: scenarioWithFlatSpend(scenario, spend),
    assets,
    taxProfile,
    runs: searchRuns,
    seed,
    sequences,
    profile,
    metadata: { totalSpend: round(spend, 2) },
    includeHistorical: false,
    tracker
  });

  let high = Math.max(currentTargetSpend, requiredSpend, 1);
  let highCandidate = probe(high);
  let expansions = 0;
  while (meetsTarget(highCandidate, profile) && expansions < 4) {
    high *= 1.6;
    highCandidate = probe(high);
    expansions += 1;
  }
  const headroomCapped = meetsTarget(highCandidate, profile);

  let low = 0;
  let best = 0;
  if (headroomCapped) {
    best = high;
  } else {
    for (let index = 0; index < SOLVER_ITERATIONS + 2; index += 1) {
      const spend = (low + high) / 2;
      if (meetsTarget(probe(spend), profile)) {
        best = spend;
        low = spend;
      } else {
        high = spend;
      }
    }
  }

  const finalized = runCandidate({
    id: "safe-spend-final",
    kind: "safeSpending",
    label: "Safe spending boundary",
    scenario: scenarioWithFlatSpend(scenario, best),
    assets,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    metadata: { totalSpend: round(best, 2) },
    includeHistorical: true,
    tracker
  });

  const safeTotalSpend = round(best, 2);
  const gap = round(currentTargetSpend - safeTotalSpend, 2);
  const requiredUnsustainable = safeTotalSpend + EPSILON < requiredSpend;
  let status = "trim-flexible";
  if (gap <= EPSILON) status = "headroom";
  else if (requiredUnsustainable) status = "required-unsustainable";

  return {
    available: true,
    status,
    requiredSpend: round(requiredSpend, 2),
    flexibleSpend: round(flexibleSpend, 2),
    currentTargetSpend,
    safeTotalSpend,
    safeFlexibleSpend: round(Math.max(0, safeTotalSpend - requiredSpend), 2),
    gap,
    headroom: gap < 0 ? round(-gap, 2) : 0,
    headroomCapped,
    requiredUnsustainable,
    monteCarloSuccessRate: finalized.monteCarlo.successRate,
    historicalSuccessRate: finalized.historical.successRate,
    verdict: finalized.verdict
  };
}

function findSequenceReserve({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  const searchRuns = solverSearchRuns(runs);
  const candidates = [];
  let passing = null;
  for (let years = 1; years <= RESERVE_MAX_YEARS && !passing; years += 1) {
    for (const mode of RESERVE_MODES) {
      const candidate = runCandidate({
        id: `reserve-${years}-${mode}`,
        kind: "sequenceReserve",
        label: "Hold a sequence-risk reserve",
        scenario: scenarioWithSequenceReserve(scenario, { mode, targetYears: years }),
        assets,
        taxProfile,
        runs: searchRuns,
        seed,
        sequences,
        profile,
        metadata: { reserveYears: years, reserveMode: mode },
        includeHistorical: false,
        tracker
      });
      candidates.push(candidate);
      if (meetsTarget(candidate, profile)) {
        passing = candidate;
        break;
      }
    }
  }
  const winner = passing
    ?? [...candidates].sort((a, b) => b.monteCarlo.successRate - a.monteCarlo.successRate)[0]
    ?? null;
  if (!winner) return null;
  const finalized = finalizeCandidate({ candidate: winner, assets, taxProfile, runs, seed, sequences, profile });
  if (!isWorthwhileRescue(finalized, base, profile)) {
    return optionWithDelta(finalized, base, { status: "discarded" });
  }
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findAllocationShift({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  const searchRuns = solverSearchRuns(runs);
  const baseWorst = Number.isFinite(base?.historical?.worstEndingValue) ? base.historical.worstEndingValue : null;
  const currentTarget = Number(scenario?.allocationStrategy?.targetStockPercent);
  const baseRebalances = scenario?.allocationStrategy?.rebalanceEnabled === true;
  const candidates = [];
  for (const target of ALLOCATION_TARGETS) {
    if (baseRebalances && Number.isFinite(currentTarget) && Math.abs(currentTarget - target) < 1) continue;
    candidates.push(runCandidate({
      id: `allocation-${target}`,
      kind: "allocationShift",
      label: "Shift the target allocation",
      scenario: scenarioWithAllocationTarget(scenario, target),
      assets,
      taxProfile,
      runs: searchRuns,
      seed,
      sequences,
      profile,
      metadata: { targetStockPercent: target },
      includeHistorical: true,
      tracker
    }));
  }
  // Hard guardrail: never recommend an allocation that worsens the historical worst path.
  const allowed = candidates.filter((candidate) => {
    if (baseWorst == null) return true;
    const worst = Number(candidate?.historical?.worstEndingValue);
    return !Number.isFinite(worst) || worst + EPSILON >= baseWorst;
  });
  if (!allowed.length) return null;
  const passing = allowed.filter((candidate) => meetsTarget(candidate, profile));
  const winner = (passing.length ? passing : allowed)
    .sort((a, b) => b.monteCarlo.successRate - a.monteCarlo.successRate)[0];
  if (!winner) return null;
  const finalized = finalizeCandidate({ candidate: winner, assets, taxProfile, runs, seed, sequences, profile });
  // Re-apply the worst-path guardrail to the finalized (full-run) candidate.
  const finalizedWorst = Number(finalized?.historical?.worstEndingValue);
  const worsensWorstPath = baseWorst != null
    && Number.isFinite(finalizedWorst)
    && finalizedWorst + EPSILON < baseWorst;
  if (worsensWorstPath || !isWorthwhileRescue(finalized, base, profile)) {
    return optionWithDelta(finalized, base, {
      status: "discarded",
      worstPathGuardrail: baseWorst != null
    });
  }
  return optionWithDelta(finalized, base, {
    status: meetsTarget(finalized, profile) ? "target-met" : "best-tested",
    worstPathGuardrail: baseWorst != null
  });
}

function findWithdrawalShift({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  const searchRuns = solverSearchRuns(runs);
  const baseMode = typeof scenario?.withdrawalStrategy === "string"
    ? scenario.withdrawalStrategy
    : scenario?.withdrawalStrategy?.mode === "heuristic" ? "heuristic" : "lifetime";
  const altMode = baseMode === "lifetime" ? "heuristic" : "lifetime";
  const baseOrder = Array.isArray(scenario?.withdrawalOrder) ? scenario.withdrawalOrder.join(">") : "";
  const variants = [
    { id: "withdrawal-mode", mode: altMode, order: null, label: `Use the ${altMode} withdrawal strategy` }
  ];
  WITHDRAWAL_ORDERS.forEach((order, index) => {
    if (order.join(">") !== baseOrder) {
      variants.push({ id: `withdrawal-order-${index}`, mode: null, order, label: "Reorder account withdrawals" });
    }
  });
  const candidates = variants.map((variant) => runCandidate({
    id: variant.id,
    kind: "withdrawalShift",
    label: variant.label,
    scenario: scenarioWithWithdrawalPlan(scenario, { mode: variant.mode, order: variant.order }),
    assets,
    taxProfile,
    runs: searchRuns,
    seed,
    sequences,
    profile,
    metadata: {
      withdrawalMode: variant.mode ?? baseMode,
      withdrawalOrder: variant.order ?? (Array.isArray(scenario?.withdrawalOrder) ? scenario.withdrawalOrder : null)
    },
    includeHistorical: false,
    tracker
  }));
  if (!candidates.length) return null;
  const passing = candidates.filter((candidate) => meetsTarget(candidate, profile));
  const winner = (passing.length ? passing : candidates)
    .sort((a, b) => b.monteCarlo.successRate - a.monteCarlo.successRate)[0];
  if (!winner) return null;
  const finalized = finalizeCandidate({ candidate: winner, assets, taxProfile, runs, seed, sequences, profile });
  if (!isWorthwhileRescue(finalized, base, profile)) {
    return optionWithDelta(finalized, base, { status: "discarded" });
  }
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findHealthcareRescue({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  if (scenario?.aca?.enabled === false) return null;
  const firstYear = base?.planFirstYear;
  if (!firstYear || !Number.isFinite(firstYear.acaMagiCeiling)) return null;
  const searchRuns = solverSearchRuns(runs);
  const variants = [
    { id: "healthcare-fpl-400", maxAcaFplPercent: 400, disableGainHarvesting: false },
    { id: "healthcare-fpl-400-nogain", maxAcaFplPercent: 400, disableGainHarvesting: true },
    { id: "healthcare-fpl-250-nogain", maxAcaFplPercent: 250, disableGainHarvesting: true }
  ];
  const candidates = variants.map((variant) => runCandidate({
    id: variant.id,
    kind: "healthcareRescue",
    label: "Discipline MAGI to protect the subsidy",
    scenario: scenarioWithMagiDiscipline(scenario, variant),
    assets,
    taxProfile,
    runs: searchRuns,
    seed,
    sequences,
    profile,
    metadata: {
      maxAcaFplPercent: variant.maxAcaFplPercent,
      gainHarvestingDisabled: variant.disableGainHarvesting,
      magiCeiling: round(firstYear.acaMagiCeiling, 2)
    },
    includeHistorical: false,
    tracker
  }));
  const passing = candidates.filter((candidate) => meetsTarget(candidate, profile));
  const winner = (passing.length ? passing : candidates)
    .sort((a, b) => healthcareSortScore(b) - healthcareSortScore(a))[0];
  if (!winner) return null;
  const finalized = finalizeCandidate({ candidate: winner, assets, taxProfile, runs, seed, sequences, profile });
  const subsidyGain = (finalized.planFirstYear?.acaSubsidy ?? 0) > (base.planFirstYear?.acaSubsidy ?? 0) + 1;
  if (!isWorthwhileRescue(finalized, base, profile) && !subsidyGain) {
    return optionWithDelta(finalized, base, { status: "discarded" });
  }
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findRothBasisCliffRescue({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  if (scenario?.aca?.enabled === false || !hasAccountType(assets, "roth")) return null;
  const firstYear = base?.planFirstYear;
  if (!firstYear || !Number.isFinite(firstYear.acaMagiCeiling)) return null;
  const candidate = runCandidate({
    id: "roth-basis-cliff",
    kind: "rothBasisCliffRescue",
    label: "Use Roth basis to stay under MAGI cliffs",
    scenario: scenarioWithRothBasisCliffRescue(scenario, {
      maxAcaFplPercent: firstYear.acaMagiCeilingFplPercent ?? 400,
      magiBuffer: DEFAULT_MAGI_BUFFER
    }),
    assets,
    taxProfile,
    runs: solverSearchRuns(runs),
    seed,
    sequences,
    profile,
    metadata: {
      magiBuffer: DEFAULT_MAGI_BUFFER,
      maxAcaFplPercent: firstYear.acaMagiCeilingFplPercent ?? 400
    },
    includeHistorical: false,
    tracker
  });
  const finalized = finalizeCandidate({ candidate, assets, taxProfile, runs, seed, sequences, profile });
  const subsidyGain = firstYearSubsidyGain(finalized, base);
  if (!isWorthwhileRescue(finalized, base, profile) && !(subsidyGain > MEANINGFUL_SUBSIDY_GAIN)) {
    return optionWithDelta(finalized, base, { status: "discarded" });
  }
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findTaxableLotRescue({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  if (!hasAccountType(assets, "taxable")) return null;
  const candidate = runCandidate({
    id: "taxable-lot-rescue",
    kind: "taxableLotRescue",
    label: "Spend high-basis taxable lots first",
    scenario: scenarioWithTaxableLotRescue(scenario),
    assets,
    taxProfile,
    runs: solverSearchRuns(runs),
    seed,
    sequences,
    profile,
    metadata: {
      withdrawalOrder: ["taxable", "hsa", "traditional", "roth"],
      gainHarvestingDisabled: scenario.aca?.enabled !== false
    },
    includeHistorical: false,
    tracker
  });
  const finalized = finalizeCandidate({ candidate, assets, taxProfile, runs, seed, sequences, profile });
  if (!isWorthwhileRescue(finalized, base, profile) && !(firstYearSubsidyGain(finalized, base) > MEANINGFUL_SUBSIDY_GAIN)) {
    return optionWithDelta(finalized, base, { status: "discarded" });
  }
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findConversionGuardrail({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  if (scenario?.rothConversion?.enabled === false || !hasAccountType(assets, "traditional")) return null;
  const firstYear = base?.planFirstYear;
  if (!firstYear || (!Number.isFinite(firstYear.acaMagiCeiling) && scenario?.medicare?.irmaaEnabled === false)) return null;
  const candidate = runCandidate({
    id: "conversion-guardrail",
    kind: "conversionGuardrail",
    label: "Throttle conversions at MAGI cliffs",
    scenario: scenarioWithConversionGuardrails(scenario, {
      maxAcaFplPercent: firstYear.acaMagiCeilingFplPercent ?? 400,
      magiBuffer: DEFAULT_MAGI_BUFFER
    }),
    assets,
    taxProfile,
    runs: solverSearchRuns(runs),
    seed,
    sequences,
    profile,
    metadata: {
      magiBuffer: DEFAULT_MAGI_BUFFER,
      maxAcaFplPercent: firstYear.acaMagiCeilingFplPercent ?? 400
    },
    includeHistorical: false,
    tracker
  });
  const finalized = finalizeCandidate({ candidate, assets, taxProfile, runs, seed, sequences, profile });
  // A bare MAGI drop with no success or subsidy gain just renders a "+0 pts"
  // no-op card; a real MAGI win shows up in the success rate or the subsidy.
  if (!isWorthwhileRescue(finalized, base, profile) && !(firstYearSubsidyGain(finalized, base) > MEANINGFUL_SUBSIDY_GAIN)) {
    return optionWithDelta(finalized, base, { status: "discarded" });
  }
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findMagiSpendTrim({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  if (scenario?.aca?.enabled === false || !(profile.flexibleSpend > 0)) return null;
  const firstYear = base?.planFirstYear;
  if (!firstYear || !Number.isFinite(firstYear.acaMagiCeiling) || !Number.isFinite(firstYear.magi)) return null;
  const targetMagi = Math.max(0, firstYear.acaMagiCeiling - DEFAULT_MAGI_BUFFER);
  const gap = firstYear.magi - targetMagi;
  if (!(gap > 1)) return null;
  const trimAmount = Math.min(profile.flexibleSpend, gap);
  const candidate = runCandidate({
    id: "magi-spend-trim",
    kind: "magiSpendTrim",
    label: "Trim spending enough to protect ACA MAGI",
    scenario: scenarioWithMagiSpendTrim(scenario, profile, trimAmount),
    assets,
    taxProfile,
    runs: solverSearchRuns(runs),
    seed,
    sequences,
    profile,
    metadata: {
      trimAmount: round(trimAmount, 2),
      magiGap: round(gap, 2),
      magiBuffer: DEFAULT_MAGI_BUFFER
    },
    includeHistorical: false,
    tracker
  });
  const finalized = finalizeCandidate({ candidate, assets, taxProfile, runs, seed, sequences, profile });
  if (!isWorthwhileRescue(finalized, base, profile) && !(firstYearSubsidyGain(finalized, base) > MEANINGFUL_SUBSIDY_GAIN)) {
    return optionWithDelta(finalized, base, { status: "discarded" });
  }
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findIrmaaLookbackRescue({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  const firstYear = base?.planFirstYear;
  const age = Number(firstYear?.age ?? scenario?.currentAge);
  if (!Number.isFinite(age) || age < 63 || age >= 65) return null;
  if (scenario?.medicare?.irmaaEnabled === false) return null;
  if (scenario?.rothConversion?.enabled === false && scenario?.taxGainHarvesting?.enabled === false) return null;
  const candidate = runCandidate({
    id: "irmaa-lookback",
    kind: "irmaaLookbackRescue",
    label: "Smooth MAGI before Medicare IRMAA lookback",
    scenario: scenarioWithIrmaaLookbackGuardrails(scenario, { maxIrmaaTier: 0 }),
    assets,
    taxProfile,
    runs: solverSearchRuns(runs),
    seed,
    sequences,
    profile,
    metadata: { maxIrmaaTier: 0 },
    includeHistorical: false,
    tracker
  });
  const finalized = finalizeCandidate({ candidate, assets, taxProfile, runs, seed, sequences, profile });
  // Surface only on a real success gain; a MAGI drop that does not move the
  // success rate is not worth a "+0 pts" card.
  if (!isWorthwhileRescue(finalized, base, profile)) {
    return optionWithDelta(finalized, base, { status: "discarded" });
  }
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

function findSocialSecurityBridge({ assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker }) {
  // Only optimize claiming when there is a real Social Security benefit to
  // optimize: an entered benefit, or the explicit earnings-estimation opt-in.
  // Bridge/earned-income inputs alone (medicareWages etc.) do NOT count —
  // they are not lifetime career earnings and don't imply a SS benefit.
  const estimateFromEarnings = scenario?.estimateSocialSecurityFromEarnings === true;
  const primaryHasSS = Number(scenario?.socialSecurityAnnualBenefit) > 0 || estimateFromEarnings;
  const spousePresent = scenario?.spouseAge !== null && scenario?.spouseAge !== undefined;
  const spouseHasSS = Number(scenario?.spouseSocialSecurityAnnualBenefit) > 0 || (estimateFromEarnings && spousePresent);
  if (!primaryHasSS && !spouseHasSS) return null;

  // Coarse claiming grid (early / mid / FRA / max) keeps the search bounded:
  // 4 ages → 16 couple candidates (was 9×9 = 81) or 4 single candidates.
  const ages = [62, 65, 67, 70];
  const searchRuns = solverSearchRuns(runs);
  const candidatesList = [];

  if (spousePresent) {
    for (const primaryAge of ages) {
      for (const spouseAge of ages) {
        candidatesList.push({ primaryAge, spouseAge });
      }
    }
  } else {
    for (const primaryAge of ages) {
      candidatesList.push({ primaryAge, spouseAge: 67 });
    }
  }

  // Entered benefits are quoted at the household's current start ages; rescale
  // them to each candidate age so the sweep actually changes the benefit amount.
  // (The PIA-from-earnings path scales inside socialSecurityBenefitsForYear, so
  // for it we only set the start ages.)
  const curPrimaryStart = Number(scenario.socialSecurityStartAge ?? 67);
  const curSpouseStart = Number(scenario.spouseSocialSecurityStartAge ?? 67);
  const enteredPrimary = Math.max(0, Number(scenario.socialSecurityAnnualBenefit) || 0);
  const enteredSpouse = Math.max(0, Number(scenario.spouseSocialSecurityAnnualBenefit) || 0);

  const candidates = candidatesList.map(({ primaryAge, spouseAge }) => {
    const candidateScenario = {
      ...scenario,
      socialSecurityStartAge: primaryAge,
      spouseSocialSecurityStartAge: spouseAge,
      ...(enteredPrimary > 0 ? {
        socialSecurityAnnualBenefit: round(enteredPrimary / socialSecurityClaimFactor(curPrimaryStart) * socialSecurityClaimFactor(primaryAge), 2)
      } : {}),
      ...(enteredSpouse > 0 ? {
        spouseSocialSecurityAnnualBenefit: round(enteredSpouse / socialSecurityClaimFactor(curSpouseStart) * socialSecurityClaimFactor(spouseAge), 2)
      } : {})
    };

    return runCandidate({
      id: `social-security-${primaryAge}-${spouseAge}`,
      kind: "socialSecurityBridge",
      label: spousePresent
        ? `Optimize claiming (Primary: ${primaryAge}, Spouse: ${spouseAge})`
        : `Optimize claiming (Age: ${primaryAge})`,
      scenario: candidateScenario,
      assets,
      taxProfile,
      runs: searchRuns,
      seed,
      sequences,
      profile,
      metadata: {
        primaryAge,
        spouseAge,
        socialSecurityStartAge: primaryAge,
        spouseSocialSecurityStartAge: spouseAge
      },
      includeHistorical: false,
      tracker
    });
  });

  if (!candidates.length) return null;

  const winner = [...candidates].sort((a, b) => {
    const rateDiff = b.monteCarlo.successRate - a.monteCarlo.successRate;
    if (Math.abs(rateDiff) > 1e-6) return rateDiff;
    const aVal = a.monteCarlo.medianEndingValue ?? 0;
    const bVal = b.monteCarlo.medianEndingValue ?? 0;
    return bVal - aVal;
  })[0];

  const finalized = finalizeCandidate({
    candidate: winner,
    assets,
    taxProfile,
    runs,
    seed,
    sequences,
    profile
  });

  if (!isWorthwhileRescue(finalized, base, profile)) {
    return optionWithDelta(finalized, base, { status: "discarded" });
  }

  return optionWithDelta(finalized, base, {
    status: meetsTarget(finalized, profile) ? "target-met" : "best-tested"
  });
}

// A rescue is worth surfacing only if the finalized full-run candidate meets
// the target or improves the success rate by at least a visible point.
// A smaller gain is within Monte Carlo noise and renders as a "+0 pts" card.
const WORTHWHILE_RESCUE_GAIN = 0.01;

function isWorthwhileRescue(candidate, base, profile) {
  return meetsTarget(candidate, profile)
    || candidate.monteCarlo.successRate >= base.monteCarlo.successRate + WORTHWHILE_RESCUE_GAIN;
}

function healthcareSortScore(candidate) {
  return candidate.monteCarlo.successRate * 1000 + (candidate.planFirstYear?.acaSubsidy ?? 0) / 1000;
}

// A subsidy-only rescue (no success-rate gain) is worth a card only if it
// preserves a meaningful amount of first-year ACA subsidy. A trivial gain
// just renders as a "+0 pts" no-op card.
const MEANINGFUL_SUBSIDY_GAIN = 250;

function firstYearSubsidyGain(candidate, base) {
  return (candidate?.planFirstYear?.acaSubsidy ?? 0) - (base?.planFirstYear?.acaSubsidy ?? 0);
}

function hasAccountType(assets = [], accountType) {
  return assets.some((asset) => asset?.accountType === accountType && Number(asset.units) * Number(asset.price) > 0);
}

function diagnoseFailure({ base, safeSpending, profile }) {
  const anatomy = base?.failureAnatomy ?? {};
  const failedCount = anatomy.failedCount ?? 0;
  const firstYear = base?.planFirstYear;
  const magiCeiling = Number(firstYear?.acaMagiCeiling);
  const magi = Number(firstYear?.magi);
  const magiBuffer = Number.isFinite(magiCeiling) && Number.isFinite(magi) ? magiCeiling - magi : null;
  // Sitting at the ceiling is the intended optimized state; only a genuine
  // breach (modeled MAGI above the ceiling) points to a subsidy-cliff failure.
  const overCliff = magiBuffer != null && magiBuffer < -1;
  const requiredUnsustainable = safeSpending?.requiredUnsustainable === true;

  let primary = "none";
  let label = "No failures in tested paths";
  let reason = "The base plan met the target in the tested evidence.";
  let recommendedKinds = [];

  if (failedCount > 0 && overCliff) {
    primary = "healthcareCliff";
    label = "Healthcare subsidy cliff";
    reason = "Modeled MAGI is above the subsidy ceiling, so losing the healthcare subsidy is the likely failure driver.";
    recommendedKinds = ["rothBasisCliffRescue", "conversionGuardrail", "healthcareRescue", "magiSpendTrim", "taxableLotRescue", "withdrawalShift", "guytonKlingerRescue", "vpwRescue", "discretionaryCut"];
  } else if (failedCount > 0 && anatomy.commonTrigger === "Early sequence risk") {
    primary = "earlySequenceRisk";
    label = "Early sequence risk";
    reason = "Failures cluster in the first ten years, so an early bad-market sequence is the likely failure driver.";
    recommendedKinds = ["sequenceReserve", "allocationShift", "guytonKlingerRescue", "vpwRescue", "discretionaryCut", "socialSecurityBridge"];
  } else if (failedCount > 0) {
    primary = "longHorizonDepletion";
    label = "Long-horizon depletion";
    reason = "Failures cluster later in the plan, so structural overspend or portfolio drag is the likely failure driver.";
    recommendedKinds = ["guytonKlingerRescue", "vpwRescue", "discretionaryCut", "allocationShift", "withdrawalShift", "socialSecurityBridge", "irmaaLookbackRescue"];
  }

  if (requiredUnsustainable) {
    // Respect a household that has opted out of bridge income — do not keep
    // recommending a return to work they have already ruled out.
    if (profile?.incomeBridge?.enabled === false) {
      reason += " Required spending alone is not sustainable, so the required-spending floor itself has to come down.";
    } else {
      reason += " Required spending alone is not sustainable, so an income bridge may be necessary.";
      recommendedKinds = ["incomeBridge", ...recommendedKinds.filter((kind) => kind !== "incomeBridge")];
    }
  }

  const stressPriorities = stressorRecommendedKinds(anatomy.topStressors);
  if (stressPriorities.length) {
    recommendedKinds = [
      ...stressPriorities,
      ...recommendedKinds.filter((kind) => !stressPriorities.includes(kind))
    ];
    const top = anatomy.topStressors[0];
    reason += ` The failed paths also show ${top.label.toLowerCase()} in ${round(top.percentage * 100, 1)}% of failures.`;
  }

  return {
    primary,
    label,
    reason,
    recommendedKinds,
    magiBuffer: magiBuffer != null ? round(magiBuffer, 2) : null,
    warningSigns: anatomy.warningSigns ?? [],
    portfolioPivots: anatomy.portfolioPivots ?? [],
    causesBreakdown: anatomy.causesBreakdown ?? {},
    summaryText: anatomy.summaryText ?? ""
  };
}

function stressorRecommendedKinds(stressors = []) {
  const ranked = [];
  for (const stressor of stressors) {
    for (const kind of FAILURE_STRESSOR_MAP[stressor.id]?.recommendedKinds ?? []) {
      if (!ranked.includes(kind)) ranked.push(kind);
    }
  }
  return ranked;
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
    monteCarlo: runMonteCarlo({
      assets,
      scenario,
      taxProfile,
      runs,
      seed,
      scenarioTimelineLimit: SUMMARY_ONLY_MONTE_CARLO_TIMELINES
    }),
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
      age: round(planFirstYear.age ?? 0, 2),
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
      rothConversionAmount: round(planFirstYear.rothConversionAmount ?? 0, 2),
      rothBasisUsed: round(planFirstYear.rothBasisUsed ?? 0, 2),
      rothBasisAvailable: round(planFirstYear.rothBasisAvailable ?? planFirstYear.rothBasisRemaining ?? 0, 2),
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

function comparisonOption(option, base, extra = {}) {
  const withDelta = optionWithDelta(option, base, extra);
  return {
    id: withDelta.id,
    sequence: withDelta.sequence,
    kind: withDelta.kind,
    label: withDelta.label,
    status: withDelta.status,
    metadata: withDelta.metadata,
    scenario: withDelta.scenario,
    scenarioSummary: withDelta.scenarioSummary,
    verdict: withDelta.verdict,
    monteCarlo: withDelta.monteCarlo,
    historical: withDelta.historical,
    planFirstYear: withDelta.planFirstYear,
    delta: withDelta.delta
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

function rescueSortScore(candidate, profile, diagnosis) {
  const targetBonus = meetsTarget(candidate, profile) ? 1_000_000 : 0;
  const diagnosisBonus = diagnosisMatchRank(candidate, diagnosis) * 10_000;
  const lifestylePenalty = lifestyleCost(candidate) * 2_000;
  const combined = candidate?.verdict?.combinedSuccessRate ?? 0;
  return targetBonus + diagnosisBonus - lifestylePenalty + combined * 1000;
}

// Lifestyle cost ranks how much a rescue asks the household to change its life:
// 0 = mechanical (no lifestyle change), 1 = spend less, 2 = earn income.
function lifestyleCost(candidate) {
  switch (candidate?.kind) {
    case "incomeBridge":
    case "combined":
      return 2;
    case "discretionaryCut":
    case "magiSpendTrim":
      return 1;
    default:
      return 0;
  }
}

function diagnosisMatchRank(candidate, diagnosis) {
  const kinds = Array.isArray(diagnosis?.recommendedKinds) ? diagnosis.recommendedKinds : [];
  const index = kinds.indexOf(candidate?.kind);
  return index < 0 ? 0 : kinds.length - index;
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

const DIAGNOSTIC_MAP = {
  highInflation: {
    label: "High Inflation Drag",
    description: "A high-inflation environment (average annual inflation exceeding 4% in the first decade) eroded the purchasing power of the portfolio. To maintain the same real spending standard, nominal withdrawals had to scale up rapidly, accelerating depletion.",
    warningSigns: [
      {
        metricTrigger: "CPI-U annualized inflation rate persistently above 3.5% for >12 consecutive months.",
        title: "Macroeconomic Inflation Spike",
        description: "Watch for sustained high inflation prints that force nominal budget increases."
      },
      {
        metricTrigger: "Nominal spending requirements increase by >10% over any 2-year period.",
        title: "Cost of Living Acceleration",
        description: "Keep a close eye on your household cost of living scaling faster than historic norms."
      }
    ],
    portfolioPivots: [
      {
        title: "Reallocate to Inflation Hedges",
        description: "Shift a portion of the fixed-income portfolio into inflation-protected assets such as Treasury Inflation-Protected Securities (TIPS), I-Bonds, or real estate investment trusts (REITs)."
      },
      {
        title: "Spending Adjustments (Caps)",
        description: "Temporarily cap the annual inflation adjustment of your spending at 2% or 3% rather than matching the full CPI-U print during high-inflation spikes."
      }
    ]
  },
  consecutiveDownYears: {
    label: "Consecutive Down Markets",
    description: "The portfolio was depleted due to a prolonged, consecutive multi-year decline in asset values (e.g. 3+ consecutive years of negative stock returns). This prevents the portfolio from recovering because withdrawals are made from a shrinking asset base.",
    warningSigns: [
      {
        metricTrigger: "Two consecutive years of negative equity index returns.",
        title: "Prolonged Equity Downturn",
        description: "Monitor index benchmarks; consecutive down years indicate sustained market stress."
      },
      {
        metricTrigger: "Portfolio value declines by >15% from its peak while in active decumulation.",
        title: "Peak-to-Trough Portfolio Drop",
        description: "Track your maximum portfolio drawdown from its starting retirement balance."
      }
    ],
    portfolioPivots: [
      {
        title: "Dynamic Spending Cut (Guardrails)",
        description: "Immediately reduce discretionary spending by 10% to 20% to reduce the withdrawal drag on the declining portfolio."
      },
      {
        title: "Sequence Buffer Activation",
        description: "Temporarily halt withdrawals from equities. Fund lifestyle needs entirely using defensive assets (short-term bonds, cash, or a dedicated sequence reserve) to avoid selling equities at a loss."
      }
    ]
  },
  earlySequenceRisk: {
    label: "Early Sequence of Returns Risk",
    description: "Poor stock market returns or concentrated down years occurred in the critical first decade of retirement. When large withdrawals are made during an early market downturn, the compounding power of the remaining portfolio is permanently damaged (Sequence of Returns Risk).",
    warningSigns: [
      {
        metricTrigger: "Cumulative equity return is negative over the first 3 to 5 years of the retirement plan.",
        title: "Initial Decade Equity Decline",
        description: "A negative total return early in your plan poses a severe sequence risk threat."
      },
      {
        metricTrigger: "Actual withdrawal rate (annual spending / current portfolio value) rises above 5.5% in the first 5 years.",
        title: "Elevated Early Withdrawal Rate",
        description: "A rising withdrawal rate caused by declining asset values is a key leading indicator of failure."
      }
    ],
    portfolioPivots: [
      {
        title: "Establish a Sequence Buffer",
        description: "If not already present, carve out a 2-to-3-year spending reserve in ultra-low-volatility assets (cash, high-yield savings) to insulate the portfolio from short-term market swings."
      },
      {
        title: "Equity Glidepath (Rising Equity Allocation)",
        description: "Start with a slightly more conservative allocation (e.g., 50% equities) and gradually increase the equity exposure by 1% per year back to 60-70% over the first decade to mitigate the impact of an early crash."
      },
      {
        title: "Delay Social Security Claiming",
        description: "Delay claiming Social Security benefits to age 70. This increases the guaranteed, inflation-adjusted lifetime income floor by 8% per year of delay, permanently reducing the future withdrawal pressure."
      }
    ]
  },
  earlySequenceRiskWithInflation: {
    label: "Early Market Stress & High Inflation",
    description: "The most challenging combination: a severe equity market downturn in the first 5-10 years combined with high inflation. The portfolio suffered from both declining asset values and the pressure of rapidly escalating nominal spending needs.",
    warningSigns: [
      {
        metricTrigger: "Simultaneous occurrence of negative annual equity returns and CPI-U inflation >4%.",
        title: "Stagflationary Retirement Launch",
        description: "High inflation combined with falling markets is the ultimate test of portfolio durability."
      },
      {
        metricTrigger: "Portfolio value declines by >20% while nominal withdrawals increase by >5% in a single year.",
        title: "Rapid Scissors Effect",
        description: "Watch for the widening gap where your assets shrink but your nominal cash needs expand."
      }
    ],
    portfolioPivots: [
      {
        title: "Execute Severe Spending Cuts",
        description: "Enact a substantial 15-20% discretionary spending reduction and transition to a sequence buffer to avoid selling depressed equities."
      },
      {
        title: "Temporary Part-Time Income Bridge",
        description: "Consider a temporary part-time income bridge (earning a small amount of active income) to cover inflation-bloated expenses and avoid withdrawals during market lows."
      }
    ]
  },
  standardDrawdown: {
    label: "Standard Drawdown / Structural Overspending",
    description: "The portfolio was depleted over a long horizon. This is typically driven by a structural overspend—where the target spending rate is permanently set too high relative to the portfolio size—or long-term investment drag.",
    warningSigns: [
      {
        metricTrigger: "Long-term average withdrawal rate exceeds 4.5% over any 10-year period.",
        title: "Unsustainable Withdrawal Rate Floor",
        description: "A sustained baseline withdrawal rate above 4% creates immense drag in a standard drawdown scenario."
      },
      {
        metricTrigger: "Portfolio growth fails to outpace the combined drag of spending and taxes over a rolling 7-year window.",
        title: "Stagnant Long-term Balance Growth",
        description: "Track your long-term compound growth; it must exceed your withdrawal rate plus tax drag."
      }
    ],
    portfolioPivots: [
      {
        title: "Permanent Spending Calibration",
        description: "Re-evaluate and permanently lower the base spending target. Shifting the spending target down by 0.5% to 1.0% can add a decade or more to portfolio longevity."
      },
      {
        title: "Asset Rebalancing and Low Fees",
        description: "Ensure the portfolio is optimally diversified across global equities and fixed income, and minimize expense ratios and tax drag."
      }
    ]
  }
};

const FAILURE_STRESSOR_MAP = Object.freeze({
  taxDrag: {
    label: "Tax drag",
    description: "Taxes consume a large share of the failed path's required cash flow.",
    recommendedKinds: ["withdrawalShift", "conversionGuardrail", "taxableLotRescue", "irmaaLookbackRescue"]
  },
  healthcareDrag: {
    label: "Healthcare drag",
    description: "Medical premiums, OOP costs, or subsidy loss consume a large share of required cash flow.",
    recommendedKinds: ["healthcareRescue", "rothBasisCliffRescue", "magiSpendTrim", "conversionGuardrail"]
  },
  spendingPressure: {
    label: "Spending pressure",
    description: "Required cash flow is high relative to the portfolio during failed paths.",
    recommendedKinds: ["guytonKlingerRescue", "vpwRescue", "discretionaryCut", "incomeBridge", "socialSecurityBridge"]
  },
  reserveShortfall: {
    label: "Reserve shortfall",
    description: "Down-market years lack enough defensive assets to avoid selling volatile assets under stress.",
    recommendedKinds: ["sequenceReserve", "allocationShift", "guytonKlingerRescue", "vpwRescue", "discretionaryCut"]
  },
  allocationMismatch: {
    label: "Allocation mismatch",
    description: "The risk-asset mix is poorly matched to the path: too exposed during early stress or too defensive for long-horizon growth.",
    recommendedKinds: ["allocationShift", "sequenceReserve"]
  }
});

function buildSensitivityAnalysis({
  assets,
  scenario,
  taxProfile,
  runs,
  seed,
  sequences,
  profile,
  base
} = {}) {
  if (!base) return { top: [], all: [] };
  const sensitivityRuns = solverSearchRuns(runs);
  const variants = sensitivityVariants({ assets, scenario, profile });
  const baseCombined = Number.isFinite(base?.verdict?.combinedSuccessRate)
    ? base.verdict.combinedSuccessRate
    : base?.monteCarlo?.successRate ?? 0;
  const baseMonteCarlo = Number.isFinite(base?.monteCarlo?.successRate) ? base.monteCarlo.successRate : null;
  const baseHistorical = Number.isFinite(base?.historical?.successRate) ? base.historical.successRate : null;
  const baseVerdict = base?.verdict?.label ?? "unknown";
  const baseVerdictRank = verdictRank(baseVerdict);

  const all = variants.map((variant) => {
    const candidate = runCandidate({
      id: `sensitivity-${variant.id}`,
      kind: "sensitivity",
      label: variant.label,
      scenario: variant.scenario,
      assets,
      taxProfile,
      runs: sensitivityRuns,
      seed,
      sequences,
      profile,
      metadata: { shockId: variant.id },
      includeHistorical: true
    });
    const combined = Number.isFinite(candidate?.verdict?.combinedSuccessRate)
      ? candidate.verdict.combinedSuccessRate
      : candidate?.monteCarlo?.successRate ?? 0;
    const monteCarlo = Number.isFinite(candidate?.monteCarlo?.successRate) ? candidate.monteCarlo.successRate : null;
    const historical = Number.isFinite(candidate?.historical?.successRate) ? candidate.historical.successRate : null;
    const stressedVerdict = candidate?.verdict?.label ?? "unknown";
    const verdictDelta = verdictRank(stressedVerdict) - baseVerdictRank;
    const combinedDelta = round(combined - baseCombined, 4);
    const monteCarloDelta = Number.isFinite(monteCarlo) && Number.isFinite(baseMonteCarlo)
      ? round(monteCarlo - baseMonteCarlo, 4)
      : null;
    const historicalDelta = Number.isFinite(historical) && Number.isFinite(baseHistorical)
      ? round(historical - baseHistorical, 4)
      : null;
    const impactScore = round(
      Math.abs(combinedDelta)
        + Math.abs(verdictDelta)
        + (Number.isFinite(monteCarloDelta) ? Math.abs(monteCarloDelta) * 0.25 : 0)
        + (Number.isFinite(historicalDelta) ? Math.abs(historicalDelta) * 0.25 : 0),
      4
    );
    return {
      id: variant.id,
      label: variant.label,
      question: variant.question,
      change: variant.change,
      controlHint: variant.controlHint,
      base: {
        verdict: baseVerdict,
        combinedSuccessRate: round(baseCombined, 4),
        monteCarloSuccessRate: baseMonteCarlo,
        historicalSuccessRate: baseHistorical
      },
      stressed: {
        verdict: stressedVerdict,
        combinedSuccessRate: round(combined, 4),
        monteCarloSuccessRate: monteCarlo,
        historicalSuccessRate: historical
      },
      delta: {
        combinedSuccessRate: combinedDelta,
        monteCarloSuccessRate: monteCarloDelta,
        historicalSuccessRate: historicalDelta
      },
      verdictMoved: stressedVerdict !== baseVerdict,
      direction: combinedDelta < -EPSILON ? "worse" : combinedDelta > EPSILON ? "better" : "flat",
      impactScore
    };
  }).sort((a, b) => b.impactScore - a.impactScore || Math.abs(b.delta.combinedSuccessRate) - Math.abs(a.delta.combinedSuccessRate));

  const breakpoints = findHouseholdBreakpoints({
    assets,
    scenario,
    taxProfile,
    runs,
    seed,
    sequences,
    profile,
    base
  });

  return {
    runs: sensitivityRuns,
    top: all.slice(0, SENSITIVITY_TOP_COUNT).map((item, index) => ({ ...item, rank: index + 1 })),
    all,
    breakpoints
  };
}

export function findHouseholdBreakpoints({
  assets,
  scenario,
  taxProfile,
  runs,
  seed,
  sequences,
  profile,
  base
}) {
  if (!base) return null;
  const sensitivityRuns = Math.min(250, solverSearchRuns(runs));
  const targetSuccessRate = profile.targetSuccessRate ?? 0.90;
  const growthClasses = sensitivityReturnClasses(assets, scenario);

  // Breakpoints are Monte-Carlo-based for speed (no historical backtest per
  // probe) and compared against the base plan's MC success rate, so the
  // comparison is like-for-like. If the base plan is already below target there
  // is no "breakpoint" to find — report that explicitly rather than returning a
  // degenerate 0pp / +0% threshold.
  const baseMcRate = Number.isFinite(base?.monteCarlo?.successRate) ? base.monteCarlo.successRate : 0;
  if (baseMcRate < targetSuccessRate) {
    return {
      alreadyBelowTarget: true,
      returnBreakpoint: null,
      spendingBreakpoint: null,
      spendingBreakpointApplicable: scenario?.spendingStrategy?.mode !== "vpw",
      inflationBreakpoint: null,
      targetSuccessRate
    };
  }

  // Probe whether a stressed scenario drops MC success below target.
  const probeFails = (label, builder, t) => {
    const cand = runCandidate({
      id: `breakpoint-${label}-${t}`,
      kind: "sensitivity",
      scenario: builder(t),
      assets,
      taxProfile,
      runs: sensitivityRuns,
      seed,
      sequences,
      profile,
      includeHistorical: false
    });
    const mc = Number.isFinite(cand?.monteCarlo?.successRate) ? cand.monteCarlo.successRate : 0;
    return mc < targetSuccessRate;
  };

  // Smallest stress magnitude t in [0, hi] at which the plan fails, via
  // bisection over a monotonic predicate (more stress → lower success). Returns
  // null if the plan still passes at the maximum stress. ~log2(hi/tol) probes
  // instead of a full linear scan, and no floating-point step accumulation.
  const smallestFailing = (label, builder, hi, tol) => {
    if (!probeFails(label, builder, hi)) return null; // survives max stress
    if (probeFails(label, builder, 0)) return 0;      // fails with no stress (noise vs base)
    let lo = 0;
    let high = hi;
    while (high - lo > tol) {
      const mid = (lo + high) / 2;
      if (probeFails(label, builder, mid)) high = mid; else lo = mid;
    }
    return high;
  };

  // 1. Expected-return drop (report as a negative shift).
  const returnDrop = smallestFailing(
    "return",
    (drop) => scenarioWithReturnMeanShift(scenario, growthClasses, -drop),
    0.03,
    0.0025
  );

  // 2. Spending increase. VPW sizes spending from the portfolio, so scaling
  //    target/essential/discretionary spend is inert — the breakpoint is not
  //    applicable for a VPW base plan.
  const spendingApplicable = scenario?.spendingStrategy?.mode !== "vpw";
  const spendingExtra = spendingApplicable
    ? smallestFailing(
      "spend",
      (extra) => ({
        ...scenario,
        targetSpend: (scenario.targetSpend ?? 0) * (1 + extra),
        spendingStrategy: scenario.spendingStrategy ? {
          ...scenario.spendingStrategy,
          essentialSpend: (scenario.spendingStrategy.essentialSpend ?? 0) * (1 + extra),
          discretionarySpend: (scenario.spendingStrategy.discretionarySpend ?? 0) * (1 + extra)
        } : undefined
      }),
      0.30,
      0.025
    )
    : null;

  // 3. Inflation increase (shifts both general and medical streams together).
  const inflationShift = smallestFailing(
    "inflation",
    (shift) => ({
      ...scenario,
      returnAssumptions: {
        ...scenario.returnAssumptions,
        inflation: scenario.returnAssumptions?.inflation ? {
          ...scenario.returnAssumptions.inflation,
          mean: (scenario.returnAssumptions.inflation.mean ?? 0) + shift
        } : undefined,
        medicalInflation: scenario.returnAssumptions?.medicalInflation ? {
          ...scenario.returnAssumptions.medicalInflation,
          mean: (scenario.returnAssumptions.medicalInflation.mean ?? 0) + shift
        } : undefined
      }
    }),
    0.03,
    0.0025
  );

  return {
    alreadyBelowTarget: false,
    returnBreakpoint: returnDrop !== null ? round(-returnDrop, 4) : null,
    spendingBreakpoint: spendingExtra !== null ? round(1 + spendingExtra, 4) : null,
    spendingBreakpointApplicable: spendingApplicable,
    inflationBreakpoint: inflationShift !== null ? round(inflationShift, 4) : null,
    targetSuccessRate
  };
}

function sensitivityVariants({ assets = [], scenario = {}, profile = {} } = {}) {
  const growthClasses = sensitivityReturnClasses(assets, scenario);
  return [
    {
      id: "portfolio-return-1pp-lower",
      label: "Portfolio returns 1pp lower",
      question: "What if expected returns are one percentage point lower?",
      change: `${growthClasses.join(", ")} expected returns -1.0 percentage point.`,
      controlHint: "Return assumptions module",
      scenario: scenarioWithReturnMeanShift(scenario, growthClasses, -0.01)
    },
    {
      id: "inflation-1pp-higher",
      label: "Inflation 1pp higher",
      question: "What if inflation runs one percentage point higher?",
      change: "General inflation mean +1.0 percentage point.",
      controlHint: "Return assumptions module -> inflation",
      scenario: scenarioWithInflationMeanShift(scenario, 0.01)
    },
    {
      id: "spending-5pct-higher",
      label: "Spending 5% higher",
      question: "What if the household spends 5% more?",
      change: "Target, essential, and discretionary spending +5%.",
      controlHint: "Basics / Spending strategy module",
      scenario: scenarioWithSpendingScale(scenario, profile, 1.05)
    },
    {
      id: "healthcare-10pct-higher",
      label: "Healthcare costs 10% higher",
      question: "What if health costs and ACA premiums are 10% higher?",
      change: "Medical base, ACA premiums, OOP maximums, and Part D premium +10%.",
      controlHint: "Healthcare module",
      scenario: scenarioWithHealthcareScale(scenario, 1.1)
    }
  ];
}

function sensitivityReturnClasses(assets = [], scenario = {}) {
  const fromAssets = [...new Set((assets ?? [])
    .map((asset) => asset?.assetClass)
    .filter((assetClass) => assetClass && !["cash", "inflation"].includes(assetClass)))];
  if (fromAssets.length) return fromAssets;
  const assumptions = scenario?.returnAssumptions ?? DEFAULT_SCENARIO.returnAssumptions ?? {};
  const fromAssumptions = Object.keys(assumptions)
    .filter((assetClass) => !["cash", "inflation"].includes(assetClass));
  return fromAssumptions.length ? fromAssumptions : ["stock", "bond"];
}

function scenarioWithReturnMeanShift(scenario = {}, assetClasses = [], meanDelta = 0) {
  const assumptions = {
    ...DEFAULT_SCENARIO.returnAssumptions,
    ...(plainObject(scenario.returnAssumptions) ? scenario.returnAssumptions : {})
  };
  for (const assetClass of assetClasses) {
    const current = plainObject(assumptions[assetClass])
      ? assumptions[assetClass]
      : DEFAULT_SCENARIO.returnAssumptions?.[assetClass] ?? { mean: 0, stdev: 0 };
    assumptions[assetClass] = {
      ...current,
      mean: round((Number(current.mean) || 0) + meanDelta, 6)
    };
  }
  return { ...scenario, returnAssumptions: assumptions };
}

function scenarioWithInflationMeanShift(scenario = {}, meanDelta = 0) {
  const assumptions = {
    ...DEFAULT_SCENARIO.returnAssumptions,
    ...(plainObject(scenario.returnAssumptions) ? scenario.returnAssumptions : {})
  };
  const current = plainObject(assumptions.inflation)
    ? assumptions.inflation
    : DEFAULT_SCENARIO.returnAssumptions?.inflation ?? { mean: 0, stdev: 0 };
  return {
    ...scenario,
    returnAssumptions: {
      ...assumptions,
      inflation: {
        ...current,
        mean: round((Number(current.mean) || 0) + meanDelta, 6)
      }
    }
  };
}

function scenarioWithSpendingScale(scenario = {}, profile = {}, factor = 1) {
  const normalized = normalizeDecisionProfile(profile, scenario);
  const targetSpend = Number.isFinite(Number(scenario.targetSpend))
    ? Number(scenario.targetSpend)
    : normalized.targetSpend;
  const existing = plainObject(scenario.spendingStrategy) ? scenario.spendingStrategy : {};
  const nextStrategy = { ...existing };
  if (Number.isFinite(Number(existing.essentialSpend))) {
    nextStrategy.essentialSpend = round(Number(existing.essentialSpend) * factor, 2);
  }
  if (Number.isFinite(Number(existing.discretionarySpend))) {
    nextStrategy.discretionarySpend = round(Number(existing.discretionarySpend) * factor, 2);
  }
  return {
    ...scenario,
    targetSpend: round(Math.max(0, targetSpend) * factor, 2),
    spendingStrategy: nextStrategy
  };
}

function scenarioWithHealthcareScale(scenario = {}, factor = 1) {
  const aca = plainObject(scenario.aca) ? scenario.aca : {};
  const backup = plainObject(aca.backupPlan) ? aca.backupPlan : null;
  return {
    ...scenario,
    medicalExpensesBase: scaleFinite(scenario.medicalExpensesBase, factor),
    medicare: plainObject(scenario.medicare)
      ? {
          ...scenario.medicare,
          partDMonthlyPremium: scaleFinite(scenario.medicare.partDMonthlyPremium, factor)
        }
      : scenario.medicare,
    aca: plainObject(scenario.aca)
      ? {
          ...aca,
          benchmarkPremium: scaleFinite(aca.benchmarkPremium, factor),
          selectedPlanPremium: scaleFinite(aca.selectedPlanPremium, factor),
          planPremium: scaleFinite(aca.planPremium, factor),
          oopMaximum: scaleFinite(aca.oopMaximum, factor),
          backupPlan: backup ? {
            ...backup,
            benchmarkPremium: scaleFinite(backup.benchmarkPremium, factor),
            selectedPlanPremium: scaleFinite(backup.selectedPlanPremium, factor),
            planPremium: scaleFinite(backup.planPremium, factor),
            oopMaximum: scaleFinite(backup.oopMaximum, factor)
          } : aca.backupPlan
        }
      : scenario.aca
  };
}

function scaleFinite(value, factor) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round(Math.max(0, numeric) * factor, 2) : value;
}

function verdictRank(label) {
  if (label === "safe") return 2;
  if (label === "fragile") return 1;
  if (label === "unsafe") return 0;
  return -1;
}

function failureAnatomy(scenarios = []) {
  const failed = scenarios.filter((item) => item && item.success === false);
  if (!failed.length) {
    return {
      failedCount: 0,
      earliestFailureYear: null,
      medianFailureYear: null,
      commonTrigger: "No failures in tested paths",
      causesBreakdown: {},
      stressBreakdown: {},
      topStressors: [],
      warningSigns: [],
      portfolioPivots: [],
      summaryText: "No failures detected in tested paths."
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

  const counts = {
    highInflation: 0,
    earlySequenceRisk: 0,
    consecutiveDownYears: 0,
    earlySequenceRiskWithInflation: 0,
    standardDrawdown: 0
  };
  const stressCounts = Object.fromEntries(Object.keys(FAILURE_STRESSOR_MAP).map((key) => [
    key,
    { count: 0, valueTotal: 0 }
  ]));

  for (const item of failed) {
    const diag = item.diagnostics;
    let cause = "standardDrawdown";
    if (diag) {
      const factors = [];
      if (diag.avgInflationFirstDecade >= 0.04) {
        factors.push("highInflation");
      }
      if (diag.maxConsecutiveDownYears >= 3) {
        factors.push("consecutiveDownYears");
      }
      if (diag.earlyDownYearsCount >= 5 || diag.avgStockReturnFirstDecade < 0.01) {
        factors.push("earlySequenceRisk");
      }

      if (factors.length > 0) {
        if (factors.includes("earlySequenceRisk") && factors.includes("highInflation")) {
          cause = "earlySequenceRiskWithInflation";
        } else if (factors.includes("consecutiveDownYears")) {
          cause = "consecutiveDownYears";
        } else if (factors.includes("earlySequenceRisk")) {
          cause = "earlySequenceRisk";
        } else if (factors.includes("highInflation")) {
          cause = "highInflation";
        } else {
          cause = factors[0];
        }
      }
      for (const stressor of diag.stressors ?? []) {
        if (!stressCounts[stressor.id]) continue;
        stressCounts[stressor.id].count += 1;
        stressCounts[stressor.id].valueTotal += Number.isFinite(Number(stressor.value)) ? Number(stressor.value) : 0;
      }
    }
    counts[cause]++;
  }

  const causesBreakdown = {};
  for (const [key, count] of Object.entries(counts)) {
    causesBreakdown[key] = {
      count,
      percentage: failed.length > 0 ? round(count / failed.length, 4) : 0
    };
  }
  const stressBreakdown = Object.fromEntries(Object.entries(stressCounts).map(([key, info]) => [
    key,
    {
      count: info.count,
      percentage: failed.length > 0 ? round(info.count / failed.length, 4) : 0,
      averageValue: info.count > 0 ? round(info.valueTotal / info.count, 4) : 0,
      label: FAILURE_STRESSOR_MAP[key].label,
      description: FAILURE_STRESSOR_MAP[key].description
    }
  ]));
  const topStressors = Object.entries(stressBreakdown)
    .filter(([, info]) => info.count > 0)
    .sort((a, b) => b[1].percentage - a[1].percentage || b[1].averageValue - a[1].averageValue)
    .slice(0, 3)
    .map(([id, info]) => ({
      id,
      label: info.label,
      description: info.description,
      count: info.count,
      percentage: info.percentage,
      averageValue: info.averageValue
    }));

  // Generate dynamic warning signs and portfolio pivots
  // Include any cause that affected >= 15% of failures, sorted by percentage descending
  const activeCauses = Object.entries(causesBreakdown)
    .filter(([key, info]) => info.percentage >= 0.15 && key !== "standardDrawdown")
    .sort((a, b) => b[1].percentage - a[1].percentage);

  if (activeCauses.length === 0) {
    const topCause = Object.entries(causesBreakdown)
      .sort((a, b) => b[1].percentage - a[1].percentage)[0]?.[0];
    if (topCause && topCause !== "standardDrawdown") {
      activeCauses.push([topCause, causesBreakdown[topCause]]);
    }
  }

  const warningSigns = [];
  const portfolioPivots = [];
  const summaryParts = [];

  for (const [cause, info] of activeCauses) {
    const data = DIAGNOSTIC_MAP[cause];
    if (!data) continue;
    const pctStr = `${round(info.percentage * 100, 1)}%`;

    for (const sign of data.warningSigns) {
      warningSigns.push({
        ...sign,
        riskPercentage: info.percentage,
        context: `Triggered in ${pctStr} of failure scenarios (Primary Cause: ${data.label})`
      });
    }

    for (const pivot of data.portfolioPivots) {
      portfolioPivots.push({
        ...pivot,
        riskPercentage: info.percentage,
        context: `Addresses risk associated with ${data.label} (${pctStr} of failures)`
      });
    }

    summaryParts.push(`${data.label} (${pctStr} of failures)`);
  }

  // Include standardDrawdown if it had high percentage or no other drivers triggered
  if (causesBreakdown.standardDrawdown.percentage > 0.15 || summaryParts.length === 0) {
    const info = causesBreakdown.standardDrawdown;
    const pctStr = `${round(info.percentage * 100, 1)}%`;
    const data = DIAGNOSTIC_MAP.standardDrawdown;
    if (data) {
      for (const sign of data.warningSigns) {
        warningSigns.push({
          ...sign,
          riskPercentage: info.percentage,
          context: `Triggered in ${pctStr} of failure scenarios (Primary Cause: ${data.label})`
        });
      }
      for (const pivot of data.portfolioPivots) {
        portfolioPivots.push({
          ...pivot,
          riskPercentage: info.percentage,
          context: `Addresses risk associated with ${data.label} (${pctStr} of failures)`
        });
      }
      summaryParts.push(`${data.label} (${pctStr} of failures)`);
    }
  }

  const stressText = topStressors.length
    ? ` Top stressors across failed paths: ${topStressors.map((item) => `${item.label} (${round(item.percentage * 100, 1)}%)`).join(", ")}.`
    : "";
  const summaryText = `Analysis of the ${failed.length} failed scenarios indicates that the primary drivers of depletion are: ${summaryParts.join(", ")}.${stressText}`;

  return {
    failedCount: failed.length,
    earliestFailureYear: failureYears.length ? failureYears[0] + 1 : null,
    medianFailureYear: failureYears.length ? percentile(failureYears, 0.5) + 1 : null,
    commonTrigger: trigger,
    causesBreakdown,
    stressBreakdown,
    topStressors,
    warningSigns,
    portfolioPivots,
    summaryText
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

function progressTracker({ onProgress, base, candidates = [] } = {}) {
  if (!base) return null;
  let done = 0;
  return (candidate) => {
    done += 1;
    const comparison = comparisonOption(candidate, base, {
      sequence: done,
      status: candidate.status ?? "tested"
    });
    candidates.push(comparison);
    if (typeof onProgress === "function") {
      onProgress({
        done,
        candidateId: candidate.id,
        candidateKind: candidate.kind,
        label: candidate.label,
        candidate: comparison
      });
    }
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

function ensureWithdrawalOrderIncludes(order = [], accountType) {
  const normalized = Array.isArray(order) && order.length ? [...order] : ["taxable", "traditional", "hsa", "roth"];
  return normalized.includes(accountType) ? normalized : [...normalized, accountType];
}

function socialSecurityClaimFactor(age, fullRetirementAge = 67) {
  const months = Math.round((Number(age) - fullRetirementAge) * 12);
  if (!Number.isFinite(months) || months === 0) return 1;
  if (months > 0) return 1 + Math.min(months, 36) * (2 / 3 / 100);
  const earlyMonths = Math.abs(months);
  const firstReduction = Math.min(36, earlyMonths) * (5 / 9 / 100);
  const additionalReduction = Math.max(0, earlyMonths - 36) * (5 / 12 / 100);
  return Math.max(0, 1 - firstReduction - additionalReduction);
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

export function buildTradeoffFrontier({ assets, scenario, taxProfile, runs, seed, sequences, profile, tracker }) {
  const activeProfile = profile ?? normalizeDecisionProfile({}, scenario);
  const searchRuns = solverSearchRuns(runs);
  
  // 1. Max Spending Plan: target spend + 20%
  const maxSpendingScenario = {
    ...scenario,
    targetSpend: round((scenario.targetSpend ?? 90000) * 1.20, 2)
  };
  
  // 2. Base plan reference point (current settings, unchanged) — the frontier's
  //    anchor for comparing the spending / healthcare / bequest alternatives
  //    against. It is not a distinct "maximize resilience" lever.
  const baseReferenceScenario = {
    ...scenario
  };
  
  // 3. Max Healthcare Plan: limit conversions to keep MAGI <= 150% FPL
  const maxHealthcareScenario = {
    ...scenario,
    rothConversion: {
      ...(scenario.rothConversion ?? {}),
      enabled: true,
      maxAcaFplPercent: 150,
      applyMagiGuardrails: true
    }
  };
  
  // 4. Max Bequest Plan: Minimize discretionary spending (essential only)
  const essentialOnlySpend = scenario.spendingStrategy?.essentialSpend ?? (scenario.targetSpend ?? 90000) * 0.7;
  const maxBequestScenario = {
    ...scenario,
    targetSpend: essentialOnlySpend,
    spendingStrategy: {
      ...(scenario.spendingStrategy ?? {}),
      discretionarySpend: 0
    }
  };
  
  const plans = [
    { id: "max-spending", label: "Max Spending (+20% Spend)", scenario: maxSpendingScenario },
    { id: "base-reference", label: "Base Plan (current settings)", scenario: baseReferenceScenario },
    { id: "max-healthcare", label: "Max Healthcare Subsidy (MAGI <= 150% FPL)", scenario: maxHealthcareScenario },
    { id: "max-bequest", label: "Max Bequest (Essential Only, High Shelter)", scenario: maxBequestScenario }
  ];
  
  const results = plans.map(p => {
    const cand = runCandidate({
      id: p.id,
      kind: "tradeoffFrontier",
      label: p.label,
      scenario: p.scenario,
      assets,
      taxProfile,
      runs: searchRuns,
      seed,
      sequences,
      profile: activeProfile,
      metadata: {},
      includeHistorical: false,
      tracker
    });
    
    const spend = p.scenario.targetSpend;
    const resilience = cand.monteCarlo?.successRate ?? 0;
    const healthcare = cand.planFirstYear?.acaSubsidy ?? 0;
    const bequest = cand.monteCarlo?.medianHeirValue ?? cand.monteCarlo?.medianEndingValue ?? 0;
    
    return {
      id: p.id,
      label: p.label,
      spend: round(spend, 2),
      resilience: round(resilience, 4),
      healthcare: round(healthcare, 2),
      bequest: round(bequest, 2),
      successRate: round(resilience, 4),
      candidate: cand
    };
  });
  
  return results;
}
