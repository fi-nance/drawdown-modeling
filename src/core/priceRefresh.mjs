// On-demand portfolio price refresh.
//
// Assets carry an optional `symbol` identifier that tells the refresher how to
// price the row. Three identifier shapes are recognized:
//
//   ticker         "VTI", "BRK-B", "VOD.L"  → local same-origin Yahoo chart
//                  proxy (regular-market price, falling back to the previous
//                  close). Browser CORS blocks direct Yahoo reads.
//   Treasury CUSIP "912810SV1" (9 chars,    → FiscalData "TIPS and CPI Data"
//                  valid check digit)         daily index ratio. Price is the
//                                             inflation-adjusted principal per
//                                             $100 face AT PAR — the market
//                                             premium/discount is not included
//                                             (no public CORS-enabled EOD quote
//                                             source exists for Treasuries;
//                                             FedInvest publishes one but
//                                             without CORS headers). Non-TIPS
//                                             CUSIPs are reported as failures.
//   I-bond month   "2021-11" / "11/2021"    → computed locally (no network)
//                                             from the official TreasuryDirect
//                                             rate history embedded at build
//                                             time. Price is the redemption
//                                             value per $1 of face value, with
//                                             the 3-month early-redemption
//                                             penalty applied under 5 years.
//
// Refreshes are USER-TRIGGERED only — prices never change underneath a saved
// scenario without an explicit click, so outcome comparisons stay stable.
// Every row reports a status so the UI can highlight rows that did not update.

import { I_BOND_FIXED_RATES, I_BOND_INFLATION_RATES } from "../data/iBondRates.generated.mjs";

const YAHOO_CHART_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const LOCAL_TICKER_PROXY_PATH = "/api/price-refresh/yahoo-chart";
const NETLIFY_TICKER_PROXY_PATH = "/.netlify/functions/price-refresh-yahoo-chart";
const FISCAL_DATA_TIPS_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/tips_cpi_data_detail";
const I_BOND_PENALTY_MONTHS = 3;
const I_BOND_PENALTY_HORIZON_MONTHS = 60;

// ─── Identifier classification ───────────────────────────────────────────

export function classifyPriceIdentifier(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { type: "none" };

  const ibondMonth = parseIssueMonth(text);
  if (ibondMonth) return { type: "ibond", value: ibondMonth };

  const compact = text.toUpperCase().replace(/\s+/g, "");
  if (/^[0-9A-Z]{9}$/.test(compact) && isValidCusip(compact)) {
    return { type: "cusip", value: compact };
  }

  if (/^[A-Z0-9.^=-]{1,12}$/i.test(compact)) {
    return { type: "ticker", value: compact };
  }
  return { type: "invalid", value: text };
}

// Accepts "2021-11", "2021/11", "11/2021", "2021-11-15" (day ignored: I bonds
// are issued as of the 1st of the month).
function parseIssueMonth(text) {
  let match = text.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/);
  let year;
  let month;
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
  } else {
    match = text.match(/^(\d{1,2})[-/](\d{4})$/);
    if (!match) return null;
    month = Number(match[1]);
    year = Number(match[2]);
  }
  if (month < 1 || month > 12 || year < 1900 || year > 2200) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

// Standard CUSIP check digit (modulus 10 "double-add-double").
export function isValidCusip(cusip) {
  const text = String(cusip ?? "").toUpperCase();
  if (!/^[0-9A-Z@#*]{9}$/.test(text)) return false;
  let sum = 0;
  for (let index = 0; index < 8; index += 1) {
    const char = text[index];
    let value;
    if (char >= "0" && char <= "9") value = char.charCodeAt(0) - 48;
    else if (char >= "A" && char <= "Z") value = char.charCodeAt(0) - 55;
    else if (char === "*") value = 36;
    else if (char === "@") value = 37;
    else value = 38; // '#'
    if (index % 2 === 1) value *= 2;
    sum += Math.floor(value / 10) + (value % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(text[8]);
}

// ─── Series I savings bond valuation ─────────────────────────────────────
//
// Official method (31 CFR 359; matches the TreasuryDirect calculator):
//   composite = [fixed + 2·inflation + fixed·inflation], rounded to 4 decimal
//   places, floored at zero. Values accrue per $25 denomination unit: within a
//   six-month rate period the month-m value is round(base · (1 + composite/2)^(m/6), 2)
//   and the rounded month-6 value becomes the next period's base. Bonds held
//   under five years forfeit the latest three months of interest.

export function iBondCompositeRate(fixedRate, inflationRate) {
  const raw = fixedRate + 2 * inflationRate + fixedRate * inflationRate;
  return Math.max(0, Math.round(raw * 10000) / 10000);
}

function monthIndex(yyyyMm) {
  const [year, month] = String(yyyyMm).split("-").map(Number);
  return year * 12 + (month - 1);
}

function monthLabel(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function latestRateAtOrBefore(rates, targetMonthIndex) {
  let found = null;
  for (const entry of rates) {
    if (monthIndex(entry.date.slice(0, 7)) <= targetMonthIndex) found = entry;
    else break;
  }
  return found;
}

// Last period-start month with a known inflation rate (a setting covers the
// six months that follow it).
export function iBondCoverageThrough(inflationRates = I_BOND_INFLATION_RATES) {
  const latest = inflationRates[inflationRates.length - 1];
  return monthLabel(monthIndex(latest.date.slice(0, 7)) + 5);
}

export function iBondUnitValue({
  issueMonth,
  asOfMonth,
  fixedRates = I_BOND_FIXED_RATES,
  inflationRates = I_BOND_INFLATION_RATES
} = {}) {
  const issue = monthIndex(issueMonth);
  const asOf = monthIndex(asOfMonth);
  if (!Number.isFinite(issue) || !Number.isFinite(asOf)) {
    return { error: `I-bond months must be YYYY-MM; got issue "${issueMonth}", as-of "${asOfMonth}".` };
  }
  const firstIssue = monthIndex(fixedRates[0].date.slice(0, 7));
  if (issue < firstIssue) {
    return { error: `Series I bonds were first issued ${fixedRates[0].date.slice(0, 7)}; got ${issueMonth}.` };
  }
  if (asOf < issue) {
    return { error: `I bond issued ${issueMonth} has no value as of ${asOfMonth} (issued in the future).` };
  }

  const fixedEntry = latestRateAtOrBefore(fixedRates, issue);
  const monthsHeld = asOf - issue;
  const penaltyApplied = monthsHeld < I_BOND_PENALTY_HORIZON_MONTHS;
  const effectiveMonths = penaltyApplied ? Math.max(0, monthsHeld - I_BOND_PENALTY_MONTHS) : monthsHeld;

  let base = 25;
  let value = 25;
  let currentCompositeRate = 0;
  // Strictly below: the value AT an exact period boundary is the prior
  // period's rounded close and must not demand the next period's rate.
  for (let periodStart = 0; periodStart < effectiveMonths; periodStart += 6) {
    const inflationEntry = latestRateAtOrBefore(inflationRates, issue + periodStart);
    if (!inflationEntry) {
      return { error: `No inflation rate covers ${monthLabel(issue + periodStart)}.` };
    }
    const settingAge = (issue + periodStart) - monthIndex(inflationEntry.date.slice(0, 7));
    if (settingAge > 5) {
      return {
        error: `The embedded I-bond rate table covers accrual periods starting through ${iBondCoverageThrough(inflationRates)};`
          + ` this bond's period starting ${monthLabel(issue + periodStart)} needs a newer rate`
          + ` (regenerate with: node scripts/generateIBondRates.mjs).`
      };
    }
    const composite = iBondCompositeRate(fixedEntry.rate, inflationEntry.rate);
    currentCompositeRate = composite;
    const monthsIntoPeriod = Math.min(6, effectiveMonths - periodStart);
    value = round2(base * Math.pow(1 + composite / 2, monthsIntoPeriod / 6));
    if (monthsIntoPeriod === 6) base = value;
  }

  return {
    value25: value,
    valuePerDollar: Math.round((value / 25) * 1e6) / 1e6,
    monthsHeld,
    penaltyApplied,
    fixedRate: fixedEntry.rate,
    currentCompositeRate
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ─── Quote sources ────────────────────────────────────────────────────────

export function yahooChartUrl(host, symbol) {
  return `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
}

export function localTickerProxyUrl(symbol, baseUrl = defaultTickerProxyBaseUrl()) {
  if (!baseUrl) return null;
  const documentUrl = globalThis.location?.href ?? "http://127.0.0.1/";
  const url = new URL(baseUrl, documentUrl);
  url.searchParams.set("symbol", symbol);
  return url.toString();
}

export function localTickerProxyUrls(symbol, baseUrls = defaultTickerProxyBaseUrls()) {
  const urls = Array.isArray(baseUrls) ? baseUrls : [baseUrls];
  return urls.map((baseUrl) => localTickerProxyUrl(symbol, baseUrl)).filter(Boolean);
}

function defaultTickerProxyBaseUrl() {
  return defaultTickerProxyBaseUrls()[0] ?? null;
}

function defaultTickerProxyBaseUrls() {
  const location = globalThis.location;
  if (!location || location.protocol === "file:") return [];
  return [
    `${location.origin}${LOCAL_TICKER_PROXY_PATH}`,
    `${location.origin}${NETLIFY_TICKER_PROXY_PATH}`
  ];
}

// Returns { price, priceHint, asOf } or throws with a human-readable reason.
export function parseYahooChart(payload, symbol) {
  const result = payload?.chart?.result?.[0];
  const apiError = payload?.chart?.error;
  if (apiError?.description || apiError?.code) {
    throw new Error(`${symbol}: ${apiError.description ?? apiError.code}`);
  }
  if (!result?.meta) throw new Error(`${symbol}: quote response had no data.`);
  const meta = result.meta;
  if (Number.isFinite(meta.regularMarketPrice) && meta.regularMarketPrice > 0) {
    return {
      price: meta.regularMarketPrice,
      priceHint: "market",
      asOf: Number.isFinite(meta.regularMarketTime) ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      currency: meta.currency ?? null
    };
  }
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(closes[index]) && closes[index] > 0) {
      const stamp = result.timestamp?.[index];
      return {
        price: closes[index],
        priceHint: "previousClose",
        asOf: Number.isFinite(stamp) ? new Date(stamp * 1000).toISOString() : null,
        currency: meta.currency ?? null
      };
    }
  }
  if (Number.isFinite(meta.chartPreviousClose) && meta.chartPreviousClose > 0) {
    return { price: meta.chartPreviousClose, priceHint: "previousClose", asOf: null, currency: meta.currency ?? null };
  }
  throw new Error(`${symbol}: no usable price in quote response.`);
}

async function fetchTickerQuote(symbol, fetchImpl, tickerProxyBaseUrl) {
  const attempts = [];
  for (const proxyUrl of localTickerProxyUrls(symbol, tickerProxyBaseUrl)) {
    attempts.push({ label: "same-origin quote proxy", url: proxyUrl });
  }
  for (const host of YAHOO_CHART_HOSTS) {
    attempts.push({ label: new URL(host).host, url: yahooChartUrl(host, symbol) });
  }

  const errors = [];
  for (const attempt of attempts) {
    try {
      const response = await fetchImpl(attempt.url, { headers: { accept: "application/json" } });
      if (!response.ok) {
        errors.push(`${attempt.label}: HTTP ${response.status}`);
        continue;
      }
      return parseYahooChart(await response.json(), symbol);
    } catch (error) {
      errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const suffix = tickerProxyBaseUrl
    ? ""
    : " This deployment needs a same-domain quote proxy; use `npm start` locally or deploy the included Vercel, Netlify, or Cloudflare Pages function.";
  throw new Error(`${symbol}: quote request failed (${errors.join("; ")}).${suffix}`);
}

export function fiscalDataTipsUrl(cusip, asOfDate) {
  const filter = `cusip:eq:${cusip},index_date:lte:${asOfDate}`;
  return `${FISCAL_DATA_TIPS_URL}?filter=${encodeURIComponent(filter)}&sort=-index_date&page%5Bsize%5D=1`;
}

// Returns { price, indexRatio, indexDate } (price per $100 face at par).
export function parseTipsIndexRatio(payload, cusip) {
  const row = payload?.data?.[0];
  if (!row) {
    throw new Error(
      `${cusip}: not in the Treasury TIPS index-ratio dataset — only TIPS CUSIPs can auto-update`
      + ` (other Treasuries have no browser-accessible end-of-day price source); update this price manually.`
    );
  }
  const ratio = Number(row.index_ratio);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new Error(`${cusip}: TIPS index ratio response was not numeric.`);
  }
  return {
    price: Math.round(ratio * 100 * 10000) / 10000,
    indexRatio: ratio,
    indexDate: row.index_date ?? null
  };
}

async function fetchTipsPrice(cusip, fetchImpl, asOfDate) {
  const response = await fetchImpl(fiscalDataTipsUrl(cusip, asOfDate), { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${cusip}: FiscalData request failed (HTTP ${response.status}).`);
  return parseTipsIndexRatio(await response.json(), cusip);
}

// ─── Refresh orchestration ────────────────────────────────────────────────

// Refreshes every asset that carries an identifier. Returns per-asset results
// keyed by asset id plus a roll-up summary; assets are mutated in place
// (price only). `now` and `fetchImpl` are injectable for tests.
export async function refreshAssetPrices(assets = [], {
  fetchImpl = globalThis.fetch,
  now = new Date(),
  privacyMode = false,
  tickerProxyBaseUrl = defaultTickerProxyBaseUrls()
} = {}) {
  const asOfDate = isoDate(now);
  const asOfMonth = asOfDate.slice(0, 7);
  const results = new Map();
  const fetchCache = new Map();

  const lookups = assets.map((asset) => ({ asset, classified: classifyPriceIdentifier(asset.symbol) }));

  // `record` stores each asset's outcome by id (for the per-row UI highlight)
  // AND returns it, so the roll-up below counts PER ASSET — two holdings that
  // happen to share an id (e.g. duplicate import names) each still count.
  const record = (asset, entry) => {
    results.set(asset.id, entry);
    return entry;
  };

  const records = await Promise.all(lookups.map(async ({ asset, classified }) => {
    const { type, value } = classified;
    if (type === "none") {
      return record(asset, { status: "no-identifier" });
    }
    if (type === "invalid") {
      return record(asset, {
        status: "failed",
        message: `"${value}" is not a recognizable ticker, CUSIP, or I-bond purchase month (use e.g. VTI, 912810SV1, or 2021-11).`
      });
    }

    if (type === "ibond") {
      const valuation = iBondUnitValue({ issueMonth: value, asOfMonth });
      if (valuation.error) {
        return record(asset, { status: "failed", message: valuation.error });
      }
      asset.price = valuation.valuePerDollar;
      // I bonds can't be cashed in the first 12 months, so under a year the
      // figure is a mark-to-market accrued value, not a redeemable one; from
      // 12-59 months it's the redemption value net of the 3-month penalty.
      const notYetRedeemable = valuation.monthsHeld < 12;
      const note = notYetRedeemable
        ? "; not redeemable until held 12 months"
        : (valuation.penaltyApplied ? "; 3-month early-redemption penalty applied" : "");
      return record(asset, {
        status: "updated",
        price: valuation.valuePerDollar,
        source: "I-bond rate table",
        message: `${notYetRedeemable ? "Accrued value" : "Redemption value"} per $1 face`
          + ` (issued ${value}; units = face value in dollars${note}).`
      });
    }

    if (privacyMode) {
      return record(asset, {
        status: "skipped-privacy",
        message: "Privacy mode blocks external quote lookups; only I-bond values (computed locally) refresh."
      });
    }
    if (typeof fetchImpl !== "function") {
      return record(asset, { status: "failed", message: "No network fetch available in this environment." });
    }

    const cacheKey = `${type}:${value}`;
    if (!fetchCache.has(cacheKey)) {
      fetchCache.set(cacheKey, (type === "ticker"
        ? fetchTickerQuote(value, fetchImpl, tickerProxyBaseUrl)
        : fetchTipsPrice(value, fetchImpl, asOfDate)
      ).then(
        (quote) => ({ ok: true, quote }),
        (error) => ({ ok: false, message: error?.message ?? String(error) })
      ));
    }
    const outcome = await fetchCache.get(cacheKey);
    if (!outcome.ok) {
      return record(asset, { status: "failed", message: outcome.message });
    }
    asset.price = outcome.quote.price;
    return record(asset, {
      status: "updated",
      price: outcome.quote.price,
      source: type === "ticker" ? "Yahoo Finance" : "Treasury TIPS index ratio",
      message: type === "ticker"
        ? (outcome.quote.priceHint === "market" ? `Market price for ${value}.` : `Previous close for ${value}.`)
        : `Inflation-adjusted principal per $100 face at par (index ratio ${outcome.quote.indexRatio}`
          + `${outcome.quote.indexDate ? ` as of ${outcome.quote.indexDate}` : ""}); market premium/discount not included.`
    });
  }));

  const summary = { updated: 0, failed: 0, skipped: 0, noIdentifier: 0 };
  for (const result of records) {
    if (result.status === "updated") summary.updated += 1;
    else if (result.status === "failed") summary.failed += 1;
    else if (result.status === "skipped-privacy") summary.skipped += 1;
    else summary.noIdentifier += 1;
  }
  return { results, summary, asOf: asOfDate };
}

export function refreshSummaryText({ summary, asOf } = {}) {
  if (!summary) return "Price refresh did not run.";
  const parts = [];
  parts.push(`${summary.updated} price${summary.updated === 1 ? "" : "s"} updated`);
  if (summary.failed) parts.push(`${summary.failed} failed (highlighted)`);
  if (summary.skipped) parts.push(`${summary.skipped} blocked by privacy mode`);
  if (summary.noIdentifier) parts.push(`${summary.noIdentifier} without a symbol`);
  return `${parts.join(", ")} — ${asOf}.`;
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
