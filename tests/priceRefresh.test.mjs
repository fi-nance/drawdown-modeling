import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRequestListener, PRICE_REFRESH_PROXY_PATH } from "../scripts/devServer.mjs";
import { NETLIFY_PRICE_REFRESH_PROXY_PATH, yahooQuoteProxyResponse } from "../scripts/yahooQuoteProxy.mjs";
import {
  classifyPriceIdentifier,
  fiscalDataTipsUrl,
  iBondCompositeRate,
  iBondCoverageThrough,
  iBondUnitValue,
  isValidCusip,
  localTickerProxyUrl,
  localTickerProxyUrls,
  parseTipsIndexRatio,
  parseYahooChart,
  refreshAssetPrices,
  refreshSummaryText,
  yahooChartUrl
} from "../src/core/priceRefresh.mjs";

// ─── Identifier classification ───────────────────────────────────────────

test("classifyPriceIdentifier recognizes tickers, CUSIPs, and I-bond months", () => {
  assert.deepEqual(classifyPriceIdentifier("VTI"), { type: "ticker", value: "VTI" });
  assert.deepEqual(classifyPriceIdentifier(" brk-b "), { type: "ticker", value: "BRK-B" });
  assert.deepEqual(classifyPriceIdentifier("VOD.L"), { type: "ticker", value: "VOD.L" });

  // Real Treasury CUSIPs (3-year note auctioned 2019; 30-year TIPS from 1998).
  assert.deepEqual(classifyPriceIdentifier("912828YK0"), { type: "cusip", value: "912828YK0" });
  assert.deepEqual(classifyPriceIdentifier("912810fd5"), { type: "cusip", value: "912810FD5" });
  // Nine alphanumerics with a WRONG check digit stay a ticker, not a CUSIP.
  assert.deepEqual(classifyPriceIdentifier("912828YK1"), { type: "ticker", value: "912828YK1" });

  assert.deepEqual(classifyPriceIdentifier("2021-11"), { type: "ibond", value: "2021-11" });
  assert.deepEqual(classifyPriceIdentifier("11/2021"), { type: "ibond", value: "2021-11" });
  assert.deepEqual(classifyPriceIdentifier("2021/3"), { type: "ibond", value: "2021-03" });
  assert.deepEqual(classifyPriceIdentifier("2021-11-15"), { type: "ibond", value: "2021-11" });

  assert.equal(classifyPriceIdentifier("").type, "none");
  assert.equal(classifyPriceIdentifier(null).type, "none");
  assert.equal(classifyPriceIdentifier("not a symbol!!!").type, "invalid");
});

test("isValidCusip implements the modulus-10 double-add-double check digit", () => {
  assert.equal(isValidCusip("912828YK0"), true);
  assert.equal(isValidCusip("912810FD5"), true);
  assert.equal(isValidCusip("912810SV1"), true); // 30-year TIPS 2/2051
  assert.equal(isValidCusip("912828YK9"), false);
  assert.equal(isValidCusip("12345678"), false); // 8 chars
});

// ─── I-bond valuation ────────────────────────────────────────────────────
//
// Golden values are the official accrual table for $10,000 face bonds
// (TreasuryDirect CRV math; cross-checked against eyebonds.info, which
// replicates the official redemption tables to the penny). The simulator's
// convention is price per $1 of face value, with the 3-month penalty applied
// while the bond is under five years old — matching what the TreasuryDirect
// calculator reports as the bond's current redemption value.

test("I-bond composite rate matches official examples (rounding + floor)", () => {
  // May 2026 setting: fixed 0.90%, semiannual inflation 1.67% → 4.26% (TD's
  // worked example: 0.0425503 rounds to 0.0426).
  assert.equal(iBondCompositeRate(0.009, 0.0167), 0.0426);
  // 0%-fixed bonds in the same period earn 3.34%; May 2025's 1.10% fixed earns 4.46%.
  assert.equal(iBondCompositeRate(0, 0.0167), 0.0334);
  assert.equal(iBondCompositeRate(0.011, 0.0167), 0.0446);
  // May 2009 deflation (-2.78%) floors the composite at zero even with 3.4% fixed.
  assert.equal(iBondCompositeRate(0.034, -0.0278), 0);
});

test("I-bond value matches the official redemption tables", () => {
  const value = (issueMonth, asOfMonth) => iBondUnitValue({ issueMonth, asOfMonth }).valuePerDollar;
  // Nov 2021 bond (0% fixed, the 7.12% / 9.62% sequence).
  assert.equal(value("2021-11", "2021-11"), 1);        // issue month = face
  assert.equal(value("2021-11", "2022-05"), 1.0176);   // held 6mo, penalty → 3mo accrual
  assert.equal(value("2021-11", "2026-06"), 1.22);     // held 55mo, penalty → Mar 2026 value
  assert.equal(value("2021-11", "2026-11"), 1.2468);   // exactly 60mo: penalty ends
  // May 2008 bond rode the 2009 deflation floor (composite 0 for six months).
  assert.equal(value("2008-05", "2009-08"), 1.0496);
  assert.equal(value("2008-05", "2026-06"), 1.6208);
  // Sep 1998 first-ever issue (3.4% fixed): flat through the floored period.
  assert.equal(value("1998-09", "2009-10"), 1.9652);
  assert.equal(value("1998-09", "2009-12"), 1.9652);
  assert.equal(value("1998-09", "2026-06"), 5.1516);
});

test("I-bond refresh labels sub-12-month bonds as accrued, not redeemable", async () => {
  const assets = [
    { id: "young", symbol: "2026-01", price: 1 },   // 5 months held in June 2026
    { id: "seasoned", symbol: "2021-11", price: 1 } // 55 months held
  ];
  const { results } = await refreshAssetPrices(assets, { fetchImpl: stubFetch([]), now: NOW, privacyMode: true });
  assert.match(results.get("young").message, /Accrued value/);
  assert.match(results.get("young").message, /not redeemable until held 12 months/);
  assert.doesNotMatch(results.get("young").message, /Redemption value/);
  assert.match(results.get("seasoned").message, /Redemption value/);
  assert.match(results.get("seasoned").message, /penalty/);
});

test("I-bond valuation flags penalty status and rejects bad inputs", () => {
  const young = iBondUnitValue({ issueMonth: "2024-01", asOfMonth: "2026-06" });
  assert.equal(young.penaltyApplied, true);
  assert.equal(young.monthsHeld, 29);
  const seasoned = iBondUnitValue({ issueMonth: "1998-09", asOfMonth: "2026-06" });
  assert.equal(seasoned.penaltyApplied, false);

  assert.match(iBondUnitValue({ issueMonth: "1998-08", asOfMonth: "2026-06" }).error, /first issued/);
  assert.match(iBondUnitValue({ issueMonth: "2030-01", asOfMonth: "2026-06" }).error, /future/);
  assert.match(iBondUnitValue({ issueMonth: "garbage", asOfMonth: "2026-06" }).error, /YYYY-MM/);
});

test("I-bond valuation fails honestly past rate-table coverage", () => {
  // Latest setting in the generated table covers period starts through its
  // date + 5 months; a valuation needing a later period must error, not guess.
  const coverage = iBondCoverageThrough();
  assert.match(coverage, /^\d{4}-\d{2}$/);
  const stale = iBondUnitValue({ issueMonth: "2021-11", asOfMonth: "2027-06" });
  assert.match(stale.error, /rate table covers accrual periods starting through/);
  assert.match(stale.error, /generateIBondRates/);
});

// ─── Quote response parsing ──────────────────────────────────────────────

test("parseYahooChart prefers the live market price, then falls back to closes", () => {
  const live = parseYahooChart({
    chart: { result: [{ meta: { regularMarketPrice: 287.31, regularMarketTime: 1765500000, currency: "USD" } }] }
  }, "VTI");
  assert.equal(live.price, 287.31);
  assert.equal(live.priceHint, "market");

  const fallback = parseYahooChart({
    chart: {
      result: [{
        meta: { currency: "USD" },
        timestamp: [1765400000, 1765490000],
        indicators: { quote: [{ close: [286.05, null] }] }
      }]
    }
  }, "VTI");
  assert.equal(fallback.price, 286.05);
  assert.equal(fallback.priceHint, "previousClose");

  assert.throws(() => parseYahooChart({ chart: { error: { description: "No data found, symbol may be delisted" } } }, "ZZZ"),
    /delisted/);
  assert.throws(() => parseYahooChart({}, "ZZZ"), /no data/);
});

test("parseTipsIndexRatio converts the index ratio to a per-$100 par price", () => {
  const quote = parseTipsIndexRatio({ data: [{ index_ratio: "2.07157", index_date: "2026-06-12" }] }, "912810FD5");
  assert.equal(quote.price, 207.157);
  assert.equal(quote.indexRatio, 2.07157);
  assert.throws(() => parseTipsIndexRatio({ data: [] }, "912828YK0"), /only TIPS CUSIPs/);
});

test("quote URLs hit the documented endpoints", () => {
  assert.match(yahooChartUrl("https://query1.finance.yahoo.com", "BRK-B"),
    /^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/BRK-B\?interval=1d&range=5d$/);
  assert.equal(
    localTickerProxyUrl("BRK-B", "http://127.0.0.1:4173/api/price-refresh/yahoo-chart"),
    "http://127.0.0.1:4173/api/price-refresh/yahoo-chart?symbol=BRK-B"
  );
  assert.deepEqual(
    localTickerProxyUrls("VTI", [
      "https://example.com/api/price-refresh/yahoo-chart",
      "https://example.com/.netlify/functions/price-refresh-yahoo-chart"
    ]),
    [
      "https://example.com/api/price-refresh/yahoo-chart?symbol=VTI",
      "https://example.com/.netlify/functions/price-refresh-yahoo-chart?symbol=VTI"
    ]
  );
  const url = fiscalDataTipsUrl("912810FD5", "2026-06-12");
  assert.match(url, /^https:\/\/api\.fiscaldata\.treasury\.gov\/services\/api\/fiscal_service\/v1\/accounting\/od\/tips_cpi_data_detail\?filter=/);
  assert.ok(url.includes(encodeURIComponent("cusip:eq:912810FD5,index_date:lte:2026-06-12")));
});

// ─── Refresh orchestration ───────────────────────────────────────────────

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function stubFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [needle, responder] of routes) {
      if (url.includes(needle)) return responder(url);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

async function invokeListener(listener, url, method = "GET") {
  const req = { method, url };
  const response = {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    }
  };
  await listener(req, response);
  return response;
}

const NOW = new Date(2026, 5, 12); // June 12, 2026 (local time)

test("refreshAssetPrices updates each identified row and flags failures per-row", async () => {
  const assets = [
    { id: "a-vti", symbol: "VTI", price: 100 },
    { id: "a-vti-dup", symbol: "vti", price: 99 },
    { id: "a-flaky", symbol: "VXUS", price: 50 },
    { id: "a-tips", symbol: "912810FD5", price: 180 },
    { id: "a-note", symbol: "912828YK0", price: 98 },
    { id: "a-ibond", symbol: "2021-11", price: 1 },
    { id: "a-manual", price: 42 },
    { id: "a-bad", symbol: "not a symbol!!!", price: 7 }
  ];

  const fetchImpl = stubFetch([
    ["query1.finance.yahoo.com/v8/finance/chart/VTI", () =>
      jsonResponse({ chart: { result: [{ meta: { regularMarketPrice: 287.31, currency: "USD" } }] } })],
    // VXUS: query1 rate-limits, query2 succeeds → fallback host works.
    ["query1.finance.yahoo.com/v8/finance/chart/VXUS", () => jsonResponse({}, 429)],
    ["query2.finance.yahoo.com/v8/finance/chart/VXUS", () =>
      jsonResponse({ chart: { result: [{ meta: { regularMarketPrice: 64.2, currency: "USD" } }] } })],
    ["cusip%3Aeq%3A912810FD5", () => jsonResponse({ data: [{ index_ratio: "2.07157", index_date: "2026-06-11" }] })],
    ["cusip%3Aeq%3A912828YK0", () => jsonResponse({ data: [] })]
  ]);

  const { results, summary } = await refreshAssetPrices(assets, { fetchImpl, now: NOW });

  assert.equal(results.get("a-vti").status, "updated");
  assert.equal(assets[0].price, 287.31);
  // Same ticker in two rows: both update from ONE fetch.
  assert.equal(results.get("a-vti-dup").status, "updated");
  assert.equal(assets[1].price, 287.31);
  assert.equal(fetchImpl.calls.filter((url) => url.includes("chart/VTI")).length, 1);

  assert.equal(results.get("a-flaky").status, "updated");
  assert.equal(assets[2].price, 64.2);

  assert.equal(results.get("a-tips").status, "updated");
  assert.equal(assets[3].price, 207.157);
  assert.match(results.get("a-tips").message, /market premium\/discount not included/);

  assert.equal(results.get("a-note").status, "failed");
  assert.equal(assets[4].price, 98, "failed rows keep their manual price");
  assert.match(results.get("a-note").message, /only TIPS CUSIPs/);

  assert.equal(results.get("a-ibond").status, "updated");
  assert.equal(assets[5].price, 1.22); // Nov 2021 bond in June 2026, penalty applied
  assert.match(results.get("a-ibond").message, /penalty/);

  assert.equal(results.get("a-manual").status, "no-identifier");
  assert.equal(assets[6].price, 42);

  assert.equal(results.get("a-bad").status, "failed");
  assert.match(results.get("a-bad").message, /not a recognizable/);

  assert.deepEqual(summary, { updated: 5, failed: 2, skipped: 0, noIdentifier: 1 });
});

test("ticker refresh uses the local quote proxy before direct Yahoo fetches", async () => {
  const assets = [{ id: "a-vti", symbol: "VTI", price: 100 }];
  const fetchImpl = stubFetch([
    ["127.0.0.1:4173/api/price-refresh/yahoo-chart?symbol=VTI", () =>
      jsonResponse({ chart: { result: [{ meta: { regularMarketPrice: 288.12, currency: "USD" } }] } })],
    ["query1.finance.yahoo.com", () => {
      throw new Error("direct Yahoo fetch should not be needed");
    }]
  ]);

  const { results, summary } = await refreshAssetPrices(assets, {
    fetchImpl,
    now: NOW,
    tickerProxyBaseUrl: "http://127.0.0.1:4173/api/price-refresh/yahoo-chart"
  });

  assert.equal(results.get("a-vti").status, "updated");
  assert.equal(assets[0].price, 288.12);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0], /\/api\/price-refresh\/yahoo-chart\?symbol=VTI$/);
  assert.deepEqual(summary, { updated: 1, failed: 0, skipped: 0, noIdentifier: 0 });
});

test("ticker refresh can fall through to a deployed function proxy path", async () => {
  const assets = [{ id: "a-vti", symbol: "VTI", price: 100 }];
  const fetchImpl = stubFetch([
    ["example.com/api/price-refresh/yahoo-chart?symbol=VTI", () => jsonResponse({ error: "Not found" }, 404)],
    ["example.com/.netlify/functions/price-refresh-yahoo-chart?symbol=VTI", () =>
      jsonResponse({ chart: { result: [{ meta: { regularMarketPrice: 289.44, currency: "USD" } }] } })],
    ["query1.finance.yahoo.com", () => {
      throw new Error("direct Yahoo fetch should not be needed after function proxy succeeds");
    }]
  ]);

  const { results, summary } = await refreshAssetPrices(assets, {
    fetchImpl,
    now: NOW,
    tickerProxyBaseUrl: [
      "https://example.com/api/price-refresh/yahoo-chart",
      `https://example.com${NETLIFY_PRICE_REFRESH_PROXY_PATH}`
    ]
  });

  assert.equal(results.get("a-vti").status, "updated");
  assert.equal(assets[0].price, 289.44);
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0], /\/api\/price-refresh\/yahoo-chart\?symbol=VTI$/);
  assert.match(fetchImpl.calls[1], /\/\.netlify\/functions\/price-refresh-yahoo-chart\?symbol=VTI$/);
  assert.deepEqual(summary, { updated: 1, failed: 0, skipped: 0, noIdentifier: 0 });
});

test("default browser ticker refresh tries every bundled same-origin proxy path", async () => {
  const assets = [{ id: "a-vti", symbol: "VTI", price: 100 }];
  const previousLocation = globalThis.location;
  Object.defineProperty(globalThis, "location", {
    value: { protocol: "https:", origin: "https://example.com", href: "https://example.com/" },
    configurable: true
  });
  const fetchImpl = stubFetch([
    ["example.com/api/price-refresh/yahoo-chart?symbol=VTI", () => jsonResponse({ error: "Not found" }, 404)],
    ["example.com/.netlify/functions/price-refresh-yahoo-chart?symbol=VTI", () =>
      jsonResponse({ chart: { result: [{ meta: { regularMarketPrice: 290.01, currency: "USD" } }] } })],
    ["query1.finance.yahoo.com", () => {
      throw new Error("direct Yahoo fetch should not be needed after the bundled function proxy succeeds");
    }]
  ]);

  try {
    const { results, summary } = await refreshAssetPrices(assets, { fetchImpl, now: NOW });

    assert.equal(results.get("a-vti").status, "updated");
    assert.equal(assets[0].price, 290.01);
    assert.equal(fetchImpl.calls.length, 2);
    assert.match(fetchImpl.calls[0], /\/api\/price-refresh\/yahoo-chart\?symbol=VTI$/);
    assert.match(fetchImpl.calls[1], /\/\.netlify\/functions\/price-refresh-yahoo-chart\?symbol=VTI$/);
    assert.deepEqual(summary, { updated: 1, failed: 0, skipped: 0, noIdentifier: 0 });
  } finally {
    if (previousLocation === undefined) {
      delete globalThis.location;
    } else {
      Object.defineProperty(globalThis, "location", {
        value: previousLocation,
        configurable: true
      });
    }
  }
});

test("shared quote proxy response returns browser-readable JSON", async () => {
  const upstreamCalls = [];
  const fetchImpl = async (url, options) => {
    upstreamCalls.push({ url, headers: options.headers });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        chart: { result: [{ meta: { regularMarketPrice: 288.12, currency: "USD" } }] }
      })
    };
  };

  const result = await yahooQuoteProxyResponse({ symbol: "vti", method: "GET", fetchImpl });
  const payload = JSON.parse(result.body);

  assert.equal(result.status, 200);
  assert.equal(result.headers["access-control-allow-origin"], "*");
  assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(payload.chart.result[0].meta.regularMarketPrice, 288.12);
  assert.match(upstreamCalls[0].url, /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/VTI\?/);
});

test("local dev server proxies ticker quotes as same-origin JSON", async () => {
  const upstreamCalls = [];
  const fetchImpl = async (url, options) => {
    upstreamCalls.push({ url, headers: options.headers });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        chart: { result: [{ meta: { regularMarketPrice: 288.12, currency: "USD" } }] }
      })
    };
  };
  const listener = createRequestListener({ fetchImpl });

  const response = await invokeListener(listener, `${PRICE_REFRESH_PROXY_PATH}?symbol=vti`);
  const payload = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(payload.chart.result[0].meta.regularMarketPrice, 288.12);
  assert.equal(upstreamCalls.length, 1);
  assert.match(upstreamCalls[0].url, /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/VTI\?/);
  assert.equal(upstreamCalls[0].headers.accept, "application/json");
  assert.match(upstreamCalls[0].headers["user-agent"], /PortfolioSuccessLab/);
});

test("local static server 405 copy matches the supported methods", async () => {
  const listener = createRequestListener({ fetchImpl: stubFetch([]) });
  const response = await invokeListener(listener, "/index.html", "POST");
  const payload = JSON.parse(response.body);

  assert.equal(response.status, 405);
  assert.match(payload.error, /GET and HEAD/);
});

test("privacy mode blocks network quotes but still computes I-bond values locally", async () => {
  const assets = [
    { id: "t", symbol: "VTI", price: 100 },
    { id: "c", symbol: "912810FD5", price: 180 },
    { id: "i", symbol: "2021-11", price: 1 }
  ];
  const fetchImpl = stubFetch([]); // any network call would throw
  const { results, summary } = await refreshAssetPrices(assets, { fetchImpl, now: NOW, privacyMode: true });

  assert.equal(results.get("t").status, "skipped-privacy");
  assert.equal(assets[0].price, 100);
  assert.equal(results.get("c").status, "skipped-privacy");
  assert.equal(results.get("i").status, "updated");
  assert.equal(assets[2].price, 1.22);
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(summary, { updated: 1, failed: 0, skipped: 2, noIdentifier: 0 });
});

test("summary counts every asset even when two holdings share an id", async () => {
  // Imported holdings get slugify(name) ids, so two rows with the same name
  // collide. Prices must still both update, and the roll-up must count both
  // (the per-row highlight is shared by id, which is acceptable).
  const assets = [
    { id: "dup", symbol: "2021-11", price: 1 },
    { id: "dup", symbol: "2008-05", price: 1 }
  ];
  const { results, summary } = await refreshAssetPrices(assets, {
    fetchImpl: stubFetch([]),
    now: NOW,
    privacyMode: true
  });
  assert.equal(assets[0].price, 1.22);
  assert.equal(assets[1].price, 1.6208);
  assert.equal(results.size, 1, "highlight state collapses by id");
  assert.deepEqual(summary, { updated: 2, failed: 0, skipped: 0, noIdentifier: 0 });
});

test("refreshSummaryText reads like a status line", () => {
  const text = refreshSummaryText({
    summary: { updated: 3, failed: 1, skipped: 2, noIdentifier: 4 },
    asOf: "2026-06-12"
  });
  assert.equal(text, "3 prices updated, 1 failed (highlighted), 2 blocked by privacy mode, 4 without a symbol — 2026-06-12.");
  assert.equal(refreshSummaryText(), "Price refresh did not run.");
});
