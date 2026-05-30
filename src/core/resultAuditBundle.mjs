import { compactLatestForCache } from "./resultsCache.mjs";
import { normalizeSetupState } from "./setupBackup.mjs";

export const RESULT_AUDIT_BUNDLE_SCHEMA_VERSION = 1;
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
    setup: normalizeSetupState(setupState),
    audit: normalizeAuditRows(auditRows),
    result: compactLatestForCache(latest)
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
