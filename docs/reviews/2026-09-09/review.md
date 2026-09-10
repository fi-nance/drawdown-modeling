# Retirement modeling review — September 9, 2026

Reviewed commit: `1a9007a323d14815483fa130f6410c2eb6922db2`.

The model still has material correctness gaps. The most consequential reproduced case turns a failing plan into a successful rescue by rewriting a Social Security election made thirteen years earlier. Roth withdrawal tax character, state retirement exclusions, and healthcare transitions also need corrections before their affected recommendations are dependable.

This review examines the current implementation through tax-accounting, financial-planning, and early-retirement execution concerns. It does not merely re-review the last diff. The previous audit's completed fixes are not being counted again. Application code was not changed.

Validation: `npm test` passed **698 tests, 0 failures, 0 skipped**, in 36.4 seconds. Additional deterministic reproductions are in [reproduce.mjs](/Users/tom/Code/drawdown-modeling/docs/reviews/2026-09-09/reproduce.mjs); captured results are in [observed.json](/Users/tom/Code/drawdown-modeling/docs/reviews/2026-09-09/observed.json). Run `node docs/reviews/2026-09-09/reproduce.mjs` from the project root. Its assertions document observed defects, not desired behavior; they should cease passing as the defects are fixed. The one-run, zero-volatility solver example isolates a logic error and is not a statistical estimate of retirement risk.

**Priority definitions:** P1 means fix before relying on affected planning recommendations. P2 means a narrower correctness or planning-completeness issue. Confidence describes evidence for the finding, not certainty about an individual's finances.

## Newly reproduced correctness issues

### F1 — P1, confidence 10/10: Social Security rescue rewrites past elections

[decisionEngine.mjs:1415](/Users/tom/Code/drawdown-modeling/src/core/decisionEngine.mjs:1415) unconditionally searches `const ages = [62, 65, 67, 70];`. At [line 1446](/Users/tom/Code/drawdown-modeling/src/core/decisionEngine.mjs:1446), it rescales the entered benefit to each candidate without checking whether that election is still available.

**Reproduction:** A 75-year-old receiving $24,000 annually since claiming at 62, with $100,000 in cash and $40,000 spending, has 0% modeled success over the test's ten years. The solver recommends claiming at 70, raises the annual benefit to **$42,240**, and reports **100% success / target-met**. It neither accounts for the historical election nor models a permitted change in benefits.

**Fix:** Track each person's actual claim status/date and distinguish an existing award from a prospective estimate. Lock historical elections. Restrict unclaimed candidates to future feasible dates; model permitted withdrawal/suspension separately if supported. Acceptance must include already-claimed ages below FRA, between FRA and 70, and above 70, for either spouse. SSA limits withdrawal of a claim to a qualifying early window and suspension to the period from FRA until 70. [SSA withdrawal rules](https://www.ssa.gov/faqs/en/questions/KA-01993.html), [SSA suspension rules](https://www.ssa.gov/benefits/retirement/planner/suspend.html).

### F2 — P1, confidence 10/10: Roth conversion principal is treated as security-lot basis

[withdrawalExecution.mjs:319](/Users/tom/Code/drawdown-modeling/src/core/simulation/withdrawalExecution.mjs:319) uses `Math.min(remaining, sale.costBasisSold ?? remaining)` to identify distributed conversion principal. [portfolio.mjs:85](/Users/tom/Code/drawdown-modeling/src/core/portfolio.mjs:85) computes `costBasisSold` proportionally from the securities sold. That is not Roth IRA distribution ordering.

**Reproduction:** A 50-year-old has a single $100,000 conversion from 2020 now worth $120,000, no regular-contribution basis, and no prior distributions. Withdrawing $60,000 in 2026 produces **$10,000 ordinary income plus a $1,000 penalty**. The withdrawal is entirely within seasoned conversion principal and should produce neither in this example.

**Fix:** Maintain contribution basis and conversion amounts/year by taxpayer independently of asset lots. Consume regular contributions, then conversions in statutory order, then earnings. Buying, selling, rebalancing, and investment growth inside the IRA must not redefine this ledger. Test partial withdrawals after appreciation, multiple conversion vintages, losses, and subsequent-year balances. The documented aggregate-account limitation does not make this simple single-owner conversion example correct. [IRS Publication 590-B, Roth distribution ordering](https://www.irs.gov/publications/p590b).

### F3 — P1, confidence 9/10: Several default state retirement rules contradict current state guidance

The retirement table's approximation warning is appropriate, but the following are demonstrable rule errors in ordinary supported scenarios:

| State / source location | Reproduced result | Required treatment |
| --- | --- | --- |
| Kansas, [line 100](/Users/tom/Code/drawdown-modeling/src/data/stateRetirementTax2026.mjs:100): `type: "thresholdRate"`, $75,000 threshold | At $100,000 income, excludes $0 of $30,000 federally taxable Social Security. | Kansas has exempted federally included Social Security without that income cap for tax years after 2023. [Kansas revenue guidance](https://www.ksrevenue.gov/faqs-taxii.html). |
| New Jersey, [line 167](/Users/tom/Code/drawdown-modeling/src/data/stateRetirementTax2026.mjs:167): `type: "fixedWithIncomeLimit"` | An eligible MFJ couple with $120,000 of qualifying private pension income and no other income receives a $100,000 exclusion. | The applicable pension exclusion is 50% of that pension, **$60,000**, in this income band. Higher income bands have different percentages. [New Jersey exclusion schedule](https://www.nj.gov/treasury/taxation/njit7.shtml). |
| Michigan, [line 134](/Users/tom/Code/drawdown-modeling/src/data/stateRetirementTax2026.mjs:134): `retirementIncome: { type: "all", minAge: 59.5 }` | Excludes all $300,000 of a 65-year-old single taxpayer's private retirement income. | The 2026 phase-in remains subject to the applicable inflation-adjusted retirement maximum; it is not an unlimited private-retirement exclusion. Exact cap/cohort/source treatment needs a versioned rule. [Michigan RAB 2026-1](https://www.michigan.gov/taxes/rep-legal/rab/2026-revenue-administrative-bulletins/revenue-administrative-bulletin-2026-1). |

**Fix:** Correct these rows with primary-source golden cases and audit the remaining retirement table state by state. Test threshold boundaries and distinguish private pensions, IRAs, conversions, and public-plan exceptions where required. Do not describe the unexamined states as verified because these examples were checked. These errors can distort Roth conversion amounts as well as annual state tax.

### F4 — P1, confidence 10/10: State retirement exclusions lose the income owner's identity

[stateRetirementTax2026.mjs:355](/Users/tom/Code/drawdown-modeling/src/data/stateRetirementTax2026.mjs:355) returns a single `amountForStatus(config, filingStatus)` for a fixed exclusion. [Line 384](/Users/tom/Code/drawdown-modeling/src/data/stateRetirementTax2026.mjs:384) determines age eligibility with an OR across both spouses. The tax input receives household retirement income rather than each person's eligible income.

**Reproduction:** Two New York spouses, both 60, each receive $30,000 of qualifying private pension income. The full simulation excludes **$20,000 total instead of $40,000**. Conversely, checking whether either spouse meets the age test can incorrectly qualify income belonging to the younger spouse.

**Fix:** Thread income by owner and type into state calculations. Apply each state's individual or joint eligibility/cap rules before summing. Do not fix this by simply doubling every married exclusion: unused individual exclusions cannot necessarily transfer between spouses. Test both earners, one earner, and mixed-age couples. [New York retirement guidance](https://www.tax.ny.gov/pit/file/information_for_seniors.htm).

### F5 — P1, confidence 10/10: Married-filing-separately households receive ACA subsidies by default

[aca.mjs:132](/Users/tom/Code/drawdown-modeling/src/core/aca.mjs:132) determines eligibility only from FPL bounds: `const eligible = fplPercent >= minEligibleFplPercent && fplPercent <= maxEligibleFplPercent;`. The wrapper receives filing status but [does not pass an eligibility constraint](/Users/tom/Code/drawdown-modeling/src/core/simulation/medical.mjs:31).

**Reproduction:** A married-filing-separately household, ages 55, $40,000 MAGI, and $20,000 annual benchmark/plan premiums receives **$17,569.66 of premium tax credit**. Without a qualifying exception, the credit should be zero.

**Fix:** Separate coverage from subsidy eligibility. Keep full-price coverage available while disabling PTC for ordinary MFS cases. Add explicit supported exception facts rather than treating every MFS household as eligible. Use the same eligibility state in conversions, withdrawal candidates, and displayed healthcare costs. [IRS premium tax credit eligibility](https://www.irs.gov/affordable-care-act/individuals-and-families/questions-and-answers-on-the-premium-tax-credit).

### F6 — P1, confidence 10/10: Parents reaching Medicare age can erase a dependent's ACA coverage

[medical.mjs:12](/Users/tom/Code/drawdown-modeling/src/core/simulation/medical.mjs:12) defines `both65Plus` using only the primary and spouse. [Line 18](/Users/tom/Code/drawdown-modeling/src/core/simulation/medical.mjs:18) then disables the entire ACA configuration, before inspecting the configured covered-member ages.

**Reproduction:** Both parents are 65, a dependent student is 20 and is the sole Marketplace enrollee, annual plan premium is $6,000, and household MAGI is above the subsidy ceiling. The engine returns **$0 gross premium** and marks the whole household Medicare-eligible.

**Fix:** Determine coverage per enrolled member. A parent's Medicare transition must leave eligible dependents' premiums and cost-sharing in the plan and retain their tax-household treatment. Include mixed Medicare/Marketplace OOP expenses concurrently. Test one young dependent, multiple dependents, and both possible parent transition orders. [HealthCare.gov household and coverage rules](https://www.healthcare.gov/income-and-household-information/household-size/).

### F7 — P1, confidence 10/10: Turning off IRMAA also removes ordinary Medicare premiums

[medical.mjs:110](/Users/tom/Code/drawdown-modeling/src/core/simulation/medical.mjs:110) returns `emptyMedicareCost()` whenever `medicare.irmaaEnabled === false`. The user-facing checkbox says [“Apply Medicare / IRMAA surcharges”](/Users/tom/Code/drawdown-modeling/index.html:497).

**Reproduction:** One 65-year-old with $30/month Part D, $150/month Medigap, and no income surcharge costs **$4,594.80 annually** with the checkbox on and **$0** with it off. This removes the standard Part B premium and explicitly entered premiums even though no surcharge was due in either case.

**Fix:** Separate Medicare enrollment/premium inclusion from income-surcharge modeling. Turning off IRMAA should zero only the adjustments. If a household separately pays premiums from an entered budget, offer a distinct, accurately labeled cost-inclusion control. Preserve explicit premiums in the acceptance test. [CMS 2026 Part B premium](https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles).

### F8 — P1, confidence 9/10: Survivor IRMAA combines old joint income with current single brackets

[plan.mjs:243](/Users/tom/Code/drawdown-modeling/src/core/simulation/plan.mjs:243) stores only `result.irmaaMagi` in history. [medical.mjs:120](/Users/tom/Code/drawdown-modeling/src/core/simulation/medical.mjs:120) selects a bracket using `magi: lookbackMagi` and the current `filingStatus`.

**Reproduction:** The couple has $200,000 joint MAGI in 2026; one spouse dies that year. In 2028, the surviving spouse has no current taxable income. With zero inflation in the test, the engine applies single brackets to the old joint $200,000 and creates monthly surcharges of **$324.60 Part B + $60.40 Part D**, or **$4,620 annually**. That joint return falls below the model's joint IRMAA threshold.

**Fix:** Store `{taxYear, magi, filingStatus, mfsLivedTogether}` together and use one consistent historical return for both income and thresholds. Collect filing status with the two prior-income inputs. Model an SSA-44 redetermination as an explicit alternative using matching income/status from the selected replacement year; do not silently mix tax years. [SSA tax-return lookback](https://www.ssa.gov/OP_Home/handbook/handbook.25/handbook-2504.html), [SSA-44 income and filing-status requirements](https://www.ssa.gov/forms/ssa-44.pdf).

### F9 — P2, confidence 10/10: Passive rental income bypasses NIIT

[yearEngine.mjs:150](/Users/tom/Code/drawdown-modeling/src/core/simulation/yearEngine.mjs:150) includes recurring rent in ordinary income, but [line 156](/Users/tom/Code/drawdown-modeling/src/core/simulation/yearEngine.mjs:156) restricts `ordinaryInvestmentIncome` to dividends and TIPS income. Recurring streams have no NIIT classification.

**Reproduction:** An MFJ household with $250,000 qualifying pension income and $50,000 net passive rent has $300,000 AGI but **$0 NIIT**, instead of **$1,900**, assuming no allocable deductions or qualifying nonpassive-business exception.

**Fix:** Carry investment-income tax character through recurring streams. Support net passive rental income and an explicit, substantiated exception classification; do not tax ordinary qualified-plan pensions as investment income. Test below, at, and above NIIT thresholds. [IRS NIIT rules](https://www.irs.gov/taxtopics/tc559).

## Must-add capabilities and known unresolved gaps

These are implementation priorities, not claims that every household needs every feature enabled.

1. **P1 for early-claim/work scenarios: Social Security earnings-test integration.** [socialSecurity.mjs:122](/Users/tom/Code/drawdown-modeling/src/core/simulation/socialSecurity.mjs:122) returns the entered benefit regardless of current earnings. A 62-year-old with $60,000 full-year wages and $24,000 benefits receives all $24,000 in the model. The ordinary 2026 annual earnings test implies $17,760 withheld and $6,240 payable in the test scenario. Add per-person earnings limits, FRA-year treatment, later benefit adjustments, and an explicit first-year monthly-rule path. Feed this into bridge-income and claiming rescues. This was already disclosed as unmodeled, but it is essential when the product recommends working while claiming. [SSA earnings test](https://www.ssa.gov/OACT/COLA/rtea.html), [SSA special first-year rule](https://www.ssa.gov/benefits/retirement/planner/rule.html).

2. **P1 for HSA-funded plans: A qualified-expense ledger.** The previous audit added warnings, not expense classification. [hsa.mjs:90](/Users/tom/Code/drawdown-modeling/src/core/simulation/hsa.mjs:90) adds all `medicalEstimate` to reimbursable expenses; [yearEngine.mjs:1024](/Users/tom/Code/drawdown-modeling/src/core/simulation/yearEngine.mjs:1024) carries that pool forward. The reproduction finances **$12,000 of ordinary ACA insurance premiums tax-free from an HSA** at age 50 with no qualifying insurance exception. Separate eligible OOP, eligible insurance exceptions, nonqualified ACA/Medigap premiums, prior receipts, reimbursements, and deductions already taken. Track eligibility and catch-up contributions by owner. A generic “medical” expense input cannot establish HSA tax-free eligibility. [IRS Publication 969](https://www.irs.gov/publications/p969).

3. **P1 for ACA-dependent rescues: An explicit coverage-eligibility calendar.** F5/F6 are immediate bugs, but income below 400% FPL is not enough to establish PTC eligibility. Employer coverage, Medicaid/CHIP eligibility, dependent status, and coverage months must be represented before recommending a precise subsidized spending/conversion target. Start with explicit per-member eligibility inputs and conservative handling of unknown facts, then add rule automation. Pair each member's Medicare and Marketplace expenses during transition years. The current annual FPL-only predicate is quoted in F5. [IRS eligibility requirements](https://www.irs.gov/affordable-care-act/individuals-and-families/questions-and-answers-on-the-premium-tax-credit).

4. **P2, necessary for households bringing tax history: Opening tax balances.** [plan.mjs:37](/Users/tom/Code/drawdown-modeling/src/core/simulation/plan.mjs:37) always initializes `lossCarryforward = { shortTerm: 0, longTerm: 0 };`; the UI exposes results but has no opening-loss input. Add separate prior-year short/long capital-loss carryforwards to setup, validation, audit export and simulation initialization. Pair this with the owner-specific Roth ledger from F2 and explicit handling or rejection of nondeductible traditional IRA basis; [withdrawalExecution.mjs:273](/Users/tom/Code/drawdown-modeling/src/core/simulation/withdrawalExecution.mjs:273) currently treats all traditional proceeds as taxable. The application should be able to start from a household's actual tax position. [IRS IRA distribution and basis rules](https://www.irs.gov/publications/p590b), [IRS capital-loss carryovers](https://www.irs.gov/taxtopics/tc409).

5. **P2, financial-planning baseline: Explicit fee treatment.** The return pipeline reads configured means or supplied historical returns directly ([market.mjs:20](/Users/tom/Code/drawdown-modeling/src/core/simulation/market.mjs:20)); there is no recurring AUM-fee cash flow. Add account/advisory fees and a clear choice stating whether investment returns already include fund expenses, so fees are not omitted or counted twice. Apply the same convention to Monte Carlo and historical tests. A 1% fee on $2 million is $20,000 in the first year before compounding effects, large enough to change a retirement verdict. [SEC fee guidance](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins/updated).

6. **P2 for couples: Survivor budgets and a direct longevity stress.** The required-spending formula ([spending.mjs:184](/Users/tom/Code/drawdown-modeling/src/core/simulation/spending.mjs:184)) has no survivor-budget transition. Add separate required/flexible survivor budgets for either death order, while retaining the unchanged budget as the conservative default. Add a one-action rerun with each life extended independently and jointly. Keep housing, care costs and tax/healthcare costs distinct so the model does not assume a survivor's expenses simply halve. This is planning judgment about making the existing joint-life engine usable, not a claim that the current unchanged-spending default is a mathematical bug.

The prior limitations document explicitly defers several broader capabilities, including detailed 72(t)/Rule-of-55 exceptions, full AMT, cross-state moves, and complex estate transfers. This review does not silently reverse those scope decisions. For users needing them, the minimum acceptable behavior is a clear unsupported-scenario result; a complete specialist engine becomes necessary only if the product promises executable recommendations for those scenarios.

## Smaller tax correctness item

**P2, confidence 9/10:** [tax.mjs:277](/Users/tom/Code/drawdown-modeling/src/core/tax.mjs:277) sets federal income tax to ordinary tax plus preferential tax without the Qualified Dividends and Capital Gain Tax Worksheet's final comparison against tax on all taxable income at ordinary rates. In the model's continuous-bracket approximation, a 2026 single filer with $66,000 ordinary income and $100 qualified dividends gets $5,755, while the all-ordinary alternative is $5,752. Add the minimum comparison and reconcile component reporting. These numbers demonstrate the model's bracket calculation; exact IRS tax-table rounding is a separate filing-calculator issue. [IRS worksheet, line 25](https://www.irs.gov/instructions/i1040gi).

## Recommended order and review limits

First repair **F1/F2** because they can invent a rescue or misclassify the core early-retirement funding source. Next repair **F3–F8**, then the missing earnings-test/HSA/eligibility paths. Correct NIIT, initialize actual tax history, and add fee/survivor planning inputs before expanding optimizer sophistication.

For each fix, use the reproduced input as an independent expected-result regression, then verify taxes, MAGI, cash flow, ending balances, and the final rescue recommendation together. A changed tax number alone is insufficient if the recommendation still uses the old assumption.

This was a source-and-calculation review with current primary-source checks and a full existing test-suite run. It was not an exhaustive audit of every state table, every generated Marketplace/geographic record, all historical return series, or live browser workflows. Known limitations, passing tests and confidence badges are useful disclosures; none correct the demonstrated numerical or eligibility errors.
