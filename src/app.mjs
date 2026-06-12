import {
  googleSpreadsheetIdFromInput,
  parsePortfolioCsv,
  parsePortfolioJson,
  parsePortfolioRows,
  toGoogleCsvUrl
} from "./core/importers.mjs";
import { portfolioValue } from "./core/portfolio.mjs";
import { actionConfidenceFor, buildConfidenceReport } from "./core/confidence.mjs";
import { createSetupBackup, parseSetupBackup, SETUP_BACKUP_PRIVACY_NOTICE } from "./core/setupBackup.mjs";
import { cacheLatestResults, clearCachedLatest, restoreCachedLatest } from "./core/resultsCache.mjs";
import { createResultAuditBundle, RESULT_AUDIT_BUNDLE_PRIVACY_NOTICE } from "./core/resultAuditBundle.mjs";
import {
  normalizeUserPlanningSpendingMode,
  validateUserPlanningScenario
} from "./core/planningInputValidation.mjs";
import {
  DEFAULT_MONTE_CARLO_MEAN_REVERSION,
  DEFAULT_SCENARIO,
  MONTE_CARLO_ASSUMPTION_PRESETS,
  runHistoricalBacktests,
  runMonteCarlo,
  simulatePlan,
  generateSingleMonteCarloPath
} from "./core/simulation.mjs?v=20260612-aca-conversions";
import { round } from "./core/utils.mjs";
import { defaultOneOffExpenses, sampleAssets } from "./data/sample.mjs";
import {
  assetClassesInPortfolio,
  DEFAULT_HISTORICAL_DATA_SOURCE,
  historicalCoverageForAssetClasses,
  HISTORICAL_DATA_SOURCE_OPTIONS,
  HISTORICAL_RETURN_DATA_VERSION,
  makeHistoricalSequences
} from "./data/historicalReturns.mjs";
import { buildAcaConfig, buildTaxProfile, STATE_OPTIONS, TAX_DATA_VERSION, getMonthlyBenchmarkPremium } from "./data/taxData.mjs?v=20260612-aca-conversions";
import { massachusettsConnectorCareEstimate, massachusettsConnectorCarePlanOptions } from "./data/acaPlanPresets.mjs";
import {
  buildMarketplacePlanSearchRequest,
  marketplaceApiUrl,
  marketplaceStateCode,
  normalizeMarketplaceCounties,
  normalizeMarketplaceRatingArea,
  normalizeMarketplacePlans,
  secondLowestSilverPlan
} from "./data/marketplaceApi.mjs";
import { resolveZip } from "./data/geo.mjs";
import { isSbeState } from "./data/sbeRatingArea.mjs";

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
const MONTE_CARLO_ASSUMPTION_FIELD_IDS = Object.freeze({
  stock: Object.freeze({ mean: "mcStockMean", stdev: "mcStockStdev" }),
  bond: Object.freeze({ mean: "mcBondMean", stdev: "mcBondStdev" }),
  cash: Object.freeze({ mean: "mcCashMean", stdev: "mcCashStdev" }),
  realEstate: Object.freeze({ mean: "mcRealEstateMean", stdev: "mcRealEstateStdev" }),
  tips: Object.freeze({ mean: "mcTipsMean", stdev: "mcTipsStdev" }),
  crypto: Object.freeze({ mean: "mcCryptoMean", stdev: "mcCryptoStdev" }),
  inflation: Object.freeze({ mean: "mcInflationMean", stdev: "mcInflationStdev" }),
  medicalInflation: Object.freeze({ mean: "mcMedicalInflationMean", stdev: "mcMedicalInflationStdev" })
});
const MONTE_CARLO_PRESET_LABELS = Object.freeze({
  marketNeutral: "market-neutral 2026",
  planning: "conservative planning",
  historical: "historical-fit",
  custom: "custom"
});

const STORAGE_KEY = "portfolio-success-lab:v3";
const REMEMBER_SETUP_KEY = "portfolio-success-lab:remember-setup";
const REDESIGN_STORAGE_KEYS = Object.freeze([
  "psl:redesign:screen",
  "psl:redesign:theme",
  "psl:redesign:persona",
  "psl:redesign:outcome",
  "psl:redesign:detail",
  "psl:redesign:modules",
  "psl:redesign:collapsedModules"
]);
const CONTROL_IDS = [
  "viewMode",
  "planYears",
  "runs",
  "seed",
  "mcPreset",
  "mcSamplingMode",
  "mcShortTermMeanReversion",
  "mcLongTermMeanReversion",
  "mcLongTermReversionYears",
  "mcStockMean",
  "mcStockStdev",
  "mcBondMean",
  "mcBondStdev",
  "mcCashMean",
  "mcCashStdev",
  "mcRealEstateMean",
  "mcRealEstateStdev",
  "mcTipsMean",
  "mcTipsStdev",
  "mcCryptoMean",
  "mcCryptoStdev",
  "mcInflationMean",
  "mcInflationStdev",
  "mcMedicalInflationMean",
  "mcMedicalInflationStdev",
  "targetSpend",
  "decisionRequiredSpend",
  "decisionFlexibleSpend",
  "decisionTargetSuccessRate",
  "decisionIncomeBridgeEnabled",
  "historicalDataSource",
  "backtestMode",
  "historicalStartYear",
  "historicalEndYear",
  "historicalChunkYears",
  "cryptoStockProxy",
  "tipsBondProxy",
  "withdrawalStrategyMode",
  "withdrawalOrder",
  "spendingStrategyMode",
  "essentialSpend",
  "discretionarySpend",
  "guardrailCorrectionDiscretionaryPercent",
  "guardrailBearDiscretionaryPercent",
  "riskGuardrailTargetSuccessRate",
  "riskGuardrailLowerSuccessRate",
  "riskGuardrailUpperSuccessRate",
  "riskGuardrailMinimumAdjustmentPercent",
  "riskGuardrailIncomeFloor",
  "riskGuardrailIncomeCeiling",
  "sequenceReserveMode",
  "sequenceReserveTargetYears",
  "sequenceReserveTentYears",
  "tipsLadderEnabled",
  "tipsLadderYears",
  "tipsLadderAnnualAmount",
  "tipsLadderRealYieldPercent",
  "tipsLadderMaintenanceMode",
  "tipsLadderReplenishCatchUp",
  "tipsLadderTriggerStockReturnPercent",
  "unifiedMarginalOptimizer",
  "assetLocationOptimization",
  "hsaContributionStrategy",
  "hsaQualifiedExpenseLimit",
  "hsaContributionAmount",
  "hsaCoverage",
  "allocationAwareWithdrawals",
  "taxAwareRebalancing",
  "equityGlidepath",
  "targetStockAllocation",
  "rebalanceBand",
  "glidepathStartStockAllocation",
  "glidepathEndStockAllocation",
  "glidepathYears",
  "taxYear",
  "filingStatus",
  "stateSelect",
  "householdSize",
  "marketplaceMembers",
  "currentAge",
  "spouseAge",
  "primaryMortalityAge",
  "spouseMortalityAge",
  "acaMemberAges",
  "retirementPenaltyAge",
  "rothBasis",
  "earlyWithdrawalPenaltyExceptionAmount",
  "rothFiveYearRuleSatisfied",
  "privacyMode",
  "medicareWages",
  "socialSecurityWages",
  "selfEmploymentIncome",
  "rrtaCompensation",
  "spouseMedicareWages",
  "spouseSocialSecurityWages",
  "spouseSelfEmploymentIncome",
  "estimateSocialSecurityFromEarnings",
  "earnedIncomeInflationAdjusted",
  "socialSecurityAnnualBenefit",
  "socialSecurityStartAge",
  "socialSecurityInflationAdjusted",
  "spouseSocialSecurityAnnualBenefit",
  "spouseSocialSecurityStartAge",
  "spouseSocialSecurityInflationAdjusted",
  "heirType",
  "nonSpouse10YrTaxDrag",
  "eligibleDesignatedTaxDiscount",
  "rmdEnabled",
  "rmdStartAge",
  "irmaaEnabled",
  "maxIrmaaTier",
  "medicarePartBEnrollees",
  "medicarePartDEnrollees",
  "medicarePartDMonthlyPremium",
  "medicareMedigapMonthlyPremium",
  "medicareAnnualOopBase",
  "rmdSpouseStartAge",
  "agePhasedSpending",
  "slowGoAge",
  "slowGoPercent",
  "noGoAge",
  "noGoPercent",
  "ltcStressEnabled",
  "ltcStressMember",
  "ltcStressStartAge",
  "ltcStressYears",
  "ltcStressAnnualCost",
  "heirTaxIndexing",
  "survivorStepUpEnabled",
  "survivorStepUpJointPercent",
  "mcInflationPersistence",
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
  "maConnectorCarePlanType",
  "marketplaceApiKey",
  "marketplaceZip",
  "marketplaceCountyFips",
  "marketplaceCountyName",
  "marketplaceRatingArea",
  "marketplacePlanYear",
  "marketplaceUsesTobacco",
  "marketplaceUtilizationLevel",
  "acaBenchmarkMonthlyPremium",
  "acaBenchmarkPlanId",
  "acaBenchmarkPlanName",
  "acaSelectedPlanMonthlyPremium",
  "acaSelectedPlanId",
  "acaSelectedPlanName",
  "oopMaxOverride",
  "acaBackupPremiumInputMode",
  "acaBackupBenchmarkMonthlyPremium",
  "acaBackupMonthlyPremium",
  "acaBackupOopMax",
  "acaBackupTriggerFplPercent",
  "acaBackupPlanId",
  "acaBackupPlanName",
  "acaAgeRateManualPremiums",
  "acaPremium",
  "acaFpl",
  "qualifyingChildren",
  "childAges",
  "additionalFederalDeduction",
  "additionalFederalCredits",
  "itemizedDeductionMode",
  "itemizedStateLocalTaxes",
  "itemizedMortgageInterest",
  "itemizedCharitableContributions",
  "itemizedMedicalExpenses",
  "amtPreferenceItems",
  "qbiSourceMode",
  "qbiAmount",
  "qbiSpecifiedServiceBusiness",
  "qbiW2Wages",
  "qbiUbiaQualifiedProperty",
  "stateTaxRate",
  "separateStateGains",
  "stateCapitalRate",
  "stateRetirementExclusion",
  "stateSocialSecurityTaxablePercent",
  "taxLossHarvesting",
  "tlhMax",
  "taxGainHarvesting",
  "tghMax",
  "taxGainMagiBuffer",
  "rothConversion",
  "rothConversionOptimizeForAca",
  "rothConversionMagiGuardrails",
  "rothConversionSpendingAware",
  "rothConversionSpendFromBasis",
  "rothAmount",
  "rothTargetRate",
  "heirOrdinaryTaxRate",
  "rothConversionMaxAcaFplPercent",
  "rothConversionMagiBuffer",
  "rothBasisOptimization",
  "rothBasisMagiBuffer",
  "rothBasisOpportunityCostMode",
  "oneOffName",
  "oneOffType",
  "oneOffStart",
  "oneOffEnd",
  "oneOffAmount",
  "oneOffInflation",
  "flowMode",
  "magiDisplayMode",
  "yearRange",
  "sheetUrl",
  "googleClientId",
  "sheetRange"
];

const els = {
  status: document.querySelector("#status"),
  importStatus: document.querySelector("#importStatus"),
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
  downloadResultAuditBundle: document.querySelector("#downloadResultAuditBundle"),
  rememberSetup: document.querySelector("#rememberSetup"),
  clearLocalData: document.querySelector("#clearLocalData"),
  restoreSetupFile: document.querySelector("#restoreSetupFile"),
  restoreSetupFiles: [...document.querySelectorAll("[data-setup-restore-file]")],
  addAsset: document.querySelector("#addAsset"),
  planYears: document.querySelector("#planYears"),
  runs: document.querySelector("#runs"),
  seed: document.querySelector("#seed"),
  mcPreset: document.querySelector("#mcPreset"),
  mcSamplingMode: document.querySelector("#mcSamplingMode"),
  mcShortTermMeanReversion: document.querySelector("#mcShortTermMeanReversion"),
  mcLongTermMeanReversion: document.querySelector("#mcLongTermMeanReversion"),
  mcLongTermReversionYears: document.querySelector("#mcLongTermReversionYears"),
  targetSpend: document.querySelector("#targetSpend"),
  decisionRequiredSpend: document.querySelector("#decisionRequiredSpend"),
  decisionFlexibleSpend: document.querySelector("#decisionFlexibleSpend"),
  decisionTargetSuccessRate: document.querySelector("#decisionTargetSuccessRate"),
  decisionIncomeBridgeEnabled: document.querySelector("#decisionIncomeBridgeEnabled"),
  historicalDataSource: document.querySelector("#historicalDataSource"),
  backtestMode: document.querySelector("#backtestMode"),
  historicalStartYear: document.querySelector("#historicalStartYear"),
  historicalEndYear: document.querySelector("#historicalEndYear"),
  historicalChunkYears: document.querySelector("#historicalChunkYears"),
  cryptoStockProxy: document.querySelector("#cryptoStockProxy"),
  tipsBondProxy: document.querySelector("#tipsBondProxy"),
  withdrawalStrategyMode: document.querySelector("#withdrawalStrategyMode"),
  withdrawalOrder: document.querySelector("#withdrawalOrder"),
  spendingStrategyMode: document.querySelector("#spendingStrategyMode"),
  essentialSpend: document.querySelector("#essentialSpend"),
  discretionarySpend: document.querySelector("#discretionarySpend"),
  guardrailCorrectionDiscretionaryPercent: document.querySelector("#guardrailCorrectionDiscretionaryPercent"),
  guardrailBearDiscretionaryPercent: document.querySelector("#guardrailBearDiscretionaryPercent"),
  riskGuardrailTargetSuccessRate: document.querySelector("#riskGuardrailTargetSuccessRate"),
  riskGuardrailLowerSuccessRate: document.querySelector("#riskGuardrailLowerSuccessRate"),
  riskGuardrailUpperSuccessRate: document.querySelector("#riskGuardrailUpperSuccessRate"),
  riskGuardrailMinimumAdjustmentPercent: document.querySelector("#riskGuardrailMinimumAdjustmentPercent"),
  riskGuardrailIncomeFloor: document.querySelector("#riskGuardrailIncomeFloor"),
  riskGuardrailIncomeCeiling: document.querySelector("#riskGuardrailIncomeCeiling"),
  sequenceReserveMode: document.querySelector("#sequenceReserveMode"),
  sequenceReserveTargetYears: document.querySelector("#sequenceReserveTargetYears"),
  sequenceReserveTentYears: document.querySelector("#sequenceReserveTentYears"),
  tipsLadderEnabled: document.querySelector("#tipsLadderEnabled"),
  tipsLadderYears: document.querySelector("#tipsLadderYears"),
  tipsLadderAnnualAmount: document.querySelector("#tipsLadderAnnualAmount"),
  tipsLadderRealYieldPercent: document.querySelector("#tipsLadderRealYieldPercent"),
  tipsLadderMaintenanceMode: document.querySelector("#tipsLadderMaintenanceMode"),
  tipsLadderReplenishCatchUp: document.querySelector("#tipsLadderReplenishCatchUp"),
  tipsLadderTriggerStockReturnPercent: document.querySelector("#tipsLadderTriggerStockReturnPercent"),
  unifiedMarginalOptimizer: document.querySelector("#unifiedMarginalOptimizer"),
  assetLocationOptimization: document.querySelector("#assetLocationOptimization"),
  hsaContributionStrategy: document.querySelector("#hsaContributionStrategy"),
  hsaQualifiedExpenseLimit: document.querySelector("#hsaQualifiedExpenseLimit"),
  hsaContributionAmount: document.querySelector("#hsaContributionAmount"),
  hsaCoverage: document.querySelector("#hsaCoverage"),
  allocationAwareWithdrawals: document.querySelector("#allocationAwareWithdrawals"),
  taxAwareRebalancing: document.querySelector("#taxAwareRebalancing"),
  equityGlidepath: document.querySelector("#equityGlidepath"),
  targetStockAllocation: document.querySelector("#targetStockAllocation"),
  rebalanceBand: document.querySelector("#rebalanceBand"),
  glidepathStartStockAllocation: document.querySelector("#glidepathStartStockAllocation"),
  glidepathEndStockAllocation: document.querySelector("#glidepathEndStockAllocation"),
  glidepathYears: document.querySelector("#glidepathYears"),
  taxYear: document.querySelector("#taxYear"),
  filingStatus: document.querySelector("#filingStatus"),
  stateSelect: document.querySelector("#stateSelect"),
  householdSize: document.querySelector("#householdSize"),
  marketplaceMembers: document.querySelector("#marketplaceMembers"),
  currentAge: document.querySelector("#currentAge"),
  spouseAge: document.querySelector("#spouseAge"),
  primaryMortalityAge: document.querySelector("#primaryMortalityAge"),
  spouseMortalityAge: document.querySelector("#spouseMortalityAge"),
  acaMemberAges: document.querySelector("#acaMemberAges"),
  retirementPenaltyAge: document.querySelector("#retirementPenaltyAge"),
  rothBasis: document.querySelector("#rothBasis"),
  earlyWithdrawalPenaltyExceptionAmount: document.querySelector("#earlyWithdrawalPenaltyExceptionAmount"),
  rothFiveYearRuleSatisfied: document.querySelector("#rothFiveYearRuleSatisfied"),
  privacyMode: document.querySelector("#privacyMode"),
  medicareWages: document.querySelector("#medicareWages"),
  socialSecurityWages: document.querySelector("#socialSecurityWages"),
  selfEmploymentIncome: document.querySelector("#selfEmploymentIncome"),
  rrtaCompensation: document.querySelector("#rrtaCompensation"),
  spouseMedicareWages: document.querySelector("#spouseMedicareWages"),
  spouseSocialSecurityWages: document.querySelector("#spouseSocialSecurityWages"),
  spouseSelfEmploymentIncome: document.querySelector("#spouseSelfEmploymentIncome"),
  estimateSocialSecurityFromEarnings: document.querySelector("#estimateSocialSecurityFromEarnings"),
  earnedIncomeInflationAdjusted: document.querySelector("#earnedIncomeInflationAdjusted"),
  socialSecurityAnnualBenefit: document.querySelector("#socialSecurityAnnualBenefit"),
  socialSecurityStartAge: document.querySelector("#socialSecurityStartAge"),
  socialSecurityInflationAdjusted: document.querySelector("#socialSecurityInflationAdjusted"),
  spouseSocialSecurityAnnualBenefit: document.querySelector("#spouseSocialSecurityAnnualBenefit"),
  spouseSocialSecurityStartAge: document.querySelector("#spouseSocialSecurityStartAge"),
  spouseSocialSecurityInflationAdjusted: document.querySelector("#spouseSocialSecurityInflationAdjusted"),
  heirType: document.querySelector("#heirType"),
  nonSpouse10YrTaxDrag: document.querySelector("#nonSpouse10YrTaxDrag"),
  eligibleDesignatedTaxDiscount: document.querySelector("#eligibleDesignatedTaxDiscount"),
  heirBaseIncome: document.querySelector("#heirBaseIncome"),
  heirAge: document.querySelector("#heirAge"),
  heirState: document.querySelector("#heirState"),
  rmdEnabled: document.querySelector("#rmdEnabled"),
  rmdStartAge: document.querySelector("#rmdStartAge"),
  irmaaEnabled: document.querySelector("#irmaaEnabled"),
  maxIrmaaTier: document.querySelector("#maxIrmaaTier"),
  medicarePartBEnrollees: document.querySelector("#medicarePartBEnrollees"),
  medicarePartDEnrollees: document.querySelector("#medicarePartDEnrollees"),
  medicarePartDMonthlyPremium: document.querySelector("#medicarePartDMonthlyPremium"),
  medicareMedigapMonthlyPremium: document.querySelector("#medicareMedigapMonthlyPremium"),
  medicareAnnualOopBase: document.querySelector("#medicareAnnualOopBase"),
  rmdSpouseStartAge: document.querySelector("#rmdSpouseStartAge"),
  agePhasedSpending: document.querySelector("#agePhasedSpending"),
  slowGoAge: document.querySelector("#slowGoAge"),
  slowGoPercent: document.querySelector("#slowGoPercent"),
  noGoAge: document.querySelector("#noGoAge"),
  noGoPercent: document.querySelector("#noGoPercent"),
  ltcStressEnabled: document.querySelector("#ltcStressEnabled"),
  ltcStressMember: document.querySelector("#ltcStressMember"),
  ltcStressStartAge: document.querySelector("#ltcStressStartAge"),
  ltcStressYears: document.querySelector("#ltcStressYears"),
  ltcStressAnnualCost: document.querySelector("#ltcStressAnnualCost"),
  heirTaxIndexing: document.querySelector("#heirTaxIndexing"),
  survivorStepUpEnabled: document.querySelector("#survivorStepUpEnabled"),
  survivorStepUpJointPercent: document.querySelector("#survivorStepUpJointPercent"),
  mcInflationPersistence: document.querySelector("#mcInflationPersistence"),
  incomeStreamName: document.querySelector("#incomeStreamName"),
  incomeStreamType: document.querySelector("#incomeStreamType"),
  incomeStreamOwner: document.querySelector("#incomeStreamOwner"),
  incomeStreamStartAge: document.querySelector("#incomeStreamStartAge"),
  incomeStreamEndAge: document.querySelector("#incomeStreamEndAge"),
  incomeStreamAmount: document.querySelector("#incomeStreamAmount"),
  incomeStreamSurvivorPercent: document.querySelector("#incomeStreamSurvivorPercent"),
  incomeStreamTaxCharacter: document.querySelector("#incomeStreamTaxCharacter"),
  incomeStreamCola: document.querySelector("#incomeStreamCola"),
  incomeStreamStateRetirement: document.querySelector("#incomeStreamStateRetirement"),
  addIncomeStream: document.querySelector("#addIncomeStream"),
  incomeStreamList: document.querySelector("#incomeStreamList"),
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
  maConnectorCarePlanType: document.querySelector("#maConnectorCarePlanType"),
  fillMassConnectorCare: document.querySelector("#fillMassConnectorCare"),
  fillMassBackupPlan: document.querySelector("#fillMassBackupPlan"),
  findMarketplacePlans: document.querySelector("#findMarketplacePlans"),
  marketplaceApiKey: document.querySelector("#marketplaceApiKey"),
  marketplaceZip: document.querySelector("#marketplaceZip"),
  marketplaceCountyFips: document.querySelector("#marketplaceCountyFips"),
  marketplaceCountyName: document.querySelector("#marketplaceCountyName"),
  marketplaceRatingArea: document.querySelector("#marketplaceRatingArea"),
  marketplacePlanYear: document.querySelector("#marketplacePlanYear"),
  marketplaceUsesTobacco: document.querySelector("#marketplaceUsesTobacco"),
  marketplaceUtilizationLevel: document.querySelector("#marketplaceUtilizationLevel"),
  acaPlanLookupStatus: document.querySelector("#acaPlanLookupStatus"),
  marketplacePlanResults: document.querySelector("#marketplacePlanResults"),
  acaBenchmarkMonthlyPremium: document.querySelector("#acaBenchmarkMonthlyPremium"),
  acaBenchmarkPlanId: document.querySelector("#acaBenchmarkPlanId"),
  acaBenchmarkPlanName: document.querySelector("#acaBenchmarkPlanName"),
  acaSelectedPlanMonthlyPremium: document.querySelector("#acaSelectedPlanMonthlyPremium"),
  acaSelectedPlanId: document.querySelector("#acaSelectedPlanId"),
  acaSelectedPlanName: document.querySelector("#acaSelectedPlanName"),
  oopMaxOverride: document.querySelector("#oopMaxOverride"),
  acaBackupPremiumInputMode: document.querySelector("#acaBackupPremiumInputMode"),
  acaBackupBenchmarkMonthlyPremium: document.querySelector("#acaBackupBenchmarkMonthlyPremium"),
  acaBackupMonthlyPremium: document.querySelector("#acaBackupMonthlyPremium"),
  acaBackupOopMax: document.querySelector("#acaBackupOopMax"),
  acaBackupTriggerFplPercent: document.querySelector("#acaBackupTriggerFplPercent"),
  acaBackupPlanId: document.querySelector("#acaBackupPlanId"),
  acaBackupPlanName: document.querySelector("#acaBackupPlanName"),
  acaAgeRateManualPremiums: document.querySelector("#acaAgeRateManualPremiums"),
  acaPremium: document.querySelector("#acaPremium"),
  acaFpl: document.querySelector("#acaFpl"),
  qualifyingChildren: document.querySelector("#qualifyingChildren"),
  childAges: document.querySelector("#childAges"),
  additionalFederalDeduction: document.querySelector("#additionalFederalDeduction"),
  additionalFederalCredits: document.querySelector("#additionalFederalCredits"),
  itemizedDeductionMode: document.querySelector("#itemizedDeductionMode"),
  itemizedStateLocalTaxes: document.querySelector("#itemizedStateLocalTaxes"),
  itemizedMortgageInterest: document.querySelector("#itemizedMortgageInterest"),
  itemizedCharitableContributions: document.querySelector("#itemizedCharitableContributions"),
  itemizedMedicalExpenses: document.querySelector("#itemizedMedicalExpenses"),
  amtPreferenceItems: document.querySelector("#amtPreferenceItems"),
  qbiSourceMode: document.querySelector("#qbiSourceMode"),
  qbiAmount: document.querySelector("#qbiAmount"),
  qbiSpecifiedServiceBusiness: document.querySelector("#qbiSpecifiedServiceBusiness"),
  qbiW2Wages: document.querySelector("#qbiW2Wages"),
  qbiUbiaQualifiedProperty: document.querySelector("#qbiUbiaQualifiedProperty"),
  stateTaxRate: document.querySelector("#stateTaxRate"),
  separateStateGains: document.querySelector("#separateStateGains"),
  stateCapitalRate: document.querySelector("#stateCapitalRate"),
  stateRetirementExclusion: document.querySelector("#stateRetirementExclusion"),
  stateSocialSecurityTaxablePercent: document.querySelector("#stateSocialSecurityTaxablePercent"),
  taxLossHarvesting: document.querySelector("#taxLossHarvesting"),
  tlhMax: document.querySelector("#tlhMax"),
  taxGainHarvesting: document.querySelector("#taxGainHarvesting"),
  tghMax: document.querySelector("#tghMax"),
  taxGainMagiBuffer: document.querySelector("#taxGainMagiBuffer"),
  rothConversion: document.querySelector("#rothConversion"),
  rothConversionOptimizeForAca: document.querySelector("#rothConversionOptimizeForAca"),
  rothConversionMagiGuardrails: document.querySelector("#rothConversionMagiGuardrails"),
  rothConversionSpendingAware: document.querySelector("#rothConversionSpendingAware"),
  rothConversionSpendFromBasis: document.querySelector("#rothConversionSpendFromBasis"),
  rothAmount: document.querySelector("#rothAmount"),
  rothTargetRate: document.querySelector("#rothTargetRate"),
  heirOrdinaryTaxRate: document.querySelector("#heirOrdinaryTaxRate"),
  rothConversionMaxAcaFplPercent: document.querySelector("#rothConversionMaxAcaFplPercent"),
  rothConversionMagiBuffer: document.querySelector("#rothConversionMagiBuffer"),
  rothBasisOptimization: document.querySelector("#rothBasisOptimization"),
  rothBasisMagiBuffer: document.querySelector("#rothBasisMagiBuffer"),
  rothBasisOpportunityCostMode: document.querySelector("#rothBasisOpportunityCostMode"),
  oneOffName: document.querySelector("#oneOffName"),
  oneOffType: document.querySelector("#oneOffType"),
  oneOffStart: document.querySelector("#oneOffStart"),
  oneOffEnd: document.querySelector("#oneOffEnd"),
  oneOffAmount: document.querySelector("#oneOffAmount"),
  oneOffInflation: document.querySelector("#oneOffInflation"),
  addOneOff: document.querySelector("#addOneOff"),
  oneOffList: document.querySelector("#oneOffList"),
  kpis: document.querySelector("#kpis"),
  flowMode: document.querySelector("#flowMode"),
  magiDisplayMode: document.querySelector("#magiDisplayMode"),
  yearRange: document.querySelector("#yearRange"),
  yearLabel: document.querySelector("#yearLabel"),
  sankeySvg: document.querySelector("#sankeySvg"),
  timelineSvg: document.querySelector("#timelineSvg"),
  distributionSvg: document.querySelector("#distributionSvg"),
  yearTable: document.querySelector("#yearTable"),
  scenarioTable: document.querySelector("#scenarioTable"),
  backtestTable: document.querySelector("#backtestTable"),
  auditPanel: document.querySelector("#auditPanel"),
  actionPlan: document.querySelector("#actionPlan"),
  actionPlanNote: document.querySelector("#actionPlanNote"),
  assetBreakdownTable: document.querySelector("#assetBreakdownTable")
};

let assets = sampleAssets.map((asset) => ({ ...asset }));
let oneOffExpenses = defaultOneOffExpenses.map((expense) => ({ ...expense }));
let incomeStreams = [];
let selectedYearIndex = 0;
let selectedScenarioId = null;
let selectedBacktestIndex = null;
let latest = null;
let googleSheetsAccessToken = null;
let googleSheetsTokenExpiresAt = 0;
let marketplacePlanChoices = [];
let marketplaceSlcspMonthly = null;
let marketplaceSlcspPlan = null;
let marketplaceRatingAreaLabel = "";
let simulationWorker = null;
let simulationRequestId = 0;
let activeSimulationRequestId = 0;
let runModelsBusy = false;
let pendingRerunRequested = false;
let runModelsToken = 0;
let activeSimulationCancel = null;
let workspaceDirty = false;
let streamingRenderRaf = 0;
let appliedRescueScenarioOverride = null;
let applyingRescueScenario = false;
let rememberSetupEnabled = loadRememberSetupPreference();

const PINNED_YEAR_STORAGE_KEY = "portfolio-success-lab:pinned-year-columns";
const PINNED_ASSET_STORAGE_KEY = "portfolio-success-lab:pinned-asset-columns";
const TABLE_HEIGHT_STORAGE_KEY = "portfolio-success-lab:table-heights";
const ASSET_SORT_STORAGE_KEY = "portfolio-success-lab:asset-sort";
const ALWAYS_PINNED_YEAR = ["Year", "Age"];
const ALWAYS_PINNED_ASSET = ["Asset", "Account"];
const ASSET_COLUMN_META = {
  "Asset":        { value: (r) => r.currentAsset.name,         numeric: false, defaultDir: "asc"  },
  "Account":      { value: (r) => r.currentAsset.accountType,  numeric: false, defaultDir: "asc"  },
  "Class":        { value: (r) => r.currentAsset.assetClass,   numeric: false, defaultDir: "asc"  },
  "Units":        { value: (r) => r.currentAsset.units,        numeric: true,  defaultDir: "desc" },
  "Price":        { value: (r) => r.currentAsset.price,        numeric: true,  defaultDir: "desc" },
  "Ending value": { value: (r) => r.currentAsset.value,        numeric: true,  defaultDir: "desc" },
  "Change":       { value: (r) => r.change,                    numeric: true,  defaultDir: "desc" },
  "Change %":     { value: (r) => r.changePercent,             numeric: true,  defaultDir: "desc" },
  "Basis":        { value: (r) => r.currentAsset.costBasis,    numeric: true,  defaultDir: "desc" },
  "Unrealized":   { value: (r) => r.currentAsset.unrealizedGain, numeric: true, defaultDir: "desc" }
};
const RUN_CANCELED_MESSAGE = "Simulation run canceled.";
let pinnedYearColumns = loadPinnedColumns(PINNED_YEAR_STORAGE_KEY);
let pinnedAssetColumns = loadPinnedColumns(PINNED_ASSET_STORAGE_KEY);
let assetSortState = loadAssetSortState();

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

function loadAssetSortState() {
  try {
    const stored = JSON.parse(localStorage.getItem(ASSET_SORT_STORAGE_KEY) || "null");
    if (stored && typeof stored.column === "string" && (stored.direction === "asc" || stored.direction === "desc")) {
      return { column: stored.column, direction: stored.direction };
    }
  } catch { /* ignore */ }
  return { column: null, direction: "desc" };
}

function saveAssetSortState(state) {
  try {
    if (!state || !state.column) {
      localStorage.removeItem(ASSET_SORT_STORAGE_KEY);
    } else {
      localStorage.setItem(ASSET_SORT_STORAGE_KEY, JSON.stringify(state));
    }
  } catch { /* ignore */ }
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

function loadRememberSetupPreference() {
  try {
    const preference = localStorage.getItem(REMEMBER_SETUP_KEY);
    if (preference === "true") return true;
    if (preference === "false") return false;
    return Boolean(localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

function writeRememberSetupPreference(value) {
  try {
    if (value) {
      localStorage.setItem(REMEMBER_SETUP_KEY, "true");
    } else {
      localStorage.removeItem(REMEMBER_SETUP_KEY);
    }
  } catch { /* ignore */ }
}

function initializePersistenceControls() {
  if (els.rememberSetup) {
    els.rememberSetup.checked = rememberSetupEnabled;
  }
}

function handleRememberSetupChange() {
  rememberSetupEnabled = Boolean(els.rememberSetup?.checked);
  writeRememberSetupPreference(rememberSetupEnabled);

  if (rememberSetupEnabled) {
    saveStoredState({ markDirty: false });
    if (latest?.monteCarlo?.progress?.complete) {
      cacheLatestResults(latest);
    }
    setImportStatus("Setup will be remembered on this device.");
  } else {
    removeStoredSetupState();
    clearCachedLatest();
    setImportStatus("Setup is no longer saved on this device.");
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("psl:persistence-changed", {
      detail: { rememberSetup: rememberSetupEnabled }
    }));
  }
}

function handleClearLocalData() {
  const confirmed = typeof window === "undefined"
    || window.confirm("Clear setup and restart from the beginning? This removes saved setup, cached results, app preferences, and the current open setup.");
  if (!confirmed) return;

  clearLocalData();
  restartSetupFlow();
}

function clearLocalData() {
  rememberSetupEnabled = false;
  if (els.rememberSetup) els.rememberSetup.checked = false;

  [
    STORAGE_KEY,
    REMEMBER_SETUP_KEY,
    PINNED_YEAR_STORAGE_KEY,
    PINNED_ASSET_STORAGE_KEY,
    TABLE_HEIGHT_STORAGE_KEY,
    ASSET_SORT_STORAGE_KEY,
    ...REDESIGN_STORAGE_KEYS
  ].forEach((key) => {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  });

  clearCachedLatest();
  pinnedYearColumns = new Set();
  pinnedAssetColumns = new Set();
  assetSortState = { column: null, direction: "desc" };

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("psl:local-data-cleared"));
    window.dispatchEvent(new CustomEvent("psl:persistence-changed", {
      detail: { rememberSetup: false }
    }));
  }
}

function removeStoredSetupState() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

function restartSetupFlow() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("screen");
  if (url.toString() === window.location.href) {
    window.location.reload();
  } else {
    window.location.replace(url.toString());
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
  renderMassachusettsConnectorCarePlanOptions();
  initializePersistenceControls();
  loadStoredState();
  updatePrivacyModeControls();
  syncSpendingStrategyControls();
  syncMonteCarloControls();
  syncJsonFromAssets();
  renderAssetTable();
  renderOneOffs();
  renderIncomeStreams();
  bindEvents();
  // Restore previously-rendered results from sessionStorage so a refresh paints
  // the page immediately (instead of staring at empty panels while the worker
  // re-runs). The runModels() call below kicks off a fresh background run that
  // overwrites these results when it finishes.
  const cached = rememberSetupEnabled ? restoreCachedLatest() : null;
  if (cached) {
    latest = cached;
    // Cached scenarios from sessionStorage are always from a completed run.
    if (latest.monteCarlo && !latest.monteCarlo.progress) {
      latest.monteCarlo.progress = {
        done: latest.monteCarlo.scenarios?.length ?? 0,
        total: latest.monteCarlo.scenarios?.length ?? 0,
        complete: true
      };
    }
    selectedScenarioId = firstResultWithYears(latest.monteCarlo?.scenarios)?.id ?? null;
    const planYears = latest.scenario?.planYears ?? 35;
    selectedYearIndex = Math.min(Math.max(0, selectedYearIndex), planYears - 1);
    if (els.yearRange) {
      els.yearRange.max = String(planYears);
      els.yearRange.value = String(selectedYearIndex + 1);
    }
    renderLatest();
  }
  // If a cached snapshot is already painted, run silently in the background
  // and only swap when the new full result is ready — otherwise stream into
  // an empty results screen so the user sees progress.
  runModels({ stream: !cached });
}

function bindEvents() {
  els.rememberSetup?.addEventListener("change", handleRememberSetupChange);
  els.clearLocalData?.addEventListener("click", handleClearLocalData);
  els.fillMassConnectorCare.addEventListener("click", applyMassachusettsConnectorCarePreset);
  els.fillMassBackupPlan.addEventListener("click", applyMassachusettsBackupPlanPreset);
  els.findMarketplacePlans.addEventListener("click", findMarketplacePlans);
  els.marketplacePlanResults.addEventListener("click", handleMarketplacePlanSelection);
  els.viewMode.addEventListener("change", renderLatest);
  els.flowMode.addEventListener("change", renderFlowAndSales);
  els.magiDisplayMode?.addEventListener("change", () => {
    saveStoredState();
    renderYearTable();
  });
  CONTROL_IDS.forEach((id) => {
    const input = document.querySelector(`#${id}`);
    if (!input) return;
    input.addEventListener("change", handleWorkspaceControlChange);
    input.addEventListener("input", handleWorkspaceControlChange);
  });
  els.spendingStrategyMode?.addEventListener("change", () => {
    syncSpendingStrategyControls();
    saveStoredState();
  });
  els.withdrawalStrategyMode?.addEventListener("change", () => {
    updateStrategyDescriptions();
    saveStoredState();
  });
  els.essentialSpend?.addEventListener("input", () => {
    syncSpendingStrategyControls();
    saveStoredState();
  });
  els.discretionarySpend?.addEventListener("input", () => {
    syncSpendingStrategyControls();
    saveStoredState();
  });
  bindMonteCarloControls();
  els.historicalDataSource?.addEventListener("change", resetHistoricalRangeControlsForCurrentSource);
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
      qualifiedDividendShare: 1,
      beneficiaryType: "default"
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
    if (privacyModeEnabled()) return reportImportError(externalLookupBlockedMessage("Google Sheets import"));
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
    if (privacyModeEnabled()) return reportImportError(externalLookupBlockedMessage("Google Sheets OAuth import"));
    const spreadsheetId = googleSpreadsheetIdFromInput(els.sheetUrl.value);
    const range = els.sheetRange.value.trim() || "A:J";
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

  els.downloadSetup.addEventListener("click", downloadSetupBackup);
  els.downloadResultAuditBundle?.addEventListener("click", downloadResultAuditBundle);

  const restoreInputs = els.restoreSetupFiles.length ? els.restoreSetupFiles : [els.restoreSetupFile].filter(Boolean);
  restoreInputs.forEach((input) => input.addEventListener("change", handleSetupRestoreFile));

  async function handleSetupRestoreFile(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      setImportStatus(`Loading ${file.name}...`);
      const restoredState = parseSetupBackup(await file.text());
      applySetupState(restoredState);
      syncSpendingStrategyControls();
      syncJsonFromAssets();
      renderAssetTable();
      renderOneOffs();
      renderIncomeStreams();
      saveStoredState();
      runModels();
      const message = `Loaded setup from ${file.name}. ${assets.length} assets loaded.`;
      setStatus(message);
      setImportStatus(message);
      window.dispatchEvent(new CustomEvent("psl:setup-restored", {
        detail: { fileName: file.name, state: restoredState, assetCount: assets.length }
      }));
    } catch (error) {
      reportImportError(error);
    } finally {
      input.value = "";
    }
  }

  els.addOneOff.addEventListener("click", () => {
    const cashFlowType = normalizedOneOffCashFlowType(els.oneOffType.value);
    oneOffExpenses.push({
      name: els.oneOffName.value || oneOffDefaultName(cashFlowType),
      cashFlowType,
      startYear: Number(els.oneOffStart.value),
      endYear: Number(els.oneOffEnd.value),
      amount: Number(els.oneOffAmount.value),
      inflationAdjusted: els.oneOffInflation.checked
    });
    renderOneOffs();
    saveStoredState();
  });

  els.addIncomeStream?.addEventListener("click", () => {
    incomeStreams.push({
      name: els.incomeStreamName?.value || "",
      type: els.incomeStreamType?.value || "pension",
      owner: els.incomeStreamOwner?.value === "spouse" ? "spouse" : "primary",
      startAge: Number(els.incomeStreamStartAge?.value) || 65,
      endAge: numberOrNull(els.incomeStreamEndAge?.value),
      annualAmount: Number(els.incomeStreamAmount?.value) || 0,
      survivorPercent: numberOrNull(els.incomeStreamSurvivorPercent?.value) ?? 0,
      taxCharacter: els.incomeStreamTaxCharacter?.value === "taxFree" ? "taxFree" : "ordinary",
      inflationAdjusted: els.incomeStreamCola?.checked !== false,
      stateRetirementIncome: els.incomeStreamStateRetirement?.checked === true
    });
    renderIncomeStreams();
    saveStoredState();
  });
}

function privacyModeEnabled() {
  return els.privacyMode?.checked === true;
}

function externalLookupBlockedMessage(kind = "external lookup") {
  return `Privacy mode is on. Turn it off before using ${kind}.`;
}

function updatePrivacyModeControls({ announce = false } = {}) {
  const enabled = privacyModeEnabled();
  document.querySelectorAll("[data-external-lookup]").forEach((control) => {
    control.disabled = enabled;
    control.setAttribute("aria-disabled", String(enabled));
    if (enabled) {
      if (!Object.prototype.hasOwnProperty.call(control.dataset, "privacyTitle")) {
        control.dataset.privacyTitle = control.getAttribute("title") || "";
      }
      control.setAttribute("title", "Privacy mode is on; this external lookup helper is disabled.");
    } else if (Object.prototype.hasOwnProperty.call(control.dataset, "privacyTitle")) {
      const previousTitle = control.dataset.privacyTitle;
      if (previousTitle) control.setAttribute("title", previousTitle);
      else control.removeAttribute("title");
      delete control.dataset.privacyTitle;
    }
  });

  if (enabled) {
    marketplacePlanChoices = [];
    marketplaceSlcspMonthly = null;
    marketplaceSlcspPlan = null;
    if (els.marketplacePlanResults) els.marketplacePlanResults.innerHTML = "";
  }

  if (!announce) return;
  if (enabled) {
    setImportStatus("Privacy mode is on. Google Sheets import is disabled; CSV, JSON, and setup files remain local.");
    setAcaPlanLookupStatus("Privacy mode is on. Live CMS Marketplace plan search is disabled; use offline ZIP estimates or manual ACA plan inputs.");
  } else {
    setImportStatus("Privacy mode is off. Google Sheets imports are available when explicitly invoked.");
    setAcaPlanLookupStatus("Privacy mode is off. CMS Marketplace plan search is available when explicitly invoked.");
  }
}

function syncSpendingStrategyControls() {
  const guardrailEnabled = els.spendingStrategyMode?.value === "discretionaryGuardrails";
  const riskGuardrailEnabled = els.spendingStrategyMode?.value === "riskBasedGuardrails";
  document.querySelectorAll("[data-guardrail-spend-controls]").forEach((element) => {
    element.hidden = !guardrailEnabled;
  });
  document.querySelectorAll("[data-risk-guardrail-controls]").forEach((element) => {
    element.hidden = !riskGuardrailEnabled;
  });
  [els.essentialSpend, els.discretionarySpend].forEach((input) => {
    if (input) input.disabled = !guardrailEnabled;
  });
  [
    els.riskGuardrailTargetSuccessRate,
    els.riskGuardrailLowerSuccessRate,
    els.riskGuardrailUpperSuccessRate,
    els.riskGuardrailMinimumAdjustmentPercent,
    els.riskGuardrailIncomeFloor,
    els.riskGuardrailIncomeCeiling
  ].forEach((input) => {
    if (input) input.disabled = !riskGuardrailEnabled;
  });
  if (els.targetSpend) {
    els.targetSpend.disabled = guardrailEnabled;
    if (guardrailEnabled) {
      const total = (Number(els.essentialSpend?.value) || 0) + (Number(els.discretionarySpend?.value) || 0);
      els.targetSpend.value = String(Math.max(0, total));
    }
  }
  updateStrategyDescriptions();
}

function syncMonteCarloControls() {
  const meanReversionEnabled = els.mcSamplingMode?.value === "meanRevertingCorrelated";
  document.querySelectorAll("[data-mean-reversion-controls]").forEach((element) => {
    element.hidden = !meanReversionEnabled;
  });
  [
    els.mcShortTermMeanReversion,
    els.mcLongTermMeanReversion,
    els.mcLongTermReversionYears
  ].forEach((input) => {
    if (input) input.disabled = !meanReversionEnabled;
  });
}

function updateStrategyDescriptions() {
  const withdrawalMode = els.withdrawalStrategyMode?.value;
  const spendingMode = els.spendingStrategyMode?.value;

  const withdrawalDescEl = document.querySelector("#withdrawalStrategyDesc");
  const spendingDescEl = document.querySelector("#spendingStrategyDesc");

  if (withdrawalDescEl) {
    if (withdrawalMode === "lifetime") {
      withdrawalDescEl.innerHTML = `<strong>Selected: Lifetime Optimizer (Recommended)</strong> — Solves for optimal annual Roth conversions, ACA subsidies, and progressive tax-bracket matching over your entire plan horizon. Mathematically maximizes tax-efficiency and legacy bequest.<br><span style="display: block; margin-top: 0.25rem; opacity: 0.85;"><em>Alternative:</em> <strong>Basic Drawdown Heuristic</strong> uses a fixed sequence (e.g., Taxable → Traditional → Roth) without multi-year dynamic tax planning.</span>`;
    } else {
      withdrawalDescEl.innerHTML = `<strong>Selected: Basic Drawdown Heuristic</strong> — Withdraws sequentially using a predefined asset order (e.g., Taxable → Traditional → Roth) to cover spending needs as they arise, with no multi-year forward planning.<br><span style="display: block; margin-top: 0.25rem; opacity: 0.85;"><em>Alternative:</em> <strong>Lifetime Optimizer</strong> (Recommended) dynamically sweeps and matches tax brackets to minimize lifetime taxes and maximize the legacy bequest.</span>`;
    }
  }

  if (spendingDescEl) {
    if (spendingMode === "fixed") {
      spendingDescEl.innerHTML = `<strong>Selected: Fixed Target Spend</strong> — Adjusts your initial target spend annually strictly by CPI inflation. It provides consistent purchasing power but ignores portfolio performance, introducing sequence-of-returns risk during severe bear markets.<br><span style="display: block; margin-top: 0.25rem; opacity: 0.85;"><em>Alternatives:</em> Dynamic rules (Guardrails, Risk-Based Guardrails, Guyton-Klinger, Kitces, VPW) dynamically adjust spending based on market conditions or historical risk thresholds.</span>`;
    } else if (spendingMode === "discretionaryGuardrails") {
      spendingDescEl.innerHTML = `<strong>Selected: Essential + Discretionary Guardrails</strong> — Splits spending into essential (inflation-adjusted) and discretionary (variable). Discretionary spending dynamically scales down (50% or 0%) when stock markets drop below prior highs, defending the portfolio during market corrections.<br><span style="display: block; margin-top: 0.25rem; opacity: 0.85;"><em>Alternatives:</em> Alternatives include Risk-Based Guardrails (historical thresholds), Guyton-Klinger (rules-based adjustments), Kitces (ratchets spending up on bull runs), VPW (percentage-based), and Fixed Spend.</span>`;
    } else if (spendingMode === "riskBasedGuardrails") {
      spendingDescEl.innerHTML = `<strong>Selected: Risk-Based Historical Guardrails</strong> — Uses historical backtest cohorts to solve a failsafe fixed spend, a starting spend, a lower portfolio trigger with a cut, and an upper portfolio trigger with a raise. Decision results show the solved table before the rules are applied.<br><span style="display: block; margin-top: 0.25rem; opacity: 0.85;"><em>Alternatives:</em> Alternatives include Essential + Discretionary Guardrails (market drawdown-based), Guyton-Klinger, Kitces, VPW, and Fixed Spend.</span>`;
    } else if (spendingMode === "guytonKlinger") {
      spendingDescEl.innerHTML = `<strong>Selected: Guyton-Klinger Rules</strong> — Applies rules-based guardrails: increases spending by inflation unless the withdrawal rate rises by &gt;20% (frozen rule), and reduces spending by 10% if the current withdrawal rate exceeds the initial rate by &gt;20% (capital preservation rule).<br><span style="display: block; margin-top: 0.25rem; opacity: 0.85;"><em>Alternatives:</em> Alternatives include Fixed Spend (static inflation-adjusted), Guardrails (market drop-based adjustments), Kitces (upside-focused), and VPW (dynamic percentage).</span>`;
    } else if (spendingMode === "kitces") {
      spendingDescEl.innerHTML = `<strong>Selected: Kitces Ratcheting</strong> — Designed to prevent "under-spending". Starts with a conservative initial spending rate. If portfolio growth rises such that the current withdrawal rate drops below 10% of its initial level, spending ratchets up by 10%.<br><span style="display: block; margin-top: 0.25rem; opacity: 0.85;"><em>Alternatives:</em> Alternatives include Guardrails/Guyton-Klinger (defensive downside and dynamic corrections), VPW (fully variable percentage), and Fixed Spend.</span>`;
    } else if (spendingMode === "vpw") {
      spendingDescEl.innerHTML = `<strong>Selected: Variable Percentage Withdrawal (VPW)</strong> — Calculates your annual spending as a variable percentage of your current portfolio value, based on your current age and asset allocation life expectancy. Spending automatically shrinks in bear markets and expands in bull markets, ensuring zero chance of premature depletion.<br><span style="display: block; margin-top: 0.25rem; opacity: 0.85;"><em>Alternatives:</em> Alternatives include Guardrails, Guyton-Klinger, and Kitces (which seek to smooth out spending fluctuations), and Fixed Spend.</span>`;
    }
  }
}

function renderStateOptions() {
  els.stateSelect.innerHTML = STATE_OPTIONS.map((state) => (
    `<option value="${escapeAttr(state)}" ${state === "Florida" ? "selected" : ""}>${escapeHtml(state)}</option>`
  )).join("");
}

function renderMassachusettsConnectorCarePlanOptions() {
  if (!els.maConnectorCarePlanType) return;
  els.maConnectorCarePlanType.innerHTML = [
    `<option value="auto">Auto by MAGI</option>`,
    ...massachusettsConnectorCarePlanOptions().map((planType) => (
      `<option value="${escapeAttr(planType.name)}">${escapeHtml(planType.name)} (${planType.minFplPercent}-${planType.maxFplPercent}% FPL)</option>`
    ))
  ].join("");
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

    const estimate = massachusettsConnectorCareEstimate({
      income,
      householdSize,
      marketplaceMembers,
      planTypeName: els.maConnectorCarePlanType?.value || "auto"
    });
    if (!estimate.eligible) {
      throw new Error(`${estimate.reason} Estimated FPL is ${percentFormatter.format(estimate.fplPercent / 100)}.`);
    }

    els.acaEnabled.checked = true;
    els.acaPlanCostMode.value = "selectedPlan";
    els.acaPremiumInputMode.value = "net";
    els.acaSelectedPlanMonthlyPremium.value = String(estimate.selectedPlanMonthlyPremium);
    if (els.acaSelectedPlanId) els.acaSelectedPlanId.value = estimate.planName;
    if (els.acaSelectedPlanName) els.acaSelectedPlanName.value = estimate.planName;
    els.oopMaxOverride.value = String(estimate.selectedPlanOopMaximum);
    els.acaBenchmarkMonthlyPremium.value = "";
    els.acaPremium.value = "";
    setAcaPlanLookupStatus(
      `${estimate.planName} from ACA MAGI ${moneyFormatter.format(income)}: ${moneyFormatter.format(estimate.selectedPlanMonthlyPremium)}/mo net premium, ${moneyFormatter.format(estimate.selectedPlanOopMaximum)} combined medical/Rx OOP max.${estimate.userSelectedPlanType && estimate.automaticPlanName !== estimate.planName ? ` Auto estimate would be ${estimate.automaticPlanName}.` : ""} Add a backup plan for years above 400% FPL.`
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
    if (privacyModeEnabled()) {
      throw new Error(externalLookupBlockedMessage("CMS Marketplace plan search"));
    }
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
    const county = await resolveMarketplaceCountyFips({ apiKey, zipcode });
    const countyfips = county.fips;
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
    const ratingArea = normalizeMarketplaceRatingArea(payload);
    marketplaceRatingAreaLabel = ratingArea.display || "";
    if (els.marketplaceRatingArea) els.marketplaceRatingArea.value = marketplaceRatingAreaLabel;
    if (els.marketplaceCountyName && county.name) els.marketplaceCountyName.value = county.name;
    const slcspPlan = secondLowestSilverPlan(plans);
    const slcspMonthly = Number.isFinite(Number(slcspPlan?.premium)) ? Number(slcspPlan.premium) : null;
    marketplacePlanChoices = plans;
    marketplaceSlcspMonthly = slcspMonthly;
    marketplaceSlcspPlan = slcspPlan;
    saveStoredState();
    renderMarketplacePlanResults(plans, { slcspMonthly, slcspPlan, ratingArea: marketplaceRatingAreaLabel });
    setAcaPlanLookupStatus(
      `Found ${numberFormatter.format(plans.length)} Marketplace plans for ${marketplaceLocalitySummary(zipcode, county)}. Pick a primary plan or a backup plan.`
    );
  } catch (error) {
    setAcaPlanLookupStatus(error.message, true);
  }
}

async function resolveMarketplaceCountyFips({ apiKey, zipcode }) {
  const current = String(els.marketplaceCountyFips.value || "").trim();
  if (current) {
    return {
      fips: current,
      name: String(els.marketplaceCountyName?.value || "").trim()
    };
  }

  const response = await fetch(marketplaceApiUrl(`/counties/by/zip/${encodeURIComponent(zipcode)}`, apiKey));
  if (!response.ok) throw new Error(await marketplaceResponseError(response, "County lookup failed"));
  const counties = normalizeMarketplaceCounties(await response.json());
  if (!counties.length) throw new Error("CMS Marketplace could not find a county for that ZIP code.");
  if (counties.length === 1) {
    els.marketplaceCountyFips.value = counties[0].fips;
    if (els.marketplaceCountyName) els.marketplaceCountyName.value = counties[0].name;
    saveStoredState();
    return counties[0];
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
              <td><button type="button" data-county-fips="${escapeAttr(county.fips)}" data-county-name="${escapeAttr(county.name)}">Use</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderMarketplacePlanResults(plans, { slcspMonthly = null, slcspPlan = null, ratingArea = "" } = {}) {
  const visiblePlans = plans.slice(0, 60);
  els.marketplacePlanResults.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Plan</th>
            <th>Plan ID</th>
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
              <td class="mono">${escapeHtml(plan.id || "")}</td>
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
    <p class="muted">SLCSP estimate from returned silver plans: ${Number.isFinite(slcspMonthly) ? moneyFormatter.format(slcspMonthly) : "not available"} monthly${slcspPlan?.name ? ` (${escapeHtml(marketplacePlanDisplayName(slcspPlan))})` : ""}.${ratingArea ? ` Rating area: ${escapeHtml(ratingArea)}.` : ""} Showing ${numberFormatter.format(visiblePlans.length)} of ${numberFormatter.format(plans.length)} plans.</p>
  `;
}

function handleMarketplacePlanSelection(event) {
  const countyButton = event.target.closest("[data-county-fips]");
  if (countyButton) {
    els.marketplaceCountyFips.value = countyButton.dataset.countyFips;
    if (els.marketplaceCountyName) els.marketplaceCountyName.value = countyButton.dataset.countyName || "";
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
  if (els.acaSelectedPlanId) els.acaSelectedPlanId.value = plan.id || "";
  if (els.acaSelectedPlanName) els.acaSelectedPlanName.value = marketplacePlanDisplayName(plan);
  els.oopMaxOverride.value = Number.isFinite(plan.oopMaximum) ? formatPlanInput(plan.oopMaximum) : "";
  els.acaBenchmarkMonthlyPremium.value = Number.isFinite(marketplaceSlcspMonthly)
    ? formatPlanInput(marketplaceSlcspMonthly)
    : "";
  if (els.acaBenchmarkPlanId) els.acaBenchmarkPlanId.value = marketplaceSlcspPlan?.id || "";
  if (els.acaBenchmarkPlanName) {
    els.acaBenchmarkPlanName.value = marketplaceSlcspPlan ? marketplacePlanDisplayName(marketplaceSlcspPlan) : "";
  }
  setAcaPlanLookupStatus(`${plan.name} filled as the primary ACA plan using gross Marketplace premiums for ${marketplaceLocalitySummary()}.`);
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
  if (els.acaBenchmarkPlanId) els.acaBenchmarkPlanId.value = marketplaceSlcspPlan?.id || "";
  if (els.acaBenchmarkPlanName) {
    els.acaBenchmarkPlanName.value = marketplaceSlcspPlan ? marketplacePlanDisplayName(marketplaceSlcspPlan) : "";
  }
  if (els.acaBackupPlanId) els.acaBackupPlanId.value = plan.id || "";
  els.acaBackupPlanName.value = marketplacePlanDisplayName(plan);
  setAcaPlanLookupStatus(`${plan.name} filled as the backup plan for future MAGI above the trigger for ${marketplaceLocalitySummary()}.`);
}

function marketplacePlanDisplayName(plan = {}) {
  return [plan.name, plan.issuer].filter(Boolean).join(" - ") || plan.id || "Marketplace plan";
}

function marketplaceLocalitySummary(zipcode = "", county = null) {
  const zip = String(zipcode || els.marketplaceZip?.value || "").trim();
  const countyName = String(county?.name || els.marketplaceCountyName?.value || "").trim();
  const countyFips = String(county?.fips || els.marketplaceCountyFips?.value || "").trim();
  const ratingArea = String(els.marketplaceRatingArea?.value || marketplaceRatingAreaLabel || "").trim();
  return [
    zip ? `ZIP ${zip}` : "",
    countyName ? countyName : countyFips ? `FIPS ${countyFips}` : "",
    ratingArea
  ].filter(Boolean).join(", ") || "the selected location";
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

function bindMonteCarloControls() {
  if (!els.mcPreset) return;

  els.mcSamplingMode?.addEventListener("change", () => {
    syncMonteCarloControls();
    saveStoredState();
  });

  els.mcPreset.addEventListener("change", () => {
    if (Object.prototype.hasOwnProperty.call(MONTE_CARLO_ASSUMPTION_PRESETS, els.mcPreset.value)) {
      applyMonteCarloPreset(els.mcPreset.value);
      saveStoredState();
    }
  });

  for (const fields of Object.values(MONTE_CARLO_ASSUMPTION_FIELD_IDS)) {
    for (const id of [fields.mean, fields.stdev]) {
      document.querySelector(`#${id}`)?.addEventListener("input", () => {
        if (els.mcPreset.value !== "custom") {
          els.mcPreset.value = "custom";
          saveStoredState();
        }
      });
    }
  }

  [
    els.mcShortTermMeanReversion,
    els.mcLongTermMeanReversion,
    els.mcLongTermReversionYears
  ].forEach((input) => {
    input?.addEventListener("input", saveStoredState);
    input?.addEventListener("change", saveStoredState);
  });
}

function applyMonteCarloPreset(presetId) {
  const preset = MONTE_CARLO_ASSUMPTION_PRESETS[presetId];
  if (!preset) return;
  for (const [assetClass, fields] of Object.entries(MONTE_CARLO_ASSUMPTION_FIELD_IDS)) {
    const assumption = preset[assetClass];
    if (!assumption) continue;
    setPercentInputValue(fields.mean, assumption.mean);
    setPercentInputValue(fields.stdev, assumption.stdev);
  }
}

function setPercentInputValue(id, decimalValue) {
  const input = document.querySelector(`#${id}`);
  if (!input || !Number.isFinite(decimalValue)) return;
  input.value = String(round(decimalValue * 100, 2));
}

function readMonteCarloReturnAssumptions() {
  return Object.fromEntries(
    Object.entries(MONTE_CARLO_ASSUMPTION_FIELD_IDS).map(([assetClass, fields]) => {
      const fallback = DEFAULT_SCENARIO.returnAssumptions[assetClass] ?? { mean: 0, stdev: 0 };
      return [
        assetClass,
        {
          mean: readPercentInput(fields.mean, fallback.mean),
          stdev: Math.max(0, readPercentInput(fields.stdev, fallback.stdev))
        }
      ];
    })
  );
}

function readMonteCarloMeanReversion() {
  return {
    shortTermStrength: readPercentInput("mcShortTermMeanReversion", DEFAULT_MONTE_CARLO_MEAN_REVERSION.shortTermStrength),
    longTermStrength: readPercentInput("mcLongTermMeanReversion", DEFAULT_MONTE_CARLO_MEAN_REVERSION.longTermStrength),
    longTermYears: Math.max(2, Math.min(30, Math.trunc(Number(els.mcLongTermReversionYears?.value) || DEFAULT_MONTE_CARLO_MEAN_REVERSION.longTermYears)))
  };
}

function normalizeMonteCarloSamplingMode(value) {
  return ["correlated", "meanRevertingCorrelated", "independent"].includes(value) ? value : DEFAULT_SCENARIO.monteCarlo.samplingMode;
}

function readPercentInput(id, fallback) {
  const value = Number(document.querySelector(`#${id}`)?.value);
  return Number.isFinite(value) ? value / 100 : fallback;
}

function loadStoredState() {
  if (!rememberSetupEnabled) return;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!stored || typeof stored !== "object") return;
    applySetupState(stored);
  } catch (error) {
    console.warn("Saved state could not be loaded.", error);
  }
}

function handleWorkspaceControlChange(event) {
  if (event?.target?.id === "marketplaceZip") {
    handleZipCodeChange();
  }
  if (event?.target?.id === "privacyMode") {
    updatePrivacyModeControls({ announce: true });
  }
  if (!applyingRescueScenario) {
    appliedRescueScenarioOverride = null;
  }
  saveStoredState();
}

function handleZipCodeChange() {
  const zip = String(els.marketplaceZip?.value || "").trim();
  if (zip.length < 3) return;

  const geo = resolveZip(zip);
  if (!geo.state) {
    if (geo.fallback === "military") {
      setAcaPlanLookupStatus("APO/FPO military ZIP code is out of model for Marketplace plans.", true);
    } else if (geo.fallback === "territory") {
      setAcaPlanLookupStatus("U.S. territories are out of model for Marketplace plans.", true);
    }
    return;
  }

  // Autofill the state select and fire a change so state-derived UI updates
  // (setting .value alone does not dispatch an event).
  if (els.stateSelect && els.stateSelect.value !== geo.state) {
    els.stateSelect.value = geo.state;
    els.stateSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Describe what the offline benchmark will actually do. Only states the SBE
  // module covers resolve to an offline rating-area benchmark; the rest (incl.
  // state-based exchanges we have not ingested, like GA/VA, and SBM-FP states
  // like IL) use the state-level fallback even though they aren't HealthCare.gov.
  const portal = geo.exchange?.portal;
  if (geo.exchange?.type === "stateBased" && isSbeState(geo.stateAbbreviation)) {
    setAcaPlanLookupStatus(
      `Resolved ZIP ${zip} to ${geo.state}${portal ? ` (${portal})` : ""}. Using the offline state-based-exchange rating-area benchmark.`
    );
  } else if (geo.exchange?.type === "stateBased") {
    setAcaPlanLookupStatus(
      `Resolved ZIP ${zip} to ${geo.state}${portal ? ` (${portal})` : ""}. Rating-area data isn't bundled for this exchange yet, so the model uses the state-level benchmark.`
    );
  } else if (geo.exchange?.type === "stateBasedFederal") {
    setAcaPlanLookupStatus(
      `Resolved ZIP ${zip} to ${geo.state}${portal ? ` (${portal} on HealthCare.gov)` : ""}.`
    );
  } else {
    setAcaPlanLookupStatus(`Resolved ZIP ${zip} to ${geo.state} (HealthCare.gov).`);
  }
}

function saveStoredState(options = {}) {
  const shouldMarkDirty = options?.markDirty !== false;
  if (!rememberSetupEnabled) {
    removeStoredSetupState();
    if (shouldMarkDirty) markWorkspaceDirty();
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setupStateSnapshot()));
  } catch (error) {
    console.warn("Saved state could not be written.", error);
  }
  if (shouldMarkDirty) markWorkspaceDirty();
}

function markWorkspaceDirty() {
  // Any setup change implies workspace inputs were edited. runModels
  // clears this flag at the start of each run so post-run callers can tell
  // whether the displayed results reflect the current inputs.
  workspaceDirty = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("psl:workspace-dirty"));
  }
}

function setAcaPlanLookupStatus(message, isError = false) {
  paintStatus(els.acaPlanLookupStatus, message, isError);
  if (els.acaPlanLookupStatus) {
    els.acaPlanLookupStatus.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function setupStateSnapshot() {
  const redesign = typeof window.__pslRedesignStateSnapshot === "function"
    ? window.__pslRedesignStateSnapshot()
    : null;
  return {
    controls: readControlState(),
    decisionProfile: decisionProfileStateSnapshot(),
    assets,
    oneOffExpenses,
    incomeStreams,
    ...(redesign ? { redesign } : {})
  };
}

function decisionProfileStateSnapshot() {
  const targetPercent = numberOrNull(els.decisionTargetSuccessRate?.value);
  return {
    mode: "recentlyLeftWork",
    requiredSpend: numberOrNull(els.decisionRequiredSpend?.value),
    flexibleSpend: numberOrNull(els.decisionFlexibleSpend?.value),
    targetSuccessRate: targetPercent == null ? 0.9 : Math.max(1, Math.min(99, targetPercent)) / 100,
    targetSuccessRateUserOverridden: targetPercent != null && Math.abs(targetPercent - 90) > 0.001,
    verdictObjective: "avoidDepletion",
    evidenceWeights: { monteCarlo: 0.5, historical: 0.5 },
    incomeBridge: {
      enabled: els.decisionIncomeBridgeEnabled?.checked !== false,
      startYear: 1,
      maxYears: 6,
      maxAnnualIncome: 150000,
      incomeType: "medicareWages"
    },
    healthcarePriority: els.stateSelect?.value === "Massachusetts" ? "preserveConnectorCare" : "preserveAcaSubsidy",
    healthcarePlanSelection: {
      mode: els.stateSelect?.value === "Massachusetts" ? "maConnectorCarePlanType" : "manualOrMarketplace",
      selectedPlanId: els.maConnectorCarePlanType?.value || null
    },
    share: {
      mode: "deferred",
      allowInputTweaks: false
    }
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
  if (Array.isArray(stored.incomeStreams)) {
    incomeStreams = stored.incomeStreams.map((stream) => ({ ...stream }));
  }

  for (const [id, value] of Object.entries(stored.controls ?? {})) {
    const input = document.querySelector(`#${id}`);
    if (!input || input.type === "file") continue;
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = value ?? "";
    }
  }

  if (stored.decisionProfile && typeof stored.decisionProfile === "object") {
    if (stored.controls?.decisionRequiredSpend == null && els.decisionRequiredSpend) {
      els.decisionRequiredSpend.value = stored.decisionProfile.requiredSpend ?? "";
    }
    if (stored.controls?.decisionFlexibleSpend == null && els.decisionFlexibleSpend) {
      els.decisionFlexibleSpend.value = stored.decisionProfile.flexibleSpend ?? "";
    }
    if (stored.controls?.decisionTargetSuccessRate == null && els.decisionTargetSuccessRate) {
      const rate = Number(stored.decisionProfile.targetSuccessRate);
      els.decisionTargetSuccessRate.value = Number.isFinite(rate) ? String(Math.round(rate * 100)) : "90";
    }
  }
  updatePrivacyModeControls();
}

function applyRescueScenarioToWorkspace(scenario = {}, { label = "rescue scenario", changes = [] } = {}) {
  if (!scenario || typeof scenario !== "object") {
    return { applied: false, changed: [] };
  }
  applyingRescueScenario = true;
  try {
    applyScenarioControls(scenario);
    if (Array.isArray(scenario.oneOffExpenses)) {
      oneOffExpenses = scenario.oneOffExpenses.map((expense) => ({ ...expense }));
      renderOneOffs();
    }
    if (Array.isArray(scenario.incomeStreams)) {
      incomeStreams = scenario.incomeStreams.map((stream) => ({ ...stream }));
      renderIncomeStreams();
    }
    appliedRescueScenarioOverride = extractRescueScenarioOverride(scenario);
    syncSpendingStrategyControls();
    saveStoredState();
  } finally {
    applyingRescueScenario = false;
  }

  const appliedChanges = Array.isArray(changes) ? changes : [];
  const suffix = appliedChanges.length ? ` Applied: ${appliedChanges.slice(0, 3).join("; ")}${appliedChanges.length > 3 ? "; ..." : ""}` : "";
  setStatus(`Applied ${label} to the workspace.${suffix}`);
  window.dispatchEvent(new CustomEvent("psl:rescue-scenario-applied", {
    detail: { label, scenario, changes: appliedChanges }
  }));
  return { applied: true, changed: appliedChanges };
}

function applyScenarioControls(scenario) {
  setNumberControl("targetSpend", scenario.targetSpend);
  setCheckedControl("includeTaxes", scenario.targetSpendIncludesTaxes);
  setCheckedControl("includeMedical", scenario.targetSpendIncludesMedical);
  setNumberControl("medicalBase", scenario.medicalExpensesBase);
  setNumberControl("primaryMortalityAge", scenario.primaryMortalityAge);
  setNumberControl("spouseMortalityAge", scenario.spouseMortalityAge);

  const spending = scenario.spendingStrategy ?? {};
  setValueControl("spendingStrategyMode", spending.mode);
  setNumberControl("essentialSpend", spending.essentialSpend);
  setNumberControl("discretionarySpend", spending.discretionarySpend);
  setPercentControl("guardrailCorrectionDiscretionaryPercent", spending.correctionDiscretionaryPercent);
  setPercentControl("guardrailBearDiscretionaryPercent", spending.bearDiscretionaryPercent);
  const riskGuardrails = spending.riskBasedGuardrails ?? {};
  setPercentControl("riskGuardrailTargetSuccessRate", riskGuardrails.targetSuccessRate);
  setPercentControl("riskGuardrailLowerSuccessRate", riskGuardrails.lowerSuccessRate);
  setPercentControl("riskGuardrailUpperSuccessRate", riskGuardrails.upperSuccessRate);
  setPercentControl("riskGuardrailMinimumAdjustmentPercent", riskGuardrails.minimumAdjustmentPercent);
  setNumberControl("riskGuardrailIncomeFloor", riskGuardrails.incomeFloor);
  setNumberControl("riskGuardrailIncomeCeiling", riskGuardrails.incomeCeiling);
  if (Number.isFinite(Number(spending.essentialSpend)) && Number.isFinite(Number(spending.discretionarySpend))) {
    setNumberControl("decisionRequiredSpend", spending.essentialSpend);
    setNumberControl("decisionFlexibleSpend", spending.discretionarySpend);
  }

  const reserve = scenario.sequenceRiskReserve ?? {};
  setValueControl("sequenceReserveMode", reserve.enabled === false ? "none" : reserve.mode);
  setNumberControl("sequenceReserveTargetYears", reserve.targetYears);
  setNumberControl("sequenceReserveTentYears", reserve.tentYears);
  setCheckedControl("tipsLadderEnabled", scenario.tipsLadder?.enabled);
  setOptionalNumberControl("tipsLadderYears", scenario.tipsLadder?.years);
  setOptionalNumberControl("tipsLadderAnnualAmount", scenario.tipsLadder?.annualRealAmount);
  setOptionalNumberControl("tipsLadderRealYieldPercent", scenario.tipsLadder?.realYieldPercent);
  setValueControl("tipsLadderMaintenanceMode", scenario.tipsLadder?.maintenanceMode ?? "none");
  setCheckedControl("tipsLadderReplenishCatchUp", scenario.tipsLadder?.replenishCatchUp !== false);
  setNumberControl("tipsLadderTriggerStockReturnPercent", scenario.tipsLadder?.triggerStockReturnPercent ?? 0);

  const allocation = scenario.allocationStrategy ?? {};
  setCheckedControl("allocationAwareWithdrawals", allocation.withdrawalBiasEnabled);
  setCheckedControl("taxAwareRebalancing", allocation.rebalanceEnabled);
  setCheckedControl("equityGlidepath", allocation.glidepathEnabled);
  setNumberControl("targetStockAllocation", allocation.targetStockPercent);
  setNumberControl("rebalanceBand", allocation.rebalanceBandPercent);
  setNumberControl("glidepathStartStockAllocation", allocation.glidepathStartStockPercent);
  setNumberControl("glidepathEndStockAllocation", allocation.glidepathEndStockPercent);
  setNumberControl("glidepathYears", allocation.glidepathYears);

  setValueControl("withdrawalStrategyMode", scenario.withdrawalStrategy?.mode);
  if (Array.isArray(scenario.withdrawalOrder)) {
    setValueControl("withdrawalOrder", scenario.withdrawalOrder.join(","));
  }
  setCheckedControl("taxLossHarvesting", scenario.taxLossHarvesting?.enabled);
  setCheckedControl("taxGainHarvesting", scenario.taxGainHarvesting?.enabled);
  setNumberControl("taxGainMagiBuffer", scenario.taxGainHarvesting?.magiBuffer);
  setCheckedControl("rothConversion", scenario.rothConversion?.enabled);
  setCheckedControl("rothConversionOptimizeForAca", scenario.rothConversion?.optimizeForAca);
  setCheckedControl("rothConversionMagiGuardrails", scenario.rothConversion?.applyMagiGuardrails);
  setCheckedControl("rothConversionSpendingAware", scenario.rothConversion?.spendingAware);
  setCheckedControl("rothConversionSpendFromBasis", scenario.rothConversion?.spendFromBasis);
  setOptionalNumberControl("rothAmount", scenario.rothConversion?.mode === "manual" ? scenario.rothConversion?.overrideAmount : null);
  if (Number.isFinite(Number(scenario.rothConversion?.targetMarginalRate))) {
    setNumberControl("rothTargetRate", Number(scenario.rothConversion.targetMarginalRate) * 100);
  }
  if (Number.isFinite(Number(scenario.heirOrdinaryTaxRate))) {
    setNumberControl("heirOrdinaryTaxRate", Number(scenario.heirOrdinaryTaxRate) * 100);
  }
  setNumberControl("rothConversionMaxAcaFplPercent", scenario.rothConversion?.maxAcaFplPercent);
  setNumberControl("rothConversionMagiBuffer", scenario.rothConversion?.magiBuffer);
  setCheckedControl("rothBasisOptimization", scenario.rothBasisOptimization?.enabled);
  setNumberControl("rothBasisMagiBuffer", scenario.rothBasisOptimization?.magiBuffer);
  setValueControl("rothBasisOpportunityCostMode", scenario.rothBasisOptimization?.opportunityCostMode);

  setNumberControl("socialSecurityAnnualBenefit", scenario.socialSecurityAnnualBenefit);
  setNumberControl("socialSecurityStartAge", scenario.socialSecurityStartAge);
  setCheckedControl("socialSecurityInflationAdjusted", scenario.socialSecurityInflationAdjusted);
  setNumberControl("spouseSocialSecurityAnnualBenefit", scenario.spouseSocialSecurityAnnualBenefit);
  setNumberControl("spouseSocialSecurityStartAge", scenario.spouseSocialSecurityStartAge);
  setCheckedControl("spouseSocialSecurityInflationAdjusted", scenario.spouseSocialSecurityInflationAdjusted);
  setNumberControl("medicareWages", scenario.medicareWages);
  setOptionalNumberControl("socialSecurityWages", scenario.socialSecurityWages);
  setNumberControl("selfEmploymentIncome", scenario.selfEmploymentIncome);
  setNumberControl("rrtaCompensation", scenario.rrtaCompensation);
  setNumberControl("spouseMedicareWages", scenario.spouseMedicareWages);
  setOptionalNumberControl("spouseSocialSecurityWages", scenario.spouseSocialSecurityWages);
  setNumberControl("spouseSelfEmploymentIncome", scenario.spouseSelfEmploymentIncome);
  setCheckedControl("estimateSocialSecurityFromEarnings", scenario.estimateSocialSecurityFromEarnings);
  setCheckedControl("earnedIncomeInflationAdjusted", scenario.earnedIncomeInflationAdjusted);
  setValueControl("heirType", scenario.heirType);
  if (Number.isFinite(scenario.nonSpouse10YrTaxDrag)) {
    setNumberControl("nonSpouse10YrTaxDrag", scenario.nonSpouse10YrTaxDrag * 100);
  }
  if (Number.isFinite(scenario.eligibleDesignatedTaxDiscount)) {
    setNumberControl("eligibleDesignatedTaxDiscount", scenario.eligibleDesignatedTaxDiscount * 100);
  }
  setNumberControl("heirBaseIncome", scenario.heirBaseIncome ?? 80000);
  setNumberControl("heirAge", scenario.heirAge ?? 30);
  setValueControl("heirState", scenario.heirState ?? "");
  setCheckedControl("irmaaEnabled", scenario.medicare?.irmaaEnabled);
  setOptionalNumberControl("medicarePartBEnrollees", scenario.medicare?.partBEnrollees);
  setOptionalNumberControl("medicarePartDEnrollees", scenario.medicare?.partDEnrollees);
  setOptionalNumberControl("medicarePartDMonthlyPremium", scenario.medicare?.partDMonthlyPremium);
  setOptionalNumberControl("medicareMedigapMonthlyPremium", scenario.medicare?.medigapMonthlyPremium);
  setOptionalNumberControl("medicareAnnualOopBase", scenario.medicare?.annualOopBase);
  setOptionalNumberControl("rmdSpouseStartAge", scenario.rmd?.spouseStartAge);
  setCheckedControl("agePhasedSpending", scenario.agePhasedSpending?.enabled);
  setOptionalNumberControl("slowGoAge", scenario.agePhasedSpending?.slowGoAge);
  setOptionalNumberControl("slowGoPercent", scenario.agePhasedSpending?.slowGoPercent);
  setOptionalNumberControl("noGoAge", scenario.agePhasedSpending?.noGoAge);
  setOptionalNumberControl("noGoPercent", scenario.agePhasedSpending?.noGoPercent);
  setCheckedControl("ltcStressEnabled", scenario.ltcStress?.enabled);
  setValueControl("ltcStressMember", scenario.ltcStress?.member ?? "primary");
  setOptionalNumberControl("ltcStressStartAge", scenario.ltcStress?.startAge);
  setOptionalNumberControl("ltcStressYears", scenario.ltcStress?.years);
  setOptionalNumberControl("ltcStressAnnualCost", scenario.ltcStress?.annualCost);
  setCheckedControl("survivorStepUpEnabled", scenario.survivorStepUp?.enabled);
  setOptionalNumberControl("survivorStepUpJointPercent", scenario.survivorStepUp?.jointBasisStepUpPercent);
  setValueControl("heirTaxIndexing", scenario.heirTaxIndexing === "frozen2026" ? "frozen2026" : "indexed");
  if (Number.isFinite(Number(scenario.monteCarlo?.inflationPersistence))) {
    setNumberControl("mcInflationPersistence", Math.round(Number(scenario.monteCarlo.inflationPersistence) * 100));
  }
  setOptionalNumberControl("twoYearsPriorMagi", scenario.medicare?.twoYearsPriorMagi);
  setOptionalNumberControl("priorYearMagi", scenario.medicare?.priorYearMagi);
  setOptionalNumberControl("maxIrmaaTier", scenario.medicare?.maxIrmaaTier);
  setCheckedControl("mfsLivedTogether", scenario.medicare?.marriedFilingSeparatelyLivedTogether);

  const taxEfficiency = scenario.taxEfficiencyStrategy ?? {};
  setCheckedControl("unifiedMarginalOptimizer", taxEfficiency.marginalRateOptimizationEnabled);
  setCheckedControl("assetLocationOptimization", taxEfficiency.assetLocationEnabled);
  setCheckedControl("hsaContributionStrategy", taxEfficiency.hsaContributionEnabled);
  setValueControl("hsaCoverage", taxEfficiency.hsaCoverage);
  setOptionalNumberControl("hsaContributionAmount", taxEfficiency.hsaAnnualContribution);
  setCheckedControl("hsaQualifiedExpenseLimit", taxEfficiency.hsaUseForQualifiedExpenses);
}

function extractRescueScenarioOverride(scenario = {}) {
  const keys = [
    "targetSpend",
    "spendingStrategy",
    "sequenceRiskReserve",
    "tipsLadder",
    "allocationStrategy",
    "withdrawalStrategy",
    "withdrawalOrder",
    "taxLossHarvesting",
    "taxGainHarvesting",
    "rothConversion",
    "rothBasisOptimization",
    "medicare",
    "socialSecurityStartAge",
    "socialSecurityAnnualBenefit",
    "spouseSocialSecurityStartAge",
    "spouseSocialSecurityAnnualBenefit",
    "spouseMedicareWages",
    "spouseSocialSecurityWages",
    "spouseSelfEmploymentIncome",
    "estimateSocialSecurityFromEarnings",
    "earnedIncomeInflationAdjusted",
    "taxEfficiencyStrategy",
    "primaryMortalityAge",
    "spouseMortalityAge",
    "heirType",
    "nonSpouse10YrTaxDrag",
    "eligibleDesignatedTaxDiscount",
    "heirBaseIncome",
    "heirAge",
    "heirState"
  ];
  const override = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(scenario, key)) {
      override[key] = cloneJsonSafe(scenario[key]);
    }
  }
  return override;
}

function cloneJsonSafe(value) {
  if (Array.isArray(value)) return value.map(cloneJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJsonSafe(item)]));
  }
  return value;
}

function setValueControl(id, value) {
  if (value == null) return;
  const input = document.querySelector(`#${id}`);
  if (!input || input.type === "file") return;
  input.value = String(value);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNumberControl(id, value) {
  if (!Number.isFinite(Number(value))) return;
  setValueControl(id, round(Number(value), 4));
}

function setOptionalNumberControl(id, value) {
  if (value == null || !Number.isFinite(Number(value))) {
    setValueControl(id, "");
    return;
  }
  setNumberControl(id, value);
}

function setPercentControl(id, value) {
  if (!Number.isFinite(Number(value))) return;
  setNumberControl(id, Number(value) * 100);
}

function setCheckedControl(id, value) {
  if (typeof value !== "boolean") return;
  const input = document.querySelector(`#${id}`);
  if (!input || input.type !== "checkbox") return;
  input.checked = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
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

// ─── Simulation worker plumbing ──────────────────────────────────────
// Heavy work (Monte Carlo + backtests) runs off the main thread so the
// page stays responsive. We lazy-create one worker and reuse it; in-flight
// requests are tagged with an id so a stale response from a superseded run
// is ignored.
function getSimulationWorker() {
  if (!simulationWorker) {
    simulationWorker = new Worker(
      new URL("./core/simulation.worker.mjs?v=20260612-aca-conversions", import.meta.url),
      { type: "module" }
    );
    simulationWorker.addEventListener("error", (ev) => {
      console.error("Simulation worker error:", ev.message || ev);
    });
  }
  return simulationWorker;
}

function cancelActiveSimulationRun() {
  activeSimulationRequestId = ++simulationRequestId;
  pendingRerunRequested = false;
  activeSimulationCancel?.();
  activeSimulationCancel = null;
  if (simulationWorker) {
    simulationWorker.terminate();
    simulationWorker = null;
  }
}

function runSimulationsInWorker({
  assets, scenario, taxProfile, runs, seed, sequences, decisionProfile,
  onPlan, onBacktests, onScenarios, onProgress, onDecisionProgress, onDecision
}) {
  const worker = getSimulationWorker();
  const id = ++simulationRequestId;
  activeSimulationRequestId = id;
  return new Promise((resolve, reject) => {
    let settled = false;
    function cleanup() {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (activeSimulationCancel === cancel) activeSimulationCancel = null;
    }
    function settle() {
      if (settled) return false;
      settled = true;
      cleanup();
      return true;
    }
    function cancel() {
      if (settle()) reject(new Error(RUN_CANCELED_MESSAGE));
    }
    function onMessage(ev) {
      const msg = ev.data;
      if (!msg || msg.id !== id) return;
      if (id !== activeSimulationRequestId) {
        if (msg.type === "result" || msg.type === "error") settle();
        return;
      }
      if (msg.type === "plan-ready") {
        onPlan?.(msg.plan);
      } else if (msg.type === "backtests-ready") {
        onBacktests?.(msg.backtests);
      } else if (msg.type === "scenarios-batch") {
        onScenarios?.({ scenarios: msg.scenarios, done: msg.done, total: msg.total });
        onProgress?.({ phase: "monteCarlo", done: msg.done, total: msg.total });
      } else if (msg.type === "decision-progress") {
        onDecisionProgress?.(msg.progress);
      } else if (msg.type === "decision-ready") {
        onDecision?.(msg.decision);
      } else if (msg.type === "result") {
        if (settle()) resolve({ summary: msg.summary });
      } else if (msg.type === "error") {
        const err = new Error(msg.message || "Simulation worker failed");
        if (msg.stack) err.stack = msg.stack;
        if (settle()) reject(err);
      }
    }
    function onError(ev) {
      if (settle()) reject(new Error(ev.message || "Simulation worker crashed"));
    }
    activeSimulationCancel = cancel;
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ type: "run", id, payload: { assets, scenario, taxProfile, runs, seed, sequences, decisionProfile } });
  });
}

async function runModels(opts = {}) {
  // If a run is already in flight, queue another so the user's freshly-edited
  // inputs aren't dropped — the queued run starts as soon as this one finishes.
  if (runModelsBusy) {
    if (opts.cancelActive === true) {
      cancelActiveSimulationRun();
    } else {
      pendingRerunRequested = true;
      return;
    }
  }
  const runToken = ++runModelsToken;
  runModelsBusy = true;
  pendingRerunRequested = false;
  // Stream by default. Silent mode (no UI swap until done) is used by
  // initialize() when cached results are already painted: the background
  // re-run shouldn't wipe the user's last view with placeholders.
  const stream = opts.stream !== false;
  try {
    const started = performance.now();
    const scenario = readScenario();
    const planningValidation = validateUserPlanningScenario(scenario);
    if (!planningValidation.ok) {
      const validationError = planningValidation.errors[0];
      setStatus(validationError.message, true);
      focusPlanningValidationError(validationError);
      window.dispatchEvent(new CustomEvent("psl:run-progress", { detail: { error: true, validation: true } }));
      return;
    }
    saveStoredState();
    const taxProfile = readTaxProfile();
    const decisionProfile = readDecisionProfile(scenario);
    const runs = clampInteger(Number(els.runs.value), 10, 5000);
    const seed = Number(els.seed.value) || 42;
    const historicalDataSource = readHistoricalDataSource();
    const historicalAssetClasses = assetClassesInPortfolio(assets);
    const historicalProxies = historicalProxyMapForControls(historicalAssetClasses);
    const strictHistoricalCoverage = historicalCoverageForAssetClasses(historicalAssetClasses, { historicalDataSource });
    const historicalCoverage = historicalCoverageForAssetClasses(historicalAssetClasses, { assetClassProxies: historicalProxies, historicalDataSource });
    reconcileHistoricalRangeControls({ coverage: historicalCoverage, strictCoverage: strictHistoricalCoverage, proxies: historicalProxies });
    const historicalRange = readHistoricalRange(historicalCoverage);
    const historicalSequences = makeHistoricalSequences({
      planYears: scenario.planYears,
      mode: els.backtestMode.value,
      startYear: historicalRange.startYear,
      endYear: historicalRange.endYear,
      chunkYears: Number(els.historicalChunkYears.value) || 10,
      requiredAssetClasses: historicalAssetClasses,
      assetClassProxies: historicalProxies,
      historicalDataSource
    });

    setStatus("Running projections...");
    workspaceDirty = false;
    let firstScenarioId = null;
    // Buffer used when stream=false so the cached display stays put until
    // we have the full new result.
    const confidenceContext = () => ({
      scenario,
      taxProfile,
      decision: latest?.decision ?? buffered.decision,
      plan: latest?.plan ?? buffered.plan,
      historicalCoverage,
      historicalAssetClasses
    });
    const buffered = { plan: null, backtests: [], scenarios: [], decision: null };

    if (stream) {
      selectedBacktestIndex = null;
      latest = {
        assets: assets.map((a) => ({ ...a })),
        seed,
        scenario,
        taxProfile,
        historicalCoverage,
        historicalAssetClasses,
        historicalProxies,
        historicalDataSource,
        historicalRange,
        historicalMode: els.backtestMode.value,
        plan: null,
        decision: { status: "running" },
        confidence: buildConfidenceReport({ scenario, taxProfile, historicalCoverage, historicalAssetClasses }),
        monteCarlo: {
          scenarios: [],
          summary: null,
          progress: { done: 0, total: runs, complete: false }
        },
        backtests: []
      };
      selectedYearIndex = Math.min(selectedYearIndex, scenario.planYears - 1);
      els.yearRange.max = String(scenario.planYears);
      els.yearRange.value = String(selectedYearIndex + 1);

      window.dispatchEvent(new CustomEvent("psl:run-start", { detail: { runs } }));
      renderLatest({ streaming: true });
    }
    window.dispatchEvent(new CustomEvent("psl:run-progress", {
      detail: { phase: "monteCarlo", done: 0, total: runs }
    }));

    const result = await runSimulationsInWorker({
      assets,
      scenario,
      taxProfile,
      runs,
      seed,
      sequences: historicalSequences,
      decisionProfile,
      onPlan: (plan) => {
        if (stream) {
          if (!latest) return;
          latest.plan = plan;
          latest.confidence = buildConfidenceReport(confidenceContext());
          renderLatest({ streaming: true });
        } else {
          buffered.plan = plan;
        }
      },
      onBacktests: (backtests) => {
        if (stream) {
          if (!latest) return;
          latest.backtests = backtests;
          renderLatest({ streaming: true });
        } else {
          buffered.backtests = backtests;
        }
      },
      onScenarios: ({ scenarios, done, total }) => {
        if (stream) {
          if (!latest) return;
          latest.monteCarlo.scenarios.push(...scenarios);
          latest.monteCarlo.progress = { done, total, complete: false };
          if (firstScenarioId == null && latest.monteCarlo.scenarios[0]) {
            firstScenarioId = latest.monteCarlo.scenarios[0].id;
            selectedScenarioId = firstResultWithYears(latest.monteCarlo.scenarios)?.id ?? null;
            // First MC scenario landed — redesign.mjs uses this to swap to
            // the results screen so the user sees something live.
            window.dispatchEvent(new CustomEvent("psl:first-scenario-ready"));
          }
          renderLatest({ streaming: true });
        } else {
          buffered.scenarios.push(...scenarios);
        }
      },
      onDecisionProgress: (progress) => {
        const runningDecision = {
          status: "running",
          progress: mergeDecisionProgress(stream ? latest?.decision : buffered.decision, progress)
        };
        if (stream) {
          if (!latest) return;
          latest.decision = runningDecision;
          latest.confidence = buildConfidenceReport(confidenceContext());
          setStatus(`Solving rescue options... ${progress.done} candidates tested.`);
          renderLatest({ streaming: true });
        } else {
          buffered.decision = runningDecision;
        }
      },
      onDecision: (decision) => {
        if (stream) {
          if (!latest) return;
          latest.decision = decision;
          latest.confidence = buildConfidenceReport(confidenceContext());
          renderLatest({ streaming: true });
        } else {
          buffered.decision = decision;
        }
      },
      onProgress: ({ phase, done, total }) => {
        window.dispatchEvent(new CustomEvent("psl:run-progress", {
          detail: { phase, done, total }
        }));
      }
    });

    if (stream) {
      latest.monteCarlo.summary = result.summary;
      latest.monteCarlo.progress = { done: runs, total: runs, complete: true };
      latest.confidence = buildConfidenceReport(confidenceContext());
      if (selectedScenarioId == null) {
        selectedScenarioId = firstResultWithYears(latest.monteCarlo.scenarios)?.id ?? null;
      }
    } else {
      latest = {
        assets: assets.map((a) => ({ ...a })),
        seed,
        scenario,
        taxProfile,
        historicalCoverage,
        historicalAssetClasses,
        historicalProxies,
        historicalDataSource,
        historicalRange,
        historicalMode: els.backtestMode.value,
        plan: buffered.plan,
        decision: buffered.decision,
        confidence: buildConfidenceReport({
          scenario,
          taxProfile,
          decision: buffered.decision,
          plan: buffered.plan,
          historicalCoverage,
          historicalAssetClasses
        }),
        monteCarlo: {
          scenarios: buffered.scenarios,
          summary: result.summary,
          progress: { done: runs, total: runs, complete: true }
        },
        backtests: buffered.backtests
      };
      selectedYearIndex = Math.min(selectedYearIndex, scenario.planYears - 1);
      els.yearRange.max = String(scenario.planYears);
      els.yearRange.value = String(selectedYearIndex + 1);
      selectedScenarioId = firstResultWithYears(latest.monteCarlo.scenarios)?.id ?? null;
      selectedBacktestIndex = null;
    }
    if (runToken !== runModelsToken) return;
    renderLatest({ streaming: false });
    window.dispatchEvent(new CustomEvent("psl:run-complete"));
    setStatus(`Completed ${runs} Monte Carlo runs and ${latest.backtests.length} historical backtests in ${Math.round(performance.now() - started)} ms.${historicalCompletionNote()}`);
  } catch (error) {
    if (error?.message !== RUN_CANCELED_MESSAGE && runToken === runModelsToken) {
      console.error(error);
      setStatus(error.message, true);
      window.dispatchEvent(new CustomEvent("psl:run-progress", { detail: { error: true } }));
    }
  } finally {
    if (runToken !== runModelsToken) return;
    runModelsBusy = false;
    activeSimulationCancel = null;
    if (pendingRerunRequested) {
      pendingRerunRequested = false;
      setTimeout(() => runModels(), 0);
    }
  }
}

function mergeDecisionProgress(previousDecision, progress = {}) {
  const priorCandidates = Array.isArray(previousDecision?.progress?.candidates)
    ? previousDecision.progress.candidates
    : [];
  const candidates = [...priorCandidates];
  if (progress.candidate) {
    candidates.push(progress.candidate);
  }
  return {
    ...progress,
    candidates
  };
}

function renderLatest(options = {}) {
  if (!latest) return;
  const streaming = !!options.streaming;
  // Streaming flushes can arrive faster than the browser can paint. Coalesce
  // them onto the next animation frame so the UI stays responsive while a
  // 5k-run sim is still flowing.
  if (streaming) {
    if (streamingRenderRaf) return;
    streamingRenderRaf = requestAnimationFrame(() => {
      streamingRenderRaf = 0;
      paintLatest(true);
    });
    return;
  }
  if (streamingRenderRaf) {
    cancelAnimationFrame(streamingRenderRaf);
    streamingRenderRaf = 0;
  }
  paintLatest(false);
}

function paintLatest(streaming) {
  if (!latest) return;
  clampSelectedYearToVisible();
  if (latest.plan) {
    renderKpis();
    renderAuditPanel();
    renderFlowAndSales();
    drawTimeline();
    renderYearTable();
    renderAssetBreakdown();
  }
  drawDistribution();
  renderScenarioTable();
  renderBacktests();
  if (!latest.plan) renderAuditPanel();
  // Only cache final, complete results — mid-run partials would thrash
  // sessionStorage and a refresh during a stream is supposed to start over.
  let cacheOk = true;
  if (!streaming && latest.monteCarlo?.progress?.complete) {
    cacheOk = rememberSetupEnabled ? cacheLatestResults(latest) : false;
    if (!rememberSetupEnabled) clearCachedLatest();
  }
  if (typeof window !== "undefined") {
    window.__pslLatest = latest;
    window.dispatchEvent(new CustomEvent("psl:cache-status", { detail: { cached: cacheOk } }));
    window.dispatchEvent(new CustomEvent("psl:render-latest", { detail: { streaming } }));
  }
}


if (typeof window !== "undefined") {
  // Expose for redesign.mjs's "view results" flow — it forces a re-run when
  // workspace inputs changed since the last completed run.
  window.__pslIsWorkspaceDirty = () => workspaceDirty;
  window.__pslRunModels = (opts) => runModels(opts);
  window.__pslSelectHistoricalBacktest = (index) => selectHistoricalBacktest(index);
  window.__pslApplyRescueScenarioToWorkspace = (scenario, options) => applyRescueScenarioToWorkspace(scenario, options);
}

// Returns the Monte Carlo summary if the run completed, otherwise recomputes
// a "preliminary" summary from the scenarios accumulated so far. Returns
// null only when there are no scenarios yet at all.
function effectiveMonteCarloSummary() {
  const mc = latest?.monteCarlo;
  if (!mc) return null;
  if (mc.summary) return mc.summary;
  const scenarios = mc.scenarios ?? [];
  if (!scenarios.length) return null;
  const endingValues = scenarios.map((s) => s.endingValue);
  const heirValues = scenarios.map((s) => s.heirValue);
  const sortedEnding = [...endingValues].sort((a, b) => a - b);
  const sortedHeir = [...heirValues].sort((a, b) => a - b);
  const pct = (sorted, p) => sorted.length
    ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))]
    : 0;
  return {
    runs: scenarios.length,
    successRate: scenarios.filter((s) => s.success).length / scenarios.length,
    medianEndingValue: pct(sortedEnding, 0.5),
    p10EndingValue: pct(sortedEnding, 0.1),
    p90EndingValue: pct(sortedEnding, 0.9),
    medianHeirValue: pct(sortedHeir, 0.5),
    preliminary: true
  };
}

function renderAuditPanel() {
  if (!els.auditPanel) return;
  const scenario = latest?.scenario;
  if (!scenario) {
    els.auditPanel.innerHTML = `<p class="empty-state">Run a model to see the audit trail.</p>`;
    return;
  }

  const rows = auditRowsForScenario(scenario);

  els.auditPanel.innerHTML = `
    <dl class="audit-list">
      ${rows.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `).join("")}
    </dl>
  `;
}

function auditRowsForScenario(scenario) {
  return [
    ["Dollar basis", dollarAuditLine()],
    ["Tax assumptions", taxAuditLine(scenario)],
    ["Strategy mode", strategyAuditLine(scenario)],
    ["Legacy/bequest", legacyAuditLine(scenario)],
    ["ACA locality", acaLocalityAuditLine(scenario)],
    ["ACA plan inputs", acaPlanAuditLine(scenario)],
    ["Data custody", dataCustodyAuditLine(scenario)],
    ["Simulation inputs", simulationAuditLine()],
    ["Known limits", knownLimitsAuditLine()]
  ];
}

async function downloadSetupBackup() {
  const confirmed = typeof window === "undefined"
    || await confirmDialog({
      title: "Export setup backup?",
      body: SETUP_BACKUP_PRIVACY_NOTICE,
      confirmLabel: "Export setup",
      cancelLabel: "Cancel"
    });
  if (!confirmed) return;

  syncJsonFromAssets();
  const backup = createSetupBackup(setupStateSnapshot());
  downloadJsonFile(backup, `portfolio-success-lab-setup-${backup.exportedAt.slice(0, 10)}.json`);
  setImportStatus("Setup JSON downloaded.");
}

async function downloadResultAuditBundle() {
  if (!latest?.plan || !latest?.monteCarlo) {
    setStatus("Run a completed model before exporting an audit bundle.", true);
    return;
  }
  const confirmed = typeof window === "undefined"
    || await confirmDialog({
      title: "Export audit bundle?",
      body: RESULT_AUDIT_BUNDLE_PRIVACY_NOTICE,
      confirmLabel: "Export bundle",
      cancelLabel: "Cancel"
    });
  if (!confirmed) return;

  syncJsonFromAssets();
  const exportedAt = new Date().toISOString();
  const bundle = createResultAuditBundle({
    latest,
    setupState: setupStateSnapshot(),
    auditRows: auditRowsForScenario(latest.scenario),
    sourceVersions: resultAuditSourceVersions(),
    exportedAt
  });
  downloadJsonFile(bundle, `portfolio-success-lab-audit-${exportedAt.slice(0, 10)}.json`);
  setStatus("Result audit bundle downloaded.");
  setImportStatus("Result audit bundle downloaded.");
}

function confirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel" } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    const titleId = `confirm-title-${Date.now()}`;
    overlay.setAttribute("aria-labelledby", titleId);
    overlay.innerHTML = `
      <div class="confirm-card">
        <h2 class="confirm-title" id="${titleId}">${escapeHtml(title ?? "Confirm")}</h2>
        <p class="confirm-body">${escapeHtml(body ?? "")}</p>
        <div class="confirm-actions">
          <button type="button" class="subtle-button" data-action="cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="primary-button" data-action="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    const cleanup = (result) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === "Escape") cleanup(false);
      else if (event.key === "Enter") cleanup(true);
    };
    overlay.addEventListener("click", (event) => {
      const action = event.target?.dataset?.action;
      if (action === "confirm") cleanup(true);
      else if (action === "cancel" || event.target === overlay) cleanup(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    overlay.querySelector('[data-action="confirm"]')?.focus();
  });
}

function resultAuditSourceVersions() {
  return {
    taxDataVersion: TAX_DATA_VERSION,
    historicalReturnDataVersion: HISTORICAL_RETURN_DATA_VERSION,
    historicalDataSource: latest?.historicalDataSource ?? readHistoricalDataSource(),
    historicalRange: latest?.historicalRange ?? null,
    monteCarloPreset: latest?.scenario?.monteCarlo?.assumptionPreset ?? els.mcPreset?.value,
    monteCarloRuns: latest?.monteCarlo?.summary?.runs ?? latest?.monteCarlo?.progress?.total ?? null,
    seed: Number(els.seed?.value) || 42,
    taxYear: latest?.scenario?.taxYear ?? null,
    state: latest?.scenario?.state ?? null,
    privacyMode: latest?.scenario?.privacyMode ?? privacyModeEnabled()
  };
}

function dollarAuditLine() {
  const mode = els.viewMode?.value === "nominal" ? "Future $" : "Today's $";
  return `${mode} display. Future-year deductions, brackets, spending marked inflation-adjusted, and return paths use modeled inflation; Today's $ deflates displayed nominal results by each path's inflation index.`;
}

function taxAuditLine(scenario) {
  const profile = latest?.taxProfile ?? {};
  const federalYear = profile.year ?? scenario.taxYear;
  const state = profile.state?.state ?? scenario.state;
  const federalDeduction = Number.isFinite(profile.standardDeduction)
    ? `standard deduction ${moneyFormatter.format(profile.standardDeduction)}`
    : "standard deduction from the selected tax table";
  const stateSource = profile.state?.source ? `; state source ${profile.state.source}` : "";
  const itemizedMode = profile.itemizedDeductions?.mode && profile.itemizedDeductions.mode !== "auto"
    ? `; deduction choice ${profile.itemizedDeductions.mode}`
    : "";
  const amtNote = Number(profile.amtPreferenceItems) > 0
    ? `; AMT preference/addback estimate ${moneyFormatter.format(profile.amtPreferenceItems)}`
    : "";
  const qbi = profile.qualifiedBusinessIncome ?? {};
  const qbiNote = qbi.sourceMode && qbi.sourceMode !== "none"
    ? `; QBI source ${qbi.sourceMode}${qbi.sourceMode === "manual" ? ` ${moneyFormatter.format(qbi.amount ?? 0)}` : ""}${qbi.specifiedServiceBusiness ? " SSTB" : ""}`
    : "";
  const childCreditNote = Number(profile.qualifyingChildren) > 0
    ? `; CTC/ACTC qualifying children ${profile.qualifyingChildren}`
    : "";
  return `${federalYear} federal ${readableFilingStatus(profile.filingStatus ?? scenario.filingStatus)}, ${federalDeduction}${itemizedMode}${amtNote}${qbiNote}${childCreditNote}; future standard deductions, child-credit amounts, and bracket thresholds inflate with the modeled CPI path, while the enhanced senior deduction is applied only in its 2025-2028 window. State: ${state || "None"}${stateSource}.`;
}

function strategyAuditLine(scenario) {
  const mode = scenario.withdrawalStrategy?.mode === "lifetime" ? "lifetime" : "heuristic";
  const spending = scenario.spendingStrategy?.mode === "discretionaryGuardrails"
    ? ` Spending guardrails are active: ${moneyFormatter.format(scenario.spendingStrategy.essentialSpend ?? 0)} essential plus ${moneyFormatter.format(scenario.spendingStrategy.discretionarySpend ?? 0)} discretionary, with discretionary trimmed at 10% and 20% stock-market drawdowns.`
    : " Fixed target spending is active.";
  if (mode === "lifetime") {
    return `Lifetime optimizer is active: it scores alternate withdrawal sources and tax moves against ACA, IRMAA, NIIT, ordinary/LTCG brackets, Roth basis, expected returns, and future tax-rate pressure.${spending}`;
  }
  return `Basic drawdown heuristic is active: it follows the selected account order with tax-aware lot sorting and simple guardrails, without full cross-year source scoring.${spending}`;
}

function legacyAuditLine(scenario) {
  const breakdown = latest?.plan?.heirValueBreakdown;
  const rate = Number.isFinite(Number(scenario.heirOrdinaryTaxRate))
    ? percentFormatter.format(Number(scenario.heirOrdinaryTaxRate))
    : "the default heir ordinary tax rate";
  const heirTypeLabel = {
    spouse: "spousal rollover",
    nonSpouse10Yr: "non-spouse 10-year rule",
    eligibleDesignated: "eligible designated beneficiary (stretch)"
  }[scenario.heirType] ?? scenario.heirType;

  const drag = Number.isFinite(Number(scenario.nonSpouse10YrTaxDrag)) ? Number(scenario.nonSpouse10YrTaxDrag) : 0;
  const discount = Number.isFinite(Number(scenario.eligibleDesignatedTaxDiscount)) ? Number(scenario.eligibleDesignatedTaxDiscount) : 0;
  const dragNote = scenario.heirType === "nonSpouse10Yr" && drag > 0
    ? ` Heir bracket-compression drag set to ${percentFormatter.format(drag)} (user-set planning assumption, not tax law).`
    : scenario.heirType === "eligibleDesignated" && discount > 0
      ? ` Heir stretch discount set to ${percentFormatter.format(discount)} (user-set planning assumption, not tax law).`
      : "";

  const accountOverrides = Number(breakdown?.perAccountBeneficiaryOverrideCount) || 0;
  const beneficiaryNote = accountOverrides > 0
    ? ` ${accountOverrides} account${accountOverrides === 1 ? "" : "s"} use per-account beneficiary overrides.`
    : " Account beneficiaries use the household-level heir type unless overridden in the portfolio table.";
  const rolloverNote = (breakdown?.spouseRolloverValue ?? 0) > 0
    ? ` Spouse-designated inherited traditional/HSA value ${moneyFormatter.format(breakdown.spouseRolloverValue)} is treated as tax-deferred in the bequest estimate.`
    : "";
  const base = `After-tax bequest estimate assumes a ${heirTypeLabel} household default with heir ordinary tax rate ${rate}; Roth and taxable balances are treated as tax-free to heirs, with taxable unrealized gains assumed stepped up at death.${beneficiaryNote}${rolloverNote}${dragNote}`;
  if (!breakdown) return `${base} Inherited-account payout timing, federal estate tax, and lineal state inheritance tax are unavailable for this result.`;

  const effectiveRateLabel = breakdown.effectiveTraditionalTaxRate != null
    && breakdown.effectiveTraditionalTaxRate !== breakdown.assumedOrdinaryTaxRate
    ? ` (effective traditional tax rate after bracket adjustment: ${percentFormatter.format(breakdown.effectiveTraditionalTaxRate)})`
    : "";
  return `${base}${effectiveRateLabel} Current modeled ending gross value ${moneyFormatter.format(breakdown.grossValue ?? 0)}, estimated inherited-account income tax ${moneyFormatter.format(breakdown.totalIncomeTaxEstimate ?? 0)}, federal estate tax ${moneyFormatter.format(breakdown.federalEstateTax ?? 0)}, lineal state inheritance tax ${moneyFormatter.format(breakdown.stateInheritanceTax ?? 0)}, after-tax bequest ${moneyFormatter.format(breakdown.afterTaxValue ?? 0)}. Non-lineal relationship classes, trusts, portability, and state estate taxes remain out of model.`;
}

function acaLocalityAuditLine(scenario) {
  if (scenario.aca?.enabled === false) return "ACA disabled.";
  const zip = String(els.marketplaceZip?.value || "").trim();
  const countyName = String(els.marketplaceCountyName?.value || "").trim();
  const countyFips = String(els.marketplaceCountyFips?.value || "").trim();
  const ratingArea = String(els.marketplaceRatingArea?.value || "").trim();
  const year = String(els.marketplacePlanYear?.value || scenario.taxYear || "").trim();

  const geo = zip ? resolveZip(zip) : null;
  const portalName = geo?.exchange?.portal || "";

  const parts = [
    zip ? `ZIP ${zip}` : "",
    portalName ? `Exchange ${portalName}` : "",
    countyName || countyFips ? `County ${countyName || "unknown"}${countyFips ? ` (${countyFips})` : ""}` : "",
    ratingArea ? `rating area ${ratingArea}` : "",
    year ? `plan year ${year}` : ""
  ].filter(Boolean);
  return parts.length
    ? parts.join("; ")
    : "No ZIP/county/rating-area saved; model falls back to state benchmark or manual premium inputs.";
}

function acaPlanAuditLine(scenario) {
  if (scenario.aca?.enabled === false) return "ACA disabled.";
  const costMode = els.acaPlanCostMode?.value === "selectedPlan" ? "Exact selected plan" : "State benchmark estimate";
  const premiumMode = els.acaPremiumInputMode?.value === "net" ? "quoted net premium" : "gross premium with calculated PTC";
  const slcsp = monthlyInputSummary("SLCSP", els.acaBenchmarkMonthlyPremium?.value, els.acaBenchmarkPlanId?.value, els.acaBenchmarkPlanName?.value);
  const selected = monthlyInputSummary("selected", els.acaSelectedPlanMonthlyPremium?.value, els.acaSelectedPlanId?.value, els.acaSelectedPlanName?.value);
  const oop = numberOrNull(els.oopMaxOverride?.value);
  const backup = backupPlanAuditSummary();
  return `${costMode}; ${premiumMode}. ${slcsp}; ${selected}; selected OOP ${Number.isFinite(oop) ? moneyFormatter.format(oop) : "not set"}. ${backup}`;
}

function monthlyInputSummary(label, monthlyValue, planId, planName) {
  const monthly = numberOrNull(monthlyValue);
  const id = String(planId || "").trim();
  const name = String(planName || "").trim();
  const plan = [name, id ? `ID ${id}` : ""].filter(Boolean).join(", ");
  return `${label} ${Number.isFinite(monthly) ? `${moneyFormatter.format(monthly)}/mo` : "not set"}${plan ? ` (${plan})` : ""}`;
}

function backupPlanAuditSummary() {
  const monthly = numberOrNull(els.acaBackupMonthlyPremium?.value);
  const oop = numberOrNull(els.acaBackupOopMax?.value);
  const trigger = numberOrNull(els.acaBackupTriggerFplPercent?.value);
  const id = String(els.acaBackupPlanId?.value || "").trim();
  const name = String(els.acaBackupPlanName?.value || "").trim();
  if (!Number.isFinite(monthly) && !Number.isFinite(oop) && !id && !name) return "No backup plan.";
  const plan = [name, id ? `ID ${id}` : ""].filter(Boolean).join(", ");
  return `Backup ${Number.isFinite(monthly) ? `${moneyFormatter.format(monthly)}/mo` : "premium not set"}${plan ? ` (${plan})` : ""}; OOP ${Number.isFinite(oop) ? moneyFormatter.format(oop) : "not set"}; trigger ${Number.isFinite(trigger) ? `${numberFormatter.format(trigger)}% FPL` : "not set"}.`;
}

function dataCustodyAuditLine(scenario) {
  if (scenario?.privacyMode === true) {
    return "Privacy mode was enabled. Google Sheets imports and live CMS Marketplace plan search were disabled; CSV, JSON, setup files, offline ZIP lookup, and manual ACA plan inputs stayed available.";
  }
  return "Local-first run. Setup/results stayed in this browser unless the user explicitly invoked Google Sheets, CMS Marketplace search, or confirmed an export; Google access tokens are held in memory only.";
}

function simulationAuditLine() {
  const summary = effectiveMonteCarloSummary();
  const runs = summary ? `${numberFormatter.format(summary.runs)}${summary.preliminary ? " preliminary" : ""} Monte Carlo runs` : "Monte Carlo pending";
  const preset = els.mcPreset?.value || latest?.scenario?.monteCarlo?.assumptionPreset || DEFAULT_SCENARIO.monteCarlo.assumptionPreset;
  const presetLabel = MONTE_CARLO_PRESET_LABELS[preset] ?? preset;
  const samplingMode = normalizeMonteCarloSamplingMode(els.mcSamplingMode?.value ?? latest?.scenario?.monteCarlo?.samplingMode);
  const sampling = samplingMode === "meanRevertingCorrelated"
    ? "mean-reverting correlated sampling"
    : samplingMode === "correlated"
      ? "correlated sampling"
      : "independent sampling";
  const coverage = latest?.historicalCoverage
    ? `${historicalDataSourceLabel()} history ${latest.historicalCoverage.startYear}-${latest.historicalCoverage.endYear}`
    : "historical coverage unavailable";
  return `${runs}; ${presetLabel} return preset; ${sampling}; ${coverage}.`;
}

function knownLimitsAuditLine() {
  return "Planning model only: verify final ACA enrollment quotes, plan networks, Schedule A substantiation, QBI/Form 8995 support, and tax filings outside the app. AMT is a CPA-review tripwire, not a full Form 6251 calculation; exact state-exchange CSR designs and intra-year withholding estimates are not modeled.";
}

function readableFilingStatus(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function renderKpis() {
  if (!els.kpis) return;
  const years = activeVisibleYears();
  if (!years?.length) { els.kpis.innerHTML = ""; return; }
  const currentYear = years[selectedYearIndex] ?? years[0];
  const finalYear = years.at(-1);
  const summary = effectiveMonteCarloSummary();
  if (!summary) { els.kpis.innerHTML = ""; return; }
  const adjustedMedian = adjustAmount(summary.medianEndingValue, finalYear);
  const adjustedP10 = adjustAmount(summary.p10EndingValue, finalYear);
  const adjustedHeir = adjustAmount(summary.medianHeirValue, finalYear);
  const kpis = [
    ["Success rate", percentFormatter.format(summary.successRate)],
    ["Median ending", moneyFormatter.format(adjustedMedian)],
    ["P10 ending", moneyFormatter.format(adjustedP10)],
    ["Median after-tax bequest", moneyFormatter.format(adjustedHeir)],
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
  els.yearLabel.textContent = year ? yearDisplayLabel(year) : `Year ${selectedYearIndex + 1}`;
}

function acaPlanLabel(year) {
  const role = year.aca?.activePlanRole;
  if (!role) return "";
  if (role === "backup") return year.aca.planName ? `Backup: ${year.aca.planName}` : "Backup";
  return "Primary";
}

function renderYearTable() {
  const years = activeVisibleYears();
  const magiColumn = selectedMagiColumn();
  const headers = ["Year", "Age", "Stock", "Bond", "Real estate", "TIPS", "Crypto", "Inflation", "Start value", "End value", "Sales / withdrawals", "Dividends", "Social Security", "Earned income", "One-off income", "RMD", "Total cash", "Total need", "Tax", "Fed income tax", "CG/QD tax", "NIIT", "W-2 FICA", "SE tax", "Addl Medicare", "Credits", "Refundable credits", "State tax", magiColumn.header, "Taxable SS", "Deduction", "Itemized ded", "65+ deduction", "Senior bonus", "QBI ded", "CTC children", "ACA plan", "ACA SLCSP", "ACA gross", "ACA subsidy", "ACA net", "Medicare", "Spend", "Essential", "Discretionary", "Disc. %", "Market DD", "Medical", "Tax gain harvest", "Roth conv.", "Roth basis available", "Penalty", "CL offset", "ST loss carry", "LT loss carry", "Loss carry", "State loss review"];
  const rows = years.map((year) => [
    yearDisplayLabel(year),
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
    money(year.earnedIncome ?? 0, year),
    money(year.oneOffIncome ?? 0, year),
    money(year.rmdAmount ?? 0, year),
    money(year.cashAvailable ?? ((year.cashRaised ?? 0) + (year.taxableDividendsCash ?? 0)), year),
    money(year.totalCashRequired ?? ((year.plannedSpending ?? 0) + (year.medicalCost ?? 0) + (year.taxes?.totalTax ?? 0)), year),
    money(year.taxes.totalTax, year),
    money(year.taxes.federalIncomeTax ?? year.taxes.incomeTax ?? 0, year),
    money(year.taxes.federalPreferentialTax ?? 0, year),
    money(year.taxes.niitTax ?? 0, year),
    money(year.taxes.employeePayrollTax ?? 0, year),
    money(year.taxes.selfEmploymentTax ?? 0, year),
    money(year.taxes.additionalMedicareTax ?? 0, year),
    money(year.taxes.federalCreditsUsed ?? 0, year),
    money(year.taxes.federalRefundableCredits ?? 0, year),
    money(year.taxes.stateTax ?? 0, year),
    money(magiColumn.value(year), year),
    money(year.taxableSocialSecurity ?? 0, year),
    year.taxes?.federalDeductionKind ?? "standard",
    money(year.taxes?.itemizedDeduction ?? 0, year),
    money(year.age65AdditionalDeduction ?? 0, year),
    money(year.enhancedSeniorDeduction ?? 0, year),
    money(year.taxes?.qbiDeduction ?? 0, year),
    year.qualifyingChildren ?? 0,
    acaPlanLabel(year),
    money(year.aca.benchmarkPremium ?? 0, year),
    money(year.aca.grossPremium ?? 0, year),
    money(year.aca.subsidy, year),
    money(year.aca.netPremium ?? 0, year),
    money(year.medicare?.totalAnnualPremium ?? 0, year),
    money(year.plannedSpending, year),
    year.spendingStrategy?.mode === "discretionaryGuardrails" ? money(year.essentialSpending ?? 0, year) : "n/a",
    year.spendingStrategy?.mode === "discretionaryGuardrails" ? money(year.discretionarySpending ?? 0, year) : "n/a",
    guardrailPercent(year.spendingGuardrail?.discretionaryPercent),
    guardrailPercent(year.spendingGuardrail?.marketDrawdown),
    money(year.medicalCost, year),
    money(year.taxGainHarvested, year),
    money(year.rothConversionAmount, year),
    money(year.rothBasisAvailable ?? year.rothBasisRemaining ?? 0, year),
    money(year.penaltyTax, year),
    money(year.taxes?.ordinaryLossOffset ?? 0, year),
    money(capitalLossCarryforwardDetail(year).shortTerm, year),
    money(capitalLossCarryforwardDetail(year).longTerm, year),
    money(year.lossCarryforward ?? year.taxes?.lossCarryforward ?? 0, year),
    stateCapitalLossReviewRequired(year) ? "Review" : ""
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

function selectedMagiColumn() {
  const mode = els.magiDisplayMode?.value ?? "aca";
  if (mode === "irmaa") {
    return { header: "IRMAA MAGI", value: (year) => year.irmaaMagi ?? year.magi };
  }
  if (mode === "agi") {
    return { header: "Federal AGI", value: (year) => year.federalAgi ?? year.magi };
  }
  return { header: "ACA MAGI", value: (year) => year.acaMagi ?? year.magi };
}

function yearDisplayLabel(year) {
  if (!year) return "";
  return Number.isFinite(year.historicalSourceYear)
    ? `${year.year} (${year.historicalSourceYear})`
    : `${year.year}`;
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
  const rowData = [...keys].map((key) => {
    const currentAsset = current.get(key) ?? emptyAssetFromKey(key);
    const previousAsset = previous.get(key) ?? emptyAssetFromKey(key);
    const change = currentAsset.value - previousAsset.value;
    const changePercent = previousAsset.value > 0 ? change / previousAsset.value : null;
    return { currentAsset, change, changePercent };
  });

  const activeSort = assetSortState.column && ASSET_COLUMN_META[assetSortState.column]
    ? assetSortState
    : null;
  if (activeSort) {
    const meta = ASSET_COLUMN_META[activeSort.column];
    const dir = activeSort.direction === "asc" ? 1 : -1;
    rowData.sort((a, b) => compareSortValues(meta.value(a), meta.value(b), meta.numeric) * dir);
  } else {
    rowData.sort((a, b) => Math.abs(b.currentAsset.value) - Math.abs(a.currentAsset.value));
  }

  const rows = rowData.map(({ currentAsset, change, changePercent }) => [
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
  bindAssetSortHandlers(els.assetBreakdownTable);
  bindResizeObserver(els.assetBreakdownTable, "assetBreakdown");
  addStickyHorizontalScrollbar(els.assetBreakdownTable);
}

function compareSortValues(a, b, numeric) {
  if (numeric) {
    const aNull = a == null || !Number.isFinite(a);
    const bNull = b == null || !Number.isFinite(b);
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return a - b;
  }
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base" });
}

function handleAssetSortClick(headerName) {
  const meta = ASSET_COLUMN_META[headerName];
  if (!meta) return;
  if (assetSortState.column === headerName) {
    if (assetSortState.direction === meta.defaultDir) {
      assetSortState = { column: headerName, direction: meta.defaultDir === "asc" ? "desc" : "asc" };
    } else {
      assetSortState = { column: null, direction: "desc" };
    }
  } else {
    assetSortState = { column: headerName, direction: meta.defaultDir };
  }
  saveAssetSortState(assetSortState);
  renderAssetBreakdown();
}

function bindAssetSortHandlers(container) {
  container.querySelectorAll("thead th").forEach((th) => {
    const pinBtn = th.querySelector(".pin-toggle");
    const headerName = pinBtn?.dataset.pinHeader;
    if (!headerName || !ASSET_COLUMN_META[headerName]) return;
    th.classList.add("is-sortable");
    const isActive = assetSortState.column === headerName;
    const arrow = isActive ? (assetSortState.direction === "asc" ? "▲" : "▼") : "↕";
    const indicator = document.createElement("span");
    indicator.className = "sort-indicator" + (isActive ? " is-active" : "");
    indicator.textContent = arrow;
    indicator.setAttribute("aria-hidden", "true");
    th.appendChild(indicator);
    if (isActive) {
      th.setAttribute("aria-sort", assetSortState.direction === "asc" ? "ascending" : "descending");
    }
    th.addEventListener("click", (event) => {
      if (event.target.closest(".pin-toggle")) return;
      handleAssetSortClick(headerName);
    });
  });
}

function renderScenarioTable() {
  const rows = latest.monteCarlo.scenarios.map((scenarioResult) => {
    // After a cached-latest restore, scenarios may not carry full year
    // arrays; fall back to the compact lastYear thumbnail.
    const finalYear = scenarioResult.years?.at?.(-1) ?? scenarioResult.lastYear ?? null;
    return [
      scenarioResult.id,
      scenarioResult.success ? `<span class="positive">Yes</span>` : `<span class="negative">No</span>`,
      money(scenarioResult.endingValue, finalYear),
      money(scenarioResult.heirValue, finalYear),
      escapeHtml(failureSummary(scenarioResult))
    ];
  });

  const progress = latest.monteCarlo.progress;
  const streaming = progress && !progress.complete;
  els.scenarioTable.innerHTML = tableHtml(
    ["Run", "Success", "Ending", "After-tax heirs", "Failure year"],
    rows,
    (index) => {
      const scenario = latest.monteCarlo.scenarios[index];
      const id = scenario.id;
      const classes = selectedBacktestIndex == null && id === selectedScenarioId ? "selected-row" : "";
      return `data-scenario="${id}" class="${classes}"`;
    },
    streaming ? scenarioStreamingFooter(progress) : ""
  );

  els.scenarioTable.querySelectorAll("[data-scenario]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = Number(row.dataset.scenario);
      ensureScenarioTimeline(id);
      selectedScenarioId = id;
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
  const sourceLabel = historicalDataSourceLabel();
  const note = coverage
    ? `Historical success ${percentFormatter.format(successRate)} across ${latest.backtests.length} paths. ${sourceLabel}; data version ${HISTORICAL_RETURN_DATA_VERSION}; ${coverage.startYear}-${coverage.endYear} available for this asset mix.${proxyNote}${rangeNote}`
    : `Historical success ${percentFormatter.format(successRate)} across ${latest.backtests.length} paths.`;
  const rows = latest.backtests.map((backtest) => {
    const finalYear = backtest.years?.at?.(-1) ?? backtest.lastYear ?? null;
    return [
      escapeHtml(backtest.id),
      backtest.success ? `<span class="positive">Yes</span>` : `<span class="negative">No</span>`,
      money(backtest.endingValue, finalYear),
      money(backtest.heirValue, finalYear),
      (backtest.years ? firstFailureYear(backtest.years) : backtest.depletionYear) ?? ""
    ];
  });

  els.backtestTable.innerHTML = `
    <p class="table-note">${escapeHtml(note)}</p>
    ${tableHtml(
      ["Path", "Success", "Ending", "After-tax heirs", "Failure year"],
      rows,
      (index) => {
        const backtest = latest.backtests[index];
        const selectable = hasYearTimeline(backtest);
        const classes = [
          index === selectedBacktestIndex ? "selected-row" : "",
          selectable ? "" : "disabled-row"
        ].filter(Boolean).join(" ");
        const attrs = selectable
          ? `data-backtest-index="${index}"`
          : `aria-disabled="true" title="Full path details are reloading"`;
        return `${attrs} class="${classes}"`;
      }
    )}
  `;

  els.backtestTable.querySelectorAll("[data-backtest-index]").forEach((row) => {
    row.addEventListener("click", () => {
      selectHistoricalBacktest(Number(row.dataset.backtestIndex));
    });
  });
}

function selectHistoricalBacktest(index) {
  const numericIndex = Number(index);
  if (!Number.isInteger(numericIndex) || numericIndex < 0) return false;
  const backtest = latest?.backtests?.[numericIndex];
  if (!hasYearTimeline(backtest)) return false;

  selectedBacktestIndex = numericIndex;
  selectedScenarioId = null;
  clampSelectedYearToVisible();
  renderScenarioTable();
  renderBacktests();
  drawTimeline();
  renderKpis();
  renderFlowAndSales();
  renderYearTable();
  renderAssetBreakdown();

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("psl:path-selected", {
      detail: { type: "historical", index: numericIndex, id: backtest.id }
    }));
  }
  return true;
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
  const addAction = (kind, cells) => {
    rows.push([...cells, actionConfidenceHtml(actionConfidenceFor(kind, latest?.confidence))]);
  };
  const magiTarget = year.acaMagiCeiling;
  if (Number.isFinite(magiTarget) && year.aca?.enabled !== false) {
    addAction("magiManagement", [
      "Manage MAGI",
      money(magiTarget, year),
      "ACA threshold",
      `${money(year.magi, year)} projected MAGI; ${money(year.aca.subsidy, year)} subsidy`,
      `Keep discretionary gains and conversions under about ${percentFormatter.format((year.acaMagiCeilingFplPercent ?? 0) / 100)} FPL.`
    ]);
  }

  if ((year.rothConversionAmount ?? 0) > 0) {
    addAction("rothConversion", [
      "Convert traditional to Roth",
      money(year.rothConversionAmount, year),
      "Traditional accounts",
      `${money(taxAttributionFor(year, "Roth conversion"), year)} estimated tax share`,
      "Fills low ordinary brackets without crossing the selected ACA MAGI target."
    ]);
  }

  if ((year.rmdAmount ?? 0) > 0) {
    addAction("traditionalWithdrawal", [
      "Take required minimum distribution",
      money(year.rmdAmount, year),
      "Traditional accounts",
      `${money(year.rmdBase ?? 0, year)} prior balance / ${year.rmdFactor ?? "n/a"} divisor`,
      "Forced taxable distribution under the modeled RMD start age."
    ]);
  }

  if ((year.socialSecurityBenefits ?? 0) > 0) {
    addAction("socialSecurity", [
      "Collect Social Security",
      money(year.socialSecurityBenefits, year),
      "Social Security",
      `${money(year.taxableSocialSecurity ?? 0, year)} taxable; ${money(taxAttributionFor(year, "Social Security benefits"), year)} estimated tax share`,
      "Uses provisional-income rules and counts non-taxable benefits in ACA MAGI."
    ]);
  }

  if ((year.earnedIncome ?? 0) > 0) {
    addAction("earnedIncome", [
      "Receive earned income",
      money(year.earnedIncome, year),
      "Earned income",
      `${money(year.taxes?.employeePayrollTax ?? 0, year)} W-2 FICA; ${money(year.taxes?.selfEmploymentTax ?? 0, year)} self-employment tax; ${money(year.taxes?.additionalMedicareTax ?? 0, year)} Additional Medicare Tax; ${money(taxAttributionFor(year, "Earned income"), year)} estimated tax share`,
      "Counts as ordinary income and cash available; W-2 wages apply employee FICA, and self-employment income applies Schedule SE when present."
    ]);
  }

  if ((year.oneOffIncome ?? 0) > 0) {
    addAction("oneOffIncome", [
      "Receive one-off income",
      money(year.oneOffIncome, year),
      "One-off income",
      `${money(taxAttributionFor(year, "One-off income"), year)} estimated tax share`,
      "Adds outside cash for the configured year range before selling portfolio assets."
    ]);
  }

  const discretionaryTrim = Math.max(0, (year.discretionarySpendingBudget ?? 0) - (year.discretionarySpending ?? 0));
  if (discretionaryTrim > 1 && year.spendingGuardrail?.enabled) {
    addAction("spendingGuardrail", [
      "Trim discretionary spending",
      money(discretionaryTrim, year),
      "Lifestyle budget",
      `${guardrailPercent(year.spendingGuardrail.marketDrawdown)} stock-market drawdown; ${guardrailPercent(year.spendingGuardrail.discretionaryPercent)} discretionary budget modeled`,
      "Applies the essential-plus-discretionary guardrail before portfolio sales are sized."
    ]);
  }

  if ((year.taxGainHarvested ?? 0) > 0) {
    addAction("taxGainHarvesting", [
      "Harvest taxable gains",
      money(year.taxGainHarvested, year),
      "Taxable lots",
      `${money(taxAttributionFor(year, "Tax gain harvesting"), year)} estimated tax share`,
      "Steps up basis while staying inside the federal and ACA room the model found."
    ]);
  }

  if ((year.realizedCapitalLosses ?? 0) > 0) {
    addAction("taxLossHarvesting", [
      "Harvest taxable losses",
      money(year.realizedCapitalLosses, year),
      "Taxable lots",
      `${money(year.taxes?.ordinaryLossOffset ?? 0, year)} ordinary offset; ${capitalLossCarryforwardText(year)} after this year${stateCapitalLossReviewSuffix(year)}`,
      "Offsets gains first, then up to the allowed ordinary-income offset."
    ]);
  }

  const taxableDividendsForSpending = Math.min(year.taxableDividendsCash ?? 0, year.totalCashRequired ?? 0);
  if (taxableDividendsForSpending > 1) {
    addAction("taxableDividends", [
      "Collect taxable dividends for spending",
      money(taxableDividendsForSpending, year),
      "Taxable account dividends",
      `${money(year.taxableDividendsCash ?? 0, year)} taxable dividends; ${money(taxAttributionFor(year, "Taxable account dividends"), year)} estimated tax share`,
      "Use taxable dividend cash for this year's spending before selling additional assets."
    ]);
  }

  for (const sale of year.sales ?? []) {
    addAction(sale.accountType === "traditional" ? "traditionalWithdrawal" : "withdrawal", [
      saleActionLabel(sale),
      money(sale.proceeds, year),
      escapeHtml(sale.name),
      saleImpactText(sale, year),
      saleReasonText(sale)
    ]);
  }

  if ((year.taxes?.totalTax ?? 0) > 0) {
    const refundableCreditText = (year.taxes?.federalRefundableCredits ?? 0) > 0
      ? `; ${money(year.taxes.federalRefundableCredits, year)} refundable credits`
      : "";
    addAction("taxReserve", [
      "Reserve for taxes",
      money(year.taxes.totalTax, year),
      "Spending reserve",
      `${money(year.taxes.federalIncomeTax ?? 0, year)} federal; ${money(year.taxes.stateTax ?? 0, year)} state; ${money(year.taxes.niitTax ?? 0, year)} NIIT; ${money(year.taxes.employeePayrollTax ?? 0, year)} W-2 FICA; ${money(year.taxes.selfEmploymentTax ?? 0, year)} SE tax; ${money(year.taxes.additionalMedicareTax ?? 0, year)} Additional Medicare${refundableCreditText}`,
      "Includes estimated income taxes and any early-withdrawal penalties."
    ]);
  }

  if ((year.taxRefundCash ?? 0) > 0) {
    addAction("taxReserve", [
      "Receive refundable tax credits",
      money(year.taxRefundCash, year),
      "Tax refund",
      `${money(year.taxes?.additionalChildTaxCredit ?? year.taxes?.federalRefundableCredits ?? 0, year)} Additional Child Tax Credit; ${money(year.taxes?.earnedIncomeForRefundableCredits ?? 0, year)} earned income used for refundable-credit sizing`,
      "Refundable credits reduce this year's modeled cash need; verify Schedule 8812 before relying on the refund."
    ]);
  }

  if ((year.medicalCost ?? 0) > 0) {
    const medicarePremium = year.medicare?.totalAnnualPremium ?? 0;
    addAction("medicalReserve", [
      "Reserve for medical",
      money(year.medicalCost, year),
      "Spending reserve",
      `${money(year.aca?.grossPremium ?? 0, year)} gross ACA premium; ${money(year.aca?.subsidy ?? 0, year)} subsidy; ${money(year.aca?.netPremium ?? 0, year)} net`,
      `${money(medicarePremium, year)} Medicare/IRMAA after age 65.`
    ]);
  }

  if ((year.unfunded ?? 0) > 1) {
    addAction("fundingGap", [
      "Close funding gap",
      money(year.unfunded, year),
      "Portfolio",
      "Plan failure in selected year",
      "Reduce spending, add cash, or change withdrawal order before relying on this path."
    ]);
  }

  els.actionPlan.innerHTML = rows.length
    ? tableHtml(["Move", "Amount", "Source", "Tax / cash impact", "Why", "Confidence"], rows)
    : `<p class="empty-state">No portfolio moves are needed in ${year.year}.</p>`;
  addStickyHorizontalScrollbar(els.actionPlan);
}

function actionConfidenceHtml(confidence = {}) {
  const level = confidence.level ?? "high-confidence";
  const label = confidence.label ?? "High";
  const title = confidence.title ?? "Source-versioned rule";
  const detail = confidence.detail ?? "";
  return `
    <span class="action-confidence" data-level="${escapeHtml(level)}" title="${escapeHtml(detail)}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(title)}</span>
    </span>
  `;
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

function readHistoricalDataSource() {
  const value = els.historicalDataSource?.value;
  return HISTORICAL_DATA_SOURCE_OPTIONS.some((option) => option.id === value)
    ? value
    : DEFAULT_HISTORICAL_DATA_SOURCE;
}

function resetHistoricalRangeControlsForCurrentSource() {
  const assetClasses = assetClassesInPortfolio(assets);
  const proxies = historicalProxyMapForControls(assetClasses);
  const coverage = historicalCoverageForAssetClasses(assetClasses, {
    assetClassProxies: proxies,
    historicalDataSource: readHistoricalDataSource()
  });
  if (!coverage) return;
  updateHistoricalRangeBounds(coverage);
  els.historicalStartYear.value = String(coverage.startYear);
  els.historicalEndYear.value = String(coverage.endYear);
  saveStoredState();
}

function reconcileHistoricalRangeControls({ coverage, strictCoverage, proxies }) {
  if (!coverage) return;
  updateHistoricalRangeBounds(coverage);
  const start = Number(els.historicalStartYear.value);
  const end = Number(els.historicalEndYear.value);
  if (!Number.isFinite(start) || start < coverage.startYear || start > coverage.endYear) {
    els.historicalStartYear.value = String(coverage.startYear);
  }
  if (!Number.isFinite(end) || end < coverage.startYear || end > coverage.endYear) {
    els.historicalEndYear.value = String(coverage.endYear);
  }
  if (!Object.keys(proxies ?? {}).length || els.backtestMode.value !== "all") return;
  if (strictCoverage && start === strictCoverage.startYear && end === strictCoverage.endYear && coverage.startYear < strictCoverage.startYear) {
    els.historicalStartYear.value = String(coverage.startYear);
    els.historicalEndYear.value = String(coverage.endYear);
  }
}

function updateHistoricalRangeBounds(coverage) {
  els.historicalStartYear.min = String(coverage.startYear);
  els.historicalStartYear.max = String(coverage.endYear);
  els.historicalEndYear.min = String(coverage.startYear);
  els.historicalEndYear.max = String(coverage.endYear);
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

function historicalDataSourceLabel() {
  return HISTORICAL_DATA_SOURCE_OPTIONS.find((option) => option.id === latest?.historicalDataSource)?.label
    ?? HISTORICAL_DATA_SOURCE_OPTIONS.find((option) => option.id === DEFAULT_HISTORICAL_DATA_SOURCE)?.label
    ?? "Historical data";
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

function hasYearTimeline(result) {
  return Array.isArray(result?.years) && result.years.length > 0;
}

function firstResultWithYears(results = []) {
  return results.find(hasYearTimeline) ?? null;
}

function ensureScenarioTimeline(id) {
  if (!latest) return;
  const scenario = latest.monteCarlo.scenarios.find((s) => s.id === id);
  if (!scenario) return;
  if (!hasYearTimeline(scenario)) {
    const activeAssets = latest.assets || assets || [];
    const activeScenario = latest.scenario || readScenario();
    const activeTaxProfile = latest.taxProfile || readTaxProfile();
    const activeSeed = latest.seed || (Number(els.seed?.value) || 42);
    
    const plan = generateSingleMonteCarloPath({
      assets: activeAssets,
      scenario: activeScenario,
      taxProfile: activeTaxProfile,
      seed: activeSeed,
      scenarioId: id
    });
    if (plan) {
      scenario.years = plan.years;
    }
  }
}

function activeYears() {
  if (!latest) return [];
  const planYears = latest.plan?.years ?? [];
  if (selectedBacktestIndex != null) {
    const backtest = latest.backtests[selectedBacktestIndex];
    return hasYearTimeline(backtest) ? backtest.years : planYears;
  }
  ensureScenarioTimeline(selectedScenarioId);
  const selectedScenario = latest.monteCarlo.scenarios.find((scenario) => scenario.id === selectedScenarioId);
  return hasYearTimeline(selectedScenario) ? selectedScenario.years : planYears;
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

function failureSummary(result) {
  const details = depletionDetailsForResult(result);
  if (!details?.year) return "";
  const pieces = [];
  if (Number.isFinite(details.yearIndex)) {
    pieces.push(`after ${numberFormatter.format(details.yearIndex)} ${details.yearIndex === 1 ? "year" : "years"}`);
  }
  if (Number.isFinite(details.age)) pieces.push(`age ${ageLabel(details.age)}`);
  return pieces.length ? `${details.year} (${pieces.join(", ")})` : String(details.year);
}

function depletionDetailsForResult(result) {
  if (Array.isArray(result.years)) {
    const matchingYear = result.years.find(isFailureYear);
    if (!matchingYear) return null;
    return {
      year: matchingYear.year,
      yearIndex: matchingYear.yearIndex,
      age: matchingYear.age
    };
  }
  if (!result.depletionYear) return null;
  return {
    year: result.depletionYear,
    yearIndex: result.depletionYearIndex,
    age: result.depletionAge
  };
}

function isFailureYear(year) {
  return (year?.endingPortfolioValue ?? 0) <= 0;
}

function addStickyHorizontalScrollbar(container) {
  container._stickyCleanup?.();
  const table = container.querySelector("table");
  if (!table) return;
  const scrollbar = document.createElement("div");
  scrollbar.className = "sticky-x-scroll";

  const leftArrow = document.createElement("button");
  leftArrow.type = "button";
  leftArrow.className = "table-scroll-arrow";
  leftArrow.setAttribute("aria-label", "Scroll table left");
  leftArrow.textContent = "‹";

  const track = document.createElement("div");
  track.className = "sticky-x-scroll-track";
  const spacer = document.createElement("div");
  spacer.className = "sticky-x-scroll-spacer";
  track.append(spacer);

  const rightArrow = document.createElement("button");
  rightArrow.type = "button";
  rightArrow.className = "table-scroll-arrow";
  rightArrow.setAttribute("aria-label", "Scroll table right");
  rightArrow.textContent = "›";

  scrollbar.append(leftArrow, track, rightArrow);
  container.append(scrollbar);

  const maxScrollLeft = () => Math.max(0, table.scrollWidth - container.clientWidth);
  const updateArrows = () => {
    const max = maxScrollLeft();
    leftArrow.disabled = container.scrollLeft <= 1;
    rightArrow.disabled = container.scrollLeft >= max - 1;
  };

  const updateWidth = () => {
    spacer.style.width = `${table.scrollWidth}px`;
    scrollbar.classList.toggle("is-needed", table.scrollWidth > container.clientWidth + 1);
    updateArrows();
    updateFixedState();
  };

  let syncing = false;
  container.addEventListener("scroll", () => {
    if (!syncing) {
      syncing = true;
      track.scrollLeft = container.scrollLeft;
      syncing = false;
    }
    updateArrows();
  });
  track.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    container.scrollLeft = track.scrollLeft;
    syncing = false;
  });

  const scrollByStep = (direction) => {
    // Instant, not smooth: a smooth animation gets cancelled by the
    // container <-> track scroll sync, which fires across separate frames.
    const step = Math.max(120, container.clientWidth * 0.6);
    container.scrollLeft += direction * step;
  };
  leftArrow.addEventListener("click", () => scrollByStep(-1));
  rightArrow.addEventListener("click", () => scrollByStep(1));

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
  const beneficiaryOptions = [
    { value: "default", label: "Household default" },
    { value: "spouse", label: "Spouse rollover" },
    { value: "nonSpouse10Yr", label: "Non-spouse 10-year" },
    { value: "eligibleDesignated", label: "Eligible stretch" }
  ];
  const ownerOptions = [
    { value: "primary", label: "Primary" },
    { value: "spouse", label: "Spouse" },
    { value: "joint", label: "Joint (taxable)" }
  ];
  // data-label on each <td> lets the narrow-viewport CSS reflow this editable
  // table into stacked cards (see .asset-table reflow in styles.css), so every
  // holding field is visible without horizontal scrolling on a phone.
  const rows = assets.map((asset, index) => `
    <tr>
      <td data-label="Name"><input data-index="${index}" data-field="name" value="${escapeAttr(asset.name)}"></td>
      <td data-label="Account">${selectHtml(index, "accountType", accountOptions, asset.accountType)}</td>
      <td data-label="Class">${selectHtml(index, "assetClass", assetClassOptions, asset.assetClass)}</td>
      <td data-label="Units"><input data-index="${index}" data-field="units" type="number" step="0.0001" value="${asset.units}"></td>
      <td data-label="Price"><input data-index="${index}" data-field="price" type="number" step="0.01" value="${asset.price}"></td>
      <td data-label="Basis"><input data-index="${index}" data-field="costBasisPerUnit" type="number" step="0.01" value="${asset.costBasisPerUnit}"></td>
      <td data-label="Yield"><input data-index="${index}" data-field="dividendYield" type="number" step="0.001" value="${asset.dividendYield ?? 0}"></td>
      <td data-label="Qualified"><input data-index="${index}" data-field="qualifiedDividendShare" type="number" step="0.05" min="0" max="1" value="${asset.qualifiedDividendShare ?? 0}"></td>
      <td data-label="Term">${selectHtml(index, "holdingPeriod", holdingOptions, asset.holdingPeriod ?? "long")}</td>
      <td data-label="Owner">${selectHtml(index, "owner", ownerOptions, asset.owner ?? "primary")}</td>
      <td data-label="Beneficiary">${selectHtml(index, "beneficiaryType", beneficiaryOptions, asset.beneficiaryType ?? "default")}</td>
      <td data-label="">${`<button type="button" data-remove="${index}">Remove</button>`}</td>
    </tr>
  `).join("");

  els.assetTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th><th>Account</th><th>Class</th><th>Units</th><th>Price</th><th>Basis</th><th>Yield</th><th>Qualified</th><th>Term</th><th>Owner</th><th>Beneficiary</th><th></th>
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
    els.oneOffList.innerHTML = `<p class="empty-state">No one-off cash flows.</p>`;
    return;
  }

  els.oneOffList.innerHTML = oneOffExpenses.map((expense, index) => `
    <div class="one-off-item">
      <div>
        <strong>${escapeHtml(expense.name)}</strong>
        <span>${oneOffTypeLabel(expense.cashFlowType)}; years ${expense.startYear}-${expense.endYear}, ${moneyFormatter.format(expense.amount)}, ${expense.inflationAdjusted ? "inflation adjusted" : "fixed"}</span>
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

function renderIncomeStreams() {
  if (!els.incomeStreamList) return;
  if (!incomeStreams.length) {
    els.incomeStreamList.innerHTML = `<p class="empty-state">No recurring income streams.</p>`;
    return;
  }

  els.incomeStreamList.innerHTML = incomeStreams.map((stream, index) => `
    <div class="one-off-item">
      <div>
        <strong>${escapeHtml(stream.name || incomeStreamTypeLabel(stream.type))}</strong>
        <span>${incomeStreamTypeLabel(stream.type)}; ${stream.owner === "spouse" ? "spouse" : "primary"} from age ${stream.startAge}${stream.endAge != null ? `-${stream.endAge}` : " for life"}, ${moneyFormatter.format(stream.annualAmount)}/yr${stream.inflationAdjusted === false ? " fixed" : " COLA"}, survivor ${Math.max(0, Number(stream.survivorPercent) || 0)}%${stream.taxCharacter === "taxFree" ? ", tax-free" : ""}</span>
      </div>
      <button type="button" data-remove-income-stream="${index}">Remove</button>
    </div>
  `).join("");

  els.incomeStreamList.querySelectorAll("[data-remove-income-stream]").forEach((button) => {
    button.addEventListener("click", () => {
      incomeStreams.splice(Number(button.dataset.removeIncomeStream), 1);
      renderIncomeStreams();
      saveStoredState();
    });
  });
}

function incomeStreamTypeLabel(type) {
  return {
    pension: "Pension",
    annuity: "Annuity",
    rent: "Rental income",
    other: "Recurring income"
  }[type] ?? "Recurring income";
}

function normalizedOneOffCashFlowType(type) {
  return [
    "taxableOrdinaryIncome",
    "taxFreeIncome",
    "medicareWages",
    "selfEmploymentIncome",
    "rrtaCompensation"
  ].includes(type) ? type : "expense";
}

function oneOffTypeLabel(type) {
  return {
    expense: "Expense",
    taxableOrdinaryIncome: "Taxable ordinary income",
    taxFreeIncome: "Tax-free income",
    medicareWages: "Medicare wages",
    selfEmploymentIncome: "Self-employment income",
    rrtaCompensation: "RRTA compensation"
  }[normalizedOneOffCashFlowType(type)];
}

function oneOffDefaultName(type) {
  return normalizedOneOffCashFlowType(type) === "expense" ? "One-off expense" : "One-off income";
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
  let tooltip = svg.parentElement.querySelector(".chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
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
      <div class="chart-tt-year">${yr.year}</div>
      <div class="chart-tt-row"><span class="chart-tt-dot" style="background:#34d1b6"></span>Portfolio <strong>${moneyFormatter.format(values[idx])}</strong></div>
      <div class="chart-tt-row"><span class="chart-tt-dot" style="background:#f06060"></span>Tax <strong>${moneyFormatter.format(taxes[idx])}</strong></div>
      <div class="chart-tt-row chart-tt-muted">Spend ${moneyFormatter.format(adjustAmount(yr.plannedSpending, yr))}</div>
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
    return hasYearTimeline(backtest) ? `Backtest ${backtest.id}` : "Baseline mean path";
  }
  const selectedScenario = latest.monteCarlo.scenarios.find((scenario) => scenario.id === selectedScenarioId);
  return hasYearTimeline(selectedScenario) ? `Monte Carlo run ${selectedScenario.id}` : "Baseline mean path";
}

function drawDistribution() {
  const svg = els.distributionSvg;
  const width = 860;
  const height = 320;
  clearSvg(svg, width, height);
  // Histogram is an aggregate view — drawing it with a handful of scenarios
  // looks degenerate, not "in progress". Hold for a same-sized placeholder
  // until the run finishes so the layout doesn't jump.
  if (!latest.monteCarlo.progress?.complete) {
    drawDistributionPlaceholder(svg, width, height, latest.monteCarlo.progress);
    return;
  }
  const margin = { top: 28, right: 28, bottom: 52, left: 60 };
  const scenarios = latest.monteCarlo.scenarios;
  const values = scenarios.map((s) => adjustAmount(s.endingValue, s.years?.at?.(-1) ?? s.lastYear));
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
  let tooltip = svg.parentElement.querySelector(".chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
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
      class: "dist-bar", cursor: "pointer"
    });

    bar.addEventListener("mouseenter", (e) => {
      bar.setAttribute("opacity", "1");
      const rect = svg.getBoundingClientRect();
      const successes = bin.scenarios.filter(s => s.success).length;
      tooltip.innerHTML = `
        <div class="chart-tt-year">${moneyFormatter.format(bin.low)} – ${moneyFormatter.format(bin.high)}</div>
        <div class="chart-tt-row"><strong>${bin.count}</strong> scenarios (${Math.round(bin.count / values.length * 100)}%)</div>
        <div class="chart-tt-row">${successes} succeeded, ${bin.count - successes} failed</div>
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

function drawDistributionPlaceholder(svg, width, height, progress) {
  // Subtle rounded panel matching the chart frame so the page doesn't reflow
  // when the real chart paints.
  svg.append(svgEl("rect", {
    x: 12, y: 12, width: width - 24, height: height - 24,
    rx: 12, fill: "rgba(255,255,255,0.02)", stroke: "rgba(255,255,255,0.06)"
  }));
  const cx = width / 2;
  const cy = height / 2 - 8;
  // Spinner ring (CSS animated via class).
  svg.append(svgEl("circle", {
    cx, cy, r: 16,
    fill: "none",
    stroke: "rgba(255,255,255,0.12)",
    "stroke-width": 3
  }));
  const spinner = svgEl("circle", {
    cx, cy, r: 16,
    fill: "none",
    stroke: "#34d1b6",
    "stroke-width": 3,
    "stroke-linecap": "round",
    "stroke-dasharray": "30 70",
    class: "dist-spinner"
  });
  svg.append(spinner);
  svg.append(svgEl("text", {
    x: cx, y: cy + 38, "text-anchor": "middle",
    fill: "rgba(255,255,255,0.78)",
    "font-size": 13, "font-weight": 600,
    "font-family": "'Inter', sans-serif"
  }, "Building distribution…"));
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  if (total > 0) {
    svg.append(svgEl("text", {
      x: cx, y: cy + 56, "text-anchor": "middle",
      fill: "rgba(255,255,255,0.5)",
      "font-size": 11,
      "font-family": "'JetBrains Mono', monospace"
    }, `${done.toLocaleString()} of ${total.toLocaleString()} scenarios`));
  }
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
      class: "flow-ribbon",
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
      class: "flow-node",
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
      class: "flow-node-name"
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
      class: "flow-node-value"
    }, val);
    badge.append(svgEl("title", {}, nodeTitle));
    labelGroup.append(badge);
  }

  // ── Hover interactions ──
  svg.querySelectorAll(".flow-ribbon").forEach(ribbon => {
    ribbon.addEventListener("mouseenter", () => {
      svg.querySelectorAll(".flow-ribbon").forEach(r => {
        r.style.opacity = r === ribbon ? "1" : "0.12";
        r.style.transition = "opacity 0.2s";
      });
    });
    ribbon.addEventListener("mouseleave", () => {
      svg.querySelectorAll(".flow-ribbon").forEach(r => {
        r.style.opacity = "";
        r.style.transition = "opacity 0.3s";
      });
    });
  });

  svg.querySelectorAll(".flow-node").forEach(bar => {
    bar.style.cursor = "pointer";
    bar.addEventListener("mouseenter", () => {
      const id = bar.getAttribute("data-node-id");
      svg.querySelectorAll(".flow-ribbon").forEach(r => {
        const match = r.getAttribute("data-from") === id || r.getAttribute("data-to") === id;
        r.style.opacity = match ? "1" : "0.08";
        r.style.transition = "opacity 0.2s";
      });
    });
    bar.addEventListener("mouseleave", () => {
      svg.querySelectorAll(".flow-ribbon").forEach(r => {
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
      `Roth contribution basis left: ${money(year.rothContributionBasisRemaining ?? year.rothBasisRemaining ?? 0, year)}`,
      `Penalty-free conversion principal: ${money(year.rothPenaltyFreeConversionPrincipal ?? 0, year)}`,
      `Roth basis available: ${money(year.rothBasisAvailable ?? year.rothBasisRemaining ?? 0, year)}`
    ].join("\n");
  }

  const taxDetails = taxPaymentNodeDetails(year);
  if (taxDetails) details["Tax payment"] = taxDetails;
  const refundDetails = taxRefundNodeDetails(year);
  if (refundDetails) details["Tax refund"] = refundDetails;

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
    `NIIT: ${money(taxes.niitTax ?? 0, year)}`,
    `W-2 employee FICA: ${money(taxes.employeePayrollTax ?? 0, year)}`,
    `Self-employment tax: ${money(taxes.selfEmploymentTax ?? 0, year)}`,
    `Additional Medicare Tax: ${money(taxes.additionalMedicareTax ?? 0, year)}`
  ];
  if ((taxes.ordinaryLossOffset ?? 0) > 0) {
    lines.push(`Capital-loss ordinary offset: -${money(taxes.ordinaryLossOffset, year)}`);
  }
  if ((taxes.lossCarryforward ?? year?.lossCarryforward ?? 0) > 0) {
    lines.push(`Capital-loss carryforward: ${capitalLossCarryforwardText(year)}`);
  }
  if (stateCapitalLossReviewRequired(year)) {
    lines.push(`State capital-loss review: ${stateCapitalLossReviewNote(year)}`);
  }
  if ((taxes.federalCreditsUsed ?? 0) > 0) {
    lines.push(`Federal credits used: -${money(taxes.federalCreditsUsed, year)}`);
  }
  if ((taxes.federalRefundableCredits ?? 0) > 0) {
    lines.push(`Refundable federal credits: -${money(taxes.federalRefundableCredits, year)}`);
  }
  if (penalty > 0) {
    lines.push(`Early withdrawal penalties are shown separately: ${money(penalty, year)}`);
  }
  return lines.join("\n");
}

function capitalLossCarryforwardDetail(year) {
  const detail = year?.lossCarryforwardDetail ?? {};
  const taxes = year?.taxes ?? {};
  const shortTerm = Number.isFinite(Number(taxes.lossCarryforwardShort))
    ? Number(taxes.lossCarryforwardShort)
    : Math.max(0, Number(detail.shortTerm) || 0);
  const longTerm = Number.isFinite(Number(taxes.lossCarryforwardLong))
    ? Number(taxes.lossCarryforwardLong)
    : Math.max(0, Number(detail.longTerm) || 0);
  const total = Number.isFinite(Number(taxes.lossCarryforward))
    ? Number(taxes.lossCarryforward)
    : Math.max(0, Number(year?.lossCarryforward) || shortTerm + longTerm);
  return { shortTerm, longTerm, total };
}

function capitalLossCarryforwardText(year) {
  const { shortTerm, longTerm, total } = capitalLossCarryforwardDetail(year);
  if (!(total > 0)) return money(0, year);
  return `${money(total, year)} loss carryforward (${money(shortTerm, year)} short-term; ${money(longTerm, year)} long-term)`;
}

function stateCapitalLossReviewRequired(year) {
  return year?.taxes?.stateTaxBreakdown?.capitalLossTreatment?.reviewRequired === true;
}

function stateCapitalLossReviewNote(year) {
  const assumption = year?.taxes?.stateTaxBreakdown?.capitalLossTreatment?.assumption ?? "federal-AGI conformity approximation";
  return `state tax uses ${assumption}; verify resident-state loss carryforward rules.`;
}

function stateCapitalLossReviewSuffix(year) {
  return stateCapitalLossReviewRequired(year) ? `; ${stateCapitalLossReviewNote(year)}` : "";
}

function taxRefundNodeDetails(year) {
  const refundCash = Math.max(0, Number(year?.taxRefundCash) || 0);
  if (refundCash <= 0) return "";
  const taxes = year?.taxes ?? {};
  const lines = [
    `Tax refund: ${money(refundCash, year)}`,
    `Additional Child Tax Credit: ${money(taxes.additionalChildTaxCredit ?? 0, year)}`,
    `Earned income used for ACTC sizing: ${money(taxes.earnedIncomeForRefundableCredits ?? 0, year)}`,
    `Unused Child Tax Credit: ${money(taxes.unusedChildTaxCredit ?? 0, year)}`
  ];
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
  const earnedIncome = adjustAmount(year.earnedIncome ?? 0, year);
  const oneOffIncome = adjustAmount(year.oneOffIncome ?? 0, year);
  const taxRefund = adjustAmount(year.taxRefundCash ?? 0, year);
  const unspent = adjustAmount(year.unspentCash ?? 0, year);
  const spending = adjustAmount(year.plannedSpending ?? 0, year);
  const medical = adjustAmount(year.medicalCost ?? 0, year);
  const penalties = adjustAmount(year.penaltyTax ?? 0, year);
  const taxes = adjustAmount(Math.max(0, (year.taxes?.totalTax ?? 0) - (year.penaltyTax ?? 0)), year);
  const totalReturn = ending + withdrawals - beginning - unspent;
  const marketGains = Math.max(0, totalReturn);
  const marketLosses = Math.max(0, -totalReturn);
  const reserveInflow = withdrawals + dividends + socialSecurity + earnedIncome + oneOffIncome + taxRefund;
  const reserveOutflow = spending + medical + taxes + penalties;
  const flows = [
    { from: "Starting balance", to: "Portfolio after returns", amount: beginning, type: "balance" }
  ];

  if (marketGains > 0) flows.push({ from: "Market gains", to: "Portfolio after returns", amount: marketGains, type: "income" });
  if (marketLosses > 0) flows.push({ from: "Portfolio after returns", to: "Market losses", amount: marketLosses, type: "loss" });
  if (withdrawals > 0) flows.push({ from: "Portfolio after returns", to: "Yearly cash flow", amount: withdrawals, type: "withdrawal" });
  if (dividends > 0) flows.push({ from: "Taxable dividends", to: "Yearly cash flow", amount: dividends, type: "income" });
  if (socialSecurity > 0) flows.push({ from: "Social Security", to: "Yearly cash flow", amount: socialSecurity, type: "income" });
  if (earnedIncome > 0) flows.push({ from: "Earned income", to: "Yearly cash flow", amount: earnedIncome, type: "income" });
  if (oneOffIncome > 0) flows.push({ from: "One-off income", to: "Yearly cash flow", amount: oneOffIncome, type: "income" });
  if (taxRefund > 0) flows.push({ from: "Tax refund", to: "Yearly cash flow", amount: taxRefund, type: "income" });
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
  const marketplaceZip = String(els.marketplaceZip?.value || "").trim();
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
    zip: marketplaceZip || null,
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
  const spendingStrategyMode = normalizeUserPlanningSpendingMode(els.spendingStrategyMode?.value);
  const essentialSpend = Math.max(0, Number(els.essentialSpend?.value) || 0);
  const discretionarySpend = Math.max(0, Number(els.discretionarySpend?.value) || 0);
  const correctionDiscretionaryPercent = percentInputValue("guardrailCorrectionDiscretionaryPercent", 0.5);
  const bearDiscretionaryPercent = percentInputValue("guardrailBearDiscretionaryPercent", 0);
  const riskBasedGuardrails = {
    targetSuccessRate: percentInputValue("riskGuardrailTargetSuccessRate", 0.9),
    lowerSuccessRate: percentInputValue("riskGuardrailLowerSuccessRate", 0.75),
    upperSuccessRate: percentInputValue("riskGuardrailUpperSuccessRate", 1),
    minimumAdjustmentPercent: percentInputValue("riskGuardrailMinimumAdjustmentPercent", 0.05),
    incomeFloor: numberOrNull(els.riskGuardrailIncomeFloor?.value),
    incomeCeiling: numberOrNull(els.riskGuardrailIncomeCeiling?.value)
  };
  const targetSpend = spendingStrategyMode === "discretionaryGuardrails"
    ? essentialSpend + discretionarySpend
    : Number(els.targetSpend.value) || 0;

  const scenario = {
    ...DEFAULT_SCENARIO,
    taxYear,
    privacyMode: privacyModeEnabled(),
    state,
    filingStatus: els.filingStatus.value,
    householdSize,
    marketplaceMembers,
    currentAge,
    spouseAge,
    primaryMortalityAge: numberOrNull(els.primaryMortalityAge.value) ?? DEFAULT_SCENARIO.primaryMortalityAge,
    spouseMortalityAge: numberOrNull(els.spouseMortalityAge.value) ?? DEFAULT_SCENARIO.spouseMortalityAge,
    heirType: els.heirType.value || DEFAULT_SCENARIO.heirType,
    nonSpouse10YrTaxDrag: percentInputValue("nonSpouse10YrTaxDrag", DEFAULT_SCENARIO.nonSpouse10YrTaxDrag),
    eligibleDesignatedTaxDiscount: percentInputValue("eligibleDesignatedTaxDiscount", DEFAULT_SCENARIO.eligibleDesignatedTaxDiscount),
    heirBaseIncome: Number(els.heirBaseIncome.value) || 80000,
    heirAge: Number(els.heirAge.value) || 30,
    heirState: els.heirState.value || null,
    retirementPenaltyAge: Number(els.retirementPenaltyAge.value) || DEFAULT_SCENARIO.retirementPenaltyAge,
    rothBasis: Number(els.rothBasis.value) || 0,
    earlyWithdrawalPenaltyExceptionAmount: numberOrNull(els.earlyWithdrawalPenaltyExceptionAmount.value) ?? 0,
    rothFiveYearRuleSatisfied: els.rothFiveYearRuleSatisfied.checked,
    heirOrdinaryTaxRate: percentInputValue("heirOrdinaryTaxRate", DEFAULT_SCENARIO.heirOrdinaryTaxRate),
    medicareWages: Number(els.medicareWages.value) || 0,
    socialSecurityWages: numberOrNull(els.socialSecurityWages.value),
    selfEmploymentIncome: Number(els.selfEmploymentIncome.value) || 0,
    rrtaCompensation: Number(els.rrtaCompensation.value) || 0,
    spouseMedicareWages: Number(els.spouseMedicareWages?.value) || 0,
    spouseSocialSecurityWages: numberOrNull(els.spouseSocialSecurityWages?.value),
    spouseSelfEmploymentIncome: Number(els.spouseSelfEmploymentIncome?.value) || 0,
    estimateSocialSecurityFromEarnings: els.estimateSocialSecurityFromEarnings?.checked === true,
    earnedIncomeInflationAdjusted: els.earnedIncomeInflationAdjusted.checked,
    socialSecurityAnnualBenefit: Number(els.socialSecurityAnnualBenefit.value) || 0,
    socialSecurityStartAge: Number(els.socialSecurityStartAge.value) || DEFAULT_SCENARIO.socialSecurityStartAge,
    socialSecurityInflationAdjusted: els.socialSecurityInflationAdjusted.checked,
    spouseSocialSecurityAnnualBenefit: Number(els.spouseSocialSecurityAnnualBenefit.value) || 0,
    spouseSocialSecurityStartAge: Number(els.spouseSocialSecurityStartAge.value) || DEFAULT_SCENARIO.spouseSocialSecurityStartAge,
    spouseSocialSecurityInflationAdjusted: els.spouseSocialSecurityInflationAdjusted.checked,
    rmd: {
      enabled: els.rmdEnabled.checked,
      startAge: numberOrNull(els.rmdStartAge.value),
      spouseStartAge: numberOrNull(els.rmdSpouseStartAge?.value)
    },
    medicare: {
      irmaaEnabled: els.irmaaEnabled.checked,
      partBEnrollees: numberOrNull(els.medicarePartBEnrollees.value),
      partDEnrollees: numberOrNull(els.medicarePartDEnrollees.value),
      partDMonthlyPremium: numberOrNull(els.medicarePartDMonthlyPremium.value) ?? 0,
      medigapMonthlyPremium: numberOrNull(els.medicareMedigapMonthlyPremium?.value) ?? 0,
      annualOopBase: numberOrNull(els.medicareAnnualOopBase?.value),
      twoYearsPriorMagi: numberOrNull(els.twoYearsPriorMagi.value),
      priorYearMagi: numberOrNull(els.priorYearMagi.value),
      maxIrmaaTier: numberOrNull(els.maxIrmaaTier?.value),
      marriedFilingSeparatelyLivedTogether: els.mfsLivedTogether.checked
    },
    planYears: clampInteger(Number(els.planYears.value), 1, 80),
    targetSpend,
    targetSpendIncludesTaxes: els.includeTaxes.checked,
    targetSpendIncludesMedical: els.includeMedical.checked,
    medicalExpensesBase: Number(els.medicalBase.value) || 0,
    expectedOopMaxUsePercent: Math.max(0, Math.min(1, (Number(els.expectedOopPercent.value) || 0) / 100)),
    oopMaxOverride: selectedPlanOopMaximumOverride,
    withdrawalStrategy: {
      mode: els.withdrawalStrategyMode?.value === "lifetime" ? "lifetime" : "heuristic"
    },
    withdrawalOrder: readWithdrawalOrder(),
    spendingStrategy: {
      mode: spendingStrategyMode,
      essentialSpend,
      discretionarySpend,
      essentialInflationAdjusted: true,
      discretionaryInflationAdjusted: false,
      correctionDrawdownThreshold: 0.1,
      bearDrawdownThreshold: 0.2,
      correctionDiscretionaryPercent,
      bearDiscretionaryPercent,
      marketAssetClass: "stock",
      riskBasedGuardrails
    },
    sequenceRiskReserve: {
      enabled: (els.sequenceReserveMode?.value ?? "none") !== "none",
      mode: ["cash", "bond", "hybrid"].includes(els.sequenceReserveMode?.value) ? els.sequenceReserveMode.value : "cash",
      targetYears: Math.max(0.5, Number(els.sequenceReserveTargetYears?.value) || 3),
      tentYears: Math.max(1, Number(els.sequenceReserveTentYears?.value) || 10),
      triggerStockReturn: 0
    },
    tipsLadder: {
      enabled: els.tipsLadderEnabled?.checked === true,
      years: numberOrNull(els.tipsLadderYears?.value) ?? 10,
      annualRealAmount: numberOrNull(els.tipsLadderAnnualAmount?.value),
      realYieldPercent: numberOrNull(els.tipsLadderRealYieldPercent?.value) ?? 2,
      maintenanceMode: els.tipsLadderMaintenanceMode?.value ?? "none",
      replenishCatchUp: els.tipsLadderReplenishCatchUp ? els.tipsLadderReplenishCatchUp.checked === true : true,
      triggerStockReturnPercent: numberOrNull(els.tipsLadderTriggerStockReturnPercent?.value) ?? 0
    },
    allocationStrategy: {
      withdrawalBiasEnabled: els.allocationAwareWithdrawals?.checked === true,
      rebalanceEnabled: els.taxAwareRebalancing?.checked === true,
      glidepathEnabled: els.equityGlidepath?.checked === true,
      targetStockPercent: Math.max(0, Math.min(100, Number(els.targetStockAllocation?.value) || 70)),
      rebalanceBandPercent: Math.max(0, Math.min(50, Number(els.rebalanceBand?.value) || 5)),
      glidepathStartStockPercent: Math.max(0, Math.min(100, Number(els.glidepathStartStockAllocation?.value) || 60)),
      glidepathEndStockPercent: Math.max(0, Math.min(100, Number(els.glidepathEndStockAllocation?.value) || 80)),
      glidepathYears: Math.max(1, Number(els.glidepathYears?.value) || 15)
    },
    taxEfficiencyStrategy: {
      marginalRateOptimizationEnabled: els.unifiedMarginalOptimizer?.checked !== false,
      assetLocationEnabled: els.assetLocationOptimization?.checked === true,
      hsaContributionEnabled: els.hsaContributionStrategy?.checked === true,
      hsaCoverage: ["auto", "self", "family"].includes(els.hsaCoverage?.value) ? els.hsaCoverage.value : "auto",
      hsaAnnualContribution: numberOrNull(els.hsaContributionAmount?.value),
      hsaContributionInflationAdjusted: true,
      hsaCatchUpEnabled: true,
      hsaInvestmentAssetClass: "stock",
      // Default ON (checkbox checked): cap tax-free HSA withdrawals at the
      // tracked qualified-expense pool. Explicit opt-out restores the legacy
      // unlimited tax-free behavior. Contribution strategy still forces
      // tracking on inside hsaStrategyConfig.
      hsaUseForQualifiedExpenses: els.hsaQualifiedExpenseLimit?.checked !== false
    },
    monteCarlo: {
      assumptionPreset: presetIdIsKnown(els.mcPreset?.value) || els.mcPreset?.value === "custom"
        ? els.mcPreset.value
        : DEFAULT_SCENARIO.monteCarlo.assumptionPreset,
      samplingMode: normalizeMonteCarloSamplingMode(els.mcSamplingMode?.value),
      meanReversion: readMonteCarloMeanReversion(),
      inflationPersistence: Math.max(0, Math.min(0.95, (numberOrNull(els.mcInflationPersistence?.value) ?? 0) / 100))
    },
    returnAssumptions: readMonteCarloReturnAssumptions(),
    oneOffExpenses,
    incomeStreams,
    agePhasedSpending: {
      enabled: els.agePhasedSpending?.checked === true,
      slowGoAge: numberOrNull(els.slowGoAge?.value) ?? 76,
      slowGoPercent: numberOrNull(els.slowGoPercent?.value) ?? 85,
      noGoAge: numberOrNull(els.noGoAge?.value) ?? 86,
      noGoPercent: numberOrNull(els.noGoPercent?.value) ?? 75
    },
    ltcStress: {
      enabled: els.ltcStressEnabled?.checked === true,
      member: els.ltcStressMember?.value === "spouse" ? "spouse" : "primary",
      startAge: numberOrNull(els.ltcStressStartAge?.value) ?? 85,
      years: numberOrNull(els.ltcStressYears?.value) ?? 3,
      annualCost: numberOrNull(els.ltcStressAnnualCost?.value) ?? 100000
    },
    survivorStepUp: {
      enabled: els.survivorStepUpEnabled?.checked === true,
      jointBasisStepUpPercent: numberOrNull(els.survivorStepUpJointPercent?.value) ?? 50
    },
    heirTaxIndexing: els.heirTaxIndexing?.value === "frozen2026" ? "frozen2026" : "indexed",
    taxLossHarvesting: {
      enabled: els.taxLossHarvesting.checked,
      mode: numberOrNull(els.tlhMax.value) == null ? "auto" : "manual",
      overrideMaxLoss: numberOrNull(els.tlhMax.value)
    },
    taxGainHarvesting: {
      enabled: els.taxGainHarvesting.checked,
      mode: numberOrNull(els.tghMax.value) == null ? "auto" : "manual",
      overrideMaxGain: numberOrNull(els.tghMax.value),
      magiBuffer: numberOrNull(els.taxGainMagiBuffer?.value) ?? 0
    },
    rothConversion: {
      enabled: els.rothConversion.checked,
      mode: numberOrNull(els.rothAmount.value) == null ? "auto" : "manual",
      overrideAmount: numberOrNull(els.rothAmount.value),
      targetMarginalRate: Math.max(0, (Number(els.rothTargetRate.value) || 12) / 100),
      optimizeForAca: els.rothConversionOptimizeForAca?.checked !== false,
      maxAcaFplPercent: Math.max(100, Math.min(600, Number(els.rothConversionMaxAcaFplPercent?.value) || 400)),
      magiBuffer: Math.max(0, Number(els.rothConversionMagiBuffer?.value) || 0),
      applyMagiGuardrails: els.rothConversionMagiGuardrails?.checked === true,
      spendingAware: els.rothConversionSpendingAware?.checked !== false,
      spendFromBasis: els.rothConversionSpendFromBasis?.checked !== false
    },
    rothBasisOptimization: {
      enabled: els.rothBasisOptimization?.checked !== false,
      minSavingsRate: DEFAULT_SCENARIO.rothBasisOptimization?.minSavingsRate ?? 0.5,
      opportunityCostMode: els.rothBasisOpportunityCostMode?.value === "fixed" ? "fixed" : "dynamic",
      magiBuffer: Math.max(0, Number(els.rothBasisMagiBuffer?.value) || 1000)
    },
    aca
  };
  return applyRescueScenarioOverride(scenario);
}

function readWithdrawalOrder() {
  const raw = String(els.withdrawalOrder?.value || "").trim();
  const order = raw.split(",").map((item) => item.trim()).filter(Boolean);
  const allowed = new Set(["taxable", "traditional", "hsa", "roth"]);
  return order.length ? order.filter((item) => allowed.has(item)) : [...DEFAULT_SCENARIO.withdrawalOrder];
}

function percentInputValue(id, fallback) {
  const value = Number(document.querySelector(`#${id}`)?.value);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) / 100 : fallback;
}

function applyRescueScenarioOverride(scenario) {
  if (!appliedRescueScenarioOverride || typeof appliedRescueScenarioOverride !== "object") {
    return scenario;
  }
  return mergePlainObjects(scenario, appliedRescueScenarioOverride);
}

function mergePlainObjects(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base?.[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      merged[key] = mergePlainObjects(base[key], value);
    } else if (Array.isArray(value)) {
      merged[key] = value.map((item) => item && typeof item === "object" ? { ...item } : item);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function presetIdIsKnown(value) {
  return Object.prototype.hasOwnProperty.call(MONTE_CARLO_ASSUMPTION_PRESETS, value);
}

function readDecisionProfile(scenario) {
  const requiredSpend = numberOrNull(els.decisionRequiredSpend?.value);
  const flexibleSpend = numberOrNull(els.decisionFlexibleSpend?.value);
  const targetPercent = numberOrNull(els.decisionTargetSuccessRate?.value);
  const targetSuccessRate = targetPercent == null ? 0.9 : Math.max(1, Math.min(99, targetPercent)) / 100;
  return {
    mode: "recentlyLeftWork",
    requiredSpend,
    flexibleSpend,
    targetSuccessRate,
    targetSuccessRateUserOverridden: targetPercent != null && Math.abs(targetPercent - 90) > 0.001,
    verdictObjective: "avoidDepletion",
    minimumAcceptableHistoricalWorstEnding: 0,
    evidenceWeights: {
      monteCarlo: 0.5,
      historical: 0.5
    },
    incomeBridge: {
      enabled: els.decisionIncomeBridgeEnabled?.checked !== false,
      startYear: 1,
      maxYears: 6,
      maxAnnualIncome: 150000,
      incomeType: "medicareWages"
    },
    healthcarePriority: scenario?.state === "Massachusetts" ? "preserveConnectorCare" : "preserveAcaSubsidy",
    healthcarePlanSelection: {
      mode: scenario?.state === "Massachusetts" ? "maConnectorCarePlanType" : "manualOrMarketplace",
      selectedPlanId: els.maConnectorCarePlanType?.value || null
    },
    share: {
      mode: "deferred",
      allowInputTweaks: false
    }
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
    itemizedDeductionMode: els.itemizedDeductionMode?.value || "auto",
    itemizedStateLocalTaxes: Number(els.itemizedStateLocalTaxes?.value) || 0,
    itemizedMortgageInterest: Number(els.itemizedMortgageInterest?.value) || 0,
    itemizedCharitableContributions: Number(els.itemizedCharitableContributions?.value) || 0,
    itemizedMedicalExpenses: Number(els.itemizedMedicalExpenses?.value) || 0,
    amtPreferenceItems: Number(els.amtPreferenceItems?.value) || 0,
    qbiSourceMode: els.qbiSourceMode?.value || "none",
    qbiAmount: Number(els.qbiAmount?.value) || 0,
    qbiSpecifiedServiceBusiness: els.qbiSpecifiedServiceBusiness?.checked === true,
    qbiW2Wages: Number(els.qbiW2Wages?.value) || 0,
    qbiUbiaQualifiedProperty: Number(els.qbiUbiaQualifiedProperty?.value) || 0,
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

function tableHtml(headers, rows, rowAttrs = () => "", footerHtml = "") {
  // data-label on each <td> lets narrow-viewport CSS reflow the table into a
  // stacked card layout (see #actionPlan rule in redesign.css). Unused by
  // tables that keep the default table presentation.
  const labels = headers.map((header) => escapeHtml(header));
  return `
    <table>
      <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map((row, index) => `<tr ${rowAttrs(index)}>${row.map((cell, cellIndex) => `<td data-label="${labels[cellIndex] ?? ""}">${cell}</td>`).join("")}</tr>`).join("")}
      </tbody>
      ${footerHtml ? `<tfoot>${footerHtml}</tfoot>` : ""}
    </table>
  `;
}

function scenarioStreamingFooter(progress) {
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const remaining = Math.max(0, total - done);
  return `
    <tr class="streaming-row" aria-live="polite">
      <td colspan="5">
        <span class="streaming-spinner" aria-hidden="true"></span>
        <span class="streaming-label">Running… ${done.toLocaleString()} of ${total.toLocaleString()} scenarios</span>
        <span class="streaming-remaining">${remaining.toLocaleString()} to go</span>
      </td>
    </tr>
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
  const normalizedOptions = options.map((option) => (
    typeof option === "object" ? option : { value: option, label: option }
  ));
  return `
    <select data-index="${index}" data-field="${field}">
      ${normalizedOptions.map((option) => `<option value="${escapeAttr(option.value)}" ${option.value === value ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
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

function guardrailPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? percentFormatter.format(value) : "n/a";
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

function focusPlanningValidationError(error) {
  const controlId = error?.controlId;
  if (!controlId) return;
  const element = document.querySelector(`#${controlId}`);
  if (!element) return;
  element.focus({ preventScroll: false });
  element.select?.();
  element.reportValidity?.();
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
