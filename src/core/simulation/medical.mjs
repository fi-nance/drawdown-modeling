// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: medical. No behavior changes — pure code movement.

import { computeAca } from "../aca.mjs";
import { getMedicareIrmaaConfig } from "../../data/taxData.mjs";
import { round } from "../utils.mjs";
import { clampIntegerLike, optionalFiniteNumber } from "./guards.mjs";

export function computeAcaForYear({ age, spouseAge, magi, config, filingStatus }) {
  const married = filingStatus === "marriedFilingJointly" && Number.isFinite(spouseAge);
  const both65Plus = married ? (age >= 65 && spouseAge >= 65) : (age >= 65);

  if (both65Plus) return computeAca({ magi, config: { ...config, enabled: false } });
  return computeAca({ magi, config });
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
  return {
    total: round(baseMedical + (aca?.netPremium ?? 0) + medicare.totalAnnualPremium, 6),
    medicare
  };
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
  const partBAnnualPremium = round(partBMonthlyPremium * 12 * partBEnrollees, 6);
  const partDAnnualPremium = round(partDMonthlyPremium * 12 * partDEnrollees, 6);

  return {
    enabled: true,
    lookbackMagi: round(lookbackMagi, 6),
    partBEnrollees,
    partDEnrollees,
    partBMonthlyPremium: round(partBMonthlyPremium, 6),
    partDMonthlyPremium: round(partDMonthlyPremium, 6),
    partBMonthlyIrmaa: round(bracket.partBMonthlyAdjustment ?? 0, 6),
    partDMonthlyIrmaa: round(bracket.partDMonthlyAdjustment ?? 0, 6),
    partBAnnualPremium,
    partDAnnualPremium,
    totalAnnualPremium: round(partBAnnualPremium + partDAnnualPremium, 6)
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
    partBMonthlyIrmaa: 0,
    partDMonthlyIrmaa: 0,
    partBAnnualPremium: 0,
    partDAnnualPremium: 0,
    totalAnnualPremium: 0
  };
}

function medicalCostForScenario(scenario, acaConfig, inflationIndex, aca = null) {
  const base = (scenario.medicalExpensesBase ?? 0) * inflationIndex;
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
