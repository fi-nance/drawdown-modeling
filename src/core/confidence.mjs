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
  const find = (ids) => flags.find((flag) => ids.includes(flag.id));

  if (["aca", "medicalReserve"].includes(actionKind)) {
    const flag = find(["aca-plan-inputs", "aca-benchmark-state-fallback", "aca-benchmark-out-of-model", "aca-oop-inputs", "aca-net-premium-quote", "aca-magi-threshold"]);
    if (flag) return actionConfidenceFromFlag(flag);
  }

  if (["magiManagement", "rothConversion", "taxGainHarvesting"].includes(actionKind) && has("aca-magi-threshold")) {
    return actionConfidenceFromFlag(flags.find((flag) => flag.id === "aca-magi-threshold"));
  }

  if (["taxReserve", "traditionalWithdrawal", "stateTax"].includes(actionKind) && has("state-retirement-tax-review")) {
    return actionConfidenceFromFlag(flags.find((flag) => flag.id === "state-retirement-tax-review"));
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
  const find = (ids) => flags.find((flag) => ids.includes(flag.id));
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
  historicalCoverage = null,
  historicalAssetClasses = []
} = {}) {
  const flags = [];
  addHealthcareFlags(flags, scenario, decision);
  addCoverageGapFlags(flags, scenario);
  addStateTaxFlags(flags, taxProfile);
  addEvidenceFlags(flags, decision, historicalCoverage, historicalAssetClasses);
  addSocialSecurityFlags(flags, scenario);
  addLegacyFlags(flags);

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
    return {
      id: "aca-rating-area-slcsp",
      level: CONFIDENCE_LEVELS.HIGH,
      lens: "cpa",
      title: "ACA benchmark uses bundled rating-area SLCSP",
      detail: `ZIP ${zip} resolves offline to ${areaText}; the benchmark uses the CMS 2026 rating-area second-lowest-cost silver premium age-rated to the covered household.`,
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

function addCoverageGapFlags(flags, scenario) {
  // The Medicaid "coverage gap" exists in non-expansion states between
  // Medicaid eligibility and the 100% FPL PTC floor (IRC §36B(c)(1)(A)).
  // Roth-heavy retirement years can drop MAGI below 100% FPL, leaving the
  // household with neither Medicaid nor a premium tax credit. This flag
  // notifies users in affected states so they can model around it.
  // Suppressed when ACA is disabled or the household has no state set.
  if (scenario?.aca?.enabled === false) return;
  const state = scenario?.state;
  if (!state) return;

  const medicaid = STATE_MEDICAID_EXPANSION_2026.states?.[state];
  if (!medicaid) return;
  if (medicaid.expanded === true) return;

  const isPartial = medicaid.expanded === "partial";
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
  if (!(Number(scenario?.socialSecurityAnnualBenefit) > 0)) return;
  flags.push({
    id: "social-security-claiming-inputs",
    level: CONFIDENCE_LEVELS.INPUT_LIMITED,
    lens: "cpa",
    title: "Social Security claiming uses entered benefit timing",
    detail: "The action plan uses the entered annual benefit and start age. It does not yet derive PIA from earnings history or optimize survivor claiming across both spouses.",
    action: "Enter verified SSA benefit estimates and treat claiming-date recommendations as planning outputs until earnings-history and survivor optimization are modeled."
  });
}

function addLegacyFlags(flags) {
  flags.push({
    id: "legacy-tax-out-of-model",
    level: CONFIDENCE_LEVELS.OUT_OF_MODEL,
    lens: "cpa",
    title: "Legacy strategy is residual-value only today",
    detail: "Heir after-tax inheritance, inherited IRA 10-year rules, estate/inheritance tax, beneficiary type, and taxable step-up are not modeled yet.",
    action: "Treat bequest values as pre-estate-planning planning outputs until heir and estate inputs are added."
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

function rescueFlagIds(kind) {
  switch (kind) {
    case "healthcareRescue":
      return ["aca-plan-inputs", "aca-benchmark-state-fallback", "aca-benchmark-out-of-model", "aca-oop-inputs", "aca-net-premium-quote", "aca-magi-threshold"];
    case "rothBasisCliffRescue":
    case "conversionGuardrail":
    case "magiSpendTrim":
      return ["aca-magi-threshold", "aca-plan-inputs", "aca-benchmark-state-fallback", "aca-benchmark-out-of-model", "aca-oop-inputs", "aca-net-premium-quote"];
    case "taxableLotRescue":
      return ["aca-magi-threshold"];
    case "withdrawalShift":
    case "safeSpending":
      return ["state-retirement-tax-review"];
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
