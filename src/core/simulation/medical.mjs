// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: medical. No behavior changes — pure code movement.

import { computeAca } from "../aca.mjs";
import { getMedicareIrmaaConfig } from "../../data/taxData.mjs";
import { round } from "../utils.mjs";
import { clampIntegerLike, optionalFiniteNumber } from "./guards.mjs";
import { mortalityStatus } from "./household.mjs";

export function computeAcaForYear({ age, spouseAge, magi, config, filingStatus }) {
  const married = filingStatus === "marriedFilingJointly" && Number.isFinite(spouseAge);
  const both65Plus = married ? (age >= 65 && spouseAge >= 65) : (age >= 65);

  if (both65Plus) {
    // Whole household is Medicare-eligible: marketplace coverage ends. The
    // marker lets medical-cost logic switch from the ACA-plan OOP proxy to the
    // household's Medicare OOP input (scenario.medicare.annualOopBase).
    return { ...computeAca({ magi, config: { ...config, enabled: false } }), medicareEligibleHousehold: true };
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
  return computeAca({
    magi,
    config,
    ...(fallbackHouseholdAges ? { householdAges: fallbackHouseholdAges } : {})
  });
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
  const autoEnrollees = filingStatus === "marriedFilingJointly"
    ? (age >= 65 ? 1 : 0) + (Number.isFinite(spouseAge) && spouseAge >= 65 ? 1 : 0)
    : (age >= 65 ? 1 : 0);

  if (medicare.irmaaEnabled === false || autoEnrollees === 0) return emptyMedicareCost();

  const medIndex = medicalInflationIndex !== null && medicalInflationIndex !== undefined ? medicalInflationIndex : inflationIndex;
  const config = getMedicareIrmaaConfig({ taxYear: scenario.taxYear, inflationIndex, medicalInflationIndex: medIndex });
  const lookbackMagi = medicareLookbackMagi({
    scenario,
    yearIndex,
    currentMagi: irmaaMagi,
    magiHistory
  });
  const bracket = medicareIrmaaBracket({
    config,
    magi: lookbackMagi,
    filingStatus,
    marriedFilingSeparatelyLivedTogether: medicare.marriedFilingSeparatelyLivedTogether
  });
  const partBEnrollees = clampIntegerLike(medicare.partBEnrollees, 0, 2, autoEnrollees);
  const partDEnrollees = clampIntegerLike(medicare.partDEnrollees, 0, 2, partBEnrollees);
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

function medicareLookbackMagi({ scenario, yearIndex, currentMagi, magiHistory }) {
  const medicare = scenario.medicare ?? {};
  if (yearIndex >= 2 && Number.isFinite(magiHistory?.[yearIndex - 2])) return magiHistory[yearIndex - 2];
  const priorYearMagi = optionalFiniteNumber(medicare.priorYearMagi);
  const twoYearsPriorMagi = optionalFiniteNumber(medicare.twoYearsPriorMagi);
  if (yearIndex === 1 && priorYearMagi !== null) return priorYearMagi;
  if (yearIndex === 0 && twoYearsPriorMagi !== null) return twoYearsPriorMagi;
  return Math.max(0, Number(currentMagi) || 0);
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
  const base = (scenario.medicalExpensesBase ?? 0) * inflationIndex;
  // Once the whole household is Medicare-eligible, the ACA plan's OOP maximum
  // is the wrong anchor for expected out-of-pocket spending. Honor the
  // explicit Medicare OOP input when provided (today's dollars, inflated with
  // the medical index, premiums excluded — Part B/D + IRMAA are billed
  // separately). When the input is absent, the legacy behavior below applies
  // (the ACA-era plan OOP proxy when a plan OOP was entered, otherwise $0
  // non-premium OOP) and the confidence layer flags it as input-limited.
  const medicareOopBase = optionalFiniteNumber(scenario.medicare?.annualOopBase);
  if (aca?.medicareEligibleHousehold === true && medicareOopBase !== null) {
    return round(base + Math.max(0, medicareOopBase) * inflationIndex, 6);
  }
  const hasScenarioOopOverride = Number.isFinite(Number(scenario.oopMaxOverride));
  const scenarioOopOverride = Math.max(0, Number(scenario.oopMaxOverride));
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
