/* ──────────────────────────────────────────────────────────────────
   redesign.mjs
   - Companion to v2ui-app.mjs (which still does all simulation/data work)
   - Implements: three-screen router, theme toggle, persona presets,
     module library, scenario tabs, action-plan card, bracket fill,
     withdrawal mix per year, sensitivity tornado, mobile polish.
   - DOM IDs from the legacy app are preserved, so v2ui-app.mjs continues
     to function unchanged.
   ────────────────────────────────────────────────────────────────── */

const SCREENS = ["persona", "workspace", "results"];
const STORAGE_SCREEN = "psl:redesign:screen";
const STORAGE_THEME = "psl:redesign:theme";
const STORAGE_PERSONA = "psl:redesign:persona";
const STORAGE_OUTCOME = "psl:redesign:outcome";
const STORAGE_DETAIL = "psl:redesign:detail";
const STORAGE_MODULES = "psl:redesign:modules";
const STORAGE_SCENARIOS = "psl:redesign:scenarios";

// Persona presets — what each card pre-fills in the workspace.
const PERSONAS = [
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
    note: "(Solver coming soon — for now, the safe-spend rate KPI is highlighted.)"
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
  { id: "basics",        label: "The basics",     desc: "Age, plan length, target spend",        controls: 11, required: true,  enabledByDefault: true  },
  { id: "portfolio",     label: "Portfolio",      desc: "Your accounts and holdings",             controls: 5,  required: true,  enabledByDefault: true  },
  { id: "healthcare",    label: "Healthcare",     desc: "Insurance until Medicare",               controls: 14, required: false, enabledByDefault: true  },
  { id: "medicare",      label: "Medicare/IRMAA", desc: "Premiums after 65",                       controls: 8,  required: false, enabledByDefault: false },
  { id: "other-income",  label: "Other income",   desc: "Social Security, work, SE",               controls: 7,  required: false, enabledByDefault: false },
  { id: "strategy",      label: "Strategy toolkit", desc: "TLH, TGH, Roth conversions",            controls: 9,  required: false, enabledByDefault: true  },
  { id: "reserve",       label: "Cash reserve",   desc: "Bucket strategy",                          controls: 4,  required: false, enabledByDefault: false },
  { id: "history",       label: "History test",   desc: "How would you have done?",                controls: 7,  required: false, enabledByDefault: false },
  { id: "what-ifs",      label: "What ifs",       desc: "Future expenses or income",                controls: 3,  required: false, enabledByDefault: true  },
  { id: "tax-overrides", label: "Tax overrides",  desc: "Power-user tax tweaks",                    controls: 12, required: false, enabledByDefault: false }
];

const TIER_THRESHOLDS = { warn: 0.85, risk: 0.7 };

// ─── State ─────────────────────────────────────────────────────────

const state = {
  screen: "persona",
  theme: "dark",
  persona: null,
  outcome: null,
  detail: "plain",
  enabledModules: new Set(MODULES.filter(m => m.enabledByDefault).map(m => m.id)),
  scenarios: [],          // [{ id, name, color, summary }]
  activeScenarioId: null
};

// ─── Boot ──────────────────────────────────────────────────────────

function boot() {
  hydrateState();
  buildPersonaCards();
  buildOutcomeCards();
  buildModuleLibrary();
  bindRouter();
  bindTheme();
  bindIntakes();
  bindResultsScenarioPanel();
  bindWorkspaceSummary();
  applyAll();
  // Wait for v2ui-app to settle before painting the new visuals; it dispatches
  // a custom event whenever a new run completes (we hook it below).
  hookRunCompletion();
  // If v2ui-app already painted before redesign.mjs loaded, sync now.
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

  state.scenarios = readJsonStorage(STORAGE_SCENARIOS, []);
}

function applyAll() {
  document.body.dataset.screen = state.screen;
  document.body.dataset.theme  = state.theme;
  syncDetailToggle();
  syncModuleVisibility();
  syncModuleLibraryUI();
  syncPersonaSelection();
  syncOutcomeSelection();
  renderScenarioTabs();
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
  if (persona.rothBasis != null) setInputValue("rothBasis", persona.rothBasis);

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

// ─── Router ────────────────────────────────────────────────────────

function bindRouter() {
  const personaContinue = document.getElementById("personaContinue");
  personaContinue?.addEventListener("click", () => setScreen("workspace"));

  const personaRunModel = document.getElementById("personaRunModel");
  personaRunModel?.addEventListener("click", () => {
    setScreen("workspace");
    // Defer to v2ui-app's runModel, which is already wired to #runModel
    requestAnimationFrame(() => document.getElementById("runModel")?.click());
  });

  const wsViewResults = document.getElementById("wsViewResults");
  wsViewResults?.addEventListener("click", () => setScreen("results"));

  const tweakInputs = document.getElementById("resultsTweakInputs");
  tweakInputs?.addEventListener("click", () => setScreen("workspace"));

  const back = document.getElementById("resultsBackToWorkspace");
  back?.addEventListener("click", () => setScreen("workspace"));

  // Wrap the synchronous runModels (from v2ui-app) with a loading overlay
  // that paints BEFORE the main thread freezes. We intercept #runModel
  // clicks in the capture phase, show the overlay, and yield the event
  // loop twice (rAF→rAF→setTimeout) to guarantee a paint before
  // re-dispatching the click for the actual handler.
  const runModel = document.getElementById("runModel");
  if (runModel) {
    let isWrapping = false;
    runModel.addEventListener("click", (ev) => {
      if (isWrapping) return;            // re-entry from our re-dispatch — let it through
      ev.stopImmediatePropagation();     // block v2ui-app's handler this turn
      ev.preventDefault();
      flagPendingRun();
      showRunOverlay();
      // Yield twice + a setTimeout to ensure the browser actually paints
      // the overlay before the synchronous simulation work begins.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            isWrapping = true;
            try {
              runModel.click();          // re-dispatch; v2ui-app handler now runs
            } finally {
              isWrapping = false;
            }
            // The MutationObserver in hookRunCompletion will fire when
            // #yearTable repaints — that's our cue to hide.
          }, 0);
        });
      });
    }, true);                            // capture phase
  }
}

function showRunOverlay(message) {
  const overlay = document.getElementById("runOverlay");
  if (!overlay) return;
  if (message) {
    const sub = document.getElementById("runOverlaySub");
    if (sub) sub.textContent = message;
  }
  overlay.hidden = false;
  // Safety timer: hide if a render hasn't happened in 30s.
  clearTimeout(showRunOverlay._timer);
  showRunOverlay._timer = setTimeout(() => hideRunOverlay(), 30000);
}

function hideRunOverlay() {
  const overlay = document.getElementById("runOverlay");
  if (!overlay) return;
  overlay.hidden = true;
  clearTimeout(showRunOverlay._timer);
}

function setScreen(screen) {
  if (!SCREENS.includes(screen)) return;
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
        // Sync to legacy #viewMode select used by v2ui-app
        const legacy = document.getElementById("viewMode");
        if (legacy) {
          legacy.value = viewMode;
          legacy.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }));
  });
}

function syncDetailToggle() {
  document.querySelectorAll(".pill-toggle [data-detail]").forEach(btn => {
    btn.setAttribute("aria-pressed", String(btn.dataset.detail === state.detail));
  });
  document.body.dataset.detail = state.detail;
}

// ─── Workspace summary KPI strip ───────────────────────────────────

function bindWorkspaceSummary() {
  // Populated when v2ui-app finishes a run (see hookRunCompletion).
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
    labelEl.textContent = "Run the model to see your number";
    subEl.textContent = "Pick modules, fill in the basics, then Run model.";
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
  const swr = targetSpend > 0 && median > 0 ? targetSpend / pickStartingValue(latest) : null;
  const subParts = [];
  if (Number.isFinite(median)) subParts.push(`Median ${formatCurrencyShort(median)} ending`);
  if (Number.isFinite(fifth))  subParts.push(`5th pct ${formatCurrencyShort(fifth)}`);
  if (Number.isFinite(swr))    subParts.push(`${(swr*100).toFixed(1)}% SWR`);
  subEl.textContent = subParts.join(" · ");
  if (sparkEl) renderSpark(sparkEl, latest);
}

function renderSpark(svg, latest) {
  // Bar chart: ending portfolio value year-over-year from the deterministic plan.
  const series = planYears(latest).slice(0, 36).map(y => y.endingPortfolioValue ?? 0);
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

// ─── Scenarios ─────────────────────────────────────────────────────

const SCENARIO_COLORS = ["#34d1b6", "#8892a8", "#7c6cf0", "#f0a848", "#56c8e8", "#f06060"];

function bindResultsScenarioPanel() {
  document.getElementById("saveScenarioBtn")?.addEventListener("click", () => {
    if (!window.__pslLatest) return;
    const successRate = computeSuccessRate(window.__pslLatest);
    const id = `scn_${Date.now().toString(36)}`;
    const scenario = {
      id,
      name: nextScenarioName(),
      color: SCENARIO_COLORS[state.scenarios.length % SCENARIO_COLORS.length],
      successRate,
      summary: snapshotSummary(window.__pslLatest)
    };
    state.scenarios.push(scenario);
    state.activeScenarioId = id;
    writeJsonStorage(STORAGE_SCENARIOS, state.scenarios);
    renderScenarioTabs();
  });

  document.getElementById("runSensitivity")?.addEventListener("click", runSensitivitySweep);
}

function nextScenarioName() {
  const baseNames = ["Your plan", "Baseline", "Aggro Roth", "Lean", "Healthcare bridge", "Late retire"];
  const used = new Set(state.scenarios.map(s => s.name));
  for (const name of baseNames) if (!used.has(name)) return name;
  return `Scenario ${state.scenarios.length + 1}`;
}

function snapshotSummary(latest) {
  return {
    successRate: computeSuccessRate(latest),
    median: pickEndingValue(latest, 0.5),
    fifth: pickEndingValue(latest, 0.05),
    lifetimeTax: sumLifetimeTax(latest),
    healthcare: sumLifetimeHealthcare(latest),
    safeRate: safeWithdrawalRate(latest),
    years: planYears(latest).length
  };
}

function renderScenarioTabs() {
  const root = document.getElementById("scenarioTabs");
  if (!root) return;
  // Clear all but the label
  [...root.querySelectorAll(".scenario-tab")].forEach(el => el.remove());
  for (const s of state.scenarios) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scenario-tab";
    btn.dataset.scenarioId = s.id;
    btn.style.setProperty("--scenario-dot", s.color);
    btn.setAttribute("aria-pressed", String(state.activeScenarioId === s.id));
    btn.innerHTML = `<span class="dot"></span>${s.name} <span class="pct">${Math.round(s.successRate*100)}%</span>`;
    btn.addEventListener("click", () => {
      state.activeScenarioId = s.id;
      writeJsonStorage(STORAGE_SCENARIOS, state.scenarios);
      renderScenarioTabs();
      renderKpiStrip();   // re-render KPI strip with the chosen scenario summary
    });
    root.appendChild(btn);
  }
  // Add "+ New scenario" button
  const add = document.createElement("button");
  add.type = "button";
  add.className = "scenario-tab add-scenario";
  add.textContent = "+ New scenario";
  add.addEventListener("click", () => {
    document.getElementById("saveScenarioBtn")?.click();
  });
  root.appendChild(add);
}

// ─── KPI strip ─────────────────────────────────────────────────────

function renderKpiStrip() {
  const root = document.getElementById("kpiStrip");
  if (!root) return;
  const latest = window.__pslLatest;
  const active = state.scenarios.find(s => s.id === state.activeScenarioId);
  const summary = active?.summary ?? (latest ? snapshotSummary(latest) : null);
  if (!summary) {
    root.innerHTML = `
      <div class="kpi-card kpi-hero"><span class="kpi-label">Money lasts</span><span class="kpi-value" data-empty="true">—</span><span class="kpi-sub">Run the model to see your number</span></div>`;
    return;
  }
  const pct = summary.successRate;
  const baseline = state.scenarios.find(s => s.name === "Baseline");
  const delta = baseline ? Math.round((pct - baseline.summary.successRate) * 100) : null;
  const runs = latest?.monteCarlo?.summary?.runs ?? monteCarloScenarios(latest).length ?? 250;
  root.innerHTML = `
    <div class="kpi-card kpi-hero">
      <span class="kpi-label">Money lasts in</span>
      <span class="kpi-value" data-tier="${tierFor(pct)}">${Math.round(pct*100)}%</span>
      <span class="kpi-sub">of ${runs.toLocaleString()} simulated futures</span>
      ${delta != null ? `<span class="kpi-delta" data-direction="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "+" : ""}${delta}pp vs. baseline</span>` : ""}
    </div>
    <div class="kpi-card"><span class="kpi-label">Median ending</span><span class="kpi-value">${formatCurrencyShort(summary.median)}</span></div>
    <div class="kpi-card"><span class="kpi-label">Worst 5%</span><span class="kpi-value">${formatCurrencyShort(summary.fifth)}</span></div>
    <div class="kpi-card"><span class="kpi-label">Lifetime tax</span><span class="kpi-value">${formatCurrencyShort(summary.lifetimeTax)}</span></div>
    <div class="kpi-card"><span class="kpi-label">Healthcare</span><span class="kpi-value">${formatCurrencyShort(summary.healthcare)}</span></div>
    <div class="kpi-card"><span class="kpi-label">Safe spend rate</span><span class="kpi-value">${(summary.safeRate*100).toFixed(1)}%</span></div>
    <div class="kpi-card"><span class="kpi-label">Years modeled</span><span class="kpi-value">${summary.years}</span></div>`;
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
  if (taxableW > 0) items.push({ kind: "withdraw", title: "Sell from taxable", sub: "0% LTCG bracket where possible", amt: taxableW });
  if (traditionalW > 0) items.push({ kind: "withdraw", title: "Sell from Traditional", sub: "Ordinary income", amt: traditionalW });
  if (rothW > 0) items.push({ kind: "withdraw", title: "Sell from Roth", sub: "Tax-free draws", amt: rothW });
  if (year.rothConversionAmount > 0) items.push({ kind: "convert", title: "Convert Trad → Roth", sub: `In ${(Number(document.getElementById("rothTargetRate")?.value) || 12)}% bracket target`, amt: year.rothConversionAmount });
  if (year.aca?.subsidy > 0) items.push({ kind: "aca", title: "Cap MAGI for PTC", sub: `+${formatCurrencyShort(year.aca.subsidy)} PTC`, amt: year.magi });
  if (year.taxGainHarvested > 0) items.push({ kind: "harvest", title: "Realize gains", sub: "0% LTCG room", amt: year.taxGainHarvested });
  if (year.realizedCapitalLosses > 0) items.push({ kind: "harvest", title: "Tax-loss harvest", sub: "$3k ordinary offset + carryforward", amt: year.realizedCapitalLosses });
  if ((year.rmdAmount ?? 0) > 0) items.push({ kind: "rmd", title: "Take RMD", sub: "IRS-mandated distribution", amt: year.rmdAmount });

  root.innerHTML = items.length ? items.map(it => `
    <li>
      <span class="action-tag" data-kind="${it.kind}">${it.kind}</span>
      <div class="action-text">
        <span class="action-title">${it.title}</span>
        <span class="action-sub">${it.sub}</span>
      </div>
      <span class="action-amt">${formatCurrencyShort(it.amt)}</span>
    </li>`).join("") : `<li><div class="action-text"><span class="action-sub">No actions for year 1.</span></div></li>`;
}

// ─── Bracket fill ──────────────────────────────────────────────────

function renderBracketFill() {
  const root = document.getElementById("bracketList");
  if (!root) return;
  const latest = window.__pslLatest;
  const year = planYears(latest)[0];
  const allBrackets = latest?.taxProfile?.ordinaryBrackets ?? [];
  if (!allBrackets.length) { root.innerHTML = ""; return; }
  // Build hit map by rate from the actual year details, then overlay onto the
  // full bracket schedule so empty brackets are visible too.
  const hitMap = new Map();
  for (const d of year?.taxes?.federalOrdinaryBracketDetails ?? []) {
    hitMap.set(d.rate ?? 0, d.taxableIncome ?? 0);
  }
  const bracketWidths = allBrackets.map((b, i) => {
    const lower = i === 0 ? 0 : (allBrackets[i - 1].upTo ?? 0);
    const upper = b.upTo;
    const width = Number.isFinite(upper) ? Math.max(0, upper - lower) : null;
    return { rate: b.rate ?? 0, width, hit: hitMap.get(b.rate ?? 0) ?? 0 };
  });
  // Use the largest bracket width as the visualization scale (skip Infinity tail).
  const max = Math.max(...bracketWidths.map(b => b.width ?? 0), 1);
  root.innerHTML = bracketWidths.slice(0, 7).map(b => {
    const denom = b.width ?? max;
    const fillFrac = denom > 0 ? Math.max(0, Math.min(1, b.hit / denom)) : 0;
    const empty = b.hit <= 0.0001;
    return `
      <li class="bracket-row">
        <span class="bracket-rate">${Math.round(b.rate * 100)}%</span>
        <div class="bracket-bar"><div class="bracket-fill" style="width:${(fillFrac*100).toFixed(1)}%" data-empty="${empty}"></div></div>
        <span class="bracket-amt">${empty ? "—" : formatCurrencyShort(b.hit)}</span>
      </li>`;
  }).join("");
}

// ─── Withdrawal mix per year ───────────────────────────────────────

function renderWithdrawalMix() {
  const root = document.getElementById("withdrawalMix");
  const legend = document.getElementById("mixLegend");
  if (!root) return;
  const latest = window.__pslLatest;
  const years = planYears(latest);
  if (!years.length) { root.innerHTML = ""; if (legend) legend.innerHTML = ""; return; }
  // Pick a digestible subset of years (every Nth so we get roughly 8 columns)
  const stride = Math.max(1, Math.round(years.length / 8));
  const picked = [];
  for (let i = 0; i < years.length; i += stride) picked.push(years[i]);
  if (picked[picked.length - 1] !== years[years.length - 1]) picked.push(years[years.length - 1]);

  root.innerHTML = picked.map(y => {
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
    return `
      <div class="mix-col">
        <div class="mix-stack">
          ${segs.map(s => `<span class="${s.cls}" style="flex-basis:${(s.v/total*100).toFixed(2)}%">${s.v/total > 0.12 ? s.label : ""}</span>`).join("")}
        </div>
        <span class="mix-year">Y${y.yearIndex+1}</span>
        <span class="mix-age">${y.age ? Math.round(y.age) : ""}</span>
      </div>`;
  }).join("");
  if (legend) legend.innerHTML = `
    <span><span class="swatch" style="background:#117a4d"></span>Taxable</span>
    <span><span class="swatch" style="background:#5946d8"></span>Traditional</span>
    <span><span class="swatch" style="background:#1f4ed8"></span>Roth</span>
    <span><span class="swatch" style="background:#0e7da6"></span>HSA</span>
    <span><span class="swatch" style="background:#c43838"></span>RMD</span>
    <span><span class="swatch" style="background:#117a4d;opacity:.55"></span>Soc Sec</span>`;
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
    document.getElementById("runModel")?.click();
    // Safety timer
    setTimeout(resolve, 8000);
  });
}

// ─── Run-completion observation ────────────────────────────────────

let pendingRunAdvance = false;

function flagPendingRun() {
  pendingRunAdvance = true;
}

function hookRunCompletion() {
  // v2ui-app stores the latest result in a module-private variable. We
  // observe via a MutationObserver on the existing #yearTable, which
  // re-renders whenever a run completes.
  const obs = new MutationObserver(() => {
    // Pull what we can from the global (set below) AND from the DOM.
    rerenderResults();
    syncWorkspaceSummary();
    hideRunOverlay();
    window.dispatchEvent(new CustomEvent("psl:run-complete"));
    if (pendingRunAdvance) {
      pendingRunAdvance = false;
      // Auto-advance to results screen on the first user-initiated run.
      if (state.screen === "workspace") setScreen("results");
    }
  });
  const target = document.getElementById("yearTable");
  if (target) obs.observe(target, { childList: true, subtree: true });
  // Also hide on the render-latest event in case the page repaints
  // without modifying #yearTable (e.g., toggle inflation view).
  window.addEventListener("psl:render-latest", () => hideRunOverlay());
}

function rerenderResults() {
  renderKpiStrip();
  renderActionList();
  renderBracketFill();
  renderWithdrawalMix();
  // Update results topbar meta
  const meta = document.getElementById("resultsMeta");
  if (meta && window.__pslLatest) {
    const runs = window.__pslLatest?.monteCarlo?.summary?.runs ?? "—";
    const years = planYears(window.__pslLatest).length || "—";
    meta.textContent = `Updated just now · ${runs} sims · ${years} years`;
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
  const summary = latest?.monteCarlo?.summary;
  if (summary) {
    if (Math.abs(percentile - 0.5)  < 0.001 && Number.isFinite(summary.medianEndingValue)) return summary.medianEndingValue;
    if (Math.abs(percentile - 0.05) < 0.001 && Number.isFinite(summary.p10EndingValue))    return summary.p10EndingValue;
    if (Math.abs(percentile - 0.95) < 0.001 && Number.isFinite(summary.p90EndingValue))    return summary.p90EndingValue;
  }
  const arr = monteCarloScenarios(latest).map(s => s.endingValue ?? 0).filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return NaN;
  const idx = Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * percentile)));
  return arr[idx];
}
function pickStartingValue(latest) {
  return planYears(latest)[0]?.beginningPortfolioValue ?? 0;
}
function sumLifetimeTax(latest) {
  return planYears(latest).reduce((t, y) => t + (y?.taxes?.totalTax ?? 0), 0);
}
function sumLifetimeHealthcare(latest) {
  return planYears(latest).reduce((t, y) => t + (y?.medicalTotal ?? 0), 0);
}
function safeWithdrawalRate(latest) {
  const start = pickStartingValue(latest);
  const targetSpend = Number(document.getElementById("targetSpend")?.value) || 0;
  return start > 0 ? targetSpend / start : 0;
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
