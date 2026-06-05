# Continuous Review Bar

Every change to this project is held to three lenses on every PR. This is not
a one-time audit; it is the standing definition of "done." Each lens has
concrete questions, a checklist that lives in
`.github/PULL_REQUEST_TEMPLATE.md`, and an automated floor enforced by tests.

The bar exists because [GOAL.md](GOAL.md) is ambitious: CPA-grade accuracy,
engineering rigor, and a design a non-advisor can act on. None of those survive
without continuous enforcement.

## The Three Lenses

### CPA Lens — "Would a CPA sign their name to this output?"

A PR touches the CPA lens if it changes any of:

- Federal tax facts (brackets, deductions, credits, NIIT, Additional Medicare,
  RMDs, Social Security taxation thresholds).
- ACA facts (applicable percentages, required contribution percentage, FPL
  guidelines, benchmark premiums, age-rating curve, cost-sharing limits).
- State tax facts (rates, brackets, retirement-income exclusions, capital-gains
  treatment, Social Security treatment, estate/inheritance tax).
- Medicare facts (IRMAA tiers, Part B/D premiums, lookback rules).
- Withdrawal-character rules (Roth basis, 5-year clocks, early-withdrawal
  penalty, conversion recapture, inherited-account rules).

For every such change, the PR must:

1. **Cite a primary source.** IRS Pub, Rev. Proc., IRB notice, CFR, CMS rule,
   HHS Federal Register notice, or state revenue department instructions. Not
   a secondary aggregator (Tax Foundation, Kiplinger, news articles) except as
   a cross-check or until a primary source is available.
2. **Add a golden test** in `tests/golden_*.test.mjs` that exercises the new
   fact against a worked example traceable to that primary source.
3. **Update [`docs/DATA_SOURCES.md`](DATA_SOURCES.md)** with the source URL and
   the in-app fields the source feeds.
4. **Update or extend [`docs/KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)** if
   the new rule narrows or widens what the model claims to cover.

If the PR cannot cite a primary source, it should not change the modeled rule.
It can still add a labeled user override.

### Engineering Lens — "Is this still reproducible, tested, and stable?"

Every PR is held to:

1. **Pure core, observable I/O.** Code in `src/core/` is pure. Side effects
   live in `src/app.mjs` and `src/redesign.mjs`. Tests can call the core
   directly.
2. **Deterministic outputs.** Monte Carlo and historical paths reproduce
   exactly from a setup file + seed.
3. **Versioned data tables.** Tax data, ACA data, historical returns, and
   Monte Carlo CMA presets have version constants (`TAX_DATA_VERSION`,
   `HISTORICAL_RETURN_DATA_VERSION`).
4. **Tests pass.** `npm test`. New behavior gets new tests; new tax facts get
   golden tests.
5. **No silent assumptions.** Every modeled rule is either a labeled user
   control or a documented default with a source.
6. **Numerical stability.** No NaN/Infinity leak into UI outputs. Money
   amounts round to six decimals internally, two for display, and conservation
   invariants hold (cash flow balance, no negative balances except by design).

### Design Lens — "Can a spouse read this verdict together in 60 seconds?"

Every PR that changes user-facing output is held to:

1. **The verdict is one sentence.** Safe, fragile, or unsafe — with the
   evidence shown, not buried.
2. **Disagreement is surfaced, not averaged.** If Monte Carlo says safe and
   historical cohorts say fragile, the verdict is fragile and the
   disagreement is explained.
3. **Every action-row maps to a why.** "Convert $X to Roth in year Y" links to
   the assumption that drove it and the override that would change it.
4. **ZIP code is the only geographic input.** State, county, rating area,
   exchange, and Medicaid status are derived. The user does not type "rating
   area 4."
5. **The healthcare bridge is a screen, not a tab.** Pre-65 ACA + post-65
   IRMAA + the cliff at 65 are surfaced together.
6. **Plain-language explanations beat jargon.** "Modified Adjusted Gross
   Income" gets a tooltip on first use. "PTC" never appears without "premium
   tax credit" attached.
7. **Mobile and desktop are equal citizens.** The change is verified on a
   phone-sized viewport (≥320 px wide) and a desktop viewport. Tables reflow
   or scroll cleanly; charts adapt or expose a tabular alternative; touch
   targets are usable; numeric inputs trigger the appropriate mobile
   keyboard. New layouts that look good only on desktop do not ship.

## Per-PR Enforcement

The checklist in `.github/PULL_REQUEST_TEMPLATE.md` is the runtime version of
this document. Every PR fills it in before merge. PRs that do not touch a
lens can mark its section N/A.

## Automated Floor

Two test categories are the floor under the CPA + Engineering lenses:

### Golden tests (`tests/golden_*.test.mjs`)

Tests that exercise a single tax-law rule against a worked example traceable
to a primary IRS, CMS, or HHS publication. Each test header names the source
and the worked example. Adding a new tax-law fact requires adding or
extending a golden test.

Current seed coverage:

- `tests/golden_aca_ptc.test.mjs` — ACA premium tax credit, IRS Rev. Proc.
  2025-25 applicable percentages.
- `tests/golden_ss_taxation.test.mjs` — Social Security benefit taxation,
  IRS Publication 915 worksheet.
- `tests/golden_ltcg_stacking.test.mjs` — Long-term capital gains stacking
  above ordinary income, IRS Schedule D Qualified Dividends and Capital Gain
  Tax Worksheet with 2026 MFJ brackets.
- `tests/golden_senior_deduction.test.mjs` — OBBBA enhanced senior deduction
  (2025-2028), IRC §151(d)(5) and IRS Schedule 1-A (Form 1040) Part V
  per-person phaseout worksheet.
- `tests/golden_actc.test.mjs` — Child Tax Credit and refundable Additional
  Child Tax Credit, IRC §24 and the IRS Schedule 8812 earned-income formula.

### Data-source coverage (`tests/dataSourcesCoverage.test.mjs`)

A structural test that walks the versioned data exports in `src/data/` and
asserts each is referenced in `docs/DATA_SOURCES.md`. A new versioned table
without a documented source fails CI.

## Annual Cycle

The CPA lens has an annual cadence as well as a per-PR one. Every January,
the runbook in [`docs/DATA_SOURCES.md`](DATA_SOURCES.md) is executed against
the new IRS, CMS, and HHS releases. The cycle produces:

- An incremented `TAX_DATA_VERSION` and new `FEDERAL_TAX_YYYY` / `ACA_YYYY` /
  `FPL_YYYY` / `MEDICARE_IRMAA_YYYY` tables.
- Refreshed state tax tables (`stateTaxYYYY.generated.mjs`).
- A historical-returns append for the closed calendar year.
- New golden tests covering the new year's facts.
- A commit log line tagged `chore(annual): YYYY tax-year refresh`.

## When To Add To This Bar

The bar grows over time. Add a check here when:

- A category of bug repeatedly slips through (e.g., MAGI definition drift).
- A new modeling area (heir maximization, estate tax) introduces a class of
  rule that needs its own primary-source discipline.
- A user-facing regression shows the design lens missed a class of
  readability problem.

Bar additions go in a PR alongside the test or rubric that enforces them.
