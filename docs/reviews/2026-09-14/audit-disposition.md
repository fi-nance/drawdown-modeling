# September 14 CPA / early-retirement audit disposition

Reviewed the supplied 12-finding audit against the working tree on
`initial-submit`, starting from commit `1c7da63`. The audit partly captured an
unfinished implementation. It also contains a substantive 2026-law error and
several recommendations that would introduce new assumptions if applied literally.

## Findings and corrections

| Audit item | Assessment | Correction and verification |
| --- | --- | --- |
| 1. Failing basis rejection test | Accurate for the intermediate tree, stale now. Positive basis is newly supported. | Replaced the obsolete rejection with invalid-basis validation and positive Form 8606 goldens in `tests/ira_csr_owner_regressions.test.mjs`. |
| 2. Designated Roth import without remedy | Missing remedy was accurate during implementation. Applying IRA ordering directly would be wrong. | Holdings now preserve employer subtype and offer **Completed IRA rollover**. Unrolled designated Roth accounts stop before the main worker launches. Added Roth 403(b) aliases and rollover tests. See `iraBasis.mjs`, `importers.mjs`, and `app.mjs`. |
| 3. CSR validation not called | Stale in current work. | All four Silver variants have maximum/expected-cost forms. Validation runs before UI execution and at the engine entry point. Exact 150/200/250% thresholds affect cash costs and conversion/harvesting comparisons. Missing/invalid variants are rejected. |
| 4. NIIT capital-loss deduction | Confirmed. | `computeNiit` now subtracts the allowed current investment loss deduction, including the MFS cap, without deducting the entire carryover. $15,000 interest less $3,000 loss yields $456 NIIT when the MAGI limit does not bind. |
| 5. CTC/ACTC priority | Partly confirmed; not every other credit simply precedes CTC. The audit's two-child example also incorrectly says no unused CTC remains. | Explicit pre-CTC and post-CTC manual credit inputs replace the ambiguous single category. With $3,000 tax, two eligible children, $3,000 verified priority credits and sufficient earnings, ACTC is $3,400. Credit-specific Worksheets A/B, eligibility and carryovers still need a verified input. |
| 6. Allegedly invented QBI minimum | **Incorrect audit assertion.** The 2026 $400 active-QBI minimum is statutory. | Kept the rule; added affirmative material-participation input and tests distinguishing confirmed active QBI ($400) from unconfirmed/passive assumptions ($200 on $1,000 QBI). |
| 7. Estate-tax IRD deduction | Confirmed gap in the simplified bequest estimate. | Estate tax attributable to taxable non-spouse IRD is allocated across income receipts and compared with the heir's standard deduction. Remaining IRA basis is not taxable IRD; state inheritance tax does not qualify. Estate tax itself remains a cash charge. |
| 8. HSA and Treasury state treatment | Confirmed for the modeled income channels. | CA/NJ HSA deduction reversal, employer deposits, annual earnings, realized gains and distribution-income reversal now flow through tax funding. Reinvested basis is preserved. CA losses have a separate owner ledger; NJ has no ordinary loss deduction/carryover. TIPS coupon/OID exemption is automatic; qualifying generic interest requires an explicit fraction. |
| 9. LTC suppressed by all-in budget | Confirmed, including withdrawal reconciliation. | Ordinary medical already included in target spend is separated from additional LTC stress cash. Conversion sizing, withdrawal trials, top-ups, final cash flows and annual reporting all fund the stress. A $100,000 stress reduces a tax-free cash portfolio by $100,000 even with medical included. |
| 10. HSA automatic family coverage | Confirmed flawed inference; the proposed filing-status inference is also invalid. | Contributions now require explicit actual self-only/family qualifying coverage. Non-ACA family coverage receives the family limit. Legacy `auto` requests confirmation. |
| 11. Spouse catch-up starvation | Allocation preference, not inherently a tax defect: a sub-maximum deposit to the primary can be legal and has the same deduction. | Limited funding now prefers eligible owner-specific catch-ups before base contributions, while preserving employer and shared caps. $8,750 with two eligible 55+ owners allocates $7,750/$1,000. |
| 12. Entered spouse SS total | Genuine ambiguity, not evidence that SSA statements always include auxiliary benefits. | The form explicitly requires **own-worker benefit excluding spousal supplement**. Existing component logic adds the independently calculated supplement once. Combined awards must be split from SSA records; they are not safely convertible to a worker PIA from one total. |

## Earlier requested work completed in this batch

- Per-owner nondeductible IRA basis, aggregation across traditional/SEP/SIMPLE IRAs, separate employer/spouse accounts, taxable conversion sizing, RMD/withdrawal basis recovery, clone isolation and survivor pooling.
- Explicit outside-IRA holdings entry, account subtypes and completed-rollover controls, owner basis totals and annual Form 8606-style audit rows.
- User-entered Silver CSR variants with eligibility checks and income-sensitive expected out-of-pocket costs in annual and lifetime policy comparisons.
- Owner capital-loss survival, dated Roth qualification clocks, separate worker/spousal earnings-test adjustment formulas, employer HSA deposits and employment end years.

## Additional browser-discovered correction

A fixed $40,000 budget inherited an inactive $60,000 guardrail essential-spending
default during decision-profile normalization, creating a false required-spending
shortfall despite fully funded cash flows. The automatic split now follows the
active fixed budget. Explicitly entered higher required spending and explicitly
zero flexible spending remain authoritative. Regression tests cover both cases,
and the results cache version was advanced so old verdicts are not reused.

## Sources and scope

The NIIT correction follows [Form 8960](https://www.irs.gov/instructions/i8960).
Credit priority follows [Schedule 8812 Worksheets A/B](https://www.irs.gov/instructions/i1040s8),
not a universal ordering of every Schedule 3 credit. The QBI audit rebuttal is
supported by [2026 Publication 505](https://www.irs.gov/pub/irs-prior/p505--2026.pdf).
The IRD deduction follows [Publication 559](https://www.irs.gov/publications/p559).
State adjustments follow [California Schedule CA](https://www.ftb.ca.gov/forms/2025/2025-540-ca-instructions.html),
[NJ deduction guidance](https://www.nj.gov/treasury/taxation/njit13.shtml) and the
[NJ legislative explanation of existing HSA nonconformity](https://pub.njleg.state.nj.us/Bills/2024/A1500/1311_I1.HTM).
TIPS interest treatment follows [TreasuryDirect](https://www.treasurydirect.gov/marketable-securities/tips/).
HSA eligibility and separate owner catch-ups follow [Publication 969](https://www.irs.gov/publications/p969).

This is a planning model, not certification of a tax return or a globally optimal
withdrawal schedule. Confirm IRA records and all outside balances, plan access,
CSR enrollment/expected costs, HDHP months, HSA security basis, credit priority,
QBI activity and estate/heir assumptions with the appropriate professionals.
Annual timing, state-return differences, SSA award details and the simplified
bequest schedule remain material limitations. Optional full filing engines and
the older review's gross-charitable-deduction/basis-provenance extensions are not
silently claimed as complete.

## Reproduction

Run `node --test tests/ira_csr_owner_regressions.test.mjs tests/pasted_audit_regressions.test.mjs`
for the new financial examples, and `npm test` for the complete regression suite.
See `docs/RETIREMENT_REVIEW_FIXES.md` for final verification results.
