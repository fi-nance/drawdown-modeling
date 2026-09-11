import { normalizeIncomeStream } from "./simulation/incomeStreams.mjs";

export const MIN_USER_PLANNING_ANNUAL_SPEND = 1000;

const USER_PLANNING_SPENDING_MODES = new Set([
  "fixed",
  "discretionaryGuardrails",
  "guytonKlinger",
  "kitces",
  "vpw",
  "riskBasedGuardrails"
]);

export function normalizeUserPlanningSpendingMode(value) {
  return USER_PLANNING_SPENDING_MODES.has(value) ? value : "fixed";
}

export function validateUserPlanningScenario(scenario = {}, options = {}) {
  const minAnnualSpend = Math.max(1, Number(options.minAnnualSpend) || MIN_USER_PLANNING_ANNUAL_SPEND);
  const errors = [];
  for (const [ageField, startField, statusField] of [
    ['currentAge', 'socialSecurityStartAge', 'socialSecurityClaimStatus'],
    ['spouseAge', 'spouseSocialSecurityStartAge', 'spouseSocialSecurityClaimStatus']
  ]) {
    if (scenario[statusField] === 'unclaimed' && Number(scenario[startField]) < Number(scenario[ageField])) errors.push({ field: startField, controlId: startField, message: 'For an unclaimed benefit, choose a start age at or after the current age. Past elections cannot be recreated.' });
    if (scenario[statusField] === 'claimed' && Number(scenario[startField]) > Number(scenario[ageField])) errors.push({ field: startField, controlId: startField, message: 'For an existing Social Security award, enter the actual past or current claim age.' });
  }
  for (const field of ['traditionalIraBasis', 'spouseTraditionalIraBasis']) {
    if (Number(scenario[field]) > 0) errors.push({ field, controlId: field, message: 'Nondeductible traditional IRA basis needs Form 8606 pro-rata modeling, which is not supported. Do not use this plan for withdrawal/conversion recommendations.' });
  }
  for (const owner of ['primary', 'spouse']) {
    const budget = scenario.survivorBudgets?.[owner];
    if (budget?.enabled && !(Number(budget.requiredSpend) + Number(budget.flexibleSpend) >= minAnnualSpend)) errors.push({field:'survivorBudgets',controlId:`${owner}SurvivorRequired`,message:`Enter at least $${minAnnualSpend.toLocaleString('en-US')}/year for the enabled survivor budget.`});
  }
  const spendingMode = normalizeUserPlanningSpendingMode(scenario.spendingStrategy?.mode);
  for (const field of ["socialSecuritySurvivorStartAge", "spouseSocialSecuritySurvivorStartAge"]) {
    const value = scenario[field];
    if (value != null && String(value).trim() !== "" && !(finiteNumber(value) >= 60 && finiteNumber(value) <= 120)) {
      errors.push({ field, controlId: field, message: "Aged survivor Social Security start age must be between 60 and 120, or blank for the first eligible year." });
    }
  }
  for (const [index, stream] of (Array.isArray(scenario.incomeStreams) ? scenario.incomeStreams : []).entries()) {
    try { normalizeIncomeStream(stream, index); }
    catch (error) { errors.push({ field: "incomeStreams", controlId: "incomeStreamList", message: error.message }); }
  }

  if (spendingMode === "discretionaryGuardrails") {
    const essentialSpend = finiteNumber(scenario.spendingStrategy?.essentialSpend);
    const discretionarySpend = finiteNumber(scenario.spendingStrategy?.discretionarySpend);
    const targetSpend = finiteNumber(scenario.targetSpend);
    // In guardrails mode the engine spends essential + discretionary, so the
    // floor check must be derived from those components — never from a
    // separately-stored `targetSpend`. An import (or hand-built scenario) can
    // carry a `targetSpend` that disagrees with the components; trusting it
    // would both falsely block a funded plan (stale targetSpend = 0) and
    // falsely pass an unfunded one (stale targetSpend = 90000). Fall back to
    // `targetSpend` only when neither component is present, i.e. a legacy
    // scenario that stored just the combined figure.
    const hasComponentSpend = Number.isFinite(essentialSpend) || Number.isFinite(discretionarySpend);
    const combinedSpend = hasComponentSpend
      ? Math.max(0, essentialSpend || 0) + Math.max(0, discretionarySpend || 0)
      : (Number.isFinite(targetSpend) ? targetSpend : 0);

    if (essentialSpend < 0 || discretionarySpend < 0) {
      errors.push({
        field: "spendingStrategy",
        controlId: essentialSpend < 0 ? "essentialSpend" : "discretionarySpend",
        message: "Essential and discretionary spending must be zero or higher."
      });
    } else if (!(combinedSpend >= minAnnualSpend)) {
      errors.push({
        field: "spendingStrategy",
        controlId: "essentialSpend",
        message: `Enter at least ${formatWholeDollars(minAnnualSpend)}/yr of combined essential and discretionary spending before running a household plan. Test-scale spending belongs in engine tests, not a workspace planning run.`
      });
    }
  } else {
    const targetSpend = finiteNumber(scenario.targetSpend);
    if (!(targetSpend >= minAnnualSpend)) {
      errors.push({
        field: "targetSpend",
        controlId: "targetSpend",
        message: `Enter a target spend of at least ${formatWholeDollars(minAnnualSpend)}/yr before running a household plan. Zero or test-scale spending belongs in engine tests, not a workspace planning run.`
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function formatWholeDollars(value) {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
