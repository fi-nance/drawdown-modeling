// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: household. No behavior changes — pure code movement.

import { acaAgeRatingFactor } from "../aca.mjs";
import { buildTaxProfile, getAcaFplGuideline } from "../../data/taxData.mjs";
import { round } from "../utils.mjs";
import { DEFAULT_SCENARIO } from "./scenario.mjs";

// Mortality semantics: `mortalityAge` is the calendar age at which the person
// dies. Per tax law, the year of death is filed jointly (MFJ → MFJ) and the
// surviving spouse files single starting the following year. So `age > mortalityAge`
// (strictly greater) is the "post-death" predicate, not `age >=`.
export function mortalityStatus(scenario, yearIndex) {
  const primaryAge = (scenario.currentAge ?? 55) + yearIndex;
  const spouseAge = Number.isFinite(Number(scenario.spouseAge))
    ? Number(scenario.spouseAge) + yearIndex
    : null;
  const primaryDeceased = primaryAge > (scenario.primaryMortalityAge ?? 95);
  const spouseDeceased = spouseAge !== null && spouseAge > (scenario.spouseMortalityAge ?? 95);
  return { primaryAge, spouseAge, primaryDeceased, spouseDeceased };
}

export function isMarriedFiling(filingStatus) {
  return filingStatus === "marriedFilingJointly" || filingStatus === "marriedFilingSeparately";
}

// Build a single-filer tax profile from a married baseline, preserving every
// user override (overrideRate, dependentCount, stateRetirementExclusion, etc.)
// by re-running buildTaxProfile against the original build inputs. Falls back
// to a best-effort rebuild when the profile was constructed by hand (test
// fixtures without `buildOptions`).
export function buildSurvivorTaxProfile(taxProfile) {
  if (taxProfile?.buildOptions) {
    return buildTaxProfile({ ...taxProfile.buildOptions, filingStatus: "single" });
  }
  // Hand-rolled fixture path: no overrides to preserve.
  return buildTaxProfile({
    filingStatus: "single",
    state: taxProfile?.state?.state ?? "Florida"
  });
}

export function acaConfigForSimulationYear({
  config,
  scenario,
  hasSpouseLife,
  primaryDeceased,
  spouseDeceased
}) {
  if (!config?.enabled || !hasSpouseLife) return config;
  if (primaryDeceased === spouseDeceased) return config;
  return shrinkAcaConfigForSurvivor({
    config,
    scenario,
    deceasedIndex: primaryDeceased ? 0 : 1
  });
}

function shrinkAcaConfigForSurvivor({ config, scenario, deceasedIndex }) {
  const originalHouseholdSize = householdSizeFromAca(config);
  const survivorHouseholdSize = Math.max(1, originalHouseholdSize - 1);
  const coverage = shrinkAcaCoverageForSurvivor({
    config,
    deceasedIndex,
    originalHouseholdSize,
    survivorHouseholdSize
  });
  const planYear = Math.trunc(Number(config.year ?? scenario?.taxYear ?? DEFAULT_SCENARIO.aca?.year ?? 2026) || 2026);
  const state = config.state ?? scenario?.state ?? "Florida";

  return {
    ...coverage,
    fpl: config.manualFpl === true
      ? config.fpl
      : getAcaFplGuideline({ taxYear: planYear, state, householdSize: survivorHouseholdSize }),
    backupPlan: config.backupPlan?.enabled
      ? shrinkAcaCoverageForSurvivor({
        config: config.backupPlan,
        parentConfig: config,
        deceasedIndex,
        originalHouseholdSize,
        survivorHouseholdSize
      })
      : config.backupPlan ?? null
  };
}

function shrinkAcaCoverageForSurvivor({
  config,
  parentConfig = null,
  deceasedIndex,
  originalHouseholdSize,
  survivorHouseholdSize
}) {
  const originalMarketplaceMembers = marketplaceMembersFromAca(config, parentConfig);
  const survivorMarketplaceMembers = originalMarketplaceMembers > 1
    ? originalMarketplaceMembers - 1
    : originalMarketplaceMembers;
  const benchmarkScale = acaSurvivorPremiumScale({
    config,
    originalMarketplaceMembers,
    survivorMarketplaceMembers,
    deceasedIndex,
    referenceAgesKey: "benchmarkPremiumReferenceAges",
    referenceAgeKey: "benchmarkPremiumReferenceAge",
    ageRatedKey: "ageRatedBenchmarkPremium"
  });
  const selectedPlanScale = acaSurvivorPremiumScale({
    config,
    originalMarketplaceMembers,
    survivorMarketplaceMembers,
    deceasedIndex,
    referenceAgesKey: "selectedPlanPremiumReferenceAges",
    referenceAgeKey: "selectedPlanPremiumReferenceAge",
    ageRatedKey: "ageRatedSelectedPlanPremium"
  });
  const costSharingLimit = config.costSharingLimit ?? parentConfig?.costSharingLimit;
  const oopMaximum = config.manualOopMaximum === true || !costSharingLimit
    ? config.oopMaximum
    : survivorMarketplaceMembers > 1
      ? costSharingLimit.family
      : costSharingLimit.selfOnly;

  return {
    ...config,
    householdSize: survivorHouseholdSize,
    marketplaceMembers: survivorMarketplaceMembers,
    memberAges: dropAcaCoveredMember(config.memberAges, deceasedIndex, originalMarketplaceMembers, survivorMarketplaceMembers),
    benchmarkPremium: scaleFiniteMoney(config.benchmarkPremium, benchmarkScale),
    planPremium: scaleFiniteMoney(config.planPremium, selectedPlanScale),
    selectedPlanPremium: scaleFiniteMoney(config.selectedPlanPremium, selectedPlanScale),
    benchmarkPremiumReferenceAges: dropAcaCoveredMember(config.benchmarkPremiumReferenceAges, deceasedIndex, originalMarketplaceMembers, survivorMarketplaceMembers),
    selectedPlanPremiumReferenceAges: dropAcaCoveredMember(config.selectedPlanPremiumReferenceAges, deceasedIndex, originalMarketplaceMembers, survivorMarketplaceMembers),
    oopMaximum
  };
}

function acaSurvivorPremiumScale({
  config,
  originalMarketplaceMembers,
  survivorMarketplaceMembers,
  deceasedIndex,
  referenceAgesKey,
  referenceAgeKey,
  ageRatedKey
}) {
  if (!(originalMarketplaceMembers > survivorMarketplaceMembers)) return 1;
  if (config?.[ageRatedKey] === true) {
    const fallbackAge = finiteNonNegativeAge(config?.[referenceAgeKey]) ?? finiteNonNegativeAge(config?.currentAge);
    const originalReference = acaReferenceRatingTotal({
      ages: config?.[referenceAgesKey],
      fallbackAge,
      members: originalMarketplaceMembers
    });
    const survivorReference = acaReferenceRatingTotal({
      ages: dropAcaCoveredMember(config?.[referenceAgesKey], deceasedIndex, originalMarketplaceMembers, survivorMarketplaceMembers),
      fallbackAge,
      members: survivorMarketplaceMembers
    });
    if (originalReference > 0 && survivorReference > 0) {
      return survivorReference / originalReference;
    }
  }
  return survivorMarketplaceMembers / originalMarketplaceMembers;
}

function acaReferenceRatingTotal({ ages, fallbackAge, members }) {
  const fallback = finiteNonNegativeAge(fallbackAge) ?? 21;
  return Array.from({ length: Math.max(1, members) }, (_, index) => {
    const age = finiteNonNegativeAge(ages?.[index]) ?? fallback;
    return acaAgeRatingFactor(age);
  }).reduce((total, factor) => total + factor, 0);
}

function dropAcaCoveredMember(values, deceasedIndex, originalMembers, survivorMembers) {
  if (!Array.isArray(values)) return values ?? null;
  if (!(originalMembers > survivorMembers)) return values.slice(0, survivorMembers);
  return values
    .filter((_, index) => index !== deceasedIndex)
    .slice(0, survivorMembers);
}

function householdSizeFromAca(config = {}) {
  return Math.max(1, Math.trunc(Number(config.householdSize) || 1));
}

function marketplaceMembersFromAca(config = {}, parentConfig = null) {
  return Math.max(1, Math.trunc(Number(config.marketplaceMembers) || Number(parentConfig?.marketplaceMembers) || Number(config.householdSize) || 1));
}

function finiteNonNegativeAge(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : null;
}

function scaleFiniteMoney(value, scale) {
  if (!Number.isFinite(Number(value))) return value;
  const numericScale = Number.isFinite(Number(scale)) ? Math.max(0, Number(scale)) : 1;
  return round(Math.max(0, Number(value)) * numericScale, 6);
}
