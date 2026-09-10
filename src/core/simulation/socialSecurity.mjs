// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: socialSecurity. No behavior changes — pure code movement.

import { DEFAULT_TAX_PROFILE } from "../tax.mjs?v=20260613-rescue-precision";
import { round } from "../utils.mjs";
import { optionalFiniteNumber } from "./guards.mjs";

// Annual age inputs imply a birth-year cohort, not an exact date of birth.
export function socialSecurityBirthYear(scenario, owner = "primary") {
  const age = optionalFiniteNumber(owner === "spouse" ? scenario.spouseAge : scenario.currentAge);
  return age === null ? 1960 : Math.trunc((scenario.startYear ?? 2026) - age);
}

export function socialSecurityFullRetirementAge(birthYear = 1960, type = "retirement") {
  const year = Math.trunc(birthYear);
  const firstTransition = type === "survivor" ? 1940 : 1938;
  const secondTransition = type === "survivor" ? 1957 : 1955;
  if (year < firstTransition) return 65;
  if (year < firstTransition + 5) return 65 + (year - firstTransition + 1) / 6;
  if (year < secondTransition) return 66;
  return Math.min(67, 66 + (year - secondTransition + 1) / 6);
}

function annualDelayedCredit(birthYear) {
  if (birthYear <= 1924) return 0.03;
  if (birthYear >= 1943) return 0.08;
  return 0.035 + Math.floor((birthYear - 1925) / 2) * 0.005;
}

export function socialSecurityClaimFactor(startAge, birthYear = 1960, type = "retirement") {
  const age = Math.max(62, Math.min(70, Number(startAge) || 67));
  const fra = socialSecurityFullRetirementAge(birthYear);
  const diffMonths = Math.round((age - fra) * 12);
  if (diffMonths < 0) {
    const first36 = Math.max(-36, diffMonths);
    const first36Reduction = first36 * (type === "spousal" ? 25 / 3600 : 5 / 900);
    const extra = Math.min(0, diffMonths + 36);
    const extraReduction = extra * (5 / 1200);
    return 1 + first36Reduction + extraReduction;
  } else {
    const delayedCredit = type === "spousal" ? 0 : diffMonths * annualDelayedCredit(birthYear) / 12;
    return 1 + delayedCredit;
  }
}

function enteredBenefitToPia(annualBenefit, startAge, birthYear) {
  const benefit = Math.max(0, Number(annualBenefit) || 0);
  if (benefit <= 0) return 0;
  const factor = socialSecurityClaimFactor(startAge, birthYear);
  return factor > 0 ? benefit / factor : benefit;
}

function primaryPiaForScenario(scenario, taxProfile = DEFAULT_TAX_PROFILE) {
  const enteredBenefit = Math.max(0, Number(scenario.socialSecurityAnnualBenefit) || 0);
  if (enteredBenefit > 0) {
    return enteredBenefitToPia(enteredBenefit, scenario.socialSecurityStartAge ?? 67, socialSecurityBirthYear(scenario));
  }
  if (scenario.estimateSocialSecurityFromEarnings !== true) return 0;
  return estimatePiaFromEarnings(
    scenario.medicareWages,
    scenario.socialSecurityWages,
    scenario.selfEmploymentIncome,
    taxProfile
  );
}

function spousalEntitlementAge(spouseStartAge, spouseAge, primaryAge, primaryStartAge) {
  if (!Number.isFinite(primaryAge) || primaryAge < primaryStartAge) return spouseStartAge;
  const spouseAgeWhenPrimaryFiled = spouseAge - (primaryAge - primaryStartAge);
  return Math.max(spouseStartAge, spouseAgeWhenPrimaryFiled);
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
  const benefitAtStart = pia * socialSecurityClaimFactor(startAge, socialSecurityBirthYear(scenario));
  return round(benefitAtStart * (scenario.socialSecurityInflationAdjusted === false ? 1 : inflationIndex), 6);
}

export function spouseSocialSecurityBenefitsForYear(scenario, spouseAge, inflationIndex, taxProfile = DEFAULT_TAX_PROFILE, options = {}) {
  if (spouseAge === null) return 0;
  const startAge = scenario.spouseSocialSecurityStartAge ?? 67;
  if (spouseAge < startAge) return 0;
  const primaryAge = optionalFiniteNumber(options.primaryAge);
  const hasPrimaryFilingContext = primaryAge !== null;
  const primaryStartAge = scenario.socialSecurityStartAge ?? 67;
  const primaryHasFiled = hasPrimaryFilingContext && primaryAge >= primaryStartAge;

  let benefitAtStart = 0;
  let ownPia = 0;
  let receivesPureSpousalBenefit = false;
  const enteredBenefit = Math.max(0, Number(scenario.spouseSocialSecurityAnnualBenefit) || 0);
  if (enteredBenefit > 0) {
    // Used as-is at the chosen start age (optimizer pre-scales its candidates).
    benefitAtStart = enteredBenefit;
    ownPia = enteredBenefitToPia(enteredBenefit, startAge, socialSecurityBirthYear(scenario, "spouse"));
  } else {
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
      ownPia = basePia;
    } else {
      // No spouse earnings → 50% spousal benefit off the primary's PIA (FRA benefit).
      if (hasPrimaryFilingContext && !primaryHasFiled) return 0;
      basePia = primaryPiaForScenario(scenario, taxProfile) * 0.5;
      isSpousalBenefit = true;
      receivesPureSpousalBenefit = true;
    }

    // A spouse's own retirement clock is independent of the worker's filing.
    const entitlementAge = spousalEntitlementAge(startAge, spouseAge, primaryAge, primaryStartAge);
    const factor = socialSecurityClaimFactor(isSpousalBenefit ? entitlementAge : startAge,
      socialSecurityBirthYear(scenario, "spouse"), isSpousalBenefit ? "spousal" : "retirement");
    benefitAtStart = basePia * factor;
  }

  if (primaryHasFiled && !receivesPureSpousalBenefit) {
    const primaryPia = primaryPiaForScenario(scenario, taxProfile);
    const spouseCap = primaryPia * 0.5;
    const excessSpousalPia = Math.max(0, spouseCap - ownPia);
    if (excessSpousalPia > 0) {
      const entitlementAge = spousalEntitlementAge(startAge, spouseAge, primaryAge, primaryStartAge);
      const spousalFactor = socialSecurityClaimFactor(entitlementAge, socialSecurityBirthYear(scenario, "spouse"), "spousal");
      benefitAtStart += excessSpousalPia * spousalFactor;
    }
  }

  return round(benefitAtStart * (scenario.spouseSocialSecurityInflationAdjusted === false ? 1 : inflationIndex), 6);
}

function ownRecordScenario(scenario, owner) {
  if (owner === "primary") return scenario;
  return { ...scenario, currentAge: scenario.spouseAge,
    socialSecurityAnnualBenefit: scenario.spouseSocialSecurityAnnualBenefit,
    socialSecurityStartAge: scenario.spouseSocialSecurityStartAge,
    socialSecurityInflationAdjusted: scenario.spouseSocialSecurityInflationAdjusted,
    medicareWages: scenario.spouseMedicareWages,
    socialSecurityWages: scenario.spouseSocialSecurityWages,
    selfEmploymentIncome: scenario.spouseSelfEmploymentIncome };
}

// Aged widow(er) benefits only. Disability, child-in-care, remarriage and other
// eligibility exceptions require a verified SSA calculation outside this model.
export function survivorSocialSecurityBenefitsForYear(scenario, {
  survivorOwner, yearIndex, inflationIndex = 1, taxProfile = DEFAULT_TAX_PROFILE
}) {
  const deceasedOwner = survivorOwner === "primary" ? "spouse" : "primary";
  const own = ownRecordScenario(scenario, survivorOwner);
  const deceased = ownRecordScenario(scenario, deceasedOwner);
  const age = Number(own.currentAge) + yearIndex;
  const deathAge = deceasedOwner === "primary" ? scenario.primaryMortalityAge ?? 95 : scenario.spouseMortalityAge ?? 95;
  const firstSurvivorYear = Math.max(0, Math.floor(deathAge - Number(deceased.currentAge)) + 1);
  const configuredClaimAge = optionalFiniteNumber(survivorOwner === "primary"
    ? scenario.socialSecuritySurvivorStartAge : scenario.spouseSocialSecuritySurvivorStartAge);
  const claimAge = Math.max(60, Number(own.currentAge) + firstSurvivorYear, configuredClaimAge ?? 60);
  const ownBenefit = socialSecurityBenefitsForYear(own, age, inflationIndex, taxProfile);
  const pia = primaryPiaForScenario(deceased, taxProfile);
  const birthYear = socialSecurityBirthYear(deceased);
  const workerClaimAge = deceased.socialSecurityStartAge ?? 67;
  const workerClaimed = workerClaimAge <= deathAge;
  const workerFactor = socialSecurityClaimFactor(workerClaimed ? workerClaimAge : Math.max(
    socialSecurityFullRetirementAge(birthYear), deathAge), birthYear);
  const unreducedAnnual = pia * Math.max(1, workerFactor);
  const fra = socialSecurityFullRetirementAge(socialSecurityBirthYear(own), "survivor");
  const reductionMonths = Math.max(0, Math.round((fra - claimAge) * 12));
  const reductionRate = 0.285 * reductionMonths / Math.round((fra - 60) * 12);
  // POMS RS 00615.301 rounds the monthly reduction UP to the next dime.
  const monthlyReduction = Math.ceil((unreducedAnnual / 12 * reductionRate - 1e-9) * 10) / 10;
  const retirementLimit = workerClaimed && workerFactor < 1 ? pia * Math.max(0.825, workerFactor) : Infinity;
  const survivorBenefit = age < claimAge ? 0 : round(Math.min(retirementLimit,
    Math.max(0, unreducedAnnual - monthlyReduction * 12)) *
    (deceased.socialSecurityInflationAdjusted === false ? 1 : inflationIndex), 6);
  return { total: Math.max(ownBenefit, survivorBenefit), ownBenefit, survivorBenefit,
    claimAge, fullRetirementAge: fra, deceasedPia: round(pia, 6), workerClaimed,
    workerFactor, reductionRate: round(reductionRate, 6) };
}

export function socialSecurityClaimState(scenario, owner = 'primary') {
  const spouse = owner === 'spouse';
  const currentAge = Number((spouse ? scenario.spouseAge : scenario.currentAge) ?? 0);
  const startAge = Number((spouse ? scenario.spouseSocialSecurityStartAge : scenario.socialSecurityStartAge) ?? 67);
  const status = spouse ? scenario.spouseSocialSecurityClaimStatus : scenario.socialSecurityClaimStatus;
  // Legacy inputs with a past start age describe history. At the current age,
  // an explicit receiving status locks the award; an estimate remains feasible.
  const claimed = status === 'claimed' || (status !== 'unclaimed' && startAge < currentAge);
  return { currentAge, startAge, claimed };
}

export function feasibleSocialSecurityClaimAges(scenario, owner = 'primary') {
  const { currentAge, startAge, claimed } = socialSecurityClaimState(scenario, owner);
  if (claimed) return [startAge];
  const earliest = Math.max(62, Math.ceil(currentAge * 12 - 1e-8) / 12);
  // Delaying past 70 adds no credits, but a still-unclaimed older person can
  // begin now. The model does not create a retroactive payment or past election.
  if (earliest >= 70) return [earliest];
  return [...new Set([earliest, 62, 65, 67, 70, startAge])]
    .filter(age => age >= earliest && age <= 70).sort((a, b) => a - b);
}

export function scenarioWithSocialSecurityClaimAge(scenario, owner, targetAge) {
  const { currentAge, startAge, claimed } = socialSecurityClaimState(scenario, owner);
  if (claimed || targetAge === startAge || targetAge < Math.max(62, currentAge) || targetAge > Math.max(70, Math.ceil(currentAge * 12 - 1e-8) / 12)) return { ...scenario };
  const spouse = owner === 'spouse';
  const benefitKey = spouse ? 'spouseSocialSecurityAnnualBenefit' : 'socialSecurityAnnualBenefit';
  const ageKey = spouse ? 'spouseSocialSecurityStartAge' : 'socialSecurityStartAge';
  const benefit = Math.max(0, Number(scenario[benefitKey]) || 0);
  const birthYear = socialSecurityBirthYear(scenario, owner);
  return { ...scenario, [ageKey]: targetAge,
    ...(benefit > 0 ? { [benefitKey]: round(benefit / socialSecurityClaimFactor(startAge, birthYear) * socialSecurityClaimFactor(targetAge, birthYear), 2) } : {}) };
}
