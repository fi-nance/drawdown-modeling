// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: hsa. No behavior changes — pure code movement.

import { marketValue } from "../portfolio.mjs";
import { round } from "../utils.mjs";
import { CASH_RAISED_EPSILON, DEFENSIVE_ASSET_CLASSES, GROWTH_ASSET_CLASSES } from "./constants.mjs";
import { optionalFiniteNumber } from "./guards.mjs";
import { assetClassLabel } from "./portfolioQueries.mjs";
import { expectedReturnForAsset } from "./scenario.mjs";

const HSA_LIMITS_2026 = Object.freeze({
  selfOnly: 4400,
  family: 8750,
  catchUp55: 1000
});

export function hsaStrategyConfig(scenario) {
  const config = scenario.taxEfficiencyStrategy ?? {};
  const contribution = optionalFiniteNumber(config.hsaAnnualContribution);
  return {
    marginalRateOptimizationEnabled: config.marginalRateOptimizationEnabled !== false,
    assetLocationEnabled: config.assetLocationEnabled === true,
    hsaContributionEnabled: config.hsaContributionEnabled === true,
    hsaCoverage: ["auto", "self", "family"].includes(config.hsaCoverage) ? config.hsaCoverage : "auto",
    hsaAnnualContribution: contribution,
    hsaContributionInflationAdjusted: config.hsaContributionInflationAdjusted !== false,
    hsaCatchUpEnabled: config.hsaCatchUpEnabled !== false,
    hsaInvestmentAssetClass: GROWTH_ASSET_CLASSES.includes(config.hsaInvestmentAssetClass)
      || DEFENSIVE_ASSET_CLASSES.includes(config.hsaInvestmentAssetClass)
      ? config.hsaInvestmentAssetClass
      : "stock",
    useForQualifiedExpenses: config.hsaUseForQualifiedExpenses === true || config.hsaContributionEnabled === true,
    startingQualifiedExpenseBalance: Math.max(0, Number(config.startingHsaQualifiedExpenseBalance) || 0)
  };
}

export function hsaContributionForYear({ scenario, age, spouseAge, inflationIndex }) {
  const config = hsaStrategyConfig(scenario);
  if (!config.hsaContributionEnabled || age >= 65) {
    return emptyHsaContribution(config);
  }

  const coverage = config.hsaCoverage === "auto"
    ? (Number(scenario.aca?.marketplaceMembers) || 1) > 1 ? "family" : "self"
    : config.hsaCoverage;
  const baseLimit = coverage === "family" ? HSA_LIMITS_2026.family : HSA_LIMITS_2026.selfOnly;
  const catchUp = config.hsaCatchUpEnabled
    ? (age >= 55 && age < 65 ? HSA_LIMITS_2026.catchUp55 : 0)
      + (coverage === "family" && Number.isFinite(spouseAge) && spouseAge >= 55 && spouseAge < 65
        ? HSA_LIMITS_2026.catchUp55
        : 0)
    : 0;
  const automaticLimit = baseLimit + catchUp;
  const requested = config.hsaAnnualContribution == null
    ? automaticLimit
    : Math.min(config.hsaAnnualContribution, automaticLimit);
  const index = config.hsaContributionInflationAdjusted ? inflationIndex : 1;
  const amount = round(Math.max(0, requested) * Math.max(0, index), 6);

  return {
    enabled: true,
    amount,
    coverage,
    baseLimit: round(baseLimit * Math.max(0, index), 6),
    catchUpLimit: round(catchUp * Math.max(0, index), 6),
    assetClass: config.hsaInvestmentAssetClass
  };
}

export function emptyHsaContribution(config = hsaStrategyConfig({})) {
  return {
    enabled: false,
    amount: 0,
    coverage: config.hsaCoverage ?? "auto",
    baseLimit: 0,
    catchUpLimit: 0,
    assetClass: config.hsaInvestmentAssetClass ?? "stock"
  };
}

export function hsaQualifiedExpenseAvailableForWithdrawal({ scenario, hsaQualifiedExpenseBalance = 0, medicalEstimate = 0 }) {
  const config = hsaStrategyConfig(scenario);
  if (!config.useForQualifiedExpenses) return Infinity;
  return round(Math.max(0, hsaQualifiedExpenseBalance + Math.max(0, medicalEstimate)), 6);
}

export function addHsaContributionLot(portfolio, contribution, { calendarYear = null, returnAssumptions = {} } = {}) {
  const amount = Math.max(0, contribution?.amount ?? 0);
  if (amount <= CASH_RAISED_EPSILON) return;

  const assetClass = contribution.assetClass ?? "stock";
  const template = portfolio.find((asset) => (
    asset.accountType === "hsa"
    && asset.assetClass === assetClass
    && marketValue(asset) > CASH_RAISED_EPSILON
  ));
  const price = Math.max(CASH_RAISED_EPSILON, Number(template?.price) || 1);
  portfolio.push({
    id: `hsa-contribution-${calendarYear ?? "na"}-${portfolio.length + 1}`,
    name: `${assetClassLabel(assetClass)} HSA contribution`,
    accountType: "hsa",
    assetClass,
    beneficiaryType: template?.beneficiaryType ?? "default",
    units: round(amount / price, 8),
    price: round(price, 8),
    costBasisPerUnit: round(price, 8),
    holdingPeriod: "long",
    expectedReturn: Number.isFinite(Number(template?.expectedReturn))
      ? Number(template.expectedReturn)
      : expectedReturnForAsset({ assetClass }, returnAssumptions),
    ...(Number.isFinite(Number(template?.dividendYield)) ? { dividendYield: Number(template.dividendYield) } : {}),
    ...(Number.isFinite(Number(template?.qualifiedDividendShare))
      ? { qualifiedDividendShare: Number(template.qualifiedDividendShare) }
      : {})
  });
}
