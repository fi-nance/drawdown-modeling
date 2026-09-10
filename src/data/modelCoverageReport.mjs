export const MODEL_COVERAGE_REPORT_VERSION = "2026.06.12-loss-carryovers";

export const COVERAGE_STATUSES = [
  "high-confidence",
  "input-limited",
  "assumption-sensitive",
  "cpa-review",
  "out-of-model"
];

export const modelCoverageReport = {
  title: "Model Coverage And Review Report",
  version: MODEL_COVERAGE_REPORT_VERSION,
  lawYear: "2026",
  updated: "2026-06-12",
  purpose: "Track what the drawdown model currently covers, what is approximate or out of model, which sources support each area, and which tests keep it from drifting.",
  summary: [
    { label: "North-star lens", value: "CPA + engineering + design" },
    { label: "Current law basis", value: "2026 federal/state/ACA/Medicare datasets" },
    { label: "State scope", value: "50 states + DC, with explicit caveats" },
    { label: "Primary maintenance rule", value: "New modeled rules need source refs, limits, and tests" }
  ],
  legend: [
    { status: "high-confidence", label: "High confidence", description: "Source-versioned, specific inputs, and representative or golden tests exist." },
    { status: "input-limited", label: "Input-limited", description: "The rule is modeled, but household-specific detail can materially improve precision." },
    { status: "assumption-sensitive", label: "Assumption-sensitive", description: "Outputs can move materially under plausible return, inflation, healthcare, tax, or life-event assumptions." },
    { status: "cpa-review", label: "CPA review", description: "Planning-grade coverage exists, but filing-grade facts or state-form nuance still require professional review." },
    { status: "out-of-model", label: "Out of model", description: "The report names the exclusion so the app does not imply hidden coverage." }
  ],
  sections: [
    {
      id: "federal-tax",
      title: "Federal Income Tax And Credits",
      status: "cpa-review",
      lens: "CPA",
      summary: "Strong 2026 planning engine for ordinary income, LTCG/QDI stacking, credits, payroll taxes, QBI, itemized deductions, AMT tripwires, and senior deduction, with filing-grade gaps clearly flagged.",
      implemented: [
        "2026 federal brackets, standard deduction, age-65 bump, 2025-2028 enhanced senior deduction, LTCG/QDI stacking, NIIT, Additional Medicare Tax, W-2 FICA, self-employment tax, CTC, and common ACTC formula.",
        "Schedule D-style capital-loss netting preserves short-term and long-term character, applies the $3,000 ordinary-loss cap ($1,500 MFS), and uses carryover worksheet logic when deductions leave part of the line 21 loss unused.",
        "Itemized deduction controls for standard/itemized choice, SALT cap/phaseout, mortgage interest, charitable gifts, and medical expense AGI floor.",
        "QBI planning from manual QBI or self-employment income, including W-2 wage, UBIA, SSTB, thresholds, and active-QBI minimum.",
        "AMT exposure tripwire and manual federal deduction/credit overrides with confidence flags."
      ],
      limitations: [
        "Full Form 6251 AMT calculation is not modeled.",
        "Full Form 8995/8995-A business detail, K-1 aggregation, loss carryforwards, REIT/PTP components, and business expense substantiation are not validated.",
        "EITC, education credits, dependent-care credits, complete Schedule 8812 edge cases, household employment tax, and withholding timing remain out of model."
      ],
      sources: [
        { label: "docs/DATA_SOURCES.md - federal tax source inventory", href: "./docs/DATA_SOURCES.md" },
        { label: "src/data/taxData.mjs", href: "./src/data/taxData.mjs" }
      ],
      tests: [
        "tests/golden_ltcg_stacking.test.mjs",
        "tests/golden_senior_deduction.test.mjs",
        "tests/golden_actc.test.mjs",
        "tests/golden_qbi.test.mjs",
        "tests/golden_salt.test.mjs",
        "tests/tax.test.mjs",
        "tests/confidence.test.mjs"
      ],
      nextReview: [
        "Promote AMT from tripwire to computed tentative-minimum-tax engine only when primary-source worked examples and golden tests are ready.",
        "Decide whether EITC/dependent-care/education credits belong in the near-term household-input surface."
      ]
    },
    {
      id: "state-tax",
      title: "State Income Tax",
      status: "cpa-review",
      lens: "CPA",
      summary: "All 50 states and DC have 2026 ordinary/capital-gains defaults plus retirement-income and Social Security overlays, but state-form nuance is still the highest-risk correctness frontier.",
      implemented: [
        "2026 state ordinary tax defaults, capital-gains treatment, no-tax states, and broad retirement-income/Social Security handling.",
        "Capital-loss effects flow through the federal-AGI approximation and surface state capital-loss conformity review details when a state-taxed year uses loss offsets or carryforwards.",
        "Manual state ordinary tax, state capital-gains tax, retirement-income exclusion, and Social Security taxable percentage overrides."
      ],
      limitations: [
        "Public pension, military, railroad, disability, municipal, county, school-district, credit-only, and nonresident/part-year rules are not filing-grade.",
        "State-specific capital-loss additions, subtractions, carryforward worksheets, and nonconformity rules are not modeled.",
        "Cross-state moves are not modeled; one residency state applies for every year."
      ],
      sources: [
        { label: "docs/DATA_SOURCES.md - state income tax defaults", href: "./docs/DATA_SOURCES.md" },
        { label: "src/data/stateTax2026.generated.mjs", href: "./src/data/stateTax2026.generated.mjs" },
        { label: "src/data/stateRetirementTax2026.mjs", href: "./src/data/stateRetirementTax2026.mjs" }
      ],
      tests: [
        "tests/tax.test.mjs",
        "tests/simulation.test.mjs",
        "tests/confidence.test.mjs",
        "tests/resultAuditBundle.test.mjs",
        "tests/dataSourcesCoverage.test.mjs"
      ],
      nextReview: [
        "Create a state-by-state CPA audit matrix for retirement income, Social Security, capital-loss conformity, local taxes, credits, and pension categories.",
        "Add relocation year support before making cross-state optimization recommendations."
      ]
    },
    {
      id: "aca-healthcare",
      title: "ACA Premium Tax Credits And Pre-65 Healthcare",
      status: "input-limited",
      lens: "CPA + design",
      summary: "Strong ACA MAGI, PTC, SLCSP, ZIP/rating-area, and healthcare bridge modeling, with exact-plan inputs raising confidence when household-specific plan data is available.",
      implemented: [
        "2026 FPL, applicable percentages, 400% FPL cliff under current law, selected-plan premium/OOP inputs, quoted net premium mode, backup plan triggers, member age rating, and mixed ACA/Medicare handling.",
        "Offline ZIP to county/rating-area SLCSP for covered FFM and SBM states, including county and ZIP-level partial-county overrides where bundled.",
        "CMS Marketplace API helper for HealthCare.gov states and Massachusetts ConnectorCare planning preset."
      ],
      limitations: [
        "Exact partial-year ACA reconciliation in year of death is not modeled.",
        "Tobacco, CSR variants, employer affordability, immigration, Medicaid/CHIP eligibility, and non-calendar plan-year edge cases need exact marketplace data or additional eligibility engines.",
        "A few state-based exchange paths still use documented fallback estimates when 2026 PUF data is absent."
      ],
      sources: [
        { label: "docs/DATA_SOURCES.md - ACA and SLCSP source inventory", href: "./docs/DATA_SOURCES.md" },
        { label: "src/data/acaRatingArea.mjs", href: "./src/data/acaRatingArea.mjs" },
        { label: "src/data/sbeRatingArea.mjs", href: "./src/data/sbeRatingArea.mjs" },
        { label: "src/data/geo.mjs", href: "./src/data/geo.mjs" }
      ],
      tests: [
        "tests/golden_aca_ptc.test.mjs",
        "tests/aca.test.mjs",
        "tests/acaRatingArea.test.mjs",
        "tests/golden_slcsp_rating_area.test.mjs",
        "tests/acaMedicareTransition.test.mjs",
        "tests/sbeCoverage.test.mjs",
        "tests/geo.test.mjs"
      ],
      nextReview: [
        "Add household-specific exact-plan import support for more state exchanges.",
        "Add explicit Medicaid/CHIP handoff modeling instead of confidence flags only."
      ]
    },
    {
      id: "medicare-irmaa",
      title: "Medicare And IRMAA",
      status: "input-limited",
      lens: "CPA",
      summary: "Models Part B/D premiums, IRMAA tiers, two-year lookback MAGI, medigap/MA supplemental premium, and non-premium OOP override, with missing OOP inputs flagged.",
      implemented: [
        "2026 Medicare Part B and Part D IRMAA brackets and premiums.",
        "Two-year lookback MAGI, max-tier guardrails, mixed ACA/Medicare household premium separation, medigap/Medicare Advantage monthly premium per enrollee, and annual OOP override."
      ],
      limitations: [
        "Plan-specific Part D, Medigap underwriting, Medicare Advantage benefits, and state rating methods are out of model.",
        "When Medicare OOP is absent, the model uses a documented fallback and flags input-limited confidence."
      ],
      sources: [
        { label: "docs/DATA_SOURCES.md - Medicare source inventory", href: "./docs/DATA_SOURCES.md" },
        { label: "src/data/taxData.mjs", href: "./src/data/taxData.mjs" }
      ],
      tests: [
        "tests/acaMedicareTransition.test.mjs",
        "tests/workspaceOptions.test.mjs",
        "tests/confidence.test.mjs",
        "tests/simulation.test.mjs"
      ],
      nextReview: [
        "Add plan-specific Part D premium/OOP controls if Medicare decisions become optimizer inputs.",
        "Separate Medigap and Medicare Advantage assumptions when they affect yearly cash-flow risk."
      ]
    },
    {
      id: "social-security",
      title: "Social Security",
      status: "assumption-sensitive",
      lens: "CPA + engineering",
      summary: "Benefits, survivor treatment, taxation, claiming age scaling, and opt-in 2026 PIA-from-earnings proxy are modeled, but exact SSA history remains a user-input confidence lever.",
      implemented: [
        "Entered benefits by claiming age, cohort-specific worker/spousal reductions, delayed worker credits, aged-survivor eligibility/reduction and Pub 915 taxable-benefit calculation.",
        "Opt-in single-year earnings-to-PIA proxy using 2026 SSA bend points and dime rounding.",
        "Social Security bridge/delay rescue option in the decision engine."
      ],
      limitations: [
        "The PIA estimator is a coarse proxy, not a 35-year indexed earnings record.",
        "Birth cohorts are inferred from annual ages; exact birth-date and monthly filing/death rules are not modeled.",
        "Divorced spouse, child-in-care, remarriage and disability eligibility require verified SSA inputs."
      ],
      sources: [
        { label: "docs/DATA_SOURCES.md - Social Security sources", href: "./docs/DATA_SOURCES.md" },
        { label: "src/core/simulation/socialSecurity.mjs", href: "./src/core/simulation/socialSecurity.mjs" }
      ],
      tests: [
        "tests/golden_ss_taxation.test.mjs",
        "tests/golden_ss_pia.test.mjs",
        "tests/golden_ss_claiming.test.mjs",
        "tests/headlineCapabilities.test.mjs",
        "tests/jointLife.test.mjs",
        "tests/decisionEngine.test.mjs"
      ],
      nextReview: [
        "Add a richer earnings-history input or import path before treating PIA optimization as high-confidence.",
        "Verify survivor claiming dates, marriage eligibility and special-case benefits before acting."
      ]
    },
    {
      id: "retirement-accounts",
      title: "Retirement Accounts, RMDs, Roth, And HSA",
      status: "cpa-review",
      lens: "CPA + engineering",
      summary: "Strong planning-grade modeling for account ownership, RMDs, Roth basis/conversion clocks, HSA expense pools, and early-withdrawal penalty exceptions, with several filing-grade retirement-plan rules intentionally excluded.",
      implemented: [
        "SECURE 2.0 RMD ages and Uniform Lifetime factors with per-owner clocks, survivor rollover pooling, and forced-RMD cash retention.",
        "Roth contribution basis, conversion five-year penalty recapture, global qualified-distribution toggle, and dynamic Roth-basis substitution.",
        "HSA qualified-expense pool by default, age-65 nonqualified ordinary distributions, HSA contribution strategy, and spouse/non-spouse HSA inheritance treatment.",
        "Annual early-withdrawal penalty exception amount and configurable penalty-free age/rate."
      ],
      limitations: [
        "72(t) SEPP, QDRO, disability, terminal illness, first-home, education, public-safety, disaster, reservist, domestic-abuse, and unemployment health-insurance exceptions require user-entered exception amounts.",
        "Separate Roth IRA versus designated Roth 401(k) five-year clocks and complete Form 8606 ordering history are not tracked.",
        "Joint Life and Last Survivor RMD table is not modeled."
      ],
      sources: [
        { label: "docs/DATA_SOURCES.md - RMD/HSA/Roth sources", href: "./docs/DATA_SOURCES.md" },
        { label: "src/core/simulation/rmd.mjs", href: "./src/core/simulation/rmd.mjs" },
        { label: "src/core/simulation/hsa.mjs", href: "./src/core/simulation/hsa.mjs" },
        { label: "src/core/simulation/withdrawalExecution.mjs", href: "./src/core/simulation/withdrawalExecution.mjs" }
      ],
      tests: [
        "tests/hsaQualifiedExpenses.test.mjs",
        "tests/golden_inherited_hsa.test.mjs",
        "tests/workspaceOptions.test.mjs",
        "tests/simulation.test.mjs"
      ],
      nextReview: [
        "Add rule-specific early-withdrawal exception engines only when the app collects the required household facts.",
        "Split Roth account types and clocks if Roth ordering becomes a central recommendation."
      ]
    },
    {
      id: "withdrawal-optimization",
      title: "Withdrawal, Roth Conversion, Asset Location, And Rescue Optimization",
      status: "assumption-sensitive",
      lens: "engineering + design",
      summary: "The app produces tested decision and rescue candidates across spending, MAGI, conversions, withdrawal order, allocation, reserves, TIPS ladders, and Social Security delay, with live comparison rows and apply-to-workspace controls.",
      implemented: [
        "Heuristic and lifetime optimizer withdrawal modes, taxable lot selection, TLH/TGH, Roth conversion sizing, ACA-aware MAGI caps, IRMAA lookback guardrails, asset-location swaps, annual rebalancing, glidepaths, and sequence-risk reserves.",
        "Decision engine rescue candidates for safe spending, discretionary cuts, income bridge, risk guardrails, sequence reserve, TIPS ladder, allocation shift, withdrawal shift, healthcare/MAGI discipline, Roth basis, taxable lot, conversion guardrail, MAGI spend trim, IRMAA, and Social Security bridge.",
        "Rescue comparison rows include discarded/preliminary candidates, changed controls, confirmation dialog, and workspace application path."
      ],
      limitations: [
        "Intermediate solver probes are bounded approximations; finalized displayed options rerun with selected evidence but are still not proofs of global optimality.",
        "Failure anatomy tags broad stressors rather than exact dollar-causal attribution.",
        "Optimizer objective weights are still implicit in the available rescue set rather than a full user-tunable utility function."
      ],
      sources: [
        { label: "src/core/decisionEngine.mjs", href: "./src/core/decisionEngine.mjs" },
        { label: "src/core/simulation/withdrawalPlanning.mjs", href: "./src/core/simulation/withdrawalPlanning.mjs" },
        { label: "src/core/simulation/taxStrategy.mjs", href: "./src/core/simulation/taxStrategy.mjs" },
        { label: "src/core/simulation/tipsLadder.mjs", href: "./src/core/simulation/tipsLadder.mjs" }
      ],
      tests: [
        "tests/decisionEngine.test.mjs",
        "tests/simulation.test.mjs",
        "tests/tipsLadder.test.mjs",
        "tests/riskBasedGuardrails.test.mjs",
        "tests/rescueComparisonText.test.mjs",
        "tests/workspaceOptions.test.mjs"
      ],
      nextReview: [
        "Make the tradeoff objective explicit across spending, resilience, healthcare stability, and bequest.",
        "Add dollar-level failure attribution before presenting optimization causes as causal decomposition."
      ]
    },
    {
      id: "uncertainty",
      title: "Uncertainty, Historical Evidence, And Portfolio Returns",
      status: "assumption-sensitive",
      lens: "engineering",
      summary: "Monte Carlo and historical evidence are deterministic and inspectable, with configurable capital-market assumptions, correlated sampling, mean reversion, inflation persistence, and historical cohorts.",
      implemented: [
        "Seeded Monte Carlo, historical backtests, rolling/specific/chunked historical sequences, extended historical source option, asset-class coverage flags, and retained scenario timeline limits.",
        "Market-neutral CMA preset, correlated sampling, mean-reverting correlated sampling, two-stream general/medical inflation, AR(1) inflation persistence, and asset-class proxy controls."
      ],
      limitations: [
        "CMA assumptions are planning defaults, not forecasts or guarantees.",
        "Historical evidence is limited by available asset-class history and selected proxy rules.",
        "Mean reversion and correlations are simplified approximations, not a calibrated valuation-cycle model."
      ],
      sources: [
        { label: "docs/DATA_SOURCES.md - historical returns and Monte Carlo", href: "./docs/DATA_SOURCES.md" },
        { label: "src/data/historicalReturns.mjs", href: "./src/data/historicalReturns.mjs" },
        { label: "src/core/simulation.mjs", href: "./src/core/simulation.mjs" }
      ],
      tests: [
        "tests/historicalReturns.test.mjs",
        "tests/monteCarloDefaults.test.mjs",
        "tests/monteCarloSamplingMode.test.mjs",
        "tests/rngSeed.test.mjs",
        "tests/modelingRigor.test.mjs",
        "tests/resultsCacheSize.test.mjs"
      ],
      nextReview: [
        "Add regeneration scripts and checksums for historical return raw inputs.",
        "Expose assumption sensitivity more directly in the UI for CMA/inflation/medical inflation choices."
      ]
    },
    {
      id: "legacy",
      title: "Legacy, Heirs, Estate, And Inheritance",
      status: "cpa-review",
      lens: "CPA + design",
      summary: "After-tax bequest modeling covers spouse rollover, non-spouse 10-year inherited-account tax, eligible-designated stretch approximation, federal estate tax, lineal-heir state inheritance tax, and per-account beneficiary overrides.",
      implemented: [
        "Heir tax uses Single-filer brackets and Single standard deduction, indexed to death-year price level, with heir base income and heir age inputs.",
        "Federal estate tax above the 2026 $15M exclusion, spouse unlimited marital deduction, lineal-heir state inheritance tax for PA/NE/NJ/MD scope, taxable basis step-up, and survivor step-up option.",
        "Per-account beneficiary type overrides for traditional/Roth/HSA inherited-account treatment."
      ],
      limitations: [
        "Non-lineal state inheritance classes, multistate situs, trusts, GST, gift tax, charitable remainder trusts, donor-advised funds, NUA and full pension/annuity/insurance election rules are out of model.",
        "Eligible-designated stretch uses a generic life-expectancy approximation.",
        "Heir defaults materially affect outputs; actual heir facts should be entered before relying on bequest optimization."
      ],
      sources: [
        { label: "docs/DATA_SOURCES.md - inherited account and estate sources", href: "./docs/DATA_SOURCES.md" },
        { label: "src/core/simulation/heirEstate.mjs", href: "./src/core/simulation/heirEstate.mjs" },
        { label: "src/core/portfolio.mjs", href: "./src/core/portfolio.mjs" }
      ],
      tests: [
        "tests/headlineCapabilities.test.mjs",
        "tests/heirEstate.test.mjs",
        "tests/golden_heir_tax_indexing.test.mjs",
        "tests/golden_inherited_hsa.test.mjs",
        "tests/workspaceOptions.test.mjs"
      ],
      nextReview: [
        "Add relationship-class inputs before modeling non-lineal state inheritance tax.",
        "Replace generic eligible-designated stretch with an IRS-table-backed implementation if it becomes user-facing advice."
      ]
    },
    {
      id: "auditability-privacy-design",
      title: "Auditability, Privacy, And Design Actionability",
      status: "input-limited",
      lens: "design + engineering",
      summary: "The app exposes source versions, confidence flags, audit bundle export, setup backup, privacy controls, and plain-language rescue/apply flows, but every actionable result still needs deeper assumption drilldowns over time.",
      implemented: [
        "Result audit bundle with setup, compact results, audit rows, data source versions, and privacy/data-custody statement.",
        "Confidence labels and review flags for model areas where missing inputs or CPA review matter.",
        "Local-first setup/results, explicit imports/exports, privacy mode for external lookups, and in-app rescue apply confirmation.",
        "Mobile-aware module workspace and results surfaces with source-backed tests for visible controls."
      ],
      limitations: [
        "Not every number links directly to a source row or override yet.",
        "The report is a coverage view, not a formal CPA sign-off.",
        "Design review must continue as new optimizer outputs make recommendations more complex."
      ],
      sources: [
        { label: "docs/GOAL.md", href: "./docs/GOAL.md" },
        { label: "docs/REVIEW_BAR.md", href: "./docs/REVIEW_BAR.md" },
        { label: "src/core/resultAuditBundle.mjs", href: "./src/core/resultAuditBundle.mjs" },
        { label: "src/core/confidence.mjs", href: "./src/core/confidence.mjs" }
      ],
      tests: [
        "tests/resultAuditBundle.test.mjs",
        "tests/confidence.test.mjs",
        "tests/privacyMode.test.mjs",
        "tests/rescueComparisonText.test.mjs",
        "tests/appModuleInitOrder.test.mjs"
      ],
      nextReview: [
        "Add source/assumption drilldowns from high-impact action rows.",
        "Keep the coverage report updated in the same PR as new modeled domains."
      ]
    }
  ]
};

export function coverageSummary(report = modelCoverageReport) {
  const counts = Object.fromEntries(COVERAGE_STATUSES.map((status) => [status, 0]));
  for (const section of report.sections ?? []) {
    if (counts[section.status] != null) counts[section.status] += 1;
  }
  return {
    totalSections: report.sections?.length ?? 0,
    counts
  };
}
