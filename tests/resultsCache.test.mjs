import assert from "node:assert/strict";
import test from "node:test";

import {
  RESULTS_CACHE_KEY,
  cacheLatestResults,
  clearCachedLatest,
  compactLatestForCache,
  restoreCachedLatest
} from "../src/core/resultsCache.mjs";

function makeStorage({ quota = Infinity } = {}) {
  const data = new Map();
  let used = 0;
  return {
    data,
    get length() { return data.size; },
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) {
      const prev = data.get(key) ?? "";
      const next = String(value);
      const delta = next.length - prev.length;
      if (used + delta > quota) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      used += delta;
      data.set(key, next);
    },
    removeItem(key) {
      const prev = data.get(key) ?? "";
      used -= prev.length;
      data.delete(key);
    },
    clear() { data.clear(); used = 0; }
  };
}

function makeLatest({ runs = 2, planYears = 3 } = {}) {
  const years = Array.from({ length: planYears }, (_, i) => ({
    yearIndex: i,
    year: 2026 + i,
    age: 55 + i,
    inflationIndex: Math.pow(1.025, i),
    portfolioValue: 1_000_000 - i * 20_000,
    sales: [],
    socialSecurity: { benefit: 0 }
  }));
  const scenarios = Array.from({ length: runs }, (_, i) => ({
    id: i + 1,
    success: true,
    endingValue: 800_000 + i * 1000,
    heirValue: 400_000,
    years
  }));
  return {
    scenario: { planYears, currentAge: 55 },
    taxProfile: { filingStatus: "marriedFilingJointly" },
    historicalRange: { startYear: 1928, endYear: 2024 },
    historicalMode: "all",
    plan: { years, success: true, endingValue: 800_000, heirValue: 400_000 },
    monteCarlo: {
      summary: {
        runs,
        successRate: 0.9,
        medianEndingValue: 800_000,
        p10EndingValue: 600_000,
        p90EndingValue: 1_100_000,
        medianHeirValue: 400_000
      },
      scenarios
    },
    backtests: [{
      id: "1990",
      success: true,
      endingValue: 750_000,
      heirValue: 350_000,
      sourceYears: [1990, 1991],
      sourceStartYear: 1990,
      sourceEndYear: 2025,
      paddedYears: 0,
      years
    }]
  };
}

test("cacheLatestResults writes a JSON snapshot under the canonical key", () => {
  const storage = makeStorage();
  const latest = makeLatest();
  const ok = cacheLatestResults(latest, storage);
  assert.equal(ok, true);
  assert.ok(storage.getItem(RESULTS_CACHE_KEY), "expected cache key to be populated");
  const parsed = JSON.parse(storage.getItem(RESULTS_CACHE_KEY));
  assert.equal(parsed.monteCarlo.summary.runs, latest.monteCarlo.summary.runs);
  assert.equal(parsed.plan.years.length, latest.plan.years.length);
});

test("restoreCachedLatest round-trips the cached object", () => {
  const storage = makeStorage();
  const latest = makeLatest();
  cacheLatestResults(latest, storage);
  const restored = restoreCachedLatest(storage);
  assert.ok(restored, "expected to restore a non-null value");
  assert.equal(restored.monteCarlo.summary.successRate, 0.9);
  assert.equal(restored.plan.endingValue, 800_000);
  assert.equal(restored.monteCarlo.scenarios.length, 2);
});

test("restoreCachedLatest returns null when no cache is present", () => {
  const storage = makeStorage();
  assert.equal(restoreCachedLatest(storage), null);
});

test("restoreCachedLatest returns null for malformed JSON", () => {
  const storage = makeStorage();
  storage.setItem(RESULTS_CACHE_KEY, "{this is not json");
  assert.equal(restoreCachedLatest(storage), null);
});

test("restoreCachedLatest rejects shapes missing plan or monteCarlo", () => {
  const storage = makeStorage();
  storage.setItem(RESULTS_CACHE_KEY, JSON.stringify({ plan: { years: [] } })); // no monteCarlo
  assert.equal(restoreCachedLatest(storage), null);

  storage.clear();
  storage.setItem(RESULTS_CACHE_KEY, JSON.stringify({ monteCarlo: { summary: {} } })); // no plan
  assert.equal(restoreCachedLatest(storage), null);
});

test("clearCachedLatest removes the cached entry", () => {
  const storage = makeStorage();
  const latest = makeLatest();
  cacheLatestResults(latest, storage);
  assert.ok(storage.getItem(RESULTS_CACHE_KEY));
  clearCachedLatest(storage);
  assert.equal(storage.getItem(RESULTS_CACHE_KEY), null);
});

test("cacheLatestResults returns false and clears any previous blob when quota is exceeded", () => {
  const storage = makeStorage({ quota: 4096 }); // enough for a minimal seed, well below a real 250-run blob
  // Seed with a small valid prior cache.
  cacheLatestResults(makeLatest({ runs: 1, planYears: 1 }), storage);
  assert.ok(storage.getItem(RESULTS_CACHE_KEY), "seed cache must be present before the overflow attempt");

  // Now try to store something well past the quota even after compaction.
  const big = makeLatest({ runs: 250, planYears: 35 });
  const ok = cacheLatestResults(big, storage);
  assert.equal(ok, false, "expected cacheLatestResults to return false on quota overflow");
  assert.equal(
    storage.getItem(RESULTS_CACHE_KEY),
    null,
    "expected stale cache to be cleared so we don't restore a partial blob"
  );
});

test("cacheLatestResults ignores nullish inputs", () => {
  const storage = makeStorage();
  assert.equal(cacheLatestResults(null, storage), false);
  assert.equal(cacheLatestResults(undefined, storage), false);
  assert.equal(storage.getItem(RESULTS_CACHE_KEY), null);
});

test("cache → restore preserves enough fields to drive the result panels", () => {
  // Pins the contract relied on by app.mjs renderLatest and
  // redesign.mjs.rerenderResults: after restoring, plan.years and
  // monteCarlo.summary must be intact.
  const storage = makeStorage();
  const latest = makeLatest({ runs: 5, planYears: 10 });
  cacheLatestResults(latest, storage);
  const restored = restoreCachedLatest(storage);

  assert.ok(Array.isArray(restored.plan.years), "plan.years must round-trip");
  assert.equal(restored.plan.years.length, 10);
  assert.equal(restored.monteCarlo.summary.runs, 5);
  assert.ok(Array.isArray(restored.monteCarlo.scenarios));
  assert.equal(restored.monteCarlo.scenarios.length, 5);
});

test("compactLatestForCache strips per-scenario years but keeps lastYear thumbnail", () => {
  const latest = makeLatest({ runs: 3, planYears: 5 });
  const compact = compactLatestForCache(latest);

  assert.equal(compact._compact, true);
  for (const s of compact.monteCarlo.scenarios) {
    assert.equal(s.years, undefined, "compact scenario must not carry the years array");
    assert.ok(s.lastYear, "compact scenario must carry a lastYear thumbnail");
    assert.equal(typeof s.lastYear.inflationIndex, "number");
    assert.equal(s.lastYear.yearIndex, 4); // planYears - 1
  }
  for (const b of compact.backtests) {
    assert.equal(b.years, undefined, "compact backtest must not carry the years array");
    assert.ok(b.lastYear);
  }
  // plan.years stays intact because activeYears() falls back to it.
  assert.equal(compact.plan.years.length, 5);
});

test("compactLatestForCache preserves restored thumbnails and depletion metadata", () => {
  const latest = makeLatest({ runs: 1, planYears: 5 });
  const failureYear = latest.plan.years[2];
  latest.monteCarlo.scenarios[0] = {
    ...latest.monteCarlo.scenarios[0],
    success: false,
    depletionYear: failureYear.year,
    depletionYearIndex: failureYear.yearIndex,
    depletionAge: failureYear.age
  };

  const firstCompact = compactLatestForCache(latest);
  const secondCompact = compactLatestForCache(firstCompact);
  const scenario = secondCompact.monteCarlo.scenarios[0];

  assert.deepEqual(scenario.lastYear, firstCompact.monteCarlo.scenarios[0].lastYear);
  assert.equal(scenario.depletionYear, failureYear.year);
  assert.equal(scenario.depletionYearIndex, failureYear.yearIndex);
  assert.equal(scenario.depletionAge, failureYear.age);
});

test("cached blob shrinks dramatically after compaction (fits under sessionStorage quota)", () => {
  // The whole point: default MC blobs (1000 runs × 35 years) exceed the ~5 MB
  // sessionStorage quota. The compact form must come in well under.
  const latest = makeLatest({ runs: 1000, planYears: 35 });
  const fullKb = Math.round(JSON.stringify(latest).length / 1024);
  const compactKb = Math.round(JSON.stringify(compactLatestForCache(latest)).length / 1024);
  assert.ok(compactKb * 5 < fullKb, `expected compact form to be much smaller (full ${fullKb} KB, compact ${compactKb} KB)`);
  assert.ok(compactKb < 5 * 1024, `compact form ${compactKb} KB should fit under ~5 MB sessionStorage quota`);
});

test("cacheLatestResults succeeds with realistic 1000-run latest because it caches the compact form", () => {
  const storage = makeStorage({ quota: 5 * 1024 * 1024 }); // 5 MB
  const latest = makeLatest({ runs: 1000, planYears: 35 });
  const ok = cacheLatestResults(latest, storage);
  assert.equal(ok, true, "compact cache must succeed at the default 1000 runs");

  const restored = restoreCachedLatest(storage);
  assert.ok(restored, "must round-trip");
  assert.equal(restored.monteCarlo.scenarios.length, 1000);
  assert.equal(restored.plan.years.length, 35);
  assert.ok(restored.monteCarlo.scenarios[0].lastYear);
});
