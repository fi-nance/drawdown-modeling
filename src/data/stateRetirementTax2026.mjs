export const STATE_RETIREMENT_TAX_RULES_VERSION = "2026.2";

const DEFAULT_RULE = Object.freeze({
  socialSecurity: { type: "excluded" },
  retirementIncome: { type: "none" },
  source: "Best-effort 2026 state retirement-income rule table; verify against state instructions before filing."
});

export const STATE_RETIREMENT_TAX_RULES_2026 = Object.freeze({
  Alabama: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Alabama generally exempts Social Security and defined-benefit pension income; IRA/401(k)-style distributions remain taxable in this model."
  },
  Alaska: noIncomeTaxRule(),
  Arizona: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Arizona exempts Social Security but has no broad private IRA/401(k) exclusion."
  },
  Arkansas: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "fixed", amount: 6000, minAge: 59.5 },
    source: "Arkansas retirement or disability income exclusion, commonly modeled as up to $6,000."
  },
  California: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "California exempts Social Security but generally taxes retirement distributions."
  },
  Colorado: {
    socialSecurity: { type: "conditionalExcluded", minAge: 65 },
    retirementIncome: {
      type: "ageBand",
      bands: [
        { minAge: 55, maxAge: 64, amount: 20000 },
        { minAge: 65, amount: 24000 }
      ],
      appliesToTaxableSocialSecurity: true
    },
    source: "Colorado pension/annuity subtraction is age based and can shelter taxable Social Security."
  },
  Connecticut: {
    socialSecurity: {
      type: "thresholdRate",
      thresholds: { single: 75000, marriedFilingJointly: 100000, marriedFilingSeparately: 75000, headOfHousehold: 75000 },
      rateAbove: 0.25
    },
    retirementIncome: {
      type: "incomeThresholdFull",
      minAge: 59.5,
      thresholds: { single: 75000, marriedFilingJointly: 100000, marriedFilingSeparately: 75000, headOfHousehold: 75000 }
    },
    source: "Connecticut retirement and Social Security subtractions are income-limited."
  },
  Delaware: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "fixed", amount: 12500, minAge: 60 },
    source: "Delaware pension exclusion for taxpayers age 60 or older."
  },
  Florida: noIncomeTaxRule(),
  Georgia: {
    socialSecurity: { type: "excluded" },
    retirementIncome: {
      type: "ageBand",
      bands: [
        { minAge: 62, maxAge: 64, amount: 35000 },
        { minAge: 65, amount: 65000 }
      ]
    },
    source: "Georgia retirement-income exclusion is age based."
  },
  Hawaii: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Hawaii exempts Social Security and certain employer-funded pensions; IRA/401(k)-style distributions remain taxable in this model."
  },
  Idaho: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Idaho exempts Social Security; pension exclusions are limited to specific public plans."
  },
  Illinois: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "all" },
    source: "Illinois subtracts federally taxed retirement income, including IRA and qualified-plan distributions."
  },
  Indiana: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Indiana exempts Social Security; no broad private retirement distribution exclusion is modeled."
  },
  Iowa: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "all", minAge: 55 },
    source: "Iowa excludes retirement income for taxpayers age 55 or older."
  },
  Kansas: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Kansas exempts federally taxable Social Security without an income cap for tax years after 2023; private retirement income is generally taxable."
  },
  Kentucky: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "fixed", amount: 31110 },
    source: "Kentucky pension-income exclusion."
  },
  Louisiana: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "fixed", amount: 12000, minAge: 65 },
    source: "Louisiana age-65 exclusion uses the $12,000 statutory base; the 2026 indexed increment and plan-specific public benefits require override review."
  },
  Maine: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "mainePension", amount: 49824, minAge: 59.5 },
    source: "Maine 2026 pension maximum $49,824, reduced by Social Security and phased out. Household Social Security offsets each owner cap conservatively until owner benefit records are supplied; phaseout uses the statutory base pending indexed thresholds."
  },
  Maryland: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Maryland pension exclusion is not inferred from generic traditional accounts: IRAs are ineligible, employer-plan eligibility and Social Security offsets require a verified manual exclusion."
  },
  Massachusetts: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Massachusetts exempts Social Security; public pensions may be exempt but private IRA/401(k) distributions are generally taxable."
  },
  Michigan: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "fixed", scope: "joint", minAge: 59.5, amounts: { single: 67610, headOfHousehold: 67610, marriedFilingSeparately: 67610, marriedFilingJointly: 135220 } },
    source: "Michigan 2026 qualified private retirement-income maximum: $67,610 single/$135,220 joint. Public-plan, early-retirement, and alternate standard-deduction exceptions require review."
  },
  Minnesota: {
    socialSecurity: { type: "federal" },
    retirementIncome: { type: "none" },
    source: "Minnesota partially taxes Social Security through state subtraction rules and generally taxes retirement distributions."
  },
  Mississippi: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "all", minAge: 59.5 },
    source: "Mississippi exempts qualified retirement income after retirement-plan eligibility."
  },
  Missouri: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "fixedPhaseout", amount: 6000, phaseoutStart: { single: 25000, marriedFilingJointly: 32000, marriedFilingSeparately: 16000, headOfHousehold: 25000 } },
    source: "Missouri private pension deduction is capped at $6,000 per recipient, reduced dollar-for-dollar above filing-status income limits. Public-plan and disability rules require review."
  },
  Montana: {
    socialSecurity: { type: "federal" },
    retirementIncome: { type: "none" },
    source: "Montana taxes federally taxable Social Security and has no broad private retirement distribution exclusion in this model."
  },
  Nebraska: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Nebraska exempts Social Security; retirement distributions are generally taxable."
  },
  Nevada: noIncomeTaxRule(),
  "New Hampshire": noIncomeTaxRule(),
  "New Jersey": {
    socialSecurity: { type: "excluded" },
    retirementIncome: {
      type: "newJerseyPension", scope: "joint",
      minAge: 62,
      thresholds: { single: 150000, marriedFilingJointly: 150000, marriedFilingSeparately: 150000, headOfHousehold: 150000 },
      amounts: { single: 75000, marriedFilingJointly: 100000, marriedFilingSeparately: 50000, headOfHousehold: 75000 }
    },
    source: "New Jersey retirement-income exclusion for taxpayers age 62 or older with income at or below the gross-income cap."
  },
  "New Mexico": {
    socialSecurity: {
      type: "thresholdRate",
      thresholds: { single: 100000, marriedFilingJointly: 150000, marriedFilingSeparately: 75000, headOfHousehold: 100000 },
      rateAbove: 1
    },
    retirementIncome: { type: "fixedWithIncomeLimit", minAge: 65, amount: 8000, thresholds: { single: 28500, marriedFilingJointly: 51000, marriedFilingSeparately: 25500, headOfHousehold: 28500 } },
    source: "New Mexico Social Security exemption and age-65 deduction are income limited."
  },
  "New York": {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "fixed", amount: 20000, minAge: 59.5 },
    source: "New York excludes Social Security and up to $20,000 of qualifying private pension/annuity income for age 59.5+."
  },
  "North Carolina": {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "North Carolina exempts Social Security; most private retirement income is taxable."
  },
  "North Dakota": {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "North Dakota exempts Social Security; most private retirement income is taxable."
  },
  Ohio: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Ohio exempts Social Security and offers credits rather than a broad retirement-income exclusion."
  },
  Oklahoma: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "fixed", amount: 10000 },
    source: "Oklahoma retirement-income exclusion."
  },
  Oregon: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "Oregon exempts Social Security; other retirement distributions are generally taxable aside from limited credits/public pension rules."
  },
  Pennsylvania: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "all", minAge: 59.5 },
    source: "Pennsylvania exempts eligible retirement-plan distributions after retirement-plan eligibility."
  },
  "Rhode Island": {
    socialSecurity: {
      type: "thresholdRate",
      minAge: 67,
      thresholds: { single: 101000, marriedFilingJointly: 126250, marriedFilingSeparately: 101000, headOfHousehold: 101000 },
      rateAbove: 1
    },
    retirementIncome: {
      type: "fixedWithIncomeLimit",
      minAge: 67,
      amount: 20000,
      thresholds: { single: 101000, marriedFilingJointly: 126250, marriedFilingSeparately: 101000, headOfHousehold: 101000 }
    },
    source: "Rhode Island Social Security and pension/annuity exclusions are age and income limited."
  },
  "South Carolina": {
    socialSecurity: { type: "excluded" },
    retirementIncome: {
      type: "ageBand",
      bands: [
        { minAge: 0, maxAge: 64, amount: 3000 },
        { minAge: 65, amount: 15000 }
      ]
    },
    source: "South Carolina retirement deduction is age based."
  },
  "South Dakota": noIncomeTaxRule(),
  Tennessee: noIncomeTaxRule(),
  Texas: noIncomeTaxRule(),
  Utah: {
    socialSecurity: { type: "federal" },
    retirementIncome: { type: "none" },
    source: "Utah taxes federally taxable Social Security but offers income-limited credits not modeled as deductions."
  },
  Vermont: {
    socialSecurity: {
      type: "thresholdRate",
      thresholds: { single: 50000, marriedFilingJointly: 65000, marriedFilingSeparately: 50000, headOfHousehold: 50000 },
      rateAbove: 1
    },
    retirementIncome: { type: "none" },
    source: "Vermont Social Security exemption is income limited; most private retirement income is taxable."
  },
  Virginia: {
    socialSecurity: { type: "excluded" },
    retirementIncome: {
      type: "fixedPhaseout",
      minAge: 65,
      amount: 12000,
      phaseoutStart: { single: 50000, marriedFilingJointly: 75000, marriedFilingSeparately: 50000, headOfHousehold: 50000 }
    },
    source: "Virginia age deduction is income limited."
  },
  Washington: noIncomeTaxRule(),
  "Washington DC": {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "none" },
    source: "District of Columbia exempts Social Security; private retirement income is generally taxable."
  },
  "West Virginia": {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "fixed", amount: 8000, minAge: 65 },
    source: "West Virginia fully exempts Social Security for 2026; senior retirement-income modification is modeled as $8,000."
  },
  Wisconsin: {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "wisconsinPension" },
    source: "Wisconsin: age 67+ $24,000 per qualifying person ($48,000 if both joint filers qualify), without an income cap; choosing it forfeits state credits. Age 65-66 $5,000 requires FAGI below $15,000/$30,000 married."
  },
  Wyoming: noIncomeTaxRule()
});

export function stateRetirementRulesFor(state) {
  return STATE_RETIREMENT_TAX_RULES_2026[state] ?? DEFAULT_RULE;
}

export function stateSocialSecurityExclusion({
  rule,
  filingStatus,
  age,
  spouseAge,
  taxableSocialSecurity = 0,
  stateIncome = 0,
  manualTaxableRate = null
} = {}) {
  const taxable = Math.max(0, taxableSocialSecurity);
  if (taxable <= 0) return 0;
  if (manualTaxableRate != null) return taxable * (1 - clampRate(manualTaxableRate));

  const config = rule?.socialSecurity ?? DEFAULT_RULE.socialSecurity;
  if (config.type === "excluded") return taxable;
  if (config.type === "federal") return 0;
  if (config.type === "conditionalExcluded") {
    return householdMeetsAge(age, spouseAge, config.minAge) ? taxable : 0;
  }
  if (config.type === "thresholdRate") {
    if (config.minAge != null && !householdMeetsAge(age, spouseAge, config.minAge)) return 0;
    const threshold = thresholdForStatus(config.thresholds, filingStatus);
    return stateIncome <= threshold ? taxable : taxable * (1 - clampRate(config.rateAbove ?? 1));
  }
  return 0;
}

export function stateRetirementIncomeExclusion({
  rule,
  filingStatus,
  age,
  spouseAge,
  retirementIncome = 0,
  retirementIncomeDetails = null,
  remainingTaxableSocialSecurity = 0,
  totalSocialSecurity = 0,
  stateIncome = 0,
  manualExclusion = 0
} = {}) {
  const config = rule?.retirementIncome ?? DEFAULT_RULE.retirementIncome;
  const eligibleIncome = Math.max(0, retirementIncome)
    + (config.appliesToTaxableSocialSecurity ? Math.max(0, remainingTaxableSocialSecurity) : 0);
  if (eligibleIncome <= 0) return 0;

  const details = Array.isArray(retirementIncomeDetails) && retirementIncomeDetails.length
    ? retirementIncomeDetails : [{ owner: 'primary', amount: retirementIncome, type: 'unspecified' }];
  const ownerIncome = { primary: 0, spouse: 0 };
  for (const row of details) ownerIncome[row.owner === 'spouse' ? 'spouse' : 'primary'] += Math.max(0, Number(row.amount) || 0);
  // Preserve age ownership. Only a joint dollar cap may be shared; a younger
  // spouse's distributions never become eligible because the other is older.
  const ownerAge = { primary: age, spouse: spouseAge };
  const qualifiedTotal = Object.entries(ownerIncome).reduce((sum, [owner, amount]) => sum
    + (Number.isFinite(Number(ownerAge[owner])) && ownerAge[owner] != null && (config.minAge == null || Number(ownerAge[owner]) >= config.minAge) ? amount : 0), 0);
  let defaultExclusion = 0;
  if (config.type === 'wisconsinPension') {
    const eligible67 = ['primary', 'spouse'].filter(owner => ownerAge[owner] != null && ownerAge[owner] >= 67);
    if (eligible67.length === 2 && filingStatus === 'marriedFilingJointly') defaultExclusion = Math.min(retirementIncome, 48000);
    else for (const owner of ['primary', 'spouse']) {
      const ownerLimit = ownerAge[owner] >= 67 ? 24000 : ownerAge[owner] >= 65 && stateIncome < (filingStatus.startsWith('married') ? 30000 : 15000) ? 5000 : 0;
      defaultExclusion += Math.min(ownerIncome[owner], ownerLimit);
    }
  } else if (config.type === 'mainePension') {
    const threshold = filingStatus === 'marriedFilingJointly' ? 250000 : filingStatus === 'headOfHousehold' ? 187500 : 125000;
    const phase = 1 - Math.min(1, Math.max(0, stateIncome - threshold) / (filingStatus === 'marriedFilingSeparately' ? 50000 : 100000));
    for (const owner of ['primary', 'spouse']) if (ownerAge[owner] != null && ownerAge[owner] >= config.minAge) {
      defaultExclusion += Math.min(ownerIncome[owner], Math.max(0, config.amount - totalSocialSecurity)) * phase;
    }
  } else if (config.type === 'newJerseyPension') {
    const share = filingStatus === 'marriedFilingJointly' ? 0.5 : filingStatus === 'marriedFilingSeparately' ? 0.25 : 0.375;
    defaultExclusion = stateIncome <= 100000 ? Math.min(qualifiedTotal, amountForStatus(config, filingStatus))
      : stateIncome <= 125000 ? qualifiedTotal * share : stateIncome <= 150000 ? qualifiedTotal * share / 2 : 0;
  } else if (config.scope === 'joint' || config.amounts) {
    defaultExclusion = Math.min(qualifiedTotal, retirementExclusionLimit({ config, filingStatus, age, spouseAge, stateIncome }));
  } else {
    for (const owner of ['primary', 'spouse']) {
      if (ownerAge[owner] == null && (config.minAge != null || config.type === "ageBand")) continue;
      const limit = retirementExclusionLimit({ config, filingStatus, age: ownerAge[owner], spouseAge: null, stateIncome });
      defaultExclusion += Math.min(ownerIncome[owner], limit);
    }
    if (config.appliesToTaxableSocialSecurity) defaultExclusion += Math.min(Math.max(0, remainingTaxableSocialSecurity), Math.max(0,
      retirementExclusionLimit({ config, filingStatus, age, spouseAge, stateIncome }) - defaultExclusion));
  }
  return Math.min(eligibleIncome, Math.max(defaultExclusion, Math.max(0, manualExclusion ?? 0)));

}

function retirementExclusionLimit({ config, filingStatus, age, spouseAge, stateIncome }) {
  if (!config || config.type === "none") return 0;
  if (config.minAge != null && !householdMeetsAge(age, spouseAge, config.minAge)) return 0;
  if (config.type === "all") return Infinity;
  if (config.type === "fixed") return amountForStatus(config, filingStatus);
  if (config.type === "ageBand") return ageBandAmount(config.bands, age, spouseAge);
  if (config.type === "incomeThresholdFull") {
    return stateIncome <= thresholdForStatus(config.thresholds, filingStatus) ? Infinity : 0;
  }
  if (config.type === "fixedWithIncomeLimit") {
    return stateIncome <= thresholdForStatus(config.thresholds, filingStatus)
      ? amountForStatus(config, filingStatus)
      : 0;
  }
  if (config.type === "fixedPhaseout") {
    const start = thresholdForStatus(config.phaseoutStart, filingStatus);
    return Math.max(0, amountForStatus(config, filingStatus) - Math.max(0, stateIncome - start));
  }
  return 0;
}

function ageBandAmount(bands = [], age, spouseAge) {
  const amountForAge = (candidateAge) => {
    const band = bands.find((row) => (
      candidateAge >= (row.minAge ?? 0)
      && candidateAge <= (row.maxAge ?? Infinity)
    ));
    return band?.amount ?? 0;
  };
  return Math.max(amountForAge(Number(age) || 0), Number.isFinite(spouseAge) ? amountForAge(spouseAge) : 0);
}

function householdMeetsAge(age, spouseAge, minAge) {
  return (Number(age) || 0) >= minAge || (Number.isFinite(spouseAge) && spouseAge >= minAge);
}

function amountForStatus(config, filingStatus) {
  return config.amounts?.[filingStatus] ?? config.amount ?? 0;
}

function thresholdForStatus(thresholds = {}, filingStatus) {
  return thresholds[filingStatus] ?? thresholds.single ?? Infinity;
}

function noIncomeTaxRule() {
  return {
    socialSecurity: { type: "excluded" },
    retirementIncome: { type: "all" },
    source: "No broad individual income tax."
  };
}

function clampRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0, Math.min(1, numeric));
}
