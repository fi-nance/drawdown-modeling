# Known Modeling Limitations

This app is a planning model, not tax advice. It should make assumptions explicit, expose overrides when rules are household-specific, and keep a visible queue of tax-law areas that still need CPA/state-form review before anyone treats results as comprehensive retirement tax projections.

## Assumptions With Explicit Controls

- Roth qualified-distribution status is controlled by `rothFiveYearRuleSatisfied`. When disabled, Roth earnings are taxable even after the penalty-free age; when enabled, post-penalty-age Roth withdrawals are treated as qualified.
- Early retirement-distribution penalty exceptions are controlled by `earlyWithdrawalPenaltyExceptionAmount`. The model consumes that annual exception before applying the configured early-withdrawal penalty rate.
- The penalty-free retirement-distribution age is controlled by `retirementPenaltyAge`; it defaults to 59.5.
- Additional federal deductions and credits can be entered manually for household-specific rules not otherwise modeled.
- Child Tax Credit eligibility can be driven by child ages so children age out year by year.
- ACA premiums can use exact selected-plan inputs, quoted net premiums, manual FPL values, manual member ages, and optional age-rating projection.
- RMD start age, Medicare IRMAA enrollment counts, Medicare Part D premium, and IRMAA lookback MAGI can be overridden.
- State ordinary tax, state capital-gains tax, retirement-income exclusion, and taxable Social Security percentage can be manually overridden when the state rule table is not specific enough.
- Medicare wages, self-employment income, and RRTA compensation can be entered explicitly so Additional Medicare Tax is applied only when the household has income subject to that tax.
- One-off cash flows can be scheduled by year range as expenses, taxable ordinary income, tax-free income, Medicare wages, self-employment income, or RRTA compensation.

## CPA Review Queue

- [Not planning to address]: Itemized deductions are not modeled. SALT caps, mortgage interest, charitable giving, medical itemization, casualty losses, and Pease-style or future limitation rules require manual deduction overrides.
- [Not planning to address]: Refundable and earned-income-linked credits are not fully modeled. The child tax credit is modeled as nonrefundable; Additional Child Tax Credit, EITC, education credits, dependent-care credits, clean-energy credits, and premium-credit reconciliation edge cases need household inputs that are not collected yet.
- [Not planning to address]: AMT, QBI, self-employment tax, household employment tax, and pass-through or business income rules are not modeled.
- [Not planning to address]: Retirement-plan exceptions are simplified to one annual early-withdrawal penalty exception amount. Rule-specific details such as 72(t) SEPP, QDROs, disability, terminal illness, domestic abuse, birth/adoption, qualified disaster, reservist, public safety, medical expense, education, first-home, and unemployed health-insurance exceptions require user-entered exception amounts.
- [Not planning to address]: Roth account tracking is aggregate. The model has a global contribution-basis pool, per-lot conversion year when available, and a global qualified-distribution checkbox; it does not maintain separate Roth IRA versus designated Roth 401(k) five-year clocks or complete Form 8606 ordering history.
- [Not planning to address]: State taxes use a 2026 rule table plus overrides for broad IRA/401(k)-style retirement income and Social Security. Plan-specific public pension, military, railroad, disability, municipal tax, county tax, school-district tax, credit-only, and nonresident/part-year resident rules need state-form-level implementation.
- [Not planning to address]: Inherited IRA and beneficiary RMD rules are not modeled. Eligible designated beneficiary rules, 5-year and 10-year rules, spouse elections, trust beneficiaries, and missed-RMD excise tax handling remain out of scope.
- [Not planning to address]: HSA treatment is simplified. Qualified medical distributions, nonqualified distributions, age-65 penalty changes, contribution eligibility, catch-up contributions, and payroll/FICA distinctions need explicit HSA inputs.
- [Not planning to address]: Wash sales, straddles, collectibles, Section 1256 contracts, foreign tax credit, PFIC treatment, municipal bond interest, bond premium/accrued interest, and qualified small business stock exclusions are not modeled.
- [Not planning to address]: Estate, gift, generation-skipping transfer, charitable remainder trust, donor-advised fund, NUA, annuity, pension survivor benefit, and insurance-product rules are not modeled.
- ACA exact-plan mode still depends on user-provided or API-filled premiums. Rating-area, tobacco, household composition, CSR variant, employer affordability, immigration, Medicaid/CHIP, non-calendar policy year, and state-exchange edge cases require exact marketplace data or additional eligibility engines.

## Implementation Notes

- Prefer adding tax-law features as explicit user inputs with clear defaults rather than hidden assumptions.
- Add year-by-year audit fields and tests for every new tax-law feature so Sankey flows, action rows, and tax tables stay explainable.
- Keep source links in `docs/DATA_SOURCES.md` and verify current-year tax facts from primary government sources when possible.
