# Retirement Audit Fixes

Implementation date: September 8, 2026. Baseline commit: `40eb0a29e6ba9349ac4cb4917c61fac624d69fa8`.

The eleven reproduced findings from the retirement review and the finite-horizon safeguard (C1) are corrected within the application's stated planning scope. The changes do not constitute financial certification or implement every optional capability in the review.

## Completed Work

| Finding | Correction | Main implementation | Regression coverage |
| --- | --- | --- | --- |
| F1 | Preserve the household's required floor across rescues; distinguish portfolio survival from required-spending success; show realized real-dollar spending and shortfalls. | `spending.mjs`, `yearEngine.mjs`, `plan.mjs`, `decisionEngine.mjs`, `redesign.mjs` | Audit F1 cases; rescue display tests; rerunning every finalized rescue reproduces spending and after-tax summaries. |
| F2 | Blank, null and omitted pension end ages mean for life; invalid age ranges are rejected. | `incomeStreams.mjs`, `planningInputValidation.mjs`, `app.mjs` | Audit F2; saved setup tests; browser form, survivor pension and restore flow. |
| F3 | Preserve account owner, beneficiary identity and Roth conversion history through rebalancing, asset location, TIPS transactions and imports. Coupon earnings remain distinct from conversion principal. | `portfolio.mjs`, `allocation.mjs`, `assetLocation.mjs`, `tipsLadder.mjs`, `importers.mjs` | Spouse RMD, ownership, beneficiary, conversion-clock and CSV cases. |
| F4 | Distinguish missing OOP estimates from explicit zero; use Marketplace defaults only for Marketplace coverage and warn on missing Medicare OOP. | `medical.mjs`, `confidence.mjs` | Null/blank/zero and ACA-disabled Medicare cases; existing mixed-age coverage tests. |
| F5 | Calculate aged-survivor benefits separately, using survivor eligibility/claim age and the deceased worker's record at death. | `socialSecurity.mjs`, `yearEngine.mjs`, survivor controls | Both death orders, death before claiming, age-60 reduction, deferral, own-benefit switching and SSA worked examples. |
| F6 | Preserve after-tax heir metrics through summaries/refinement/cache; label four tested alternatives honestly and use realized spending. | `decisionEngine.mjs`, `resultsCache.mjs`, `redesign.mjs` | Audit F6; browser checks that every displayed comparison uses its after-tax source. |
| F7 | Treat positive taxable cash returns as ordinary interest even with missing or zero dividend yield. | `portfolio.mjs` | Imported cash and integrated AGI/tax cases; updated ladder income expectations. |
| F8 | Reject ambiguous non-Roth after-tax retirement imports instead of silently treating them as Roth. | `importers.mjs` | JSON/CSV alias tests; explicit designated Roth remains supported. |
| F9 | Preserve the capital-loss deduction when qualified dividends are the only positive income; share AGI computation with healthcare calculations. | `tax.mjs`, `income.mjs` | Dividend-only AGI, tax and carryover regression; existing golden tax suite. |
| F10 | Use decedent-state nexus, normalize state names/codes, and apply Nebraska's fixed per-beneficiary exemption and minor exemption. | `heirEstate.mjs`, `importers.mjs`, removed misleading heir-residence control | PA/NE nexus, $100,000 threshold, under-22 exemption, multiple lots/heirs and conflicting metadata. |
| F11 | Use birth-cohort FRA and distinct worker/spousal reductions; share claiming factors with the optimizer. | `socialSecurity.mjs`, `decisionEngine.mjs` | Cohort boundaries, spousal age-62 reduction, delayed credits and optimizer consistency. |
| C1 | Identify projections ending before the last configured death, disclose missing years and scope the verdict title. | `household.mjs`, `confidence.mjs`, `redesign.mjs` | Inclusive death-year boundary, younger spouse, missing spouse and short-horizon UI cases. |

Implementation modules above live under `src/core/` or `src/core/simulation/` unless specified. Dedicated regressions are in [retirementAuditRegression.test.mjs](../tests/retirementAuditRegression.test.mjs) and [golden_ss_claiming.test.mjs](../tests/golden_ss_claiming.test.mjs).

Additional safeguards flag HSA expense-qualification assumptions and unsupported non-spouse first-death/contingent-beneficiary transitions. Affected beneficiary scenarios receive out-of-model rescue badges. Audit exports retain the new metrics, scope and model version. The versioned result-cache key invalidates old recommendations without deleting saved household inputs. Rerun saved plans: corrections can raise or lower projected success, taxes and spending.

## Verification

- Final automated acceptance: `npm test` passed **698 tests, 0 failed, 0 skipped** (35.8 seconds), covering the full suite plus the new audit regressions. The baseline had 654 tests.
- All 120 repository JavaScript/MJS files pass `node --check`; both JSON files parse; `git diff --check` passes.
- Integrated adverse-path tests cover early/late return shocks, prolonged low returns, persistent inflation, late-life care expenses, pension survivor income, both death transitions and cash/shortfall reconciliation.
- Isolated Chrome/Playwright checks cover desktop (1440 x 1000), mobile (390 x 844), actual input validation, pension cash flow, survivor benefits, after-tax comparison sources, required-spending labels, horizon warnings and saved-control restoration. No JavaScript errors; no whole-page horizontal overflow. The guardrail table scrolls within its container on mobile.
- Rules and worked examples were checked against primary SSA, IRS and state sources listed in [DATA_SOURCES.md](DATA_SOURCES.md). No independent professional sign-off, exhaustive production/network QA or row-by-row audit of generated marketplace/geographic tables was performed.

## Reliability And Remaining Priorities

The repaired model supports bounded, reproducible planning comparisons with verified household inputs. Passing tests establish the covered calculations and workflows, not a guarantee of household retirement security or global optimization. Do not treat a limited-horizon result, unsupported transfer, or unverified healthcare assumption as an executable lifetime plan.

1. Before relying on affected recommendations, obtain professional confirmation of account tax character/basis, HSA expense eligibility, first-/second-death estate transfers and contingent heirs. Warnings now expose these scope limits; a complete account/beneficiary lifecycle and per-category HSA qualification remain unimplemented.
2. Confirm actual SSA records, claim history and marriage eligibility. Birth years are inferred from annual ages; monthly timing, disability/caregiver/remarriage/divorced-spouse cases and reverse-record living-spouse top-ups are outside the supported approximation.
3. Confirm survivor budgets, Medicare/OOP inputs, care-cost stresses and longevity assumptions. Required spending does not automatically shrink at first death; choose a defensible household budget and stress longer lives. Mixed-age household non-premium medical costs still require careful manual budgeting.
4. Confirm return assumptions net of applicable fees and use alternate seeds, market paths and inflation assumptions. A first-class recurring AUM-fee model, calibrated actuarial mortality, formal holdout uncertainty estimates and a globally solved withdrawal frontier remain separate enhancements, not proven capabilities.
5. Recheck tax law and actual decedent/property nexus before use. Detailed state/local forms, multistate situs, complex trusts, beneficiary-specific income-tax histories and filing-grade retirement exceptions remain subject to CPA/estate review.

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for the full supported-scope contract. No commit, push, deployment, dependency upgrade or professional approval is implied by this implementation record.
