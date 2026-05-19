/* Tiny session-scoped cache for the most-recent rendered results.
   Lets a results-screen refresh paint instantly from the cache while the
   worker re-runs in the background.

   The full `latest` object is too big to fit in sessionStorage at realistic
   MC run counts — a single 1000-run × 35-year Monte Carlo serializes well
   above the ~5 MB quota. We strip the per-scenario year
   timelines (which dominate the size) and keep just the summary + each
   scenario's top-level outcome fields plus a thumbnail "lastYear" so
   inflation-adjusted formatting still works. The live browser run also keeps
   only a small number of full Monte Carlo timelines so high-run-count plans do
   not exhaust the renderer. */

export const RESULTS_CACHE_KEY = "portfolio-success-lab:results-cache:current";

// Used by tests; defaults to globalThis.sessionStorage in the browser.
function defaultStorage() {
  return typeof sessionStorage !== "undefined" ? sessionStorage : null;
}

function lastYearThumbnail(year) {
  if (!year) return null;
  return {
    year: year.year,
    yearIndex: year.yearIndex,
    inflationIndex: year.inflationIndex
  };
}

export function compactLatestForCache(value) {
  if (!value || typeof value !== "object") return value;
  const compactScenario = (s) => ({
    id: s.id,
    success: s.success,
    endingValue: s.endingValue,
    heirValue: s.heirValue,
    depletionYear: s.depletionYear ?? null,
    depletionYearIndex: s.depletionYearIndex ?? null,
    depletionAge: s.depletionAge ?? null,
    lastYear: lastYearThumbnail(s.years?.at?.(-1)) ?? s.lastYear ?? null
  });
  const compactBacktest = (b) => ({
    id: b.id,
    success: b.success,
    endingValue: b.endingValue,
    heirValue: b.heirValue,
    depletionYear: b.depletionYear ?? null,
    depletionYearIndex: b.depletionYearIndex ?? null,
    depletionAge: b.depletionAge ?? null,
    sourceYears: b.sourceYears,
    sourceStartYear: b.sourceStartYear,
    sourceEndYear: b.sourceEndYear,
    paddedYears: b.paddedYears,
    lastYear: lastYearThumbnail(b.years?.at?.(-1)) ?? b.lastYear ?? null
  });
  return {
    ...value,
    monteCarlo: value.monteCarlo ? {
      ...value.monteCarlo,
      scenarios: (value.monteCarlo.scenarios ?? []).map(compactScenario)
    } : value.monteCarlo,
    backtests: (value.backtests ?? []).map(compactBacktest),
    _compact: true
  };
}

export function cacheLatestResults(value, storage = defaultStorage()) {
  if (!value || !storage) return false;
  const compact = compactLatestForCache(value);
  try {
    storage.setItem(RESULTS_CACHE_KEY, JSON.stringify(compact));
    return true;
  } catch {
    // Quota exceeded or non-serializable value — drop the cache so we don't
    // restore a partial blob next time.
    try { storage.removeItem(RESULTS_CACHE_KEY); } catch { /* ignore */ }
    return false;
  }
}

export function restoreCachedLatest(storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(RESULTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.plan || !parsed.monteCarlo) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearCachedLatest(storage = defaultStorage()) {
  if (!storage) return;
  try { storage.removeItem(RESULTS_CACHE_KEY); } catch { /* ignore */ }
}
