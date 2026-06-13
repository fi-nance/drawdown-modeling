// onboarding.mjs
// Pure, DOM-free helpers for the first-run onboarding wizard. The wizard lets a
// user enter their portfolio at one of three depths — a single total, totals by
// account type, or every holding (the full table). The first two depths are
// turned into "representative lots" here: one stock lot and one bond lot per
// non-empty account bucket, priced at $1 so units == dollars. The engine only
// reads units/price/assetClass/accountType for a core run (see portfolio.mjs),
// and these lots round-trip into the editable asset table, so a user can always
// graduate to per-holding detail later without losing anything.
//
// Kept side-effect-free so it can be unit-tested directly and exercised against
// simulatePlan without a DOM.

// Per-class income defaults mirror the conventions in src/data/sample.mjs so a
// synthesized lot behaves like a typical broad-market fund of that class.
const ASSET_CLASS_DEFAULTS = {
  stock: { dividendYield: 0.018, qualifiedDividendShare: 0.95 },
  bond: { dividendYield: 0.025, qualifiedDividendShare: 0 }
};

const ACCOUNT_LABELS = {
  taxable: "Taxable",
  traditional: "Pre-tax (401k/IRA)",
  roth: "Roth",
  hsa: "HSA"
};

// Account buckets in the order they should appear in the table.
const ACCOUNT_ORDER = ["taxable", "traditional", "roth", "hsa"];

function roundCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function makeDefaultIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `onboarding-${counter}`;
  };
}

function round8(value) {
  return Math.round(value * 1e8) / 1e8;
}

function makeLot(accountType, assetClass, units, costBasisPerUnit, idFactory) {
  const cls = ASSET_CLASS_DEFAULTS[assetClass];
  return {
    id: idFactory(),
    name: `${ACCOUNT_LABELS[accountType] ?? accountType} — ${assetClass === "stock" ? "stocks" : "bonds"}`,
    symbol: "",
    accountType,
    assetClass,
    holdingPeriod: "long",
    units,
    price: 1,
    costBasisPerUnit,
    dividendYield: cls.dividendYield,
    qualifiedDividendShare: cls.qualifiedDividendShare,
    owner: "primary",
    beneficiaryType: "default"
  };
}

// Build representative stock/bond lots for each non-empty account bucket.
// `stockPercent` (0–100) is applied uniformly across buckets. Empty/zero buckets
// are skipped. The bond units are computed as (amount − stockUnits) so each
// bucket's lots sum back to its exact dollar amount with no rounding drift.
//
// `taxableGainsPercent` (0–100, default 50) is the share of the *taxable* bucket
// assumed to be unrealized gains: with price 1, cost basis per unit is
// (1 − gains%), so selling realizes that gain and is taxed. Basis is irrelevant
// for sheltered (traditional/Roth/HSA) buckets, which keep basis = value.
export function representativeAssets({
  taxable = 0,
  traditional = 0,
  roth = 0,
  hsa = 0,
  stockPercent = 60,
  taxableGainsPercent = 50,
  makeId
} = {}) {
  const idFactory = typeof makeId === "function" ? makeId : makeDefaultIdFactory();
  const share = clamp01(Number(stockPercent) / 100);
  const taxableBasis = round8(Math.max(0, 1 - clamp01(Number(taxableGainsPercent) / 100)));
  const amounts = { taxable, traditional, roth, hsa };
  const assets = [];
  for (const accountType of ACCOUNT_ORDER) {
    const amount = roundCents(amounts[accountType]);
    if (!(amount > 0)) continue;
    const basis = accountType === "taxable" ? taxableBasis : 1;
    const stockUnits = roundCents(amount * share);
    const bondUnits = roundCents(amount - stockUnits);
    if (stockUnits > 0) assets.push(makeLot(accountType, "stock", stockUnits, basis, idFactory));
    if (bondUnits > 0) assets.push(makeLot(accountType, "bond", bondUnits, basis, idFactory));
  }
  return assets;
}

// Simplest depth: a single liquid total, modeled as a taxable brokerage account.
// The wizard nudges the user to split by account type for a more accurate tax
// picture; this is the deliberate all-taxable fallback when they don't.
export function portfolioFromTotal({ total = 0, stockPercent = 60, taxableGainsPercent = 50, makeId } = {}) {
  return representativeAssets({ taxable: total, stockPercent, taxableGainsPercent, makeId });
}

// Map the wizard's collected essentials onto workspace control ids (the flat
// { controlId: value } shape the app's applySetupState / setInputValue expect).
// Marriage is driven by filingStatus in the engine, so spouse age is only
// surfaced for joint/separate filers; for single/HoH we mirror the primary age
// (a harmless valid value — spouse mechanics stay gated off by filing status).
export function essentialsToControls(essentials = {}) {
  const {
    currentAge,
    spouseAge,
    filingStatus,
    state,
    householdSize,
    planYears,
    targetSpend,
    includeTaxes = false,
    includeMedical = false
  } = essentials;

  const married =
    filingStatus === "marriedFilingJointly" || filingStatus === "marriedFilingSeparately";
  const hasValue = (v) => v != null && v !== "";

  const controls = {};
  if (hasValue(currentAge)) controls.currentAge = currentAge;
  const spouseValue = married ? spouseAge : currentAge;
  if (hasValue(spouseValue)) controls.spouseAge = spouseValue;
  if (hasValue(filingStatus)) controls.filingStatus = filingStatus;
  if (hasValue(state)) controls.stateSelect = state;
  if (hasValue(householdSize)) controls.householdSize = householdSize;
  if (hasValue(planYears)) controls.planYears = planYears;
  if (hasValue(targetSpend)) controls.targetSpend = targetSpend;
  controls.includeTaxes = Boolean(includeTaxes);
  controls.includeMedical = Boolean(includeMedical);
  return controls;
}

export const ONBOARDING_ACCOUNT_LABELS = ACCOUNT_LABELS;
