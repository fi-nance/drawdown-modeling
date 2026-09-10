// SSA: https://www.ssa.gov/OACT/ProgData/ar_drc.html
// https://www.ssa.gov/OACT/quickcalc/spouse.html
// https://secure.ssa.gov/apps10/poms.nsf/lnx/0300615301 (survivor reduction)
// https://secure.ssa.gov/apps10/poms.nsf/lnx/0300615320 (RIB limit)
// https://secure.ssa.gov/apps10/poms.nsf/lnx/0300615706 (credits at death)
import assert from "node:assert/strict";
import test from "node:test";
import { socialSecurityFullRetirementAge as fra, socialSecurityClaimFactor as factor,
  spouseSocialSecurityBenefitsForYear, survivorSocialSecurityBenefitsForYear as survivor }
  from "../src/core/simulation/socialSecurity.mjs";
import { mortalityStatus } from "../src/core/simulation/household.mjs";
import { scenarioWithSocialSecurityBridge } from "../src/core/decisionEngine.mjs";

const close = (a, b) => assert.ok(Math.abs(a - b) < .00001, `${a} != ${b}`);
const base = { startYear: 2026, currentAge: 65, spouseAge: 59, primaryMortalityAge: 65,
  socialSecurityAnnualBenefit: 37200, socialSecurityStartAge: 70,
  socialSecurityInflationAdjusted: false, spouseSocialSecurityAnnualBenefit: 0 };
const benefit = (scenario, yearIndex = 1) => survivor({ ...base, ...scenario },
  { survivorOwner: "spouse", yearIndex });

test("F11: retirement and survivor FRA use their different birth cohorts", () => {
  for (const [year, age] of [[1937,65],[1938,65+2/12],[1942,65+10/12],[1943,66],
    [1954,66],[1955,66+2/12],[1959,66+10/12],[1960,67]]) close(fra(year), age);
  for (const [year, age] of [[1939,65],[1940,65+2/12],[1944,65+10/12],[1945,66],
    [1956,66],[1957,66+2/12],[1961,66+10/12],[1962,67]]) close(fra(year,"survivor"), age);
});

test("F11: worker and spouse have distinct early reductions and delayed credits", () => {
  close(factor(62,1960), .70);
  close(factor(62,1960,"spousal"), .65);
  close(factor(64,1960), .80);
  close(factor(64,1960,"spousal"), .75);
  close(factor(70,1960), 1.24);
  close(factor(70,1954), 1.32);
  close(factor(70,1960,"spousal"), 1);
  close(factor(66+9/12,1959), 1-5/900);
  // 1940 FRA is 65y6m: 4.5 years at 7% per year.
  close(factor(70,1940), 1.315);
});

test("F11: spouse at 62 receives 32.5% of worker PIA when FRA is 67", () => {
  close(spouseSocialSecurityBenefitsForYear({ startYear: 2027, currentAge: 67, spouseAge: 62,
    socialSecurityAnnualBenefit: 36000, socialSecurityStartAge: 67,
    spouseSocialSecurityStartAge: 62, estimateSocialSecurityFromEarnings: true },
  62, 1, undefined, { primaryAge: 67 }), 11700);
});

test("F11: claiming optimizer uses the same cohort as the simulation", () => {
  const s = scenarioWithSocialSecurityBridge({ startYear: 2020, currentAge: 66,
    socialSecurityStartAge: 66, socialSecurityAnnualBenefit: 30000 }, 70);
  close(s.socialSecurityAnnualBenefit, 39600);
});

test("F5: survivor reduction at 60 persists instead of disappearing at FRA", () => {
  for (const year of [1, 2, 8]) {
    const result = benefit({}, year);
    close(result.survivorBenefit, 21450);
    close(result.claimAge, 60);
  }
});

test("F5: explicit survivor claim timing, no payment before 60, own benefit switches later", () => {
  close(benefit({ spouseAge: 50 }).total, 0);
  close(benefit({ spouseSocialSecuritySurvivorStartAge: 67 }, 1).total, 0);
  close(benefit({ spouseSocialSecuritySurvivorStartAge: 67 }, 8).total, 30000);
  close(benefit({ spouseSocialSecurityAnnualBenefit: 35000, spouseSocialSecurityStartAge: 70 }, 11).total, 35000);
});

test("F5: survivor reduction rounds up to a dime and early-worker limit applies afterward", () => {
  // $1,000/month PIA, FRA 67, claim at 61: reduction = ceil(1000 * .285 * 72/84 * 10)/10.
  close(benefit({ socialSecurityAnnualBenefit: 14880, spouseAge: 60 }).total, 9068.4);
  // Worker claimed at 62: .70 * $30,000. FRA survivor is limited to .825 * PIA.
  close(benefit({ socialSecurityAnnualBenefit: 21000, socialSecurityStartAge: 62, spouseAge: 70 }).total, 24750);
});

test("F5: unclaimed delayed credits stop at death, not the planned future claim date", () => {
  // Born 1960, dies 68 before filing at 70: PIA $30k plus one year of credits.
  close(benefit({ startYear: 2028, currentAge: 68, primaryMortalityAge: 68, spouseAge: 70 }).total, 32400);
});

test("F5: either household member can be the deceased worker", () => {
  const result = survivor({ startYear: 2026, currentAge: 67, spouseAge: 65, spouseMortalityAge: 65,
    socialSecurityAnnualBenefit: 0, spouseSocialSecurityAnnualBenefit: 37200,
    spouseSocialSecurityStartAge: 70, spouseSocialSecurityInflationAdjusted: false },
  { survivorOwner: "primary", yearIndex: 1 });
  close(result.total, 30000);
});

test("null or blank spouse age does not invent a second life", () => {
  for (const spouseAge of [null, undefined, "", " "]) {
    assert.equal(mortalityStatus({ currentAge: 70, spouseAge }, 2).spouseAge, null);
  }
});
