import { compactLatestForCache, MODEL_VERSION } from "./resultsCache.mjs";
import { inheritanceTaxStateForScenario } from "./simulation/heirEstate.mjs";
import { normalizeSetupState } from "./setupBackup.mjs";

export const RESULT_AUDIT_BUNDLE_SCHEMA_VERSION = 3;
export const RESULT_AUDIT_SUMMARY_SCHEMA_VERSION = 2;
export const RESULT_AUDIT_BUNDLE_TYPE = "portfolio-success-lab-result-audit-bundle";
export const RESULT_AUDIT_BUNDLE_PRIVACY_NOTICE = "This bundle can include household ages, account balances, tax assumptions, healthcare inputs, heirs/goals, and modeled results. Keep it local unless you intentionally share it with a CPA or trusted reviewer.";

export function createResultAuditBundle({
  latest,
  setupState,
  auditRows = [],
  sourceVersions = {},
  exportedAt = new Date().toISOString()
} = {}) {
  if (!latest || typeof latest !== "object") {
    throw new Error("Result audit bundle requires a latest result object.");
  }
  if (!latest.plan || !latest.monteCarlo) {
    throw new Error("Result audit bundle requires completed plan and Monte Carlo results.");
  }

  return {
    app: "Portfolio Success Lab",
    type: RESULT_AUDIT_BUNDLE_TYPE,
    schemaVersion: RESULT_AUDIT_BUNDLE_SCHEMA_VERSION,
    exportedAt,
    privacyNotice: RESULT_AUDIT_BUNDLE_PRIVACY_NOTICE,
    sourceVersions: copyJsonObject(sourceVersions),
    reviewSummary: createResultAuditSummary({ latest, auditRows, sourceVersions, exportedAt }),
    setup: normalizeSetupState(setupState),
    audit: normalizeAuditRows(auditRows),
    result: compactLatestForCache(latest)
  };
}

export function createResultAuditSummary({
  latest,
  auditRows = [],
  sourceVersions = {},
  exportedAt = new Date().toISOString()
} = {}) {
  if (!latest || typeof latest !== "object") {
    throw new Error("Result audit summary requires a latest result object.");
  }
  const scenario = latest.scenario ?? {};
  const mcSummary = latest.monteCarlo?.summary ?? latest.monteCarlo?.progress ?? {};
  const decision = latest.decision ?? {};
  const confidence = latest.confidence ?? {};
  const flags = Array.isArray(confidence.flags) ? confidence.flags : [];
  const topSensitivity = Array.isArray(decision.sensitivity?.top) ? decision.sensitivity.top : [];

  return {
    schemaVersion: RESULT_AUDIT_SUMMARY_SCHEMA_VERSION,
    exportedAt,
    scenario: summarizeScenarioForReview(scenario),
    verdict: {
      planSuccess: latest.plan?.success ?? null,
      planningSuccess: latest.plan?.planningSuccess ?? null,
      spendingOutcome: latest.plan?.spendingOutcome ?? null,
      lifetimeHorizon: latest.plan?.lifetimeHorizon ?? null,
      requiredSpendingSuccessRate: finiteOrNull(mcSummary.planningSuccessRate),
      monteCarloSuccessRate: finiteOrNull(mcSummary.successRate),
      monteCarloRuns: finiteOrNull(mcSummary.runs ?? mcSummary.total),
      historicalBacktestCount: Array.isArray(latest.backtests) ? latest.backtests.length : 0,
      medianEndingValue: finiteOrNull(mcSummary.medianEndingValue),
      p10EndingValue: finiteOrNull(mcSummary.p10EndingValue),
      medianHeirValue: finiteOrNull(mcSummary.medianHeirValue),
      decisionStatus: decision.status ?? null,
      decisionTargetSuccessRate: finiteOrNull(decision.profile?.targetSuccessRate)
    },
    reproducibility: {
      modelVersion: MODEL_VERSION,
      seed: sourceVersions.seed ?? scenario.seed ?? null,
      monteCarloPreset: sourceVersions.monteCarloPreset ?? scenario.monteCarlo?.assumptionPreset ?? null,
      monteCarloRuns: sourceVersions.monteCarloRuns ?? finiteOrNull(mcSummary.runs ?? mcSummary.total),
      historicalDataSource: sourceVersions.historicalDataSource ?? latest.historicalDataSource ?? null,
      historicalRange: sourceVersions.historicalRange ?? latest.historicalRange ?? null
    },
    tax: summarizeTaxForReview(latest),
    gainHarvestingOptimization: copyJsonObject(latest.plan?.gainHarvestingOptimization),
    sourceVersions: copyJsonObject(sourceVersions),
    confidence: {
      headline: confidence.headline ?? null,
      flags: flags.map((flag) => ({
        id: String(flag.id ?? ""),
        level: flag.level ?? null,
        lens: flag.lens ?? null,
        title: flag.title ?? null,
        action: flag.action ?? null
      }))
    },
    sensitivity: topSensitivity.map((item) => ({
      id: String(item.id ?? ""),
      label: item.label ?? null,
      impact: finiteOrNull(item.impact)
    })),
    audit: normalizeAuditRows(auditRows)
  };
}

function summarizeTaxForReview(latest = {}) {
  const scenario = latest.scenario ?? {};
  const profile = latest.taxProfile ?? {};
  const stateProfile = profile.state ?? {};
  const years = Array.isArray(latest.plan?.years) ? latest.plan.years : [];
  const capitalLossYears = years
    .map(summarizeCapitalLossYearForReview)
    .filter(Boolean);
  const finalYearTaxes = years.length ? years[years.length - 1]?.taxes ?? {} : {};
  const stateReviewYears = capitalLossYears.filter((year) => year.stateReviewRequired);

  return {
    taxYear: profile.year ?? scenario.taxYear ?? null,
    filingStatus: profile.filingStatus ?? scenario.filingStatus ?? null,
    federal: {
      standardDeduction: finiteOrNull(profile.standardDeduction),
      capitalLossOrdinaryIncomeOffset: finiteOrNull(profile.capitalLossOrdinaryIncomeOffset)
    },
    state: {
      state: stateProfile.state ?? scenario.state ?? null,
      source: stateProfile.source ?? null,
      capitalGainsTreatment: stateProfile.capitalGainsTreatment ?? null,
      capitalLossConformity: stateProfile.capitalLossConformity ?? null
    },
    capitalLosses: {
      hasActivity: capitalLossYears.length > 0,
      yearCount: capitalLossYears.length,
      stateReviewRequired: stateReviewYears.length > 0,
      stateReviewYearCount: stateReviewYears.length,
      finalCarryforward: finiteOrNull(finalYearTaxes.lossCarryforward),
      finalCarryforwardShortTerm: finiteOrNull(finalYearTaxes.lossCarryforwardShort ?? latest.plan?.years?.at?.(-1)?.lossCarryforwardDetail?.shortTerm),
      finalCarryforwardLongTerm: finiteOrNull(finalYearTaxes.lossCarryforwardLong ?? latest.plan?.years?.at?.(-1)?.lossCarryforwardDetail?.longTerm),
      years: capitalLossYears
    }
  };
}

function summarizeCapitalLossYearForReview(year = {}) {
  const taxes = year?.taxes ?? {};
  const stateTreatment = taxes.stateTaxBreakdown?.capitalLossTreatment ?? null;
  const ordinaryLossOffset = finiteOrNull(taxes.ordinaryLossOffset);
  const lossCarryforward = finiteOrNull(taxes.lossCarryforward);
  const lossCarryforwardShort = finiteOrNull(taxes.lossCarryforwardShort ?? year?.lossCarryforwardDetail?.shortTerm);
  const lossCarryforwardLong = finiteOrNull(taxes.lossCarryforwardLong ?? year?.lossCarryforwardDetail?.longTerm);
  const hasActivity = [ordinaryLossOffset, lossCarryforward, lossCarryforwardShort, lossCarryforwardLong]
    .some((value) => Number(value) > 0)
    || stateTreatment?.reviewRequired === true;
  if (!hasActivity) return null;

  return {
    year: year.year ?? null,
    yearIndex: finiteOrNull(year.yearIndex),
    ordinaryLossOffset,
    lossCarryforward,
    lossCarryforwardShortTerm: lossCarryforwardShort,
    lossCarryforwardLongTerm: lossCarryforwardLong,
    federalAgi: finiteOrNull(taxes.federalAgi ?? taxes.magi),
    taxableOrdinaryIncome: finiteOrNull(taxes.taxableOrdinaryIncome),
    stateTax: finiteOrNull(taxes.stateTax),
    stateReviewRequired: stateTreatment?.reviewRequired === true,
    stateCapitalLossAssumption: stateTreatment?.assumption ?? null,
    stateOrdinaryTaxableBase: finiteOrNull(taxes.stateTaxBreakdown?.ordinaryTaxableBase)
  };
}

function summarizeScenarioForReview(scenario = {}) {
  return {
    taxYear: scenario.taxYear ?? null,
    startYear: scenario.startYear ?? null,
    planYears: scenario.planYears ?? null,
    state: scenario.state ?? null,
    filingStatus: scenario.filingStatus ?? null,
    privacyMode: booleanOrNull(scenario.privacyMode),
    currentAge: finiteOrNull(scenario.currentAge),
    spouseAge: finiteOrNull(scenario.spouseAge),
    targetSpend: finiteOrNull(scenario.targetSpend),
    targetSpendIncludesTaxes: booleanOrNull(scenario.targetSpendIncludesTaxes),
    targetSpendIncludesMedical: booleanOrNull(scenario.targetSpendIncludesMedical),
    monteCarlo: summarizeMonteCarloForReview(scenario.monteCarlo),
    withdrawalStrategy: scenario.withdrawalStrategy?.mode ?? scenario.withdrawalStrategy ?? null,
    spendingStrategy: scenario.spendingStrategy?.mode ?? scenario.spendingStrategy ?? null,
    riskBasedGuardrails: summarizeRiskBasedGuardrails(scenario.spendingStrategy?.riskBasedGuardrails),
    healthcare: {
      acaEnabled: scenario.aca?.enabled !== false,
      acaPlanCostMode: scenario.aca?.planCostMode ?? null,
      acaPremiumInputMode: scenario.aca?.premiumInputMode ?? null,
      zip: scenario.aca?.zip ?? null,
      householdSize: finiteOrNull(scenario.aca?.householdSize),
      marketplaceMembers: finiteOrNull(scenario.aca?.marketplaceMembers)
    },
    legacy: {
      heirType: scenario.heirType ?? null,
      heirState: scenario.heirState ?? null,
      inheritanceTaxState: inheritanceTaxStateForScenario(scenario) ?? null,
      heirBaseIncome: finiteOrNull(scenario.heirBaseIncome),
      heirAge: finiteOrNull(scenario.heirAge),
      heirOrdinaryTaxRate: finiteOrNull(scenario.heirOrdinaryTaxRate)
    }
  };
}

function summarizeMonteCarloForReview(config = null) {
  if (!config || typeof config !== "object") return null;
  return {
    assumptionPreset: config.assumptionPreset ?? null,
    samplingMode: config.samplingMode ?? null,
    meanReversion: config.meanReversion && typeof config.meanReversion === "object" ? {
      shortTermStrength: finiteOrNull(config.meanReversion.shortTermStrength),
      longTermStrength: finiteOrNull(config.meanReversion.longTermStrength),
      longTermYears: finiteOrNull(config.meanReversion.longTermYears)
    } : null
  };
}

function summarizeRiskBasedGuardrails(config = null) {
  if (!config || typeof config !== "object") return null;
  const table = config.table && typeof config.table === "object" ? config.table : null;
  return {
    targetSuccessRate: finiteOrNull(config.targetSuccessRate),
    lowerSuccessRate: finiteOrNull(config.lowerSuccessRate),
    upperSuccessRate: finiteOrNull(config.upperSuccessRate),
    minimumAdjustmentPercent: finiteOrNull(config.minimumAdjustmentPercent),
    incomeFloor: finiteOrNull(config.incomeFloor),
    incomeCeiling: finiteOrNull(config.incomeCeiling),
    table: table ? {
      sequenceCount: finiteOrNull(table.sequenceCount),
      fixedFailsafeSpend: finiteOrNull(table.fixedFailsafeSpend),
      initialSpend: finiteOrNull(table.initialSpend),
      lowerGuardrailPortfolioValue: finiteOrNull(table.lowerGuardrailPortfolioValue),
      lowerAdjustedSpend: finiteOrNull(table.lowerAdjustedSpend),
      upperGuardrailPortfolioValue: finiteOrNull(table.upperGuardrailPortfolioValue),
      upperAdjustedSpend: finiteOrNull(table.upperAdjustedSpend)
    } : null
  };
}

function normalizeAuditRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (Array.isArray(row)) {
      return {
        label: String(row[0] ?? ""),
        value: String(row[1] ?? "")
      };
    }
    return {
      label: String(row?.label ?? ""),
      value: String(row?.value ?? "")
    };
  }).filter((row) => row.label || row.value);
}

function copyJsonObject(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}
