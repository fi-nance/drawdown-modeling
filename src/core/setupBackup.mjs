// v2: state gained an `incomeStreams` array (recurring pension/annuity/rent
// streams). v1 backups restore cleanly — missing streams normalize to [].
export const SETUP_BACKUP_SCHEMA_VERSION = 2;
export const SETUP_BACKUP_TYPE = "portfolio-success-lab-full-setup";
export const SETUP_BACKUP_PRIVACY_NOTICE = "Setup backups can include household ages, account balances, tax assumptions, healthcare inputs, heirs/goals, and decision preferences. Keep them local unless you intentionally share them with a CPA or trusted reviewer.";

export function createSetupBackup(state, { exportedAt = new Date().toISOString() } = {}) {
  return {
    app: "Portfolio Success Lab",
    type: SETUP_BACKUP_TYPE,
    schemaVersion: SETUP_BACKUP_SCHEMA_VERSION,
    exportedAt,
    privacyNotice: SETUP_BACKUP_PRIVACY_NOTICE,
    state: normalizeSetupState(state)
  };
}

export function parseSetupBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid setup backup JSON: ${error.message}`);
  }

  const state = parsed?.type === SETUP_BACKUP_TYPE ? parsed.state : parsed;
  return normalizeSetupState(state);
}

export function normalizeSetupState(state) {
  if (!state || typeof state !== "object") {
    throw new Error("Setup backup must contain a state object.");
  }
  if (!Array.isArray(state.assets)) {
    throw new Error("Setup backup is missing an assets array.");
  }
  if (state.controls != null && (typeof state.controls !== "object" || Array.isArray(state.controls))) {
    throw new Error("Setup backup controls must be an object.");
  }
  if (state.oneOffExpenses != null && !Array.isArray(state.oneOffExpenses)) {
    throw new Error("Setup backup one-off expenses must be an array.");
  }
  if (state.incomeStreams != null && !Array.isArray(state.incomeStreams)) {
    throw new Error("Setup backup income streams must be an array.");
  }
  if (state.redesign != null && (typeof state.redesign !== "object" || Array.isArray(state.redesign))) {
    throw new Error("Setup backup redesign state must be an object.");
  }
  if (state.decisionProfile != null && (typeof state.decisionProfile !== "object" || Array.isArray(state.decisionProfile))) {
    throw new Error("Setup backup decision profile must be an object.");
  }

  const normalized = {
    controls: copyPlainObject(state.controls ?? {}),
    assets: copyObjectArray(state.assets, "assets"),
    oneOffExpenses: copyObjectArray(state.oneOffExpenses ?? [], "one-off expenses"),
    // Default to [] (like oneOffExpenses) so restoring a pre-stream backup
    // clears the workspace's current streams instead of silently keeping them.
    incomeStreams: copyObjectArray(state.incomeStreams ?? [], "income streams")
  };
  if (state.redesign != null) normalized.redesign = copyPlainObject(state.redesign);
  if (state.decisionProfile != null) normalized.decisionProfile = copyPlainObject(state.decisionProfile);
  return normalized;
}

function copyObjectArray(items, label) {
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Setup backup ${label} item ${index + 1} must be an object.`);
    }
    return copyPlainObject(item);
  });
}

function copyPlainObject(object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, cloneJsonValue(value)]));
}

function cloneJsonValue(value) {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}
