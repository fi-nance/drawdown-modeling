export const PRICE_REFRESH_PROXY_PATH = "/api/price-refresh/yahoo-chart";
export const NETLIFY_PRICE_REFRESH_PROXY_PATH = "/.netlify/functions/price-refresh-yahoo-chart";

const YAHOO_CHART_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const TICKER_PATTERN = /^[A-Z0-9.^=-]{1,12}$/i;

export function normalizeTickerSymbol(raw) {
  const symbol = String(raw ?? "").trim().toUpperCase();
  return TICKER_PATTERN.test(symbol) ? symbol : null;
}

export async function yahooQuoteProxyResponse({
  symbol,
  method = "GET",
  fetchImpl = globalThis.fetch,
  yahooHosts = YAHOO_CHART_HOSTS
} = {}) {
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "content-type"
  };

  if (method === "OPTIONS") {
    return { status: 204, headers: corsHeaders, body: "" };
  }
  if (method !== "GET" && method !== "HEAD") {
    return jsonProxyResponse(405, { error: "Only GET is supported for quote refresh." }, corsHeaders);
  }
  if (typeof fetchImpl !== "function") {
    return jsonProxyResponse(503, { error: "This runtime does not provide fetch()." }, corsHeaders);
  }

  const ticker = normalizeTickerSymbol(symbol);
  if (!ticker) {
    return jsonProxyResponse(400, { error: "Enter a ticker symbol such as VTI, BRK-B, or VOD.L." }, corsHeaders);
  }

  const errors = [];
  for (const host of yahooHosts) {
    const upstreamUrl = `${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    try {
      const response = await fetchImpl(upstreamUrl, {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 PortfolioSuccessLab/0.1 (+price refresh proxy)"
        }
      });
      const body = await response.text();
      if (!response.ok) {
        errors.push(`${new URL(host).host}: HTTP ${response.status}`);
        continue;
      }
      return {
        status: 200,
        headers: {
          ...corsHeaders,
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        },
        body: method === "HEAD" ? "" : body
      };
    } catch (error) {
      errors.push(`${new URL(host).host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return jsonProxyResponse(502, {
    error: `${ticker}: Yahoo Finance quote request failed through the quote proxy.`,
    details: errors
  }, corsHeaders);
}

function jsonProxyResponse(status, payload, extraHeaders = {}) {
  return {
    status,
    headers: {
      ...extraHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}
