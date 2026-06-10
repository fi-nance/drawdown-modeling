// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: socialSecurity. No behavior changes — pure code movement.

import { DEFAULT_TAX_PROFILE } from "../tax.mjs?v=20260609-deepfix";
import { round } from "../utils.mjs";

function socialSecurityScalingFactor(startAge) {
  const age = Math.max(62, Math.min(70, Number(startAge) || 67));
  const diffMonths = (age - 67) * 12;
  if (diffMonths < 0) {
    const first36 = Math.max(-36, diffMonths);
    const first36Reduction = first36 * (5 / 900);
    const extra = Math.min(0, diffMonths + 36);
    const extraReduction = extra * (5 / 1200);
    return 1 + first36Reduction + extraReduction;
  } else {
    const delayedMonths = Math.min(36, diffMonths);
    const delayedCredit = delayedMonths * (2 / 300);
    return 1 + delayedCredit;
  }
}

// Rough PIA estimate from earnings. NOTE: this is a coarse proxy — it treats
// the entered annual wages as if they were the career-average AIME (no 35-year
// indexing/averaging), so it overstates PIA for a single high year. It is only
// used when the household explicitly opts in (see socialSecurityBenefitsForYear),
// because the model's wage inputs (medicareWages etc.) are bridge/earned-income
// figures, not lifetime career earnings. The PIA formula itself is sourced from
// the active tax profile so the bend points and rounding are versioned.
function estimatePiaFromEarnings(medicareWages, socialSecurityWages, selfEmploymentIncome, profile = DEFAULT_TAX_PROFILE) {
  const wages = Math.max(0, medicareWages ?? 0, socialSecurityWages ?? 0, selfEmploymentIncome ?? 0);
  if (wages <= 0) return 0;
  const formula = profile?.socialSecurityPiaFormula ?? DEFAULT_TAX_PROFILE.socialSecurityPiaFormula ?? {};
  const bendPoints = Array.isArray(formula.bendPoints) && formula.bendPoints.length >= 2
    ? formula.bendPoints
    : [1286, 7749];
  const rates = Array.isArray(formula.rates) && formula.rates.length >= 3
    ? formula.rates
    : [0.9, 0.32, 0.15];
  const wageBase = Math.max(0, Number(formula.socialSecurityWageBase ?? profile?.employeePayrollTax?.socialSecurityWageBase ?? 184500) || 0);
  const cappedWages = wageBase > 0 ? Math.min(wageBase, wages) : wages;
  const aime = cappedWages / 12;
  let monthlyPia = 0;
  const [firstBend, secondBend] = bendPoints.map((value) => Math.max(0, Number(value) || 0));
  const [firstRate, secondRate, thirdRate] = rates.map((value) => Math.max(0, Number(value) || 0));
  if (aime <= firstBend) {
    monthlyPia = aime * firstRate;
  } else if (aime <= secondBend) {
    monthlyPia = firstBend * firstRate + (aime - firstBend) * secondRate;
  } else {
    monthlyPia = firstBend * firstRate + (secondBend - firstBend) * secondRate + (aime - secondBend) * thirdRate;
  }
  const roundedMonthlyPia = Math.floor((monthlyPia + 1e-9) * 10) / 10;
  return round(roundedMonthlyPia * 12, 6);
}

// An entered Social Security benefit is the amount received at the chosen
// start age and is used as-is (SSA statements quote a per-claiming-age figure).
// The claiming-age solver scales entered benefits across ages by baking the
// adjusted amount into its candidate scenarios (scenarioWithSocialSecurityBridge),
// so this function must NOT re-scale them. Earnings-based PIA estimation is
// OPT-IN only — bridge/earned-income inputs are not lifetime career earnings,
// so without an explicit opt-in a household with no entered benefit gets $0
// (no phantom Social Security). PIA is treated as the FRA benefit and IS scaled
// by the claiming age here.
export function socialSecurityBenefitsForYear(scenario, age, inflationIndex, taxProfile = DEFAULT_TAX_PROFILE) {
  const startAge = scenario.socialSecurityStartAge ?? 67;
  if (age < startAge) return 0;

  const enteredBenefit = Math.max(0, Number(scenario.socialSecurityAnnualBenefit) || 0);
  if (enteredBenefit > 0) {
    return round(enteredBenefit * (scenario.socialSecurityInflationAdjusted === false ? 1 : inflationIndex), 6);
  }

  if (scenario.estimateSocialSecurityFromEarnings !== true) return 0;
  const pia = estimatePiaFromEarnings(
    scenario.medicareWages,
    scenario.socialSecurityWages,
    scenario.selfEmploymentIncome,
    taxProfile
  );
  const benefitAtStart = pia * socialSecurityScalingFactor(startAge);
  return round(benefitAtStart * (scenario.socialSecurityInflationAdjusted === false ? 1 : inflationIndex), 6);
}

export function spouseSocialSecurityBenefitsForYear(scenario, spouseAge, inflationIndex, taxProfile = DEFAULT_TAX_PROFILE) {
  if (spouseAge === null) return 0;
  const startAge = scenario.spouseSocialSecurityStartAge ?? 67;
  if (spouseAge < startAge) return 0;

  const enteredBenefit = Math.max(0, Number(scenario.spouseSocialSecurityAnnualBenefit) || 0);
  if (enteredBenefit > 0) {
    // Used as-is at the chosen start age (optimizer pre-scales its candidates).
    return round(enteredBenefit * (scenario.spouseSocialSecurityInflationAdjusted === false ? 1 : inflationIndex), 6);
  }

  // Derive a spousal/own benefit only under the same opt-in as the primary.
  if (scenario.estimateSocialSecurityFromEarnings !== true) return 0;

  const spouseWages = Math.max(0, scenario.spouseMedicareWages ?? 0, scenario.spouseSocialSecurityWages ?? 0, scenario.spouseSelfEmploymentIncome ?? 0);
  let isSpousalBenefit = false;
  let basePia = 0;
  if (spouseWages > 0) {
    basePia = estimatePiaFromEarnings(
      scenario.spouseMedicareWages,
      scenario.spouseSocialSecurityWages,
      scenario.spouseSelfEmploymentIncome,
      taxProfile
    );
  } else {
    // No spouse earnings → 50% spousal benefit off the primary's PIA (FRA benefit).
    const primaryPia = Math.max(0, Number(scenario.socialSecurityAnnualBenefit) || 0) || estimatePiaFromEarnings(
      scenario.medicareWages,
      scenario.socialSecurityWages,
      scenario.selfEmploymentIncome,
      taxProfile
    );
    basePia = primaryPia * 0.5;
    isSpousalBenefit = true;
  }

  // Spousal benefits do NOT earn delayed-retirement credits (they max at the
  // 50%-of-PIA amount at FRA), so cap the scaling factor at 1.0 for the spousal
  // case. Early-claiming reduction is approximated with the retirement curve.
  const rawFactor = socialSecurityScalingFactor(startAge);
  const factor = isSpousalBenefit ? Math.min(1, rawFactor) : rawFactor;
  const benefitAtStart = basePia * factor;
  return round(benefitAtStart * (scenario.spouseSocialSecurityInflationAdjusted === false ? 1 : inflationIndex), 6);
}
