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
    // Tax-free treatment requires qualified, unreimbursed, undeducted expenses.
    // A legacy toggle cannot establish eligibility.
    useForQualifiedExpenses: true,
    startingQualifiedExpenseBalance: Math.max(0, (Number(config.startingHsaQualifiedExpenseBalance) || 0) - (Number(config.hsaPriorReimbursements) || 0) - (Number(config.hsaPriorDeductedExpenses) || 0))
  };
}

export function hsaContributionForYear({ scenario, age, spouseAge, inflationIndex }) {
  const config = hsaStrategyConfig(scenario);
  if (!config.hsaContributionEnabled) return emptyHsaContribution(config);
  const raw = scenario.taxEfficiencyStrategy ?? {};
  const months = (value, ownerAge, fallback) => Number.isFinite(ownerAge) && ownerAge < 65
    ? Math.max(0, Math.min(12, Math.trunc(Number(value ?? fallback) || 0))) : 0;
  const primaryMonths = months(raw.hsaPrimaryEligibleMonths, age, 12);
  const spouseMonths = months(raw.hsaSpouseEligibleMonths, spouseAge, 0);
  const coverage = config.hsaCoverage === 'auto'
    ? (Number(scenario.aca?.marketplaceMembers) || 1) > 1 ? 'family' : 'self' : config.hsaCoverage;
  const index = config.hsaContributionInflationAdjusted ? Math.max(0, inflationIndex) : 1;
  const limit = (coverage === 'family' ? HSA_LIMITS_2026.family : HSA_LIMITS_2026.selfOnly) * index;
  const spouseShare = !primaryMonths ? 1 : !spouseMonths ? 0 : Math.max(0, Math.min(1, Number(raw.hsaSpouseBaseShare) || 0));
  const primaryBase = limit * primaryMonths / 12 * (coverage === 'family' ? 1 - spouseShare : 1);
  const spouseBase = limit * spouseMonths / 12 * (coverage === 'family' ? spouseShare : 1);
  // The statutory $1,000 catch-up is not inflation-indexed and must go into
  // that person's own HSA. Eligibility-month proration avoids last-month-rule
  // assumptions and its subsequent testing-period obligation.
  const primaryCatchUp = config.hsaCatchUpEnabled && age >= 55 ? 1000 * primaryMonths / 12 : 0;
  const spouseCatchUp = config.hsaCatchUpEnabled && spouseAge >= 55 ? 1000 * spouseMonths / 12 : 0;
  const primaryRoom = Math.max(0, primaryBase + primaryCatchUp - Math.max(0, Number(raw.hsaPrimaryEmployerContribution) || 0));
  const spouseRoom = Math.max(0, spouseBase + spouseCatchUp - Math.max(0, Number(raw.hsaSpouseEmployerContribution) || 0));
  let remaining = config.hsaAnnualContribution == null ? primaryRoom + spouseRoom : Math.max(0, config.hsaAnnualContribution) * index;
  const primaryAmount = Math.min(remaining, primaryRoom);
  remaining -= primaryAmount;
  const spouseAmount = Math.min(remaining, spouseRoom);
  return { enabled: true, amount: round(primaryAmount + spouseAmount, 6),
    byOwner: { primary: round(primaryAmount, 6), spouse: round(spouseAmount, 6) },
    coverage, baseLimit: round(primaryBase + spouseBase, 6), catchUpLimit: round(primaryCatchUp + spouseCatchUp, 6), assetClass: config.hsaInvestmentAssetClass };
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
  if (contribution?.byOwner) {
    for (const owner of ['primary', 'spouse']) addHsaContributionLot(portfolio,
      { ...contribution, byOwner: null, owner, amount: contribution.byOwner[owner] }, { calendarYear, returnAssumptions });
    return;
  }
  const amount = Math.max(0, contribution?.amount ?? 0);
  const owner = contribution.owner ?? 'primary';
  if (amount <= CASH_RAISED_EPSILON) return;

  const assetClass = contribution.assetClass ?? "stock";
  const template = portfolio.find((asset) => (
    asset.accountType === "hsa"
    && (asset.owner ?? "primary") === owner
    && asset.assetClass === assetClass
    && marketValue(asset) > CASH_RAISED_EPSILON
  ));
  const price = Math.max(CASH_RAISED_EPSILON, Number(template?.price) || 1);
  portfolio.push({
    id: `hsa-contribution-${calendarYear ?? "na"}-${portfolio.length + 1}`,
    name: `${assetClassLabel(assetClass)} HSA contribution`,
    accountType: "hsa",
    owner,
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
