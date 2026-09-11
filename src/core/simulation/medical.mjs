// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: medical. No behavior changes — pure code movement.

import { computeAca } from "../aca.mjs";
import { getMedicareIrmaaConfig } from "../../data/taxData.mjs";
import { round } from "../utils.mjs";
import { clampIntegerLike, optionalFiniteNumber } from "./guards.mjs";
import { mortalityStatus, isMarriedFiling } from "./household.mjs";

export function computeAcaForYear({ age, spouseAge, magi, config, filingStatus }) {
  const married = isMarriedFiling(filingStatus) && Number.isFinite(spouseAge);
  const configuredAges = config?.currentMemberAges ?? config?.memberAges;
  const hasCalendarCoverage = (config?.coverageCalendar ?? []).some(row => Number(row.year) === Number(config.coverageYear ?? config.year ?? 2026));
  const hasCoveredDependent = Array.isArray(configuredAges) && configuredAges.some(memberAge => Number(memberAge) < 65);
  const both65Plus = (married ? age >= 65 && spouseAge >= 65 : age >= 65) && !hasCoveredDependent && !hasCalendarCoverage;
  const medicareMembers = (age >= 65 ? 1 : 0) + (married && spouseAge >= 65 ? 1 : 0);
  const ptcAllowedByFiling = filingStatus !== "marriedFilingSeparately" || config?.mfsPtcException === true;
  config = { ...config, ptcAllowedByFiling };
  if (both65Plus) {
    return { ...computeAca({ magi, config: { ...config, enabled: false } }), medicareEligibleHousehold: true, medicareMembers };
  }
  // ZIP-path fallback ages: when the ACA config carries no member ages, derive
  // them from the modeled primary/spouse ages so the rating-area SLCSP prices
  // the actual covered members — and drops a Medicare-eligible (65+) spouse
  // instead of billing the whole household at the primary's age. Only passed
  // when the config has no member ages, so user-entered/projected
  // `currentMemberAges` always win inside computeAca.
  const hasConfigMemberAges = (Array.isArray(config?.currentMemberAges) && config.currentMemberAges.length > 0)
    || (Array.isArray(config?.memberAges) && config.memberAges.length > 0);
  const fallbackHouseholdAges = !hasConfigMemberAges && Number.isFinite(age)
    ? (married ? [age, spouseAge] : [age])
    : null;
  return { ...computeAca({
    magi,
    config,
    ...(fallbackHouseholdAges ? { householdAges: fallbackHouseholdAges } : {})
  }), medicareMembers, medicareEligibleHousehold: false };
}

export function medicalCostForYear({
  scenario,
  aca,
  yearAcaConfig,
  inflationIndex,
  medicalInflationIndex = null,
  age,
  spouseAge,
  yearIndex,
  filingStatus,
  irmaaMagi,
  magiHistory
}) {
  const medIndex = medicalInflationIndex !== null && medicalInflationIndex !== undefined ? medicalInflationIndex : inflationIndex;
  const baseMedical = medicalCostForScenario(scenario, yearAcaConfig, medIndex, aca);
  const medicare = computeMedicareCostForYear({
    scenario,
    age,
    spouseAge,
    yearIndex,
    filingStatus,
    irmaaMagi,
    magiHistory,
    inflationIndex,
    medicalInflationIndex: medIndex
  });
  const ltcCost = ltcStressCostForYear({ scenario, yearIndex, medicalInflationIndex: medIndex });
  return {
    total: round(baseMedical + (aca?.netPremium ?? 0) + medicare.totalAnnualPremium + ltcCost, 6),
    medicare,
    qualifiedHsaExpenses: round(baseMedical + (age >= 65 && (!Number.isFinite(spouseAge) || spouseAge >= 65)
      ? medicare.partBAnnualPremium + medicare.partDAnnualPremium : 0)
      + Math.min(aca?.netPremium ?? 0, Math.max(0, Number(scenario.taxEfficiencyStrategy?.hsaEligibleInsurancePremiumAnnual) || 0) * medIndex)
      + (scenario.ltcStress?.hsaQualified === true ? ltcCost : 0), 6),
    ltcCost
  };
}

// Opt-in long-term-care stress: an additional medical-inflated annual cost
// while the selected member is alive and inside the configured age window.
// This is a planning stress test, not an LTC-insurance or care-cost model —
// the cost applies flatly for `years` years from `startAge` on the member's
// own age clock (today's dollars, medical-inflated).
export function ltcStressCostForYear({ scenario, yearIndex, medicalInflationIndex = 1 }) {
  const config = scenario?.ltcStress ?? {};
  if (config.enabled !== true) return 0;
  const annualCost = Math.max(0, Number(config.annualCost) || 0);
  const years = Math.max(0, Math.trunc(Number(config.years) || 0));
  const startAge = Number(config.startAge);
  if (!(annualCost > 0) || !(years > 0) || !Number.isFinite(startAge)) return 0;

  const { primaryAge, spouseAge, primaryDeceased, spouseDeceased } = mortalityStatus(scenario, yearIndex);
  const member = config.member === "spouse" ? "spouse" : "primary";
  const memberAge = member === "spouse" ? spouseAge : primaryAge;
  const memberDeceased = member === "spouse" ? spouseDeceased : primaryDeceased;
  if (memberAge === null || memberDeceased) return 0;
  if (memberAge < startAge || memberAge >= startAge + years) return 0;
  return round(annualCost * Math.max(0, medicalInflationIndex), 6);
}

function computeMedicareCostForYear({
  scenario,
  age,
  spouseAge,
  yearIndex,
  filingStatus,
  irmaaMagi,
  magiHistory,
  inflationIndex,
  medicalInflationIndex = null
}) {
  const medicare = scenario.medicare ?? {};
  const autoEnrollees = isMarriedFiling(filingStatus)
    ? (age >= 65 ? 1 : 0) + (Number.isFinite(spouseAge) && spouseAge >= 65 ? 1 : 0)
    : (age >= 65 ? 1 : 0);

  if (medicare.premiumsEnabled === false || autoEnrollees === 0) return emptyMedicareCost();

  const medIndex = medicalInflationIndex !== null && medicalInflationIndex !== undefined ? medicalInflationIndex : inflationIndex;
  const config = getMedicareIrmaaConfig({ taxYear: scenario.taxYear, inflationIndex, medicalInflationIndex: medIndex });
  const lookback = medicareLookbackReturn({ scenario, yearIndex, currentMagi: irmaaMagi, magiHistory, filingStatus });
  const lookbackMagi = lookback.magi;
  const bracket = medicare.irmaaEnabled === false ? {} : medicareIrmaaBracket({
    config,
    magi: lookbackMagi,
    filingStatus: lookback.filingStatus,
    marriedFilingSeparatelyLivedTogether: lookback.marriedFilingSeparatelyLivedTogether
  });
  const partBEnrollees = clampIntegerLike(medicare.partBEnrollees, 0, autoEnrollees, autoEnrollees);
  const partDEnrollees = clampIntegerLike(medicare.partDEnrollees, 0, autoEnrollees, partBEnrollees);
  const partDBaseMonthlyPremium = Math.max(0, Number(medicare.partDMonthlyPremium) || 0) * Math.max(0, medIndex);
  const partBMonthlyPremium = (config.partBStandardMonthlyPremium ?? 0) + (bracket.partBMonthlyAdjustment ?? 0);
  const partDMonthlyPremium = partDBaseMonthlyPremium + (bracket.partDMonthlyAdjustment ?? 0);
  // Medigap / Medicare Advantage supplemental premium: per Part B enrollee,
  // medical-inflated, with no IRMAA adjustment (IRMAA applies only to B/D).
  const medigapMonthlyPremium = Math.max(0, Number(medicare.medigapMonthlyPremium) || 0) * Math.max(0, medIndex);
  const partBAnnualPremium = round(partBMonthlyPremium * 12 * partBEnrollees, 6);
  const partDAnnualPremium = round(partDMonthlyPremium * 12 * partDEnrollees, 6);
  const medigapAnnualPremium = round(medigapMonthlyPremium * 12 * partBEnrollees, 6);

  return {
    enabled: true,
    lookbackMagi: round(lookbackMagi, 6),
    lookbackFilingStatus: lookback.filingStatus,
    lookbackSource: lookback.source,
    partBEnrollees,
    partDEnrollees,
    partBMonthlyPremium: round(partBMonthlyPremium, 6),
    partDMonthlyPremium: round(partDMonthlyPremium, 6),
    medigapMonthlyPremium: round(medigapMonthlyPremium, 6),
    partBMonthlyIrmaa: round(bracket.partBMonthlyAdjustment ?? 0, 6),
    partDMonthlyIrmaa: round(bracket.partDMonthlyAdjustment ?? 0, 6),
    partBAnnualPremium,
    partDAnnualPremium,
    medigapAnnualPremium,
    totalAnnualPremium: round(partBAnnualPremium + partDAnnualPremium + medigapAnnualPremium, 6)
  };
}

export function medicareLookbackReturn({ scenario, yearIndex, currentMagi, magiHistory, filingStatus }) {
  const medicare = scenario.medicare ?? {};
  const defaults = { filingStatus, marriedFilingSeparatelyLivedTogether: medicare.marriedFilingSeparatelyLivedTogether };
  const override = (medicare.irmaaOverrides ?? []).find(row => Number(row.year) === Number(scenario.startYear ?? scenario.taxYear ?? 2026) + yearIndex);
  if (override && Number.isFinite(Number(override.magi)) && Number(override.magi) >= 0) {
    return { ...defaults, ...override, magi: Number(override.magi), source: 'explicit-redetermination' };
  }
  const historical = yearIndex >= 2 ? magiHistory?.[yearIndex - 2] : null;
  if (historical && typeof historical === 'object' && Number.isFinite(historical.magi)) return { ...defaults, ...historical, source: 'modeled-return' };
  if (Number.isFinite(historical)) return { ...defaults, magi: historical, source: 'legacy-magi-only' };
  const key = yearIndex === 0 ? 'twoYearsPrior' : yearIndex === 1 ? 'priorYear' : null;
  const entered = key ? optionalFiniteNumber(medicare[`${key}Magi`]) : null;
  if (entered !== null) return { ...defaults, magi: Math.max(0, entered),
    filingStatus: medicare[`${key}FilingStatus`] || filingStatus,
    marriedFilingSeparatelyLivedTogether: medicare[`${key}MfsLivedTogether`] ?? medicare.marriedFilingSeparatelyLivedTogether,
    source: 'entered-return' };
  return { ...defaults, magi: Math.max(0, Number(currentMagi) || 0), source: 'current-income-fallback' };
}

function medicareIrmaaBracket({
  config,
  magi,
  filingStatus,
  marriedFilingSeparatelyLivedTogether
}) {
  const tableKey = medicareIrmaaBracketKey({ filingStatus, marriedFilingSeparatelyLivedTogether });
  return (config.brackets?.[tableKey] ?? config.brackets?.individual ?? []).find((row) => magi <= row.upTo) ?? {
    partBMonthlyAdjustment: 0,
    partDMonthlyAdjustment: 0
  };
}

export function medicareIrmaaBracketKey({ filingStatus, marriedFilingSeparatelyLivedTogether }) {
  return filingStatus === "marriedFilingJointly"
    ? "marriedFilingJointly"
    : filingStatus === "marriedFilingSeparately" && marriedFilingSeparatelyLivedTogether
      ? "marriedFilingSeparatelyTogether"
      : "individual";
}

export function emptyMedicareCost() {
  return {
    enabled: false,
    lookbackMagi: 0,
    partBEnrollees: 0,
    partDEnrollees: 0,
    partBMonthlyPremium: 0,
    partDMonthlyPremium: 0,
    medigapMonthlyPremium: 0,
    partBMonthlyIrmaa: 0,
    partDMonthlyIrmaa: 0,
    partBAnnualPremium: 0,
    partDAnnualPremium: 0,
    medigapAnnualPremium: 0,
    totalAnnualPremium: 0
  };
}

function medicalCostForScenario(scenario, acaConfig, inflationIndex, aca = null) {
  const medicareOop = aca?.medicareMembers > 0 && scenario.medicare?.premiumsEnabled !== false
    ? Math.max(0, Number(scenario.medicare?.annualOopBase) || 0) * inflationIndex : 0;
  const base = (scenario.medicalExpensesBase ?? 0) * inflationIndex + medicareOop;
  // Once the whole household is Medicare-eligible, the ACA plan's OOP maximum
  // is the wrong anchor for expected out-of-pocket spending. Honor the
  // explicit Medicare OOP input when provided (today's dollars, inflated with
  // the medical index, premiums excluded — Part B/D + IRMAA are billed
  // separately). When the input is absent, the legacy behavior below applies
  // (the ACA-era plan OOP proxy when a plan OOP was entered, otherwise $0
  // non-premium OOP) and the confidence layer flags it as input-limited.
  const medicareOopBase = optionalFiniteNumber(scenario.medicare?.annualOopBase);
  if (aca?.medicareEligibleHousehold === true && medicareOopBase !== null) {
    return round(base + (aca?.medicareMembers > 0 ? 0 : Math.max(0, medicareOopBase) * inflationIndex), 6);
  }
  const rawOopOverride = optionalFiniteNumber(scenario.oopMaxOverride);
  const hasScenarioOopOverride = rawOopOverride !== null;
  const scenarioOopOverride = Math.max(0, rawOopOverride ?? 0);
  const usesMarketplaceOop = acaConfig.enabled !== false && aca?.medicareEligibleHousehold !== true;
  if (!usesMarketplaceOop && !hasScenarioOopOverride && !acaConfig.manualOopMaximum) return round(base, 6);
  const activePlanOop = aca?.activePlanRole
    && (aca.activePlanRole === "backup" || acaConfig.manualOopMaximum)
    && Number.isFinite(Number(aca.oopMaximum))
    ? Math.max(0, Number(aca.oopMaximum))
    : null;
  const oopMax = activePlanOop ?? (acaConfig.oopMaximumInflated
    ? acaConfig.manualOopMaximum
      ? Math.max(0, acaConfig.oopMaximum ?? 0)
      : hasScenarioOopOverride
        ? scenarioOopOverride * inflationIndex
        : Math.max(0, acaConfig.oopMaximum ?? 0)
    : hasScenarioOopOverride
      ? scenarioOopOverride * inflationIndex
      : Math.max(0, acaConfig.oopMaximum ?? 0) * inflationIndex);
  const expectedOop = oopMax * Math.max(0, Math.min(1, scenario.expectedOopMaxUsePercent ?? 0));
  return round(base + expectedOop, 6);
}
