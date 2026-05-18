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
const WITHDRAWAL_ORDERS = [
  ["taxable", "traditional", "hsa", "roth"],
  ["traditional", "taxable", "hsa", "roth"],
  ["taxable", "hsa", "traditional", "roth"]
];

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

  const solverContext = { assets, scenario, taxProfile, runs, seed, sequences, profile, base, tracker };

  const safeSpending = findSafeSpendingBoundary(solverContext);

  // The discretionary cut is the same lever a guardrails plan already owns,
  // so skip it as a distinct rescue when the base plan already guards spending.
  const baseUsesGuardrails = scenario?.spendingStrategy?.mode === "discretionaryGuardrails";
  const discretionaryCut = baseUsesGuardrails ? null : findDiscretionaryCut(solverContext);
  const incomeBridge = findIncomeBridge(solverContext);
  const sequenceReserve = findSequenceReserve(solverContext);
  const allocationShift = findAllocationShift(solverContext);
  const withdrawalShift = findWithdrawalShift(solverContext);
  const healthcareRescue = findHealthcareRescue(solverContext);
  const combined = buildCombinedRescue({ ...solverContext, discretionaryCut, incomeBridge });

  const verdict = classifyDecisionEvidence({
    monteCarloSuccessRate: base.monteCarlo.successRate,
    historicalSuccessRate: base.historical.successRate,
    historicalCount: base.historical.count,
    targetSuccessRate: profile.targetSuccessRate
  });
  const diagnosis = diagnoseFailure({ base, safeSpending });

  const rescueOptions = [
    discretionaryCut,
    incomeBridge,
    sequenceReserve,
    allocationShift,
    withdrawalShift,
    healthcareRescue,
    combined
  ].filter(Boolean);
  rescueOptions.sort((a, b) => rescueSortScore(b, profile, diagnosis) - rescueSortScore(a, profile, diagnosis));
  const bestOption = rescueOptions[0] ?? null;

  return {
    status: "ready",
    profile,
    verdict,
    diagnosis,
    safeSpending,
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
  const finalized = finalizeCandidate({ candidate: best, assets, taxProfile, runs, seed, sequences, profile });
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
    maxAcaFplPercent: clampNumber(Number(maxAcaFplPercent), 100, 600, 400)
  };
  if (disableGainHarvesting) {
    const existingGain = plainObject(scenario.taxGainHarvesting) ? scenario.taxGainHarvesting : {};
    next.taxGainHarvesting = { ...existingGain, enabled: false };
  }
  return next;
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
  if (!isWorthwhileRescue(finalized, base, profile)) return null;
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
  if (worsensWorstPath || !isWorthwhileRescue(finalized, base, profile)) return null;
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
  if (!isWorthwhileRescue(finalized, base, profile)) return null;
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
  if (!isWorthwhileRescue(finalized, base, profile) && !subsidyGain) return null;
  return optionWithDelta(finalized, base, { status: meetsTarget(finalized, profile) ? "target-met" : "best-tested" });
}

// A rescue is worth surfacing only if the finalized full-run candidate meets
// the target or genuinely improves on the base success rate.
function isWorthwhileRescue(candidate, base, profile) {
  return meetsTarget(candidate, profile)
    || candidate.monteCarlo.successRate > base.monteCarlo.successRate + EPSILON;
}

function healthcareSortScore(candidate) {
  return candidate.monteCarlo.successRate * 1000 + (candidate.planFirstYear?.acaSubsidy ?? 0) / 1000;
}

function diagnoseFailure({ base, safeSpending }) {
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
    recommendedKinds = ["healthcareRescue", "withdrawalShift", "discretionaryCut"];
  } else if (failedCount > 0 && anatomy.commonTrigger === "Early sequence risk") {
    primary = "earlySequenceRisk";
    label = "Early sequence risk";
    reason = "Failures cluster in the first ten years, so an early bad-market sequence is the likely failure driver.";
    recommendedKinds = ["sequenceReserve", "allocationShift", "discretionaryCut"];
  } else if (failedCount > 0) {
    primary = "longHorizonDepletion";
    label = "Long-horizon depletion";
    reason = "Failures cluster later in the plan, so structural overspend or portfolio drag is the likely failure driver.";
    recommendedKinds = ["discretionaryCut", "allocationShift", "withdrawalShift"];
  }

  if (requiredUnsustainable) {
    reason += " Required spending alone is not sustainable, so an income bridge may be necessary.";
    recommendedKinds = ["incomeBridge", ...recommendedKinds.filter((kind) => kind !== "incomeBridge")];
  }

  return {
    primary,
    label,
    reason,
    recommendedKinds,
    magiBuffer: magiBuffer != null ? round(magiBuffer, 2) : null
  };
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
