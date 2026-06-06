import { compactLatestForCache } from "./resultsCache.mjs";
import { normalizeSetupState } from "./setupBackup.mjs";

export const RESULT_AUDIT_BUNDLE_SCHEMA_VERSION = 2;
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
    schemaVersion: 1,
    exportedAt,
    scenario: summarizeScenarioForReview(scenario),
    verdict: {
      planSuccess: latest.plan?.success ?? null,
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
      seed: sourceVersions.seed ?? scenario.seed ?? null,
      monteCarloPreset: sourceVersions.monteCarloPreset ?? scenario.monteCarlo?.assumptionPreset ?? null,
      monteCarloRuns: sourceVersions.monteCarloRuns ?? finiteOrNull(mcSummary.runs ?? mcSummary.total),
      historicalDataSource: sourceVersions.historicalDataSource ?? latest.historicalDataSource ?? null,
      historicalRange: sourceVersions.historicalRange ?? latest.historicalRange ?? null
    },
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
    withdrawalStrategy: scenario.withdrawalStrategy?.mode ?? scenario.withdrawalStrategy ?? null,
    spendingStrategy: scenario.spendingStrategy?.mode ?? scenario.spendingStrategy ?? null,
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
      heirBaseIncome: finiteOrNull(scenario.heirBaseIncome),
      heirAge: finiteOrNull(scenario.heirAge),
      heirState: scenario.heirState ?? null
    }
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
