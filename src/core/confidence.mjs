import { STATE_MEDICAID_EXPANSION_2026 } from "../data/geo.mjs";
import { benchmarkPremiumForZip } from "./aca.mjs";

export const CONFIDENCE_LEVELS = Object.freeze({
  HIGH: "high-confidence",
  INPUT_LIMITED: "input-limited",
  ASSUMPTION_SENSITIVE: "assumption-sensitive",
  CPA_REVIEW: "cpa-review-recommended",
  OUT_OF_MODEL: "out-of-model"
});

const LEVEL_LABELS = Object.freeze({
  [CONFIDENCE_LEVELS.HIGH]: "High confidence",
  [CONFIDENCE_LEVELS.INPUT_LIMITED]: "Input-limited",
  [CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE]: "Assumption-sensitive",
  [CONFIDENCE_LEVELS.CPA_REVIEW]: "CPA review recommended",
  [CONFIDENCE_LEVELS.OUT_OF_MODEL]: "Out of model"
});

const HEADLINE_PRIORITY = [
  CONFIDENCE_LEVELS.CPA_REVIEW,
  CONFIDENCE_LEVELS.INPUT_LIMITED,
  CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE
];

export function confidenceLevelLabel(level) {
  return LEVEL_LABELS[level] ?? "Review flag";
}

export function actionConfidenceFor(actionKind, confidenceReport = {}) {
  const flags = Array.isArray(confidenceReport.flags) ? confidenceReport.flags : [];
  const has = (id) => flags.some((flag) => flag.id === id);
  const find = (ids) => findFlagByPriority(flags, ids);

  if (["taxReserve", "traditionalWithdrawal", "rothConversion", "taxGainHarvesting", "taxLossHarvesting"].includes(actionKind)) {
    const flag = find(["manual-federal-tax-overrides-review"]);
    if (flag) return actionConfidenceFromFlag(flag);
  }

  if (["aca", "medicalReserve"].includes(actionKind)) {
    const flag = find(["aca-coverage-gap-modeled", "aca-medicaid-handoff-modeled", "aca-coverage-gap-risk", "aca-plan-inputs", "aca-benchmark-state-fallback", "aca-benchmark-out-of-model", "aca-oop-inputs", "aca-net-premium-quote", "aca-magi-threshold"]);
    if (flag) return actionConfidenceFromFlag(flag);
  }

  if (["magiManagement", "rothConversion", "taxGainHarvesting"].includes(actionKind)) {
    const flag = find(["aca-coverage-gap-modeled", "aca-medicaid-handoff-modeled", "aca-coverage-gap-risk", "aca-magi-threshold"]);
    if (flag) return actionConfidenceFromFlag(flag);
  }

  if (["taxReserve", "traditionalWithdrawal", "stateTax"].includes(actionKind) && has("state-retirement-tax-review")) {
    return actionConfidenceFromFlag(flags.find((flag) => flag.id === "state-retirement-tax-review"));
  }

  if (actionKind === "earnedIncome" && has("business-income-tax-review")) {
    return actionConfidenceFromFlag(flags.find((flag) => flag.id === "business-income-tax-review"));
  }

  if (actionKind === "socialSecurity" && has("social-security-claiming-inputs")) {
    return actionConfidenceFromFlag(flags.find((flag) => flag.id === "social-security-claiming-inputs"));
  }

  if (actionKind === "legacy" && has("legacy-tax-out-of-model")) {
    return actionConfidenceFromFlag(flags.find((flag) => flag.id === "legacy-tax-out-of-model"));
  }

  if (actionKind === "fundingGap") {
    return {
      level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
      label: "Sensitive",
      title: "Selected path has an unfunded gap",
      detail: "This is a failure-path action. Treat the move as a rescue prompt, not an executable recommendation."
    };
  }

  return {
    level: CONFIDENCE_LEVELS.HIGH,
    label: "High",
    title: "Source-versioned rule",
    detail: "The modeled rule is covered by versioned assumptions and tests; confirm household inputs before acting."
  };
}

export function rescueConfidenceFor(option = {}, confidenceReport = {}) {
  const flags = Array.isArray(confidenceReport.flags) ? confidenceReport.flags : [];
  const find = (ids) => findFlagByPriority(flags, ids);
  const kind = option?.kind;

  if (option?.status === "discarded") {
    return {
      level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
      label: "Sensitive",
      title: "Solver found negligible effect",
      detail: "This candidate is shown for auditability, but it did not materially improve the selected decision target."
    };
  }

  if (!(Number(option?.historical?.count) > 0)) {
    return {
      level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
      label: "Sensitive",
      title: "Preliminary solver evidence",
      detail: "This candidate may still be a live search probe or a result without historical cohorts. Use the final full-run evidence before acting."
    };
  }

  const specific = find(rescueFlagIds(kind));
  if (specific) return actionConfidenceFromFlag(specific);

  if (["incomeBridge", "combined"].includes(kind)) {
    const businessIncome = selfEmploymentIncomeSummary(option?.scenario);
    if (businessIncome.hasSelfEmploymentIncome) {
      return actionConfidenceFromFlag(businessIncomeReviewFlag(businessIncome));
    }
  }

  const evidence = find(["evidence-disagreement", "historical-evidence-missing"]);
  if (evidence) return actionConfidenceFromFlag(evidence);

  if (["allocationShift", "sequenceReserve"].includes(kind)) {
    return {
      level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
      label: "Sensitive",
      title: "Return-path assumption drives this rescue",
      detail: "This option changes portfolio risk exposure or reserve sizing, so its ranking can move when return, inflation, or historical-window assumptions change."
    };
  }

  return {
    level: CONFIDENCE_LEVELS.HIGH,
    label: "High",
    title: "Full-run rescue evidence",
    detail: "This rescue was compared against the selected base scenario with versioned assumptions and final-run success metrics."
  };
}

export function buildConfidenceReport({
  scenario = {},
  taxProfile = {},
  decision = null,
  plan = null,
  historicalCoverage = null,
  historicalAssetClasses = []
} = {}) {
  const flags = [];
  addHealthcareFlags(flags, scenario, decision);
  addCoverageGapFlags(flags, scenario, plan);
  addStateTaxFlags(flags, taxProfile);
  addFederalTaxScopeFlags(flags, scenario, taxProfile);
  addEvidenceFlags(flags, decision, historicalCoverage, historicalAssetClasses);
  addSocialSecurityFlags(flags, scenario);
  addLegacyFlags(flags, scenario);

  if (!flags.length) {
    flags.push({
      id: "rules-source-versioned",
      level: CONFIDENCE_LEVELS.HIGH,
      lens: "engineering",
      title: "Core rules are source-versioned",
      detail: "The selected federal, ACA, Medicare, state-tax, and historical-return tables are versioned and covered by regression tests.",
      action: "Keep the setup export with the run if you want a reproducible record."
    });
  }

  return {
    headline: confidenceHeadline(flags),
    flags,
    counts: flags.reduce((counts, flag) => ({
      ...counts,
      [flag.level]: (counts[flag.level] ?? 0) + 1
    }), {})
  };
}

function addHealthcareFlags(flags, scenario, decision) {
  const aca = scenario?.aca ?? {};
  if (aca.enabled === false) return;

  const benchmarkFlag = acaBenchmarkGeographyFlag(aca);
  if (benchmarkFlag) flags.push(benchmarkFlag);

  if (aca.manualOopMaximum !== true) {
    flags.push({
      id: "aca-oop-inputs",
      level: CONFIDENCE_LEVELS.INPUT_LIMITED,
      lens: "cpa",
      title: "ACA out-of-pocket cost uses a default cap",
      detail: "The healthcare bridge does not yet have the household's selected-plan OOP maximum, so medical spending uses the federal self-only/family cap instead of plan-specific exposure.",
      action: "Enter the selected plan OOP maximum or fill an exact Marketplace plan before treating healthcare cash-flow risk as household-specific."
    });
  }

  const magiBuffer = Number(decision?.healthcare?.magiBuffer);
  if (Number.isFinite(magiBuffer) && Math.abs(magiBuffer) <= 2500) {
    flags.push({
      id: "aca-magi-threshold",
      level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
      lens: "cpa",
      title: "ACA MAGI is close to a subsidy threshold",
      detail: `Year-1 modeled MAGI is within ${formatCurrency(Math.abs(magiBuffer))} of the healthcare ceiling, so small income, dividend, or tax-harvest changes can alter subsidy results.`,
      action: "Review MAGI-producing income and keep a buffer before treating the healthcare recommendation as durable."
    });
  }

  if (aca.premiumInputMode === "net") {
    flags.push({
      id: "aca-net-premium-quote",
      level: CONFIDENCE_LEVELS.INPUT_LIMITED,
      lens: "cpa",
      title: "ACA premium tax credit is bypassed by a quoted net premium",
      detail: "Quoted net premium mode trusts the entered quote instead of recalculating the premium tax credit from SLCSP and MAGI.",
      action: "Use gross SLCSP and selected-plan premiums when you want an auditable Form 8962-style trace."
    });
  }
}

function acaBenchmarkGeographyFlag(aca) {
  if (aca.planCostMode === "selectedPlan") return null;

  const zip = normalizedZip(aca.zip);
  if (!zip) {
    return {
      id: "aca-plan-inputs",
      level: CONFIDENCE_LEVELS.INPUT_LIMITED,
      lens: "cpa",
      title: "ACA benchmark needs ZIP or exact plan data",
      detail: "The healthcare bridge is using the state-level benchmark because no ZIP is available to resolve a local rating-area SLCSP.",
      action: "Enter a ZIP for the offline rating-area SLCSP lookup, or use exact selected-plan premiums from the marketplace."
    };
  }

  let benchmark;
  try {
    benchmark = benchmarkPremiumForZip({
      zip,
      planYear: aca.year ?? 2026,
      age: aca.currentAge ?? null,
      householdAges: aca.currentMemberAges ?? aca.memberAges ?? null
    });
  } catch {
    return {
      id: "aca-plan-inputs",
      level: CONFIDENCE_LEVELS.INPUT_LIMITED,
      lens: "cpa",
      title: "ACA benchmark ZIP lookup needs covered ages",
      detail: `ZIP ${zip} is present, but the model needs marketplace member ages to age-rate the local SLCSP benchmark.`,
      action: "Enter covered member ages for ACA modeling or use exact selected-plan premiums from the marketplace."
    };
  }

  if (benchmark.fallback === null) {
    const area = benchmark.ratingArea;
    const areaText = area?.areaCode != null ? `${area.state} rating area ${area.areaCode}` : "a bundled rating area";
    // Provenance differs by path: federal-platform states come from the CMS
    // Rate PUFs; state-based exchanges come from the SBE rate bulletins. Don't
    // claim CMS-PUF provenance for SBE data.
    const slcspSource = benchmark.sources?.slcsp || "the bundled rating-area table";
    return {
      id: "aca-rating-area-slcsp",
      level: CONFIDENCE_LEVELS.HIGH,
      lens: "cpa",
      title: "ACA benchmark uses bundled rating-area SLCSP",
      detail: `ZIP ${zip} resolves offline to ${areaText}; the benchmark uses the second-lowest-cost silver premium from ${slcspSource}, age-rated to the covered household.`,
      action: "Use exact Marketplace selected-plan inputs when county service area, tobacco rating, CSR variant, or the chosen plan's OOP exposure matters."
    };
  }

  if (benchmark.fallback === "state") {
    const reason = benchmark.ratingArea?.state
      ? `${benchmark.ratingArea.state} is not covered by the bundled rating-area table or the ZIP could not resolve to an ingested rating area`
      : "the ZIP could not resolve to an ingested rating area";
    return {
      id: "aca-benchmark-state-fallback",
      level: CONFIDENCE_LEVELS.INPUT_LIMITED,
      lens: "cpa",
      title: "ACA benchmark fell back to state average",
      detail: `ZIP ${zip} was checked, but ${reason}. The model is still using an age-rated state-level SLCSP fallback instead of a local rating-area benchmark.`,
      action: "Use exact selected-plan inputs from the state exchange or Marketplace API when local healthcare costs could move the decision."
    };
  }

  return {
    id: "aca-benchmark-out-of-model",
    level: CONFIDENCE_LEVELS.OUT_OF_MODEL,
    lens: "cpa",
    title: "ACA benchmark ZIP is out of model",
    detail: `ZIP ${zip} does not resolve to an ACA marketplace geography covered by the offline tables, so the local SLCSP benchmark cannot be verified from ZIP alone.`,
    action: "Enter exact plan premiums manually if the household has marketplace coverage, or disable ACA when marketplace coverage does not apply."
  };
}

function addCoverageGapFlags(flags, scenario, plan = null) {
  // The Medicaid "coverage gap" exists in non-expansion states between
  // Medicaid eligibility and the 100% FPL PTC floor (IRC §36B(c)(1)(A)).
  // Roth-heavy retirement years can drop MAGI below 100% FPL, leaving the
  // household with neither Medicaid nor a premium tax credit. When a simulated
  // plan is available, prefer its actual year-by-year FPL percentages over a
  // generic state-level warning.
  if (scenario?.aca?.enabled === false) return;
  const state = scenario?.state;
  if (!state) return;

  const medicaid = STATE_MEDICAID_EXPANSION_2026.states?.[state];
  if (!medicaid) return;

  const isPartial = medicaid.expanded === "partial";
  const aca = scenario?.aca ?? {};
  const ptcFloorPercent = Number.isFinite(Number(aca.minEligibleFplPercent))
    ? Math.max(0, Number(aca.minEligibleFplPercent))
    : 100;
  const modeledGapYears = modeledMarketplaceYearsBelowFpl(plan, ptcFloorPercent);
  if (modeledGapYears.length && medicaid.expanded !== true) {
    flags.push({
      id: "aca-coverage-gap-modeled",
      level: CONFIDENCE_LEVELS.CPA_REVIEW,
      lens: "cpa",
      title: "Modeled MAGI enters the ACA coverage gap",
      detail: `${state} ${isPartial ? "has only partial Medicaid expansion" : "has not adopted Medicaid expansion"}, and the modeled plan drops below the ${formatPercent(ptcFloorPercent)} FPL PTC floor in ${formatModeledFplYears(modeledGapYears)}.`,
      action: "Before relying on healthcare or Roth-conversion actions, size income, Roth conversions, or taxable draws to keep ACA MAGI above the PTC floor, or model exact state Medicaid/alternative coverage for those years."
    });
    return;
  }

  if (medicaid.expanded === true) {
    const medicaidFloorPercent = 138;
    const modeledMedicaidYears = modeledMarketplaceYearsBelowFpl(plan, medicaidFloorPercent);
    if (modeledMedicaidYears.length) {
      flags.push({
        id: "aca-medicaid-handoff-modeled",
        level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
        lens: "cpa",
        title: "Modeled MAGI enters Medicaid/CHIP range",
        detail: `${state} has adopted Medicaid expansion, and the modeled plan drops below ${formatPercent(medicaidFloorPercent)} FPL in ${formatModeledFplYears(modeledMedicaidYears)}. ACA PTC math may no longer describe the household's actual coverage path in those years.`,
        action: "Check state Medicaid/CHIP eligibility, household member categories, and plan-transition timing before treating ACA premiums or MAGI-reduction moves as final."
      });
    }
    return;
  }

  if (Array.isArray(plan?.years) && !modeledGapYears.length) return;

  const detail = isPartial
    ? `${state} has only partial Medicaid expansion under a §1115 waiver, so the household can still fall into a coverage gap if planned MAGI drops below 100% FPL in low-income years.`
    : `${state} has not adopted Medicaid expansion, so a household whose modeled MAGI drops below 100% FPL in any year (often during Roth-heavy or low-conversion years) loses access to both Medicaid and ACA premium tax credits for that year.`;
  flags.push({
    id: "aca-coverage-gap-risk",
    level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
    lens: "cpa",
    title: "Coverage-gap risk in a non-expansion state",
    detail,
    action: "Inspect modeled MAGI by year. Years below ~100% FPL in this state lose PTC and fall outside Medicaid; consider sizing Roth conversions or taxable draws to keep MAGI above the floor in those years."
  });
}

function modeledMarketplaceYearsBelowFpl(plan, thresholdPercent) {
  if (!Array.isArray(plan?.years)) return [];
  return plan.years.filter((year) => {
    const aca = year?.aca ?? {};
    const fplPercent = Number(aca.fplPercent);
    if (!Number.isFinite(fplPercent) || fplPercent >= thresholdPercent) return false;
    return [
      aca.benchmarkPremium,
      aca.grossPremium,
      aca.netPremium,
      aca.subsidy,
      year.medicalCost
    ].some((value) => Number(value) > 0);
  });
}

function addStateTaxFlags(flags, taxProfile) {
  const state = taxProfile?.state;
  if (!state || state.source === "Manual override") return;
  const source = String(state.retirementRulesSource ?? "");
  if (source.includes("Best-effort") || source.includes("verify")) {
    flags.push({
      id: "state-retirement-tax-review",
      level: CONFIDENCE_LEVELS.CPA_REVIEW,
      lens: "cpa",
      title: "State retirement-tax rules need state-form review",
      detail: "The model uses broad state retirement-income and Social Security rules. Public pensions, military, railroad, disability, local taxes, credits, and part-year residency can differ.",
      action: "Use state overrides or CPA review before treating state-tax outputs as filing-grade."
    });
  }
}

function addFederalTaxScopeFlags(flags, scenario = {}, taxProfile = {}) {
  const manualFederalOverrides = manualFederalTaxOverrideSummary(taxProfile);
  if (manualFederalOverrides.hasManualFederalTaxOverride) {
    flags.push(manualFederalTaxOverrideReviewFlag(manualFederalOverrides));
  }

  const businessIncome = selfEmploymentIncomeSummary(scenario);
  if (businessIncome.hasSelfEmploymentIncome) {
    flags.push(businessIncomeReviewFlag(businessIncome));
  }
}

function manualFederalTaxOverrideReviewFlag(summary = {}) {
  return {
    id: "manual-federal-tax-overrides-review",
    level: CONFIDENCE_LEVELS.CPA_REVIEW,
    lens: "cpa",
    title: "Manual federal tax overrides need CPA review",
    detail: `Manual federal tax overrides are present${manualFederalTaxOverrideText(summary)}. The model applies these amounts mechanically, inflates them forward with the tax profile, and uses them in tax estimates, Roth-conversion bracket room, harvesting, and safe-spending results. It does not validate eligibility, phaseouts, itemized-deduction character, refundable versus nonrefundable credit treatment, or AMT/QBI interactions.`,
    action: "Keep a worksheet/source for each override and review it before treating tax-payment, Roth-conversion, harvesting, or safe-spending recommendations as filing-grade."
  };
}

function manualFederalTaxOverrideSummary(taxProfile = {}) {
  const additionalDeduction = Math.max(0, Number(taxProfile?.additionalDeduction) || 0);
  const additionalCredits = Math.max(0, Number(taxProfile?.additionalCredits) || 0);
  return {
    hasManualFederalTaxOverride: additionalDeduction > 0 || additionalCredits > 0,
    additionalDeduction,
    additionalCredits
  };
}

function manualFederalTaxOverrideText(summary = {}) {
  const parts = [];
  if (summary.additionalDeduction > 0) parts.push(`${formatCurrency(summary.additionalDeduction)} additional deduction`);
  if (summary.additionalCredits > 0) parts.push(`${formatCurrency(summary.additionalCredits)} additional credit`);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function businessIncomeReviewFlag(summary = {}) {
  return {
    id: "business-income-tax-review",
    level: CONFIDENCE_LEVELS.CPA_REVIEW,
    lens: "cpa",
    title: "Business income needs CPA review",
    detail: `Self-employment income is present${businessIncomeSummaryText(summary)}. The model applies Schedule SE self-employment tax and the one-half SE tax deduction, but it does not model business-expense substantiation, self-employed health insurance, solo retirement-plan deductions, pass-through K-1 detail, QBI/Form 8995 where applicable, AMT interactions, or estimated-tax/withholding timing.`,
    action: "Use manual deduction/credit overrides for known business-tax adjustments, and review business-income years with a CPA before acting on income-bridge, Roth-conversion, or tax-payment recommendations."
  };
}

function selfEmploymentIncomeSummary(scenario = {}) {
  const annualAmount = Math.max(0, Number(scenario?.selfEmploymentIncome) || 0);
  const oneOffs = Array.isArray(scenario?.oneOffExpenses) ? scenario.oneOffExpenses : [];
  const selfEmploymentOneOffs = oneOffs.filter((item) => (
    item?.cashFlowType === "selfEmploymentIncome" && Number(item?.amount) > 0
  ));
  const oneOffTotal = selfEmploymentOneOffs.reduce((total, item) => total + Math.max(0, Number(item.amount) || 0), 0);
  return {
    hasSelfEmploymentIncome: annualAmount > 0 || oneOffTotal > 0,
    annualAmount,
    oneOffCount: selfEmploymentOneOffs.length,
    oneOffTotal
  };
}

function businessIncomeSummaryText(summary = {}) {
  const parts = [];
  if (summary.annualAmount > 0) parts.push(`${formatCurrency(summary.annualAmount)} annual self-employment income`);
  if (summary.oneOffTotal > 0) {
    parts.push(`${formatCurrency(summary.oneOffTotal)} scheduled self-employment bridge income across ${summary.oneOffCount} one-off cash flow${summary.oneOffCount === 1 ? "" : "s"}`);
  }
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function addEvidenceFlags(flags, decision, historicalCoverage, historicalAssetClasses) {
  if (!decision || decision.status === "running") return;
  const base = decision.base ?? {};
  const historicalCount = Number(base.historical?.count);
  if (!(historicalCount > 0)) {
    flags.push({
      id: "historical-evidence-missing",
      level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
      lens: "engineering",
      title: "Historical cohort evidence is unavailable",
      detail: "The decision verdict is relying on Monte Carlo because no historical backtest cohort was available for the selected asset mix and range.",
      action: historicalCoverageAction(historicalCoverage, historicalAssetClasses)
    });
  }

  const mcPasses = base.verdict?.monteCarloPasses;
  const historicalPasses = base.verdict?.historicalPasses;
  if (base.verdict?.historicalKnown && typeof mcPasses === "boolean" && typeof historicalPasses === "boolean" && mcPasses !== historicalPasses) {
    flags.push({
      id: "evidence-disagreement",
      level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
      lens: "engineering",
      title: "Monte Carlo and history disagree",
      detail: "The verdict is fragile because the stochastic and historical evidence do not clear the decision target in the same way.",
      action: "Inspect the worst historical path and rerun sensitivity cases before acting on a rescue option."
    });
  }
}

function addSocialSecurityFlags(flags, scenario) {
  const hasEnteredBenefit = Number(scenario?.socialSecurityAnnualBenefit) > 0
    || Number(scenario?.spouseSocialSecurityAnnualBenefit) > 0;
  const usesEarningsEstimator = scenario?.estimateSocialSecurityFromEarnings === true;
  if (!hasEnteredBenefit && !usesEarningsEstimator) return;

  if (usesEarningsEstimator) {
    flags.push({
      id: "social-security-claiming-inputs",
      level: CONFIDENCE_LEVELS.INPUT_LIMITED,
      lens: "cpa",
      title: "Social Security PIA estimate uses a coarse earnings proxy",
      detail: "The opt-in estimator uses source-versioned 2026 SSA PIA bend points, but it treats entered annual wages as career-average AIME rather than a 35-year indexed earnings record.",
      action: "Enter verified SSA benefit estimates when available; use the estimator only for planning sensitivity around claiming ages."
    });
    return;
  }

  flags.push({
    id: "social-security-claiming-inputs",
    level: CONFIDENCE_LEVELS.INPUT_LIMITED,
    lens: "cpa",
    title: "Social Security claiming uses entered benefit timing",
    detail: "The action plan uses the entered annual benefit and start age. The claiming solver can compare coarse claiming ages, but it is still a planning model rather than an SSA filing calculator.",
    action: "Use verified SSA benefit estimates and review claiming-date recommendations before acting, especially for survivor or spousal benefit cases."
  });
}

function addLegacyFlags(flags, scenario = {}) {
  const heirIncome = Number(scenario?.heirBaseIncome);
  const heirAge = Number(scenario?.heirAge);
  const usesDefaultHeirIncome = !Number.isFinite(heirIncome) || heirIncome === 80000;
  const usesDefaultHeirAge = !Number.isFinite(heirAge) || heirAge === 30;
  const assumptionNote = (usesDefaultHeirIncome || usesDefaultHeirAge)
    ? ` Heir income and age default to $${(Number.isFinite(heirIncome) ? heirIncome : 80000).toLocaleString("en-US")} and age ${Number.isFinite(heirAge) ? heirAge : 30} when not entered, which materially drives the modeled heir tax — set them for your heirs.`
    : "";
  flags.push({
    id: "legacy-tax-out-of-model",
    level: CONFIDENCE_LEVELS.CPA_REVIEW,
    lens: "cpa",
    title: "Legacy/estate estimate needs professional review",
    detail: "The bequest estimate now models per-account spouse, non-spouse 10-year, and eligible-designated inherited-account treatment with heir bracket stacking, the federal estate tax (40% above the 2026 $15M exclusion, spouse exempt), and state inheritance tax for a lineal-descendant heir (PA/NE; NJ/MD lineal-exempt). These are planning approximations, not estate-plan-grade: non-lineal relationship classes, trust beneficiaries, portability/state estate taxes, and exact IRS Single Life Table divisors are not fully modeled." + assumptionNote,
    action: "Use the after-tax bequest as a planning estimate; confirm account beneficiaries and heir inputs, then add CPA/estate review before optimizing for heirs."
  });
}

function actionConfidenceFromFlag(flag = {}) {
  return {
    level: flag.level ?? CONFIDENCE_LEVELS.INPUT_LIMITED,
    label: shortConfidenceLabel(flag.level),
    title: flag.title ?? confidenceLevelLabel(flag.level),
    detail: flag.action ?? flag.detail ?? ""
  };
}

function findFlagByPriority(flags, ids) {
  for (const id of ids) {
    const flag = flags.find((item) => item.id === id);
    if (flag) return flag;
  }
  return null;
}

function rescueFlagIds(kind) {
  switch (kind) {
    case "healthcareRescue":
      return ["aca-coverage-gap-modeled", "aca-medicaid-handoff-modeled", "aca-coverage-gap-risk", "aca-plan-inputs", "aca-benchmark-state-fallback", "aca-benchmark-out-of-model", "aca-oop-inputs", "aca-net-premium-quote", "aca-magi-threshold"];
    case "rothBasisCliffRescue":
    case "conversionGuardrail":
    case "magiSpendTrim":
      return ["aca-coverage-gap-modeled", "aca-medicaid-handoff-modeled", "aca-coverage-gap-risk", "manual-federal-tax-overrides-review", "aca-magi-threshold", "aca-plan-inputs", "aca-benchmark-state-fallback", "aca-benchmark-out-of-model", "aca-oop-inputs", "aca-net-premium-quote"];
    case "taxableLotRescue":
      return ["manual-federal-tax-overrides-review", "aca-magi-threshold"];
    case "withdrawalShift":
    case "safeSpending":
      return ["manual-federal-tax-overrides-review", "state-retirement-tax-review"];
    case "incomeBridge":
    case "combined":
      return ["business-income-tax-review"];
    case "socialSecurityBridge":
      return ["social-security-claiming-inputs"];
    default:
      return [];
  }
}

function normalizedZip(zip) {
  if (zip == null) return "";
  const text = String(zip).trim();
  const plus4 = text.match(/^(\d{5})-\d{4}$/);
  return plus4 ? plus4[1] : text;
}

function shortConfidenceLabel(level) {
  switch (level) {
    case CONFIDENCE_LEVELS.HIGH:
      return "High";
    case CONFIDENCE_LEVELS.INPUT_LIMITED:
      return "Input";
    case CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE:
      return "Sensitive";
    case CONFIDENCE_LEVELS.CPA_REVIEW:
      return "CPA";
    case CONFIDENCE_LEVELS.OUT_OF_MODEL:
      return "Excluded";
    default:
      return "Flag";
  }
}

function confidenceHeadline(flags) {
  for (const level of HEADLINE_PRIORITY) {
    if (flags.some((flag) => flag.level === level)) {
      return confidenceLevelLabel(level);
    }
  }
  if (flags.some((flag) => flag.level === CONFIDENCE_LEVELS.OUT_OF_MODEL)) {
    return "Known exclusions";
  }
  return confidenceLevelLabel(CONFIDENCE_LEVELS.HIGH);
}

function historicalCoverageAction(historicalCoverage, historicalAssetClasses) {
  const classes = Array.isArray(historicalAssetClasses) && historicalAssetClasses.length
    ? historicalAssetClasses.join(", ")
    : "the selected asset classes";
  const coverage = historicalCoverage?.startYear && historicalCoverage?.endYear
    ? `Current coverage for ${classes}: ${historicalCoverage.startYear}-${historicalCoverage.endYear}.`
    : `Check historical coverage for ${classes}.`;
  return `${coverage} Enable documented proxies or adjust the historical range when appropriate.`;
}

function formatCurrency(value) {
  const amount = Math.round(Number(value) || 0);
  return `$${amount.toLocaleString("en-US")}`;
}

function formatPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "100%";
  return `${Math.round(percent * 10) / 10}%`;
}

function formatModeledFplYears(years) {
  const visible = years.slice(0, 3).map((year) => {
    const label = Number.isFinite(Number(year.year)) ? String(year.year) : `year ${year.yearIndex ?? "?"}`;
    return `${label} (${formatPercent(year.aca?.fplPercent)} FPL)`;
  });
  const remaining = years.length - visible.length;
  return remaining > 0
    ? `${visible.join(", ")}, and ${remaining} more year${remaining === 1 ? "" : "s"}`
    : visible.join(", ");
}
