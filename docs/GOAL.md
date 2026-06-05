# Project Goal

## North Star

> Build the most rigorous explainable U.S. household drawdown model an individual
> can run without an advisor. Starting from the simplest viable inputs and
> improving confidence as more household detail is added, it produces a
> CPA-auditable year-by-year action plan for withdrawals, Roth conversions,
> Social Security claiming, asset location, healthcare/MAGI management, and
> legacy strategy. It optimizes the household's stated tradeoff between after-tax
> lifetime spending, failure resilience, healthcare stability, and after-tax
> bequest under quantified uncertainty. It uses source-versioned current federal
> and state law for all 50 states and DC, with explicit assumptions, exclusions,
> confidence levels, and review flags. Every result must be reproducible, tested,
> inspectable from a CPA and engineering perspective, and designed so a
> non-advisor can understand the tradeoff well enough to act or know when to seek
> professional review.

The compact version:

> The most rigorous explainable personal drawdown planner: current-law accurate,
> tax and healthcare aware, uncertainty tested, legacy aware, CPA-auditable,
> engineering-reproducible, and simple enough for a household to use directly.

This document is the north-star. It is intentionally larger than what is shipped.
The repo's two companion docs ground that ambition in reality:

- [`README.md`](../README.md) — what is implemented today.
- [`docs/KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) — what is explicitly out of
  scope or deferred, and what overrides exist for power users.
- [`docs/DATA_SOURCES.md`](DATA_SOURCES.md) — where every versioned data table
  comes from and the annual refresh runbook.
- [`docs/REVIEW_BAR.md`](REVIEW_BAR.md) — the continuous CPA, engineering, and
  design bar every change should satisfy.

GOAL.md exists to keep the gap between today and the north-star visible, prioritized,
and reviewable.

## Product Contract

The goal is not "produce the highest success percentage." The product contract is
to make household drawdown decisions legible and auditable:

1. **Start simple, then grade confidence.** A ZIP code, ages, filing status,
   account totals by tax type, target spend, and healthcare status should produce
   a useful first verdict. More detail — lots, basis, Social Security earnings,
   heirs, state-specific tax facts, exact ACA plans — should raise confidence,
   not be required before the app is useful.
2. **Optimize stated tradeoffs.** Spending, resilience, healthcare stability,
   and after-tax bequest conflict. The app must ask or infer the household's
   tradeoff and show the efficient frontier instead of hiding value judgments in
   one score.
3. **Explain every recommendation.** A recommendation is incomplete unless the
   user can see what changed, why the solver tried it, what rules applied, which
   outcomes improved, which outcomes worsened, and which missing inputs or legal
   assumptions could invalidate it.
4. **Version rules, not vibes.** Tax, ACA, Medicare, Social Security, state, and
   historical-return facts must carry source, tax/plan year, retrieval date where
   practical, and tests or review flags. "Current law" means year-by-year rule
   selection with documented fallback behavior.
5. **Protect household data.** The model asks for sensitive financial, health
   coverage, family, and legacy information. Local-first operation, explicit
   import/export boundaries, and no surprise network submission are product
   requirements, not polish.

## Product Wedge (Why This Goal Now)

The first user is the post-job decision moment (see
[`docs/PRODUCT_DESIGN_REVIEW.md`](PRODUCT_DESIGN_REVIEW.md)): a household that
recently left work and needs to know — with a fallback plan — whether they can
stay retired. Drawdown rigor is the wedge because it makes the answer
defensible. Heir maximization, ACA accuracy, and state portability are what turn
a one-time decision tool into a model the household trusts year after year.

## What "Done" Looks Like

A household enters a ZIP code, ages, account balances by tax type, Social
Security PIA(s) or earnings history, heirs, goals, and only the extra fields
needed to raise confidence for its situation. The model returns:

1. **A verdict.** Can they stay retired at their target spend, with a
   quantified failure rate from both Monte Carlo and historical cohorts, and
   the disagreement between the two surfaced rather than averaged away.
2. **A year-by-year action plan.** Each year: withdrawal sources and amounts,
   Roth conversion size, SS claiming year (when first computed), tax payment,
   ACA plan and net premium, IRMAA tier, and bequest trajectory.
3. **Rescue scenarios with cost.** If fragile, what spending cut, bridge income,
   tax move, healthcare move, asset-allocation shift, or claiming change improves
   the plan, plus the cost to lifestyle and heirs.
4. **Tradeoff frontier.** A ranked set of alternatives across lifetime spending,
   failure resilience, healthcare stability, and after-tax bequest.
5. **Sensitivity.** Which three assumptions move the verdict most, ranked.
6. **Confidence and review flags.** Which outputs are high-confidence,
   assumption-sensitive, missing-input-limited, or CPA-review-recommended.
7. **An audit trail.** Every dollar of tax, subsidy, and withdrawal is
   traceable to a rule with a source link and model-year selection.

## Confidence Levels

Every verdict, action row, rescue option, and tax/healthcare estimate should
eventually carry one of these labels:

- **High confidence.** Rule is source-versioned, inputs are specific, and tests
  cover representative and boundary cases.
- **Input-limited.** Rule is modeled, but the household has not supplied enough
  detail for a precise result. The UI must show the specific input that would
  improve confidence.
- **Assumption-sensitive.** Result materially changes under plausible return,
  inflation, healthcare, tax-law, or life-event assumptions.
- **CPA review recommended.** Rule involves state-form nuance, estate/beneficiary
  law, business income, itemization, AMT/QBI, unusual retirement-plan rules, or
  other areas where the app should not imply filing-grade certainty.
- **Out of model.** The product explicitly does not model the rule yet; results
  must name the exclusion instead of silently ignoring it.

## Held To Three Lenses, Continuously

These are not one-time reviews. They are continuous bars every PR is held to.

### CPA Lens
- Every tax-law fact has a source link in [`docs/DATA_SOURCES.md`](DATA_SOURCES.md)
  and a primary-source citation (IRS Pub, Rev. Proc., CFR, state revenue
  instructions) — not a secondary aggregator.
- Annual refresh runbook executes deterministically; tests assert the new
  brackets, FPL, IRMAA tiers, ACA applicable percentages, and SLCSP defaults
  before the year defaults forward.
- Golden worked examples derived from IRS publications (Pub 590-B RMDs, Pub 915
  Social Security worksheet, Form 8962 ACA reconciliation, Schedule D capital
  gains stacking) live in `tests/` and never break silently.
- Law-regime correctness is explicit and verified, not assumed. The 2026
  federal structure reflects the OBBBA (2025) permanence of the TCJA individual
  provisions (no end-2025 sunset), and the 2026 ACA schedule reflects the
  post-2025 expiration of the ARPA/IRA enhanced subsidies (400% cliff returns).
  Both carry a `lawBasis` field, golden-test regime guards, and a documented
  assumption in KNOWN_LIMITATIONS. The 2025-2028 enhanced senior deduction is
  modeled as an explicit time-boxed rule rather than silently inheriting the
  base-year snapshot forever. Genuinely future legislated changes get the same
  per-year treatment.

### Engineering Lens
- Pure-function core in `src/core/`; UI in `src/redesign.mjs` and `src/app.mjs`.
- Deterministic with explicit seeds. Monte Carlo and historical paths are
  reproducible from a setup file.
- Tests cover: tax math (per-bracket and per-credit), ACA math against worked
  CMS examples, RMD against IRS Uniform Lifetime Table, IRMAA tier transitions,
  state-by-state edge cases, and end-to-end simulation invariants
  (no negative balances except by design, conservation of cash flows, etc.).
- Versioned data tables (`TAX_DATA_VERSION`, `HISTORICAL_RETURN_DATA_VERSION`).
- No hidden assumptions: every modeled rule is either a labeled control or a
  documented default with a source.

### Design Lens
- A spouse can read the verdict together in under 60 seconds and understand
  what is decided.
- ZIP code is the only geographic input required for the common case. State,
  rating area, county, exchange, and Medicaid-expansion status are derived.
- The healthcare bridge to 65 is a first-class screen, not a tab the user has
  to find.
- Every number the user can act on links to its assumption and the override
  that would change it.
- Missing data is presented as a confidence ladder, not a scolding checklist.
- Results separate "do this now," "consider this," and "ask a professional"
  actions so a non-advisor does not confuse planning output with advice.
- **Works on desktop and mobile.** The full decision flow — persona selection,
  setup import, results verdict, action plan, rescue options, and Sankey
  cash-flow views — must be usable on a phone-sized viewport (≥320 px wide)
  with touch input, not just on a desktop browser. Tables reflow to readable
  layouts on narrow screens; charts adapt or expose a tabular alternative;
  numeric inputs use appropriate mobile keyboards. The same setup file works
  identically across devices, so a household can start on a laptop together
  and continue on a phone, or vice versa.

## Scope Pillars

These are the load-bearing capability areas the goal requires. Each links to
its status today.

### 1. Tax engine, current-year-accurate

Shipped today (see README and `src/data/taxData.mjs`):
- Federal 2026 brackets, standard deduction, age-65 bump, LTCG/QDI stacking,
  2025-2028 enhanced senior deduction with MAGI phaseout, NIIT, W-2 employee
  FICA, Additional Medicare Tax, self-employment tax, child tax credit
  (nonrefundable).
- Capital loss carryforwards, ordinary loss offsets.
- 50-state ordinary + capital-gains tax tables with retirement-income and
  Social Security rule overlays.
- Roth contribution basis, 5-year clock, conversion 5-year penalty recapture,
  early-withdrawal penalty exception input.
- RMDs (SECURE 2.0 ages with override), forced-RMD cash retention.
- Social Security provisional-income taxation.
- IRMAA Part B + Part D tier estimation with 2-year MAGI lookback.

Goal-level gaps (today flagged in KNOWN_LIMITATIONS as "not planning to address"
but in scope for the north-star if we want CPA-grade coverage):
- ~~2026 TCJA sunset path~~ **Resolved by law.** OBBBA (2025) made the TCJA
  individual structure permanent, so there is no sunset boundary to switch at;
  the base-year-forward projection is correct and now carries a `lawBasis` field
  and golden-test regime guard. The remaining need is a **selectable regime only
  for genuinely future temporary law changes**, not a sunset reversal.
- ✅ **[Shipped] OBBBA enhanced senior deduction** (extra deduction for filers
  65+, 2025-2028, MAGI-phased) is modeled as a time-boxed federal rule with
  input-limited confidence flags for SSN/file-jointly eligibility facts the app
  does not separately collect.
- ✅ **[Shipped] Itemized deduction planning inputs** compare standard versus
  itemized deductions, model the 2026 SALT cap/phaseout and medical-expense
  AGI floor, and expose Schedule A inputs for SALT paid, mortgage interest,
  charitable gifts, and medical expenses. Confidence flags still require CPA
  review for filing-grade substantiation, mortgage-debt limits, charity caps,
  casualty losses, and other Schedule A edge cases.
- ✅ **[Shipped] AMT exposure tripwire** source-versions 2026 exemption,
  phaseout, complete phaseout, and 28% rate thresholds, exposes a Form 6251
  preference/addback estimate control, and CPA-flags tax-sensitive
  recommendations when entered addbacks or high modeled income make AMT review
  relevant. Full Form 6251 tentative-minimum-tax calculation remains out of
  model.
- **QBI deduction** for households with pass-through income (relevant to
  consulting-bridge users — see decision-engine "earn bridge income").
- **Refundable credits**: ACTC, EITC, education, dependent-care — when household
  composition triggers them.
- **NUA** (Net Unrealized Appreciation) for employer-stock-heavy households.
- **72(t) SEPP** as an explicit early-withdrawal mode, not a manual exception.
- **Form 8606 ordering** and separate Roth IRA vs designated Roth 401(k) clocks.
- **Wash sales** in the TLH path.

### 2. ACA + healthcare bridge, simple input, nationwide accuracy

Shipped today:
- 2026 applicable percentages, FPL, required contribution percentage from
  `taxData.mjs`.
- Offline ZIP → rating-area SLCSP for the 30 bundled federal-platform states,
  using CMS 2026 Rate/Plan Attribute PUFs and geographic rating areas; the app
  feeds the workspace ZIP into this path and still age-rates/inflates future
  years.
- State-level SLCSP fallback, age-rated with the federal default age curve,
  when ZIP is absent, state-based exchange data is not bundled, or the ZIP is
  out of the ingested rating-area set.
- Exact selected-plan mode (user enters or API-fills SLCSP, plan premium, OOP).
- CMS Marketplace API helper for HealthCare.gov states.
- MA ConnectorCare estimator with public plan-type tables.
- Backup plan triggered above a configurable FPL threshold (default 400%).
- MAGI computation feeds ACA subsidy sizing inside the lifetime optimizer.
- Confidence flags identify non-expansion/partial-expansion coverage-gap risk
  and distinguish bundled rating-area SLCSP from state fallback/out-of-model ZIP
  results.
- When a simulated plan is available, confidence flags name the exact modeled
  years where ACA MAGI falls below the PTC floor in non-expansion states, or
  into Medicaid/CHIP handoff range in expansion states.

Goal-level gaps:
- **County/service-area-level SLCSP**, not only rating-area-level. The current
  bundled path computes the second-lowest silver plan filed in a CMS rating
  area; exact HealthCare.gov SLCSP can differ where plan service areas cover
  only part of a rating area. Closing this requires incorporating Service Area
  PUFs or state/API county-level plan availability.
- **State-based exchange (SBE) coverage**, including CA, NY, WA, CO, CT, DC, ID,
  KY, ME, MD, MA, MN, NV, NJ, NM, PA, RI, VT. Each SBE publishes its own data;
  the goal is a per-state ingestion plan documented in DATA_SOURCES.md, with a
  ZIP → state-exchange routing layer in the UI.
- **Eligibility-grade Medicaid/CHIP modeling** beyond today's confidence flags:
  the app can now identify modeled low-income years, but still needs household
  member categories, CHIP children, immigration exceptions, state-specific
  waiver behavior, and actual Medicaid/transition cost assumptions before
  recommending MAGI-reduction moves as final.
- **Post-2025 ACA enhanced subsidy expiration** — **done, and scoped to current
  law by decision.** 2026 is modeled as expired (400% cliff, reverted schedule,
  `enhancedSubsidiesActive: false`), documented and golden-tested. An optional
  "extended" comparison regime was considered and **declined** — the model tracks
  enacted law only; revisit only if Congress actually re-extends.
- **CSR (cost-sharing reduction) variants** at 100–250% FPL households —
  modeled OOP maximum and effective AV change.
- **Employer-affordability** check for households where one spouse has an
  employer offer (disqualifies family from PTC).
- **Premium-credit reconciliation** (Form 8962 true-up) modeled at year-end so
  underestimated MAGI does not silently inflate the modeled subsidy.

### 3. Heir maximization

Shipped today: bequest and legacy modeling features a progressive heir taxation engine. It models spouse rollover (tax-deferred), non-spouse 10-year distributions stacked progressively on the heir's starting base income (default $80,000 Single) to simulate bracket compression, and eligible-designated stretch distributions over a life-expectancy schedule (a generic table approximating the IRS Single Life Table). The household-level heir type is the default, and per-account beneficiary overrides can route individual accounts to spouse, non-spouse 10-year, or eligible-designated treatment when beneficiary designations differ. It models the Federal Estate Tax (40% above the 2026 $15M per-decedent exclusion; surviving-spouse transfers exempt under the unlimited marital deduction) and lineal-heir state inheritance tax (PA 4.5%, NE 1%; NJ Class A and MD lineal descendants exempt — non-lineal heirs out of model), and assumes taxable-account basis step-up at death. Heir income/age default to $80,000/age 30 when unset and materially drive the heir tax.

Goal-level gaps (the largest single area):
- ✅ **[Shipped] Inherited IRA 10-year rule (SECURE Act 2.0)** for non-spouse heirs, distributing traditional IRA balances over 10 years stacked progressively on top of a standard base income ($80,000 Single status) to model bracket compression.
- ✅ **[Shipped] Eligible designated beneficiary** rules (surviving spouse rollover, eligible designated lifetime stretch expectancies looked up dynamically from IRS Single Life Expectancy Table I based on age).
- ✅ **[Shipped] Estate tax** (federal 40% above the 2026 $15M OBBBA exclusion, spouse exempt) + lineal-heir state inheritance tax (PA 4.5%, NE 1%; NJ/MD lineal-exempt; non-lineal heirs out of model).
- **Step-up basis sensitivity and exceptions** so the taxable-account assumption can handle alternate valuation, gift-within-one-year exceptions, no-step-up regimes if law changes, and estate-plan-specific cases instead of one broad default.
- **Bequest-aware lifetime optimizer mode** that weights heir's after-tax inheritance into the objective function, not just owner-lifetime after-tax spending. The Roth-favorability for heirs (no RMDs, tax-free 10-year window) changes Roth-conversion sizing materially.
- **Trust and non-lineal beneficiary detail**: per-account spouse, non-spouse, and eligible-designated rules are now modeled, but trusts and non-lineal relationship classes still need their own beneficiary taxonomy and tax treatment.
- **Charitable strategies** that change tax cost — QCDs after 70½, DAF bunching, charitable remainder trusts — for households with charitable intent.

### 4. Modeling rigor

Shipped today: Monte Carlo with correlated paths, 1928-present historical
cohorts, opt-in 1872 reconstructed source, sequence-risk reserves,
essential/discretionary guardrails, lifetime optimizer, and a first-pass ranked
sensitivity analysis for return, inflation, spending, and healthcare shocks.
Failed Monte Carlo paths now include both a primary sequence/inflation trigger
and a multi-factor stress breakdown for tax drag, healthcare drag, spending
pressure, reserve shortfall, and allocation mismatch.

Goal-level gaps:
- **Deeper sensitivity analysis output** — today's first pass ranks a small set
  of standard shocks. The north-star version should search household-specific
  breakpoints, e.g. "if your expected return is 1pp lower, the verdict moves
  from safe to fragile," so the user knows which assumptions to argue with.
- **Two-stream inflation** (general CPI + healthcare CPI, which historically
  runs 1.5–2pp higher) for the pre-Medicare bridge and Medicare years.
- **Spending guardrails beyond the current discretionary-trim mode** —
  Guyton-Klinger inflation-skip, Kitces ratcheting, variable-percentage
  withdrawal — as selectable strategies.
- **Deeper failure attribution** — today's first pass tags broad failed-path
  stressors. The north-star version should quantify dollar contribution to
  depletion by year and connect each factor to the exact action rows that would
  have changed it.
- **Joint-life modeling** for couples with different ages, including widowhood
  single-filer-bracket transition and survivor SS optimization.

### 5. Nationwide, ZIP-only input

Shipped today: state tax table for all 50 states + DC; manual state overrides;
offline ZIP → state/exchange/Medicaid resolver; offline ZIP → county/rating-area
SLCSP for the bundled federal-platform states.

Goal-level gaps:
- **Make ZIP primary across the whole workspace.** ACA now consumes the ZIP for
  bundled rating-area SLCSP, but state tax residency, UI defaults, and all
  confidence copy should eventually derive from ZIP first and ask for state only
  when residency or move-year facts differ from mailing ZIP.
- **ZIP/rating-area coverage completion** for SBE states and precise county /
  service-area SLCSP.
- **State estate/inheritance tax** modeling (12+ states levy one).
- **State-specific retirement-income exclusions** at form-level detail (NY's
  $20K exclusion + 100% public-pension exclusion, IL's full retirement-income
  exemption, PA's tax treatment of retirement distributions, etc.). Today the
  table is broad IRA/401(k) treatment + override.
- **Cross-state move year** support so a planned retirement-state relocation is
  modeled correctly across the move boundary.

### 6. CPA / Engineering / Design review as a continuous bar

Goal-level gaps:
- **Per-PR CPA-lens checklist** — does this PR change a tax-law fact, and if
  so, what primary source backs it, and is there a golden test?
- **Per-year CPA review cycle** in January when IRS releases the new year's
  data, executed against the runbook in DATA_SOURCES.md, with checklist
  output committed.
- **Verdict-readability rubric** for the design lens — a non-advisor reads
  the verdict cold and can explain to a spouse what changed in under 60s.

### 7. Privacy, data custody, and household trust

Shipped today: browser-based app, local setup backup/restore with sensitive-data
confirmation, result audit bundle export with setup + compact results +
confidence/sensitivity/audit metadata + a compact CPA/engineering review
summary and sensitive-data confirmation, local storage for remembered setup,
optional explicit imports from CSV/JSON/Google Sheets, live CMS Marketplace
lookup only when the user invokes it, and a privacy-mode run path that disables
Google Sheets imports and live CMS Marketplace lookup while preserving local
imports, offline ZIP lookup, and manual ACA plan inputs.

Goal-level gaps:
- **Local-first guarantee** stated in the UI and docs: what stays in the browser,
  what is stored locally, and what leaves the machine during Marketplace or
  Google integrations.
- **Data minimization by confidence tier** so the app asks for exact details only
  when they change a decision or materially improve confidence.
- **Reproducibility bundle depth** beyond today's JSON bundle: the audit bundle
  now includes a compact CPA/engineering review summary that proves
  rule/source/version choices without exposing every Monte Carlo path; next step
  is a separate shareable summary export with even tighter data minimization.

## Roadmap (Phased)

Phasing reflects: highest user-visible impact first, lowest CPA-correctness
risk first, then breadth.

### Phase 1 — ACA "simple input" payoff

- Finish ZIP-first UI behavior: derive state/exchange/Medicaid/rating-area facts
  from ZIP in the workspace, surface mismatches, and keep manual overrides for
  residency or state-based exchange edge cases.
- Extend the shipped rating-area-level SLCSP path from federal-platform states
  to SBE states where public PUFs or exchange APIs support it.
- Move from rating-area-level to county/service-area-level SLCSP where data
  allows.
- Upgrade the shipped modeled-year coverage-gap/Medicaid flags into an
  eligibility engine that uses household composition and state-specific
  Medicaid/CHIP rules.
- ✅ Post-2025 enhanced-subsidy expiration: 2026 modeled as expired (400% cliff,
  reverted schedule), documented with `lawBasis` and golden-test guards. Optional
  "extended" comparison regime considered and declined — enacted law only.
- Golden tests built from CMS worked examples.

### Phase 2 — Heir maximization

- ✅ Per-account beneficiary input + inherited-account rule engine (10-year rule, EDB stretch, spousal rollover).
- ✅ Federal estate tax (40% above the 2026 $15M OBBBA exclusion, spouse exempt) + lineal-heir state inheritance tax (PA 4.5%, NE 1%; NJ/MD lineal-exempt).
- Step-up basis at death year on taxable lots.
- Bequest-aware optimizer mode in the lifetime optimizer.

### Phase 3 — Tax-engine breadth

- ✅ Itemized deductions as first-class planning inputs (SALT cap/phaseout,
  mortgage, charitable, medical AGI floor) with Schedule A CPA-review flags.
- QBI deduction for SE bridge income.
- AMT tripwire.
- ~~2026 TCJA sunset regime modeling~~ — moot: OBBBA (2025) made the TCJA
  individual structure permanent, so there is no sunset to model. Replaced by:
  ✅ OBBBA enhanced senior deduction (2025-2028) as a time-boxed regime.
- ✅ Self-employment tax for bridge-income scenarios.

### Phase 4 — State-based exchange coverage

- Per-SBE ingestion plan in DATA_SOURCES.md.
- ZIP-routed SBE plan lookup for the largest SBE states first (CA, NY, WA,
  MA already partially shipped via ConnectorCare).

### Phase 5 — Modeling rigor upgrades

- ✅ Social Security claimant claiming age solver grid (62-70 dimension) and dynamic earnings-to-PIA estimation with source-versioned SSA 2026 progressive bend points.
- ✅ Tradeoff Frontier comparison of 4 ranked plan alternatives (Max Spend, Max Resilience, Max Healthcare, Max Bequest) with live apply triggers.
- Sensitivity-analysis output (three assumptions ranked by verdict impact).
- Two-stream inflation (general + healthcare).
- Deeper failure attribution on Monte Carlo failed paths, beyond the shipped
  stressor tags.
- Additional spending-guardrail strategies.

### Continuous

- January refresh against DATA_SOURCES.md runbook every year.
- Per-PR CPA-lens checklist.
- Design rubric on every verdict change.
- Privacy/data-custody review whenever a feature imports, stores, exports, or
  transmits household data.
- Confidence-label coverage: every new recommendation or tax/healthcare estimate
  states whether it is high-confidence, input-limited, assumption-sensitive,
  CPA-review-recommended, or out-of-model.

## Non-Goals

These remain outside the model and are documented as user responsibilities:
- Individual-equity selection and active management.
- Tax-return filing software.
- Investment, tax, legal, or employment advice.
- Insurance product recommendations (annuities, life, LTC).
- Real-time intraday data.
