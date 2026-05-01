# Portfolio Success Lab

A test-first foundation for tax-aware portfolio success forecasting.

## What Is Implemented

- Deterministic portfolio engine in `src/core/`
- Monte Carlo runs with seeded random return and inflation paths
- Historical rolling, specific-start-year, and chunked-window backtests
- Versioned 2026 federal tax tables, preferential long-term capital gains stacking, state tax profiles, capital loss carryforwards, and ordinary loss offsets
- Withdrawal tax character by account type and lot holding period
- Tax loss harvesting, tax gain harvesting, and Roth conversion modeling
- 2026 ACA premium tax credit estimates from annual MAGI, age-rated state benchmark premiums, and household-size FPL
- Target spend controls that can include or exclude taxes and medical costs
- One-off expenses by year or year range, fixed or inflation adjusted
- JSON import/export, a sample CSV template, and published Google Sheets CSV import
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

JSON accepts either an array of assets or an object with an `assets` array.
Google Sheets import expects a published CSV with these columns:

```text
name,accountType,assetClass,units,price,costBasisPerUnit,dividendYield,qualifiedDividendShare,holdingPeriod
```

CSV uploads also accept common spreadsheet headers such as `Account Type`, `Asset Class`, `Shares`, `Current Price`, and `Cost Basis / Share`. Only account type, units/shares, and price are required. Missing or non-numeric cost basis defaults to the current price, which keeps retirement accounts easy to import.

Supported `accountType` values are `taxable`, `traditional`, `roth`, and `hsa`.
CSV and Google Sheets imports also normalize common retirement account labels: `traditional`, `pre-tax`, and `pre-tax 401k` import as `traditional`; `roth`, `after-tax`, and `after-tax 401k` import as `roth`.
Supported `assetClass` values are `stock`, `bond`, `cash`, `realEstate`, `tips`, and `crypto`.

Private Google Sheets can be imported with Google OAuth by entering a Google OAuth web client ID, the sheet URL or spreadsheet ID, and an A1 range such as `A:I`. The OAuth client must include the app origin, for example `http://127.0.0.1:4175`, in its authorized JavaScript origins. The app requests only `https://www.googleapis.com/auth/spreadsheets.readonly` and keeps the access token in memory.

Private data can also be imported without OAuth by downloading the sheet as CSV and selecting it with the CSV file input.

## Accuracy Notes

The active tax-law year is 2026. Federal brackets, standard deductions, long-term capital gains thresholds, ACA applicable percentages, and HHS poverty guidelines are versioned in `src/data/taxData.mjs`. State income tax defaults use the generated 2026 state table in `src/data/stateTax2026.generated.mjs`, with manual overrides available in the UI for power users or state-specific nuance not yet modeled.

Historical backtesting data is versioned in `src/data/historicalReturns.mjs` and runs through 2025 where source history exists. Crypto history starts later than the core stock/bond/cash series, so the Backtesting panel includes an option to use stock returns for crypto before crypto data begins; actual crypto returns are still used once available. The data-source inventory and annual refresh checklist live in [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).

Long-horizon tax-law limitations and implementation priorities are tracked in [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).
