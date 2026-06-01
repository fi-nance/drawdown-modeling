// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: constants. No behavior changes — pure code movement.

export const CASH_GAP_TOLERANCE = 0.01;

export const CASH_RAISED_EPSILON = 0.000001;

export const DEFENSIVE_ASSET_CLASSES = Object.freeze(["bond", "cash", "tips"]);

export const GROWTH_ASSET_CLASSES = Object.freeze(["stock", "realEstate", "crypto"]);

export const MONTE_CARLO_ASSUMPTION_PRESETS = Object.freeze({
  marketNeutral: Object.freeze({
    stock: Object.freeze({ mean: 0.071, stdev: 0.153 }),
    bond: Object.freeze({ mean: 0.049, stdev: 0.063 }),
    cash: Object.freeze({ mean: 0.033, stdev: 0.011 }),
    realEstate: Object.freeze({ mean: 0.081, stdev: 0.179 }),
    tips: Object.freeze({ mean: 0.042, stdev: 0.05 }),
    crypto: Object.freeze({ mean: 0.12, stdev: 0.65 }),
    inflation: Object.freeze({ mean: 0.024, stdev: 0.017 }),
    medicalInflation: Object.freeze({ mean: 0.042, stdev: 0.020 })
  }),
  planning: Object.freeze({
    stock: Object.freeze({ mean: 0.065, stdev: 0.18 }),
    bond: Object.freeze({ mean: 0.028, stdev: 0.06 }),
    cash: Object.freeze({ mean: 0.015, stdev: 0.015 }),
    realEstate: Object.freeze({ mean: 0.05, stdev: 0.14 }),
    tips: Object.freeze({ mean: 0.025, stdev: 0.07 }),
    crypto: Object.freeze({ mean: 0.12, stdev: 0.65 }),
    inflation: Object.freeze({ mean: 0.025, stdev: 0.012 }),
    medicalInflation: Object.freeze({ mean: 0.043, stdev: 0.015 })
  }),
  historical: Object.freeze({
    stock: Object.freeze({ mean: 0.1186, stdev: 0.193 }),
    bond: Object.freeze({ mean: 0.0482, stdev: 0.0786 }),
    cash: Object.freeze({ mean: 0.0342, stdev: 0.0302 }),
    realEstate: Object.freeze({ mean: 0.0438, stdev: 0.0615 }),
    tips: Object.freeze({ mean: 0.0372, stdev: 0.0621 }),
    // Crypto's short, regime-heavy series is too unstable to use raw as a
    // planning preset, so keep the tempered forward-looking assumption here.
    crypto: Object.freeze({ mean: 0.12, stdev: 0.65 }),
    inflation: Object.freeze({ mean: 0.0308, stdev: 0.0387 }),
    medicalInflation: Object.freeze({ mean: 0.0488, stdev: 0.045 })
  })
});

export const DEFAULT_MONTE_CARLO_RUNS = 1000;

// Default amount by which healthcare inflation is assumed to exceed general CPI
// when a scenario does not supply an explicit medical-inflation stream. ~1.8pp
// reflects the long-run gap between BLS medical-care CPI / CMS National Health
// Expenditure growth and headline CPI. Single source of truth so the MC,
// historical-backtest, and fallback paths stay consistent.
export const MEDICAL_INFLATION_PREMIUM = 0.018;
