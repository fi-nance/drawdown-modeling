// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: withdrawalPlanning. No behavior changes — pure code movement.

import { clonePortfolio } from "../portfolio.mjs";
import { computeIncomeTax } from "../tax.mjs?v=20260604-amt";
import { round } from "../utils.mjs";
import { emptyEarnedIncome } from "./cashFlows.mjs";
import { clampFiniteNumber } from "./guards.mjs";
import { estimateHeirValueBreakdown } from "./heirEstate.mjs?v=20260604-amt";
import { acaMagiForIncome, federalAgiForIncome, incomeForYear, irmaaMagiForIncome } from "./income.mjs?v=20260604-amt";
import { computeAcaForYear, medicalCostForYear } from "./medical.mjs";
import { expectedReturnForAsset, isLifetimeOptimizerEnabled, withdrawalStrategyConfig } from "./scenario.mjs";
import { addPenaltyTax, estimatedFutureCapitalGainRate, estimatedFutureOrdinaryIncomeRate } from "./taxStrategy.mjs?v=20260604-amt";
import { mergeWithdrawals, withdrawForCash } from "./withdrawalExecution.mjs";
import { betterPenaltyAvoidancePlan, earlyPenaltyAvoidanceWithdrawalOrder, hasLowerPenaltyBurden, isBeforePenaltyAge, normalizedWithdrawalOrder, optimizedRothProceedsLimit, rothFirstWithdrawalOrder, rothPreservingWithdrawalOrder, rothWithdrawalProceeds, sameWithdrawalOrder, withdrawalPenaltyBurden } from "./withdrawalOrders.mjs";

export function chooseWithdrawalPlan({
  portfolio,
  amount,
  baseWithdrawal,
  withdrawalOrder,
  withdrawalContext,
  evaluationContext
}) {
  const optimization = rothBasisOptimizationConfig(evaluationContext.scenario);
  const requestedOrder = normalizedWithdrawalOrder(withdrawalOrder);
  if (isLifetimeOptimizerEnabled(evaluationContext.scenario)) {
    return chooseLifetimeOptimizedWithdrawalPlan({
      portfolio,
      amount,
      baseWithdrawal,
      requestedOrder,
      withdrawalContext,
      evaluationContext,
      rothOptimization: optimization
    });
  }

  const baselineOrder = optimization.enabled ? rothPreservingWithdrawalOrder(requestedOrder) : requestedOrder;
  const baseline = evaluateWithdrawalPlan({
    portfolio,
    amount,
    baseWithdrawal,
    withdrawalOrder: baselineOrder,
    withdrawalContext,
    evaluationContext
  });

  if (optimization.enabled && amount > 0 && requestedOrder.includes("roth") && isBeforePenaltyAge(withdrawalContext)) {
    let penaltyCandidate = null;
    const penaltyOrders = uniqueWithdrawalOrders([
      earlyPenaltyAvoidanceWithdrawalOrder(requestedOrder),
      rothFirstWithdrawalOrder(requestedOrder)
    ]);
    for (const order of penaltyOrders) {
      if (sameWithdrawalOrder(order, baselineOrder)) continue;
      const candidate = evaluateWithdrawalPlan({
        portfolio,
        amount,
        baseWithdrawal,
        withdrawalOrder: order,
        withdrawalContext: {
          ...withdrawalContext,
          maxRothProceeds: optimizedRothProceedsLimit(withdrawalContext)
        },
        evaluationContext
      });
      if (hasLowerPenaltyBurden(candidate.withdrawal, baseline.withdrawal)
        && betterPenaltyAvoidancePlan(candidate, penaltyCandidate)) {
        penaltyCandidate = candidate;
      }
    }
    if (penaltyCandidate) {
      const metrics = rothOptimizationMetrics({
        baseline,
        candidate: penaltyCandidate,
        baseWithdrawal,
        withdrawalContext,
        evaluationContext,
        optimization
      });
      return withRothOptimizationDecision(penaltyCandidate, {
        enabled: true,
        accepted: true,
        reason: "early-penalty-avoidance",
        minSavingsRate: optimization.minSavingsRate,
        ...metrics
      });
    }
  }

  if (!optimization.enabled || amount <= 0 || !requestedOrder.includes("roth")) {
    return withRothOptimizationDecision(baseline, {
      enabled: optimization.enabled,
      accepted: false,
      reason: optimization.enabled ? "no-roth-substitution" : "disabled",
      minSavingsRate: optimization.minSavingsRate,
      extraRothWithdrawal: 0,
      modeledSavings: 0,
      requiredSavings: 0
    });
  }

  const candidateOrder = rothFirstWithdrawalOrder(requestedOrder);
  if (sameWithdrawalOrder(candidateOrder, baselineOrder)) {
    return withRothOptimizationDecision(baseline, {
      enabled: true,
      accepted: false,
      reason: "already-roth-first",
      minSavingsRate: optimization.minSavingsRate,
      extraRothWithdrawal: 0,
      modeledSavings: 0,
      requiredSavings: 0
    });
  }

  const candidate = evaluateWithdrawalPlan({
    portfolio,
    amount,
    baseWithdrawal,
    withdrawalOrder: candidateOrder,
    withdrawalContext: {
      ...withdrawalContext,
      maxRothProceeds: optimizedRothProceedsLimit(withdrawalContext)
    },
    evaluationContext
  });
  const metrics = rothOptimizationMetrics({
    baseline,
    candidate,
    baseWithdrawal,
    withdrawalContext,
    evaluationContext,
    optimization
  });
  const accepted = metrics.extraRothWithdrawal > 0.000001
    && metrics.modeledSavings > 0.01
    && metrics.modeledSavings + 0.01 >= metrics.requiredSavings;

  return withRothOptimizationDecision(accepted ? candidate : baseline, {
    enabled: true,
    accepted,
    reason: accepted ? "savings-hurdle-met" : "savings-below-hurdle",
    minSavingsRate: optimization.minSavingsRate,
    ...metrics
  });
}

function chooseLifetimeOptimizedWithdrawalPlan({
  portfolio,
  amount,
  baseWithdrawal,
  requestedOrder,
  withdrawalContext,
  evaluationContext,
  rothOptimization
}) {
  const config = withdrawalStrategyConfig(evaluationContext.scenario);
  const baseOrder = rothOptimization.enabled ? rothPreservingWithdrawalOrder(requestedOrder) : requestedOrder;
  const baseline = evaluateWithdrawalPlan({
    portfolio,
    amount,
    baseWithdrawal,
    withdrawalOrder: baseOrder,
    withdrawalContext: {
      ...withdrawalContext,
      optimizedLotSelection: true
    },
    evaluationContext
  });
  let best = withRothOptimizationDecision(baseline, {
    enabled: rothOptimization.enabled,
    accepted: false,
    reason: "lifetime-baseline",
    minSavingsRate: rothOptimization.minSavingsRate,
    extraRothWithdrawal: 0,
    modeledSavings: 0,
    requiredSavings: 0
  });
  let bestScore = lifetimeWithdrawalScore(best, config, evaluationContext.scenario);

  const candidates = optimizedWithdrawalCandidates({
    requestedOrder,
    baseline,
    baseWithdrawal,
    amount,
    withdrawalContext,
    evaluationContext,
    rothOptimization
  });

  for (const candidateConfig of candidates) {
    const candidate = evaluateWithdrawalPlan({
      portfolio,
      amount,
      baseWithdrawal,
      withdrawalOrder: candidateConfig.order,
      withdrawalContext: {
        ...withdrawalContext,
        optimizedLotSelection: true,
        ...(Number.isFinite(candidateConfig.maxRothProceeds) ? { maxRothProceeds: candidateConfig.maxRothProceeds } : {})
      },
      evaluationContext
    });
    const metrics = rothOptimizationMetrics({
      baseline,
      candidate,
      baseWithdrawal,
      withdrawalContext,
      evaluationContext,
      optimization: rothOptimization
    });
    const avoidsEarlyPenalty = hasLowerPenaltyBurden(candidate.withdrawal, baseline.withdrawal);

    if (metrics.extraRothWithdrawal > 0.000001
      && !avoidsEarlyPenalty
      && (!rothOptimization.enabled
        || metrics.modeledSavings <= 0.01
        || metrics.modeledSavings + 0.01 < metrics.requiredSavings)) {
      continue;
    }

    const annotated = withRothOptimizationDecision(candidate, {
      enabled: rothOptimization.enabled,
      accepted: metrics.extraRothWithdrawal > 0.000001,
      reason: avoidsEarlyPenalty
        ? "early-penalty-avoidance"
        : metrics.extraRothWithdrawal > 0.000001 ? "lifetime-savings-hurdle-met" : "lifetime-lower-cost-source",
      minSavingsRate: rothOptimization.minSavingsRate,
      ...metrics
    });
    const score = lifetimeWithdrawalScore(annotated, config, evaluationContext.scenario);
    const candidatePenalty = withdrawalPenaltyBurden(annotated.withdrawal);
    const bestPenalty = withdrawalPenaltyBurden(best.withdrawal);
    if (candidatePenalty + 0.01 < bestPenalty) {
      best = annotated;
      bestScore = score;
    } else if (candidatePenalty <= bestPenalty + 0.01 && score + 0.01 < bestScore) {
      best = annotated;
      bestScore = score;
    }
  }

  return best;
}

function optimizedWithdrawalCandidates({
  requestedOrder,
  baseline,
  amount,
  withdrawalContext,
  evaluationContext,
  rothOptimization
}) {
  const canonical = ["taxable", "traditional", "hsa", "roth"].filter((accountType) => requestedOrder.includes(accountType));
  const orders = [
    requestedOrder,
    canonical,
    ["taxable", "hsa", "traditional", "roth"].filter((accountType) => requestedOrder.includes(accountType)),
    ["traditional", "taxable", "hsa", "roth"].filter((accountType) => requestedOrder.includes(accountType)),
    ["taxable", "roth", "traditional", "hsa"].filter((accountType) => requestedOrder.includes(accountType))
  ];
  if ((withdrawalContext.age ?? 99) >= (withdrawalContext.penaltyAge ?? 59.5)) {
    orders.push(["traditional", "hsa", "taxable", "roth"].filter((accountType) => requestedOrder.includes(accountType)));
  }
  if (requestedOrder.includes("roth")) {
    orders.push(rothFirstWithdrawalOrder(requestedOrder));
  }

  const uniqueOrders = uniqueWithdrawalOrders(orders)
    .filter((order) => order.length > 0);
  const candidates = uniqueOrders.map((order) => ({ order }));

  if (rothOptimization.enabled && isBeforePenaltyAge(withdrawalContext) && requestedOrder.includes("roth")) {
    candidates.push({
      order: earlyPenaltyAvoidanceWithdrawalOrder(requestedOrder),
      maxRothProceeds: optimizedRothProceedsLimit(withdrawalContext)
    });
  }

  if (rothOptimization.enabled && requestedOrder.includes("roth") && amount > 0) {
    const rothOrder = rothFirstWithdrawalOrder(requestedOrder);
    for (const limit of rothSubstitutionLimits({
      baseline,
      withdrawalContext,
      evaluationContext,
      amount,
      rothOptimization
    })) {
      candidates.push({ order: rothOrder, maxRothProceeds: limit });
    }
  }

  return candidates;
}

function rothSubstitutionLimits({ baseline, withdrawalContext, evaluationContext, amount, rothOptimization }) {
  const maxRoth = optimizedRothProceedsLimit(withdrawalContext);
  if (!(maxRoth > 0)) return [];
  const baselineRoth = rothWithdrawalProceeds(baseline.withdrawal);
  const thresholds = magiOptimizationThresholds({
    magi: baseline.magi,
    yearTaxProfile: evaluationContext.yearTaxProfile,
    yearAcaConfig: evaluationContext.yearAcaConfig,
    magiBuffer: rothOptimization?.magiBuffer ?? 0
  });
  const limits = [Math.min(maxRoth, amount)];
  for (const threshold of thresholds) {
    const reductionNeeded = Math.max(0, baseline.magi - threshold);
    if (reductionNeeded > 0.000001) {
      limits.push(Math.min(maxRoth, baselineRoth + reductionNeeded));
    }
  }
  return [...new Set(limits.map((limit) => round(Math.max(0, Math.min(maxRoth, limit)), 6)))]
    .filter((limit) => limit > 0.000001)
    .sort((a, b) => a - b);
}

function magiOptimizationThresholds({ magi, yearTaxProfile, yearAcaConfig, magiBuffer = 0 }) {
  const thresholds = [];
  const acaBuffer = Math.max(0, Number(magiBuffer) || 0);
  if (yearAcaConfig?.enabled && yearAcaConfig.fpl > 0) {
    thresholds.push(...(yearAcaConfig.applicablePercentageTable ?? [])
      .map((row) => row.maxFplPercent)
      .filter((percent) => Number.isFinite(percent) && percent > 0)
      .map((percent) => Math.max(0, yearAcaConfig.fpl * percent / 100 - acaBuffer)));
    thresholds.push(Math.max(0, yearAcaConfig.fpl * ((yearAcaConfig.maxEligibleFplPercent ?? 400) / 100) - acaBuffer));
  }
  const niitThreshold = yearTaxProfile?.niit?.thresholds?.[yearTaxProfile.filingStatus];
  if (Number.isFinite(niitThreshold)) thresholds.push(niitThreshold);
  return thresholds
    .filter((threshold) => Number.isFinite(threshold) && threshold > 0 && threshold < magi - 0.000001)
    .sort((a, b) => b - a);
}

function rothOptimizationMetrics({
  baseline,
  candidate,
  baseWithdrawal,
  withdrawalContext,
  evaluationContext,
  optimization
}) {
  const baselineRoth = rothWithdrawalProceeds(baseline.withdrawal) - rothWithdrawalProceeds(baseWithdrawal);
  const candidateRoth = rothWithdrawalProceeds(candidate.withdrawal) - rothWithdrawalProceeds(baseWithdrawal);
  const extraRothWithdrawal = round(Math.max(0, candidateRoth - Math.max(0, baselineRoth)), 6);
  const modeledSavings = round(Math.max(0, baseline.modeledCost - candidate.modeledCost), 6);
  const opportunityCostRate = rothBasisOpportunityCostRate({
    baseline,
    candidate,
    extraRothWithdrawal,
    withdrawalContext,
    evaluationContext,
    optimization
  });
  return {
    extraRothWithdrawal,
    modeledSavings,
    requiredSavings: round(extraRothWithdrawal * opportunityCostRate, 6),
    opportunityCostRate
  };
}

function rothBasisOpportunityCostRate({
  baseline,
  candidate,
  extraRothWithdrawal,
  withdrawalContext,
  evaluationContext,
  optimization
}) {
  if (!(extraRothWithdrawal > 0)) return 0;
  if (optimization?.opportunityCostMode === "fixed") {
    return round(clampFiniteNumber(optimization.minSavingsRate, 0, 1, 0.5), 6);
  }

  const scenario = evaluationContext.scenario ?? {};
  const taxProfile = evaluationContext.yearTaxProfile;
  const years = rothOpportunityCostYears({
    withdrawalContext,
    scenario,
    yearIndex: evaluationContext.yearIndex
  });
  const futureOrdinaryRate = estimatedFutureOrdinaryIncomeRate({
    portfolio: candidate.portfolio ?? [],
    scenario,
    age: withdrawalContext.age,
    taxProfile,
    ordinaryIncome: evaluationContext.ordinaryIncome ?? 0
  });
  const futureCapitalGainRate = estimatedFutureCapitalGainRate({
    taxProfile,
    scenario,
    portfolio: candidate.portfolio ?? []
  });
  const avoidedSales = avoidedSalesFromBaseline(baseline.withdrawal, candidate.withdrawal);
  const retainedTaxRate = weightedRetainedFutureTaxRate(avoidedSales, {
    futureOrdinaryRate,
    futureCapitalGainRate,
    scenario
  });
  const retainedReturn = weightedSaleExpectedReturn(avoidedSales, scenario.returnAssumptions);
  const extraRothSales = extraRothSalesFromCandidate(baseline.withdrawal, candidate.withdrawal);
  const rothReturn = weightedSaleExpectedReturn(extraRothSales, scenario.returnAssumptions);
  const discountReturn = Math.max(0.01, rothReturn);
  const relativeGrowth = Math.pow((1 + Math.max(-0.5, retainedReturn)) / (1 + discountReturn), years);
  const futureTaxCost = retainedTaxRate * relativeGrowth;
  const taxableDrag = retainedTaxRate > 0
    ? 0
    : Math.max(0, rothReturn - retainedReturn) * Math.min(years, 10) * 0.15;
  const rawRate = futureTaxCost + taxableDrag;
  const capped = clampFiniteNumber(rawRate, 0, optimization?.minSavingsRate ?? 0.5, 0.15);
  return round(capped, 6);
}

function rothOpportunityCostYears({ withdrawalContext, scenario, yearIndex = 0 }) {
  const configured = Number(scenario?.rothBasisOptimization?.opportunityCostYears);
  if (Number.isFinite(configured) && configured > 0) return Math.min(40, configured);
  const age = Number(withdrawalContext?.age);
  const remainingPlanYears = Math.max(1, Number(scenario?.planYears ?? 30) - Number(yearIndex ?? 0));
  if (Number.isFinite(age) && age < 65 && scenario?.aca?.enabled !== false) {
    return Math.max(1, Math.min(remainingPlanYears, 65 - age));
  }
  if (Number.isFinite(age)) return Math.max(1, Math.min(remainingPlanYears, 85 - age));
  return Math.min(remainingPlanYears, 20);
}

function avoidedSalesFromBaseline(baselineWithdrawal = {}, candidateWithdrawal = {}) {
  const candidateByKey = saleProceedsByKey(candidateWithdrawal.sales ?? [], (sale) => sale.accountType !== "roth");
  return (baselineWithdrawal.sales ?? [])
    .filter((sale) => sale.accountType !== "roth")
    .map((sale) => {
      const key = saleKey(sale);
      const candidateProceeds = candidateByKey.get(key) ?? 0;
      const avoidedProceeds = Math.max(0, (sale.proceeds ?? 0) - candidateProceeds);
      return avoidedProceeds > 0.000001 ? { ...sale, proceeds: round(avoidedProceeds, 6) } : null;
    })
    .filter(Boolean);
}

function extraRothSalesFromCandidate(baselineWithdrawal = {}, candidateWithdrawal = {}) {
  const baselineByKey = saleProceedsByKey(baselineWithdrawal.sales ?? [], (sale) => sale.accountType === "roth");
  return (candidateWithdrawal.sales ?? [])
    .filter((sale) => sale.accountType === "roth")
    .map((sale) => {
      const key = saleKey(sale);
      const baselineProceeds = baselineByKey.get(key) ?? 0;
      const extraProceeds = Math.max(0, (sale.proceeds ?? 0) - baselineProceeds);
      return extraProceeds > 0.000001 ? { ...sale, proceeds: round(extraProceeds, 6) } : null;
    })
    .filter(Boolean);
}

function saleProceedsByKey(sales = [], predicate = () => true) {
  const map = new Map();
  for (const sale of sales) {
    if (!predicate(sale)) continue;
    const key = saleKey(sale);
    map.set(key, (map.get(key) ?? 0) + Math.max(0, sale.proceeds ?? 0));
  }
  return map;
}

function saleKey(sale = {}) {
  return `${sale.accountType ?? ""}|${sale.assetId ?? sale.id ?? sale.name ?? ""}`;
}

function weightedRetainedFutureTaxRate(sales = [], { futureOrdinaryRate, futureCapitalGainRate, scenario }) {
  const total = sales.reduce((sum, sale) => sum + Math.max(0, sale.proceeds ?? 0), 0);
  if (!(total > 0)) return Math.max(0, futureOrdinaryRate ?? 0) * 0.5;
  return sales.reduce((sum, sale) => {
    const proceeds = Math.max(0, sale.proceeds ?? 0);
    const weight = proceeds / total;
    if (sale.accountType === "traditional") return sum + weight * Math.max(0, futureOrdinaryRate ?? 0);
    if (sale.accountType === "taxable") {
      const gainRatio = proceeds > 0 ? Math.max(0, sale.gain ?? 0) / proceeds : 0;
      return sum + weight * Math.max(0, futureCapitalGainRate ?? 0) * Math.min(1, gainRatio);
    }
    if (sale.accountType === "hsa") {
      const hsaQualified = scenario?.taxEfficiencyStrategy?.hsaUseForQualifiedExpenses === true
        || scenario?.taxEfficiencyStrategy?.hsaContributionEnabled === true;
      return sum + weight * (hsaQualified ? 0 : Math.max(0, futureOrdinaryRate ?? 0));
    }
    return sum;
  }, 0);
}

function weightedSaleExpectedReturn(sales = [], returnAssumptions = {}) {
  const total = sales.reduce((sum, sale) => sum + Math.max(0, sale.proceeds ?? 0), 0);
  if (!(total > 0)) return 0;
  return sales.reduce((sum, sale) => {
    const proceeds = Math.max(0, sale.proceeds ?? 0);
    const explicit = Number(sale.expectedReturn);
    const assumed = Number.isFinite(explicit)
      ? explicit
      : expectedReturnForAsset(sale, returnAssumptions);
    return sum + (proceeds / total) * (Number.isFinite(assumed) ? assumed : 0);
  }, 0);
}

function uniqueWithdrawalOrders(orders) {
  const seen = new Set();
  const result = [];
  for (const order of orders) {
    const normalized = normalizedWithdrawalOrder(order);
    const key = normalized.join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function lifetimeWithdrawalScore(plan, config, scenario) {
  const heirTaxRate = scenario?.heirOrdinaryTaxRate ?? 0.24;
  const heirValue = plan.portfolio ? estimateHeirValueBreakdown(plan.portfolio, heirTaxRate, {
    heirType: scenario?.heirType,
    nonSpouse10YrTaxDrag: scenario?.nonSpouse10YrTaxDrag,
    eligibleDesignatedTaxDiscount: scenario?.eligibleDesignatedTaxDiscount,
    heirBaseIncome: scenario?.heirBaseIncome,
    heirAge: scenario?.heirAge,
    state: scenario?.state
  }).afterTaxValue : 0;
  return round(
    plan.modeledCost
      + Math.max(0, plan.withdrawal?.saleOpportunityCost ?? 0) * config.expectedReturnPenaltyYears
      - heirValue,
    6
  );
}

export function evaluateWithdrawalPlan({
  portfolio,
  amount,
  baseWithdrawal,
  withdrawalOrder,
  withdrawalContext,
  evaluationContext
}) {
  const workingPortfolio = clonePortfolio(portfolio);
  const voluntaryWithdrawal = withdrawForCash(
    workingPortfolio,
    amount,
    withdrawalOrder,
    withdrawalContext
  );
  const withdrawal = mergeWithdrawals(baseWithdrawal, voluntaryWithdrawal);
  return {
    portfolio: workingPortfolio,
    voluntaryWithdrawal,
    withdrawal,
    ...evaluateWithdrawalState({
      ...evaluationContext,
      withdrawal
    })
  };
}

function evaluateWithdrawalState({
  scenario,
  yearTaxProfile,
  yearAcaConfig,
  inflationIndex,
  medicalInflationIndex = null,
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0,
  lossCarryforward,
  socialSecurityBenefits,
  age,
  spouseAge,
  yearIndex,
  magiHistory,
  withdrawal
}) {
  const { income, taxableSocialSecurity } = incomeForYear({
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome,
    ordinaryInvestmentIncome,
    qualifiedDividends,
    adjustmentsToIncome,
    strategyShortTermGains,
    strategyLongTermGains,
    strategyCapitalLosses,
    strategyShortTermLosses,
    strategyLongTermLosses,
    withdrawal,
    socialSecurityBenefits,
    taxProfile: yearTaxProfile,
    scenario,
    lossCarryforward
  });
  const taxes = computeIncomeTax({
    ...income,
    capitalLossCarryforward: lossCarryforward,
    profile: yearTaxProfile
  });
  const taxesWithPenalties = addPenaltyTax(taxes, withdrawal.penaltyTax);
  const federalAgi = round(federalAgiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, yearTaxProfile), 6);
  const acaMagi = round(acaMagiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, yearTaxProfile), 6);
  const irmaaMagi = round(irmaaMagiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, yearTaxProfile), 6);
  const aca = computeAcaForYear({ age, spouseAge, magi: acaMagi, config: yearAcaConfig, filingStatus: yearTaxProfile.filingStatus });
  const medical = medicalCostForYear({
    scenario,
    aca,
    yearAcaConfig,
    inflationIndex,
    medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
    age,
    spouseAge,
    yearIndex,
    filingStatus: yearTaxProfile.filingStatus,
    irmaaMagi,
    magiHistory
  });

  return {
    income,
    taxableSocialSecurity,
    taxes: taxesWithPenalties,
    aca,
    medicare: medical.medicare,
    medicalTotal: medical.total,
    modeledCost: round(taxesWithPenalties.totalTax + medical.total, 6),
    federalAgi,
    acaMagi,
    irmaaMagi,
    magi: acaMagi
  };
}

function withRothOptimizationDecision(plan, decision) {
  return {
    ...plan,
    rothBasisOptimization: {
      ...decision,
      extraRothWithdrawal: round(decision.extraRothWithdrawal ?? 0, 6),
      modeledSavings: round(decision.modeledSavings ?? 0, 6),
      requiredSavings: round(decision.requiredSavings ?? 0, 6),
      opportunityCostRate: round(decision.opportunityCostRate ?? 0, 6)
    }
  };
}

function rothBasisOptimizationConfig(scenario) {
  const config = scenario.rothBasisOptimization ?? {};
  const minSavingsRate = Number(config.minSavingsRate);
  const magiBuffer = Number(config.magiBuffer);
  const opportunityCostMode = config.opportunityCostMode === "fixed" ? "fixed" : "dynamic";
  return {
    enabled: config.enabled !== false,
    minSavingsRate: Number.isFinite(minSavingsRate) && minSavingsRate >= 0 ? minSavingsRate : 0.5,
    opportunityCostMode,
    magiBuffer: Number.isFinite(magiBuffer) && magiBuffer >= 0 ? magiBuffer : 1000
  };
}
