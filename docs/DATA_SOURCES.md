# Data Sources And Annual Update Runbook

This file documents where the app's versioned tax, ACA, and historical return data comes from, how it is transformed, and what to update when a new calendar year closes.

## Current Data Versions

| Dataset | App location | Current version | Current coverage |
| --- | --- | --- | --- |
| Federal tax, ACA, FPL, ACA premium defaults | `src/data/taxData.mjs` | `TAX_DATA_VERSION = "2026.1"` | 2026 tax-law year |
| State income tax defaults | `src/data/stateTax2026.generated.mjs` | generated 2026 table | 2026 tax-law year |
| Historical return backtesting | `src/data/historicalReturns.mjs` | `HISTORICAL_RETURN_DATA_VERSION = "2026.1"` | modern baseline core asset classes 1928-2025; opt-in reconstructed U.S. source extends stock/bond/cash to 1872 and real estate to 1891 |

## Source Inventory

| Data | Primary source | App fields | Update timing |
| --- | --- | --- | --- |
| Federal ordinary income tax brackets, standard deduction, long-term capital gains thresholds, child tax credit amounts | IRS Rev. Proc. 2025-32 / IRB 2025-45: https://www.irs.gov/irb/2025-45_IRB and direct PDF https://www.irs.gov/pub/irs-drop/rp-25-32.pdf | `FEDERAL_TAX_2026`, `FEDERAL_TAX_BY_YEAR` | Usually released in Q4 before the tax year |
| Child Tax Credit qualifying age | IRS Child Tax Credit page: https://www.irs.gov/credits-deductions/individuals/child-tax-credit | `taxProfile.childAges`, yearly `qualifyingChildren` | Verify annually with child-credit guidance |
| Additional standard deduction for age 65+ | IRS IRB 2025-45 / Rev. Proc. 2025-32: https://www.irs.gov/irb/2025-45_IRB | `FEDERAL_TAX_2026.additionalStandardDeduction65` | Usually released in Q4 before the tax year |
| Social Security benefit taxation | IRS Publication 915: https://www.irs.gov/publications/p915 | `FEDERAL_TAX_2026.socialSecurityTaxation` | Thresholds are statutory and not indexed under current law |
| Required minimum distributions and Uniform Lifetime Table | IRS RMD topic page: https://www.irs.gov/rmd, IRS RMD FAQs: https://www.irs.gov/retirement-plans/retirement-plan-and-ira-required-minimum-distributions-faqs, IRS Publication 590-B: https://www.irs.gov/publications/p590b, CRS summary on SECURE 2.0 RMD ages: https://www.congress.gov/crs-product/IF12750 | `UNIFORM_LIFETIME_RMD_FACTORS`, `scenario.rmd` | Verify if IRS updates SECURE 2.0 implementation or life expectancy tables |
| Medicare Part B premiums and Part B/D IRMAA brackets | CMS 2026 Medicare Parts A & B premiums fact sheet: https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles | `MEDICARE_IRMAA_2026`, `MEDICARE_IRMAA_BY_YEAR` | Usually released in Q4 before the calendar year |
| Net investment income tax | IRS NIIT topic page: https://www.irs.gov/individuals/net-investment-income-tax and IRS Topic 559: https://www.irs.gov/taxtopics/tc559 | `FEDERAL_TAX_2026.niit` | Statutory thresholds are not indexed; verify if Congress changes them |
| Additional Medicare Tax | IRS Topic 560: https://www.irs.gov/taxtopics/tc560 and Instructions for Form 8959: https://www.irs.gov/instructions/i8959 | `FEDERAL_TAX_2026.additionalMedicareTax`, `scenario.medicareWages`, `scenario.selfEmploymentIncome`, `scenario.rrtaCompensation` | Statutory thresholds are not indexed; applies only to Medicare wages, self-employment income, and RRTA compensation |
| ACA premium tax credit applicable percentages and required contribution percentage | IRS Rev. Proc. 2025-25 / IRB 2025-32: https://www.irs.gov/irb/2025-32_IRB and direct PDF https://www.irs.gov/pub/irs-drop/rp-25-25.pdf | `ACA_2026.applicablePercentageTable`, `ACA_2026.requiredContributionPercentage` | Usually released in summer before the plan year |
| ACA federal default age rating curve | CMS Final Guidance Regarding Age Curves and State Reporting: https://www.cms.gov/cciio/resources/regulations-and-guidance/downloads/final-guidance-regarding-age-curves-and-state-reporting-12-16-16.pdf | `FEDERAL_DEFAULT_ACA_AGE_RATING_CURVE` | Verify if CMS changes default age-curve guidance or a state-specific curve should apply |
| ACA maximum annual limitation on cost-sharing | CMS Marketplace Integrity and Affordability Final Rule / fact sheet: https://www.cms.gov/newsroom/fact-sheets/2025-marketplace-integrity-and-affordability-final-rule | `ACA_2026.costSharingLimit` | Usually finalized before open enrollment |
| Federal poverty guidelines | HHS Federal Register annual notice: https://www.federalregister.gov/documents/2026/01/15/2026-00755/annual-update-of-the-hhs-poverty-guidelines and ASPE poverty guidelines page https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines | `FPL_2026`, `FEDERAL_POVERTY_GUIDELINES_BY_YEAR` | Usually released in January of the guideline year |
| State income tax rates, brackets, standard deductions, exemptions, capital gains notes | Tax Foundation state income tax annual table: https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/ | `STATE_TAX_2026`, `STATE_TAX_BY_YEAR` | Usually published early in the tax year; verify retroactive updates |
| State retirement-income and Social Security tax treatment | Kiplinger 2026 all-state retiree tax guide: https://www.kiplinger.com/retirement/602202/taxes-in-retirement-how-all-50-states-tax-retirees; state revenue instructions should be used to audit edge cases | `STATE_RETIREMENT_TAX_RULES_2026` | Review at least annually and when a state enacts retirement-income changes |
| Federal Marketplace plan lookup | CMS Marketplace API docs/spec: https://developer.cms.gov/marketplace-api/ and https://developer.cms.gov/marketplace-api/api-spec | `src/data/marketplaceApi.mjs`, UI plan picker | Live API values depend on CMS API availability, API key, plan year, ZIP/county, household ages, tobacco flag, utilization level, and quote income |
| Exchange plan premiums and plan attributes | CMS Exchange PUFs: https://www.cms.gov/marketplace/resources/data/public-use-files; state-based exchange PUFs: https://www.cms.gov/marketplace/resources/data/state-based-public-use-files; QHP Landscape metadata: https://catalog.data.gov/dataset/qhp-landscape-py2026-individual-medical | `ACA_BENCHMARK_PREMIUMS_2026_MONTHLY`, future plan/rating-area tables | Updated during the plan year; CMS notes that PUF data can differ from Healthcare.gov display timing |
| Stocks, T-bills, 10-year Treasuries, real estate | NYU Stern Damodaran annual returns: https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html | `HISTORICAL_RETURNS[].stock`, `.cash`, `.bond`, `.realEstate` | Final calendar-year row is usually available in early January |
| Inflation through 2023 | NYU Stern Damodaran historical inflation table: https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histret.html | `HISTORICAL_RETURNS[].inflation` for source years available there | Updated periodically |
| Inflation extension for 2024 and 2025 | FRED CPIAUCSL: https://fred.stlouisfed.org/series/CPIAUCSL and CSV endpoint `https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL` | `HISTORICAL_RETURNS[].inflation` for years not yet in Damodaran's inflation table | Use December-over-December CPI when the final December value is available |
| Extended reconstructed U.S. returns before 1928 | Jordà-Schularick-Taylor Macrohistory Database R6: https://www.macrohistory.net/database/ and returns documentation: https://www.macrohistory.net/app/download/9834516469/RORE_documentation.pdf | `EXTENDED_HISTORICAL_RETURNS` prepended rows for `stock`, `bond`, `cash`, `realEstate`, and `inflation` before 1928 | JST data is licensed CC BY-NC-SA 4.0 and should be refreshed only when adopting a new JST release |
| Cross-check for pre-1928 U.S. stock returns | Robert Shiller/Yale stock market data: https://www.econ.yale.edu/~shiller/data.htm | Validation that JST U.S. equity total returns match annual returns reconstructed from Shiller/Cowles price and dividend history for 1872-1927 | Recheck when JST or Shiller/Yale source files are updated |
| TIPS returns | iShares TIPS Bond ETF performance page: https://www.ishares.com/ch/professionals/en/products/239467/ishares-tips-bond-etf | `HISTORICAL_RETURNS[].tips` | Available from ETF history; current app coverage starts in 2004 |
| Crypto returns | Coin Metrics community API daily BTC PriceUSD: `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD&frequency=1d&start_time=2010-01-01&end_time=2025-12-31&page_size=10000&format=csv` | `HISTORICAL_RETURNS[].crypto` | Update after final December 31 close is available |

## Current Modeling Notes

- Historical backtests only include years where every asset class in the user's portfolio has source data. In the default modern baseline, a portfolio with no TIPS or crypto can use 1928-2025; a portfolio with TIPS starts in 2004; a portfolio with crypto starts in 2011. In the opt-in extended reconstructed source, U.S. stock/bond/cash history starts in 1872 and U.S. real estate starts in 1891; 1928 onward remains the modern baseline data.
- The extended reconstructed source uses JST R6 before 1928. For U.S. stocks, the 1872-1927 JST total-return rows were cross-checked against annual total returns reconstructed from Shiller/Yale monthly price and dividend data, with differences limited to rounding noise. Bond, cash, real estate, and inflation values come directly from JST fields (`bond_tr`, `bill_rate`, `housing_tr`, and CPI percentage change).
- In the modern baseline, `stock`, `bond`, `cash`, and `realEstate` are mapped to NYU Stern's annual S&P 500 total return, 10-year Treasury bond total return, 3-month T-bill return, and real estate return series.
- In the extended reconstructed source before 1928, `stock`, `bond`, `cash`, and `realEstate` are mapped to JST U.S. equity total return, government bond total return, bill/deposit-rate return, and housing total return.
- `tips` is derived from iShares TIP NAV total return history when available.
- `crypto` is derived from BTC year-end daily USD price changes. It is a BTC proxy, not a diversified crypto index.
- ACA benchmark premiums are currently state-level defaults age-rated with the federal default age curve unless the user fills exact plan data. Exact selected-plan mode can bypass the selected-plan assumption by using the household SLCSP monthly premium, selected plan monthly premium, selected plan OOP max, and covered member ages from Healthcare.gov or a state exchange. Manual ACA premiums can be projected with inflation alone or with the federal ACA age curve on top of inflation; selected-plan OOP maximums are projected as dollar limits without age-rating.
- The CMS Marketplace API helper is intended for HealthCare.gov states. It uses CMS `counties/by/zip` and `plans/search` endpoints to populate exact gross selected-plan inputs and an estimated SLCSP from returned silver plans. The app still models future-year premiums by inflation and optional age rating after the selected plan is copied into the scenario.
- The backup ACA plan is a planning fallback for future years where modeled MAGI exceeds a configured FPL trigger, defaulting to 400%. When active, the backup selected premium and OOP maximum replace the primary plan values for that year.
- Massachusetts ConnectorCare helper values come from the public 2026 Massachusetts Health Connector ConnectorCare guide tables: 2025 FPL thresholds used for 2026 ConnectorCare eligibility, lowest monthly premium per person by Plan Type, and separate medical and prescription OOP maximums. The app combines medical and prescription OOP maximums into one conservative planning OOP value and treats the premium as a quoted net premium. The helper uses the ACA quote income/MAGI field, not target spend, because MAGI can be managed below spending via withdrawal-source choices. The UI can choose the public plan type automatically from MAGI or let the user select a specific public plan type; this is still a plan-type estimate, not a carrier-specific quote.
- Federal tax currently models the standard deduction, age-65 additional standard deduction, progressive ordinary income tax, preferential long-term capital gain and qualified dividend stacking, dynamic child tax credit counts from child ages, Social Security taxable-benefit phase-in, NIIT, Additional Medicare Tax on explicit earned-income inputs, capital-loss offsets and carryforwards, and manual additional deduction/credit overrides.
- Retirement cash-flow modeling can force RMDs from traditional accounts, collect Social Security as an income stream, schedule one-off expenses and income by year range, model optional essential/discretionary spending guardrails from the stock-market high-water mark, retain unspent forced distributions as taxable cash, tax nonqualified Roth earnings when the Roth five-year rule is not satisfied, apply an annual user-entered early-withdrawal penalty exception amount, and estimate Medicare Part B/D IRMAA using available two-year lookback MAGI.
- Withdrawal strategy modeling has two modes. The default heuristic follows the configured account withdrawal order with tax-aware lot sorting and Roth-basis savings-hurdle checks. The optional lifetime optimizer tests alternate withdrawal-source orders, lower expected-return lot sales, MAGI threshold-sized Roth-basis substitutions, pre-RMD Roth conversion pressure, IRMAA conversion caps for lookback-sensitive ages, and forward-looking gain harvesting when estimated future capital-gains tax rates justify current-year realization. A separate sequence-risk reserve option can preserve cash/T-bill, bond/TIPS, or hybrid reserve assets in non-stress early years and spend them first when stock returns are negative during the configured reserve tent window.
- State tax modeling includes a 2026 state-by-state retirement-income and Social Security rule table plus manual override controls. The table models broad IRA/401(k)-style distributions and Social Security; plan-specific public pension, military, railroad, disability, local income tax, and credit-only rules need state-form-level audit before filing.
- NIIT thresholds are held nominal because IRS guidance says the statutory thresholds are not indexed for inflation.
- The child tax credit is modeled as a nonrefundable credit against regular federal income tax. The refundable additional child tax credit is documented in the data object but is not yet applied because it depends on earned-income rules that this portfolio model does not collect.

## Annual Update Checklist

1. Create a new version label.
   - Tax data: increment `TAX_DATA_VERSION`, for example from `2026.1` to `2027.1`.
   - Historical returns: increment `HISTORICAL_RETURN_DATA_VERSION`, for example from `2026.1` to `2027.1`.

2. Add the new tax year in `src/data/taxData.mjs`.
   - Add `FEDERAL_TAX_YYYY`.
   - Add it to `FEDERAL_TAX_BY_YEAR`.
   - Add `FPL_YYYY` and register it in `FEDERAL_POVERTY_GUIDELINES_BY_YEAR`.
   - Add `ACA_YYYY` and register it in `ACA_BY_YEAR`.
   - Add or replace `ACA_BENCHMARK_PREMIUMS_YYYY_MONTHLY`.
   - Update `DEFAULT_TAX_YEAR` only after the UI should default to that year.

3. Regenerate state taxes.
   - Pull the Tax Foundation annual table and its downloadable data when available.
   - Generate `src/data/stateTaxYYYY.generated.mjs`.
   - Import the new generated table into `taxData.mjs`.
   - Add it to `STATE_TAX_BY_YEAR`.
   - Keep old generated files so prior-year tests and projections remain reproducible.

4. Update ACA plan-cost defaults.
   - Download CMS Exchange PUFs for the plan year.
   - For federal-platform states, use Rate PUF, Plan Attributes PUF, Service Area PUF, and QHP Landscape files.
   - For state-based exchanges, use CMS SBE QHP PUFs or the state exchange's own public files.
   - Prefer deriving a second-lowest-cost silver plan benchmark by rating area and household composition. If keeping a state-level fallback, document the aggregation method.

5. Append the final historical return year.
   - Download NYU Stern `histretSP.html` and verify the new final year exists.
   - If Damodaran's inflation table does not yet include the final year, download FRED CPIAUCSL and compute December-over-December CPI inflation.
   - Pull final iShares TIP calendar-year or year-end NAV return data.
   - Pull final Coin Metrics BTC daily prices through December 31 and compute year-over-year return from prior December 31 to current December 31.
   - Append the new row in `HISTORICAL_RETURNS`.

6. Add tests before trusting the new data.
   - Add tax-year tests for the new standard deduction, ordinary brackets, long-term capital gains thresholds, ACA applicable percentages, FPL values, and representative state tax cases.
   - Add historical return tests confirming the dataset ends in the new final year.
   - Add coverage tests for shorter-history asset classes.

7. Run verification.
   - `npm test`
   - Reload the local app.
   - Confirm the Backtests table includes a rolling window ending in the newly added final year.
   - Confirm the Year Breakdown table shows asset-class returns for the selected historical path.

## Useful Fetch Commands

These are starting points for the next annual data refresh. Update the year and direct file names as new source documents are released.

```bash
curl -L -o /tmp/histretSP.html "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html"
curl -L -o /tmp/histret.html "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histret.html"
curl -L -o /tmp/JSTdatasetR6.xlsx "https://www.macrohistory.net/app/download/9834512569/JSTdatasetR6.xlsx"
curl -L -o /tmp/shiller-ie-data.xls "http://www.econ.yale.edu/~shiller/data/ie_data.xls"
curl -L -o /tmp/cpi.csv "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL"
curl -L -o /tmp/tip_ishares.html "https://www.ishares.com/ch/professionals/en/products/239467/ishares-tips-bond-etf"
curl -L -o /tmp/btc_coinmetrics.csv "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD&frequency=1d&start_time=2010-01-01&end_time=2026-12-31&page_size=10000&format=csv"
curl -L -o /tmp/irs-federal-tax.pdf "https://www.irs.gov/pub/irs-drop/rp-25-32.pdf"
curl -L -o /tmp/irs-aca-ptc.pdf "https://www.irs.gov/pub/irs-drop/rp-25-25.pdf"
```

## Known Gaps To Close

- Replace state-level ACA benchmark defaults with rating-area and household-specific CMS/state PUF calculations.
- Add an explicit data-generation script so `src/data/historicalReturns.mjs` can be regenerated from raw downloaded source files instead of manually rebuilding the generated module.
- Add direct source URLs inside every tax-year object, not just source names.
- Track source retrieval dates and checksums for downloaded raw data files.
- Add full itemized deduction, refundable credit, earned income credit, AMT, QBI, education credit, household-specific ACA benchmark, and rule-specific retirement penalty exception engines.
