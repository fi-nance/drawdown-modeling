# September 2026 retirement review fixes

Requested delivery order: Roth, Social Security claiming, submit to `initial-submit`; then the remaining review findings and must-add features, submit again.

## First submission (verified, ready to submit)

- F2: per-owner Roth contribution and conversion ledger, statutory distribution ordering, portfolio clone/reconciliation and ladder integration, opening history inputs and audit export.
- F1: lock existing Social Security awards and restrict claiming candidates to feasible prospective ages for each person; validate contradictory setup inputs.

Validation: 717 tests passed, no failures or skipped tests; desktop and 375px phone setup controls inspected, no browser console errors. Independent coverage review findings were corrected before submission.

## Second submission (pending)

- F3/F4: Kansas, Michigan, New Jersey rule corrections; per-owner state retirement income eligibility/caps and table audit.
- F5–F8: ACA MFS/coverage eligibility and mixed Medicare households; separate Medicare costs from IRMAA; retain lookback filing status.
- F9/F10: passive-rent NIIT and preferential-tax ordinary-rate ceiling.
- M1: Social Security earnings test and explicit first-year/FRA treatment.
- M2/M3: HSA qualified-expense history and owner contributions; explicit member coverage eligibility calendar.
- M4–M6: opening capital-loss history and unsupported traditional basis detection; fee cash flows; survivor budgets and longevity stress.

The original review and defect reproductions are archived under `docs/reviews/2026-09-09/`; their assertions intentionally describe the pre-fix commit. Current behavior is verified by the regression suite.
