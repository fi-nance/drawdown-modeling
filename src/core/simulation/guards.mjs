// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: guards. No behavior changes — pure code movement.

import { round } from "../utils.mjs";

export function clampFiniteNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function finitePercent(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, numeric));
}

export function optionalFiniteNumber(value) {
  if (value == null || String(value).trim?.() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function clampIntegerLike(value, min, max, fallback) {
  if (value == null || String(value).trim?.() === "") {
    return Math.min(max, Math.max(min, Math.trunc(fallback)));
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(max, Math.max(min, Math.trunc(fallback)));
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

export function nonNegativeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : Math.max(0, Number(fallback) || 0);
}

export function normalizedPercent(value, fallback = 0) {
  const numeric = Number(value);
  const usable = Number.isFinite(numeric) ? numeric : Number(fallback);
  return Math.max(0, Math.min(1, Number.isFinite(usable) ? usable : 0));
}

export function finiteRoom(value) {
  const number = Number(value);
  if (Number.isNaN(number)) return Infinity;
  return Number.isFinite(number) ? Math.max(0, number) : Infinity;
}

export function finiteReturnOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? round(value, 6) : null;
}

export function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
