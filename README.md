# Portfolio Success Lab

A browser-based, tax-aware retirement decumulation planner with Monte Carlo simulation, historical backtesting, setup import/export, and year-by-year cash-flow visualization.

## What Is Implemented

- Deterministic portfolio engine in `src/core/`
- V2 UI is the default app at `index.html`; `v2ui.html` remains as a compatibility entrypoint
- Monte Carlo runs with seeded random return and inflation paths
- Historical rolling, specific-start-year, and chunked-window backtests with a default 1928-present modern source and an opt-in reconstructed 1872-present source
- Versioned 2026 federal tax tables, preferential long-term capital gains stacking, NIIT, Additional Medicare Tax, state tax profiles, capital loss carryforwards, and ordinary loss offsets
- Withdrawal tax character by account type and lot holding period, including Roth contribution basis, Roth five-year-rule controls, conversion five-year penalty recapture, and annual early-withdrawal penalty exception controls
- Tax loss harvesting, tax gain harvesting, and Roth conversion modeling
- Selectable withdrawal strategy modes: the current heuristic or an opt-in lifetime optimizer that tests alternate withdrawal sources, expected-return sale costs, MAGI thresholds, Roth-basis savings hurdles, and forward-looking gain/conversion room
- 2026 ACA premium tax credit estimates from annual MAGI, household-size FPL, age-rated SLCSP benchmark premiums, optional exact selected-plan premiums/OOP maximums, and backup-plan switching above an FPL trigger
- Social Security taxable-benefit modeling, forced RMDs, age-65 standard-deduction bumps, and Medicare Part B/D IRMAA estimates
- Target spend controls that can include or exclude taxes and medical costs
- One-off cash flows by year or year range, fixed or inflation adjusted, as expenses, taxable ordinary income, tax-free income, Medicare wages, self-employment income, or RRTA compensation
- CSV and JSON imports, a sample CSV template, public Google Sheets CSV import, private Google Sheets OAuth import, and full setup backup/restore
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

## Portfolio Import Columns

CSV upload is the primary file-import path in the UI. JSON accepts either an array of assets or an object with an `assets` array.
Google Sheets import expects a published CSV, or private Sheets values through OAuth, with these columns:

```text
name,accountType,assetClass,units,price,costBasisPerUnit,dividendYield,qualifiedDividendShare,holdingPeriod
```

CSV uploads and Google Sheets imports also accept common spreadsheet headers such as `Account Type`, `Asset Class`, `Shares`, `Current Price`, and `Cost Basis / Share`. Only account type, units/shares, and price are required. Missing or non-numeric cost basis defaults to the current price, which keeps retirement accounts easy to import.

Supported `accountType` values are `taxable`, `traditional`, `roth`, and `hsa`.
CSV and Google Sheets imports also normalize common retirement account labels: `traditional`, `pre-tax`, and `pre-tax 401k` import as `traditional`; `roth`, `after-tax`, and `after-tax 401k` import as `roth`.
Supported `assetClass` values are `stock`, `bond`, `cash`, `realEstate`, `tips`, and `crypto`.

Private Google Sheets can be imported with Google OAuth by entering a Google OAuth web client ID, the sheet URL or spreadsheet ID, and an A1 range such as `A:I`. The OAuth client must include the app origin, for example `http://127.0.0.1:4175`, in its authorized JavaScript origins. The app requests only `https://www.googleapis.com/auth/spreadsheets.readonly` and keeps the access token in memory.

Private data can also be imported without OAuth by downloading the sheet as CSV and selecting it with the CSV file input.

Use the Backup / Restore controls in the Setup tab to export or restore the full setup, including assets, scenario controls, and one-off cash flows.

## Accuracy Notes

The active tax-law year is 2026. Federal brackets, standard deductions, long-term capital gains thresholds, NIIT, Additional Medicare Tax, ACA applicable percentages, and HHS poverty guidelines are versioned in `src/data/taxData.mjs`. State income tax defaults use the generated 2026 state table in `src/data/stateTax2026.generated.mjs`, with manual overrides available in the UI for power users or state-specific nuance not yet modeled.

ACA has two plan-cost modes. State benchmark estimate mode uses the built-in state-level SLCSP fallback and treats that benchmark as the selected plan. Exact selected plan mode requires the household SLCSP monthly premium, selected plan monthly premium, selected plan OOP max, and covered member ages; subsidy math uses the SLCSP while medical spending uses the selected plan. Manual ACA premiums can optionally be age-rated forward with the federal ACA age curve on top of inflation. Selected-plan OOP maximums inflate as dollar limits, but are not age-rated.

For HealthCare.gov states, the CMS Marketplace API helper can look up available plans by ZIP/county FIPS, household ages, ACA quote income/MAGI, tobacco flag, utilization level, and plan year. Selecting a plan fills the SLCSP benchmark, selected plan premium, selected plan OOP max, issuer/name metadata where used, and covered ages for exact gross-premium modeling.

Massachusetts users can use the MA ConnectorCare helper to fill an estimated 2026 lowest-cost ConnectorCare net premium and combined medical/Rx OOP maximum from ACA quote income/MAGI, household size, and marketplace member count. Those premiums are treated as quoted net premiums, so the app does not subtract a second federal subsidy. A backup ACA plan can also be entered or filled from supported federal Marketplace results; the simulator switches to it when modeled MAGI exceeds the backup FPL trigger, which defaults to 400%.

Retirement-tax controls include Roth contribution basis, whether the Roth five-year qualified-distribution rule is satisfied, annual early-withdrawal penalty exception amounts, RMD start-age override, Social Security benefit timing, Medicare/IRMAA enrollment and lookback inputs, earned-income inputs for Additional Medicare Tax, dynamic child ages, age-65 standard-deduction bumps, and manual federal deduction/credit overrides.

The default withdrawal strategy keeps the app's established current-year heuristic. The optional lifetime optimizer evaluates multiple account-source orders each year, preserves Roth basis unless modeled tax/medical savings meet the configured hurdle, prefers lower expected-return lots when tax costs are otherwise similar, can use MAGI thresholds to size Roth-basis substitutions, and can harvest gains beyond the 0% long-term capital gains bracket when the modeled current-year cost is lower than an estimated future capital-gains tax rate.

Historical backtesting data is versioned in `src/data/historicalReturns.mjs` and runs through 2025 where source history exists. The default modern baseline uses Damodaran-style annual returns from 1928 onward. The opt-in extended reconstructed source prepends JST U.S. reconstructed stock, bond, cash, housing, and CPI history before 1928; stock/bond/cash coverage starts in 1872 and real estate coverage starts in 1891. Crypto and TIPS histories start later than the core stock/bond/cash series, so the Backtesting panel includes explicit proxy options: stock returns before crypto data begins and bond returns before TIPS data begins. Actual crypto and TIPS returns are still used once available. The data-source inventory and annual refresh checklist live in [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).

Long-horizon tax-law limitations and implementation priorities are tracked in [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).
