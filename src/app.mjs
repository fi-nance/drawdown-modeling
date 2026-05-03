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

initialize();

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
  const rows = years.map((year) => [
    year.year,
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
    money(year.penaltyTax, year),
    money(year.lossCarryforward, year)
  ]);

  els.yearTable.innerHTML = tableHtml(
    ["Year", "Stock", "Bond", "Real estate", "TIPS", "Crypto", "Inflation", "Start value", "End value", "Sales / withdrawals", "Dividends", "Social Security", "RMD", "Total cash", "Total need", "Tax", "Fed income tax", "CG/QD tax", "NIIT", "Credits", "State tax", "MAGI", "Taxable SS", "65+ deduction", "CTC children", "ACA plan", "ACA SLCSP", "ACA gross", "ACA subsidy", "ACA net", "Medicare", "Spend", "Medical", "Tax gain harvest", "Roth conv.", "Penalty", "Loss carry"],
    rows,
    (index) => `data-year-index="${index}" class="${index === selectedYearIndex ? "selected-row" : ""}"`
  );
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

  els.assetBreakdownTable.innerHTML = tableHtml(
    ["Asset", "Account", "Class", "Units", "Price", "Ending value", "Change", "Change %", "Basis", "Unrealized"],
    rows
  );
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
  const x = (index) => margin.left + (index / Math.max(1, years.length - 1)) * (width - margin.left - margin.right);
  const y = (value) => height - margin.bottom - ((value - minValue) / (maxValue - minValue || 1)) * (height - margin.top - margin.bottom);

  drawGrid(svg, width, height, margin, maxValue);
  svg.append(pathElement(values.map((value, index) => [x(index), y(value)]), "#0f766e", 3));
  svg.append(pathElement(taxes.map((value, index) => [x(index), y(value)]), "#c84f43", 2));
  svg.append(svgEl("text", { x: margin.left, y: 20, class: "chart-label" }, activePathLabel()));
  svg.append(svgEl("circle", { cx: width - 208, cy: 18, r: 5, fill: "#0f766e" }));
  svg.append(svgEl("text", { x: width - 196, y: 22, class: "chart-label" }, "End value"));
  svg.append(svgEl("circle", { cx: width - 108, cy: 18, r: 5, fill: "#c84f43" }));
  svg.append(svgEl("text", { x: width - 96, y: 22, class: "chart-label" }, "Tax"));
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
  const margin = { top: 28, right: 28, bottom: 42, left: 60 };
  const values = latest.monteCarlo.scenarios.map((scenario) => adjustAmount(scenario.endingValue, scenario.years.at(-1)));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const binCount = 16;
  const bins = Array.from({ length: binCount }, () => 0);
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor(((value - min) / (max - min || 1)) * binCount));
    bins[index] += 1;
  }
  const maxBin = Math.max(...bins, 1);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  bins.forEach((count, index) => {
    const barWidth = plotWidth / binCount - 4;
    const barHeight = (count / maxBin) * plotHeight;
    const x = margin.left + index * (plotWidth / binCount) + 2;
    const y = height - margin.bottom - barHeight;
    svg.append(svgEl("rect", {
      x,
      y,
      width: barWidth,
      height: barHeight,
      rx: 4,
      fill: index < 3 ? "#c84f43" : index > 11 ? "#0f766e" : "#2f5f98",
      opacity: 0.82
    }));
  });

  svg.append(svgEl("text", { x: margin.left, y: 20, class: "chart-label" }, `${latest.monteCarlo.summary.runs} scenarios`));
  svg.append(svgEl("text", { x: margin.left, y: height - 12, class: "axis-label" }, moneyFormatter.format(min)));
  svg.append(svgEl("text", { x: width - margin.right - 120, y: height - 12, class: "axis-label" }, moneyFormatter.format(max)));
}

function drawSankey(svg, rawFlows, nodeDetails = {}) {
  clearSvg(svg, 1280, 680);
  const width = 1280;
  const height = 680;
  const margin = { top: 54, right: 58, bottom: 48, left: 58 };
  const flows = rawFlows.filter((flow) => flow.amount > 1);
  svg.append(svgEl("rect", {
    x: 0,
    y: 0,
    width,
    height,
    rx: 18,
    class: "sankey-bg"
  }));
  if (!flows.length) {
    svg.append(svgEl("text", { x: margin.left, y: margin.top, class: "chart-label" }, "No cash flows for this view."));
    return;
  }

  const nodes = new Map();
  for (const flow of flows) {
    if (!nodes.has(flow.from)) nodes.set(flow.from, { id: flow.from, in: 0, out: 0, sources: [] });
    if (!nodes.has(flow.to)) nodes.set(flow.to, { id: flow.to, in: 0, out: 0, sources: [] });
    nodes.get(flow.from).out += flow.amount;
    nodes.get(flow.to).in += flow.amount;
    nodes.get(flow.to).sources.push(flow.from);
  }

  const depthCache = new Map();
  const depthOf = (nodeId, seen = new Set()) => {
    if (depthCache.has(nodeId)) return depthCache.get(nodeId);
    const node = nodes.get(nodeId);
    if (!node || !node.sources.length || seen.has(nodeId)) return 0;
    const nextSeen = new Set(seen);
    nextSeen.add(nodeId);
    const depth = 1 + Math.max(...node.sources.map((source) => depthOf(source, nextSeen)));
    depthCache.set(nodeId, depth);
    return depth;
  };

  for (const node of nodes.values()) node.depth = depthOf(node.id);
  const maxDepth = Math.max(...[...nodes.values()].map((node) => node.depth), 1);
  const columns = new Map();
  for (const node of nodes.values()) {
    const column = columns.get(node.depth) ?? [];
    column.push(node);
    columns.set(node.depth, column);
  }

  const nodeWidth = 22;
  const plotHeight = height - margin.top - margin.bottom;
  const plotWidth = width - margin.left - margin.right - nodeWidth;
  for (const [depth, column] of columns.entries()) {
    const layout = sankeyColumnLayout(column, plotHeight, (node) => Math.max(node.in, node.out));
    let cursor = margin.top + layout.offsetTop;
    for (const [index, node] of layout.nodes.entries()) {
      const nodeTotal = Math.max(node.in, node.out);
      node.x = margin.left + (depth / maxDepth) * plotWidth;
      node.h = layout.heights[index];
      node.y = cursor;
      node.linkScale = node.h / Math.max(1, nodeTotal);
      node.sourceOffset = 0;
      node.targetOffset = 0;
      cursor += node.h + layout.gap;
    }
  }

  const orderedFlows = [...flows].sort((a, b) => {
    const sourceDiff = nodes.get(a.from).y - nodes.get(b.from).y;
    if (Math.abs(sourceDiff) > 1) return sourceDiff;
    return nodes.get(a.to).y - nodes.get(b.to).y;
  });

  for (const flow of orderedFlows) {
    const source = nodes.get(flow.from);
    const target = nodes.get(flow.to);
    const sx = source.x + nodeWidth;
    const sourceWidth = Math.max(4, flow.amount * source.linkScale);
    const targetWidth = Math.max(4, flow.amount * target.linkScale);
    const strokeWidth = Math.max(6, Math.min(52, (sourceWidth + targetWidth) / 2));
    const sy = source.y + source.sourceOffset + sourceWidth / 2;
    const tx = target.x;
    const ty = target.y + target.targetOffset + targetWidth / 2;
    source.sourceOffset += sourceWidth;
    target.targetOffset += targetWidth;
    const bend = Math.max(45, (tx - sx) * 0.5);
    const path = svgEl("path", {
      d: `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`,
      class: "sankey-link",
      stroke: flowColor(flow.type),
      "stroke-width": strokeWidth,
      "data-flow-type": flow.type
    });
    path.append(svgEl("title", {}, `${flow.from} to ${flow.to}: ${moneyFormatter.format(flow.amount)}`));
    svg.append(path);
  }

  for (const node of nodes.values()) {
    const nodeTitle = nodeDetails[node.id] ?? `${node.id}\n${moneyFormatter.format(Math.max(node.in, node.out))}`;
    const nodeRect = svgEl("rect", {
      x: node.x,
      y: node.y,
      width: nodeWidth,
      height: node.h,
      rx: 4,
      class: "sankey-node"
    });
    nodeRect.append(svgEl("title", {}, nodeTitle));
    svg.append(nodeRect);
    const labelX = node.depth >= maxDepth ? node.x - 8 : node.x + nodeWidth + 8;
    const anchor = node.depth >= maxDepth ? "end" : "start";
    const nameLabel = appendHaloText(svg, {
      x: labelX,
      y: node.y + node.h / 2 - 2,
      "text-anchor": anchor,
      class: "node-label"
    }, node.id);
    nameLabel.append(svgEl("title", {}, nodeTitle));
    const valueLabel = appendHaloText(svg, {
      x: labelX,
      y: node.y + node.h / 2 + 20,
      "text-anchor": anchor,
      class: "axis-label"
    }, moneyFormatter.format(Math.max(node.in, node.out)));
    valueLabel.append(svgEl("title", {}, nodeTitle));
  }
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

  return details;
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
    { from: "Starting balance", to: "Invested portfolio", amount: beginning, type: "balance" }
  ];

  if (marketGains > 0) flows.push({ from: "Market gains", to: "Invested portfolio", amount: marketGains, type: "income" });
  if (marketLosses > 0) flows.push({ from: "Invested portfolio", to: "Market losses", amount: marketLosses, type: "loss" });
  if (dividends > 0) flows.push({ from: "Invested portfolio", to: "Taxable dividends", amount: dividends, type: "income" });
  if (withdrawals > 0) flows.push({ from: "Invested portfolio", to: "Spending reserve", amount: withdrawals, type: "withdrawal" });
  if (dividends > 0) flows.push({ from: "Taxable dividends", to: "Spending reserve", amount: dividends, type: "income" });
  if (socialSecurity > 0) flows.push({ from: "Social Security", to: "Spending reserve", amount: socialSecurity, type: "income" });
  flows.push({ from: "Invested portfolio", to: "Ending balance", amount: ending, type: "balance" });
  if (spending > 0) flows.push({ from: "Spending reserve", to: "Lifestyle and one-off spending", amount: spending, type: "spending" });
  if (medical > 0) flows.push({ from: "Spending reserve", to: "Medical", amount: medical, type: "medical" });
  if (taxes > 0) flows.push({ from: "Spending reserve", to: "Tax payments", amount: taxes, type: "tax" });
  if (penalties > 0) {
    flows.push({ from: "Spending reserve", to: "Early withdrawal penalties", amount: penalties, type: "penalty" });
  }
  if (unspent > 1) {
    flows.push({ from: "Spending reserve", to: "Taxable cash reserve", amount: unspent, type: "balance" });
  } else if (reserveOutflow > reserveInflow + 1) {
    flows.push({ from: "Unfunded cash need", to: "Spending reserve", amount: reserveOutflow - reserveInflow, type: "loss" });
  }

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
      stroke: "#d7ddd7",
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
  const textEl = svgEl("text", attributes, text);
  svg.append(textEl);
  return textEl;
}

function flowColor(type) {
  return {
    balance: "#355f8d",
    income: "#2f5f98",
    withdrawal: "#0f766e",
    tax: "#c84f43",
    "tax-source": "#d96d5f",
    medical: "#b87516",
    spending: "#4e5b56",
    conversion: "#6a6f2a",
    penalty: "#9b2d25",
    loss: "#6b7280"
  }[type] ?? "#61706b";
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
  element.style.borderColor = isError ? "#d59b94" : "#b7cfc9";
  element.style.background = isError ? "#fff1ef" : "#eaf6f3";
  element.style.color = isError ? "#9b2d25" : "#124f4b";
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
