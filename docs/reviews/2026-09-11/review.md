# CPA, financial-planner and early-retiree follow-up — September 11, 2026

Reviewed starting commit `7130909` on `initial-submit`. The prior review's delivered fixes are present. This follow-up found three reproducible financial defects and an important multi-year optimization gap; all four are corrected in this submission. The review used source inspection, independent financial regression review, primary IRS/SSA sources, deterministic examples, the full automated suite and Chromium desktop/phone viewport checks.

## Findings corrected

| Priority / confidence | Finding and demonstrated impact | Correction / verification |
| --- | --- | --- |
| P1 / 10 of 10 | Generic broker **Cost Basis** was read as basis per share. 100 shares priced at $100 with $5,000 total basis produced a $490,000 loss instead of a $5,000 gain. The triggering alias was `"cost basis"` inside `costBasisPerUnit` in `src/core/importers.mjs`. | Total and per-share headers now have different meanings; total basis is divided by quantity. Conflicting or invalid totals are rejected. JSON total-basis fields follow the same convention. Re-import previously affected files. |
| P1 / 10 of 10 | A spouse's $3,000 employer HSA contribution could be omitted from the shared family cap when that spouse had a zero base allocation. The planner recommended $8,750 more, making $11,750 combined deposits. `hsa.mjs` previously capped each owner's room separately without an aggregate family cap. | Both employers consume household room before personal contributions are allocated; separate catch-up caps remain. Tests cover both employers, different allocations, catch-ups and excess employer deposits. |
| P1 / 10 of 10 | A spouse's death disabled the survivor's own earnings-test adjustment because all survivor cash went through `applyEarnings(..., true)`. A $24,000 age-62 benefit withheld for 60 months correctly became $34,285.71 at FRA with both spouses alive, but remained $24,000 after the other spouse died. | The engine compares earnings-adjusted own benefits with survivor benefits and retains own-record credits. Both death orders are tested. |
| P1 / 10 of 10 | Gain harvesting compared nearby ACA bands and estimated future tax rates, without pricing several years of basis building against later lost premium tax credits. `gainHarvestingRoom` relied on `acaMagiCeiling` and `estimatedFutureCapitalGainRate`. | A complete expected-return policy comparison now tests deferral, the current heuristic, 200/250/300/350/400% FPL ceilings, and front-loaded 400% harvesting followed by deferral. Actual taxes, premiums, basis, cash funding and ending wealth flow through each plan. |

Stock basis treatment follows [IRS stock-basis guidance](https://www.irs.gov/faqs/capital-gains-losses-and-sale-of-home/stocks-options-splits-traders/stocks-options-splits-traders-1). HSA allocation follows [Publication 969](https://www.irs.gov/publications/p969), with 2026 limits from [Revenue Procedure 2025-19](https://www.irs.gov/irb/2025-21_IRB). Own-record benefit adjustments follow [SSA's earnings-test explanation](https://www.ssa.gov/benefits/retirement/planner/whileworking.html). The ACA comparison uses the model's 2026 regime, including the 400% FPL boundary described in the [IRS PTC FAQs](https://www.irs.gov/affordable-care-act/individuals-and-families/questions-and-answers-on-the-premium-tax-credit).

Runnable financial reproductions: `node docs/reviews/2026-09-11/reproduce.mjs`. The script prints the three financial invariants and now reports safe results. Permanent regressions are in `tests/golden_followup_financial_review.test.mjs` and `tests/golden_multiyear_gain_harvesting.test.mjs`.

## The harvesting tradeoff

The economic regression starts with two age-57 adults, $300,000 taxable cash and $1 million stock with $100,000 basis, $110,000 annual spending, $32,000 gross annual premiums and benchmark, and eight years of zero returns/inflation to isolate the tradeoff. The selected 350% FPL policy pays more during the first three years, preserves two additional subsidy years, and improves after-tax ending wealth by approximately **$56,377**, without reducing funded spending. A 400% policy also beats the old heuristic by more than $20,000; 350% wins among the tested alternatives. These are a synthetic test household's results, not an estimate for the user's finances.

Additional review checks corrected during implementation:

- Funding extra harvesting costs can itself realize gains. Each targeted year is checked after cash reconciliation, reducing the harvest when needed to stay within its buffered MAGI ceiling.
- Assets bought at current market value still participate: future expected growth can create gains.
- Front-loaded policies count Marketplace years rather than unrelated earlier plan years.
- Included taxes and healthcare are deducted when comparing usable spending in all-in budgets. Lost subsidies cannot masquerade as a better bequest funded by an invisible lifestyle cut. With equal ending wealth, more usable spending breaks the tie.
- Monte Carlo and historical paths use the same policy selected from configured expected returns. They do not supply their future realized returns to the policy search.
- The action card and audit bundle expose the comparison, including rejected candidates with weaker spending outcomes. Manual harvesting overrides and the basic heuristic remain authoritative.
- TIPS ladder maintenance gains are excluded from the reported tax-gain-harvesting amount.

This is a **bounded policy search**, not a globally optimal lifetime tax schedule. It holds the configured Roth-conversion, spending and other strategy rules constant while comparing harvesting policies. Annual ceilings respond to each path's actual current income, basis and cost of funding; the ceiling schedule itself is selected at plan start. Future rule, return, health and spending assumptions require rerunning the plan.

## Remaining must-add capabilities for affected households

These are targeted next priorities, not a demand that every household use every feature.

1. **P1 for early access to employer plans: preserve account subtype and gate unsupported access rules.** `src/core/importers.mjs` still maps Roth 401(k) and Roth IRA into one `roth` type; generic traditional employer plans share a type with IRAs. The limitations document explicitly discloses IRA ordering for imported designated Roth plans and a manual penalty-exception amount. Before giving executable advice for those accounts, retain the original subtype and require a supported rollover/access assumption or a clear unsupported-scenario result. Full Rule-of-55/72(t)/457(b) engines can remain scoped separately; silently losing the distinction should not be the long-term interface.
2. **P1 for precision ACA optimization: income-dependent cost-sharing assumptions.** The new comparison respects entered OOP costs and backup-plan rules, but it does not automatically reprice a Silver plan's cost-sharing-reduction variant as income crosses CSR thresholds. The existing limitations disclose this. A household relying on CSR needs explicit income-band OOP assumptions or exact variant data before the harvesting policy can be treated as an actionable healthcare optimum. PTC alone is not the whole healthcare cost.
3. **P2 for imported portfolios: basis provenance and confirmation.** Missing per-share basis still defaults to current price in `normalizeImportedAsset`. That preserves the existing import contract but can hide gains if the original statement omitted basis. Mark assumed basis separately and require confirmation before precise gain-harvesting/PTC recommendations. The total-versus-per-share defect is fixed; missing factual basis is a different gap.
4. **P2 for charitable itemizers: dynamic 2026 deduction limits.** `src/core/tax.mjs` currently adds `charitableContributions` directly into the itemized total and treats it as an already deductible amount. It does not recompute the new 0.5%-of-AGI floor as conversions/harvests change AGI, or implement the high-income limitation on itemized-deduction benefit. This is disclosed partial Schedule A support. Add sourced annual rules and golden cases before interpreting gross donations as a dynamically optimized deduction. [IRS Publication 505 for 2026](https://www.irs.gov/publications/p505) describes these changes.

The existing fee, survivor-budget, longevity, stress/sensitivity, capital-loss-history, Roth-history and eligibility-calendar features remain useful and were not relisted as missing. The review did not certify every state table, every Marketplace record, every estate scenario, or physical iOS/Android browser behavior.

## Verification

See the accompanying delivery record in `docs/RETIREMENT_REVIEW_FIXES.md` for final test counts and browser checks. Phone usability changes add 44px button targets and 16px input text, retain horizontally scrollable data tables, and include a narrow-card policy comparison. Browser evidence was inspected at 320px, 375px and 1440px widths.
