import {
  googleSpreadsheetIdFromInput,
  parsePortfolioCsv,
  parsePortfolioJson,
  parsePortfolioRows,
  toGoogleCsvUrl
} from "./core/importers.mjs";
import { portfolioValue } from "./core/portfolio.mjs";
import { createSetupBackup, parseSetupBackup } from "./core/setupBackup.mjs";
import { DEFAULT_SCENARIO, runHistoricalBacktests, runMonteCarlo, simulatePlan } from "./core/simulation.mjs";
import { round } from "./core/utils.mjs";
import { defaultOneOffExpenses, sampleAssets } from "./data/sample.mjs";
import {
  assetClassesInPortfolio,
  historicalCoverageForAssetClasses,
  HISTORICAL_RETURN_DATA_VERSION,
  makeHistoricalSequences
} from "./data/historicalReturns.mjs";
import { buildAcaConfig, buildTaxProfile, STATE_OPTIONS, getMonthlyBenchmarkPremium } from "./data/taxData.mjs";
import { massachusettsConnectorCareEstimate } from "./data/acaPlanPresets.mjs";
import {
  buildMarketplacePlanSearchRequest,
  marketplaceApiUrl,
  marketplaceStateCode,
  normalizeMarketplaceCounties,
  normalizeMarketplacePlans,
  secondLowestSilverPremium
} from "./data/marketplaceApi.mjs";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});
const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const unitFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1
});
const GOOGLE_IDENTITY_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const GOOGLE_SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const FEDERAL_MARKETPLACE_UNSUPPORTED_STATES = new Set(["Massachusetts"]);

const STORAGE_KEY = "portfolio-success-lab:v3";
const CONTROL_IDS = [
  "viewMode",
  "planYears",
  "runs",
  "seed",
  "targetSpend",
  "backtestMode",
  "historicalStartYear",
  "historicalEndYear",
  "historicalChunkYears",
  "cryptoStockProxy",
  "tipsBondProxy",
  "taxYear",
  "filingStatus",
  "stateSelect",
  "householdSize",
  "marketplaceMembers",
  "currentAge",
  "spouseAge",
  "acaMemberAges",
  "retirementPenaltyAge",
  "rothBasis",
  "socialSecurityAnnualBenefit",
  "socialSecurityStartAge",
  "socialSecurityInflationAdjusted",
  "rmdEnabled",
  "rmdStartAge",
  "irmaaEnabled",
  "medicarePartBEnrollees",
  "medicarePartDEnrollees",
  "medicarePartDMonthlyPremium",
  "twoYearsPriorMagi",
  "priorYearMagi",
  "mfsLivedTogether",
  "expectedOopPercent",
  "includeTaxes",
  "includeMedical",
  "acaEnabled",
  "medicalBase",
  "acaPlanCostMode",
  "acaPremiumInputMode",
  "acaQuoteIncome",
  "marketplaceApiKey",
  "marketplaceZip",
  "marketplaceCountyFips",
  "marketplacePlanYear",
  "marketplaceUsesTobacco",
  "marketplaceUtilizationLevel",
  "acaBenchmarkMonthlyPremium",
  "acaSelectedPlanMonthlyPremium",
  "oopMaxOverride",
  "acaBackupPremiumInputMode",
  "acaBackupBenchmarkMonthlyPremium",
  "acaBackupMonthlyPremium",
  "acaBackupOopMax",
  "acaBackupTriggerFplPercent",
  "acaBackupPlanName",
  "acaAgeRateManualPremiums",
  "acaPremium",
  "acaFpl",
  "qualifyingChildren",
  "childAges",
  "additionalFederalDeduction",
  "additionalFederalCredits",
  "stateTaxRate",
  "separateStateGains",
  "stateCapitalRate",
  "stateRetirementExclusion",
  "stateSocialSecurityTaxablePercent",
  "taxLossHarvesting",
  "tlhMax",
  "taxGainHarvesting",
  "tghMax",
  "rothConversion",
  "rothAmount",
  "rothTargetRate",
  "oneOffName",
  "oneOffStart",
  "oneOffEnd",
  "oneOffAmount",
  "oneOffInflation",
  "flowMode",
  "yearRange",
  "sheetUrl",
  "googleClientId",
  "sheetRange"
];

const els = {
  status: document.querySelector("#status"),
  importStatus: document.querySelector("#importStatus"),
  planTab: document.querySelector("#planTab"),
  setupTab: document.querySelector("#setupTab"),
  runModel: document.querySelector("#runModel"),
  viewMode: document.querySelector("#viewMode"),
  assetTable: document.querySelector("#assetTable"),
  assetJson: document.querySelector("#assetJson"),
  loadJson: document.querySelector("#loadJson"),
  downloadJson: document.querySelector("#downloadJson"),
  jsonFile: document.querySelector("#jsonFile"),
  csvFile: document.querySelector("#csvFile"),
  sheetUrl: document.querySelector("#sheetUrl"),
  loadSheet: document.querySelector("#loadSheet"),
  googleClientId: document.querySelector("#googleClientId"),
  sheetRange: document.querySelector("#sheetRange"),
  loadPrivateSheet: document.querySelector("#loadPrivateSheet"),
  downloadSetup: document.querySelector("#downloadSetup"),
  restoreSetupFile: document.querySelector("#restoreSetupFile"),
  addAsset: document.querySelector("#addAsset"),
  planYears: document.querySelector("#planYears"),
  runs: document.querySelector("#runs"),
  seed: document.querySelector("#seed"),
  targetSpend: document.querySelector("#targetSpend"),
  backtestMode: document.querySelector("#backtestMode"),
  historicalStartYear: document.querySelector("#historicalStartYear"),
  historicalEndYear: document.querySelector("#historicalEndYear"),
  historicalChunkYears: document.querySelector("#historicalChunkYears"),
  cryptoStockProxy: document.querySelector("#cryptoStockProxy"),
  tipsBondProxy: document.querySelector("#tipsBondProxy"),
  taxYear: document.querySelector("#taxYear"),
  filingStatus: document.querySelector("#filingStatus"),
  stateSelect: document.querySelector("#stateSelect"),
  householdSize: document.querySelector("#householdSize"),
  marketplaceMembers: document.querySelector("#marketplaceMembers"),
  currentAge: document.querySelector("#currentAge"),
  spouseAge: document.querySelector("#spouseAge"),
  acaMemberAges: document.querySelector("#acaMemberAges"),
  retirementPenaltyAge: document.querySelector("#retirementPenaltyAge"),
  rothBasis: document.querySelector("#rothBasis"),
  socialSecurityAnnualBenefit: document.querySelector("#socialSecurityAnnualBenefit"),
  socialSecurityStartAge: document.querySelector("#socialSecurityStartAge"),
  socialSecurityInflationAdjusted: document.querySelector("#socialSecurityInflationAdjusted"),
  rmdEnabled: document.querySelector("#rmdEnabled"),
  rmdStartAge: document.querySelector("#rmdStartAge"),
  irmaaEnabled: document.querySelector("#irmaaEnabled"),
  medicarePartBEnrollees: document.querySelector("#medicarePartBEnrollees"),
  medicarePartDEnrollees: document.querySelector("#medicarePartDEnrollees"),
  medicarePartDMonthlyPremium: document.querySelector("#medicarePartDMonthlyPremium"),
  twoYearsPriorMagi: document.querySelector("#twoYearsPriorMagi"),
  priorYearMagi: document.querySelector("#priorYearMagi"),
  mfsLivedTogether: document.querySelector("#mfsLivedTogether"),
  expectedOopPercent: document.querySelector("#expectedOopPercent"),
  includeTaxes: document.querySelector("#includeTaxes"),
  includeMedical: document.querySelector("#includeMedical"),
  acaEnabled: document.querySelector("#acaEnabled"),
  medicalBase: document.querySelector("#medicalBase"),
  acaPlanCostMode: document.querySelector("#acaPlanCostMode"),
  acaPremiumInputMode: document.querySelector("#acaPremiumInputMode"),
  acaQuoteIncome: document.querySelector("#acaQuoteIncome"),
  fillMassConnectorCare: document.querySelector("#fillMassConnectorCare"),
  fillMassBackupPlan: document.querySelector("#fillMassBackupPlan"),
  findMarketplacePlans: document.querySelector("#findMarketplacePlans"),
  marketplaceApiKey: document.querySelector("#marketplaceApiKey"),
  marketplaceZip: document.querySelector("#marketplaceZip"),
  marketplaceCountyFips: document.querySelector("#marketplaceCountyFips"),
  marketplacePlanYear: document.querySelector("#marketplacePlanYear"),
  marketplaceUsesTobacco: document.querySelector("#marketplaceUsesTobacco"),
  marketplaceUtilizationLevel: document.querySelector("#marketplaceUtilizationLevel"),
  acaPlanLookupStatus: document.querySelector("#acaPlanLookupStatus"),
  marketplacePlanResults: document.querySelector("#marketplacePlanResults"),
  acaBenchmarkMonthlyPremium: document.querySelector("#acaBenchmarkMonthlyPremium"),
  acaSelectedPlanMonthlyPremium: document.querySelector("#acaSelectedPlanMonthlyPremium"),
  oopMaxOverride: document.querySelector("#oopMaxOverride"),
  acaBackupPremiumInputMode: document.querySelector("#acaBackupPremiumInputMode"),
  acaBackupBenchmarkMonthlyPremium: document.querySelector("#acaBackupBenchmarkMonthlyPremium"),
  acaBackupMonthlyPremium: document.querySelector("#acaBackupMonthlyPremium"),
  acaBackupOopMax: document.querySelector("#acaBackupOopMax"),
  acaBackupTriggerFplPercent: document.querySelector("#acaBackupTriggerFplPercent"),
  acaBackupPlanName: document.querySelector("#acaBackupPlanName"),
  acaAgeRateManualPremiums: document.querySelector("#acaAgeRateManualPremiums"),
  acaPremium: document.querySelector("#acaPremium"),
  acaFpl: document.querySelector("#acaFpl"),
  qualifyingChildren: document.querySelector("#qualifyingChildren"),
  childAges: document.querySelector("#childAges"),
  additionalFederalDeduction: document.querySelector("#additionalFederalDeduction"),
  additionalFederalCredits: document.querySelector("#additionalFederalCredits"),
  stateTaxRate: document.querySelector("#stateTaxRate"),
  separateStateGains: document.querySelector("#separateStateGains"),
  stateCapitalRate: document.querySelector("#stateCapitalRate"),
  stateRetirementExclusion: document.querySelector("#stateRetirementExclusion"),
  stateSocialSecurityTaxablePercent: document.querySelector("#stateSocialSecurityTaxablePercent"),
  taxLossHarvesting: document.querySelector("#taxLossHarvesting"),
  tlhMax: document.querySelector("#tlhMax"),
  taxGainHarvesting: document.querySelector("#taxGainHarvesting"),
  tghMax: document.querySelector("#tghMax"),
  rothConversion: document.querySelector("#rothConversion"),
  rothAmount: document.querySelector("#rothAmount"),
  rothTargetRate: document.querySelector("#rothTargetRate"),
  oneOffName: document.querySelector("#oneOffName"),
  oneOffStart: document.querySelector("#oneOffStart"),
  oneOffEnd: document.querySelector("#oneOffEnd"),
  oneOffAmount: document.querySelector("#oneOffAmount"),
  oneOffInflation: document.querySelector("#oneOffInflation"),
  addOneOff: document.querySelector("#addOneOff"),
  oneOffList: document.querySelector("#oneOffList"),
  kpis: document.querySelector("#kpis"),
  flowMode: document.querySelector("#flowMode"),
  yearRange: document.querySelector("#yearRange"),
  yearLabel: document.querySelector("#yearLabel"),
  sankeySvg: document.querySelector("#sankeySvg"),
  timelineSvg: document.querySelector("#timelineSvg"),
  distributionSvg: document.querySelector("#distributionSvg"),
  yearTable: document.querySelector("#yearTable"),
  scenarioTable: document.querySelector("#scenarioTable"),
  backtestTable: document.querySelector("#backtestTable"),
  actionPlan: document.querySelector("#actionPlan"),
  actionPlanNote: document.querySelector("#actionPlanNote"),
  assetBreakdownTable: document.querySelector("#assetBreakdownTable")
};

let assets = sampleAssets.map((asset) => ({ ...asset }));
let oneOffExpenses = defaultOneOffExpenses.map((expense) => ({ ...expense }));
let selectedYearIndex = 0;
let selectedScenarioId = null;
let selectedBacktestIndex = null;
let latest = null;
let activeScreen = "plan";
let googleSheetsAccessToken = null;
let googleSheetsTokenExpiresAt = 0;
let marketplacePlanChoices = [];
let marketplaceSlcspMonthly = null;

const PINNED_YEAR_STORAGE_KEY = "portfolio-success-lab:pinned-year-columns";
const PINNED_ASSET_STORAGE_KEY = "portfolio-success-lab:pinned-asset-columns";
const TABLE_HEIGHT_STORAGE_KEY = "portfolio-success-lab:table-heights";
const ALWAYS_PINNED_YEAR = ["Year", "Age"];
const ALWAYS_PINNED_ASSET = ["Asset", "Account"];
let pinnedYearColumns = loadPinnedColumns(PINNED_YEAR_STORAGE_KEY);
let pinnedAssetColumns = loadPinnedColumns(PINNED_ASSET_STORAGE_KEY);

function loadPinnedColumns(key) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(stored) ? new Set(stored) : new Set();
  } catch { return new Set(); }
}

function savePinnedColumns(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); }
  catch { /* ignore */ }
}

function loadTableHeights() {
  try {
    return JSON.parse(localStorage.getItem(TABLE_HEIGHT_STORAGE_KEY) || "null") || {};
  } catch { return {}; }
}

function saveTableHeight(tableId, height) {
  try {
    const heights = loadTableHeights();
    heights[tableId] = height;
    localStorage.setItem(TABLE_HEIGHT_STORAGE_KEY, JSON.stringify(heights));
  } catch { /* ignore */ }
}

function restoreTableHeight(container, tableId) {
  const heights = loadTableHeights();
  if (heights[tableId]) {
    container.style.maxHeight = `${heights[tableId]}px`;
  }
}

initialize();

// Dismiss loading screen
const loader = document.getElementById("appLoader");
if (loader) {
  loader.style.opacity = "0";
  loader.style.visibility = "hidden";
  setTimeout(() => loader.remove(), 600);
}

function initialize() {
  renderStateOptions();
  loadStoredState();
  syncJsonFromAssets();
  renderAssetTable();
  renderOneOffs();
  bindEvents();
  setActiveScreen(activeScreen);
  runModels();
}

function bindEvents() {
  els.planTab.addEventListener("click", () => setActiveScreen("plan"));
  els.setupTab.addEventListener("click", () => setActiveScreen("setup"));
  els.runModel.addEventListener("click", runModels);
  els.fillMassConnectorCare.addEventListener("click", applyMassachusettsConnectorCarePreset);
  els.fillMassBackupPlan.addEventListener("click", applyMassachusettsBackupPlanPreset);
  els.findMarketplacePlans.addEventListener("click", findMarketplacePlans);
  els.marketplacePlanResults.addEventListener("click", handleMarketplacePlanSelection);
  els.viewMode.addEventListener("change", renderLatest);
  els.flowMode.addEventListener("change", renderFlowAndSales);
  CONTROL_IDS.forEach((id) => {
    const input = document.querySelector(`#${id}`);
    if (!input) return;
    input.addEventListener("change", saveStoredState);
    input.addEventListener("input", saveStoredState);
  });
  els.yearRange.addEventListener("input", () => {
    selectedYearIndex = Number(els.yearRange.value) - 1;
    clampSelectedYearToVisible();
    renderFlowAndSales();
    renderYearLabel();
    renderKpis();
    renderYearTable();
    renderAssetBreakdown();
  });

  els.addAsset.addEventListener("click", () => {
    assets.push({
      id: `asset-${assets.length + 1}`,
      name: "New Asset",
      accountType: "taxable",
      assetClass: "stock",
      holdingPeriod: "long",
      units: 100,
      price: 100,
      costBasisPerUnit: 100,
      dividendYield: 0,
      qualifiedDividendShare: 1
    });
    renderAssetTable();
    syncJsonFromAssets();
    saveStoredState();
  });

  els.loadJson.addEventListener("click", () => {
    try {
      importAssets(parsePortfolioJson(els.assetJson.value), "Loaded JSON.");
    } catch (error) {
      reportImportError(error);
    }
  });

  els.downloadJson.addEventListener("click", () => {
    syncJsonFromAssets();
    downloadJsonText(els.assetJson.value, "portfolio-assets.json");
  });

  els.jsonFile.addEventListener("change", async () => {
    const file = els.jsonFile.files?.[0];
    if (!file) return;
    try {
      setImportStatus(`Reading ${file.name}...`);
      els.assetJson.value = await file.text();
      els.loadJson.click();
    } catch (error) {
      reportImportError(error);
    }
  });

  els.csvFile.addEventListener("change", async () => {
    const file = els.csvFile.files?.[0];
    if (!file) return;
    try {
      setImportStatus(`Reading ${file.name}...`);
      importAssets(parsePortfolioCsv(await file.text()), `Imported ${file.name}.`);
    } catch (error) {
      reportImportError(error);
    } finally {
      els.csvFile.value = "";
    }
  });

  els.loadSheet.addEventListener("click", async () => {
    const url = toGoogleCsvUrl(els.sheetUrl.value.trim());
    if (!url) return reportImportError("Enter a Google Sheets CSV URL.");
    try {
      setStatus("Importing sheet...");
      setImportStatus("Importing sheet...");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Sheet request failed: ${response.status}`);
      importAssets(parsePortfolioCsv(await response.text()), "Imported public sheet.");
    } catch (error) {
      reportImportError(error);
    }
  });

  els.loadPrivateSheet.addEventListener("click", async () => {
    const spreadsheetId = googleSpreadsheetIdFromInput(els.sheetUrl.value);
    const range = els.sheetRange.value.trim() || "A:I";
    if (!spreadsheetId) return reportImportError("Enter a Google Sheet URL or spreadsheet ID.");
    if (!els.googleClientId.value.trim()) return reportImportError("Enter a Google OAuth client ID.");
    try {
      setStatus("Authorizing Google Sheets...");
      setImportStatus("Authorizing Google Sheets...");
      const accessToken = await googleSheetsToken();
      setStatus("Importing private sheet...");
      setImportStatus("Importing private sheet...");
      const rows = await fetchGoogleSheetRows({ spreadsheetId, range, accessToken });
      importAssets(parsePortfolioRows(rows), "Imported private sheet.");
    } catch (error) {
      reportImportError(error);
    }
  });

  els.downloadSetup.addEventListener("click", () => {
    syncJsonFromAssets();
    const backup = createSetupBackup(setupStateSnapshot());
    downloadJsonFile(backup, `portfolio-success-lab-setup-${backup.exportedAt.slice(0, 10)}.json`);
    setImportStatus("Full setup backup downloaded.");
  });

  els.restoreSetupFile.addEventListener("change", async () => {
    const file = els.restoreSetupFile.files?.[0];
    if (!file) return;
    try {
      setImportStatus(`Restoring ${file.name}...`);
      const restoredState = parseSetupBackup(await file.text());
      applySetupState(restoredState);
      syncJsonFromAssets();
      renderAssetTable();
      renderOneOffs();
      saveStoredState();
      runModels();
      setActiveScreen("setup");
      const message = `Restored full setup from ${file.name}. ${assets.length} assets loaded.`;
      setStatus(message);
      setImportStatus(message);
    } catch (error) {
      reportImportError(error);
    } finally {
      els.restoreSetupFile.value = "";
    }
  });

  els.addOneOff.addEventListener("click", () => {
    oneOffExpenses.push({
      name: els.oneOffName.value || "One-off expense",
      startYear: Number(els.oneOffStart.value),
      endYear: Number(els.oneOffEnd.value),
      amount: Number(els.oneOffAmount.value),
      inflationAdjusted: els.oneOffInflation.checked
    });
    renderOneOffs();
    saveStoredState();
  });
}

function renderStateOptions() {
  els.stateSelect.innerHTML = STATE_OPTIONS.map((state) => (
    `<option value="${escapeAttr(state)}" ${state === "Florida" ? "selected" : ""}>${escapeHtml(state)}</option>`
  )).join("");
}

function applyMassachusettsConnectorCarePreset() {
  try {
    if (els.stateSelect.value !== "Massachusetts") {
      throw new Error("Set State to Massachusetts before using the ConnectorCare preset.");
    }

    const householdSize = clampInteger(Number(els.householdSize.value), 1, 12);
    const marketplaceMembers = clampInteger(Number(els.marketplaceMembers.value), 1, 12);
    const income = numberOrNull(els.acaQuoteIncome.value);
    if (!(income > 0)) {
      throw new Error("Enter ACA quote income/MAGI before filling ConnectorCare. This can be lower than target spend.");
    }

    const estimate = massachusettsConnectorCareEstimate({ income, householdSize, marketplaceMembers });
    if (!estimate.eligible) {
      throw new Error(`${estimate.reason} Estimated FPL is ${percentFormatter.format(estimate.fplPercent / 100)}.`);
    }

    els.acaEnabled.checked = true;
    els.acaPlanCostMode.value = "selectedPlan";
    els.acaPremiumInputMode.value = "net";
    els.acaSelectedPlanMonthlyPremium.value = String(estimate.selectedPlanMonthlyPremium);
    els.oopMaxOverride.value = String(estimate.selectedPlanOopMaximum);
    els.acaBenchmarkMonthlyPremium.value = "";
    els.acaPremium.value = "";
    setAcaPlanLookupStatus(
      `${estimate.planName} from ACA MAGI ${moneyFormatter.format(income)}: ${moneyFormatter.format(estimate.selectedPlanMonthlyPremium)}/mo net premium, ${moneyFormatter.format(estimate.selectedPlanOopMaximum)} combined medical/Rx OOP max. Add a backup plan for years above 400% FPL.`
    );
    saveStoredState();
    runModels();
  } catch (error) {
    setAcaPlanLookupStatus(error.message, true);
  }
}

function applyMassachusettsBackupPlanPreset() {
  try {
    if (els.stateSelect.value !== "Massachusetts") {
      throw new Error("Set State to Massachusetts before using the MA backup preset.");
    }
    const benchmark = getMonthlyBenchmarkPremium({ state: "Massachusetts" });
    const marketplaceMembers = clampInteger(Number(els.marketplaceMembers.value), 1, 12);
    const oopMax = marketplaceMembers > 1 ? 21200 : 10600;

    els.acaBackupPremiumInputMode.value = "gross";
    els.acaBackupMonthlyPremium.value = String(benchmark);
    els.acaBackupOopMax.value = String(oopMax);
    els.acaBackupBenchmarkMonthlyPremium.value = String(benchmark);
    els.acaBackupTriggerFplPercent.value = els.acaBackupTriggerFplPercent.value || "400";
    els.acaBackupPlanName.value = "Massachusetts Standard Silver Backup";
    
    setAcaPlanLookupStatus(
      `Massachusetts Standard Silver filled as backup plan using state benchmark rate (${moneyFormatter.format(benchmark)}/mo base) and ${moneyFormatter.format(oopMax)} OOP max.`
    );
    saveStoredState();
    runModels();
  } catch (error) {
    setAcaPlanLookupStatus(error.message, true);
  }
}

async function findMarketplacePlans() {
  try {
    const state = els.stateSelect.value || "";
    if (FEDERAL_MARKETPLACE_UNSUPPORTED_STATES.has(state)) {
      throw new Error("Massachusetts is state-based. Use Fill MA ConnectorCare for subsidized ConnectorCare and the backup-plan fields for a non-ConnectorCare fallback.");
    }
    const apiKey = String(els.marketplaceApiKey.value || "").trim();
    if (!apiKey) throw new Error("Enter a CMS Marketplace API key.");
    const stateCode = marketplaceStateCode(state);
    if (!stateCode) throw new Error("Choose a valid state before searching Marketplace plans.");
    const income = numberOrNull(els.acaQuoteIncome.value);
    if (!(income > 0)) throw new Error("Enter ACA quote income/MAGI before searching Marketplace plans.");
    const zipcode = String(els.marketplaceZip.value || "").trim();
    if (!zipcode) throw new Error("Enter a ZIP code for the Marketplace plan search.");
    const year = Math.trunc(numberOrNull(els.marketplacePlanYear.value) ?? numberOrNull(els.taxYear.value) ?? 2026);
    const countyfips = await resolveMarketplaceCountyFips({ apiKey, zipcode });
    const ages = marketplaceCoveredAges();
    const request = buildMarketplacePlanSearchRequest({
      income,
      ages,
      state,
      zipcode,
      countyfips,
      year,
      usesTobacco: els.marketplaceUsesTobacco.checked,
      utilizationLevel: els.marketplaceUtilizationLevel.value || "Medium"
    });

    setAcaPlanLookupStatus("Searching CMS Marketplace plans...");
    const response = await fetch(marketplaceApiUrl("/plans/search", apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    if (!response.ok) throw new Error(await marketplaceResponseError(response, "Marketplace plan search failed"));

    const payload = await response.json();
    const plans = normalizeMarketplacePlans(payload, { marketplaceMembers: ages.length });
    if (!plans.length) throw new Error("CMS Marketplace returned no plans for that household and location.");
    const slcspMonthly = secondLowestSilverPremium(plans);
    marketplacePlanChoices = plans;
    marketplaceSlcspMonthly = slcspMonthly;
    renderMarketplacePlanResults(plans, slcspMonthly);
    setAcaPlanLookupStatus(
      `Found ${numberFormatter.format(plans.length)} Marketplace plans for ${zipcode}. Pick a primary plan or a backup plan.`
    );
  } catch (error) {
    setAcaPlanLookupStatus(error.message, true);
  }
}

async function resolveMarketplaceCountyFips({ apiKey, zipcode }) {
  const current = String(els.marketplaceCountyFips.value || "").trim();
  if (current) return current;

  const response = await fetch(marketplaceApiUrl(`/counties/by/zip/${encodeURIComponent(zipcode)}`, apiKey));
  if (!response.ok) throw new Error(await marketplaceResponseError(response, "County lookup failed"));
  const counties = normalizeMarketplaceCounties(await response.json());
  if (!counties.length) throw new Error("CMS Marketplace could not find a county for that ZIP code.");
  if (counties.length === 1) {
    els.marketplaceCountyFips.value = counties[0].fips;
    saveStoredState();
    return counties[0].fips;
  }

  renderMarketplaceCountyChoices(counties);
  throw new Error("That ZIP spans multiple counties. Choose the county, then search again.");
}

function renderMarketplaceCountyChoices(counties) {
  els.marketplacePlanResults.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>County</th><th>FIPS</th><th></th></tr></thead>
        <tbody>
          ${counties.map((county) => `
            <tr>
              <td>${escapeHtml(county.name || "County")}</td>
              <td>${escapeHtml(county.fips)}</td>
              <td><button type="button" data-county-fips="${escapeAttr(county.fips)}">Use</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderMarketplacePlanResults(plans, slcspMonthly) {
  const visiblePlans = plans.slice(0, 60);
  els.marketplacePlanResults.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Plan</th>
            <th>Issuer</th>
            <th>Metal</th>
            <th>Gross</th>
            <th>Est. net</th>
            <th>OOP max</th>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${visiblePlans.map((plan, index) => `
            <tr>
              <td>${escapeHtml(plan.name)}</td>
              <td>${escapeHtml(plan.issuer || "Unknown")}</td>
              <td>${escapeHtml(plan.metalLevel || "")}</td>
              <td>${moneyFormatter.format(plan.premium ?? 0)}</td>
              <td>${Number.isFinite(plan.premiumWithCredit) ? moneyFormatter.format(plan.premiumWithCredit) : "-"}</td>
              <td>${Number.isFinite(plan.oopMaximum) ? moneyFormatter.format(plan.oopMaximum) : "Manual"}</td>
              <td><button type="button" data-plan-target="primary" data-plan-index="${index}">Use primary</button></td>
              <td><button type="button" data-plan-target="backup" data-plan-index="${index}">Use backup</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p class="muted">SLCSP estimate from returned silver plans: ${Number.isFinite(slcspMonthly) ? moneyFormatter.format(slcspMonthly) : "not available"} monthly. Showing ${numberFormatter.format(visiblePlans.length)} of ${numberFormatter.format(plans.length)} plans.</p>
  `;
}

function handleMarketplacePlanSelection(event) {
  const countyButton = event.target.closest("[data-county-fips]");
  if (countyButton) {
    els.marketplaceCountyFips.value = countyButton.dataset.countyFips;
    saveStoredState();
    findMarketplacePlans();
    return;
  }

  const button = event.target.closest("[data-plan-index]");
  if (!button) return;
  const plan = marketplacePlanChoices[Number(button.dataset.planIndex)];
  if (!plan) return;
  if (button.dataset.planTarget === "backup") {
    fillBackupPlanFromMarketplace(plan);
  } else {
    fillPrimaryPlanFromMarketplace(plan);
  }
  saveStoredState();
  runModels();
}

function fillPrimaryPlanFromMarketplace(plan) {
  els.acaMemberAges.value = marketplaceCoveredAges().join(", ");
  els.acaEnabled.checked = true;
  els.acaPlanCostMode.value = "selectedPlan";
  els.acaPremiumInputMode.value = "gross";
  els.acaSelectedPlanMonthlyPremium.value = formatPlanInput(plan.premium);
  els.oopMaxOverride.value = Number.isFinite(plan.oopMaximum) ? formatPlanInput(plan.oopMaximum) : "";
  els.acaBenchmarkMonthlyPremium.value = Number.isFinite(marketplaceSlcspMonthly)
    ? formatPlanInput(marketplaceSlcspMonthly)
    : "";
  setAcaPlanLookupStatus(`${plan.name} filled as the primary ACA plan using gross Marketplace premiums.`);
}

function fillBackupPlanFromMarketplace(plan) {
  els.acaMemberAges.value = marketplaceCoveredAges().join(", ");
  els.acaBackupPremiumInputMode.value = "gross";
  els.acaBackupMonthlyPremium.value = formatPlanInput(plan.premium);
  els.acaBackupOopMax.value = Number.isFinite(plan.oopMaximum) ? formatPlanInput(plan.oopMaximum) : "";
  els.acaBackupBenchmarkMonthlyPremium.value = Number.isFinite(marketplaceSlcspMonthly)
    ? formatPlanInput(marketplaceSlcspMonthly)
    : "";
  els.acaBackupTriggerFplPercent.value = els.acaBackupTriggerFplPercent.value || "400";
  els.acaBackupPlanName.value = [plan.name, plan.issuer].filter(Boolean).join(" - ");
  setAcaPlanLookupStatus(`${plan.name} filled as the backup plan for future MAGI above the trigger.`);
}

function marketplaceCoveredAges() {
  const marketplaceMembers = clampInteger(Number(els.marketplaceMembers.value), 1, 12);
  return acaMemberAgesForScenario({
    explicitMemberAges: numberList(els.acaMemberAges.value),
    marketplaceMembers,
    currentAge: Number(els.currentAge.value) || DEFAULT_SCENARIO.currentAge,
    spouseAge: numberOrNull(els.spouseAge.value) ?? (Number(els.currentAge.value) || DEFAULT_SCENARIO.currentAge)
  });
}

async function marketplaceResponseError(response, fallback) {
  const text = await response.text();
  try {
    const payload = JSON.parse(text);
    return `${fallback}: ${payload.message ?? payload.error ?? response.statusText}`;
  } catch {
    return `${fallback}: ${text || response.statusText}`;
  }
}

function formatPlanInput(value) {
  return Number.isFinite(value) ? String(round(value, 2)) : "";
}

function setActiveScreen(screen) {
  const isSetup = screen === "setup";
  activeScreen = isSetup ? "setup" : "plan";
  document.body.dataset.screen = isSetup ? "setup" : "plan";
  els.setupTab.classList.toggle("active", isSetup);
  els.planTab.classList.toggle("active", !isSetup);
  saveStoredState();
}

function loadStoredState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!stored || typeof stored !== "object") return;
    applySetupState(stored);
  } catch (error) {
    console.warn("Saved state could not be loaded.", error);
  }
}

function saveStoredState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setupStateSnapshot()));
  } catch (error) {
    console.warn("Saved state could not be written.", error);
  }
}

function setAcaPlanLookupStatus(message, isError = false) {
  paintStatus(els.acaPlanLookupStatus, message, isError);
  if (els.acaPlanLookupStatus) {
    els.acaPlanLookupStatus.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function setupStateSnapshot() {
  return {
    activeScreen,
    controls: readControlState(),
    assets,
    oneOffExpenses
  };
}

function readControlState() {
  const controls = {};
  for (const id of CONTROL_IDS) {
    const input = document.querySelector(`#${id}`);
    if (!input || input.type === "file") continue;
    controls[id] = input.type === "checkbox" ? input.checked : input.value;
  }
  return controls;
}

function applySetupState(stored) {
  if (Array.isArray(stored.assets)) assets = stored.assets.map((asset) => ({ ...asset }));
  if (Array.isArray(stored.oneOffExpenses)) {
    oneOffExpenses = stored.oneOffExpenses.map((expense) => ({ ...expense }));
  }
  activeScreen = stored.activeScreen === "setup" ? "setup" : "plan";

  for (const [id, value] of Object.entries(stored.controls ?? {})) {
    const input = document.querySelector(`#${id}`);
    if (!input || input.type === "file") continue;
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = value ?? "";
    }
  }
}

function downloadJsonFile(value, filename) {
  downloadJsonText(JSON.stringify(value, null, 2), filename);
}

function downloadJsonText(text, filename) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function runModels() {
  try {
    const started = performance.now();
    saveStoredState();
    const scenario = readScenario();
    const taxProfile = readTaxProfile();
    const runs = clampInteger(Number(els.runs.value), 10, 5000);
    const seed = Number(els.seed.value) || 42;
    const historicalAssetClasses = assetClassesInPortfolio(assets);
    const historicalProxies = historicalProxyMapForControls(historicalAssetClasses);
    const strictHistoricalCoverage = historicalCoverageForAssetClasses(historicalAssetClasses);
    const historicalCoverage = historicalCoverageForAssetClasses(historicalAssetClasses, { assetClassProxies: historicalProxies });
    reconcileHistoricalRangeControls({ coverage: historicalCoverage, strictCoverage: strictHistoricalCoverage, proxies: historicalProxies });
    const historicalRange = readHistoricalRange(historicalCoverage);
    const historicalSequences = makeHistoricalSequences({
      planYears: scenario.planYears,
      mode: els.backtestMode.value,
      startYear: historicalRange.startYear,
      endYear: historicalRange.endYear,
      chunkYears: Number(els.historicalChunkYears.value) || 10,
      requiredAssetClasses: historicalAssetClasses,
      assetClassProxies: historicalProxies
    });

    setStatus("Running projections...");
    latest = {
      scenario,
      taxProfile,
      historicalCoverage,
      historicalAssetClasses,
      historicalProxies,
      historicalRange,
      historicalMode: els.backtestMode.value,
      plan: simulatePlan({ assets, scenario, taxProfile }),
      monteCarlo: runMonteCarlo({ assets, scenario, taxProfile, runs, seed }),
      backtests: runHistoricalBacktests({
        assets,
        scenario,
        taxProfile,
        sequences: historicalSequences
      })
    };

    selectedYearIndex = Math.min(selectedYearIndex, scenario.planYears - 1);
    els.yearRange.max = String(scenario.planYears);
    els.yearRange.value = String(selectedYearIndex + 1);
    selectedScenarioId = latest.monteCarlo.scenarios[0]?.id ?? null;
    selectedBacktestIndex = null;
    renderLatest();
    setStatus(`Completed ${runs} Monte Carlo runs and ${latest.backtests.length} historical backtests in ${Math.round(performance.now() - started)} ms.${historicalCompletionNote()}`);
  } catch (error) {
    console.error(error);
    setStatus(error.message, true);
  }
}

function renderLatest() {
  if (!latest) return;
  clampSelectedYearToVisible();
  renderKpis();
  renderFlowAndSales();
  drawTimeline();
  drawDistribution();
  renderYearTable();
  renderAssetBreakdown();
  renderScenarioTable();
  renderBacktests();
}

function renderKpis() {
  const years = activeVisibleYears();
  const currentYear = years[selectedYearIndex] ?? years[0];
  const finalYear = years.at(-1);
  const summary = latest.monteCarlo.summary;
  const adjustedMedian = adjustAmount(summary.medianEndingValue, finalYear);
  const adjustedP10 = adjustAmount(summary.p10EndingValue, finalYear);
  const adjustedHeir = adjustAmount(summary.medianHeirValue, finalYear);
  const kpis = [
    ["Success rate", percentFormatter.format(summary.successRate)],
    ["Median ending", moneyFormatter.format(adjustedMedian)],
    ["P10 ending", moneyFormatter.format(adjustedP10)],
    ["Median heir value", moneyFormatter.format(adjustedHeir)],
    ["Selected year tax", moneyFormatter.format(adjustAmount(currentYear.taxes.totalTax, currentYear))]
  ];

  els.kpis.innerHTML = kpis.map(([label, value]) => `
    <div class="kpi">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function renderFlowAndSales() {
  if (!latest) return;
  clampSelectedYearToVisible();
  const years = activeVisibleYears();
  const year = years[selectedYearIndex];
  renderYearLabel();
  const isPortfolioFlow = els.flowMode.value === "total";
  const flows = isPortfolioFlow
    ? portfolioFlowsForYear(year)
    : flowsForYear(year);
  els.sankeySvg.setAttribute(
    "aria-label",
    els.flowMode.value === "total"
      ? "Yearly portfolio flow diagram"
      : "Yearly cash flow diagram"
  );
  drawSankey(els.sankeySvg, flows, isPortfolioFlow ? {} : sankeyNodeDetailsForYear(year));
  renderActionPlan();
}

function renderYearLabel() {
  const year = activeVisibleYears()[selectedYearIndex];
  els.yearLabel.textContent = year ? `${year.year}` : `Year ${selectedYearIndex + 1}`;
}

function acaPlanLabel(year) {
  const role = year.aca?.activePlanRole;
  if (!role) return "";
  if (role === "backup") return year.aca.planName ? `Backup: ${year.aca.planName}` : "Backup";
  return "Primary";
}

function renderYearTable() {
  const years = activeVisibleYears();
  const headers = ["Year", "Age", "Stock", "Bond", "Real estate", "TIPS", "Crypto", "Inflation", "Start value", "End value", "Sales / withdrawals", "Dividends", "Social Security", "RMD", "Total cash", "Total need", "Tax", "Fed income tax", "CG/QD tax", "NIIT", "Credits", "State tax", "MAGI", "Taxable SS", "65+ deduction", "CTC children", "ACA plan", "ACA SLCSP", "ACA gross", "ACA subsidy", "ACA net", "Medicare", "Spend", "Medical", "Tax gain harvest", "Roth conv.", "Roth basis left", "Penalty", "Loss carry"];
  const rows = years.map((year) => [
    year.year,
    ageLabel(year.age),
    returnPercent(year, "stock"),
    returnPercent(year, "bond"),
    returnPercent(year, "realEstate"),
    returnPercent(year, "tips"),
    returnPercent(year, "crypto"),
    returnPercent(year, "inflation"),
    money(year.beginningPortfolioValue, year),
    money(year.endingPortfolioValue, year),
    money(year.cashRaised, year),
    money(year.taxableDividendsCash ?? 0, year),
    money(year.socialSecurityBenefits ?? 0, year),
    money(year.rmdAmount ?? 0, year),
    money(year.cashAvailable ?? ((year.cashRaised ?? 0) + (year.taxableDividendsCash ?? 0)), year),
    money(year.totalCashRequired ?? ((year.plannedSpending ?? 0) + (year.medicalCost ?? 0) + (year.taxes?.totalTax ?? 0)), year),
    money(year.taxes.totalTax, year),
    money(year.taxes.federalIncomeTax ?? year.taxes.incomeTax ?? 0, year),
    money(year.taxes.federalPreferentialTax ?? 0, year),
    money(year.taxes.niitTax ?? 0, year),
    money(year.taxes.federalCreditsUsed ?? 0, year),
    money(year.taxes.stateTax ?? 0, year),
    money(year.magi, year),
    money(year.taxableSocialSecurity ?? 0, year),
    money(year.age65AdditionalDeduction ?? 0, year),
    year.qualifyingChildren ?? 0,
    acaPlanLabel(year),
    money(year.aca.benchmarkPremium ?? 0, year),
    money(year.aca.grossPremium ?? 0, year),
    money(year.aca.subsidy, year),
    money(year.aca.netPremium ?? 0, year),
    money(year.medicare?.totalAnnualPremium ?? 0, year),
    money(year.plannedSpending, year),
    money(year.medicalCost, year),
    money(year.taxGainHarvested, year),
    money(year.rothConversionAmount, year),
    money(year.rothBasisRemaining ?? 0, year),
    money(year.penaltyTax, year),
    money(year.lossCarryforward, year)
  ]);

  els.yearTable.className = "pinnable-table-wrap";
  restoreTableHeight(els.yearTable, "yearTable");
  els.yearTable.innerHTML = pinnableTableHtml(
    headers, rows, pinnedYearColumns, ALWAYS_PINNED_YEAR,
    (index) => `data-year-index="${index}" class="${index === selectedYearIndex ? "selected-row" : ""}"`
  );
  applyPinnedColumnOffsets(els.yearTable);
  els.yearTable.querySelectorAll("[data-year-index]").forEach((row) => {
    row.addEventListener("click", () => {
      selectedYearIndex = Number(row.dataset.yearIndex);
      els.yearRange.value = String(selectedYearIndex + 1);
      renderKpis();
      renderFlowAndSales();
      renderYearTable();
      renderAssetBreakdown();
    });
  });
  bindPinToggles(els.yearTable, pinnedYearColumns, ALWAYS_PINNED_YEAR, PINNED_YEAR_STORAGE_KEY, () => renderYearTable());
  bindResizeObserver(els.yearTable, "yearTable");
  addStickyHorizontalScrollbar(els.yearTable);
}

function renderAssetBreakdown() {
  const years = activeVisibleYears();
  const year = years[selectedYearIndex] ?? years[0];
  if (!year) {
    els.assetBreakdownTable.innerHTML = `<p class="empty-state">No asset snapshot available.</p>`;
    return;
  }

  const current = aggregateAssetSnapshot(year.assets);
  const previous = aggregateAssetSnapshot(selectedYearIndex > 0
    ? years[selectedYearIndex - 1]?.assets
    : year.beginningAssets);
  const keys = new Set([...current.keys(), ...previous.keys()]);
  const assetHeaders = ["Asset", "Account", "Class", "Units", "Price", "Ending value", "Change", "Change %", "Basis", "Unrealized"];
  const rows = [...keys]
    .map((key) => {
      const currentAsset = current.get(key) ?? emptyAssetFromKey(key);
      const previousAsset = previous.get(key) ?? emptyAssetFromKey(key);
      const change = currentAsset.value - previousAsset.value;
      const changePercent = previousAsset.value > 0 ? change / previousAsset.value : null;
      return { currentAsset, change, changePercent };
    })
    .sort((a, b) => Math.abs(b.currentAsset.value) - Math.abs(a.currentAsset.value))
    .map(({ currentAsset, change, changePercent }) => [
      escapeHtml(currentAsset.name),
      escapeHtml(currentAsset.accountType),
      escapeHtml(currentAsset.assetClass),
      unitFormatter.format(currentAsset.units),
      money(currentAsset.price, year),
      money(currentAsset.value, year),
      signedMoney(change, year),
      changePercent == null ? "n/a" : signedPercent(changePercent),
      money(currentAsset.costBasis, year),
      signedMoney(currentAsset.unrealizedGain, year)
    ]);

  els.assetBreakdownTable.className = "pinnable-table-wrap";
  restoreTableHeight(els.assetBreakdownTable, "assetBreakdown");
  els.assetBreakdownTable.innerHTML = pinnableTableHtml(
    assetHeaders, rows, pinnedAssetColumns, ALWAYS_PINNED_ASSET
  );
  applyPinnedColumnOffsets(els.assetBreakdownTable);
  bindPinToggles(els.assetBreakdownTable, pinnedAssetColumns, ALWAYS_PINNED_ASSET, PINNED_ASSET_STORAGE_KEY, () => renderAssetBreakdown());
  bindResizeObserver(els.assetBreakdownTable, "assetBreakdown");
  addStickyHorizontalScrollbar(els.assetBreakdownTable);
}

function renderScenarioTable() {
  const rows = latest.monteCarlo.scenarios.map((scenarioResult) => [
    scenarioResult.id,
    scenarioResult.success ? `<span class="positive">Yes</span>` : `<span class="negative">No</span>`,
    money(scenarioResult.endingValue, scenarioResult.years.at(-1)),
    money(scenarioResult.heirValue, scenarioResult.years.at(-1)),
    scenarioResult.depletionYear ?? ""
  ]);

  els.scenarioTable.innerHTML = tableHtml(
    ["Run", "Success", "Ending", "Heirs", "Failure year"],
    rows,
    (index) => {
      const id = latest.monteCarlo.scenarios[index].id;
      return `data-scenario="${id}" class="${selectedBacktestIndex == null && id === selectedScenarioId ? "selected-row" : ""}"`;
    }
  );

  els.scenarioTable.querySelectorAll("[data-scenario]").forEach((row) => {
    row.addEventListener("click", () => {
      selectedScenarioId = Number(row.dataset.scenario);
      selectedBacktestIndex = null;
      clampSelectedYearToVisible();
      renderScenarioTable();
      renderBacktests();
      drawTimeline();
      renderKpis();
      renderFlowAndSales();
      renderYearTable();
      renderAssetBreakdown();
    });
  });
}

function renderBacktests() {
  if (!latest.backtests.length) {
    els.backtestTable.innerHTML = `<p class="empty-state">No historical backtests are available for the selected assets and date range.</p>`;
    return;
  }

  const successes = latest.backtests.filter((backtest) => backtest.success).length;
  const successRate = successes / latest.backtests.length;
  const coverage = latest.historicalCoverage;
  const proxyNote = historicalProxyNote();
  const rangeNote = historicalRangeNote();
  const note = coverage
    ? `Historical success ${percentFormatter.format(successRate)} across ${latest.backtests.length} paths. Data version ${HISTORICAL_RETURN_DATA_VERSION}; ${coverage.startYear}-${coverage.endYear} available for this asset mix.${proxyNote}${rangeNote}`
    : `Historical success ${percentFormatter.format(successRate)} across ${latest.backtests.length} paths.`;
  const rows = latest.backtests.map((backtest) => [
    escapeHtml(backtest.id),
    backtest.success ? `<span class="positive">Yes</span>` : `<span class="negative">No</span>`,
    money(backtest.endingValue, backtest.years.at(-1)),
    money(backtest.heirValue, backtest.years.at(-1)),
    backtest.depletionYear ?? firstFailureYear(backtest.years) ?? ""
  ]);

  els.backtestTable.innerHTML = `
    <p class="table-note">${escapeHtml(note)}</p>
    ${tableHtml(
      ["Path", "Success", "Ending", "Heirs", "Failure year"],
      rows,
      (index) => `data-backtest-index="${index}" class="${index === selectedBacktestIndex ? "selected-row" : ""}"`
    )}
  `;

  els.backtestTable.querySelectorAll("[data-backtest-index]").forEach((row) => {
    row.addEventListener("click", () => {
      selectedBacktestIndex = Number(row.dataset.backtestIndex);
      selectedScenarioId = null;
      clampSelectedYearToVisible();
      renderScenarioTable();
      renderBacktests();
      drawTimeline();
      renderKpis();
      renderFlowAndSales();
      renderYearTable();
      renderAssetBreakdown();
    });
  });
}

function renderActionPlan() {
  const year = activeVisibleYears()[selectedYearIndex];
  if (!year) {
    els.actionPlan.innerHTML = `<p class="empty-state">Run a model to generate an action plan.</p>`;
    els.actionPlanNote.textContent = "";
    return;
  }

  els.actionPlanNote.textContent = `${year.year} selected`;
  const rows = [];
  const magiTarget = year.acaMagiCeiling;
  if (Number.isFinite(magiTarget) && year.aca?.enabled !== false) {
    rows.push([
      "Manage MAGI",
      money(magiTarget, year),
      "ACA threshold",
      `${money(year.magi, year)} projected MAGI; ${money(year.aca.subsidy, year)} subsidy`,
      `Keep discretionary gains and conversions under about ${percentFormatter.format((year.acaMagiCeilingFplPercent ?? 0) / 100)} FPL.`
    ]);
  }

  if ((year.rothConversionAmount ?? 0) > 0) {
    rows.push([
      "Convert traditional to Roth",
      money(year.rothConversionAmount, year),
      "Traditional accounts",
      `${money(taxAttributionFor(year, "Roth conversion"), year)} estimated tax share`,
      "Fills low ordinary brackets without crossing the selected ACA MAGI target."
    ]);
  }

  if ((year.rmdAmount ?? 0) > 0) {
    rows.push([
      "Take required minimum distribution",
      money(year.rmdAmount, year),
      "Traditional accounts",
      `${money(year.rmdBase ?? 0, year)} prior balance / ${year.rmdFactor ?? "n/a"} divisor`,
      "Forced taxable distribution under the modeled RMD start age."
    ]);
  }

  if ((year.socialSecurityBenefits ?? 0) > 0) {
    rows.push([
      "Collect Social Security",
      money(year.socialSecurityBenefits, year),
      "Social Security",
      `${money(year.taxableSocialSecurity ?? 0, year)} taxable; ${money(taxAttributionFor(year, "Social Security benefits"), year)} estimated tax share`,
      "Uses provisional-income rules and counts non-taxable benefits in ACA MAGI."
    ]);
  }

  if ((year.taxGainHarvested ?? 0) > 0) {
    rows.push([
      "Harvest taxable gains",
      money(year.taxGainHarvested, year),
      "Taxable lots",
      `${money(taxAttributionFor(year, "Tax gain harvesting"), year)} estimated tax share`,
      "Steps up basis while staying inside the federal and ACA room the model found."
    ]);
  }

  if ((year.realizedCapitalLosses ?? 0) > 0) {
    rows.push([
      "Harvest taxable losses",
      money(year.realizedCapitalLosses, year),
      "Taxable lots",
      `${money(year.lossCarryforward, year)} loss carryforward after this year`,
      "Offsets gains first, then up to the allowed ordinary-income offset."
    ]);
  }

  const taxableDividendsForSpending = Math.min(year.taxableDividendsCash ?? 0, year.totalCashRequired ?? 0);
  if (taxableDividendsForSpending > 1) {
    rows.push([
      "Collect taxable dividends for spending",
      money(taxableDividendsForSpending, year),
      "Taxable account dividends",
      `${money(year.taxableDividendsCash ?? 0, year)} taxable dividends; ${money(taxAttributionFor(year, "Taxable account dividends"), year)} estimated tax share`,
      "Use taxable dividend cash for this year's spending before selling additional assets."
    ]);
  }

  for (const sale of year.sales ?? []) {
    rows.push([
      saleActionLabel(sale),
      money(sale.proceeds, year),
      escapeHtml(sale.name),
      saleImpactText(sale, year),
      saleReasonText(sale)
    ]);
  }

  if ((year.taxes?.totalTax ?? 0) > 0) {
    rows.push([
      "Reserve for taxes",
      money(year.taxes.totalTax, year),
      "Spending reserve",
      `${money(year.taxes.federalIncomeTax ?? 0, year)} federal; ${money(year.taxes.stateTax ?? 0, year)} state; ${money(year.taxes.niitTax ?? 0, year)} NIIT`,
      "Includes estimated income taxes and any early-withdrawal penalties."
    ]);
  }

  if ((year.medicalCost ?? 0) > 0) {
    const medicarePremium = year.medicare?.totalAnnualPremium ?? 0;
    rows.push([
      "Reserve for medical",
      money(year.medicalCost, year),
      "Spending reserve",
      `${money(year.aca?.grossPremium ?? 0, year)} gross ACA premium; ${money(year.aca?.subsidy ?? 0, year)} subsidy; ${money(year.aca?.netPremium ?? 0, year)} net`,
      `${money(medicarePremium, year)} Medicare/IRMAA after age 65.`
    ]);
  }

  if ((year.unfunded ?? 0) > 1) {
    rows.push([
      "Close funding gap",
      money(year.unfunded, year),
      "Portfolio",
      "Plan failure in selected year",
      "Reduce spending, add cash, or change withdrawal order before relying on this path."
    ]);
  }

  els.actionPlan.innerHTML = rows.length
    ? tableHtml(["Move", "Amount", "Source", "Tax / cash impact", "Why"], rows)
    : `<p class="empty-state">No portfolio moves are needed in ${year.year}.</p>`;
  addStickyHorizontalScrollbar(els.actionPlan);
}

function taxAttributionFor(year, source) {
  return (year.taxAttribution ?? [])
    .filter((item) => item.source === source)
    .reduce((total, item) => total + (item.amount ?? 0), 0);
}

function historicalProxyMapForControls(assetClasses = []) {
  return {
    ...(els.cryptoStockProxy?.checked && assetClasses.includes("crypto") ? { crypto: "stock" } : {}),
    ...(els.tipsBondProxy?.checked && assetClasses.includes("tips") ? { tips: "bond" } : {})
  };
}

function reconcileHistoricalRangeControls({ coverage, strictCoverage, proxies }) {
  if (!coverage || !Object.keys(proxies ?? {}).length || els.backtestMode.value !== "all") return;
  const start = Number(els.historicalStartYear.value);
  const end = Number(els.historicalEndYear.value);
  if (strictCoverage && start === strictCoverage.startYear && end === strictCoverage.endYear && coverage.startYear < strictCoverage.startYear) {
    els.historicalStartYear.value = String(coverage.startYear);
    els.historicalEndYear.value = String(coverage.endYear);
  }
}

function readHistoricalRange(coverage) {
  return {
    startYear: Number(els.historicalStartYear.value) || coverage?.startYear,
    endYear: Number(els.historicalEndYear.value) || coverage?.endYear
  };
}

function historicalProxyNote() {
  const notes = [];
  if (latest?.historicalProxies?.crypto === "stock") {
    notes.push("crypto uses stock returns before crypto data begins");
  }
  if (latest?.historicalProxies?.tips === "bond") {
    notes.push("TIPS uses bond returns before TIPS data begins");
  }
  return notes.length ? ` ${sentenceJoin(notes)}.` : "";
}

function historicalRangeNote() {
  if (!latest?.historicalRange || latest.historicalMode === "specific") return "";
  const rangeYears = Math.max(0, latest.historicalRange.endYear - latest.historicalRange.startYear + 1);
  const coverage = latest.historicalCoverage;
  if (latest.backtests.length === 1 && coverage?.rowCount <= latest.scenario.planYears) {
    return ` The selected asset mix has ${coverage.rowCount} usable historical years (${coverage.startYear}-${coverage.endYear}), shorter than the ${latest.scenario.planYears}-year plan, so it is repeated as one path.`;
  }
  if (latest.backtests.length === 1 && rangeYears <= latest.scenario.planYears) {
    return ` Selected range ${latest.historicalRange.startYear}-${latest.historicalRange.endYear} is shorter than the ${latest.scenario.planYears}-year plan, so it is repeated as one path.`;
  }
  return "";
}

function historicalCompletionNote() {
  const note = historicalRangeNote().trim();
  return note ? ` ${note}` : "";
}

function sentenceJoin(items) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function saleActionLabel(sale) {
  if (sale.assetClass === "cash") return "Use cash";
  return sale.accountType === "traditional" || sale.accountType === "roth" ? "Withdraw" : "Sell";
}

function saleImpactText(sale, year) {
  if (sale.assetClass === "cash") {
    return `${money(0, year)} taxable gain/loss; ${money(sale.penaltyTax ?? 0, year)} penalty`;
  }
  return `${money(sale.gain, year)} gain; ${money(sale.penaltyTax ?? 0, year)} penalty`;
}

function saleReasonText(sale) {
  if (sale.assetClass === "cash") {
    return `${escapeHtml(sale.accountType)} cash, no capital gain/loss treatment.`;
  }
  return `${escapeHtml(sale.accountType)} account, ${escapeHtml(sale.taxType)} treatment.`;
}

function activeYears() {
  if (!latest) return [];
  if (selectedBacktestIndex != null) {
    return latest.backtests[selectedBacktestIndex]?.years ?? latest.plan.years;
  }
  const selectedScenario = latest.monteCarlo.scenarios.find((scenario) => scenario.id === selectedScenarioId);
  return selectedScenario?.years ?? latest.plan.years;
}

function activeVisibleYears() {
  return visibleYearsThroughFailure(activeYears());
}

function clampSelectedYearToVisible() {
  const years = activeVisibleYears();
  selectedYearIndex = Math.min(Math.max(0, selectedYearIndex), Math.max(0, years.length - 1));
  if (els.yearRange) {
    els.yearRange.max = String(Math.max(1, years.length));
    els.yearRange.value = String(selectedYearIndex + 1);
  }
}

function visibleYearsThroughFailure(years) {
  const failureIndex = years.findIndex(isFailureYear);
  return failureIndex === -1 ? years : years.slice(0, failureIndex + 1);
}

function firstFailureYear(years) {
  return years.find(isFailureYear)?.year ?? null;
}

function isFailureYear(year) {
  return year.unfunded > 1 || year.endingPortfolioValue <= 1;
}

function addStickyHorizontalScrollbar(container) {
  container._stickyCleanup?.();
  const table = container.querySelector("table");
  if (!table) return;
  const scrollbar = document.createElement("div");
  scrollbar.className = "sticky-x-scroll";
  const spacer = document.createElement("div");
  spacer.className = "sticky-x-scroll-spacer";
  scrollbar.append(spacer);
  container.append(scrollbar);

  const updateWidth = () => {
    spacer.style.width = `${table.scrollWidth}px`;
    scrollbar.classList.toggle("is-needed", table.scrollWidth > container.clientWidth + 1);
    updateFixedState();
  };

  let syncing = false;
  container.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    scrollbar.scrollLeft = container.scrollLeft;
    syncing = false;
  });
  scrollbar.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    container.scrollLeft = scrollbar.scrollLeft;
    syncing = false;
  });

  const updateFixedState = () => {
    const rect = container.getBoundingClientRect();
    const shouldFix = table.scrollWidth > container.clientWidth + 1
      && rect.top < window.innerHeight - 40
      && rect.bottom > window.innerHeight + 34;
    scrollbar.classList.toggle("is-fixed", shouldFix);
    if (shouldFix) {
      scrollbar.style.left = `${Math.max(0, rect.left)}px`;
      scrollbar.style.width = `${Math.min(rect.width, window.innerWidth - Math.max(0, rect.left))}px`;
    } else {
      scrollbar.style.left = "";
      scrollbar.style.width = "";
    }
  };
  const onViewportChange = () => {
    updateWidth();
    updateFixedState();
  };

  window.addEventListener("scroll", onViewportChange, { passive: true });
  window.addEventListener("resize", onViewportChange);
  container._stickyCleanup = () => {
    window.removeEventListener("scroll", onViewportChange);
    window.removeEventListener("resize", onViewportChange);
  };

  updateWidth();
  requestAnimationFrame(updateWidth);
}

function renderAssetTable() {
  const accountOptions = ["taxable", "traditional", "roth", "hsa"];
  const assetClassOptions = ["stock", "bond", "cash", "realEstate", "tips", "crypto"];
  const holdingOptions = ["long", "short"];
  const rows = assets.map((asset, index) => `
    <tr>
      <td><input data-index="${index}" data-field="name" value="${escapeAttr(asset.name)}"></td>
      <td>${selectHtml(index, "accountType", accountOptions, asset.accountType)}</td>
      <td>${selectHtml(index, "assetClass", assetClassOptions, asset.assetClass)}</td>
      <td><input data-index="${index}" data-field="units" type="number" step="0.0001" value="${asset.units}"></td>
      <td><input data-index="${index}" data-field="price" type="number" step="0.01" value="${asset.price}"></td>
      <td><input data-index="${index}" data-field="costBasisPerUnit" type="number" step="0.01" value="${asset.costBasisPerUnit}"></td>
      <td><input data-index="${index}" data-field="dividendYield" type="number" step="0.001" value="${asset.dividendYield ?? 0}"></td>
      <td><input data-index="${index}" data-field="qualifiedDividendShare" type="number" step="0.05" min="0" max="1" value="${asset.qualifiedDividendShare ?? 0}"></td>
      <td>${selectHtml(index, "holdingPeriod", holdingOptions, asset.holdingPeriod ?? "long")}</td>
      <td><button type="button" data-remove="${index}">Remove</button></td>
    </tr>
  `).join("");

  els.assetTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th><th>Account</th><th>Class</th><th>Units</th><th>Price</th><th>Basis</th><th>Yield</th><th>Qualified</th><th>Term</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="asset-total">Total assets: ${moneyFormatter.format(portfolioValue(assets))}</p>
  `;

  els.assetTable.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("change", () => {
      const index = Number(input.dataset.index);
      const field = input.dataset.field;
      assets[index][field] = numericAssetFields.has(field) ? Number(input.value) : input.value;
      syncJsonFromAssets();
      saveStoredState();
    });
  });

  els.assetTable.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      assets.splice(Number(button.dataset.remove), 1);
      renderAssetTable();
      syncJsonFromAssets();
      saveStoredState();
    });
  });
}

function renderOneOffs() {
  if (!oneOffExpenses.length) {
    els.oneOffList.innerHTML = `<p class="empty-state">No one-off expenses.</p>`;
    return;
  }

  els.oneOffList.innerHTML = oneOffExpenses.map((expense, index) => `
    <div class="one-off-item">
      <div>
        <strong>${escapeHtml(expense.name)}</strong>
        <span>Years ${expense.startYear}-${expense.endYear}, ${moneyFormatter.format(expense.amount)}, ${expense.inflationAdjusted ? "inflation adjusted" : "fixed"}</span>
      </div>
      <button type="button" data-remove-one-off="${index}">Remove</button>
    </div>
  `).join("");

  els.oneOffList.querySelectorAll("[data-remove-one-off]").forEach((button) => {
    button.addEventListener("click", () => {
      oneOffExpenses.splice(Number(button.dataset.removeOneOff), 1);
      renderOneOffs();
      saveStoredState();
    });
  });
}

function drawTimeline() {
  const years = activeYears();
  const svg = els.timelineSvg;
  clearSvg(svg, 860, 320);
  const width = 860;
  const height = 320;
  const margin = { top: 28, right: 28, bottom: 42, left: 78 };
  const values = years.map((year) => adjustAmount(year.endingPortfolioValue, year));
  const taxes = years.map((year) => adjustAmount(year.taxes.totalTax, year));
  const maxValue = Math.max(...values, ...taxes, 1);
  const minValue = Math.min(...values, 0);
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const x = (index) => margin.left + (index / Math.max(1, years.length - 1)) * plotW;
  const y = (value) => height - margin.bottom - ((value - minValue) / (maxValue - minValue || 1)) * plotH;

  drawGrid(svg, width, height, margin, maxValue);

  // Area fill under portfolio line
  if (values.length > 0) {
    const areaPoints = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    const baseline = height - margin.bottom;
    svg.append(svgEl("polygon", {
      points: `${x(0)},${baseline} ${areaPoints} ${x(values.length - 1)},${baseline}`,
      fill: "rgba(52,209,182,0.08)"
    }));
  }

  svg.append(pathElement(values.map((value, index) => [x(index), y(value)]), "#34d1b6", 2.5));
  svg.append(pathElement(taxes.map((value, index) => [x(index), y(value)]), "#f06060", 2));

  // Legend
  svg.append(svgEl("text", { x: margin.left, y: 20, class: "chart-label" }, activePathLabel()));
  svg.append(svgEl("circle", { cx: width - 208, cy: 18, r: 5, fill: "#34d1b6" }));
  svg.append(svgEl("text", { x: width - 196, y: 22, class: "chart-label" }, "End value"));
  svg.append(svgEl("circle", { cx: width - 108, cy: 18, r: 5, fill: "#f06060" }));
  svg.append(svgEl("text", { x: width - 96, y: 22, class: "chart-label" }, "Tax"));

  // ── Interactive hover overlay ──
  if (!years.length) return;

  // Crosshair line
  const crosshair = svgEl("line", {
    x1: 0, x2: 0, y1: margin.top, y2: height - margin.bottom,
    stroke: "rgba(255,255,255,0.2)", "stroke-width": 1, "stroke-dasharray": "4,3",
    "pointer-events": "none", visibility: "hidden"
  });
  svg.append(crosshair);

  // Highlight dots
  const dotValue = svgEl("circle", { r: 5, fill: "#34d1b6", stroke: "#0c1018", "stroke-width": 2, "pointer-events": "none", visibility: "hidden" });
  const dotTax = svgEl("circle", { r: 4, fill: "#f06060", stroke: "#0c1018", "stroke-width": 2, "pointer-events": "none", visibility: "hidden" });
  svg.append(dotValue);
  svg.append(dotTax);

  // Tooltip (HTML, positioned relative to the SVG's parent)
  let tooltip = svg.parentElement.querySelector(".v2-chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "v2-chart-tooltip";
    svg.parentElement.style.position = "relative";
    svg.parentElement.append(tooltip);
  }
  tooltip.style.display = "none";

  // Invisible rect to capture mouse events
  const overlay = svgEl("rect", {
    x: margin.left, y: margin.top,
    width: plotW, height: plotH,
    fill: "transparent", cursor: "crosshair"
  });
  svg.append(overlay);

  overlay.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const svgX = (e.clientX - rect.left) * (width / rect.width);
    const nearestIdx = Math.round(((svgX - margin.left) / plotW) * Math.max(1, years.length - 1));
    const idx = Math.max(0, Math.min(years.length - 1, nearestIdx));
    const cx = x(idx);

    crosshair.setAttribute("x1", cx);
    crosshair.setAttribute("x2", cx);
    crosshair.setAttribute("visibility", "visible");

    dotValue.setAttribute("cx", cx);
    dotValue.setAttribute("cy", y(values[idx]));
    dotValue.setAttribute("visibility", "visible");
    dotTax.setAttribute("cx", cx);
    dotTax.setAttribute("cy", y(taxes[idx]));
    dotTax.setAttribute("visibility", "visible");

    const yr = years[idx];
    const pctX = (e.clientX - rect.left) / rect.width * 100;
    tooltip.innerHTML = `
      <div class="v2-tt-year">${yr.year}</div>
      <div class="v2-tt-row"><span class="v2-tt-dot" style="background:#34d1b6"></span>Portfolio <strong>${moneyFormatter.format(values[idx])}</strong></div>
      <div class="v2-tt-row"><span class="v2-tt-dot" style="background:#f06060"></span>Tax <strong>${moneyFormatter.format(taxes[idx])}</strong></div>
      <div class="v2-tt-row v2-tt-muted">Spend ${moneyFormatter.format(adjustAmount(yr.plannedSpending, yr))}</div>
    `;
    tooltip.style.display = "block";
    tooltip.style.top = `${(e.clientY - rect.top) - 80}px`;
    tooltip.style.left = pctX > 70 ? `${(e.clientX - rect.left) - tooltip.offsetWidth - 16}px` : `${(e.clientX - rect.left) + 16}px`;
  });

  overlay.addEventListener("mouseleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    dotValue.setAttribute("visibility", "hidden");
    dotTax.setAttribute("visibility", "hidden");
    tooltip.style.display = "none";
  });

  // Click to select year
  overlay.addEventListener("click", (e) => {
    const rect = svg.getBoundingClientRect();
    const svgX = (e.clientX - rect.left) * (width / rect.width);
    const nearestIdx = Math.round(((svgX - margin.left) / plotW) * Math.max(1, years.length - 1));
    const idx = Math.max(0, Math.min(years.length - 1, nearestIdx));
    selectedYearIndex = idx;
    els.yearRange.value = String(idx + 1);
    renderKpis();
    renderFlowAndSales();
    renderYearTable();
    renderAssetBreakdown();
    renderYearLabel();
  });
}

function activePathLabel() {
  if (selectedBacktestIndex != null) {
    const backtest = latest.backtests[selectedBacktestIndex];
    return backtest ? `Backtest ${backtest.id}` : "Historical backtest";
  }
  const selectedScenario = latest.monteCarlo.scenarios.find((scenario) => scenario.id === selectedScenarioId);
  return selectedScenario ? `Monte Carlo run ${selectedScenario.id}` : "Baseline mean path";
}

function drawDistribution() {
  const svg = els.distributionSvg;
  clearSvg(svg, 860, 320);
  const width = 860;
  const height = 320;
  const margin = { top: 28, right: 28, bottom: 52, left: 60 };
  const scenarios = latest.monteCarlo.scenarios;
  const values = scenarios.map((s) => adjustAmount(s.endingValue, s.years.at(-1)));
  const sorted = [...values].sort((a, b) => a - b);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const binCount = 20;
  const binWidth = (max - min) / binCount || 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    low: min + i * binWidth,
    high: min + (i + 1) * binWidth,
    count: 0,
    scenarios: []
  }));
  for (let vi = 0; vi < values.length; vi++) {
    const idx = Math.min(binCount - 1, Math.floor(((values[vi] - min) / (max - min || 1)) * binCount));
    bins[idx].count += 1;
    bins[idx].scenarios.push(scenarios[vi]);
  }
  const maxBin = Math.max(...bins.map(b => b.count), 1);
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  // Percentiles
  const pct = (p) => sorted[Math.floor(p * sorted.length)] ?? 0;
  const p10 = pct(0.1), median = pct(0.5), p90 = pct(0.9);
  const xScale = (v) => margin.left + ((v - min) / (max - min || 1)) * plotW;

  // Tooltip
  let tooltip = svg.parentElement.querySelector(".v2-chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "v2-chart-tooltip";
    svg.parentElement.style.position = "relative";
    svg.parentElement.append(tooltip);
  }
  tooltip.style.display = "none";

  // Draw bars
  bins.forEach((bin, index) => {
    const barW = plotW / binCount - 2;
    const barH = (bin.count / maxBin) * plotH;
    const bx = margin.left + index * (plotW / binCount) + 1;
    const by = height - margin.bottom - barH;
    const failRate = bin.scenarios.filter(s => !s.success).length / Math.max(1, bin.count);
    const color = failRate > 0.5 ? "#f06060" : failRate > 0.1 ? "#f0a848" : "#34d1b6";
    const bar = svgEl("rect", {
      x: bx, y: by, width: barW, height: Math.max(0, barH),
      rx: 3, fill: color, opacity: 0.72,
      class: "v2-dist-bar", cursor: "pointer"
    });

    bar.addEventListener("mouseenter", (e) => {
      bar.setAttribute("opacity", "1");
      const rect = svg.getBoundingClientRect();
      const successes = bin.scenarios.filter(s => s.success).length;
      tooltip.innerHTML = `
        <div class="v2-tt-year">${moneyFormatter.format(bin.low)} – ${moneyFormatter.format(bin.high)}</div>
        <div class="v2-tt-row"><strong>${bin.count}</strong> scenarios (${Math.round(bin.count / values.length * 100)}%)</div>
        <div class="v2-tt-row">${successes} succeeded, ${bin.count - successes} failed</div>
      `;
      tooltip.style.display = "block";
      const pctX = (e.clientX - rect.left) / rect.width * 100;
      tooltip.style.top = `${(e.clientY - rect.top) - 70}px`;
      tooltip.style.left = pctX > 70 ? `${(e.clientX - rect.left) - tooltip.offsetWidth - 12}px` : `${(e.clientX - rect.left) + 12}px`;
    });
    bar.addEventListener("mouseleave", () => {
      bar.setAttribute("opacity", "0.72");
      tooltip.style.display = "none";
    });
    svg.append(bar);
  });

  // Percentile lines
  const drawPctLine = (value, label, color) => {
    const lx = xScale(value);
    svg.append(svgEl("line", {
      x1: lx, x2: lx, y1: margin.top, y2: height - margin.bottom,
      stroke: color, "stroke-width": 1.5, "stroke-dasharray": "6,4", opacity: 0.7
    }));
    svg.append(svgEl("text", {
      x: lx, y: margin.top - 6, "text-anchor": "middle",
      fill: color, "font-size": 10, "font-weight": 700,
      "font-family": "'Inter', sans-serif"
    }, label));
    svg.append(svgEl("text", {
      x: lx, y: margin.top + 10, "text-anchor": "middle",
      fill: color, "font-size": 9, "font-weight": 600,
      "font-family": "'JetBrains Mono', monospace"
    }, compactMoney(value)));
  };
  drawPctLine(p10, "P10", "#f06060");
  drawPctLine(median, "Median", "#56c8e8");
  drawPctLine(p90, "P90", "#34d1b6");

  // Header
  const summary = latest.monteCarlo.summary;
  svg.append(svgEl("text", { x: margin.left, y: 20, class: "chart-label" },
    `${summary.runs} scenarios · ${Math.round(summary.successRate * 100)}% success`));

  // X-axis labels
  svg.append(svgEl("text", { x: margin.left, y: height - 8, class: "axis-label" }, moneyFormatter.format(min)));
  svg.append(svgEl("text", { x: width - margin.right, y: height - 8, "text-anchor": "end", class: "axis-label" }, moneyFormatter.format(max)));
  svg.append(svgEl("text", { x: width / 2, y: height - 8, "text-anchor": "middle", class: "axis-label", "font-size": 10 }, "Ending Portfolio Value"));

  // Color legend
  svg.append(svgEl("rect", { x: width - 220, y: height - 48, width: 8, height: 8, rx: 2, fill: "#34d1b6" }));
  svg.append(svgEl("text", { x: width - 208, y: height - 41, class: "axis-label", "font-size": 9 }, "Mostly succeed"));
  svg.append(svgEl("rect", { x: width - 220, y: height - 34, width: 8, height: 8, rx: 2, fill: "#f0a848" }));
  svg.append(svgEl("text", { x: width - 208, y: height - 27, class: "axis-label", "font-size": 9 }, "Mixed"));
  svg.append(svgEl("rect", { x: width - 220, y: height - 20, width: 8, height: 8, rx: 2, fill: "#f06060" }));
  svg.append(svgEl("text", { x: width - 208, y: height - 13, class: "axis-label", "font-size": 9 }, "Mostly fail"));
}

function drawSankey(svg, rawFlows, nodeDetails = {}) {
  clearSvg(svg, 1280, 700);
  const W = 1280, H = 700;
  const pad = { t: 40, r: 200, b: 36, l: 200 };
  const flows = rawFlows.filter(f => f.amount > 1);

  // Background
  svg.append(svgEl("rect", { x: 0, y: 0, width: W, height: H, rx: 14, fill: "#0c1018" }));
  // Subtle grid dots
  for (let gx = pad.l; gx < W - pad.r; gx += 60) {
    for (let gy = pad.t; gy < H - pad.b; gy += 60) {
      svg.append(svgEl("circle", { cx: gx, cy: gy, r: 0.6, fill: "rgba(255,255,255,0.04)" }));
    }
  }

  if (!flows.length) {
    svg.append(svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: "#5c6478", "font-size": 15 }, "No cash flows for this view."));
    return;
  }

  const defs = svgEl("defs", {});
  svg.append(defs);

  // ── Build node graph ──
  const nodes = new Map();
  for (const f of flows) {
    if (!nodes.has(f.from)) nodes.set(f.from, { id: f.from, totalIn: 0, totalOut: 0, parents: [], flowTypes: new Set() });
    if (!nodes.has(f.to))   nodes.set(f.to,   { id: f.to,   totalIn: 0, totalOut: 0, parents: [], flowTypes: new Set() });
    nodes.get(f.from).totalOut += f.amount;
    nodes.get(f.from).flowTypes.add(f.type);
    nodes.get(f.to).totalIn += f.amount;
    nodes.get(f.to).flowTypes.add(f.type);
    nodes.get(f.to).parents.push(f.from);
  }

  // Assign depths
  const dCache = new Map();
  const depth = (id, seen = new Set()) => {
    if (dCache.has(id)) return dCache.get(id);
    const n = nodes.get(id);
    if (!n || !n.parents.length || seen.has(id)) return 0;
    seen = new Set(seen); seen.add(id);
    const d = 1 + Math.max(...n.parents.map(p => depth(p, seen)));
    dCache.set(id, d);
    return d;
  };
  for (const n of nodes.values()) n.depth = depth(n.id);
  const maxD = Math.max(...[...nodes.values()].map(n => n.depth), 1);
  for (const n of nodes.values()) {
    if (n.totalOut <= 0) n.depth = maxD;
  }

  // Group into columns
  const cols = new Map();
  for (const n of nodes.values()) {
    const c = cols.get(n.depth) ?? [];
    c.push(n);
    cols.set(n.depth, c);
  }

  // ── Layout nodes ──
  const nW = 8; // slim node bar
  const plotH = H - pad.t - pad.b;
  const plotW = W - pad.l - pad.r - nW;

  for (const [d, col] of cols.entries()) {
    const layout = sankeyColumnLayout(col, plotH, (n) => Math.max(n.totalIn, n.totalOut));
    let cy = pad.t + layout.offsetTop;
    for (const [index, n] of layout.nodes.entries()) {
      const total = Math.max(n.totalIn, n.totalOut);
      n.x = pad.l + (d / maxD) * plotW;
      n.h = layout.heights[index];
      n.y = cy;
      n.scale = n.h / Math.max(1, total);
      n.srcOff = 0;
      n.tgtOff = 0;
      cy += n.h + layout.gap;
    }
  }

  // ── Node color by dominant flow type ──
  const nodeColor = (n) => {
    const types = n.flowTypes;
    if (types.has("tax") || types.has("tax-source") || types.has("penalty")) return ["#f06060", "#c04848"];
    if (types.has("medical"))   return ["#f0a848", "#c88030"];
    if (types.has("spending"))  return ["#8892a8", "#6a7288"];
    if (types.has("conversion"))return ["#a8d060", "#80a840"];
    if (types.has("withdrawal"))return ["#34d1b6", "#1a8a76"];
    if (types.has("income"))    return ["#56c8e8", "#3898b8"];
    if (types.has("loss"))      return ["#7c6cf0", "#5a4cc0"];
    return ["#5b8def", "#3868c0"]; // balance
  };

  // Sort flows for consistent layering
  const sorted = [...flows].sort((a, b) => {
    const sd = nodes.get(a.from).y - nodes.get(b.from).y;
    if (Math.abs(sd) > 1) return sd;
    return nodes.get(a.to).y - nodes.get(b.to).y;
  });

  // ── Ribbon group for hover interactions ──
  const ribbonGroup = svgEl("g", { class: "sankey-ribbons" });
  svg.append(ribbonGroup);
  const nodeGroup = svgEl("g", { class: "sankey-nodes" });
  svg.append(nodeGroup);
  const labelGroup = svgEl("g", { class: "sankey-labels" });
  svg.append(labelGroup);

  // ── Draw filled ribbons ──
  sorted.forEach((f, fi) => {
    const src = nodes.get(f.from);
    const tgt = nodes.get(f.to);
    const sx = src.x + nW;
    const tx = tgt.x;
    const sH = Math.max(3, f.amount * src.scale);
    const tH = Math.max(3, f.amount * tgt.scale);
    const sy0 = src.y + src.srcOff;
    const sy1 = sy0 + sH;
    const ty0 = tgt.y + tgt.tgtOff;
    const ty1 = ty0 + tH;
    src.srcOff += sH;
    tgt.tgtOff += tH;

    const mx = (sx + tx) / 2;
    // Filled area ribbon using two cubic beziers
    const d = [
      `M ${sx} ${sy0}`,
      `C ${mx} ${sy0}, ${mx} ${ty0}, ${tx} ${ty0}`,
      `L ${tx} ${ty1}`,
      `C ${mx} ${ty1}, ${mx} ${sy1}, ${sx} ${sy1}`,
      `Z`
    ].join(" ");

    // Gradient from source color to target color
    const gid = `rg${fi}`;
    const [sc] = nodeColor(src);
    const [tc] = nodeColor(tgt);
    const gr = svgEl("linearGradient", { id: gid, x1: "0%", y1: "0%", x2: "100%", y2: "0%" });
    gr.append(svgEl("stop", { offset: "0%", "stop-color": sc, "stop-opacity": "0.45" }));
    gr.append(svgEl("stop", { offset: "100%", "stop-color": tc, "stop-opacity": "0.3" }));
    defs.append(gr);

    const ribbon = svgEl("path", {
      d,
      fill: `url(#${gid})`,
      class: "v2-ribbon",
      "data-from": f.from,
      "data-to": f.to,
      "data-flow-type": f.type
    });
    ribbon.append(svgEl("title", {}, `${f.from} → ${f.to}\n${moneyFormatter.format(f.amount)}`));
    ribbonGroup.append(ribbon);
  });

  // ── Draw nodes as colored rounded bars ──
  for (const n of nodes.values()) {
    const [c1, c2] = nodeColor(n);
    const ngid = `ng_${n.id.replace(/\W/g, "_")}`;
    const ng = svgEl("linearGradient", { id: ngid, x1: "0%", y1: "0%", x2: "0%", y2: "100%" });
    ng.append(svgEl("stop", { offset: "0%", "stop-color": c1, "stop-opacity": "0.95" }));
    ng.append(svgEl("stop", { offset: "100%", "stop-color": c2, "stop-opacity": "0.8" }));
    defs.append(ng);

    // Glow
    nodeGroup.append(svgEl("rect", {
      x: n.x - 3, y: n.y - 1, width: nW + 6, height: n.h + 2,
      rx: 6, fill: c1, opacity: 0.08, "pointer-events": "none"
    }));
    // Bar
    const bar = svgEl("rect", {
      x: n.x, y: n.y, width: nW, height: n.h,
      rx: 4, fill: `url(#${ngid})`,
      class: "v2-node",
      "data-node-id": n.id
    });
    const nodeTitle = nodeDetails[n.id] ?? `${n.id}\n${moneyFormatter.format(Math.max(n.totalIn, n.totalOut))}`;
    bar.append(svgEl("title", {}, nodeTitle));
    nodeGroup.append(bar);

    // Labels
    const isRight = n.depth >= maxD;
    const lx = isRight ? n.x - 10 : n.x + nW + 10;
    const anchor = isRight ? "end" : "start";
    const ly = n.y + n.h / 2;

    // Name
    const nameEl = svgEl("text", {
      x: lx, y: ly - 1, "text-anchor": anchor,
      fill: "#e8ecf4", "font-size": 13, "font-weight": 700,
      class: "v2-node-name"
    }, n.id);
    nameEl.append(svgEl("title", {}, nodeTitle));
    labelGroup.append(nameEl);

    // Value badge
    const val = moneyFormatter.format(Math.max(n.totalIn, n.totalOut));
    const badgeY = ly + 15;
    const badge = svgEl("text", {
      x: lx, y: badgeY, "text-anchor": anchor,
      fill: c1, "font-size": 11, "font-weight": 600,
      "font-family": "'JetBrains Mono', monospace",
      class: "v2-node-value"
    }, val);
    badge.append(svgEl("title", {}, nodeTitle));
    labelGroup.append(badge);
  }

  // ── Hover interactions ──
  svg.querySelectorAll(".v2-ribbon").forEach(ribbon => {
    ribbon.addEventListener("mouseenter", () => {
      svg.querySelectorAll(".v2-ribbon").forEach(r => {
        r.style.opacity = r === ribbon ? "1" : "0.12";
        r.style.transition = "opacity 0.2s";
      });
    });
    ribbon.addEventListener("mouseleave", () => {
      svg.querySelectorAll(".v2-ribbon").forEach(r => {
        r.style.opacity = "";
        r.style.transition = "opacity 0.3s";
      });
    });
  });

  svg.querySelectorAll(".v2-node").forEach(bar => {
    bar.style.cursor = "pointer";
    bar.addEventListener("mouseenter", () => {
      const id = bar.getAttribute("data-node-id");
      svg.querySelectorAll(".v2-ribbon").forEach(r => {
        const match = r.getAttribute("data-from") === id || r.getAttribute("data-to") === id;
        r.style.opacity = match ? "1" : "0.08";
        r.style.transition = "opacity 0.2s";
      });
    });
    bar.addEventListener("mouseleave", () => {
      svg.querySelectorAll(".v2-ribbon").forEach(r => {
        r.style.opacity = "";
        r.style.transition = "opacity 0.3s";
      });
    });
  });
}

function sankeyColumnLayout(column, plotHeight, valueOf) {
  const nodes = column.sort((a, b) => valueOf(b) - valueOf(a));
  const count = nodes.length;
  const gap = count <= 1 ? 0 : Math.max(4, Math.min(16, (plotHeight / (count + 1)) * 0.1));
  const totalGap = gap * Math.max(0, count - 1);
  const available = Math.max(count * 2, plotHeight - totalGap);
  const total = nodes.reduce((sum, node) => sum + valueOf(node), 0) || 1;
  const fillRatio = count === 1 ? 0.78 : count === 2 ? 0.9 : 0.96;
  const targetHeight = available * fillRatio;
  const minHeight = Math.max(2, Math.min(10, targetHeight / Math.max(1, count)));
  let heights = nodes.map((node) => Math.max(minHeight, (valueOf(node) / total) * targetHeight));
  let heightTotal = heights.reduce((sum, height) => sum + height, 0);

  if (heightTotal > available) {
    const scale = available / heightTotal;
    heights = heights.map((height) => height * scale);
    heightTotal = heights.reduce((sum, height) => sum + height, 0);
  }

  return {
    nodes,
    heights,
    gap,
    offsetTop: Math.max(0, (plotHeight - totalGap - heightTotal) / 2)
  };
}

function flowsForYear(year) {
  if (!year) return [];
  return year.flows.map((flow) => ({
    ...flow,
    amount: adjustAmount(flow.amount, year)
  }));
}

function sankeyNodeDetailsForYear(year) {
  if (!year) return {};
  const details = {};
  const taxableSales = (year.sales ?? []).filter((sale) => sale.accountType === "taxable" && (sale.proceeds ?? 0) > 1);
  if (taxableSales.length) {
    const total = taxableSales.reduce((sum, sale) => sum + (sale.proceeds ?? 0), 0);
    details["Taxable account sales"] = [
      `Taxable account sales: ${money(total, year)}`,
      ...taxableSales.map((sale) => `${sale.name}: ${money(sale.proceeds, year)} proceeds, ${money(sale.gain ?? 0, year)} gain/loss`)
    ].join("\n");
  }

  const taxableDividends = year.taxableDividendDetails ?? [];
  if (taxableDividends.length) {
    const total = taxableDividends.reduce((sum, item) => sum + (item.dividend ?? 0), 0);
    details["Taxable account dividends"] = [
      `Taxable account dividends: ${money(total, year)}`,
      ...taxableDividends.map((item) => `${item.name}: ${money(item.dividend, year)} dividends (${money(item.qualifiedDividends ?? 0, year)} qualified, ${money(item.ordinaryDividends ?? 0, year)} ordinary)`)
    ].join("\n");
  }

  const rothBasisSales = (year.sales ?? []).filter((sale) => (sale.rothBasisUsed ?? 0) > 1);
  if (rothBasisSales.length) {
    const total = rothBasisSales.reduce((sum, sale) => sum + (sale.rothBasisUsed ?? 0), 0);
    details["Roth basis used"] = [
      `Roth basis used: ${money(total, year)}`,
      ...rothBasisSales.map((sale) => `${sale.name}: ${money(sale.rothBasisUsed ?? 0, year)} basis from ${money(sale.proceeds ?? 0, year)} withdrawn`),
      `Roth basis left: ${money(year.rothBasisRemaining ?? 0, year)}`
    ].join("\n");
  }

  const taxDetails = taxPaymentNodeDetails(year);
  if (taxDetails) details["Tax payment"] = taxDetails;

  return details;
}

function taxPaymentNodeDetails(year) {
  const taxes = year?.taxes;
  if (!taxes || !((taxes.totalTax ?? 0) > 0)) return "";
  const penalty = taxes.penaltyTax ?? 0;
  const taxPayment = Math.max(0, (taxes.totalTax ?? 0) - penalty);
  const lines = [
    `Tax payment: ${money(taxPayment, year)}`,
    `State tax: ${money(taxes.stateTax ?? 0, year)}`,
    `Regular federal income brackets: ${money(taxes.federalOrdinaryTax ?? 0, year)}`,
    ...taxBracketDetailLines(taxes.federalOrdinaryBracketDetails, year, "ordinary"),
    `Capital gains / qualified dividends: ${money(taxes.federalPreferentialTax ?? 0, year)}`,
    ...taxBracketDetailLines(taxes.federalPreferentialBracketDetails, year, "capital gains"),
    `NIIT: ${money(taxes.niitTax ?? 0, year)}`
  ];
  if ((taxes.federalCreditsUsed ?? 0) > 0) {
    lines.push(`Federal credits used: -${money(taxes.federalCreditsUsed, year)}`);
  }
  if (penalty > 0) {
    lines.push(`Early withdrawal penalties are shown separately: ${money(penalty, year)}`);
  }
  return lines.join("\n");
}

function taxBracketDetailLines(details = [], year, label) {
  if (!details?.length) return [`  No ${label} taxable income in brackets.`];
  return details.map((bracket) => (
    `  ${percentFormatter.format(bracket.rate ?? 0)} ${label}: ${money(bracket.taxableIncome ?? 0, year)} taxed -> ${money(bracket.tax ?? 0, year)}`
  ));
}

function portfolioFlowsForYear(year) {
  if (!year) return [];
  const beginning = adjustAmount(year.beginningPortfolioValue ?? 0, year);
  const ending = adjustAmount(year.endingPortfolioValue ?? 0, year);
  const withdrawals = adjustAmount(year.cashRaised ?? 0, year);
  const dividends = adjustAmount(year.taxableDividendsCash ?? 0, year);
  const socialSecurity = adjustAmount(year.socialSecurityBenefits ?? 0, year);
  const unspent = adjustAmount(year.unspentCash ?? 0, year);
  const spending = adjustAmount(year.plannedSpending ?? 0, year);
  const medical = adjustAmount(year.medicalCost ?? 0, year);
  const penalties = adjustAmount(year.penaltyTax ?? 0, year);
  const taxes = adjustAmount(Math.max(0, (year.taxes?.totalTax ?? 0) - (year.penaltyTax ?? 0)), year);
  const totalReturn = ending + withdrawals - beginning - unspent;
  const marketGains = Math.max(0, totalReturn);
  const marketLosses = Math.max(0, -totalReturn);
  const reserveInflow = withdrawals + dividends + socialSecurity;
  const reserveOutflow = spending + medical + taxes + penalties;
  const flows = [
    { from: "Starting balance", to: "Portfolio after returns", amount: beginning, type: "balance" }
  ];

  if (marketGains > 0) flows.push({ from: "Market gains", to: "Portfolio after returns", amount: marketGains, type: "income" });
  if (marketLosses > 0) flows.push({ from: "Portfolio after returns", to: "Market losses", amount: marketLosses, type: "loss" });
  if (withdrawals > 0) flows.push({ from: "Portfolio after returns", to: "Yearly cash flow", amount: withdrawals, type: "withdrawal" });
  if (dividends > 0) flows.push({ from: "Taxable dividends", to: "Yearly cash flow", amount: dividends, type: "income" });
  if (socialSecurity > 0) flows.push({ from: "Social Security", to: "Yearly cash flow", amount: socialSecurity, type: "income" });
  if (spending > 0) flows.push({ from: "Yearly cash flow", to: "Lifestyle spending", amount: spending, type: "spending" });
  if (medical > 0) flows.push({ from: "Yearly cash flow", to: "Medical", amount: medical, type: "medical" });
  if (taxes > 0) flows.push({ from: "Yearly cash flow", to: "Tax payment", amount: taxes, type: "tax" });
  if (penalties > 0) {
    flows.push({ from: "Yearly cash flow", to: "Early withdrawal penalties", amount: penalties, type: "penalty" });
  }
  if (unspent > 1) {
    flows.push({ from: "Yearly cash flow", to: "Taxable cash reserve", amount: unspent, type: "balance" });
  } else if (reserveOutflow > reserveInflow + 1) {
    flows.push({ from: "Unfunded cash need", to: "Yearly cash flow", amount: reserveOutflow - reserveInflow, type: "loss" });
  }
  flows.push({ from: "Portfolio after returns", to: "Ending balance", amount: ending, type: "balance" });

  return flows;
}

function readScenario() {
  const taxYear = Number(els.taxYear.value) || 2026;
  const state = els.stateSelect.value || "Florida";
  const householdSize = clampInteger(Number(els.householdSize.value), 1, 12);
  const marketplaceMembers = clampInteger(Number(els.marketplaceMembers.value), 1, 12);
  const currentAge = Number(els.currentAge.value) || DEFAULT_SCENARIO.currentAge;
  const spouseAge = numberOrNull(els.spouseAge.value) ?? currentAge;
  const planCostMode = els.acaPlanCostMode.value === "selectedPlan" ? "selectedPlan" : "stateBenchmark";
  const explicitMemberAges = numberList(els.acaMemberAges.value);
  const memberAges = acaMemberAgesForScenario({
    explicitMemberAges,
    marketplaceMembers,
    currentAge,
    spouseAge
  });
  const benchmarkMonthlyPremium = numberOrNull(els.acaBenchmarkMonthlyPremium.value);
  const benchmarkPremiumOverride = benchmarkMonthlyPremium == null
    ? numberOrNull(els.acaPremium.value)
    : benchmarkMonthlyPremium * 12;
  const selectedPlanMonthlyPremium = numberOrNull(els.acaSelectedPlanMonthlyPremium.value);
  const selectedPlanPremiumOverride = selectedPlanMonthlyPremium == null
    ? null
    : selectedPlanMonthlyPremium * 12;
  const selectedPlanOopMaximumOverride = numberOrNull(els.oopMaxOverride.value);
  const premiumInputMode = els.acaPremiumInputMode.value === "net" ? "net" : "gross";
  const backupMonthlyPremium = numberOrNull(els.acaBackupMonthlyPremium.value);
  const backupPlanPremiumOverride = backupMonthlyPremium == null ? null : backupMonthlyPremium * 12;
  const backupBenchmarkMonthlyPremium = numberOrNull(els.acaBackupBenchmarkMonthlyPremium.value);
  const backupPlanBenchmarkPremiumOverride = backupBenchmarkMonthlyPremium == null
    ? null
    : backupBenchmarkMonthlyPremium * 12;
  const backupPlanOopMaximumOverride = numberOrNull(els.acaBackupOopMax.value);
  const backupPlanPremiumInputMode = els.acaBackupPremiumInputMode.value === "net" ? "net" : "gross";
  const backupTriggerFplPercent = numberOrNull(els.acaBackupTriggerFplPercent.value);
  const backupPlanName = String(els.acaBackupPlanName.value || "").trim();
  const hasBackupPlanInputs = backupPlanPremiumOverride != null
    || backupPlanBenchmarkPremiumOverride != null
    || backupPlanOopMaximumOverride != null
    || backupPlanName;

  if (els.acaEnabled.checked && planCostMode === "selectedPlan") {
    if (premiumInputMode === "gross" && benchmarkPremiumOverride == null) {
      throw new Error("Exact ACA plan mode requires the household SLCSP monthly premium.");
    }
    if (selectedPlanPremiumOverride == null) {
      throw new Error("Exact ACA plan mode requires the selected plan monthly premium.");
    }
    if (selectedPlanOopMaximumOverride == null) {
      throw new Error("Exact ACA plan mode requires the selected plan OOP max.");
    }
    if (marketplaceMembers > 2 && explicitMemberAges.length < marketplaceMembers) {
      throw new Error("Exact ACA plan mode requires one marketplace member age per covered member.");
    }
  }
  if (els.acaEnabled.checked && hasBackupPlanInputs) {
    if (backupPlanPremiumOverride == null) {
      throw new Error("ACA backup plan requires a backup monthly premium.");
    }
    if (backupPlanOopMaximumOverride == null) {
      throw new Error("ACA backup plan requires a backup OOP max.");
    }
  }

  const aca = buildAcaConfig({
    enabled: els.acaEnabled.checked,
    taxYear,
    state,
    householdSize,
    marketplaceMembers,
    currentAge,
    memberAges,
    planCostMode,
    premiumInputMode,
    ageRateManualPremiums: els.acaAgeRateManualPremiums.checked,
    benchmarkPremiumOverride,
    selectedPlanPremiumOverride,
    selectedPlanOopMaximumOverride,
    backupPlanPremiumOverride,
    backupPlanBenchmarkPremiumOverride,
    backupPlanOopMaximumOverride,
    backupPlanPremiumInputMode,
    backupPlanName,
    backupTriggerFplPercent,
    fplOverride: numberOrNull(els.acaFpl.value)
  });

  return {
    ...DEFAULT_SCENARIO,
    taxYear,
    state,
    filingStatus: els.filingStatus.value,
    householdSize,
    marketplaceMembers,
    currentAge,
    spouseAge,
    retirementPenaltyAge: Number(els.retirementPenaltyAge.value) || DEFAULT_SCENARIO.retirementPenaltyAge,
    rothBasis: Number(els.rothBasis.value) || 0,
    socialSecurityAnnualBenefit: Number(els.socialSecurityAnnualBenefit.value) || 0,
    socialSecurityStartAge: Number(els.socialSecurityStartAge.value) || DEFAULT_SCENARIO.socialSecurityStartAge,
    socialSecurityInflationAdjusted: els.socialSecurityInflationAdjusted.checked,
    rmd: {
      enabled: els.rmdEnabled.checked,
      startAge: numberOrNull(els.rmdStartAge.value)
    },
    medicare: {
      irmaaEnabled: els.irmaaEnabled.checked,
      partBEnrollees: numberOrNull(els.medicarePartBEnrollees.value),
      partDEnrollees: numberOrNull(els.medicarePartDEnrollees.value),
      partDMonthlyPremium: numberOrNull(els.medicarePartDMonthlyPremium.value) ?? 0,
      twoYearsPriorMagi: numberOrNull(els.twoYearsPriorMagi.value),
      priorYearMagi: numberOrNull(els.priorYearMagi.value),
      marriedFilingSeparatelyLivedTogether: els.mfsLivedTogether.checked
    },
    planYears: clampInteger(Number(els.planYears.value), 1, 80),
    targetSpend: Number(els.targetSpend.value) || 0,
    targetSpendIncludesTaxes: els.includeTaxes.checked,
    targetSpendIncludesMedical: els.includeMedical.checked,
    medicalExpensesBase: Number(els.medicalBase.value) || 0,
    expectedOopMaxUsePercent: Math.max(0, Math.min(1, (Number(els.expectedOopPercent.value) || 0) / 100)),
    oopMaxOverride: selectedPlanOopMaximumOverride,
    oneOffExpenses,
    taxLossHarvesting: {
      enabled: els.taxLossHarvesting.checked,
      mode: numberOrNull(els.tlhMax.value) == null ? "auto" : "manual",
      overrideMaxLoss: numberOrNull(els.tlhMax.value)
    },
    taxGainHarvesting: {
      enabled: els.taxGainHarvesting.checked,
      mode: numberOrNull(els.tghMax.value) == null ? "auto" : "manual",
      overrideMaxGain: numberOrNull(els.tghMax.value)
    },
    rothConversion: {
      enabled: els.rothConversion.checked,
      mode: numberOrNull(els.rothAmount.value) == null ? "auto" : "manual",
      overrideAmount: numberOrNull(els.rothAmount.value),
      targetMarginalRate: Math.max(0, (Number(els.rothTargetRate.value) || 12) / 100),
      maxAcaFplPercent: 400
    },
    aca
  };
}

function readTaxProfile() {
  const householdSize = clampInteger(Number(els.householdSize.value), 1, 12);
  const dependentCount = Math.max(0, householdSize - 2);
  const childOverride = numberOrNull(els.qualifyingChildren.value);
  const childAges = numberList(els.childAges.value);
  return buildTaxProfile({
    taxYear: Number(els.taxYear.value) || 2026,
    filingStatus: els.filingStatus.value,
    state: els.stateSelect.value || "Florida",
    dependentCount,
    qualifyingChildren: childOverride == null ? dependentCount : clampInteger(childOverride, 0, 12),
    childAges,
    additionalDeduction: Number(els.additionalFederalDeduction.value) || 0,
    additionalCredits: Number(els.additionalFederalCredits.value) || 0,
    overrideRate: percentOrNull(els.stateTaxRate.value),
    overrideCapitalGainsRate: percentOrNull(els.stateCapitalRate.value),
    separateCapitalGains: els.separateStateGains.checked,
    stateRetirementExclusion: Number(els.stateRetirementExclusion.value) || 0,
    stateSocialSecurityTaxablePercent: numberOrNull(els.stateSocialSecurityTaxablePercent.value)
  });
}

function syncJsonFromAssets() {
  els.assetJson.value = JSON.stringify({ assets }, null, 2);
}

function tableHtml(headers, rows, rowAttrs = () => "") {
  return `
    <table>
      <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map((row, index) => `<tr ${rowAttrs(index)}>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}
      </tbody>
    </table>
  `;
}

function pinnableTableHtml(headers, rows, pinnedSet, alwaysPinned, rowAttrs = () => "") {
  const allPinned = new Set([...alwaysPinned, ...pinnedSet]);
  const originalIndices = headers.map((_, i) => i);
  const pinnedIndices = originalIndices.filter((i) => allPinned.has(headers[i]));
  const unpinnedIndices = originalIndices.filter((i) => !allPinned.has(headers[i]));
  const columnOrder = [...pinnedIndices, ...unpinnedIndices];
  const pinnedCount = pinnedIndices.length;

  const thCells = columnOrder.map((origIdx, visIdx) => {
    const name = headers[origIdx];
    const isPinned = visIdx < pinnedCount;
    const isLast = visIdx === pinnedCount - 1;
    const isLocked = alwaysPinned.includes(name);
    const pinClass = isPinned ? `pinned-col${isLast ? " pinned-col-last" : ""}` : "";
    const btnClass = isLocked ? "pin-toggle is-locked" : (isPinned ? "pin-toggle is-pinned" : "pin-toggle");
    const btnIcon = isLocked ? "🔒" : (isPinned ? "📌" : "📌");
    const btnTitle = isLocked ? "Always pinned" : (isPinned ? `Unpin ${name}` : `Pin ${name}`);
    const btn = `<button type="button" class="${btnClass}" data-pin-header="${escapeAttr(name)}" title="${btnTitle}">${btnIcon}</button>`;
    return `<th class="${pinClass}" data-col-index="${visIdx}">${escapeHtml(name)}${btn}</th>`;
  }).join("");

  const bodyRows = rows.map((row, rowIndex) => {
    const cells = columnOrder.map((origIdx, visIdx) => {
      const isPinned = visIdx < pinnedCount;
      const isLast = visIdx === pinnedCount - 1;
      const pinClass = isPinned ? `pinned-col${isLast ? " pinned-col-last" : ""}` : "";
      return `<td class="${pinClass}" data-col-index="${visIdx}">${row[origIdx]}</td>`;
    }).join("");
    return `<tr ${rowAttrs(rowIndex)}>${cells}</tr>`;
  }).join("");

  return `
    <table>
      <thead><tr>${thCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

function applyPinnedColumnOffsets(container) {
  const table = container.querySelector("table");
  if (!table) return;
  const headerCells = table.querySelectorAll("thead th.pinned-col");
  if (!headerCells.length) return;

  // Measure widths from the header row
  const widths = [];
  headerCells.forEach((th) => widths.push(th.offsetWidth));

  // Compute cumulative left offsets
  const leftOffsets = [];
  let cumulative = 0;
  for (const w of widths) {
    leftOffsets.push(cumulative);
    cumulative += w;
  }

  // Apply to all pinned cells by column index
  for (let i = 0; i < leftOffsets.length; i++) {
    const left = `${leftOffsets[i]}px`;
    table.querySelectorAll(`[data-col-index="${i}"].pinned-col`).forEach((cell) => {
      cell.style.left = left;
    });
  }
}

function bindPinToggles(container, pinnedSet, alwaysPinned, storageKey, rerender) {
  container.querySelectorAll(".pin-toggle:not(.is-locked)").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const headerName = btn.dataset.pinHeader;
      if (alwaysPinned.includes(headerName)) return;
      if (pinnedSet.has(headerName)) {
        pinnedSet.delete(headerName);
      } else {
        pinnedSet.add(headerName);
      }
      savePinnedColumns(storageKey, pinnedSet);
      rerender();
    });
  });
}

function bindResizeObserver(container, tableId) {
  if (container._resizeCleanup) container._resizeCleanup();
  let debounce = null;
  const observer = new ResizeObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const height = container.offsetHeight;
      if (height > 50) saveTableHeight(tableId, height);
    }, 300);
  });
  observer.observe(container);
  container._resizeCleanup = () => observer.disconnect();
}

function aggregateAssetSnapshot(snapshot = []) {
  const assetsByKey = new Map();
  for (const asset of snapshot ?? []) {
    const key = assetGroupKey(asset);
    const existing = assetsByKey.get(key) ?? {
      name: asset.name ?? asset.id,
      accountType: asset.accountType,
      assetClass: asset.assetClass,
      units: 0,
      value: 0,
      costBasis: 0,
      unrealizedGain: 0,
      price: 0
    };
    existing.units += Number(asset.units) || 0;
    existing.value += Number(asset.value) || 0;
    existing.costBasis += Number(asset.costBasis) || 0;
    existing.unrealizedGain += Number(asset.unrealizedGain) || 0;
    existing.price = existing.units > 0 ? existing.value / existing.units : 0;
    assetsByKey.set(key, existing);
  }
  return assetsByKey;
}

function assetGroupKey(asset) {
  return [asset.name ?? asset.id, asset.accountType, asset.assetClass].join("::");
}

function emptyAssetFromKey(key) {
  const [name = "", accountType = "", assetClass = ""] = key.split("::");
  return {
    name,
    accountType,
    assetClass,
    units: 0,
    value: 0,
    costBasis: 0,
    unrealizedGain: 0,
    price: 0
  };
}

function selectHtml(index, field, options, value) {
  return `
    <select data-index="${index}" data-field="${field}">
      ${options.map((option) => `<option value="${option}" ${option === value ? "selected" : ""}>${option}</option>`).join("")}
    </select>
  `;
}

function money(value, year) {
  return moneyFormatter.format(adjustAmount(value, year));
}

function ageLabel(value) {
  const age = Number(value);
  if (!Number.isFinite(age)) return "";
  return Number.isInteger(age) ? String(age) : age.toFixed(1);
}

function signedMoney(value, year) {
  const adjusted = adjustAmount(value, year);
  return `${adjusted > 0 ? "+" : ""}${moneyFormatter.format(adjusted)}`;
}

function signedPercent(value) {
  return `${value > 0 ? "+" : ""}${percentFormatter.format(value)}`;
}

function returnPercent(year, assetClass) {
  const value = year.assetClassReturns?.[assetClass];
  return typeof value === "number" && Number.isFinite(value) ? signedPercent(value) : "n/a";
}

function adjustAmount(value, year) {
  if (!Number.isFinite(Number(value))) return 0;
  if (els.viewMode.value !== "real") return Number(value);
  return Number(value) / Math.max(1, year?.inflationIndex ?? 1);
}

function drawGrid(svg, width, height, margin, maxValue) {
  const gridLines = 4;
  for (let index = 0; index <= gridLines; index += 1) {
    const y = margin.top + (index / gridLines) * (height - margin.top - margin.bottom);
    const value = maxValue * (1 - index / gridLines);
    svg.append(svgEl("line", {
      x1: margin.left,
      x2: width - margin.right,
      y1: y,
      y2: y,
      stroke: "rgba(255,255,255,0.06)",
      "stroke-width": 1
    }));
    svg.append(svgEl("text", { x: 10, y: y + 4, class: "axis-label" }, compactMoney(value)));
  }
}

function pathElement(points, color, width) {
  const d = points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
  return svgEl("path", {
    d,
    fill: "none",
    stroke: color,
    "stroke-width": width,
    "stroke-linejoin": "round",
    "stroke-linecap": "round"
  });
}

function clearSvg(svg, width, height) {
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
}

function svgEl(name, attributes = {}, text = "") {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
  if (text) el.textContent = text;
  return el;
}

function appendHaloText(svg, attributes, text) {
  svg.append(svgEl("text", { ...attributes, class: `${attributes.class} text-halo` }, text));
  svg.append(svgEl("text", attributes, text));
}

function flowColor(type) {
  return {
    balance: "#5b8def",
    income: "#56c8e8",
    withdrawal: "#34d1b6",
    tax: "#f06060",
    "tax-source": "#e87878",
    medical: "#f0a848",
    spending: "#8892a8",
    conversion: "#a8d060",
    penalty: "#d04040",
    loss: "#7c6cf0"
  }[type] ?? "#8892a8";
}

function compactMoney(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${round(value / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `$${round(value / 1_000, 0)}K`;
  return moneyFormatter.format(value);
}

function setStatus(message, isError = false) {
  paintStatus(els.status, message, isError);
}

function setImportStatus(message, isError = false) {
  paintStatus(els.importStatus, message, isError);
}

function paintStatus(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.style.borderColor = isError ? "rgba(240,96,96,0.3)" : "rgba(52,209,182,0.2)";
  element.style.background = isError ? "rgba(240,96,96,0.08)" : "rgba(52,209,182,0.06)";
  element.style.color = isError ? "#f06060" : "#34d1b6";
}

function reportImportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message, true);
  setImportStatus(message, true);
}

function importAssets(importedAssets, message) {
  assets = importedAssets;
  renderAssetTable();
  syncJsonFromAssets();
  saveStoredState();
  const statusMessage = `${message} ${assets.length} assets loaded.`;
  setStatus(statusMessage);
  setImportStatus(statusMessage);
  scrollImportedAssetsIntoView();
}

function scrollImportedAssetsIntoView() {
  if (activeScreen !== "setup") return;
  requestAnimationFrame(() => {
    els.assetTable?.closest(".panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function googleSheetsToken() {
  const now = Date.now();
  if (googleSheetsAccessToken && googleSheetsTokenExpiresAt > now + 60000) {
    return googleSheetsAccessToken;
  }

  await loadGoogleIdentityScript();
  const oauth = window.google?.accounts?.oauth2;
  if (!oauth?.initTokenClient) {
    throw new Error("Google Identity Services did not load. Check your network connection and browser blockers.");
  }

  const clientId = els.googleClientId.value.trim();
  return new Promise((resolve, reject) => {
    const tokenClient = oauth.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_SHEETS_READONLY_SCOPE,
      callback: (response) => {
        if (response?.error) {
          reject(new Error(`Google authorization failed: ${response.error}`));
          return;
        }
        if (!response?.access_token) {
          reject(new Error("Google authorization did not return an access token."));
          return;
        }
        if (!oauth.hasGrantedAllScopes(response, GOOGLE_SHEETS_READONLY_SCOPE)) {
          reject(new Error("Google authorization did not grant Sheets read access."));
          return;
        }
        googleSheetsAccessToken = response.access_token;
        googleSheetsTokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in ?? 0) - 60) * 1000;
        resolve(googleSheetsAccessToken);
      },
      error_callback: (error) => {
        reject(new Error(`Google authorization failed: ${error?.type ?? "popup closed"}`));
      }
    });
    tokenClient.requestAccessToken({ prompt: googleSheetsAccessToken ? "" : "consent" });
  });
}

function loadGoogleIdentityScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  const existing = document.querySelector(`script[src="${GOOGLE_IDENTITY_SCRIPT_URL}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("Google Identity Services failed to load.")), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GOOGLE_IDENTITY_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error("Google Identity Services failed to load.")), { once: true });
    document.head.append(script);
  });
}

async function fetchGoogleSheetRows({ spreadsheetId, range, accessToken }) {
  const endpoint = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  endpoint.searchParams.set("majorDimension", "ROWS");
  endpoint.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      googleSheetsAccessToken = null;
      googleSheetsTokenExpiresAt = 0;
    }
    throw new Error(`Private sheet request failed: ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data.values) || !data.values.length) {
    throw new Error("Private sheet returned no rows for the selected range.");
  }
  return data.values;
}

function clampInteger(value, min, max) {
  return Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));
}

function numberOrNull(value) {
  if (String(value ?? "").trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentOrNull(value) {
  const number = numberOrNull(value);
  return number == null ? null : number / 100;
}

function numberList(value) {
  return String(value ?? "")
    .split(/[\s,;]+/)
    .map((item) => Number(item))
    .filter((number) => Number.isFinite(number));
}

function acaMemberAgesForScenario({
  explicitMemberAges = [],
  marketplaceMembers = 1,
  currentAge = DEFAULT_SCENARIO.currentAge,
  spouseAge = currentAge
} = {}) {
  if (explicitMemberAges.length) return explicitMemberAges.slice(0, marketplaceMembers);

  const ages = [currentAge];
  if (marketplaceMembers > 1) ages.push(spouseAge);
  while (ages.length < marketplaceMembers) ages.push(currentAge);
  return ages.slice(0, marketplaceMembers);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

const numericAssetFields = new Set([
  "units",
  "price",
  "costBasisPerUnit",
  "dividendYield",
  "qualifiedDividendShare"
]);
