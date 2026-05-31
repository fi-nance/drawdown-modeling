# Known Modeling Limitations

This app is a planning model, not tax advice. It should make assumptions explicit, expose overrides when rules are household-specific, and keep a visible queue of tax-law areas that still need CPA/state-form review before anyone treats results as comprehensive retirement tax projections.

## Assumptions With Explicit Controls

- Decision verdicts default to a 90% success target, which can be overridden in the Basics module before running results.
- The decision engine separates required and flexible spending. Blank decision spend fields intentionally fall back to the strategy module's essential/discretionary spending split.
- Roth qualified-distribution status is controlled by `rothFiveYearRuleSatisfied`. When disabled, Roth earnings are taxable even after the penalty-free age; when enabled, post-penalty-age Roth withdrawals are treated as qualified.
- Early retirement-distribution penalty exceptions are controlled by `earlyWithdrawalPenaltyExceptionAmount`. The model consumes that annual exception before applying the configured early-withdrawal penalty rate.
- The penalty-free retirement-distribution age is controlled by `retirementPenaltyAge`; it defaults to 59.5.
- Additional federal deductions and credits can be entered manually for household-specific rules not otherwise modeled.
- Child Tax Credit eligibility can be driven by child ages so children age out year by year.
- ACA premiums can use exact selected-plan inputs, quoted net premiums, manual FPL values, manual member ages, and optional age-rating projection.
- RMD start age, Medicare IRMAA enrollment counts, Medicare Part D premium, and IRMAA lookback MAGI can be overridden.
- After-tax bequest estimates use an entered heir ordinary tax rate for inherited traditional/HSA balances and assume taxable-account basis step-up at death.
- Joint-life modeling uses an entered `primaryMortalityAge` / `spouseMortalityAge` for each spouse. The year a spouse hits their mortality age is treated as the year of death (still filed jointly per tax law); the following year and onward are filed as Single, with the surviving spouse keeping the higher of their own or the deceased's Social Security benefit. After both spouses have died, the simulation emits zero-income post-mortality years to keep `plan.years.length === planYears` and the portfolio is frozen at the second-death balance.
- Heir beneficiary type (`spouse` / `nonSpouse10Yr` / `eligibleDesignated`) toggles labeled, user-set tax-drag adjustments on the inherited-traditional/HSA portion of the bequest estimate. Both adjustments default to 0 and the IRS does not specify any flat drag for the 10-year rule — values are explicitly planning assumptions, not tax law, and the audit line says so.
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
- [Not planning to address]: Detailed inherited-account and estate rules are not modeled. The app now estimates after-tax bequest with a single heir ordinary tax rate, an optional labeled bracket-drag adjustment per beneficiary type, and taxable step-up assumption — but inherited IRA 5-year/10-year payout timing, eligible designated beneficiary mechanics, spouse elections, trust beneficiaries, missed-RMD excise tax handling, estate tax, and state inheritance tax remain out of scope.
- [Not planning to address]: Survivor benefit reductions for Social Security claimed between age 60 and FRA (71.5–99% of the deceased's PIA) are not modeled — the survivor receives the full `Math.max(own, deceased's)` benefit from the year after death onward. Households claiming survivor benefits before FRA should adjust the input benefit amount manually.
- [Not planning to address]: ACA household size does not shrink when a spouse dies mid-plan. Post-death years continue to use the household's original `marketplaceMembers` and `householdSize` for benchmark premiums and FPL ratios, which can overstate PTC eligibility for the survivor. Reduce these inputs in a separate scenario to model the survivor years.
- [Not planning to address]: HSA inheritance uses the same heir tax treatment as inherited traditional IRA balances. Real non-spouse HSA inheritance taxes the full balance as ordinary income in the year of death (no 10-year stretching); the model's simpler heir ordinary rate is an approximation that may understate the year-of-death tax hit for non-spouse HSA heirs.
- [Not planning to address]: Qualifying Surviving Spouse (formerly Qualifying Widow(er)) filing status is not modeled. Households with a dependent child who would qualify for MFJ rates for two years after a spouse's death should treat the immediate switch to Single in this model as conservative for tax purposes.
- [Not planning to address]: HSA treatment is simplified. Qualified medical distributions, nonqualified distributions, age-65 penalty changes, contribution eligibility, catch-up contributions, and payroll/FICA distinctions need explicit HSA inputs.
- [Not planning to address]: Wash sales, straddles, collectibles, Section 1256 contracts, foreign tax credit, PFIC treatment, municipal bond interest, bond premium/accrued interest, and qualified small business stock exclusions are not modeled.
- [Not planning to address]: Estate, gift, generation-skipping transfer, charitable remainder trust, donor-advised fund, NUA, annuity, pension survivor benefit, and insurance-product rules are not modeled.
- ACA exact-plan mode still depends on user-provided or API-filled premiums. Tobacco, CSR variant, employer affordability, immigration, Medicaid/CHIP, and non-calendar policy year edge cases require exact marketplace data or additional eligibility engines.
- Offline rating-area SLCSP (`slcspMonthlyFor`) covers only the **30 federal-platform states** that file rates into the CMS PUFs. State-based-exchange states (CA, NY, MA, CO, CT, DC, ID, KY, ME, MD, MN, NV, NJ, NM, PA, RI, VT, VA, WA, GA, and SBM-FP states absent from the PUFs such as IL) are **not** ingested; for them the model returns `fallback: "state"` and uses the state-level benchmark, still age-rated to the household. Closing this gap requires ingesting each state exchange's own PUFs (Phase 4). U.S. territories and APO/FPO military ZIPs return `fallback: "out-of-model"` (no marketplace).
- The bundled SLCSP is **rating-area-level**, not HealthCare.gov's **county-level** benchmark. It is the second-lowest silver premium among plans filed in the rating area; where a plan's service area covers only part of a rating area, the result can differ from the exact county-level SLCSP. Incorporating the Service Area PUF to reach county-level precision is a follow-up.
- ZIP→county uses the Census ZCTA↔county relationship file (primary county = largest land-area overlap), substituting for the HUD USPS crosswalk, which now requires a HUD API token. The two can disagree for ZIPs that straddle a county line, which only matters when the straddled counties sit in different rating areas.

## Decision Engine Limits

- Decision verdicts are planning outputs, not investment, tax, legal, or employment advice. They are only as good as the household inputs, tax assumptions, return assumptions, and healthcare plan assumptions entered in the app.
- The default Monte Carlo preset is a neutral 2026 capital-market-assumption baseline, not a guarantee. It uses normally sampled nominal annual returns, simplified correlation factors, and public CMA proxies for broad asset classes; real household portfolios can differ materially after fees, taxes, fund selection, and allocation drift.
- Intermediate solver probes use a bounded Monte Carlo search for responsiveness. Final displayed rescue options are rerun with the selected Monte Carlo count and historical backtests, but the search path itself is still an approximation.
- Failure anatomy tags failed Monte Carlo paths with broad stressors for tax drag, healthcare drag, spending pressure, reserve shortfall, allocation mismatch, and sequence/inflation triggers. It is not yet a dollar-by-dollar causal attribution engine; it does not prove how much each factor contributed to depletion or which exact year/action would have prevented the failure.
- Shareable spouse result links and the future shared fi-nance.com household profile are not implemented yet.

## Implementation Notes

- Prefer adding tax-law features as explicit user inputs with clear defaults rather than hidden assumptions.
- Add year-by-year audit fields and tests for every new tax-law feature so Sankey flows, action rows, and tax tables stay explainable.
- Keep source links in `docs/DATA_SOURCES.md` and verify current-year tax facts from primary government sources when possible.
