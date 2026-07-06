import { STATE_TAX_2026 } from "./stateTax2026.generated.mjs";
import {
  STATE_RETIREMENT_TAX_RULES_VERSION,
  stateRetirementRulesFor
} from "./stateRetirementTax2026.mjs";

export const TAX_DATA_VERSION = "2026.11";
export const DEFAULT_TAX_YEAR = 2026;

export const FILING_STATUSES = {
  single: "Single",
  marriedFilingJointly: "Married filing jointly",
  marriedFilingSeparately: "Married filing separately",
  headOfHousehold: "Head of household"
};

const FEDERAL_BRACKET_RATES = [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];

// Law basis: the One Big Beautiful Bill Act (OBBBA, July 2025) made the TCJA
// individual rate structure and standard deduction PERMANENT — the scheduled
// end-2025 TCJA sunset did NOT occur. These 2026 brackets/deductions are the
// post-OBBBA inflation-adjusted values from IRS Rev. Proc. 2025-32. Because the
// individual provisions are now permanent, the simulator's "project the base
// law year forward, inflation-indexed" approach (see inflateTaxProfile) is the
// correct treatment for the bracket/deduction structure — there is no future
// law-change boundary to switch at. Do NOT "fix" these to pre-OBBBA / reverted
// values; they are current law. Time-boxed OBBBA add-ons are modeled with their
// own effective-year windows instead of being inflation-projected permanently.
export const FEDERAL_TAX_2026 = {
  year: 2026,
  source: "IRS Rev. Proc. 2025-32",
  lawBasis: "Post-OBBBA (2025) permanent TCJA individual structure; IRS Rev. Proc. 2025-32 inflation adjustments.",
  capitalLossOrdinaryIncomeOffset: 3000,
  niit: {
    rate: 0.038,
    thresholds: {
      single: 200000,
      marriedFilingJointly: 250000,
      marriedFilingSeparately: 125000,
      headOfHousehold: 200000
    },
    source: "IRS Net Investment Income Tax thresholds are statutory and not indexed for inflation."
  },
  additionalMedicareTax: {
    rate: 0.009,
    thresholds: {
      single: 200000,
      marriedFilingJointly: 250000,
      marriedFilingSeparately: 125000,
      headOfHousehold: 200000
    },
    source: "IRS Topic 560; thresholds are statutory and not indexed for inflation."
  },
  selfEmploymentTax: {
    minimumNetEarnings: 400,
    netEarningsMultiplier: 0.9235,
    socialSecurityRate: 0.124,
    medicareRate: 0.029,
    socialSecurityWageBase: 184500,
    source: "IRS Topic 554; 2026 Form 1040-ES; SSA 2026 contribution and benefit base."
  },
  employeePayrollTax: {
    socialSecurityRate: 0.062,
    medicareRate: 0.0145,
    socialSecurityWageBase: 184500,
    source: "IRS Topic 751; IRS Publication 15 (2026); SSA 2026 contribution and benefit base."
  },
  childTaxCredit: {
    perChild: 2200,
    refundablePerChild: 1700,
    refundableEarnedIncomeThreshold: 2500,
    refundableEarnedIncomeRate: 0.15,
    phaseoutThresholds: {
      single: 200000,
      marriedFilingJointly: 400000,
      marriedFilingSeparately: 200000,
      headOfHousehold: 200000
    },
    phaseoutPerThousand: 50,
    source: "26 USC 24; IRS Rev. Proc. 2025-32; IRS Schedule 8812 instructions."
  },
  additionalStandardDeduction65: {
    married: 1650,
    unmarried: 2050
  },
  itemizedDeductions: {
    medicalExpenseAgiFloor: 0.075,
    salt: {
      temporaryCapStartYear: 2025,
      temporaryCapEndYear: 2029,
      cap2025: 40000,
      mfsCap2025: 20000,
      phaseoutThreshold2025: 500000,
      mfsPhaseoutThreshold2025: 250000,
      annualIncreaseRate: 0.01,
      phaseoutRate: 0.30,
      floor: 10000,
      mfsFloor: 5000,
      post2029Cap: 10000,
      mfsPost2029Cap: 5000,
      source: "IRS 2026 Form 1040-ES SALT correction; IRS Schedule A instructions."
    }
  },
  alternativeMinimumTax: {
    exemption: {
      single: 90100,
      marriedFilingJointly: 140200,
      marriedFilingSeparately: 70100,
      headOfHousehold: 90100
    },
    rateThreshold: {
      single: 244500,
      marriedFilingJointly: 244500,
      marriedFilingSeparately: 122250,
      headOfHousehold: 244500
    },
    phaseoutThreshold: {
      single: 500000,
      marriedFilingJointly: 1000000,
      marriedFilingSeparately: 500000,
      headOfHousehold: 500000
    },
    completePhaseout: {
      single: 680200,
      marriedFilingJointly: 1280400,
      marriedFilingSeparately: 640200,
      headOfHousehold: 680200
    },
    rates: [0.26, 0.28],
    source: "IRS Rev. Proc. 2025-32 section 4.10; IRS Topic 556; IRS 2025 Form 6251 instructions."
  },
  qualifiedBusinessIncomeDeduction: {
    rate: 0.20,
    minimumActiveQbi: 1000,
    minimumDeduction: 400,
    threshold: {
      single: 201750,
      marriedFilingJointly: 403500,
      marriedFilingSeparately: 201775,
      headOfHousehold: 201750
    },
    phaseInEnd: {
      single: 276750,
      marriedFilingJointly: 553500,
      marriedFilingSeparately: 276775,
      headOfHousehold: 276750
    },
    wageLimitPercent: 0.50,
    wagePropertyWagePercent: 0.25,
    propertyLimitPercent: 0.025,
    source: "26 USC 199A as amended by Pub. L. 119-21; IRS Rev. Proc. 2025-32 section 4.26; IRS Form 8995 instructions."
  },
  enhancedSeniorDeduction: {
    effectiveStartYear: 2025,
    effectiveEndYear: 2028,
    amountPerEligiblePerson: 6000,
    phaseoutRate: 0.06,
    phaseoutThresholds: {
      single: 75000,
      marriedFilingJointly: 150000,
      marriedFilingSeparately: null,
      headOfHousehold: 75000
    },
    source: "IRS Schedule 1-A (Form 1040) 2025 Part V; IRS OBBBA deduction for seniors guidance."
  },
  socialSecurityTaxation: {
    baseAmounts: {
      single: 25000,
      marriedFilingJointly: 32000,
      marriedFilingSeparately: 25000,
      headOfHousehold: 25000
    },
    adjustedBaseAmounts: {
      single: 34000,
      marriedFilingJointly: 44000,
      marriedFilingSeparately: 34000,
      headOfHousehold: 34000
    },
    taxableShareLow: 0.5,
    taxableShareHigh: 0.85
  },
  socialSecurityPiaFormula: {
    eligibilityYear: 2026,
    bendPoints: [1286, 7749],
    rates: [0.9, 0.32, 0.15],
    socialSecurityWageBase: 184500,
    rounding: "monthly PIA rounded down to the next lower $0.10",
    source: "SSA 2026 Primary Insurance Amount formula bend points: https://www.ssa.gov/oact/cola/piaformula.html"
  },
  standardDeduction: {
    single: 16100,
    marriedFilingJointly: 32200,
    marriedFilingSeparately: 16100,
    headOfHousehold: 24150
  },
  ordinaryBrackets: {
    single: brackets([12400, 50400, 105700, 201775, 256225, 640600]),
    marriedFilingJointly: brackets([24800, 100800, 211400, 403550, 512450, 768700]),
    marriedFilingSeparately: brackets([12400, 50400, 105700, 201775, 256225, 384350]),
    headOfHousehold: brackets([17700, 67450, 105700, 201750, 256200, 640600])
  },
  capitalGainsBrackets: {
    single: capitalGainsBrackets(49450, 545500),
    marriedFilingJointly: capitalGainsBrackets(98900, 613700),
    marriedFilingSeparately: capitalGainsBrackets(49450, 306850),
    headOfHousehold: capitalGainsBrackets(66200, 579600)
  }
};

export const FEDERAL_TAX_BY_YEAR = {
  2026: FEDERAL_TAX_2026
};

export const FPL_2025 = {
  year: 2025,
  source: "HHS 2025 poverty guidelines, 90 FR 5917",
  contiguous: { base: 15650, increment: 5500 },
  Alaska: { base: 19550, increment: 6880 },
  Hawaii: { base: 17990, increment: 6330 }
};

export const FPL_2026 = {
  year: 2026,
  source: "HHS 2026 poverty guidelines, 91 FR 1797",
  contiguous: { base: 15960, increment: 5680 },
  Alaska: { base: 19950, increment: 7100 },
  Hawaii: { base: 18360, increment: 6530 }
};

export const FEDERAL_POVERTY_GUIDELINES_BY_YEAR = {
  2025: FPL_2025,
  2026: FPL_2026
};

// Law basis: the ARPA/IRA "enhanced" premium tax credits EXPIRED at the end of
// 2025 and were not extended for 2026. So this 2026 schedule is the REVERTED
// (pre-enhancement) regime: the 400% FPL subsidy cliff returns
// (maxEligibleFplPercent: 400) and the applicable-percentage table runs from
// 2.1% up to 9.96% (IRS Rev. Proc. 2025-25), instead of the enhanced 0%-floor /
// 8.5%-cap / no-cliff schedule. This is deliberate and current law — do NOT
// "restore" the enhanced 8.5% cap unless Congress re-extends it. If an
// extension passes, model it as a separate selectable regime rather than
// editing these values in place.
export const ACA_2026 = {
  year: 2026,
  source: "IRS Rev. Proc. 2025-25",
  lawBasis: "Post-2025 expiration of ARPA/IRA enhanced PTC; reverted schedule with 400% FPL cliff per IRS Rev. Proc. 2025-25.",
  enhancedSubsidiesActive: false,
  maxEligibleFplPercent: 400,
  requiredContributionPercentage: 0.0996,
  costSharingLimit: {
    selfOnly: 10600,
    family: 21200
  },
  applicablePercentageTable: [
    { minFplPercent: 0, maxFplPercent: 133, initialRate: 0.021, finalRate: 0.021 },
    { minFplPercent: 133, maxFplPercent: 150, initialRate: 0.0314, finalRate: 0.0419 },
    { minFplPercent: 150, maxFplPercent: 200, initialRate: 0.0419, finalRate: 0.066 },
    { minFplPercent: 200, maxFplPercent: 250, initialRate: 0.066, finalRate: 0.0844 },
    { minFplPercent: 250, maxFplPercent: 300, initialRate: 0.0844, finalRate: 0.0996 },
    { minFplPercent: 300, maxFplPercent: 400, initialRate: 0.0996, finalRate: 0.0996 }
  ]
};

export const ACA_DEFAULT_BENCHMARK_REFERENCE_AGE = 40;

export const ACA_BY_YEAR = {
  2026: ACA_2026
};

export const ACA_BENCHMARK_PREMIUMS_2026_MONTHLY = {
  Alabama: 645,
  Alaska: 1032,
  Arizona: 532,
  Arkansas: 774,
  California: 570,
  Colorado: 557,
  Connecticut: 870,
  Delaware: 691,
  "District of Columbia": 610,
  Florida: 683,
  Georgia: 615,
  Hawaii: 541,
  Idaho: 490,
  Illinois: 646,
  Indiana: 474,
  Iowa: 501,
  Kansas: 670,
  Kentucky: 590,
  Louisiana: 646,
  Maine: 709,
  Maryland: 414,
  Massachusetts: 494,
  Michigan: 523,
  Minnesota: 448,
  Mississippi: 662,
  Missouri: 605,
  Montana: 692,
  Nebraska: 710,
  Nevada: 497,
  "New Hampshire": 401,
  "New Jersey": 545,
  "New Mexico": 623,
  "New York": 817,
  "North Carolina": 638,
  "North Dakota": 570,
  Ohio: 513,
  Oklahoma: 604,
  Oregon: 543,
  Pennsylvania: 572,
  "Rhode Island": 506,
  "South Carolina": 564,
  "South Dakota": 655,
  Tennessee: 711,
  Texas: 661,
  Utah: 640,
  Vermont: 1299,
  Virginia: 455,
  Washington: 612,
  "West Virginia": 1073,
  Wisconsin: 611,
  Wyoming: 1090
};

export const STATE_TAX_BY_YEAR = {
  2026: STATE_TAX_2026
};

export const STATE_OPTIONS = Object.keys(STATE_TAX_2026).sort((a, b) => a.localeCompare(b));

export const MEDICARE_IRMAA_2026 = {
  year: 2026,
  source: "CMS 2026 Medicare Parts A & B Premiums and Deductibles fact sheet",
  partBStandardMonthlyPremium: 202.90,
  brackets: {
    individual: [
      { upTo: 109000, partBMonthlyAdjustment: 0, partDMonthlyAdjustment: 0 },
      { upTo: 137000, partBMonthlyAdjustment: 81.20, partDMonthlyAdjustment: 14.50 },
      { upTo: 171000, partBMonthlyAdjustment: 202.90, partDMonthlyAdjustment: 37.50 },
      { upTo: 205000, partBMonthlyAdjustment: 324.60, partDMonthlyAdjustment: 60.40 },
      { upTo: 500000, partBMonthlyAdjustment: 446.30, partDMonthlyAdjustment: 83.30 },
      { upTo: Infinity, partBMonthlyAdjustment: 487.00, partDMonthlyAdjustment: 91.00 }
    ],
    marriedFilingJointly: [
      { upTo: 218000, partBMonthlyAdjustment: 0, partDMonthlyAdjustment: 0 },
      { upTo: 274000, partBMonthlyAdjustment: 81.20, partDMonthlyAdjustment: 14.50 },
      { upTo: 342000, partBMonthlyAdjustment: 202.90, partDMonthlyAdjustment: 37.50 },
      { upTo: 410000, partBMonthlyAdjustment: 324.60, partDMonthlyAdjustment: 60.40 },
      { upTo: 750000, partBMonthlyAdjustment: 446.30, partDMonthlyAdjustment: 83.30 },
      { upTo: Infinity, partBMonthlyAdjustment: 487.00, partDMonthlyAdjustment: 91.00 }
    ],
    marriedFilingSeparatelyTogether: [
      { upTo: 109000, partBMonthlyAdjustment: 0, partDMonthlyAdjustment: 0 },
      { upTo: 391000, partBMonthlyAdjustment: 446.30, partDMonthlyAdjustment: 83.30 },
      { upTo: Infinity, partBMonthlyAdjustment: 487.00, partDMonthlyAdjustment: 91.00 }
    ]
  }
};

export const MEDICARE_IRMAA_BY_YEAR = {
  2026: MEDICARE_IRMAA_2026
};

export function buildFederalTaxProfile({
  taxYear = DEFAULT_TAX_YEAR,
  filingStatus = "marriedFilingJointly",
  qualifyingChildren = 0,
  childAges = [],
  additionalDeduction = 0,
  additionalCredits = 0,
  itemizedDeductionMode = "auto",
  itemizedStateLocalTaxes = 0,
  itemizedMortgageInterest = 0,
  itemizedCharitableContributions = 0,
  itemizedMedicalExpenses = 0,
  amtPreferenceItems = 0,
  qbiSourceMode = "none",
  qbiAmount = 0,
  qbiSpecifiedServiceBusiness = false,
  qbiW2Wages = 0,
  qbiUbiaQualifiedProperty = 0
} = {}) {
  const data = FEDERAL_TAX_BY_YEAR[taxYear] ?? FEDERAL_TAX_2026;
  const status = FILING_STATUSES[filingStatus] ? filingStatus : "marriedFilingJointly";
  const normalizedChildAges = normalizeChildAges(childAges);
  return {
    year: data.year,
    filingStatus: status,
    standardDeduction: data.standardDeduction[status],
    capitalLossOrdinaryIncomeOffset: status === "marriedFilingSeparately"
      ? data.capitalLossOrdinaryIncomeOffset / 2
      : data.capitalLossOrdinaryIncomeOffset,
    ordinaryBrackets: data.ordinaryBrackets[status],
    capitalGainsBrackets: data.capitalGainsBrackets[status],
    niit: data.niit,
    additionalMedicareTax: data.additionalMedicareTax,
    selfEmploymentTax: data.selfEmploymentTax,
    employeePayrollTax: data.employeePayrollTax,
    childTaxCredit: data.childTaxCredit,
    additionalStandardDeduction65: data.additionalStandardDeduction65,
    alternativeMinimumTax: data.alternativeMinimumTax,
    amtPreferenceItems: Math.max(0, Number(amtPreferenceItems) || 0),
    qualifiedBusinessIncomeDeduction: data.qualifiedBusinessIncomeDeduction,
    qualifiedBusinessIncome: {
      sourceMode: normalizeQbiSourceMode(qbiSourceMode),
      amount: Math.max(0, Number(qbiAmount) || 0),
      specifiedServiceBusiness: qbiSpecifiedServiceBusiness === true,
      w2Wages: Math.max(0, Number(qbiW2Wages) || 0),
      ubiaQualifiedProperty: Math.max(0, Number(qbiUbiaQualifiedProperty) || 0)
    },
    enhancedSeniorDeduction: data.enhancedSeniorDeduction,
    socialSecurityTaxation: data.socialSecurityTaxation,
    socialSecurityPiaFormula: data.socialSecurityPiaFormula,
    qualifyingChildren: normalizedChildAges.length
      ? normalizedChildAges.filter((age) => age < 17).length
      : Math.max(0, Math.trunc(Number(qualifyingChildren) || 0)),
    childAges: normalizedChildAges,
    additionalDeduction: Math.max(0, Number(additionalDeduction) || 0),
    additionalCredits: Math.max(0, Number(additionalCredits) || 0),
    itemizedDeductions: {
      mode: normalizeItemizedDeductionMode(itemizedDeductionMode),
      stateLocalTaxes: Math.max(0, Number(itemizedStateLocalTaxes) || 0),
      mortgageInterest: Math.max(0, Number(itemizedMortgageInterest) || 0),
      charitableContributions: Math.max(0, Number(itemizedCharitableContributions) || 0),
      medicalExpenses: Math.max(0, Number(itemizedMedicalExpenses) || 0),
      limits: data.itemizedDeductions
    },
    source: data.source
  };
}

function normalizeItemizedDeductionMode(value) {
  return ["auto", "standard", "itemized"].includes(value) ? value : "auto";
}

function normalizeQbiSourceMode(value) {
  return ["none", "manual", "selfEmployment"].includes(value) ? value : "none";
}

export function buildStateTaxProfile({
  taxYear = DEFAULT_TAX_YEAR,
  state = "Florida",
  filingStatus = "marriedFilingJointly",
  dependentCount = 0,
  overrideRate = null,
  overrideCapitalGainsRate = null,
  separateCapitalGains = false,
  stateRetirementExclusion = 0,
  stateSocialSecurityTaxablePercent = null
} = {}) {
  const stateData = STATE_TAX_BY_YEAR[taxYear]?.[state] ?? STATE_TAX_2026.Florida;
  const stateStatus = filingStatus === "marriedFilingJointly" ? "mfj" : "single";
  const manualRetirementIncomeExclusion = Math.max(0, Number(stateRetirementExclusion) || 0);
  const manualSocialSecurityTaxableRate = stateSocialSecurityTaxablePercent == null
    ? null
    : normalizeRate(Number(stateSocialSecurityTaxablePercent) / 100);
  const retirementRules = stateRetirementRulesFor(state);

  if (Number.isFinite(overrideRate)) {
    return {
      year: taxYear,
      state,
      filingStatus,
      source: "Manual override",
      standardDeduction: 0,
      personalExemption: 0,
      brackets: [{ upTo: Infinity, rate: Math.max(0, overrideRate) }],
      treatCapitalGainsAsOrdinary: !separateCapitalGains,
      capitalGainsRate: Number.isFinite(overrideCapitalGainsRate)
        ? Math.max(0, overrideCapitalGainsRate)
        : Math.max(0, overrideRate),
      capitalGainsTreatment: separateCapitalGains ? "separate" : "ordinary",
      capitalLossConformity: "federal-agi-approximation",
      retirementRules,
      retirementRulesVersion: STATE_RETIREMENT_TAX_RULES_VERSION,
      retirementRulesSource: retirementRules.source,
      retirementIncomeExclusion: manualRetirementIncomeExclusion,
      socialSecurityTaxableRate: manualSocialSecurityTaxableRate
    };
  }

  const exemptions = stateData.personalExemption ?? {};
  const personalExemption = (exemptions[stateStatus] ?? 0)
    + Math.max(0, dependentCount) * (exemptions.dependent ?? 0);

  return {
    year: taxYear,
    state,
    filingStatus,
    source: "Tax Foundation 2026 state income tax compilation",
    standardDeduction: stateData.standardDeduction?.[stateStatus] ?? 0,
    personalExemption,
    brackets: thresholdPairsToBrackets(stateData[stateStatus] ?? [[0, 0]]),
    treatCapitalGainsAsOrdinary: stateData.capitalGainsTreatment === "ordinary",
    capitalGainsTreatment: stateData.capitalGainsTreatment ?? "ordinary",
    capitalLossConformity: "federal-agi-approximation",
    retirementRules,
    retirementRulesVersion: STATE_RETIREMENT_TAX_RULES_VERSION,
    retirementRulesSource: retirementRules.source,
    retirementIncomeExclusion: manualRetirementIncomeExclusion,
    socialSecurityTaxableRate: manualSocialSecurityTaxableRate
  };
}

export function buildTaxProfile(options = {}) {
  return {
    ...buildFederalTaxProfile(options),
    state: buildStateTaxProfile(options),
    // Preserve the inputs so callers (e.g. survivor-year rebuild in
    // simulation.mjs) can produce a derived profile with only filingStatus
    // changed without losing user overrides like overrideRate or
    // stateRetirementExclusion that don't appear on the returned shape.
    buildOptions: { ...options }
  };
}

export function getFplGuideline({
  taxYear = DEFAULT_TAX_YEAR,
  state = "Florida",
  householdSize = 2
} = {}) {
  const data = FEDERAL_POVERTY_GUIDELINES_BY_YEAR[taxYear] ?? FPL_2026;
  const region = state === "Alaska" ? data.Alaska : state === "Hawaii" ? data.Hawaii : data.contiguous;
  const size = Math.max(1, Math.trunc(Number(householdSize) || 1));
  return region.base + Math.max(0, size - 1) * region.increment;
}

// Per Treas. Reg. §1.36B-1(h), PTC uses the FPL "in effect on the first day of
// the regular enrollment period for coverage." For coverage year Y, that means
// the HHS guidelines published in year Y-1.
function ptcFplYear(taxYear) {
  const priorYear = taxYear - 1;
  return FEDERAL_POVERTY_GUIDELINES_BY_YEAR[priorYear] ? priorYear : taxYear;
}

export function getAcaFplGuideline({
  taxYear = DEFAULT_TAX_YEAR,
  state = "Florida",
  householdSize = 2
} = {}) {
  return getFplGuideline({ taxYear: ptcFplYear(taxYear), state, householdSize });
}

export function getMonthlyBenchmarkPremium({
  taxYear = DEFAULT_TAX_YEAR,
  state = "Florida"
} = {}) {
  if (taxYear !== 2026) return ACA_BENCHMARK_PREMIUMS_2026_MONTHLY[state] ?? 625;
  return ACA_BENCHMARK_PREMIUMS_2026_MONTHLY[state] ?? 625;
}

export function getMedicareIrmaaConfig({
  taxYear = DEFAULT_TAX_YEAR,
  inflationIndex = 1,
  medicalInflationIndex = null
} = {}) {
  const config = MEDICARE_IRMAA_BY_YEAR[taxYear] ?? MEDICARE_IRMAA_2026;
  const index = Math.max(0, Number(inflationIndex) || 0);
  const medIndex = medicalInflationIndex !== null && medicalInflationIndex !== undefined ? Math.max(0, Number(medicalInflationIndex) || 0) : index;
  return {
    ...config,
    partBStandardMonthlyPremium: roundMoney((config.partBStandardMonthlyPremium ?? 0) * medIndex),
    brackets: Object.fromEntries(Object.entries(config.brackets ?? {}).map(([key, rows]) => [
      key,
      rows.map((row) => ({
        upTo: Number.isFinite(row.upTo) ? roundMoney(row.upTo * index) : Infinity,
        partBMonthlyAdjustment: roundMoney((row.partBMonthlyAdjustment ?? 0) * medIndex),
        partDMonthlyAdjustment: roundMoney((row.partDMonthlyAdjustment ?? 0) * medIndex)
      }))
    ]))
  };
}

export function buildAcaConfig({
  enabled = true,
  taxYear = DEFAULT_TAX_YEAR,
  state = "Florida",
  householdSize = 2,
  marketplaceMembers = householdSize,
  currentAge = null,
  memberAges = null,
  zip = null,
  planCostMode = "stateBenchmark",
  premiumInputMode = "gross",
  ageRateManualPremiums = true,
  benchmarkPremiumOverride = null,
  benchmarkPremiumReferenceAge = null,
  benchmarkPremiumReferenceAges = null,
  selectedPlanPremiumOverride = null,
  selectedPlanPremiumReferenceAge = null,
  selectedPlanPremiumReferenceAges = null,
  selectedPlanOopMaximumOverride = null,
  backupPlanPremiumOverride = null,
  backupPlanBenchmarkPremiumOverride = null,
  backupPlanOopMaximumOverride = null,
  backupPlanPremiumInputMode = "gross",
  backupPlanName = "",
  backupTriggerFplPercent = null,
  fplOverride = null
} = {}) {
  const aca = ACA_BY_YEAR[taxYear] ?? ACA_2026;
  const members = Math.max(1, Math.trunc(Number(marketplaceMembers) || Number(householdSize) || 1));
  const normalizedPlanCostMode = planCostMode === "selectedPlan" ? "selectedPlan" : "stateBenchmark";
  const normalizedPremiumInputMode = premiumInputMode === "net" ? "net" : "gross";
  const normalizedBackupPremiumInputMode = backupPlanPremiumInputMode === "net" ? "net" : "gross";
  const shouldAgeRateManualPremiums = ageRateManualPremiums !== false;
  const hasBenchmarkOverride = Number.isFinite(benchmarkPremiumOverride);
  const hasOopOverride = Number.isFinite(selectedPlanOopMaximumOverride);
  const hasBackupPremiumOverride = Number.isFinite(backupPlanPremiumOverride);
  const hasBackupBenchmarkOverride = Number.isFinite(backupPlanBenchmarkPremiumOverride);
  const hasBackupOopOverride = Number.isFinite(backupPlanOopMaximumOverride);
  const annualBenchmark = Number.isFinite(benchmarkPremiumOverride)
    ? Math.max(0, benchmarkPremiumOverride)
    : normalizedPremiumInputMode === "net"
      ? 0
    : getMonthlyBenchmarkPremium({ taxYear, state }) * 12 * members;
  const hasSelectedPlanOverride = Number.isFinite(selectedPlanPremiumOverride);
  const annualSelectedPlanPremium = normalizedPlanCostMode === "selectedPlan" && hasSelectedPlanOverride
    ? Math.max(0, selectedPlanPremiumOverride)
    : annualBenchmark;
  const referenceAge = Number.isFinite(benchmarkPremiumReferenceAge)
    ? Math.max(0, benchmarkPremiumReferenceAge)
    : hasBenchmarkOverride && Number.isFinite(currentAge)
      ? Math.max(0, currentAge)
      : ACA_DEFAULT_BENCHMARK_REFERENCE_AGE;
  const referenceAges = normalizeAgeArray(benchmarkPremiumReferenceAges)
    ?? (hasBenchmarkOverride ? normalizeAgeArray(memberAges) : null);
  const selectedPlanReferenceAge = Number.isFinite(selectedPlanPremiumReferenceAge)
    ? Math.max(0, selectedPlanPremiumReferenceAge)
    : hasSelectedPlanOverride && Number.isFinite(currentAge)
      ? Math.max(0, currentAge)
      : referenceAge;
  const selectedPlanReferenceAges = normalizeAgeArray(selectedPlanPremiumReferenceAges)
    ?? (hasSelectedPlanOverride ? normalizeAgeArray(memberAges) : referenceAges);
  const coveredMemberAges = normalizeAgeArray(memberAges);
  const oopMaximum = hasOopOverride
    ? Math.max(0, selectedPlanOopMaximumOverride)
    : members > 1 ? aca.costSharingLimit.family : aca.costSharingLimit.selfOnly;
  const manualSelectedPlanPremium = hasSelectedPlanOverride || hasBenchmarkOverride;
  const backupBenchmarkPremium = hasBackupBenchmarkOverride
    ? Math.max(0, backupPlanBenchmarkPremiumOverride)
    : normalizedBackupPremiumInputMode === "net"
      ? 0
      : annualBenchmark;
  const backupPlan = hasBackupPremiumOverride && hasBackupOopOverride
    ? {
      enabled: true,
      triggerFplPercent: Number.isFinite(backupTriggerFplPercent)
        ? Math.max(0, backupTriggerFplPercent)
        : aca.maxEligibleFplPercent,
      premiumInputMode: normalizedBackupPremiumInputMode,
      benchmarkPremium: backupBenchmarkPremium,
      ageRatedBenchmarkPremium: !hasBackupBenchmarkOverride || shouldAgeRateManualPremiums,
      benchmarkPremiumReferenceAge: selectedPlanReferenceAge,
      benchmarkPremiumReferenceAges: selectedPlanReferenceAges,
      selectedPlanPremium: Math.max(0, backupPlanPremiumOverride),
      ageRatedSelectedPlanPremium: shouldAgeRateManualPremiums,
      selectedPlanPremiumReferenceAge: selectedPlanReferenceAge,
      selectedPlanPremiumReferenceAges: selectedPlanReferenceAges,
      oopMaximum: Math.max(0, backupPlanOopMaximumOverride),
      manualOopMaximum: true,
      planName: String(backupPlanName ?? "").trim(),
      currentAge,
      householdSize: Math.max(1, Math.trunc(Number(householdSize) || 1)),
      marketplaceMembers: members,
      memberAges: coveredMemberAges
    }
    : null;

  return {
    enabled,
    year: aca.year,
    source: aca.source,
    planCostMode: normalizedPlanCostMode,
    premiumInputMode: normalizedPremiumInputMode,
    ageRateManualPremiums: shouldAgeRateManualPremiums,
    state,
    zip: normalizeZipInput(zip),
    householdSize: Math.max(1, Math.trunc(Number(householdSize) || 1)),
    marketplaceMembers: members,
    fpl: Number.isFinite(fplOverride)
      ? Math.max(1, fplOverride)
      : getAcaFplGuideline({ taxYear, state, householdSize }),
    manualFpl: Number.isFinite(fplOverride),
    benchmarkPremium: annualBenchmark,
    ageRatedBenchmarkPremium: !hasBenchmarkOverride || shouldAgeRateManualPremiums,
    benchmarkPremiumReferenceAge: referenceAge,
    benchmarkPremiumReferenceAges: referenceAges,
    selectedPlanPremium: annualSelectedPlanPremium,
    ageRatedSelectedPlanPremium: !manualSelectedPlanPremium || shouldAgeRateManualPremiums,
    selectedPlanPremiumReferenceAge: selectedPlanReferenceAge,
    selectedPlanPremiumReferenceAges: selectedPlanReferenceAges,
    memberAges: coveredMemberAges,
    oopMaximum,
    manualOopMaximum: hasOopOverride,
    backupPlan,
    costSharingLimit: aca.costSharingLimit,
    applicablePercentageTable: aca.applicablePercentageTable,
    maxEligibleFplPercent: aca.maxEligibleFplPercent,
    requiredContributionPercentage: aca.requiredContributionPercentage
  };
}

function normalizeZipInput(zip) {
  if (zip == null) return null;
  const text = String(zip).trim();
  if (/^\d{5}$/.test(text)) return text;
  const plus4 = text.match(/^(\d{5})-\d{4}$/);
  if (plus4) return plus4[1];
  return text || null;
}

function brackets(upperBounds) {
  return [...upperBounds, Infinity].map((upTo, index) => ({
    upTo,
    rate: FEDERAL_BRACKET_RATES[index]
  }));
}

function normalizeAgeArray(ages) {
  if (!Array.isArray(ages)) return null;
  return ages.map((age) => {
    const numericAge = Number(age);
    return Number.isFinite(numericAge) ? Math.max(0, numericAge) : null;
  }).filter((age) => age !== null);
}

function normalizeChildAges(ages) {
  if (!Array.isArray(ages)) return [];
  return ages.map((age) => {
    const numericAge = Number(age);
    return Number.isFinite(numericAge) ? Math.max(0, numericAge) : null;
  }).filter((age) => age !== null);
}

function normalizeRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0, Math.min(1, numeric));
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function capitalGainsBrackets(zeroRateUpTo, fifteenRateUpTo) {
  return [
    { upTo: zeroRateUpTo, rate: 0 },
    { upTo: fifteenRateUpTo, rate: 0.15 },
    { upTo: Infinity, rate: 0.2 }
  ];
}

function thresholdPairsToBrackets(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const result = [];
  if ((sorted[0]?.[0] ?? 0) > 0) {
    result.push({ upTo: sorted[0][0], rate: 0 });
  }

  for (let index = 0; index < sorted.length; index += 1) {
    result.push({
      upTo: sorted[index + 1]?.[0] ?? Infinity,
      rate: sorted[index][1]
    });
  }

  return result;
}
