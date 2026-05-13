export const SETUP_BACKUP_SCHEMA_VERSION = 1;
export const SETUP_BACKUP_TYPE = "portfolio-success-lab-full-setup";

export function createSetupBackup(state, { exportedAt = new Date().toISOString() } = {}) {
  return {
    app: "Portfolio Success Lab",
    type: SETUP_BACKUP_TYPE,
    schemaVersion: SETUP_BACKUP_SCHEMA_VERSION,
    exportedAt,
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
  if (state.redesign != null && (typeof state.redesign !== "object" || Array.isArray(state.redesign))) {
    throw new Error("Setup backup redesign state must be an object.");
  }

  const normalized = {
    activeScreen: state.activeScreen === "setup" ? "setup" : "plan",
    controls: copyPlainObject(state.controls ?? {}),
    assets: copyObjectArray(state.assets, "assets"),
    oneOffExpenses: copyObjectArray(state.oneOffExpenses ?? [], "one-off expenses")
  };
  if (state.redesign != null) normalized.redesign = copyPlainObject(state.redesign);
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
