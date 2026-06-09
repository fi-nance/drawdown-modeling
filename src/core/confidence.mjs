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
    const flag = find(["amt-exposure-review", "qbi-deduction-review", "additional-child-tax-credit-review", "manual-federal-tax-overrides-review", "itemized-deduction-inputs-review", "enhanced-senior-deduction-eligibility"]);
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

  if (actionKind === "earnedIncome") {
    const flag = find(["business-income-tax-review", "additional-child-tax-credit-review"]);
    if (flag) return actionConfidenceFromFlag(flag);
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

  if (kind === "riskBasedGuardrailsRescue") {
    return {
      level: CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE,
      label: "Sensitive",
      title: "Historical guardrail assumptions",
      detail: "This option derives its lower and upper spending triggers from the selected historical cohorts, spending target, and income inputs. Re-run it when those inputs or the historical range change."
    };
  }

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
  addFederalTaxScopeFlags(flags, scenario, taxProfile, plan);
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

function addFederalTaxScopeFlags(flags, scenario = {}, taxProfile = {}, plan = null) {
  const enhancedSeniorDeduction = enhancedSeniorDeductionAssumptionSummary(scenario, taxProfile);
  if (enhancedSeniorDeduction.hasPotentialDeduction) {
    flags.push(enhancedSeniorDeductionEligibilityFlag(enhancedSeniorDeduction));
  }

  const manualFederalOverrides = manualFederalTaxOverrideSummary(taxProfile);
  if (manualFederalOverrides.hasManualFederalTaxOverride) {
    flags.push(manualFederalTaxOverrideReviewFlag(manualFederalOverrides));
  }

  const itemizedDeductions = itemizedDeductionSummary(taxProfile);
  if (itemizedDeductions.hasItemizedInput) {
    flags.push(itemizedDeductionReviewFlag(itemizedDeductions));
  }

  const alternativeMinimumTax = alternativeMinimumTaxSummary({ scenario, taxProfile, plan });
  if (alternativeMinimumTax.hasAmtExposure) {
    flags.push(alternativeMinimumTaxReviewFlag(alternativeMinimumTax));
  }

  const qbiDeduction = qualifiedBusinessIncomeDeductionSummary(taxProfile);
  if (qbiDeduction.hasQbiInput) {
    flags.push(qualifiedBusinessIncomeDeductionReviewFlag(qbiDeduction));
  }

  const refundableChildCredit = additionalChildTaxCreditSummary({ scenario, taxProfile, plan });
  if (refundableChildCredit.hasActcReview) {
    flags.push(additionalChildTaxCreditReviewFlag(refundableChildCredit));
  }

  const businessIncome = selfEmploymentIncomeSummary(scenario);
  if (businessIncome.hasSelfEmploymentIncome) {
    flags.push(businessIncomeReviewFlag(businessIncome));
  }
}

function enhancedSeniorDeductionEligibilityFlag(summary = {}) {
  return {
    id: "enhanced-senior-deduction-eligibility",
    level: CONFIDENCE_LEVELS.INPUT_LIMITED,
    lens: "cpa",
    title: "Enhanced senior deduction assumes SSN eligibility",
    detail: `The model can apply the 2025-2028 enhanced senior deduction in ${summary.firstEligibleYear}-${summary.lastEligibleYear} based on age and filing status. It assumes each qualifying taxpayer has a valid SSN and, when married, files jointly; those Schedule 1-A eligibility facts are not separately collected.`,
    action: "Confirm SSN and filing-status eligibility before relying on Roth-conversion room, tax-payment estimates, or spending headroom created by the enhanced senior deduction."
  };
}

function enhancedSeniorDeductionAssumptionSummary(scenario = {}, taxProfile = {}) {
  const config = taxProfile?.enhancedSeniorDeduction;
  if (!config || taxProfile?.filingStatus === "marriedFilingSeparately") {
    return { hasPotentialDeduction: false };
  }

  const startYear = Number(scenario?.startYear ?? taxProfile?.year);
  const planYears = Math.max(1, Math.trunc(Number(scenario?.planYears) || 1));
  const currentAge = Number(scenario?.currentAge);
  const spouseAge = Number(scenario?.spouseAge);
  const effectiveStart = Number(config.effectiveStartYear);
  const effectiveEnd = Number(config.effectiveEndYear);
  const eligibleYears = [];

  for (let index = 0; index < planYears; index += 1) {
    const year = Number.isFinite(startYear) ? startYear + index : Number(taxProfile?.year) + index;
    if (!Number.isFinite(year)) continue;
    if (Number.isFinite(effectiveStart) && year < effectiveStart) continue;
    if (Number.isFinite(effectiveEnd) && year > effectiveEnd) continue;
    const primaryEligible = Number.isFinite(currentAge) && currentAge + index >= 65;
    const spouseEligible = taxProfile?.filingStatus === "marriedFilingJointly"
      && Number.isFinite(spouseAge)
      && spouseAge + index >= 65;
    if (primaryEligible || spouseEligible) eligibleYears.push(year);
  }

  return {
    hasPotentialDeduction: eligibleYears.length > 0,
    firstEligibleYear: eligibleYears[0],
    lastEligibleYear: eligibleYears.at(-1)
  };
}

function itemizedDeductionReviewFlag(summary = {}) {
  return {
    id: "itemized-deduction-inputs-review",
    level: CONFIDENCE_LEVELS.CPA_REVIEW,
    lens: "cpa",
    title: "Itemized deduction inputs need Schedule A review",
    detail: `Schedule A itemized deduction controls are present${itemizedDeductionSummaryText(summary)}. The model compares standard versus itemized deductions, applies the 2026 SALT cap and medical-expense AGI floor, and treats entered mortgage interest and charitable gifts as already deductible amounts. It does not validate mortgage acquisition-debt limits, charitable substantiation/AGI caps, state-tax-credit charitable safe harbors, reimbursement rules, casualty losses, or foreign/territory income addbacks for the SALT phaseout.`,
    action: "Keep Schedule A support for the entered amounts and review deduction-sensitive Roth-conversion, harvesting, spending, and tax-payment recommendations before treating them as filing-grade."
  };
}

function itemizedDeductionSummary(taxProfile = {}) {
  const itemized = taxProfile?.itemizedDeductions ?? {};
  const amounts = {
    stateLocalTaxes: Math.max(0, Number(itemized.stateLocalTaxes) || 0),
    mortgageInterest: Math.max(0, Number(itemized.mortgageInterest) || 0),
    charitableContributions: Math.max(0, Number(itemized.charitableContributions) || 0),
    medicalExpenses: Math.max(0, Number(itemized.medicalExpenses) || 0)
  };
  const mode = itemized.mode ?? "auto";
  return {
    mode,
    amounts,
    hasItemizedInput: mode !== "auto" || Object.values(amounts).some((value) => value > 0)
  };
}

function itemizedDeductionSummaryText(summary = {}) {
  const parts = [];
  if (summary.mode && summary.mode !== "auto") parts.push(`mode ${summary.mode}`);
  const labels = {
    stateLocalTaxes: "SALT paid",
    mortgageInterest: "mortgage interest",
    charitableContributions: "charitable gifts",
    medicalExpenses: "medical expenses"
  };
  for (const [key, label] of Object.entries(labels)) {
    const value = summary.amounts?.[key] ?? 0;
    if (value > 0) parts.push(`${label} ${formatCurrency(value)}`);
  }
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function alternativeMinimumTaxReviewFlag(summary = {}) {
  return {
    id: "amt-exposure-review",
    level: CONFIDENCE_LEVELS.CPA_REVIEW,
    lens: "cpa",
    title: "AMT exposure needs Form 6251 review",
    detail: `AMT tripwire is active${alternativeMinimumTaxSummaryText(summary)}. The model source-versions the 2026 AMT exemption (${formatCurrency(summary.exemption)} for ${readableFilingStatus(summary.filingStatus)}), phaseout threshold (${formatCurrency(summary.phaseoutThreshold)}), complete phaseout (${formatCurrency(summary.completePhaseout)}), and 28% rate threshold (${formatCurrency(summary.rateThreshold)}). It does not calculate tentative minimum tax, AMT foreign tax credit, private-activity bond interest, ISO/depreciation/passive-loss adjustments, K-1 AMT items, or full Form 6251 adjustments/preferences.`,
    action: "Review Roth conversions, gain harvesting, withdrawal sequencing, tax reserves, and safe-spending recommendations under Form 6251 before acting."
  };
}

function alternativeMinimumTaxSummary({ scenario = {}, taxProfile = {}, plan = null } = {}) {
  const config = taxProfile?.alternativeMinimumTax;
  if (!config) return { hasAmtExposure: false };

  const filingStatus = taxProfile?.filingStatus ?? scenario?.filingStatus ?? "marriedFilingJointly";
  const exemption = finiteOrNull(config.exemption?.[filingStatus]);
  const phaseoutThreshold = finiteOrNull(config.phaseoutThreshold?.[filingStatus]);
  const completePhaseout = finiteOrNull(config.completePhaseout?.[filingStatus]);
  const rateThreshold = finiteOrNull(config.rateThreshold?.[filingStatus]);
  const preferenceItems = Math.max(0, Number(taxProfile?.amtPreferenceItems) || 0);
  const itemized = taxProfile?.itemizedDeductions ?? {};
  const scheduleATaxAddbackExposure = Math.max(0, Number(itemized.stateLocalTaxes) || 0);
  const standardDeductionAddbackExposure = Math.max(0, Number(taxProfile?.standardDeduction) || 0);
  const reviewThreshold = Number.isFinite(phaseoutThreshold) ? phaseoutThreshold * 0.9 : Infinity;
  const highIncomeYears = modeledAmtIncomeYears(plan, reviewThreshold);

  return {
    hasAmtExposure: preferenceItems > 0 || highIncomeYears.length > 0,
    filingStatus,
    exemption,
    phaseoutThreshold,
    completePhaseout,
    rateThreshold,
    preferenceItems,
    scheduleATaxAddbackExposure,
    standardDeductionAddbackExposure,
    highIncomeYears,
    reviewThreshold
  };
}

function modeledAmtIncomeYears(plan = null, reviewThreshold = Infinity) {
  if (!Array.isArray(plan?.years) || !Number.isFinite(reviewThreshold)) return [];
  return plan.years
    .filter((year) => !year?.postMortality)
    .map((year) => {
      const income = Math.max(
        0,
        Number(year?.federalAgi) || 0,
        Number(year?.irmaaMagi) || 0,
        Number(year?.acaMagi) || 0,
        Number(year?.magi) || 0
      );
      return {
        year: year?.year ?? year?.calendarYear ?? year?.yearIndex ?? "?",
        income
      };
    })
    .filter((year) => year.income >= reviewThreshold)
    .slice(0, 5);
}

function alternativeMinimumTaxSummaryText(summary = {}) {
  const parts = [];
  if (summary.preferenceItems > 0) {
    parts.push(`entered Form 6251 preference/addbacks ${formatCurrency(summary.preferenceItems)}`);
  }
  if (summary.highIncomeYears?.length) {
    parts.push(`modeled income near AMT phaseout in ${formatModeledAmtYears(summary.highIncomeYears)}`);
  }
  if (summary.scheduleATaxAddbackExposure > 0) {
    parts.push(`Schedule A tax addback exposure ${formatCurrency(summary.scheduleATaxAddbackExposure)}`);
  } else if (summary.standardDeductionAddbackExposure > 0 && summary.highIncomeYears?.length) {
    parts.push(`standard-deduction AMT addback exposure ${formatCurrency(summary.standardDeductionAddbackExposure)}`);
  }
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function formatModeledAmtYears(years = []) {
  return years.map((year) => `${year.year} (${formatCurrency(year.income)})`).join(", ");
}

function qualifiedBusinessIncomeDeductionReviewFlag(summary = {}) {
  return {
    id: "qbi-deduction-review",
    level: CONFIDENCE_LEVELS.CPA_REVIEW,
    lens: "cpa",
    title: "QBI deduction needs Form 8995 review",
    detail: `Section 199A QBI planning is active${qualifiedBusinessIncomeDeductionSummaryText(summary)}. The model applies the 2026 20% QBI rule, taxable-income cap, W-2 wage/UBIA limits, SSTB phaseout, and $400 active-QBI minimum when entered facts support it. It does not validate Form 8995/8995-A support, trade-or-business status, material participation, K-1 aggregation, QBI loss carryforwards, REIT/PTP components, cooperative patron reductions, reasonable compensation, guaranteed payments, or whether self-employment income is already net of QBI-attributable deductions.`,
    action: "Review Form 8995/8995-A support before relying on Roth-conversion room, tax reserves, income-bridge rescues, or safe-spending results affected by QBI."
  };
}

function qualifiedBusinessIncomeDeductionSummary(taxProfile = {}) {
  const qbi = taxProfile?.qualifiedBusinessIncome ?? {};
  const sourceMode = ["manual", "selfEmployment"].includes(qbi.sourceMode) ? qbi.sourceMode : "none";
  return {
    hasQbiInput: sourceMode !== "none",
    sourceMode,
    amount: Math.max(0, Number(qbi.amount) || 0),
    specifiedServiceBusiness: qbi.specifiedServiceBusiness === true,
    w2Wages: Math.max(0, Number(qbi.w2Wages) || 0),
    ubiaQualifiedProperty: Math.max(0, Number(qbi.ubiaQualifiedProperty) || 0)
  };
}

function qualifiedBusinessIncomeDeductionSummaryText(summary = {}) {
  const parts = [];
  if (summary.sourceMode === "manual") parts.push(`manual QBI ${formatCurrency(summary.amount)}`);
  if (summary.sourceMode === "selfEmployment") parts.push("QBI derived from self-employment income after the half-SE-tax deduction");
  if (summary.specifiedServiceBusiness) parts.push("SSTB selected");
  if (summary.w2Wages > 0) parts.push(`QBI W-2 wages ${formatCurrency(summary.w2Wages)}`);
  if (summary.ubiaQualifiedProperty > 0) parts.push(`UBIA property ${formatCurrency(summary.ubiaQualifiedProperty)}`);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function manualFederalTaxOverrideReviewFlag(summary = {}) {
  return {
    id: "manual-federal-tax-overrides-review",
    level: CONFIDENCE_LEVELS.CPA_REVIEW,
    lens: "cpa",
    title: "Manual federal tax overrides need CPA review",
    detail: `Manual federal tax overrides are present${manualFederalTaxOverrideText(summary)}. The model applies these amounts mechanically, inflates them forward with the tax profile, and uses them in tax estimates, Roth-conversion bracket room, harvesting, and safe-spending results. It does not validate eligibility, phaseouts, refundable versus nonrefundable credit treatment, or AMT/QBI interactions.`,
    action: "Keep a worksheet/source for each override and review it before treating tax-payment, Roth-conversion, harvesting, or safe-spending recommendations as filing-grade."
  };
}

function additionalChildTaxCreditReviewFlag(summary = {}) {
  return {
    id: "additional-child-tax-credit-review",
    level: CONFIDENCE_LEVELS.CPA_REVIEW,
    lens: "cpa",
    title: "Additional Child Tax Credit needs Schedule 8812 review",
    detail: `Refundable child credit modeling is active${additionalChildTaxCreditSummaryText(summary)}. The model applies the common Schedule 8812 limit: unused Child Tax Credit, capped by the refundable per-child amount and 15% of earned income above $2,500. It does not validate taxpayer/child SSNs, relationship/residency/support facts, Form 2555 foreign earned-income exclusion, nontaxable combat pay elections, Medicaid waiver payment choices, EITC coordination, Puerto Rico rules, or the three-or-more-child Social Security tax comparison.`,
    action: "Review Schedule 8812 before relying on tax refunds, income-bridge rescues, safe-spending room, or MAGI-sensitive tax moves created by ACTC."
  };
}

function additionalChildTaxCreditSummary({ scenario = {}, taxProfile = {}, plan = null } = {}) {
  const planYears = Array.isArray(plan?.years) ? plan.years : [];
  const actcYears = planYears
    .filter((year) => Number(year?.taxes?.additionalChildTaxCredit) > 0)
    .map((year) => ({
      year: year?.year ?? year?.calendarYear ?? year?.yearIndex ?? "?",
      amount: Number(year?.taxes?.additionalChildTaxCredit) || 0
    }))
    .slice(0, 5);
  const threeOrMoreReviewYears = planYears
    .filter((year) => year?.taxes?.childTaxCreditBreakdown?.threeOrMoreChildReviewApplies === true)
    .map((year) => year?.year ?? year?.calendarYear ?? year?.yearIndex ?? "?")
    .slice(0, 5);
  const potentialFromInputs = Math.max(0, Number(taxProfile?.qualifyingChildren) || 0) > 0
    && refundableCreditEarnedIncomeInputPresent(scenario);

  return {
    hasActcReview: actcYears.length > 0 || threeOrMoreReviewYears.length > 0 || (!planYears.length && potentialFromInputs),
    actcYears,
    threeOrMoreReviewYears,
    qualifyingChildren: Math.max(0, Number(taxProfile?.qualifyingChildren) || 0)
  };
}

function refundableCreditEarnedIncomeInputPresent(scenario = {}) {
  if (Number(scenario?.medicareWages) > 0 || Number(scenario?.selfEmploymentIncome) > 0 || Number(scenario?.rrtaCompensation) > 0) {
    return true;
  }
  const oneOffs = Array.isArray(scenario?.oneOffExpenses) ? scenario.oneOffExpenses : [];
  return oneOffs.some((item) => (
    ["medicareWages", "selfEmploymentIncome", "rrtaCompensation"].includes(item?.cashFlowType)
    && Number(item?.amount) > 0
  ));
}

function additionalChildTaxCreditSummaryText(summary = {}) {
  const parts = [];
  if (summary.actcYears?.length) {
    parts.push(`ACTC appears in ${summary.actcYears.map((year) => `${year.year} (${formatCurrency(year.amount)})`).join(", ")}`);
  }
  if (summary.threeOrMoreReviewYears?.length) {
    parts.push(`three-or-more-child review in ${summary.threeOrMoreReviewYears.join(", ")}`);
  }
  if (!parts.length && summary.qualifyingChildren > 0) {
    parts.push(`${summary.qualifyingChildren} qualifying child${summary.qualifyingChildren === 1 ? "" : "ren"} with earned-income inputs`);
  }
  return parts.length ? ` (${parts.join("; ")})` : "";
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
    detail: `Self-employment income is present${businessIncomeSummaryText(summary)}. The model applies Schedule SE self-employment tax and the one-half SE tax deduction, and can derive QBI from self-employment income when QBI planning is enabled, but it does not model business-expense substantiation, self-employed health insurance, solo retirement-plan deductions, pass-through K-1 detail, full Form 8995/8995-A support, AMT interactions, or estimated-tax/withholding timing.`,
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
      return ["amt-exposure-review", "qbi-deduction-review", "additional-child-tax-credit-review", "aca-coverage-gap-modeled", "aca-medicaid-handoff-modeled", "aca-coverage-gap-risk", "manual-federal-tax-overrides-review", "itemized-deduction-inputs-review", "enhanced-senior-deduction-eligibility", "aca-magi-threshold", "aca-plan-inputs", "aca-benchmark-state-fallback", "aca-benchmark-out-of-model", "aca-oop-inputs", "aca-net-premium-quote"];
    case "taxableLotRescue":
      return ["amt-exposure-review", "qbi-deduction-review", "additional-child-tax-credit-review", "manual-federal-tax-overrides-review", "itemized-deduction-inputs-review", "enhanced-senior-deduction-eligibility", "aca-magi-threshold"];
    case "withdrawalShift":
    case "safeSpending":
    case "riskBasedGuardrailsRescue":
      return ["amt-exposure-review", "qbi-deduction-review", "additional-child-tax-credit-review", "manual-federal-tax-overrides-review", "itemized-deduction-inputs-review", "enhanced-senior-deduction-eligibility", "state-retirement-tax-review"];
    case "incomeBridge":
    case "combined":
      return ["amt-exposure-review", "qbi-deduction-review", "additional-child-tax-credit-review", "business-income-tax-review"];
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

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readableFilingStatus(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
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
