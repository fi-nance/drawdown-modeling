<!--
This template enforces the continuous review bar from `docs/REVIEW_BAR.md`.
Mark sections N/A if a lens does not apply. Do not silently delete sections.
-->

## What this PR changes

<!-- One or two sentences. Link to GOAL.md phase or KNOWN_LIMITATIONS row if relevant. -->

## CPA lens

Does this PR change any modeled tax-law fact (federal, state, ACA, Medicare,
RMD, Roth, withdrawal character, beneficiary, estate)?

- [ ] No — N/A
- [ ] Yes — I have:
  - [ ] Cited a **primary source** (IRS Pub, Rev. Proc., IRB, CFR, CMS rule,
    HHS Federal Register, or state revenue instructions) in
    `docs/DATA_SOURCES.md`. Aggregators (Tax Foundation, Kiplinger, news) are
    cross-checks, not primary.
  - [ ] Added or extended a **golden test** in `tests/golden_*.test.mjs` that
    traces to that primary source.
  - [ ] Updated `docs/KNOWN_LIMITATIONS.md` if the scope of "what we model"
    changed.
  - [ ] Confirmed the change uses **year-by-year rule selection** if the rule
    differs across law years (TCJA sunset, post-2025 ACA enhanced subsidies,
    SECURE 2.0 RMD ages, etc.).

## Engineering lens

- [ ] `npm test` passes locally.
- [ ] New behavior has new tests; tax-law changes have golden tests.
- [ ] Core logic stays in `src/core/`; side effects in `src/app.mjs` or
  `src/redesign.mjs`.
- [ ] Monte Carlo / historical paths remain deterministic from a setup file
  and seed (if touched).
- [ ] No new silent assumption — every modeled rule is either a labeled
  control or a documented default with a source.
- [ ] No NaN/Infinity leaks into UI outputs.

## Design lens

Does this PR change user-facing output?

- [ ] No — N/A
- [ ] Yes — I have verified:
  - [ ] The verdict (if changed) reads as one sentence with the evidence
    visible.
  - [ ] Monte Carlo vs historical disagreement is surfaced, not averaged.
  - [ ] Every action row maps to its assumption and the override that would
    change it.
  - [ ] Geographic inputs stay ZIP-only for the common case (no rating-area
    inputs surfaced to users).
  - [ ] Plain language beats jargon; first-use acronyms have a tooltip or
    expansion.
  - [ ] Healthcare-bridge content stays a screen, not a tab.
  - [ ] **Verified on a phone-sized viewport (≥320 px wide)** *and* a desktop
    viewport: tables reflow or scroll cleanly, charts adapt or expose a
    tabular alternative, touch targets are usable, and numeric inputs
    trigger the appropriate mobile keyboard.

## Confidence labeling (if user-facing)

If this PR adds or changes a recommendation, what is its
[GOAL.md confidence level](../docs/GOAL.md)?

- [ ] High confidence
- [ ] Input-limited (names the input that would raise confidence)
- [ ] Assumption-sensitive (names the assumption)
- [ ] CPA review recommended
- [ ] Out of model (excluded explicitly, not silently)
- [ ] N/A

## Annual refresh (January only)

If this is part of the annual tax-year refresh:

- [ ] `TAX_DATA_VERSION` and/or `HISTORICAL_RETURN_DATA_VERSION` incremented.
- [ ] Ran the runbook in `docs/DATA_SOURCES.md` end-to-end.
- [ ] New-year golden tests added (brackets, FPL, IRMAA, ACA applicable
  percentages, representative state cases).
