import { RESULTS_CACHE_KEY } from "./core/resultsCache.mjs";
import { actionConfidenceFor, rescueConfidenceFor } from "./core/confidence.mjs";

/* ──────────────────────────────────────────────────────────────────
   redesign.mjs
   - Companion to app.mjs (which still does all simulation/data work)
   - Implements: three-screen router, theme toggle, persona presets,
     module library, setup save/load, action-plan card, bracket fill,
     withdrawal mix per year, sensitivity tornado, mobile polish.
   - DOM IDs from the app shell are preserved, so app.mjs continues
     to function unchanged.
   ────────────────────────────────────────────────────────────────── */

const SCREENS = ["persona", "workspace", "results"];
const STORAGE_SCREEN = "psl:redesign:screen";
const STORAGE_THEME = "psl:redesign:theme";
const STORAGE_PERSONA = "psl:redesign:persona";
const STORAGE_OUTCOME = "psl:redesign:outcome";
const STORAGE_DETAIL = "psl:redesign:detail";
const STORAGE_MODULES = "psl:redesign:modules";
const STORAGE_COLLAPSED = "psl:redesign:collapsedModules";

// Persona presets — what each card pre-fills in the workspace.
const PERSONAS = [
  {
    id: "recentlyLeftWork",
    label: "Recently left work",
    sub: "Can we stay retired, or do I need income?",
    dot: "#34d1b6",
    age: 44,
    spouseAge: 44,
    plan: 50,
    spend: 100000,
    requiredSpend: 72000,
    flexibleSpend: 28000,
    state: "Massachusetts",
    householdSize: 4,
    marketplaceMembers: 4,
    rothBasis: 120000,
    outcome: "fallback",
    spendingStrategyMode: "discretionaryGuardrails",
    enabledModules: ["healthcare", "strategy", "history", "what-ifs", "other-income"]
  },
  {
    id: "fire",
    label: "FIRE / early",
    sub: "Retired in 30s–40s, 50+ year horizon",
    dot: "#f06060",
    age: 38,
    spouseAge: 38,
    plan: 55,
    spend: 65000,
    rothBasis: 120000,
    enabledModules: ["healthcare", "strategy", "history", "what-ifs"]
  },
  {
    id: "fiveYears",
    label: "5 years out",
    sub: "Pre-retiree, ages 55–62, big tax-planning window",
    dot: "#34d1b6",
    age: 55,
    spouseAge: 55,
    plan: 35,
    spend: 90000,
    rothBasis: 60000,
    enabledModules: ["healthcare", "strategy", "what-ifs"]
  },
  {
    id: "justRetired",
    label: "Just retired",
    sub: "Ages 62–67, claiming SS soon, ACA bridge",
    dot: "#5b8def",
    age: 64,
    spouseAge: 64,
    plan: 30,
    spend: 95000,
    rothBasis: 60000,
    enabledModules: ["healthcare", "other-income", "strategy"]
  },
  {
    id: "medicareAge",
    label: "Medicare-age",
    sub: "65+, on Medicare, RMD planning ahead",
    dot: "#f0a848",
    age: 68,
    spouseAge: 68,
    plan: 25,
    spend: 85000,
    rothBasis: 60000,
    enabledModules: ["medicare", "other-income", "strategy"]
  },
  {
    id: "lateStage",
    label: "Late stage",
    sub: "75+, RMDs active, legacy planning",
    dot: "#7c6cf0",
    age: 78,
    spouseAge: 78,
    plan: 18,
    spend: 70000,
    rothBasis: 60000,
    enabledModules: ["medicare", "other-income"]
  },
  {
    id: "buildOwn",
    label: "Build my own",
    sub: "I know my numbers, skip presets",
    dot: "#8892a8",
    age: null,
    enabledModules: []
  }
];

const OUTCOMES = [
  {
    id: "fallback",
    label: "Bad-market fallback",
    sub: "Show the cut or income bridge that keeps us safe.",
    focus: "decisionPanel",
    enable: ["healthcare", "strategy", "history", "what-ifs", "other-income"]
  },
  {
    id: "lasts",
    label: "Will my money last?",
    sub: "Show me a simple yes / no with why.",
    focus: "kpiStrip",
    enable: []
  },
  {
    id: "spend",
    label: "How much can I safely spend?",
    sub: "Find my safe spend number.",
    focus: "kpiStrip",
    enable: [],
    note: "(Solver coming soon — for now, the all-in spend rate KPI is highlighted.)"
  },
  {
    id: "roth",
    label: "Should I do Roth conversions?",
    sub: "What's my conversion ladder?",
    focus: "actionPlanPanel",
    enable: ["strategy"]
  },
  {
    id: "order",
    label: "Which account should I draw from first?",
    sub: "Walk me through the order.",
    focus: "withdrawalMix",
    enable: ["strategy"]
  },
  {
    id: "aca",
    label: "How do I keep ACA subsidies?",
    sub: "Cap my MAGI without starving cash.",
    focus: "actionPlanPanel",
    enable: ["healthcare"]
  }
];

const MODULES = [
  { id: "basics",        label: "The basics",     desc: "Age, plan length, target spend",        controls: 19, required: true,  enabledByDefault: true  },
  { id: "portfolio",     label: "Portfolio",      desc: "Your accounts and holdings",             controls: 5,  required: true,  enabledByDefault: true  },
  { id: "healthcare",    label: "Healthcare",     desc: "Insurance until Medicare",               controls: 22, required: false, enabledByDefault: true  },
  { id: "medicare",      label: "Medicare/IRMAA", desc: "Premiums after 65",                       controls: 12, required: false, enabledByDefault: false },
  { id: "other-income",  label: "Other income",   desc: "Social Security, work, pensions",         controls: 22, required: false, enabledByDefault: false },
  { id: "strategy",      label: "Strategy toolkit", desc: "Taxes, allocations, withdrawal rules",   controls: 41, required: false, enabledByDefault: true  },
  { id: "reserve",       label: "Cash reserve",   desc: "Bucket strategy",                          controls: 8,  required: false, enabledByDefault: false },
  { id: "monte-carlo",   label: "Monte Carlo",    desc: "Return model and sampling",                controls: 20, required: false, enabledByDefault: true  },
  { id: "history",       label: "History test",   desc: "How would you have done?",                controls: 7,  required: false, enabledByDefault: false },
  { id: "what-ifs",      label: "What ifs",       desc: "Future expenses or income",                controls: 8,  required: false, enabledByDefault: true  },
  { id: "tax-overrides", label: "Tax overrides",  desc: "Power-user tax tweaks",                    controls: 23, required: false, enabledByDefault: false }
];

const RESCUE_CHANGE_MODULES = [
  { module: "reserve", pattern: /^(Reserve|TIPS ladder|Ladder )/ },
  { module: "what-ifs", pattern: /^One-off cash flows/ },
  { module: "medicare", pattern: /^(IRMAA enabled|Max IRMAA tier)/ },
  { module: "other-income", pattern: /^Social Security/ },
  {
    module: "strategy",
    pattern: /^(Spending mode|Essential spend|Discretionary spend|Correction discretionary|Bear discretionary|Risk guardrail|Tax-aware rebalancing|Equity glidepath|Stock target|Withdrawal strategy|Withdrawal order|Tax-loss harvesting|Tax-gain harvesting|Gain harvest MAGI buffer|Roth conversions|ACA-aware Roth conversions|MAGI conversion guardrails|Conversion max ACA FPL|Conversion MAGI buffer|Roth basis optimization|Roth basis hurdle|Roth basis MAGI buffer)/
  }
];

const TIER_THRESHOLDS = { warn: 0.85, risk: 0.7 };

// Cache-friendly Monte Carlo run cap. Above this, the compact cache may still
// fit, but we'd rather warn proactively than have refresh-from-cache silently
// fall through to recompute.
const RUNS_CACHE_THRESHOLD = 1000;

// Outcome of the most recent app cacheLatestResults() call. null until
// the first run completes; true on success, false if sessionStorage rejected
// the compact blob. Drives the post-run warning state on #runsHint and the
// "not cached for refresh" suffix in the results topbar.
let lastCacheOk = null;
let pendingRunAdvance = false;

// ─── State ─────────────────────────────────────────────────────────

const state = {
  screen: "persona",
  theme: "dark",
  persona: null,
  outcome: null,
  detail: "plain",
  enabledModules: new Set(MODULES.filter(m => m.enabledByDefault).map(m => m.id))
};

// ─── Boot ──────────────────────────────────────────────────────────

function boot() {
  hydrateState();
  buildPersonaCards();
  buildOutcomeCards();
  buildModuleLibrary();
  wireModuleCollapse();
  bindRouter();
  bindTheme();
  bindIntakes();
  bindSetupTransfer();
  bindRescueAppliedModuleVisibility();
  bindWorkspaceSummary();
  bindWithdrawalMix();
  bindHistoricalPathLinks();
  bindRunsHint();
  applyAll();
  hookRunCompletion();
  if (window.__pslLatest) {
    rerenderResults();
    syncWorkspaceSummary();
  }
  // Also listen for future render-latest events (in case the user changes
  // inflation view, etc., without firing the yearTable mutation observer).
  window.addEventListener("psl:render-latest", () => {
    rerenderResults();
    syncWorkspaceSummary();
  });
  window.addEventListener("psl:path-selected", () => {
    rerenderResults();
    syncWorkspaceSummary();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

function hydrateState() {
  state.screen = readStorage(STORAGE_SCREEN, "persona");
  if (!SCREENS.includes(state.screen)) state.screen = "persona";
  // Override from query string for shareable URLs
  const url = new URL(window.location.href);
  const queryScreen = url.searchParams.get("screen");
  if (queryScreen && SCREENS.includes(queryScreen)) state.screen = queryScreen;

  // Only redirect a results-screen visit back to step 1 when the user has
  // *never* engaged with the app. Earlier we were checking just two signals
  // (the app setup-state key and the cached results blob) and yanking
  // people to persona whenever both happened to be missing — too aggressive
  // when storage is partial or being cleared between sessions. Now we also
  // honour the persisted screen pointer: if the user has previously been to
  // results, trust that and let the results screen render whatever it can.
  if (state.screen === "results") {
    const diag = describeStorageState();
    console.debug("[PSL] results-screen refresh guard:", JSON.stringify(diag));
    const hasAnyEngagement =
      diag.hasSetupState ||
      diag.hasCachedResults ||
      diag.persistedScreen === "results" ||
      diag.persistedScreen === "workspace";
    if (!hasAnyEngagement) {
      console.debug("[PSL] no prior engagement found — redirecting to persona");
      state.screen = "persona";
      writeStorage(STORAGE_SCREEN, "persona");
      if (queryScreen) {
        url.searchParams.delete("screen");
        window.history.replaceState(null, "", url.toString());
      }
    }
  }

  state.theme = readStorage(STORAGE_THEME, "dark");
  state.persona = readStorage(STORAGE_PERSONA, null);
  state.outcome = readStorage(STORAGE_OUTCOME, null);
  state.detail = readStorage(STORAGE_DETAIL, "plain");

  const savedModules = readJsonStorage(STORAGE_MODULES, null);
  if (Array.isArray(savedModules) && savedModules.length) {
    state.enabledModules = new Set(savedModules);
  }
  // Required modules always enabled.
  for (const m of MODULES) {
    if (m.required) state.enabledModules.add(m.id);
  }

}

function applyAll() {
  document.body.dataset.screen = state.screen;
  document.body.dataset.theme  = state.theme;
  syncDetailToggle();
  syncViewModeToggle();
  syncModuleVisibility();
  syncModuleLibraryUI();
  syncPersonaSelection();
  syncOutcomeSelection();
}

// ─── Persona cards ─────────────────────────────────────────────────

function buildPersonaCards() {
  const root = document.getElementById("personaGrid");
  if (!root) return;
  root.innerHTML = "";
  for (const p of PERSONAS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "persona-card";
    card.setAttribute("role", "radio");
    card.dataset.persona = p.id;
    card.setAttribute("aria-pressed", "false");
    const stats = p.age == null ? "" : `
      <dl class="persona-stats">
        <div><dt>Age</dt><dd>${p.age}</dd></div>
        <div><dt>Plan</dt><dd>${p.plan}y</dd></div>
        <div><dt>Spend</dt><dd>$${(p.spend/1000)|0}k</dd></div>
      </dl>`;
    card.innerHTML = `
      <div class="persona-title"><span class="persona-dot" style="background:${p.dot}"></span>${p.label}</div>
      <div class="persona-sub">${p.sub}</div>
      ${stats}`;
    card.addEventListener("click", () => selectPersona(p.id));
    root.appendChild(card);
  }
}

function selectPersona(id) {
  state.persona = id;
  writeStorage(STORAGE_PERSONA, id);
  syncPersonaSelection();
  applyPersonaPreset(id);
}

function syncPersonaSelection() {
  document.querySelectorAll(".persona-card[data-persona]").forEach(card => {
    const isActive = card.dataset.persona === state.persona;
    card.setAttribute("aria-pressed", String(isActive));
  });
}

function applyPersonaPreset(id) {
  const persona = PERSONAS.find(p => p.id === id);
  if (!persona || persona.id === "buildOwn") return;
  setInputValue("currentAge", persona.age);
  setInputValue("spouseAge", persona.spouseAge ?? persona.age);
  setInputValue("planYears", persona.plan);
  setInputValue("targetSpend", persona.spend);
  if (persona.requiredSpend != null) setInputValue("decisionRequiredSpend", persona.requiredSpend);
  if (persona.flexibleSpend != null) setInputValue("decisionFlexibleSpend", persona.flexibleSpend);
  if (persona.state) setInputValue("stateSelect", persona.state);
  if (persona.householdSize != null) setInputValue("householdSize", persona.householdSize);
  if (persona.marketplaceMembers != null) setInputValue("marketplaceMembers", persona.marketplaceMembers);
  if (persona.requiredSpend != null) setInputValue("essentialSpend", persona.requiredSpend);
  if (persona.flexibleSpend != null) setInputValue("discretionarySpend", persona.flexibleSpend);
  if (persona.spendingStrategyMode) setInputValue("spendingStrategyMode", persona.spendingStrategyMode);
  setInputValue("decisionTargetSuccessRate", 90);
  if (persona.rothBasis != null) setInputValue("rothBasis", persona.rothBasis);
  if (persona.outcome) {
    state.outcome = persona.outcome;
    writeStorage(STORAGE_OUTCOME, persona.outcome);
    syncOutcomeSelection();
    const outcome = OUTCOMES.find(x => x.id === persona.outcome);
    if (outcome?.enable) {
      for (const id of outcome.enable) state.enabledModules.add(id);
    }
  }

  // Pre-enable suggested modules (without disabling user's existing picks).
  if (Array.isArray(persona.enabledModules)) {
    for (const id of persona.enabledModules) state.enabledModules.add(id);
    persistModules();
    syncModuleLibraryUI();
    syncModuleVisibility();
  }
}

// ─── Outcome cards ─────────────────────────────────────────────────

function buildOutcomeCards() {
  const root = document.getElementById("outcomeGrid");
  if (!root) return;
  root.innerHTML = "";
  for (const o of OUTCOMES) {
    const card = document.createElement("label");
    card.className = "outcome-card";
    card.dataset.outcome = o.id;
    card.innerHTML = `
      <span class="outcome-radio" aria-hidden="true"></span>
      <span class="outcome-text">
        <span class="outcome-title">${o.label}</span>
        <span class="outcome-sub">${o.sub}${o.note ? ` <em>${o.note}</em>` : ""}</span>
      </span>
      <input type="radio" name="primaryOutcome" value="${o.id}">`;
    card.querySelector("input").addEventListener("change", () => selectOutcome(o.id));
    card.addEventListener("click", () => selectOutcome(o.id));
    root.appendChild(card);
  }
}

function selectOutcome(id) {
  state.outcome = id;
  writeStorage(STORAGE_OUTCOME, id);
  syncOutcomeSelection();
  // Pre-enable any modules this outcome implies.
  const o = OUTCOMES.find(x => x.id === id);
  if (o?.enable?.length) {
    for (const m of o.enable) state.enabledModules.add(m);
    persistModules();
    syncModuleLibraryUI();
    syncModuleVisibility();
  }
}

function syncOutcomeSelection() {
  document.querySelectorAll(".outcome-card[data-outcome]").forEach(card => {
    const isActive = card.dataset.outcome === state.outcome;
    card.classList.toggle("is-selected", isActive);
    const input = card.querySelector('input[type="radio"]');
    if (input) input.checked = isActive;
  });
}

// ─── Intake cards (CSV/Sheets/Manual/Sample) ───────────────────────

function bindIntakes() {
  document.querySelectorAll(".intake-card[data-intake]").forEach(card => {
    card.addEventListener("click", () => {
      const intake = card.dataset.intake;
      // Mark visual active state for one click.
      document.querySelectorAll(".intake-card[data-intake]").forEach(c => c.classList.toggle("is-active", c === card));
      if (intake === "saved") {
        triggerSetupRestore();
        return;
      }
      // Switch to workspace and let the user complete intake there.
      setScreen("workspace");
      // After paint, scroll the right module into focus.
      requestAnimationFrame(() => {
        if (intake === "csv" || intake === "sheets" || intake === "manual" || intake === "sample") {
          const portfolio = document.querySelector('.module-card[data-module="portfolio"]');
          portfolio?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        if (intake === "csv") document.getElementById("csvFile")?.click();
        if (intake === "sheets") document.getElementById("sheetUrl")?.focus();
        if (intake === "manual") document.getElementById("addAsset")?.click();
        // "sample" is a no-op; default sample data is already loaded.
      });
    });
  });
}

// ─── Module library ────────────────────────────────────────────────

function buildModuleLibrary() {
  const root = document.getElementById("moduleToggleList");
  if (!root) return;
  root.innerHTML = "";
  for (const m of MODULES) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "module-toggle";
    row.dataset.module = m.id;
    if (m.required) row.classList.add("is-required");
    row.innerHTML = `
      <div class="mod-meta">
        <span class="mod-name">${m.label}${m.required ? `<span class="mod-required">required</span>` : ""}</span>
        <span class="mod-desc">${m.desc} · ${m.controls} controls</span>
      </div>
      <span class="mod-check">${m.required ? "✓" : ""}</span>`;
    row.addEventListener("click", () => toggleModule(m.id));
    root.appendChild(row);
  }
  // Mobile collapse handle
  const collapseBtn = document.querySelector("[data-toggle-library]");
  const lib = document.getElementById("moduleLibrary");
  // Default to collapsed on small viewports.
  if (lib && window.matchMedia && window.matchMedia("(max-width: 720px)").matches) {
    lib.dataset.collapsed = "true";
    if (collapseBtn) collapseBtn.textContent = "Show library";
  } else if (lib) {
    lib.dataset.collapsed = "false";
    if (collapseBtn) collapseBtn.textContent = "Hide library";
  }
  collapseBtn?.addEventListener("click", () => {
    if (!lib) return;
    const collapsed = lib.dataset.collapsed === "true";
    lib.dataset.collapsed = collapsed ? "false" : "true";
    collapseBtn.textContent = collapsed ? "Hide library" : "Show library";
  });
}

function toggleModule(id) {
  const m = MODULES.find(x => x.id === id);
  if (!m || m.required) return;
  if (state.enabledModules.has(id)) state.enabledModules.delete(id);
  else state.enabledModules.add(id);
  persistModules();
  syncModuleLibraryUI();
  syncModuleVisibility();
}

function persistModules() {
  writeJsonStorage(STORAGE_MODULES, [...state.enabledModules]);
}

function syncModuleLibraryUI() {
  document.querySelectorAll(".module-toggle[data-module]").forEach(toggle => {
    const id = toggle.dataset.module;
    const enabled = state.enabledModules.has(id);
    toggle.classList.toggle("is-active", enabled);
    const m = MODULES.find(x => x.id === id);
    const check = toggle.querySelector(".mod-check");
    if (check) check.textContent = enabled ? "✓" : (m?.required ? "✓" : "");
  });
}

function syncModuleVisibility() {
  document.querySelectorAll(".module-card[data-module]").forEach(card => {
    const id = card.dataset.module;
    const enabled = state.enabledModules.has(id);
    card.hidden = !enabled;
  });
}

function bindRescueAppliedModuleVisibility() {
  window.addEventListener("psl:rescue-scenario-applied", (ev) => {
    const modules = modulesForRescueChanges(ev.detail?.changes);
    if (!modules.size) return;
    let changed = false;
    for (const id of modules) {
      if (!state.enabledModules.has(id)) {
        state.enabledModules.add(id);
        changed = true;
      }
    }
    if (changed) persistModules();
    syncModuleLibraryUI();
    syncModuleVisibility();
    expandWorkspaceModules(modules);
  });
}

function modulesForRescueChanges(changes = []) {
  const modules = new Set();
  if (!Array.isArray(changes)) return modules;
  for (const change of changes) {
    const text = String(change ?? "");
    const match = RESCUE_CHANGE_MODULES.find((entry) => entry.pattern.test(text));
    if (match) modules.add(match.module);
  }
  return modules;
}

function expandWorkspaceModules(moduleIds) {
  const grid = document.getElementById("moduleGrid");
  if (!grid) return;
  for (const id of moduleIds) {
    const card = grid.querySelector(`.module-card[data-module="${id}"]`);
    if (!card) continue;
    card.hidden = false;
    setCardCollapsed(card, false);
  }
  persistCollapsedModules();
}

// ─── Module collapse / expand ─────────────────────────────────────

function wireModuleCollapse() {
  const grid = document.getElementById("moduleGrid");
  if (!grid) return;

  const persisted = readJsonStorage(STORAGE_COLLAPSED, []);
  const collapsedIds = new Set(Array.isArray(persisted) ? persisted : []);

  grid.querySelectorAll(".module-card[data-module]").forEach(card => {
    const actions = card.querySelector(".module-actions");
    if (actions && !actions.querySelector(".module-collapse")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "module-collapse";
      btn.setAttribute("aria-label", "Collapse module");
      btn.setAttribute("aria-expanded", "true");
      btn.innerHTML = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"></polyline></svg>`;
      actions.appendChild(btn);
    }
    if (collapsedIds.has(card.dataset.module)) setCardCollapsed(card, true);
  });

  // Toggle on header click — but ignore clicks on inputs, links, and other
  // buttons inside the header (the chevron itself is allowed).
  grid.addEventListener("click", (ev) => {
    const header = ev.target.closest(".module-header");
    if (!header) return;
    const card = header.closest(".module-card[data-module]");
    if (!card) return;
    const onChevron = !!ev.target.closest(".module-collapse");
    const onOther = !!ev.target.closest("a, input, select, textarea, .module-remove");
    if (onOther && !onChevron) return;
    setCardCollapsed(card, card.dataset.collapsed !== "true");
    persistCollapsedModules();
  });

  document.querySelectorAll('[data-modules-action]').forEach(btn => {
    btn.addEventListener("click", () => {
      const collapse = btn.dataset.modulesAction === "collapse-all";
      grid.querySelectorAll(".module-card[data-module]").forEach(card => {
        if (card.hidden) return;
        setCardCollapsed(card, collapse);
      });
      persistCollapsedModules();
    });
  });
}

function setCardCollapsed(card, collapsed) {
  card.dataset.collapsed = collapsed ? "true" : "false";
  const btn = card.querySelector(".module-collapse");
  if (btn) {
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.setAttribute("aria-label", collapsed ? "Expand module" : "Collapse module");
  }
}

function persistCollapsedModules() {
  const grid = document.getElementById("moduleGrid");
  if (!grid) return;
  const ids = [...grid.querySelectorAll('.module-card[data-collapsed="true"]')]
    .map(c => c.dataset.module)
    .filter(Boolean);
  writeJsonStorage(STORAGE_COLLAPSED, ids);
}

// ─── Router ────────────────────────────────────────────────────────

function bindRouter() {
  const personaContinue = document.getElementById("personaContinue");
  personaContinue?.addEventListener("click", () => setScreen("workspace"));

  const wsViewResults = document.getElementById("wsViewResults");
  wsViewResults?.addEventListener("click", () => {
    setScreen("results");
    runModelFromRedesign({ cancelActive: true, stream: true });
  });

  const back = document.getElementById("resultsBackToWorkspace");
  back?.addEventListener("click", () => setScreen("workspace"));

  // First Monte Carlo scenario is ready — swap to the results screen if the
  // user kicked off a run from the workspace and is waiting on us.
  window.addEventListener("psl:first-scenario-ready", () => {
    if (pendingRunAdvance) {
      pendingRunAdvance = false;
      if (state.screen === "workspace" || state.screen === "persona") {
        setScreen("results");
      }
    }
  });
}

function setScreen(screen) {
  if (!SCREENS.includes(screen)) return;
  const fromScreen = state.screen;
  state.screen = screen;
  writeStorage(STORAGE_SCREEN, screen);
  document.body.dataset.screen = screen;
  if (screen === "results") {
    rerenderResults();
    scrollOutcomeIntoFocus();
  }
  if (screen === "workspace") {
    syncWorkspaceSummary();
  }
  // Update query string without history pollution
  const url = new URL(window.location.href);
  url.searchParams.set("screen", screen);
  window.history.replaceState({}, "", url);
  console.debug(`[PSL] setScreen: ${fromScreen} → ${screen} · url now ${window.location.search || "(no query)"}`);
}

function scrollOutcomeIntoFocus() {
  const o = OUTCOMES.find(x => x.id === state.outcome);
  if (!o?.focus) return;
  requestAnimationFrame(() => {
    const target = document.getElementById(o.focus) || document.querySelector(`[id="${o.focus}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ─── Theme toggle ──────────────────────────────────────────────────

function bindTheme() {
  document.querySelectorAll("[data-theme-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      writeStorage(STORAGE_THEME, state.theme);
      document.body.dataset.theme = state.theme;
    });
  });

  // Plain/Pro pill toggles (purely cosmetic for now — sets CSS hint that
  // could later hide advanced details across the workspace).
  document.querySelectorAll(".pill-toggle[role='tablist']").forEach(group => {
    const btns = group.querySelectorAll("button");
    btns.forEach(btn => btn.addEventListener("click", () => {
      btns.forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
      const detail = btn.dataset.detail;
      const viewMode = btn.dataset.viewMode;
      if (detail) {
        state.detail = detail;
        writeStorage(STORAGE_DETAIL, detail);
        document.body.dataset.detail = detail;
      }
      if (viewMode) {
        // Sync to the hidden #viewMode select used by app.mjs
        const legacy = document.getElementById("viewMode");
        if (legacy) {
          legacy.value = viewMode;
          legacy.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }));
  });

  document.getElementById("viewMode")?.addEventListener("change", syncViewModeToggle);
}

function syncDetailToggle() {
  document.querySelectorAll(".pill-toggle [data-detail]").forEach(btn => {
    btn.setAttribute("aria-pressed", String(btn.dataset.detail === state.detail));
  });
  document.body.dataset.detail = state.detail;
}

function syncViewModeToggle() {
  const selectedViewMode = document.getElementById("viewMode")?.value === "nominal"
    ? "nominal"
    : "real";
  document.querySelectorAll(".pill-toggle [data-view-mode]").forEach(btn => {
    btn.setAttribute("aria-pressed", String(btn.dataset.viewMode === selectedViewMode));
  });
}

// ─── Workspace summary KPI strip ───────────────────────────────────

function bindWorkspaceSummary() {
  // Populated when app.mjs finishes a run (see hookRunCompletion).
}

function syncWorkspaceSummary() {
  const latest = window.__pslLatest;
  const pctEl = document.getElementById("wsSummaryPct");
  const labelEl = document.getElementById("wsSummaryLabel");
  const subEl = document.getElementById("wsSummarySub");
  const sparkEl = document.getElementById("wsSummarySpark");
  if (!pctEl || !labelEl || !subEl) return;
  if (!latest) {
    pctEl.textContent = "—";
    pctEl.dataset.empty = "true";
    labelEl.textContent = "View full results to see your number";
    subEl.textContent = "Pick modules, fill in the basics, then open results.";
    if (sparkEl) sparkEl.innerHTML = "";
    return;
  }
  const successRate = computeSuccessRate(latest);
  pctEl.textContent = `${Math.round(successRate * 100)}%`;
  pctEl.removeAttribute("data-empty");
  pctEl.dataset.tier = tierFor(successRate);
  const targetSpend = Number(document.getElementById("targetSpend")?.value) || 0;
  labelEl.textContent = `Money lasts at $${targetSpend.toLocaleString()}/yr`;
  const median = pickEndingValue(latest, 0.5);
  const fifth  = pickEndingValue(latest, 0.05);
  const spendRate = allInSpendRate(latest);
  const subParts = [];
  if (Number.isFinite(median)) subParts.push(`Median ${formatCurrencyShort(median)} ending`);
  if (Number.isFinite(fifth))  subParts.push(`5th pct ${formatCurrencyShort(fifth)}`);
  if (Number.isFinite(spendRate)) subParts.push(`${(spendRate*100).toFixed(1)}% all-in spend rate`);
  subEl.textContent = subParts.join(" · ");
  if (sparkEl) renderSpark(sparkEl, latest);
}

function renderSpark(svg, latest) {
  // Bar chart: ending portfolio value year-over-year from the deterministic plan.
  const series = planYears(latest).slice(0, 36).map(y => displayAmount(y.endingPortfolioValue ?? 0, y));
  if (!series.length) { svg.innerHTML = ""; return; }
  const max = Math.max(...series, 1);
  const w = 320, h = 56, gap = 1.5;
  const bw = (w - gap * (series.length - 1)) / series.length;
  const bars = series.map((v, i) => {
    const bh = Math.max(2, (v / max) * (h - 4));
    const x = i * (bw + gap);
    const y = h - bh;
    const tier = i < 3 ? "var(--coral)" : i < series.length - 5 ? "var(--blue)" : "var(--emerald)";
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="1" fill="${tier}" opacity="0.85"/>`;
  }).join("");
  svg.innerHTML = bars;
}

// ─── Setup Save / Load ─────────────────────────────────────────────

function bindSetupTransfer() {
  document.getElementById("workspaceSaveSetup")?.addEventListener("click", triggerSetupDownload);
  document.getElementById("resultsSaveSetup")?.addEventListener("click", triggerSetupDownload);
  document.getElementById("workspaceLoadSetup")?.addEventListener("click", triggerSetupRestore);
  document.getElementById("resultsLoadSetup")?.addEventListener("click", triggerSetupRestore);
  document.getElementById("workspaceClearSetup")?.addEventListener("click", triggerSetupClear);
  document.getElementById("resultsClearSetup")?.addEventListener("click", triggerSetupClear);
  document.getElementById("runSensitivity")?.addEventListener("click", runSensitivitySweep);

  window.__pslRedesignStateSnapshot = redesignStateSnapshot;
  window.addEventListener("psl:setup-restored", (ev) => {
    applyRedesignStateSnapshot(ev.detail?.state?.redesign);
    setScreen("workspace");
    requestAnimationFrame(() => {
      document.querySelector('.module-card[data-module="portfolio"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function triggerSetupDownload() {
  document.getElementById("downloadSetup")?.click();
  offerRememberSetupAfterTopbarSave();
}

function offerRememberSetupAfterTopbarSave() {
  const rememberSetup = document.getElementById("rememberSetup");
  if (!rememberSetup || rememberSetup.checked) return;

  const shouldRemember = window.confirm("Also remember this setup on this device so it loads next time?");
  if (!shouldRemember) return;

  rememberSetup.checked = true;
  rememberSetup.dispatchEvent(new Event("change", { bubbles: true }));
}

function triggerSetupRestore() {
  document.querySelector("[data-setup-restore-file]")?.click();
}

function triggerSetupClear() {
  document.getElementById("clearLocalData")?.click();
}

function redesignStateSnapshot() {
  return {
    screen: state.screen,
    persona: state.persona,
    outcome: state.outcome,
    detail: state.detail,
    enabledModules: [...state.enabledModules]
  };
}

function applyRedesignStateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
  if (snapshot.persona == null || typeof snapshot.persona === "string") state.persona = snapshot.persona ?? null;
  if (snapshot.outcome == null || typeof snapshot.outcome === "string") state.outcome = snapshot.outcome ?? null;
  if (snapshot.detail === "plain" || snapshot.detail === "pro") state.detail = snapshot.detail;
  if (Array.isArray(snapshot.enabledModules)) {
    state.enabledModules = new Set(snapshot.enabledModules.filter((id) => MODULES.some((module) => module.id === id)));
    for (const module of MODULES) {
      if (module.required) state.enabledModules.add(module.id);
    }
    persistModules();
  }
  writeStorage(STORAGE_PERSONA, state.persona ?? "");
  writeStorage(STORAGE_OUTCOME, state.outcome ?? "");
  writeStorage(STORAGE_DETAIL, state.detail);
  applyAll();
}

function snapshotSummary(latest) {
  return {
    successRate: computeSuccessRate(latest),
    median: pickEndingValue(latest, 0.5),
    fifth: pickEndingValue(latest, 0.05),
    lifetimeTax: sumLifetimeTax(latest),
    healthcare: sumLifetimeHealthcare(latest),
    medianHeirValue: pickHeirValue(latest, 0.5),
    allInSpendRate: allInSpendRate(latest),
    years: planYears(latest).length
  };
}

// ─── KPI strip ─────────────────────────────────────────────────────

function renderKpiStrip() {
  const root = document.getElementById("kpiStrip");
  if (!root) return;
  const latest = window.__pslLatest;
  const summary = latest ? snapshotSummary(latest) : null;
  if (!summary) {
    root.innerHTML = `
      <div class="dh-result-grid">
        <div class="dh-hero">
          <div class="dh-eyebrow">Monte Carlo</div>
          <div class="dh-result-title">Money lasts in</div>
          <div class="dh-big mono" data-empty="true">—</div>
          <div class="dh-sub">Run the model to see simulated futures</div>
        </div>
        <div class="dh-hero dh-historical">
          <div class="dh-eyebrow">Historical</div>
          <div class="dh-result-title">Money lasted in</div>
          <div class="dh-big mono" data-empty="true">—</div>
          <div class="dh-sub">Run the model to see historical paths</div>
        </div>
      </div>
      <div class="dh-kpis">
        <div class="dh-kpi"><span class="kpi-label">Lifetime tax</span><span class="kpi-big mono">—</span></div>
        <div class="dh-kpi"><span class="kpi-label">Healthcare</span><span class="kpi-big mono">—</span></div>
        <div class="dh-kpi"><span class="kpi-label">All-in spend rate</span><span class="kpi-big mono">—</span></div>
        <div class="dh-kpi"><span class="kpi-label">After-tax bequest</span><span class="kpi-big mono">—</span></div>
      </div>`;
    return;
  }
  const pct = summary.successRate;
  const progress = latest?.monteCarlo?.progress;
  const streaming = !!(progress && !progress.complete);
  const totalRuns = progress?.total ?? latest?.monteCarlo?.summary?.runs ?? monteCarloScenarios(latest).length ?? 1000;
  const doneRuns = progress?.done ?? monteCarloScenarios(latest).length ?? totalRuns;
  const pctInt = Math.round(pct * 100);
  const spinner = streaming ? `<span class="kpi-spinner" aria-hidden="true"></span>` : "";
  if (streaming && doneRuns === 0 && !planYears(latest).length) {
    root.innerHTML = `
      <div class="dh-result-grid">
        <div class="dh-hero" data-tier="ok" data-streaming="true">
          <div class="dh-eyebrow">Monte Carlo</div>
          <div class="dh-result-title">Running projections</div>
          <div class="dh-big mono" data-empty="true">—${spinner}</div>
          <div class="dh-sub"><span class="dh-prelim">starting · 0 of ${totalRuns.toLocaleString()}</span></div>
          <div class="dh-mini-grid">
            <div><span>Median ending</span><strong class="mono">—</strong></div>
            <div><span>Worst 5%</span><strong class="mono" data-tone="warn">—</strong></div>
            <div><span>Best 10%</span><strong class="mono">—</strong></div>
          </div>
        </div>
        <div class="dh-hero dh-historical" data-empty="true">
          <div class="dh-eyebrow">Historical</div>
          <div class="dh-result-title">Preparing paths</div>
          <div class="dh-big mono" data-empty="true">—</div>
          <div class="dh-sub">Historical paths pending</div>
        </div>
      </div>
      <div class="dh-kpis">
        <div class="dh-kpi"><span class="kpi-label">Lifetime tax</span><span class="kpi-big mono">—</span></div>
        <div class="dh-kpi"><span class="kpi-label">Healthcare</span><span class="kpi-big mono">—</span></div>
        <div class="dh-kpi"><span class="kpi-label">All-in spend rate</span><span class="kpi-big mono">—</span></div>
        <div class="dh-kpi"><span class="kpi-label">After-tax bequest</span><span class="kpi-big mono">—</span></div>
      </div>`;
    return;
  }
  const historical = historicalSummary(latest);
  const subline = streaming
    ? `<span class="dh-prelim">preliminary · ${doneRuns.toLocaleString()} of ${totalRuns.toLocaleString()}</span>`
    : `of ${totalRuns.toLocaleString()} simulated futures`;
  const historicalSubline = historical
    ? `of ${historical.count.toLocaleString()} historical paths`
    : "Historical paths pending";
  root.innerHTML = `
    <div class="dh-result-grid">
      <div class="dh-hero" data-tier="${tierFor(pct)}" data-streaming="${streaming}">
        <div class="dh-eyebrow">Monte Carlo</div>
        <div class="dh-result-title">Money lasts in</div>
        <div class="dh-big mono">${pctInt}<span class="dh-big-unit">%</span>${spinner}</div>
        <div class="dh-sub">${subline}</div>
        <div class="dh-mini-grid">
          <div><span>Median ending</span><strong class="mono">${formatCurrencyShort(summary.median)}${spinner}</strong></div>
          <div><span>Worst 5%</span><strong class="mono" data-tone="warn">${formatCurrencyShort(summary.fifth)}${spinner}</strong></div>
          <div><span>Best 10%</span><strong class="mono">${formatCurrencyShort(pickEndingValue(latest, 0.9))}${spinner}</strong></div>
        </div>
      </div>
      <div class="dh-hero dh-historical" data-tier="${tierFor(historical?.successRate ?? 0)}" data-empty="${historical ? "false" : "true"}">
        <div class="dh-eyebrow">Historical</div>
        <div class="dh-result-title">Money lasted in</div>
        <div class="dh-big mono">${historical ? Math.round(historical.successRate * 100) : "—"}${historical ? `<span class="dh-big-unit">%</span>` : ""}</div>
        <div class="dh-sub">${historicalSubline}</div>
        <div class="dh-mini-grid">
          <div><span>Median ending</span><strong class="mono">${historical ? formatCurrencyShort(historical.medianEnding) : "—"}</strong></div>
          ${historicalPathTile("Worst path", historical?.worstEnding, historical?.worstIndex, "warn")}
          ${historicalPathTile("Best path", historical?.bestEnding, historical?.bestIndex)}
        </div>
      </div>
    </div>
    <div class="dh-kpis">
      <div class="dh-kpi"><span class="kpi-label">Lifetime tax</span><span class="kpi-big mono">${formatCurrencyShort(summary.lifetimeTax)}</span></div>
      <div class="dh-kpi"><span class="kpi-label">Healthcare</span><span class="kpi-big mono">${formatCurrencyShort(summary.healthcare)}</span></div>
      <div class="dh-kpi"><span class="kpi-label">All-in spend rate</span><span class="kpi-big mono">${(summary.allInSpendRate*100).toFixed(1)}%</span></div>
      <div class="dh-kpi"><span class="kpi-label">After-tax bequest</span><span class="kpi-big mono">${formatCurrencyShort(summary.medianHeirValue)}</span></div>
    </div>`;
}

function renderDecisionPanel() {
  const root = document.getElementById("decisionPanel");
  if (!root) return;
  const latest = window.__pslLatest;
  const decision = latest?.decision;
  if (!latest) {
    root.innerHTML = "";
    return;
  }
  if (!decision || decision.status === "running") {
    const tested = decision?.progress?.done ?? 0;
    root.innerHTML = `
      <div class="decision-shell" data-tone="pending">
        <div>
          <p class="r-section-eyebrow">Decision engine</p>
          <h2>Solving rescue options</h2>
          <p class="decision-headline">${tested ? `${tested} candidates tested. ` : ""}Comparing the base plan against spending, income, reserve, allocation, and healthcare options.</p>
        </div>
      </div>`;
    return;
  }
  if (decision.status !== "ready") {
    root.innerHTML = `
      <div class="decision-shell" data-tone="risk">
        <div>
          <p class="r-section-eyebrow">Decision engine</p>
          <h2>Decision engine unavailable</h2>
          <p class="decision-headline">The base model is still available, but the rescue solver did not return a decision.</p>
        </div>
      </div>`;
    return;
  }

  const base = decision.base;
  const verdict = decision.verdict ?? base?.verdict;
  const target = decision.targetSuccessRate ?? 0.9;
  const diagnosis = decision.diagnosis ?? {};
  const safe = decision.safeSpending;
  const rescues = (Array.isArray(decision.rescueOptions) ? decision.rescueOptions : [])
    .filter(opt => opt.status !== "discarded");
  const headline = decisionHeadline(decision);
  const anatomy = decision.failureAnatomy ?? {};
  const healthcare = decision.healthcare ?? {};
  const confidence = latest.confidence ?? { headline: "Confidence not evaluated", flags: [] };
  const rescueCards = rescues.map((option) => rescueCardHtml(option, base, confidence)).join("");
  const riskGuardrailTable = riskBasedGuardrailTableHtml(decision);
  const diagnosisLine = diagnosis.primary && diagnosis.primary !== "none"
    ? `<p class="decision-sub"><strong>${escapeHtml(diagnosis.label)}.</strong> ${escapeHtml(diagnosis.reason)}</p>`
    : "";
  root.innerHTML = `
    <div class="decision-shell" data-tone="${escapeHtml(verdict?.tone ?? "warn")}">
      <div class="decision-main">
        <p class="r-section-eyebrow">Decision</p>
        <h2>${decisionVerdictLabel(verdict?.label)} at ${formatRate(target)} target</h2>
        <p class="decision-headline">${escapeHtml(headline)}</p>
        <p class="decision-sub">${escapeHtml(verdict?.reason ?? "Evidence is still being evaluated.")}</p>
        ${diagnosisLine}
      </div>
      <div class="decision-evidence">
        <div><span>Monte Carlo</span><strong>${formatRate(base?.monteCarlo?.successRate)}</strong></div>
        <div><span>Historical</span><strong>${formatOptionalRate(base?.historical?.successRate)}</strong></div>
        <div><span>Failed paths</span><strong>${numberText(anatomy.failedCount)}</strong></div>
      </div>
      <div class="decision-rescues">
        ${rescueCards || `<p class="decision-sub">No rescue candidates were available for the current inputs.</p>`}
      </div>
      ${riskGuardrailTable}
      <div class="decision-foot">
        <div>
          <span>Failure anatomy</span>
          <strong>${escapeHtml(anatomy.commonTrigger ?? "No failures in tested paths")}</strong>
          <small>${failureTimingText(anatomy)}</small>
        </div>
        <div>
          <span>Safe spending</span>
          <strong>${safe?.available ? `${formatCurrencyShort(safe.safeTotalSpend)}/yr` : "n/a"}</strong>
          <small>${escapeHtml(safeSpendingText(safe))}</small>
        </div>
        <div>
          <span>Healthcare guardrail</span>
          <strong>${healthcare.magiCeiling != null ? formatCurrencyShort(healthcare.magiCeiling) : "No ceiling"}</strong>
          <small>${healthcareText(healthcare)}</small>
        </div>
        ${sensitivityCardHtml(decision.sensitivity)}
        ${confidenceCardHtml(confidence)}
      </div>
    </div>`;
}

function decisionHeadline(decision) {
  const base = decision.base;
  const spend = base?.scenarioSummary?.targetSpend;
  const parts = [
    `Base plan: ${formatRate(base?.monteCarlo?.successRate)} Monte Carlo success at ${formatCurrencyShort(spend)}/year.`
  ];
  const safe = decision.safeSpending;
  if (safe?.available) {
    if (safe.status === "headroom") {
      parts.push(`Safe spending is about ${formatCurrencyShort(safe.safeTotalSpend)}/year${safe.headroomCapped ? " or more" : ""}, so the current plan has room.`);
    } else if (safe.status === "required-unsustainable") {
      parts.push("Even with no flexible spending the plan misses the target, so income may be required.");
    } else {
      parts.push(`Safe spending is about ${formatCurrencyShort(safe.safeTotalSpend)}/year, a ${formatCurrencyShort(Math.abs(safe.gap))} gap from the ${formatCurrencyShort(safe.currentTargetSpend)} target.`);
    }
  }
  const best = decision.bestOption;
  if (best && best.kind !== "base") {
    parts.push(best.status === "target-met"
      ? `Best fix that meets the target: ${rescueTitle(best)} (${formatRate(best.monteCarlo?.successRate)} success).`
      : `Closest tested option: ${rescueTitle(best)} (${formatRate(best.monteCarlo?.successRate)} success, still short of target).`);
  }
  return parts.join(" ");
}

function rescueTitle(option) {
  const meta = option?.metadata ?? {};
  switch (option?.kind) {
    case "guytonKlingerRescue":
      return "switch to Guyton-Klinger spending guardrails";
    case "riskBasedGuardrailsRescue":
      return "use risk-based historical guardrails";
    case "vpwRescue":
      return "switch to Variable Percentage Withdrawal (VPW)";
    case "discretionaryCut":
      return `cut up to ${formatCurrencyShort(meta.cutAmount ?? 0)} of flexible spending`;
    case "incomeBridge":
      return `earn ${formatCurrencyShort(meta.annualIncome ?? 0)}/year for ${meta.durationYears ?? 0} years`;
    case "combined":
      return "cut spending and earn bridge income";
    case "sequenceReserve":
      return `hold a ${meta.reserveYears ?? 0}-year ${meta.reserveMode ?? "cash"} reserve`;
    case "tipsLadder":
      return `carve out a ${meta.ladderYears ?? 0}-year TIPS ladder`;
    case "allocationShift":
      return `shift to ${Math.round(meta.targetStockPercent ?? 0)}% stock`;
    case "withdrawalShift":
      return "reorder account withdrawals";
    case "healthcareRescue":
      return "discipline MAGI to protect the subsidy";
    case "rothBasisCliffRescue":
      return `use Roth basis with a ${formatCurrencyShort(meta.magiBuffer ?? 0)} MAGI buffer`;
    case "taxableLotRescue":
      return "spend high-basis taxable lots first";
    case "conversionGuardrail":
      return "throttle Roth conversions near MAGI cliffs";
    case "magiSpendTrim":
      return `trim ${formatCurrencyShort(meta.trimAmount ?? 0)} to protect ACA MAGI`;
    case "irmaaLookbackRescue":
      return "smooth MAGI before Medicare";
    case "socialSecurityBridge":
      return `delay Social Security to age ${meta.startAge ?? 70}`;
    default:
      return option?.label ?? "rescue option";
  }
}

function rescueTierLabel(kind) {
  if (kind === "incomeBridge" || kind === "combined") return "Income change";
  if (kind === "discretionaryCut" || kind === "magiSpendTrim" || kind === "guytonKlingerRescue" || kind === "vpwRescue" || kind === "riskBasedGuardrailsRescue") return "Spending change";
  return "No lifestyle change";
}

function safeSpendingText(safe) {
  if (!safe?.available) return "Not enough spending detail to solve.";
  if (safe.status === "headroom") {
    return safe.headroomCapped
      ? "Current spending clears the target with room to spare."
      : `About ${formatCurrencyShort(safe.headroom)}/yr of headroom above the current plan.`;
  }
  if (safe.status === "required-unsustainable") {
    return "Required spending alone misses the target.";
  }
  return `Trim about ${formatCurrencyShort(Math.abs(safe.gap))}/yr to reach the target.`;
}

function capitalizeFirst(text) {
  const str = String(text ?? "");
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

function rescueCardHtml(option, base, confidenceReport = {}) {
  const delta = option.delta?.monteCarloSuccessRate ?? 0;
  const title = rescueTitle(option);
  const tier = rescueTierLabel(option.kind);
  const confidence = rescueConfidenceFor(option, confidenceReport);
  const guardrailSummary = riskBasedGuardrailSummary(option);
  const sideEffect = option.delta?.firstYearSubsidy == null
    ? "No healthcare delta"
    : `${option.delta.firstYearSubsidy >= 0 ? "+" : ""}${formatCurrencyShort(option.delta.firstYearSubsidy)} year-1 subsidy`;
  return `
    <article class="decision-rescue" data-status="${escapeHtml(option.status ?? "tested")}">
      <span>${escapeHtml(tier)}</span>
      <strong>${escapeHtml(capitalizeFirst(title))}</strong>
      <small>${formatRate(base?.monteCarlo?.successRate)} -> ${formatRate(option.monteCarlo?.successRate)} (${signedRate(delta)})</small>
      <small>Historical ${formatOptionalRate(base?.historical?.successRate)} -> ${formatOptionalRate(option.historical?.successRate)}</small>
      ${guardrailSummary ? `<small>${escapeHtml(guardrailSummary)}</small>` : ""}
      <small>${escapeHtml(sideEffect)}</small>
      ${confidenceBadgeHtml(confidence)}
    </article>`;
}

function riskBasedGuardrailSummary(option = {}) {
  const table = option.metadata?.guardrailTable ?? option.scenario?.spendingStrategy?.riskBasedGuardrails?.table;
  if (!table || option.kind !== "riskBasedGuardrailsRescue") return "";
  return `${formatCurrencyShort(table.fixedFailsafeSpend)}/yr failsafe; ${formatCurrencyShort(table.initialSpend)}/yr starting spend with lower/upper triggers.`;
}

function riskBasedGuardrailTableHtml(decision = {}) {
  const option = (Array.isArray(decision.rescueOptions) ? decision.rescueOptions : [])
    .find((item) => item.kind === "riskBasedGuardrailsRescue");
  const table = option?.metadata?.guardrailTable ?? option?.scenario?.spendingStrategy?.riskBasedGuardrails?.table;
  if (!table) return "";
  const rows = [
    ["Fixed failsafe", table.initialPortfolioValue, table.fixedFailsafeSpend, formatRate(table.upperSuccessRate)],
    ["Starting guardrail spend", table.initialPortfolioValue, table.initialSpend, formatRate(table.targetSuccessRate)],
    ["Lower cut trigger", table.lowerGuardrailPortfolioValue, table.lowerAdjustedSpend, formatRate(table.lowerSuccessRate)],
    ["Upper raise trigger", table.upperGuardrailPortfolioValue, table.upperAdjustedSpend, formatRate(table.upperSuccessRate)]
  ];
  return `
    <div class="decision-guardrail-table">
      <div>
        <span>Risk-based guardrails</span>
        <strong>Fixed vs. historical guardrail plan</strong>
        <small>${escapeHtml(table.sequenceCount ?? 0)} historical cohorts; spending values are annual current-dollar targets before taxes/medical unless included in the scenario.</small>
      </div>
      <table>
        <thead><tr><th>Step</th><th>Portfolio trigger</th><th>Annual spend</th><th>Historical target</th></tr></thead>
        <tbody>
          ${rows.map(([label, portfolio, spend, target]) => `
            <tr>
              <td>${escapeHtml(label)}</td>
              <td>${portfolio == null ? "n/a" : escapeHtml(formatCurrencyShort(portfolio))}</td>
              <td>${spend == null ? "n/a" : escapeHtml(formatCurrencyShort(spend))}</td>
              <td>${escapeHtml(target)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>`;
}

function decisionVerdictLabel(label) {
  if (label === "safe") return "Plan looks safe";
  if (label === "unsafe") return "Plan is unsafe";
  return "Plan is fragile";
}

function formatRate(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "n/a";
}

function formatOptionalRate(value) {
  return Number.isFinite(value) ? formatRate(value) : "unavailable";
}

function signedRate(value) {
  if (!Number.isFinite(value)) return "n/a";
  const pct = Math.round(value * 100);
  return `${pct >= 0 ? "+" : ""}${pct} pts`;
}

function numberText(value) {
  return Number.isFinite(value) ? String(value) : "0";
}

function failureTimingText(anatomy = {}) {
  if (!(anatomy.failedCount > 0)) return "No modeled depletion paths in the tested run.";
  const earliest = anatomy.earliestFailureYear ? `earliest Y${anatomy.earliestFailureYear}` : "earliest n/a";
  const median = anatomy.medianFailureYear ? `median Y${Math.round(anatomy.medianFailureYear)}` : "median n/a";
  const stress = failureStressText(anatomy);
  return `${earliest}; ${median}.${stress ? ` ${stress}` : ""}`;
}

function failureStressText(anatomy = {}) {
  const stressors = Array.isArray(anatomy.topStressors) ? anatomy.topStressors.slice(0, 2) : [];
  if (!stressors.length) return "";
  const summary = stressors.map((item) => {
    const pct = Number.isFinite(item.percentage) ? `${Math.round(item.percentage * 100)}%` : "some";
    return `${item.label ?? "stressor"} ${pct}`;
  }).join(", ");
  return `Top stressors: ${summary}.`;
}

function healthcareText(healthcare = {}) {
  if (healthcare.magiCeiling == null) return "No ACA/ConnectorCare ceiling was available for year 1.";
  const buffer = healthcare.magiBuffer ?? 0;
  return `${formatCurrencyShort(Math.abs(buffer))} ${buffer >= 0 ? "under" : "over"} modeled MAGI ceiling.`;
}

function confidenceCardHtml(confidence = {}) {
  // Permanent out-of-model scope notes sink below situational findings so the
  // card leads with what's actually actionable for this run, then names the
  // exclusions. data-level lets the CSS mute the scope-note styling so it
  // reads as a boundary statement, not a fresh red flag.
  const allFlags = Array.isArray(confidence.flags) ? confidence.flags : [];
  const actionable = allFlags.filter((flag) => flag.level !== "out-of-model");
  const scope = allFlags.filter((flag) => flag.level === "out-of-model");
  const flags = [...actionable, ...scope].slice(0, 3);
  const headline = confidence.headline ?? "Confidence not evaluated";
  const flagList = flags.length
    ? `<ul class="confidence-list">${flags.map((flag) => `
      <li data-level="${escapeHtml(flag.level ?? "")}">
        <strong>${escapeHtml(confidenceLevelText(flag.level))}</strong>
        <span>${escapeHtml(flag.title ?? "Review flag")}</span>
      </li>
    `).join("")}</ul>`
    : `<small>No confidence flags were reported for this run.</small>`;
  return `
    <div class="confidence-card">
      <span>Confidence</span>
      <strong>${escapeHtml(headline)}</strong>
      ${flagList}
    </div>`;
}

function sensitivityCardHtml(sensitivity = {}) {
  const items = Array.isArray(sensitivity.top) ? sensitivity.top.slice(0, 3) : [];
  const list = items.length
    ? `<ol class="sensitivity-list">${items.map((item) => `
      <li>
        <strong>${escapeHtml(item.label ?? "Sensitivity")}</strong>
        <span>${escapeHtml(sensitivityDeltaText(item))}</span>
      </li>
    `).join("")}</ol>`
    : `<small>No ranked sensitivity checks are available for this run.</small>`;
  return `
    <div class="sensitivity-card">
      <span>What moves this</span>
      <strong>${items.length ? `${items.length} assumption checks` : "Not evaluated"}</strong>
      ${list}
    </div>`;
}

function sensitivityDeltaText(item = {}) {
  const delta = item.delta?.combinedSuccessRate;
  const stressed = item.stressed?.verdict ? `${item.stressed.verdict} verdict` : "same verdict";
  const change = Number.isFinite(delta) ? `${signedRate(delta)} combined evidence` : "no rate delta";
  const hint = item.controlHint ? ` (${item.controlHint})` : "";
  return `${change}; ${stressed}${hint}.`;
}

function confidenceLevelText(level) {
  switch (level) {
    case "high-confidence":
      return "High";
    case "input-limited":
      return "Input";
    case "assumption-sensitive":
      return "Sensitive";
    case "cpa-review-recommended":
      return "CPA";
    case "out-of-model":
      return "Excluded";
    default:
      return "Flag";
  }
}

function historicalSummary(latest) {
  const list = Array.isArray(latest?.backtests) ? latest.backtests : [];
  if (!list.length) return null;
  const successes = list.filter((b) => b?.success).length;
  const ranked = list
    .map((backtest, index) => ({
      index,
      ending: resultEndingValue(backtest),
      selectable: Array.isArray(backtest?.years) && backtest.years.length > 0
    }))
    .filter((item) => Number.isFinite(item.ending))
    .sort((a, b) => a.ending - b.ending);
  const endings = ranked.map((item) => item.ending);
  const worst = ranked[0] ?? null;
  const best = ranked[ranked.length - 1] ?? null;
  return {
    successRate: successes / list.length,
    count: list.length,
    medianEnding: percentileValue(endings, 0.5),
    worstEnding: worst?.ending ?? NaN,
    bestEnding: best?.ending ?? NaN,
    worstIndex: worst?.selectable ? worst.index : null,
    bestIndex: best?.selectable ? best.index : null
  };
}

function historicalPathTile(label, value, index, tone = "") {
  const toneAttr = tone ? ` data-tone="${tone}"` : "";
  const amount = formatCurrencyShort(value);
  if (!Number.isInteger(index)) {
    return `<div><span>${label}</span><strong class="mono"${toneAttr}>${amount}</strong></div>`;
  }
  const ariaPath = label.toLowerCase().replace(/\s+path$/, "");
  return `
    <button type="button" class="dh-mini-action" data-historical-backtest-index="${index}" aria-label="View ${ariaPath} historical path">
      <span>${label}</span>
      <strong class="mono"${toneAttr}>${amount}</strong>
    </button>`;
}

// ─── Healthcare timeline (ACA → Medicare strip) ────────────────────

function renderHealthTimeline() {
  const root = document.getElementById("healthTimeline");
  const axis = document.getElementById("healthTimelineAxis");
  const heading = document.getElementById("healthHeading");
  if (!root) return;
  const latest = window.__pslLatest;
  const years = planYears(latest);
  if (!years.length) {
    root.innerHTML = "";
    if (axis) axis.innerHTML = "";
    return;
  }

  // Phase per year: medicare once the modeled timeline's primary age reaches
  // 65, else ACA if MAGI was within the ACA universe, else "self" (uncovered /
  // pre-Medicare with no marketplace plan modeled).
  const cells = years.map((y, i) => {
    const age = y.age ?? null;
    const onMedicare = Number.isFinite(age) && age >= 65;
    const acaEnrolled = !!(y.aca && (y.aca.subsidy > 0 || y.aca.netPremium > 0 || y.aca.fplPercent != null));
    const phase = onMedicare ? "medicare" : (acaEnrolled ? "aca" : "self");
    const fplPercent = y.aca?.fplPercent ?? null;
    // "hot" when MAGI is in the upper ACA range (subsidy-cliff sensitive) or
    // first 2–3 Medicare years (IRMAA lookback transition).
    const hotAca = phase === "aca" && fplPercent != null && fplPercent >= 350;
    const yearsOnMedicare = onMedicare && Number.isFinite(age) ? Math.max(0, age - 65) : null;
    const hotMedicare = phase === "medicare" && yearsOnMedicare != null && yearsOnMedicare <= 2;
    return { i, phase, hot: hotAca || hotMedicare, age, year: y.year ?? i + 1 };
  });

  const acaYears = cells.filter(c => c.phase === "aca").length;
  const medicareYears = cells.filter(c => c.phase === "medicare").length;
  if (heading) {
    if (acaYears && medicareYears) heading.textContent = `${acaYears}y ACA → ${medicareYears}y Medicare`;
    else if (medicareYears)       heading.textContent = `${medicareYears}y on Medicare`;
    else if (acaYears)            heading.textContent = `${acaYears}y on ACA marketplace`;
    else                          heading.textContent = "Coverage timeline";
  }

  root.style.setProperty("--health-cols", String(cells.length));
  root.innerHTML = cells.map(c => {
    const label = `Y${c.i + 1}${c.age != null ? ` · age ${Math.round(c.age)}` : ""} · ${c.phase.toUpperCase()}${c.hot ? " (sensitive)" : ""}`;
    return `<div class="htl-y ${c.phase}${c.hot ? " hot" : ""}" title="${label}"></div>`;
  }).join("");

  // Axis: Y1 · start age — Medicare marker — last year · end age
  if (axis) {
    const first = cells[0];
    const last = cells[cells.length - 1];
    const medicareFirst = cells.find(c => c.phase === "medicare");
    const parts = [];
    parts.push(`<span class="htl-ax start">Y1${first.age != null ? ` · ${Math.round(first.age)}` : ""}</span>`);
    if (medicareFirst) {
      const pct = (medicareFirst.i / Math.max(1, cells.length - 1)) * 100;
      parts.push(`<span class="htl-ax mid" style="left:${pct}%">Medicare at 65</span>`);
    }
    parts.push(`<span class="htl-ax end">Y${cells.length}${last.age != null ? ` · ${Math.round(last.age)}` : ""}</span>`);
    axis.innerHTML = parts.join("");
  }
}

// ─── Action plan card ──────────────────────────────────────────────

function renderActionList() {
  const root = document.getElementById("actionList");
  if (!root) return;
  const latest = window.__pslLatest;
  const year = planYears(latest)[0];
  if (!year) { root.innerHTML = ""; return; }

  const items = [];
  // Withdrawal source
  const withdrawals = year.sales ?? [];
  const taxableW = withdrawals.filter(s => s.accountType === "taxable").reduce((t, s) => t + (s.proceeds ?? 0), 0);
  const traditionalW = withdrawals.filter(s => s.accountType === "traditional").reduce((t, s) => t + (s.proceeds ?? 0), 0);
  const rothW = withdrawals.filter(s => s.accountType === "roth").reduce((t, s) => t + (s.proceeds ?? 0), 0);
  if (taxableW > 0) items.push({ kind: "withdraw", confidenceKind: "withdrawal", title: "Sell from taxable", sub: "0% LTCG bracket where possible", amt: taxableW });
  if (traditionalW > 0) items.push({ kind: "withdraw", confidenceKind: "traditionalWithdrawal", title: "Sell from Traditional", sub: "Ordinary income", amt: traditionalW });
  if (rothW > 0) items.push({ kind: "withdraw", confidenceKind: "withdrawal", title: "Sell from Roth", sub: "Tax-free draws", amt: rothW });
  if (year.rothConversionAmount > 0) items.push({ kind: "convert", confidenceKind: "rothConversion", title: "Convert Trad → Roth", sub: `In ${(Number(document.getElementById("rothTargetRate")?.value) || 12)}% bracket target`, amt: year.rothConversionAmount });
  if (year.aca?.subsidy > 0) items.push({ kind: "aca", confidenceKind: "magiManagement", title: "Cap MAGI for PTC", sub: `+${formatYearCurrencyShort(year.aca.subsidy, year)} PTC`, amt: year.magi });
  if (year.taxGainHarvested > 0) items.push({ kind: "harvest", confidenceKind: "taxGainHarvesting", title: "Realize gains", sub: "Use favorable gain room", amt: year.taxGainHarvested });
  if (year.realizedCapitalLosses > 0) items.push({ kind: "harvest", confidenceKind: "taxLossHarvesting", title: "Tax-loss harvest", sub: "$3k ordinary offset + carryforward", amt: year.realizedCapitalLosses });
  if ((year.assetLocation?.relocatedAmount ?? 0) > 0) items.push({ kind: "rebalance", confidenceKind: "assetLocation", title: "Relocate assets", sub: "Move income assets into sheltered accounts", amt: year.assetLocation.relocatedAmount });
  if ((year.allocationStrategy?.rebalancedAmount ?? 0) > 0) items.push({ kind: "rebalance", confidenceKind: "assetAllocation", title: "Rebalance allocation", sub: `Target ${Math.round(year.allocationStrategy.targetStockPercent ?? 70)}% stock sleeve`, amt: year.allocationStrategy.rebalancedAmount });
  if ((year.hsaContribution?.amount ?? 0) > 0) items.push({ kind: "convert", confidenceKind: "hsaContribution", title: "Fund HSA", sub: "Above-the-line deduction + invested medical reserve", amt: year.hsaContribution.amount });
  if ((year.rmdAmount ?? 0) > 0) items.push({ kind: "rmd", confidenceKind: "traditionalWithdrawal", title: "Take RMD", sub: "IRS-mandated distribution", amt: year.rmdAmount });

  root.innerHTML = items.length ? items.map(it => `
    <li>
      <span class="action-tag" data-kind="${it.kind}">${it.kind}</span>
      <div class="action-text">
        <span class="action-title">${it.title}</span>
        <span class="action-sub">${it.sub}</span>
        ${actionListConfidenceHtml(actionConfidenceFor(it.confidenceKind, latest?.confidence))}
      </div>
      <span class="action-amt">${formatYearCurrencyShort(it.amt, year)}</span>
    </li>`).join("") : `<li><div class="action-text"><span class="action-sub">No actions for year 1.</span></div></li>`;
}

function actionListConfidenceHtml(confidence = {}) {
  return confidenceBadgeHtml(confidence);
}

function confidenceBadgeHtml(confidence = {}) {
  return `
    <span class="action-confidence" data-level="${escapeHtml(confidence.level ?? "high-confidence")}" title="${escapeHtml(confidence.detail ?? "")}">
      ${escapeHtml(confidenceLevelText(confidence.level))}
      <span>${escapeHtml(confidence.title ?? "Source-versioned rule")}</span>
    </span>`;
}

// ─── Bracket fill ──────────────────────────────────────────────────

function renderBracketFill() {
  const root = document.getElementById("bracketList");
  if (!root) return;
  const latest = window.__pslLatest;
  const years = planYears(latest);
  const ordinaryBrackets = latest?.taxProfile?.ordinaryBrackets ?? [];
  const preferentialBrackets = latest?.taxProfile?.capitalGainsBrackets ?? [];
  if (!ordinaryBrackets.length || !years.length) { root.innerHTML = ""; return; }

  // Bracket fill shows just *investment income* — what the portfolio passively
  // throws off — so the empty space in each bracket reads as headroom for
  // discretionary moves (Roth conversions, harvest, traditional withdrawals).
  //   Ordinary side: interest + non-qualified dividends (a.k.a. ordinary
  //   investment income). RMDs / Roth conversions / SS are excluded — they're
  //   strategy levers, not unavoidable income.
  //   Preferential side: long-term capital gains + qualified dividends.
  const investmentIncome = (y) => ({
    ordinary: y.taxes?.ordinaryInvestmentIncome ?? 0,
    longTerm: y.taxes?.taxableLongTermCapitalGains ?? 0,
    qualified: y.taxes?.taxableQualifiedDividends ?? 0,
  });

  // Follow the shared year slider (used by the cash-flow Sankey + withdrawal
  // mix highlight) so all "this year" cards stay in sync. The user can scrub
  // forward to see future years (e.g. when Age 65+ kicks in); they shouldn't
  // see Age 65+ on the bracket card while still being 44.
  const bestIdx = Math.max(0, Math.min(years.length - 1, currentSelectedYearIndex()));
  const year = years[bestIdx];

  const inflation = Number.isFinite(year?.inflationIndex) && year.inflationIndex > 0
    ? year.inflationIndex
    : 1;

  // Respect the global Today's $ / Future $ toggle (#viewMode select, kept in
  // sync by the topbar pill toggle):
  //   - "real"    (default, "Today's $" button): deflated to today's purchasing power
  //   - "nominal" ("Future $" button):           future-inflated face values
  // The simulator outputs values in nominal (year-N) dollars; bracket caps
  // and standard deduction in taxProfile are in today's (year-1) dollars.
  // Two scale factors bring everything onto the chosen display scale.
  const viewMode = document.getElementById("viewMode")?.value || "real";
  const isReal = viewMode === "real";
  const bracketScale = isReal ? 1 : inflation;          // multiply profile-side values
  const incomeScale = isReal ? 1 / inflation : 1;       // multiply simulator-side values

  // Pre-scale the bracket schedules so allocateBracketRows sees them in the
  // chosen display scale.
  const scaleSchedule = (schedule) => schedule.map(b => ({
    rate: b.rate,
    upTo: Number.isFinite(b.upTo) ? b.upTo * bracketScale : null,
  }));
  const scaledOrdinary = scaleSchedule(ordinaryBrackets);
  const scaledPreferential = scaleSchedule(preferentialBrackets);

  // Update the card eyebrow + title to reflect which year and which dollar scale.
  const cell = root.closest(".dash-cell, .r-panel");
  const eyebrow = cell?.querySelector(".r-section-eyebrow, .r-eyebrow");
  const title = cell?.querySelector(".r-card-title, h2");
  const dollarLabel = isReal ? "today's $" : `Year ${year.year ?? bestIdx + 1} $`;
  if (eyebrow) eyebrow.textContent = `Tax · Year ${bestIdx + 1}${year.age != null ? ` · age ${Math.round(year.age)}` : ""} · ${dollarLabel}`;

  const inc = investmentIncome(year);
  const incTotal = inc.ordinary + inc.longTerm + inc.qualified;
  if (title) title.textContent = incTotal > 0 ? "Investment income vs. brackets" : "No investment income this year";
  const incScaled = {
    ordinary: inc.ordinary * incomeScale,
    longTerm: inc.longTerm * incomeScale,
    qualified: inc.qualified * incomeScale,
  };

  // Walk each bracket schedule from the bottom and allocate the passive
  // income across them. Schedules + income are already on the chosen scale.
  const ordinaryRows = allocateBracketRows(scaledOrdinary, incScaled.ordinary, 7);
  const preferentialRows = preferentialBrackets.length
    ? allocateBracketRows(scaledPreferential, incScaled.longTerm + incScaled.qualified, 3)
    : [];

  // Use one shared max so both groups share a visual scale (capital gains
  // brackets are wider than ordinary brackets, so the relative size is
  // meaningful when compared together).
  const maxFinite = Math.max(
    ...ordinaryRows.map(r => Number.isFinite(r.capacity) ? r.capacity : 0),
    ...preferentialRows.map(r => Number.isFinite(r.capacity) ? r.capacity : 0),
    1
  );
  for (const r of [...ordinaryRows, ...preferentialRows]) {
    if (!Number.isFinite(r.capacity)) r.capacity = maxFinite;
  }

  const renderGroup = (kind, label, rows, total) => `
    <li class="bracket-section-head" data-kind="${kind}">
      <span class="bracket-section-label">${label}</span>
      <span class="bracket-section-total">${total > 0 ? formatCurrencyShort(total) : "—"}</span>
    </li>
    ${rows.map(b => bracketRowHtml(b, maxFinite)).join("")}
  `;

  let html = renderGroup("ordinary", "Interest & non-qualified dividends", ordinaryRows, incScaled.ordinary);
  if (preferentialRows.length) {
    html += renderGroup("preferential", "Long-term gains & qualified dividends", preferentialRows, incScaled.longTerm + incScaled.qualified);
  }
  html += renderDeductionsSection(year, latest?.taxProfile ?? {}, bracketScale, incomeScale);
  root.innerHTML = html;
}

// Compute and render the "Deductions & credits" section below the brackets.
// Deduction bars are split-colored to show how much was absorbed by ordinary
// income vs long-term gains + qualified dividends (deductions stack against
// ordinary first, then spill into preferential income).
//
// Two scale factors come in from the caller so the values land on the same
// display scale as the bracket bars above (nominal Year-N $ or real today's $):
//   - bracketScale: multiplier for profile-side values (in today's dollars)
//   - incomeScale:  multiplier for simulator-side values (in nominal year-N dollars)
//
// Each applicable deduction is its own row; we don't merge std + age 65.
// Only rows with non-zero capacity are emitted.
function renderDeductionsSection(year, profile, bracketScale, incomeScale) {
  // Available deductions for this year.
  const stdDed = (profile?.standardDeduction ?? 0) * bracketScale;
  const age65 = (year?.age65AdditionalDeduction ?? 0) * incomeScale;
  const itemized = (year?.taxes?.itemizedDeduction ?? 0) * incomeScale;
  const deductionKind = year?.taxes?.federalDeductionKind ?? "standard";
  const seniorBonus = (year?.enhancedSeniorDeduction ?? year?.taxes?.enhancedSeniorDeduction ?? 0) * incomeScale;
  const additional = (profile?.additionalDeduction ?? 0) * bracketScale;
  // Capital-loss offset is an above-the-line ordinary-only deduction;
  // treat it as ordinary-absorbing capacity if it actually fired this year.
  const lossOffset = (year?.taxes?.ordinaryLossOffset ?? 0) * incomeScale;

  // Walk the available deductions in IRS order and allocate gross income
  // into each, ordinary first then preferential spill-over. Each call
  // mutates remainingOrd / remainingPref so later rows see only what's left.
  let remainingOrd = (year?.taxes?.ordinaryIncome ?? 0) * incomeScale;
  let remainingPref = ((year?.taxes?.longTermCapitalGains ?? 0) + (year?.taxes?.qualifiedDividends ?? 0)) * incomeScale;
  const allocate = (capacity) => {
    const ordAbsorbed = Math.min(remainingOrd, capacity);
    remainingOrd -= ordAbsorbed;
    const prefAbsorbed = Math.min(remainingPref, Math.max(0, capacity - ordAbsorbed));
    remainingPref -= prefAbsorbed;
    return { capacity, ordAbsorbed, prefAbsorbed };
  };

  const rows = [];

  // Capital-loss offset is above-the-line and ordinary-only — applied
  // BEFORE the standard deduction in IRS order.
  if (lossOffset > 0) {
    const cap = lossOffset;
    const ordAbsorbed = Math.min(remainingOrd, cap);
    remainingOrd -= ordAbsorbed;
    rows.push({ label: "CL loss", fullLabel: "Capital-loss ordinary offset", capacity: cap, ordAbsorbed, prefAbsorbed: 0 });
  }
  if (deductionKind === "itemized" && itemized > 0) {
    rows.push({ label: "Itemized", fullLabel: "Itemized deductions", ...allocate(itemized) });
  } else if (stdDed > 0) {
    rows.push({ label: "Std ded", fullLabel: "Standard deduction", ...allocate(stdDed) });
    if (age65 > 0) {
      rows.push({ label: "Age 65+", fullLabel: "Age 65 additional standard deduction", ...allocate(age65) });
    }
  }
  if (seniorBonus > 0) {
    rows.push({ label: "Sr bonus", fullLabel: "Enhanced senior deduction", ...allocate(seniorBonus) });
  }
  if (additional > 0) {
    rows.push({ label: "Other", fullLabel: "Other deductions", ...allocate(additional) });
  }

  // Credits don't get "filled by income" the way deductions do — they reduce
  // tax owed after brackets. Show as a simple value row when present.
  const ctcUsed = (year?.taxes?.nonrefundableChildTaxCredit ?? year?.taxes?.childTaxCredit ?? 0) * incomeScale;
  const actcRefund = (year?.taxes?.additionalChildTaxCredit ?? 0) * incomeScale;
  const otherCredits = (year?.taxes?.additionalCreditsUsed ?? year?.taxes?.additionalCredits ?? 0) * incomeScale;
  const creditsHtml = (ctcUsed > 0 || actcRefund > 0 || otherCredits > 0) ? `
    ${ctcUsed > 0 ? creditRow("CTC", "Child tax credit used", ctcUsed) : ""}
    ${actcRefund > 0 ? creditRow("ACTC", "Refundable additional child tax credit", actcRefund) : ""}
    ${otherCredits > 0 ? creditRow("Credits", "Other credits used", otherCredits) : ""}
  ` : "";

  if (!rows.length && !creditsHtml) return "";

  const totalAbsorbed = rows.reduce((t, r) => t + r.ordAbsorbed + r.prefAbsorbed, 0);
  return `
    <li class="bracket-section-head" data-kind="deductions">
      <span class="bracket-section-label">Deductions &amp; credits</span>
      <span class="bracket-section-total">${totalAbsorbed > 0 ? formatCurrencyShort(totalAbsorbed) + " absorbed" : "—"}</span>
    </li>
    ${rows.map(r => deductionRowHtml(r)).join("")}
    ${creditsHtml}
  `;
}

function deductionRowHtml(r) {
  // Deduction bars use a *full-width* scale (the bar always fills its column)
  // rather than the bracket scale — a $32k standard deduction would otherwise
  // render as a tiny sliver next to a $600k+ top bracket, hiding the
  // ord/LT split colors that are the whole point of this row.
  const ordPct = r.capacity > 0 ? (r.ordAbsorbed / r.capacity) * 100 : 0;
  const prefPct = r.capacity > 0 ? (r.prefAbsorbed / r.capacity) * 100 : 0;
  const total = r.ordAbsorbed + r.prefAbsorbed;
  const empty = total <= 0.01;
  const tip = `${r.fullLabel}: ${formatCurrencyShort(r.capacity)} (ord ${formatCurrencyShort(r.ordAbsorbed)} · LT ${formatCurrencyShort(r.prefAbsorbed)})`;
  return `
    <li class="bracket-row deduction-row">
      <span class="bracket-rate deduction-label" title="${r.fullLabel}">${r.label}</span>
      <div class="bracket-bar deduction-bar" title="${tip}">
        <div class="bracket-fill ord-fill" style="width:${ordPct.toFixed(1)}%" data-empty="${r.ordAbsorbed <= 0.01}"></div>
        <div class="bracket-fill ltcg-fill" style="width:${prefPct.toFixed(1)}%" data-empty="${r.prefAbsorbed <= 0.01}"></div>
      </div>
      <span class="bracket-amt">${empty ? "—" : formatCurrencyShort(total)}</span>
    </li>`;
}

function creditRow(label, fullLabel, amount) {
  return `
    <li class="bracket-row credit-row">
      <span class="bracket-rate deduction-label" title="${fullLabel}">${label}</span>
      <div class="credit-pill" title="${fullLabel} applied">applied</div>
      <span class="bracket-amt">−${formatCurrencyShort(amount)}</span>
    </li>`;
}

// Bracket schedules arrive pre-scaled into the active display basis; `amount`
// should already be on that same basis so the comparison stays apples-to-apples.
function allocateBracketRows(schedule, amount, limit) {
  let remaining = Math.max(0, amount);
  return schedule.slice(0, limit).map((b, i) => {
    const lower = i === 0 ? 0 : (schedule[i - 1].upTo ?? 0);
    const upper = Number.isFinite(b.upTo) ? b.upTo : null;
    const capacity = upper != null ? Math.max(0, upper - lower) : null;
    const hit = capacity != null ? Math.min(remaining, capacity) : remaining;
    remaining -= hit;
    return { rate: b.rate ?? 0, lower, upper, capacity, hit };
  });
}

function bracketRowHtml(b, maxFinite) {
  const widthPct = (b.capacity / maxFinite) * 100;
  const fillFrac = b.capacity > 0 ? Math.max(0, Math.min(1, b.hit / b.capacity)) : 0;
  const empty = b.hit <= 0.0001;
  const capLabel = Number.isFinite(b.upper) ? formatCurrencyShort(b.upper) : "∞";
  return `
    <li class="bracket-row">
      <span class="bracket-rate">${Math.round(b.rate * 100)}%</span>
      <div class="bracket-bar" style="width:${widthPct.toFixed(1)}%" title="${formatCurrencyShort(b.lower)} – ${capLabel}">
        <div class="bracket-fill" style="width:${(fillFrac*100).toFixed(1)}%" data-empty="${empty}"></div>
      </div>
      <span class="bracket-amt">${empty ? "—" : formatCurrencyShort(b.hit)}</span>
    </li>`;
}

// ─── Withdrawal mix per year ───────────────────────────────────────

function renderWithdrawalMix() {
  const root = document.getElementById("withdrawalMix");
  const legend = document.getElementById("mixLegend");
  if (!root) return;
  const latest = window.__pslLatest;
  const years = withdrawalMixVisibleYears(planYears(latest));
  if (!years.length) { root.innerHTML = ""; if (legend) legend.innerHTML = ""; return; }
  const selectedYearNumber = currentSelectedYearIndex() + 1;
  const picked = withdrawalMixYearPicks(years, selectedYearNumber - 1);

  root.innerHTML = picked.map(({ year: y, labels }) => {
    const tax  = y.sales?.filter(s => s.accountType === "taxable").reduce((t, s) => t + (s.proceeds ?? 0), 0) ?? 0;
    const trad = y.sales?.filter(s => s.accountType === "traditional").reduce((t, s) => t + (s.proceeds ?? 0), 0) ?? 0;
    const roth = y.sales?.filter(s => s.accountType === "roth").reduce((t, s) => t + (s.proceeds ?? 0), 0) ?? 0;
    const hsa  = y.sales?.filter(s => s.accountType === "hsa").reduce((t, s) => t + (s.proceeds ?? 0), 0) ?? 0;
    const ss   = y.socialSecurity?.benefit ?? 0;
    const rmd  = y.rmdAmount ?? 0;
    const total = Math.max(1, tax + trad + roth + hsa + ss + rmd);
    const segs = [
      { cls: "mix-trad", v: trad, label: "Trad" },
      { cls: "mix-roth", v: roth, label: "Roth" },
      { cls: "mix-tax",  v: tax,  label: "Tax" },
      { cls: "mix-hsa",  v: hsa,  label: "HSA" },
      { cls: "mix-rmd",  v: rmd,  label: "RMD" },
      { cls: "mix-ss",   v: ss,   label: "SS" }
    ].filter(s => s.v > 0);
    const isSelected = y.yearIndex === selectedYearNumber;
    const labelText = labels.join(", ");
    return `
      <button type="button" class="mix-col" data-year-index="${y.yearIndex - 1}" data-selected="${isSelected ? "true" : "false"}" aria-pressed="${isSelected ? "true" : "false"}" aria-label="Year ${y.yearIndex}${y.age ? `, age ${Math.round(y.age)}` : ""}${labelText ? `, ${labelText}` : ""} — click to inspect">
        <div class="mix-stack">
          ${segs.map(s => `<span class="${s.cls}" style="flex-basis:${(s.v/total*100).toFixed(2)}%">${s.v/total > 0.12 ? s.label : ""}</span>`).join("")}
        </div>
        ${labels.length ? `<span class="mix-badges">${labels.map((label) => `<span class="mix-badge" data-kind="${label.toLowerCase()}">${label}</span>`).join("")}</span>` : ""}
        <span class="mix-year">Y${y.yearIndex}</span>
        <span class="mix-age">${y.age ? Math.round(y.age) : ""}</span>
      </button>`;
  }).join("");
  if (legend) legend.innerHTML = `
    <span><span class="swatch" style="background:#117a4d"></span>Taxable</span>
    <span><span class="swatch" style="background:#5946d8"></span>Traditional</span>
    <span><span class="swatch" style="background:#1f4ed8"></span>Roth</span>
    <span><span class="swatch" style="background:#0e7da6"></span>HSA</span>
    <span><span class="swatch" style="background:#c43838"></span>RMD</span>
    <span><span class="swatch" style="background:#117a4d;opacity:.55"></span>Soc Sec</span>`;
}

function withdrawalMixVisibleYears(years = []) {
  const max = Number(document.getElementById("yearRange")?.max);
  if (!Number.isFinite(max) || max < 1) return years;
  return years.slice(0, Math.min(years.length, Math.trunc(max)));
}

function withdrawalMixYearPicks(years, selectedIndex = 0) {
  const picks = new Map();
  const add = (index, label = null) => {
    const bounded = Math.max(0, Math.min(years.length - 1, Number(index)));
    const year = years[bounded];
    if (!year) return;
    const existing = picks.get(bounded) ?? { year, labels: [] };
    if (label && !existing.labels.includes(label)) existing.labels.push(label);
    picks.set(bounded, existing);
  };

  // Keep the strip digestible while guaranteeing the important outlier years
  // are present and clickable.
  const stride = Math.max(1, Math.round(years.length / 8));
  for (let i = 0; i < years.length; i += stride) add(i);
  add(years.length - 1);
  add(selectedIndex);

  const ranked = years
    .map((year, index) => ({ index, value: displayAmount(year?.endingPortfolioValue ?? NaN, year) }))
    .filter((item) => Number.isFinite(item.value));
  if (ranked.length) {
    ranked.sort((a, b) => a.value - b.value);
    add(ranked[0].index, "Worst");
    add(ranked[ranked.length - 1].index, "Best");
  }

  return [...picks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, pick]) => pick);
}

function currentSelectedYearIndex() {
  const slider = document.getElementById("yearRange");
  const raw = Number(slider?.value);
  return Number.isFinite(raw) ? raw - 1 : 0;
}

function selectYearAcrossViews(yearIndex) {
  const slider = document.getElementById("yearRange");
  if (!slider) return;
  const max = Number(slider.max) || 1;
  const clamped = Math.max(0, Math.min(max - 1, yearIndex));
  slider.value = String(clamped + 1);
  // Drive app.mjs's existing input listener so KPIs, year table, asset
  // breakdown, flow/sales, etc. all re-render against the picked year.
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  syncMixSelectedHighlight(clamped);
}

function syncMixSelectedHighlight(yearIndex) {
  const root = document.getElementById("withdrawalMix");
  if (!root) return;
  root.querySelectorAll(".mix-col[data-year-index]").forEach(col => {
    const idx = Number(col.dataset.yearIndex);
    const on = idx === yearIndex;
    col.dataset.selected = on ? "true" : "false";
    col.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function bindRunsHint() {
  const input = document.getElementById("runs");
  const hint = document.getElementById("runsHint");
  if (!input || !hint) return;
  const defaultText = hint.textContent;
  const warnText = `Above ${RUNS_CACHE_THRESHOLD.toLocaleString()} runs: results may not fit in the refresh-from-cache, so reloading the page will trigger a fresh recompute instead of an instant restore.`;
  const failedText = `The last run was too large to cache — a page reload will re-run the model instead of restoring instantly. Lower runs to ${RUNS_CACHE_THRESHOLD.toLocaleString()} or below to enable refresh-from-cache.`;
  const update = () => {
    if (lastCacheOk === false) {
      hint.dataset.warning = "true";
      hint.textContent = failedText;
      return;
    }
    const value = Number(input.value);
    const tooMany = Number.isFinite(value) && value > RUNS_CACHE_THRESHOLD;
    hint.dataset.warning = tooMany ? "true" : "false";
    hint.textContent = tooMany ? warnText : defaultText;
  };
  input.addEventListener("input", () => { lastCacheOk = null; update(); });
  input.addEventListener("change", () => { lastCacheOk = null; update(); });
  window.addEventListener("psl:cache-status", (ev) => {
    lastCacheOk = ev.detail?.cached !== false;
    if (lastCacheOk === false) {
      console.warn("[PSL] Results too large to save in sessionStorage; refresh will trigger a recompute.");
    }
    update();
  });
  update();
}

function bindWithdrawalMix() {
  const root = document.getElementById("withdrawalMix");
  if (!root) return;
  root.addEventListener("click", (ev) => {
    const col = ev.target.closest(".mix-col[data-year-index]");
    if (!col) return;
    selectYearAcrossViews(Number(col.dataset.yearIndex));
  });
  // Keep the highlight in sync when the year is changed elsewhere (slider,
  // year-table row click). app.mjs already handles those; we just listen for
  // the same input event, re-mark the selected column, and re-paint anything
  // else that's year-scoped (bracket fill).
  document.getElementById("yearRange")?.addEventListener("input", () => {
    renderWithdrawalMix();
    syncMixSelectedHighlight(currentSelectedYearIndex());
    renderBracketFill();
  });
}

function bindHistoricalPathLinks() {
  const root = document.getElementById("kpiStrip");
  if (!root) return;
  root.addEventListener("click", (ev) => {
    const button = ev.target.closest("[data-historical-backtest-index]");
    if (!button) return;
    const index = Number(button.dataset.historicalBacktestIndex);
    if (!Number.isInteger(index)) return;
    if (typeof window.__pslSelectHistoricalBacktest === "function") {
      window.__pslSelectHistoricalBacktest(index);
    }
  });
}

// ─── Sensitivity tornado ───────────────────────────────────────────

async function runSensitivitySweep() {
  const meta = document.getElementById("sensitivityMeta");
  const list = document.getElementById("tornadoList");
  if (!list) return;
  if (!window.__pslLatest) {
    if (meta) meta.textContent = "Run the model first.";
    return;
  }
  if (meta) meta.textContent = "Sweeping…";

  // We perturb a small set of input fields and re-run. To stay fast, we use
  // a low Monte Carlo runs count, then restore.
  const sweeps = [
    { id: "targetSpend",  label: "Yearly spend",     step:  0.10, format: "pct" },
    { id: "rothTargetRate", label: "Roth conv. amount", step: 0.20, format: "pct" },
    // Equity returns approximated by toggling sequence-risk reserve mode is too coarse;
    // we sweep the random seed for noise, social-security age, and TLH on/off as proxies.
  ];
  const baseline = computeSuccessRate(window.__pslLatest);
  const results = [];
  const runsField = document.getElementById("runs");
  const savedRuns = runsField?.value;
  if (runsField) { runsField.value = "75"; }

  for (const s of sweeps) {
    const field = document.getElementById(s.id);
    if (!field) continue;
    const original = field.value;
    const orig = Number(original);
    if (!Number.isFinite(orig)) continue;
    // Negative perturbation
    field.value = String(Math.max(0, orig * (1 - s.step)));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await runOnce();
    const negRate = computeSuccessRate(window.__pslLatest) - baseline;
    // Positive perturbation
    field.value = String(orig * (1 + s.step));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await runOnce();
    const posRate = computeSuccessRate(window.__pslLatest) - baseline;
    field.value = original;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    results.push({ label: s.label, neg: negRate, pos: posRate, units: `±${(s.step*100).toFixed(0)}%` });
  }

  if (runsField && savedRuns != null) { runsField.value = savedRuns; }
  await runOnce(); // restore baseline run
  paintTornado(results);
  if (meta) meta.textContent = "Click a row to compare.";
}

function paintTornado(results) {
  const list = document.getElementById("tornadoList");
  if (!list) return;
  if (!results.length) { list.innerHTML = `<li class="tornado-row"><span class="tornado-label">—</span></li>`; return; }
  const max = Math.max(...results.flatMap(r => [Math.abs(r.neg), Math.abs(r.pos)]), 0.01);
  list.innerHTML = results.map(r => {
    const negPct = Math.min(100, Math.abs(r.neg) / max * 50);
    const posPct = Math.min(100, Math.abs(r.pos) / max * 50);
    return `
      <li class="tornado-row">
        <span class="tornado-label">${r.label}</span>
        <div class="tornado-bar">
          <span class="tornado-axis"></span>
          <span class="tornado-neg" style="width:${negPct}%">${(r.neg*100).toFixed(0)}pp</span>
          <span class="tornado-pos" style="width:${posPct}%">+${(r.pos*100).toFixed(0)}pp</span>
        </div>
        <span class="tornado-units">${r.units}</span>
      </li>`;
  }).join("");
}

function runOnce() {
  return new Promise(resolve => {
    const onDone = () => { window.removeEventListener("psl:run-complete", onDone); resolve(); };
    window.addEventListener("psl:run-complete", onDone, { once: true });
    if (!runModelFromRedesign()) {
      window.removeEventListener("psl:run-complete", onDone);
      resolve();
      return;
    }
    // Safety timer
    setTimeout(resolve, 8000);
  });
}

// ─── Run-completion observation ────────────────────────────────────

function runModelFromRedesign(opts) {
  if (typeof window.__pslRunModels !== "function") return false;
  window.__pslRunModels(opts);
  return true;
}

function flagPendingRun() {
  pendingRunAdvance = true;
}

function hookRunCompletion() {
  // Run-complete is dispatched by app.mjs when the worker hands back the
  // final summary. We use it to refresh workspace summary chips and to
  // double-check we've landed on results in case the first-scenario event
  // was missed (unlikely, but defensive).
  window.addEventListener("psl:run-complete", () => {
    rerenderResults();
    syncWorkspaceSummary();
    if (pendingRunAdvance) {
      pendingRunAdvance = false;
      if (state.screen === "workspace") setScreen("results");
    }
  });
}

function rerenderResults() {
  renderKpiStrip();
  renderDecisionPanel();
  renderRescueComparisonTable();
  renderTradeoffFrontierTable();
  renderActionList();
  renderBracketFill();
  renderWithdrawalMix();
  renderHealthTimeline();
  // Update results topbar meta
  const meta = document.getElementById("resultsMeta");
  if (meta && window.__pslLatest) {
    const runs = window.__pslLatest?.monteCarlo?.summary?.runs ?? "—";
    const years = planYears(window.__pslLatest).length || "—";
    const cacheNote = lastCacheOk === false ? " · not cached for refresh" : "";
    meta.textContent = `Updated just now · ${runs} sims · ${years} years${cacheNote}`;
    meta.dataset.cacheOk = lastCacheOk === false ? "false" : "true";
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value == null) return;
  el.value = String(value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function readStorage(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; }
  catch { return fallback; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function writeJsonStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// True if the user has ever saved workspace state (assets, inputs, etc.).
// app.mjs writes this snapshot on any meaningful interaction, so its absence
// means the user hasn't engaged with the app yet and would otherwise see
// results computed from the sample-data fallback.
function hasStoredWorkspaceData() {
  try {
    const raw = localStorage.getItem("portfolio-success-lab:v3");
    if (!raw) return false;
    const stored = JSON.parse(raw);
    return !!(stored && Array.isArray(stored.assets) && stored.assets.length > 0);
  } catch {
    return false;
  }
}

// True if app.mjs has cached the last run's results in sessionStorage. The
// results-screen refresh guard treats this as "usable data" — if cached
// results exist we'd rather restore them than punt the user back to step 1,
// even if the setup-state localStorage key happens to be missing.
function hasCachedResults() {
  try {
    return !!sessionStorage.getItem(RESULTS_CACHE_KEY);
  } catch {
    return false;
  }
}

// Diagnostic snapshot of every storage key the app touches. Printed to the
// console when the refresh guard runs so it's possible to tell at a glance
// which storage entry is missing when the guard misfires.
function describeStorageState() {
  let setupRaw = null, setupAssets = 0, setupBytes = 0;
  try {
    setupRaw = localStorage.getItem("portfolio-success-lab:v3");
    setupBytes = setupRaw?.length ?? 0;
    if (setupRaw) {
      const parsed = JSON.parse(setupRaw);
      setupAssets = Array.isArray(parsed?.assets) ? parsed.assets.length : 0;
    }
  } catch { /* ignore */ }
  let cacheBytes = 0;
  try {
    cacheBytes = sessionStorage.getItem(RESULTS_CACHE_KEY)?.length ?? 0;
  } catch { /* ignore */ }
  return {
    hasSetupState: setupBytes > 0 && setupAssets > 0,
    setupStateBytes: setupBytes,
    setupAssetCount: setupAssets,
    hasCachedResults: cacheBytes > 0,
    cacheBytes,
    persistedScreen: (() => { try { return localStorage.getItem("psl:redesign:screen"); } catch { return null; } })(),
    queryScreen: new URL(window.location.href).searchParams.get("screen")
  };
}

function planYears(latest) {
  // The deterministic median plan — every year-level field we need lives here.
  return latest?.plan?.years ?? [];
}
function monteCarloScenarios(latest) {
  return latest?.monteCarlo?.scenarios ?? [];
}
function computeSuccessRate(latest) {
  const summary = latest?.monteCarlo?.summary;
  if (summary && Number.isFinite(summary.successRate)) return summary.successRate;
  const list = monteCarloScenarios(latest);
  if (!list.length) return 0;
  return list.filter(s => s.success).length / list.length;
}
function pickEndingValue(latest, percentile) {
  const values = monteCarloScenarios(latest)
    .map((scenario) => resultEndingValue(scenario))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (values.length) return percentileValue(values, percentile);

  const summary = latest?.monteCarlo?.summary;
  if (summary) {
    const finalYear = planYears(latest).at(-1);
    if (Math.abs(percentile - 0.5)  < 0.001 && Number.isFinite(summary.medianEndingValue)) return displayAmount(summary.medianEndingValue, finalYear);
    if (Math.abs(percentile - 0.05) < 0.001 && Number.isFinite(summary.p10EndingValue))    return displayAmount(summary.p10EndingValue, finalYear);
    if (Math.abs(percentile - 0.95) < 0.001 && Number.isFinite(summary.p90EndingValue))    return displayAmount(summary.p90EndingValue, finalYear);
  }
  return NaN;
}
function pickHeirValue(latest, percentile) {
  const values = monteCarloScenarios(latest)
    .map((scenario) => resultHeirValue(scenario))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (values.length) return percentileValue(values, percentile);

  const summary = latest?.monteCarlo?.summary;
  const finalYear = planYears(latest).at(-1);
  if (summary && Math.abs(percentile - 0.5) < 0.001 && Number.isFinite(summary.medianHeirValue)) {
    return displayAmount(summary.medianHeirValue, finalYear);
  }
  return NaN;
}
function resultEndingValue(result) {
  const year = resultFinalYear(result);
  const value = result?.endingValue ?? year?.endingPortfolioValue ?? NaN;
  return displayAmount(value, year);
}
function resultHeirValue(result) {
  const year = resultFinalYear(result);
  return displayAmount(result?.heirValue ?? NaN, year);
}
function resultFinalYear(result) {
  return result?.years?.at?.(-1) ?? result?.lastYear ?? null;
}
function percentileValue(sortedValues, percentile) {
  if (!sortedValues.length) return NaN;
  if (percentile <= 0) return sortedValues[0];
  if (percentile >= 1) return sortedValues[sortedValues.length - 1];
  const idx = Math.max(0, Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * percentile)));
  return sortedValues[idx];
}
function pickStartingValue(latest) {
  const firstYear = planYears(latest)[0];
  return displayAmount(firstYear?.beginningPortfolioValue ?? 0, firstYear);
}
function sumLifetimeTax(latest) {
  return planYears(latest).reduce((t, y) => t + displayAmount(y?.taxes?.totalTax ?? 0, y), 0);
}
function sumLifetimeHealthcare(latest) {
  return planYears(latest).reduce((t, y) => t + displayAmount(yearHealthcareCost(y), y), 0);
}
export function allInSpendRate(latest) {
  const start = pickStartingValue(latest);
  const annualSpend = allInAnnualSpend(latest);
  return start > 0 ? annualSpend / start : 0;
}
export function allInAnnualSpend(latest) {
  const years = planYears(latest);
  const targetSpend = Number(document.getElementById("targetSpend")?.value) || 0;
  if (!years.length) return targetSpend;
  const averageTax = targetSpendIncludes("includeTaxes")
    ? 0
    : averageDisplayedAmount(years, (year) => year?.taxes?.totalTax ?? 0);
  const averageHealthcare = targetSpendIncludes("includeMedical")
    ? 0
    : averageDisplayedAmount(years, yearHealthcareCost);
  return targetSpend + averageTax + averageHealthcare;
}
function targetSpendIncludes(id) {
  return document.getElementById(id)?.checked === true;
}
function averageDisplayedAmount(years, selector) {
  if (!years.length) return 0;
  const total = years.reduce((sum, year) => {
    const value = Number(selector(year));
    return sum + (Number.isFinite(value) ? displayAmount(value, year) : 0);
  }, 0);
  return total / years.length;
}
function yearHealthcareCost(year) {
  return year?.medicalCost ?? year?.medicalTotal ?? 0;
}
function currentDollarMode() {
  return document.getElementById("viewMode")?.value === "nominal" ? "nominal" : "real";
}
function displayAmount(value, year = null) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return NaN;
  if (currentDollarMode() !== "real") return amount;
  const index = Number(year?.inflationIndex);
  return amount / Math.max(1, Number.isFinite(index) ? index : 1);
}
function formatYearCurrencyShort(value, year = null) {
  return formatCurrencyShort(displayAmount(value, year));
}
function tierFor(rate) {
  if (rate >= TIER_THRESHOLDS.warn) return "ok";
  if (rate >= TIER_THRESHOLDS.risk) return "warn";
  return "risk";
}
function formatCurrencyShort(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n/1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(n/1000)}k`;
  return `$${Math.round(n)}`;
}
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRescueComparisonTable() {
  const root = document.getElementById("rescueComparisonTable");
  if (!root) return;
  const latest = window.__pslLatest;
  const decision = latest?.decision;
  const running = decision?.status === "running";
  const rescues = rescueComparisonRows(decision);
  const baseScenario = decision?.base?.scenario ?? latest?.scenario ?? {};

  if (!latest || !decision) {
    root.innerHTML = `<p class="empty-state">Run simulation to see comparative breakdown.</p>`;
    return;
  }
  if (running && rescues.length === 0) {
    root.innerHTML = `<p class="empty-state">Solving rescue options... candidates will appear here as they are tested.</p>`;
    return;
  }
  if (!running && decision.status !== "ready") {
    root.innerHTML = `<p class="empty-state">Rescue solver did not return results.</p>`;
    return;
  }
  if (rescues.length === 0) {
    root.innerHTML = `<p class="empty-state">No rescue candidates were available for the current inputs.</p>`;
    return;
  }

  const headers = ["Rescue Strategy", "Optimized For", "Lifestyle Impact", "MC Success", "Historical Success", "Subsidy Change", "Confidence", "Result", "Apply"];
  const thead = `<thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;

  const rowsHtml = rescues.map((option, index) => {
    const title = capitalizeFirst(rescueTitle(option));
    const optimization = rescueOptimizationText(option, baseScenario);
    const tier = rescueTierLabel(option.kind);
    const confidence = rescueConfidenceFor(option, latest?.confidence);
    const mcRate = option.monteCarlo?.successRate;
    const mcDelta = option.delta?.monteCarloSuccessRate ?? 0;
    const mcRuns = Number.isFinite(option.monteCarlo?.runs)
      ? `<span class="ink-3" style="display:block;font-size:0.68rem;">${option.monteCarlo.runs.toLocaleString("en-US")} MC runs</span>`
      : "";
    
    // MC Success formatting with bold + delta pill
    const mcText = `${formatRate(mcRate)} <span class="ink-3" style="font-size:0.72rem;">(${signedRate(mcDelta)})</span>${mcRuns}`;
    
    // Historical Success formatting
    const histRate = option.historical?.successRate;
    const histText = formatOptionalRate(histRate);

    // Subsidy formatting
    const firstYearSubsidy = option.delta?.firstYearSubsidy;
    let subsidyText = "—";
    if (firstYearSubsidy != null) {
      const sign = firstYearSubsidy >= 0 ? "+" : "";
      subsidyText = `${sign}${formatCurrencyShort(firstYearSubsidy)} / yr`;
    }

    // Result badge/text
    let statusText = "Tested";
    let statusClass = "text-secondary";
    const searchProbe = !(option.historical?.count > 0);
    if (option.status === "target-met") {
      statusText = "Target Met";
      statusClass = "positive";
    } else if (option.status === "best-tested") {
      statusText = "Best Tested";
      statusClass = "positive";
    } else if (option.status === "discarded") {
      statusText = "Negligible Effect";
      statusClass = "text-muted";
    } else if (searchProbe) {
      statusText = running ? "Testing" : "Search Probe";
      statusClass = "text-muted";
    }

    const rowStyle = option.status === "discarded" ? ' style="opacity: 0.6;"' : "";
    const canApply = !!option.scenario && typeof window !== "undefined" && typeof window.__pslApplyRescueScenarioToWorkspace === "function";

    return `
      <tr data-status="${escapeHtml(option.status ?? "tested")}"${rowStyle}>
        <td style="font-family:'Inter',sans-serif; font-weight:600; color:var(--text-primary); white-space:normal;">${escapeHtml(title)}</td>
        <td style="font-family:'Inter',sans-serif; font-size:0.75rem; color:var(--text-secondary); white-space:normal;">${escapeHtml(optimization)}</td>
        <td style="font-family:'Inter',sans-serif; font-size:0.75rem; color:var(--text-muted);">${escapeHtml(tier)}</td>
        <td class="mono">${mcText}</td>
        <td class="mono">${escapeHtml(histText)}</td>
        <td class="mono" style="color: ${firstYearSubsidy > 0 ? "var(--emerald)" : (firstYearSubsidy < 0 ? "var(--coral)" : "inherit")}">${escapeHtml(subsidyText)}</td>
        <td>${confidenceBadgeHtml(confidence)}</td>
        <td><span class="${statusClass}" style="font-size:0.75rem; font-weight:700;">${escapeHtml(statusText)}</span></td>
        <td><button class="rescue-apply-button" type="button" data-rescue-apply="${index}" ${canApply ? "" : "disabled"}>${canApply ? "Apply" : "n/a"}</button></td>
      </tr>
    `;
  }).join("");

  root.innerHTML = `
    <table>
      ${thead}
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;
  root.querySelectorAll("[data-rescue-apply]").forEach((button) => {
    button.addEventListener("click", () => {
      const option = rescues[Number(button.dataset.rescueApply)];
      if (!option?.scenario || typeof window.__pslApplyRescueScenarioToWorkspace !== "function") return;
      const title = rescueTitle(option);
      const changes = rescueChangeList(option, baseScenario);
      const changeText = changes.length ? changes.map((change) => `- ${change}`).join("\n") : "- Apply the tested rescue scenario values.";
      const confirmed = window.confirm(`Apply "${capitalizeFirst(title)}" to the workspace and rerun projections?\n\n${changeText}`);
      if (!confirmed) return;
      window.__pslApplyRescueScenarioToWorkspace(option.scenario, {
        label: title,
        changes
      });
      runModelFromRedesign({ cancelActive: true, stream: true });
    });
  });
}

function renderTradeoffFrontierTable() {
  const root = document.getElementById("tradeoffFrontierTable");
  if (!root) return;
  const latest = window.__pslLatest;
  const decision = latest?.decision;
  const running = decision?.status === "running";
  const baseScenario = decision?.base?.scenario ?? latest?.scenario ?? {};

  if (!latest || !decision) {
    root.innerHTML = `<p class="empty-state">Run simulation to see tradeoff frontier.</p>`;
    return;
  }
  if (!decision.tradeoffFrontier) {
    root.innerHTML = `<p class="empty-state">Tradeoff frontier comparison is not available for this run.</p>`;
    return;
  }

  const headers = ["Alternative Plan", "Annual Spend", "MC Success", "Healthcare Subsidy", "Estimated Legacy", "Apply"];
  const thead = `<thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;

  const rowsHtml = decision.tradeoffFrontier.map((plan, index) => {
    const title = plan.label;
    const spendText = formatCurrencyShort(plan.spend) + " / yr";
    const mcText = formatRate(plan.resilience);
    const subsidyText = plan.healthcare > 0 ? formatCurrencyShort(plan.healthcare) + " / yr" : "—";
    const bequestText = formatCurrencyShort(plan.bequest);

    const canApply = !!plan.candidate?.scenario && typeof window !== "undefined" && typeof window.__pslApplyRescueScenarioToWorkspace === "function";

    return `
      <tr>
        <td style="font-family:'Inter',sans-serif; font-weight:600; color:var(--text-primary); white-space:normal;">${escapeHtml(title)}</td>
        <td class="mono">${escapeHtml(spendText)}</td>
        <td class="mono" style="font-weight: 700; color: ${plan.resilience >= 0.8 ? "var(--emerald)" : (plan.resilience < 0.5 ? "var(--coral)" : "inherit")}">${escapeHtml(mcText)}</td>
        <td class="mono" style="color: ${plan.healthcare > 0 ? "var(--emerald)" : "inherit"}">${escapeHtml(subsidyText)}</td>
        <td class="mono" style="font-weight: 700; color: var(--accent-text);">${escapeHtml(bequestText)}</td>
        <td><button class="rescue-apply-button" type="button" data-frontier-apply="${index}" ${canApply ? "" : "disabled"}>${canApply ? "Apply" : "n/a"}</button></td>
      </tr>
    `;
  }).join("");

  root.innerHTML = `
    <table>
      ${thead}
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;

  root.querySelectorAll("[data-frontier-apply]").forEach((button) => {
    button.addEventListener("click", () => {
      const plan = decision.tradeoffFrontier[Number(button.dataset.frontierApply)];
      if (!plan?.candidate?.scenario || typeof window.__pslApplyRescueScenarioToWorkspace !== "function") return;
      const confirmed = window.confirm(`Apply "${escapeHtml(plan.label)}" to the workspace and rerun projections?\n\nThis will update your target spending and roth conversion options accordingly.`);
      if (!confirmed) return;
      window.__pslApplyRescueScenarioToWorkspace(plan.candidate.scenario, {
        label: plan.label,
        changes: [`Adjust target spend to ${formatCurrencyShort(plan.spend)} / yr`, `Modify Roth conversion strategy for ${plan.label}`]
      });
      runModelFromRedesign({ cancelActive: true, stream: true });
    });
  });
}

function rescueComparisonRows(decision) {
  if (!decision) return [];
  if (decision.status === "running") {
    return Array.isArray(decision.progress?.candidates) ? decision.progress.candidates : [];
  }
  const attempts = Array.isArray(decision.testedRescueOptions) ? decision.testedRescueOptions : [];
  const finalOptions = Array.isArray(decision.rescueOptions) ? decision.rescueOptions : [];
  if (!attempts.length) return finalOptions;

  const finalById = new Map(finalOptions.map((option) => [option.id, option]));
  const usedFinalIds = new Set();
  const merged = attempts.map((attempt) => {
    const final = finalById.get(attempt.id);
    if (!final) return attempt;
    usedFinalIds.add(final.id);
    return {
      ...attempt,
      ...final,
      sequence: attempt.sequence
    };
  });
  finalOptions.forEach((option) => {
    if (!usedFinalIds.has(option.id)) merged.push(option);
  });
  return merged;
}

export function rescueChangeList(option = {}, baseScenario = {}) {
  const scenario = option?.scenario ?? {};
  const changes = [];
  addNumberChange(changes, "Target spend", baseScenario.targetSpend, scenario.targetSpend, formatCurrencyShort);

  const baseSpend = baseScenario.spendingStrategy ?? {};
  const nextSpend = scenario.spendingStrategy ?? {};
  addTextChange(changes, "Spending mode", baseSpend.mode, nextSpend.mode);
  addNumberChange(changes, "Essential spend", baseSpend.essentialSpend, nextSpend.essentialSpend, formatCurrencyShort);
  addNumberChange(changes, "Discretionary spend", baseSpend.discretionarySpend, nextSpend.discretionarySpend, formatCurrencyShort);
  addNumberChange(changes, "Correction discretionary", baseSpend.correctionDiscretionaryPercent, nextSpend.correctionDiscretionaryPercent, formatPercentValue);
  addNumberChange(changes, "Bear discretionary", baseSpend.bearDiscretionaryPercent, nextSpend.bearDiscretionaryPercent, formatPercentValue);
  const nextRisk = nextSpend.riskBasedGuardrails ?? {};
  if (nextRisk.table) {
    addNumberChange(changes, "Risk guardrail starting spend", null, nextRisk.table.initialSpend, formatCurrencyShort);
    addNumberChange(changes, "Risk guardrail lower trigger", null, nextRisk.table.lowerGuardrailPortfolioValue, formatCurrencyShort);
    addNumberChange(changes, "Risk guardrail upper trigger", null, nextRisk.table.upperGuardrailPortfolioValue, formatCurrencyShort);
  }

  const addedCashFlows = addedOneOffCashFlows(baseScenario.oneOffExpenses, scenario.oneOffExpenses);
  if (addedCashFlows.length) {
    changes.push(`One-off cash flows: add ${addedCashFlows.map(oneOffSummary).join(", ")}`);
  }

  const baseReserve = baseScenario.sequenceRiskReserve ?? {};
  const nextReserve = scenario.sequenceRiskReserve ?? {};
  addBooleanChange(changes, "Reserve enabled", baseReserve.enabled, nextReserve.enabled);
  addTextChange(changes, "Reserve mode", baseReserve.mode, nextReserve.mode);
  addNumberChange(changes, "Reserve years", baseReserve.targetYears, nextReserve.targetYears, formatPlainNumber);

  const baseLadder = baseScenario.tipsLadder ?? {};
  const nextLadder = scenario.tipsLadder ?? {};
  addBooleanChange(changes, "TIPS ladder", baseLadder.enabled, nextLadder.enabled);
  addNumberChange(changes, "Ladder years", baseLadder.years, nextLadder.years, formatPlainNumber);
  addNumberChange(changes, "Ladder annual amount", baseLadder.annualRealAmount ?? undefined, nextLadder.annualRealAmount ?? undefined, formatCurrencyShort);
  addNumberChange(changes, "Ladder real yield %", baseLadder.realYieldPercent, nextLadder.realYieldPercent, formatPlainNumber);

  const baseAllocation = baseScenario.allocationStrategy ?? {};
  const nextAllocation = scenario.allocationStrategy ?? {};
  addBooleanChange(changes, "Tax-aware rebalancing", baseAllocation.rebalanceEnabled, nextAllocation.rebalanceEnabled);
  addBooleanChange(changes, "Equity glidepath", baseAllocation.glidepathEnabled, nextAllocation.glidepathEnabled);
  addNumberChange(changes, "Stock target", baseAllocation.targetStockPercent, nextAllocation.targetStockPercent, formatWholePercent);

  addTextChange(changes, "Withdrawal strategy", baseScenario.withdrawalStrategy?.mode, scenario.withdrawalStrategy?.mode);
  addTextChange(changes, "Withdrawal order", withdrawalOrderLabel(baseScenario.withdrawalOrder), withdrawalOrderLabel(scenario.withdrawalOrder));

  addBooleanChange(changes, "Tax-loss harvesting", baseScenario.taxLossHarvesting?.enabled, scenario.taxLossHarvesting?.enabled);
  addBooleanChange(changes, "Tax-gain harvesting", baseScenario.taxGainHarvesting?.enabled, scenario.taxGainHarvesting?.enabled);
  addNumberChange(changes, "Gain harvest MAGI buffer", baseScenario.taxGainHarvesting?.magiBuffer, scenario.taxGainHarvesting?.magiBuffer, formatCurrencyShort);

  const baseRoth = baseScenario.rothConversion ?? {};
  const nextRoth = scenario.rothConversion ?? {};
  addBooleanChange(changes, "Roth conversions", baseRoth.enabled, nextRoth.enabled);
  addBooleanChange(changes, "ACA-aware Roth conversions", baseRoth.optimizeForAca, nextRoth.optimizeForAca);
  addBooleanChange(changes, "MAGI conversion guardrails", baseRoth.applyMagiGuardrails, nextRoth.applyMagiGuardrails);
  addNumberChange(changes, "Conversion max ACA FPL", baseRoth.maxAcaFplPercent, nextRoth.maxAcaFplPercent, formatWholePercent);
  addNumberChange(changes, "Conversion MAGI buffer", baseRoth.magiBuffer, nextRoth.magiBuffer, formatCurrencyShort);

  const baseBasis = baseScenario.rothBasisOptimization ?? {};
  const nextBasis = scenario.rothBasisOptimization ?? {};
  addBooleanChange(changes, "Roth basis optimization", baseBasis.enabled, nextBasis.enabled);
  addTextChange(changes, "Roth basis hurdle", baseBasis.opportunityCostMode, nextBasis.opportunityCostMode);
  addNumberChange(changes, "Roth basis MAGI buffer", baseBasis.magiBuffer, nextBasis.magiBuffer, formatCurrencyShort);

  addBooleanChange(changes, "IRMAA enabled", baseScenario.medicare?.irmaaEnabled, scenario.medicare?.irmaaEnabled);
  addNumberChange(changes, "Max IRMAA tier", baseScenario.medicare?.maxIrmaaTier, scenario.medicare?.maxIrmaaTier, formatPlainNumber);
  addNumberChange(changes, "Social Security start age", baseScenario.socialSecurityStartAge, scenario.socialSecurityStartAge, formatPlainNumber);
  addNumberChange(changes, "Social Security benefit", baseScenario.socialSecurityAnnualBenefit, scenario.socialSecurityAnnualBenefit, formatCurrencyShort);

  return changes;
}

function addTextChange(changes, label, before, after) {
  if (after == null || before === after) return;
  changes.push(`${label}: ${displayTextValue(before)} -> ${displayTextValue(after)}`);
}

function addBooleanChange(changes, label, before, after) {
  if (typeof after !== "boolean" || before === after) return;
  const beforeText = typeof before === "boolean" ? (before ? "on" : "off") : "unset";
  changes.push(`${label}: ${beforeText} -> ${after ? "on" : "off"}`);
}

function addNumberChange(changes, label, before, after, formatter) {
  const next = Number(after);
  if (!Number.isFinite(next)) return;
  const prev = Number(before);
  if (Number.isFinite(prev) && Math.abs(prev - next) < 0.0001) return;
  changes.push(`${label}: ${Number.isFinite(prev) ? formatter(prev) : "unset"} -> ${formatter(next)}`);
}

function displayTextValue(value) {
  if (value == null || value === "") return "unset";
  return String(value);
}

function formatPercentValue(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

function formatWholePercent(value) {
  return `${Math.round(Number(value))}%`;
}

function formatPlainNumber(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : "unset";
}

function withdrawalOrderLabel(order) {
  return Array.isArray(order) && order.length ? order.join(" > ") : null;
}

function addedOneOffCashFlows(before = [], after = []) {
  const used = new Set();
  const baseKeys = (before ?? []).map(oneOffKey);
  return (after ?? []).filter((item) => {
    const key = oneOffKey(item);
    const index = baseKeys.findIndex((baseKey, candidateIndex) => baseKey === key && !used.has(candidateIndex));
    if (index === -1) return true;
    used.add(index);
    return false;
  });
}

function oneOffKey(item = {}) {
  return [
    item.name,
    item.cashFlowType,
    item.startYear,
    item.endYear,
    item.amount,
    item.inflationAdjusted === true ? "1" : "0"
  ].join("|");
}

function oneOffSummary(item = {}) {
  const years = item.startYear === item.endYear ? `year ${item.startYear}` : `years ${item.startYear}-${item.endYear}`;
  return `${item.name || "cash flow"} ${formatCurrencyShort(Number(item.amount) || 0)} ${years}`;
}

export function rescueOptimizationText(option, baseScenario = {}) {
  const meta = option?.metadata ?? {};
  const changes = rescueChangeList(option, baseScenario);
  const changeSummary = changes.length
    ? ` Changes: ${changes.slice(0, 4).join("; ")}${changes.length > 4 ? "; ..." : ""}.`
    : "";
  switch (option?.kind) {
    case "safeSpending":
      return `Maximum annual spending that still clears the decision target.${changeSummary}`;
    case "discretionaryCut":
      return `Flexible-spending cut during early market stress.${changeSummary}`;
    case "riskBasedGuardrailsRescue":
      return `Historical guardrail table with a failsafe spend, starting spend, lower cut trigger, and upper raise trigger.${changeSummary}`;
    case "incomeBridge":
      return `Bridge-income amount for ${meta.durationYears ?? 0} years.${changeSummary}`;
    case "combined":
      return `Pair the chosen spending cut with bridge income.${changeSummary}`;
    case "sequenceReserve":
      return `${capitalizeFirst(meta.reserveMode ?? "cash")} reserve size for early sequence risk.${changeSummary}`;
    case "tipsLadder": {
      const fundingText = meta.annualRealAmount != null && Number.isFinite(Number(meta.annualRealAmount))
        ? `${formatCurrencyShort(meta.annualRealAmount)}/year`
        : "the base spending target";
      return `${meta.ladderYears ?? 0}-year TIPS ladder at ${meta.realYieldPercent ?? 2}% real yield funding ${fundingText}.${changeSummary}`;
    }
    case "allocationShift":
      return `Target allocation with the historical worst-path guardrail.${changeSummary}`;
    case "withdrawalShift":
      return `Withdrawal mode or account order with the best success rate.${changeSummary}`;
    case "healthcareRescue":
      return `MAGI discipline near ${meta.maxAcaFplPercent ?? "ACA"}% FPL.${changeSummary}`;
    case "rothBasisCliffRescue":
      return `Roth-basis substitution to stay below MAGI cliffs.${changeSummary}`;
    case "taxableLotRescue":
      return `High-basis taxable-lot sales to reduce taxes and MAGI.${changeSummary}`;
    case "conversionGuardrail":
      return `Roth conversion throttling near MAGI cliffs.${changeSummary}`;
    case "magiSpendTrim":
      return `Spending trim sized to regain ACA subsidy room.${changeSummary}`;
    case "irmaaLookbackRescue":
      return `MAGI smoothing before Medicare IRMAA lookback.${changeSummary}`;
    case "socialSecurityBridge":
      return `Social Security delay to age ${meta.startAge ?? 70}.${changeSummary}`;
    default:
      return `${option?.label ?? "Tested rescue configuration"}.${changeSummary}`;
  }
}
