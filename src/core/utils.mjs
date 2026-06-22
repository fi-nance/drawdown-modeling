export const EPSILON = 1e-8;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function finiteNumberOr(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function sumBy(items, selector) {
  return items.reduce((total, item, index) => total + selector(item, index), 0);
}

export function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "asset";
}

export function createRng(seed = 1) {
  // Numeric seeds keep the historical `>>> 0` coercion so existing seeded runs
  // stay bit-identical. String seeds are hashed (FNV-1a 32-bit) — previously
  // every string coerced to 0 via `>>> 0`, so "finance" and any other string
  // produced the same stream.
  let state = typeof seed === "string" ? hashStringSeed(seed) : seed >>> 0;
  return function rng() {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit hash. Deterministic and well-distributed so distinct string
// seeds produce distinct, reproducible streams.
function hashStringSeed(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function normalRandom(rng, mean = 0, stdev = 1) {
  if (stdev === 0) return mean;
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const standardNormal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + standardNormal * stdev;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
