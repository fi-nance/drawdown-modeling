# Portfolio Success Lab

A browser-based, tax-aware retirement decumulation planner with Monte Carlo simulation, historical backtesting, setup import/export, and year-by-year cash-flow visualization.

## What Is Implemented

- Deterministic portfolio engine in `src/core/`
- Single UI entrypoint at `index.html` with persona, workspace, and results screens
- "Recently left work" first-screen path and "Bad-market fallback" outcome for households deciding whether they can stay retired after leaving work
- Decision panel that turns the base plan into a safe, fragile, or unsafe verdict with Monte Carlo evidence, historical evidence, failure timing, healthcare guardrails, and ranked rescue options
- Rescue solvers for bad-market discretionary spending cuts, earned-income bridges, and the combined "do both" plan, with final displayed options rerun at the selected Monte Carlo count and historical backtest settings
- Monte Carlo runs with seeded random return and inflation paths
- Historical rolling, specific-start-year, and chunked-window backtests with a default 1928-present modern source and an opt-in reconstructed 1872-present source
- Versioned 2026 federal tax tables, preferential long-term capital gains stacking, NIIT, W-2 employee FICA, Additional Medicare Tax, self-employment tax, state tax profiles, capital loss carryforwards, and ordinary loss offsets
- Withdrawal tax character by account type and lot holding period, including Roth contribution basis, Roth five-year-rule controls, conversion five-year penalty recapture, and annual early-withdrawal penalty exception controls
- Tax loss harvesting, tax gain harvesting, and Roth conversion modeling
- Selectable withdrawal strategy modes: the current heuristic or an opt-in lifetime optimizer that tests alternate withdrawal sources, expected-return sale costs, MAGI thresholds, Roth-basis savings hurdles, and forward-looking gain/conversion room
- Optional essential/discretionary spending guardrails that keep essential spending inflation-adjusted while trimming discretionary spending at stock-market drawdown thresholds
- Optional sequence-risk reserve rules for cash/T-bill, bond/TIPS, or hybrid reserves during the early-retirement tent window
- 2026 ACA premium tax credit estimates from annual MAGI, household-size FPL, age-rated SLCSP benchmark premiums, optional exact selected-plan premiums/OOP maximums, and backup-plan switching above an FPL trigger
- Social Security claiming solver (coarse claiming-age 62-70 grid as a solver dimension, rescaling benefits per age), opt-in earnings-to-PIA estimation with source-versioned SSA 2026 bend points (a coarse single-year proxy, off by default), taxable benefit modeling, forced RMDs, age-65 standard-deduction bumps, the 2025-2028 enhanced senior deduction with MAGI phaseout, and Medicare Part B/D IRMAA estimates
- Detailed legacy planner with heir-specific rules (spouse rollover, non-spouse 10-year distributions stacked progressively to simulate bracket compression, eligible-designated life-expectancy stretch), Federal Estate Tax (40% above the 2026 $15M per-decedent exclusion; spouse exempt), and lineal-heir state inheritance tax (PA 4.5%, NE 1%; NJ/MD exempt lineal heirs)
- Target spend controls that can include or exclude taxes and medical costs
- Workspace planning runs require at least $1,000/year of target spending (or combined essential/discretionary spending) so engine edge-test values like $0 do not look like normal household plans
- One-off cash flows by year or year range, fixed or inflation adjusted, as expenses, taxable ordinary income, tax-free income, Medicare wages, self-employment income, or RRTA compensation
- CSV and JSON imports, a sample CSV template, public Google Sheets CSV import, private Google Sheets OAuth import, privacy mode for disabling external lookup helpers, and full setup backup/restore, including the decision profile
- Sankey-style yearly cash-flow and portfolio-flow visualizations
- Year-by-year, scenario-by-scenario, backtest, and current-year sale breakdowns

## Commands

```bash
npm test
npm run start
```

Then open:

```text
http://localhost:4173/
```

## Decision Engine And Rescue Options

The fastest way to try the decision layer is to choose **Recently left work**, use sample data or import a portfolio, then view results. That path fills a 44-year-old Massachusetts household, preselects the bad-market fallback outcome, enables healthcare and strategy controls, and separates spending into required and flexible amounts.

The Basics module includes three decision fields:

- `Required spend`: spending the household does not want the solver to cut.
- `Flexible spend`: spending the solver can trim during early market stress.
- `Success target %`: the depletion-avoidance target, defaulting to 90%.

The results Decision panel compares the base plan against three rescue choices: cut flexible spending during early market stress, earn bridge income for a limited number of years, or do both. Monte Carlo and historical backtests are shown side by side. If one evidence source passes and the other misses the target, the verdict stays fragile instead of hiding the disagreement in one blended score.

Intermediate solver probes use a bounded Monte Carlo search so the UI can remain responsive. The final displayed rescue options are rerun with the user's selected Monte Carlo count and historical backtest settings, so the percentages shown in the panel are comparable with the base plan.

## Portfolio Import Columns

CSV upload is the primary file-import path in the UI. JSON accepts either an array of assets or an object with an `assets` array.
Google Sheets import expects a published CSV, or private Sheets values through OAuth, with these columns:

```text
name,accountType,assetClass,units,price,costBasisPerUnit,dividendYield,qualifiedDividendShare,holdingPeriod,beneficiaryType
```

CSV uploads and Google Sheets imports also accept common spreadsheet headers such as `Account Type`, `Asset Class`, `Shares`, `Current Price`, and `Cost Basis / Share`. Only account type, units/shares, and price are required. Missing or non-numeric cost basis defaults to the current price, which keeps retirement accounts easy to import.

Supported `accountType` values are `taxable`, `traditional`, `roth`, and `hsa`.
CSV and Google Sheets imports also normalize common retirement account labels: `traditional`, `pre-tax`, and `pre-tax 401k` import as `traditional`; `roth`, `after-tax`, and `after-tax 401k` import as `roth`.
Supported `assetClass` values are `stock`, `bond`, `cash`, `realEstate`, `tips`, and `crypto`.
Optional `beneficiaryType` values are `default`, `spouse`, `nonSpouse10Yr`, and `eligibleDesignated`; this lets an account override the household-level heir beneficiary assumption in the after-tax bequest estimate.

Private Google Sheets can be imported with Google OAuth by entering a Google OAuth web client ID, the sheet URL or spreadsheet ID, and an A1 range such as `A:J`. The OAuth client must include the app origin, for example `http://127.0.0.1:4175`, in its authorized JavaScript origins. The app requests only `https://www.googleapis.com/auth/spreadsheets.readonly` and keeps the access token in memory.

Private data can also be imported without OAuth by downloading the sheet as CSV and selecting it with the CSV file input.

Privacy mode disables public Google Sheets import, private Google Sheets OAuth import, and the live CMS Marketplace plan search. It does not disable local CSV, JSON, setup backup/restore, offline ZIP-based ACA estimates, or manual ACA plan fields. The modeled scenario and audit bundle record whether privacy mode was enabled.

Use the Save setup / Load setup controls in the persona, workspace, or results flow to export or restore the full setup, including assets, scenario controls, decision profile, and one-off cash flows. The results screen can also export a result audit bundle: setup, compacted modeled results, confidence flags, sensitivity output, source-version metadata, the plain-language model-audit rows, and a compact CPA/engineering review summary in one JSON file. Setup backups and result audit bundles both include sensitive household data; the app asks for confirmation before exporting either, and they should be shared only intentionally.

## Accuracy Notes

The active tax-law year is 2026. Federal brackets, standard deductions, itemized-deduction limits, AMT tripwire thresholds, long-term capital gains thresholds, NIIT, W-2 employee FICA, Additional Medicare Tax, self-employment tax, ACA applicable percentages, and HHS poverty guidelines are versioned in `src/data/taxData.mjs`. State income tax defaults use the generated 2026 state table in `src/data/stateTax2026.generated.mjs`, with manual overrides available in the UI for power users or state-specific nuance not yet modeled.

ACA has two plan-cost modes. State benchmark estimate mode uses the ZIP field, when present, to resolve an offline 2026 rating-area-level SLCSP for the 30 bundled federal-platform states; otherwise it falls back to the built-in state-level SLCSP estimate and treats that benchmark as the selected plan. Exact selected plan mode requires the household SLCSP monthly premium, selected plan monthly premium, selected plan OOP max, and covered member ages; subsidy math uses the SLCSP while medical spending uses the selected plan. Manual ACA premiums and ZIP-derived benchmarks are age-rated and inflated forward; selected-plan OOP maximums inflate as dollar limits, but are not age-rated.

ACA confidence flags use the simulated plan when available: non-expansion-state years below the PTC floor are called out as modeled coverage-gap years, and expansion-state years below 138% FPL are called out as Medicaid/CHIP handoff years that need eligibility review.

For HealthCare.gov states, the CMS Marketplace API helper can look up available plans by ZIP/county FIPS, household ages, ACA quote income/MAGI, tobacco flag, utilization level, and plan year. Selecting a plan fills the SLCSP benchmark, selected plan premium, selected plan OOP max, issuer/name metadata where used, and covered ages for exact gross-premium modeling.

Massachusetts users can use the MA ConnectorCare helper to fill an estimated 2026 ConnectorCare net premium and combined medical/Rx OOP maximum from ACA quote income/MAGI, household size, marketplace member count, and either the automatic MAGI-derived plan type or a user-selected public plan type. These are official plan-type estimates, not carrier-specific quotes. Those premiums are treated as quoted net premiums, so the app does not subtract a second federal subsidy. A backup ACA plan can also be entered or filled from supported federal Marketplace results; the simulator switches to it when modeled MAGI exceeds the backup FPL trigger, which defaults to 400%.

Retirement-tax controls include Roth contribution basis, whether the Roth five-year qualified-distribution rule is satisfied, annual early-withdrawal penalty exception amounts, RMD start-age override, Social Security benefit timing, Medicare/IRMAA enrollment and lookback inputs, earned-income inputs for W-2 employee FICA, Additional Medicare Tax, and Schedule SE self-employment tax, optional W-2 Social Security wages for wage-base coordination, dynamic child ages, age-65 standard-deduction bumps, the 2025-2028 enhanced senior deduction, Schedule A itemized deduction inputs (deduction choice, SALT paid, mortgage interest, charitable gifts, and medical expenses), an AMT preference/addback tripwire input, QBI deduction planning inputs (source, amount, SSTB status, W-2 wages, and UBIA property), heir ordinary tax rate for after-tax bequest estimates, and manual federal deduction/credit overrides. Itemized inputs trigger CPA-review confidence flags because the model applies the 2026 SALT cap/phaseout and medical-expense AGI floor but treats mortgage interest and charitable gifts as already deductible/substantiated amounts. AMT exposure triggers CPA-review confidence flags when the household enters Form 6251 preference/addback estimates or modeled income gets near the 2026 AMT exemption phaseout; the app does not calculate tentative minimum tax or full Form 6251 adjustments. QBI inputs trigger CPA-review confidence flags because the model applies the 2026 Section 199A planning formula but does not validate trade/business status, K-1 aggregation, loss carryforwards, REIT/PTP components, reasonable compensation, or full Form 8995-A facts. Nonzero manual federal deduction/credit overrides trigger CPA-review confidence flags because the model applies them mechanically but does not validate eligibility, phaseouts, refundability, or AMT/QBI interactions. Self-employment income triggers a CPA-review confidence flag because business/pass-through items beyond Schedule SE and optional QBI planning still need review.

After-tax bequest and legacy modeling features a progressive heir taxation engine. The simulator models spouse rollover (tax-deferred), non-spouse 10-year distributions stacked progressively on the heir's starting base income (default $80,000 Single) to simulate bracket compression, and eligible-designated stretch distributions over a life-expectancy schedule (a generic table approximating the IRS Single Life Table). The household-level heir beneficiary type is the default, and individual portfolio accounts can override it with their own `beneficiaryType` when an IRA, HSA, Roth, or taxable account has a different beneficiary. It models the Federal Estate Tax (40% above the 2026 $15M per-decedent exclusion; surviving-spouse transfers are exempt under the unlimited marital deduction) and lineal-heir state inheritance tax (PA 4.5%, NE 1%; NJ Class A and MD lineal descendants are exempt — non-lineal heirs face higher rates that are out of model). It assumes taxable-account unrealized gains receive a basis step-up at death. Heir income/age default to $80,000/age 30 when unset and materially affect the result, so set them for your heirs.

The default withdrawal strategy keeps the app's established current-year heuristic. The optional lifetime optimizer evaluates multiple account-source orders each year, preserves Roth basis unless modeled tax/medical savings meet the configured hurdle, prefers lower expected-return lots when tax costs are otherwise similar, can use MAGI thresholds to size Roth-basis substitutions, and can harvest gains beyond the 0% long-term capital gains bracket when the modeled current-year cost is lower than an estimated future capital-gains tax rate. The essential/discretionary spending guardrail mode follows the stock-market drawdown rule popularized by Mad Fientist and Of Dollars and Data: essential spending inflates, discretionary spending stays nominal, and discretionary spending is modeled at 100%, 50%, or 0% depending on whether the prior year-end stock index is less than 10%, 10-20%, or more than 20% below its high-water mark. The separate sequence-risk reserve option lets users test cash/T-bill, bond/TIPS, or hybrid reserve behavior: reserve assets are preserved in non-stress early years and spent first when stock returns are negative during the configured reserve tent window.

Failed Monte Carlo paths are summarized by depletion timing, sequence/inflation trigger, and broad stressors: tax drag, healthcare drag, spending pressure, reserve shortfall, and allocation mismatch. These stressors help rank rescue options, but they are still planning diagnostics rather than a causal proof of exactly which dollar caused depletion.

Historical backtesting data is versioned in `src/data/historicalReturns.mjs` and runs through 2025 where source history exists. The default modern baseline uses Damodaran-style annual returns from 1928 onward. The opt-in extended reconstructed source prepends JST U.S. reconstructed stock, bond, cash, housing, and CPI history before 1928; stock/bond/cash coverage starts in 1872 and real estate coverage starts in 1891. Crypto and TIPS histories start later than the core stock/bond/cash series, so the Backtesting panel includes explicit proxy options: stock returns before crypto data begins and bond returns before TIPS data begins. Actual crypto and TIPS returns are still used once available. The data-source inventory and annual refresh checklist live in [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).

Monte Carlo defaults use the 2026 market-neutral preset: 1000 correlated annual paths, nominal before-tax/before-fee return assumptions, and arithmetic annual draw means converted from public geometric capital-market assumptions. The conservative planning and historical-fit presets remain available. Crypto stays a speculative BTC-like assumption rather than a capital-market-assumption median.

## Documentation

- [Project goal and north-star roadmap](docs/GOAL.md)
- [Continuous CPA / engineering / design review bar](docs/REVIEW_BAR.md)
- [Data sources and annual update runbook](docs/DATA_SOURCES.md)
- [Known modeling limitations](docs/KNOWN_LIMITATIONS.md)
- [Product design review for the post-job decision engine](docs/PRODUCT_DESIGN_REVIEW.md)
