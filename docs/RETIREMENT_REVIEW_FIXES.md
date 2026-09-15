# September 2026 retirement review fixes

Requested delivery order: Roth, Social Security claiming, submit to `initial-submit`; then the remaining review findings and must-add features, submit again.

## First submission (submitted as `36903a4`)

- F2: per-owner Roth contribution and conversion ledger, statutory distribution ordering, portfolio clone/reconciliation and ladder integration, opening history inputs and audit export.
- F1: lock existing Social Security awards and restrict claiming candidates to feasible prospective ages for each person; validate contradictory setup inputs.

Validation: 717 tests passed, no failures or skipped tests; desktop and 375px phone setup controls inspected, no browser console errors. Independent coverage review findings were corrected before submission.

## Second batch

- F3/F4: Kansas, Michigan, New Jersey rule corrections; retirement-income ownership through final taxes and optimizer candidates. Additional Wisconsin, Missouri, South Carolina, Louisiana and Maine corrections; unsupported generic Maryland pension exclusion removed. State-form review flags disclose remaining state table scope.
- F5–F8: ACA MFS/coverage eligibility and mixed Medicare households; separate Medicare costs from IRMAA; retain lookback filing status.
- F9/F10: passive-rent NIIT and preferential-tax ordinary-rate ceiling.
- M1: Social Security earnings test and explicit first-year/FRA treatment.
- M2/M3: HSA qualified-expense history and owner contributions; explicit member coverage eligibility calendar.
- M4–M6: opening capital-loss history and unsupported traditional basis detection; fee cash flows; survivor budgets and longevity stress.

Validation: 749 tests passed, zero failures or skipped tests. Golden cases cover each original finding and the new earnings-test,
receipt, coverage, opening-loss, fee, survivor-budget and longevity paths.
A browser comparison completed four cases with 1,000 Monte Carlo paths each;
desktop and 375px setup controls were inspected without console errors or
horizontal overflow. See KNOWN_LIMITATIONS for conservative mixed-age HSA,
state-exclusion, auxiliary-benefit and annual timing assumptions.

The original review and defect reproductions are archived under `docs/reviews/2026-09-09/`; their assertions intentionally describe the pre-fix commit. Current behavior is verified by the regression suite.

## September 11 follow-up submission

- Added complete-plan gain-harvesting policy comparisons, including 400% FPL ceilings and front-loaded harvesting. The ranking includes future basis, actual tax and medical cash funding, usable spending and after-tax ending wealth. Annual reconciliation reduces optional harvesting when its funding sales would exceed the buffered MAGI ceiling.
- Added the policy comparison to the action card and audit export. Monte Carlo and historical paths test the policy selected from expected returns, without knowing future sampled returns. Manual controls remain authoritative.
- Fixed broker total-basis imports, the shared family HSA cap with both employers, and preservation of a surviving worker's own Social Security earnings-test credits. TIPS replenishment gains no longer appear as optional gain harvesting.
- Improved phone controls with 44px button targets and 16px input text. The policy table fits all three columns at 320px and 375px.

Validation: **762 tests passed**, zero failures or skipped tests (`npm test`, approximately 42 seconds). Syntax checks and `git diff --check` passed. The saved financial reproduction JSON reports safe results for all four observations (HSA, import, and both survivor orders).

Chromium checks covered onboarding, workspace and results at 320px/375px phone widths and results at 1440px desktop width. A representative eight-year plan completed 100 Monte Carlo runs and 91 historical paths. Year navigation changed the displayed year; all visible phone buttons/summaries measured at least 44px high; phone fields measured 16px. No page-level horizontal overflow or browser console errors were observed. The expanded harvesting comparison measured 262px/317px including all columns on the two phone widths. These are viewport checks, not physical iOS/Android certification.

The full findings, sources, synthetic multi-year PTC regression and remaining household-specific feature priorities are in [the September 11 review](reviews/2026-09-11/review.md). This submission does not claim a globally optimal tax schedule or automatic CSR variant repricing.

## September 14 IRA, CSR and CPA audit batch

- Added per-owner Form 8606-style IRA basis aggregation, taxable/nontaxable conversions and distributions, separate employer-plan subtypes, explicit completed rollovers, outside-IRA entry forms and annual basis audit rows.
- Added confirmed-Silver CSR variant inputs, exact income-band selection, expected out-of-pocket costs in withdrawal/conversion/harvesting comparisons, validation and persistence.
- Corrected NIIT capital-loss deductions, manual credit priority before/after CTC, LTC cash funding with all-in budgets, and estate-tax IRD deduction treatment. Retained the valid 2026 QBI minimum and added material-participation confirmation.
- Added CA/NJ HSA investment/contribution/distribution adjustments, Treasury interest exemptions, separate California loss history, owner carryforward survival, employer HSA deposits and catch-up allocation. Corrected Roth qualification clocks, employment end years and separate worker/spousal earnings-test adjustments.
- Clarified spouse SS own-worker inputs and unsupported plan-access assumptions. Corrected a browser-discovered fixed-budget verdict bug caused by inactive guardrail defaults; explicit required-spending choices remain authoritative.

All 12 supplied audit findings have an evidence-based disposition in the
[September 14 audit report](reviews/2026-09-14/audit-disposition.md). Several were
stale or partly incorrect; their proposed changes were not applied blindly.

Verification: **805 tests passed**, zero failures, skips or cancellations, both
normally and under `npm run test:coverage`. This is 43 more tests than the 762-test
starting revision. Reported whole-suite coverage is **85.65% lines, 76.93%
branches and 68.28% functions**; the four new financial helper modules each have
100% line coverage. Coverage is not proof of filing-grade correctness, and the
browser-only application remains less automated than the core engine.

Chromium verification covered IRA entry, CSR forms, save/refresh persistence of
basis, credits, QBI confirmation, California loss history and security interest
exemption inputs. The synthetic three-year run completed 10 Monte Carlo paths,
96 historical paths and rescue comparisons. Its $40,000 required floor was fully
funded, with the limited-lifetime-horizon warning preserved. IRA/CSR forms and
results were visually inspected at 1440px desktop and 390px phone widths, with
no page-level horizontal overflow or console errors. These are browser viewport
checks, not physical-device certification or statistical confidence estimates.

JavaScript syntax checks and `git diff --check` passed. Financial source links,
annual timing assumptions and remaining professional-review requirements are in
`DATA_SOURCES.md`, `KNOWN_LIMITATIONS.md` and the audit disposition. No full tax
return, estate administration or globally optimal withdrawal schedule is claimed.
