import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_PORT = 4173;
export const PRICE_REFRESH_PROXY_PATH = "/api/price-refresh/yahoo-chart";

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const YAHOO_CHART_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const TICKER_PATTERN = /^[A-Z0-9.^=-]{1,12}$/i;
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"]
]);

export function createDevServer({
  rootDir = DEFAULT_ROOT,
  fetchImpl = globalThis.fetch,
  yahooHosts = YAHOO_CHART_HOSTS
} = {}) {
  return createServer(createRequestListener({ rootDir, fetchImpl, yahooHosts }));
}

export function createRequestListener({
  rootDir = DEFAULT_ROOT,
  fetchImpl = globalThis.fetch,
  yahooHosts = YAHOO_CHART_HOSTS
} = {}) {
  const root = resolve(rootDir);

  return async function requestListener(req, res) {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === PRICE_REFRESH_PROXY_PATH) {
        await handleYahooProxy(req, res, requestUrl, { fetchImpl, yahooHosts });
        return;
      }
      await serveStatic(req, res, requestUrl, root);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

async function handleYahooProxy(req, res, requestUrl, { fetchImpl, yahooHosts }) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type"
    });
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Only GET is supported for quote refresh." });
    return;
  }
  if (typeof fetchImpl !== "function") {
    sendJson(res, 503, { error: "This Node runtime does not provide fetch()." });
    return;
  }

  const symbol = String(requestUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!TICKER_PATTERN.test(symbol)) {
    sendJson(res, 400, { error: "Enter a ticker symbol such as VTI, BRK-B, or VOD.L." });
    return;
  }

  const errors = [];
  for (const host of yahooHosts) {
    const upstreamUrl = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    try {
      const response = await fetchImpl(upstreamUrl, {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 PortfolioSuccessLab/0.1 (+local price refresh)"
        }
      });
      const body = await response.text();
      if (!response.ok) {
        errors.push(`${new URL(host).host}: HTTP ${response.status}`);
        continue;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      if (req.method !== "HEAD") res.end(body);
      else res.end();
      return;
    } catch (error) {
      errors.push(`${new URL(host).host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  sendJson(res, 502, {
    error: `${symbol}: Yahoo Finance quote request failed through the local proxy.`,
    details: errors
  });
}

async function serveStatic(req, res, requestUrl, root) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Only GET is supported by the local static server." });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    sendJson(res, 400, { error: "Malformed URL path." });
    return;
  }
  if (pathname === "/") pathname = "/index.html";

  const filePath = resolve(root, `.${pathname}`);
  if (!isInsideRoot(filePath, root)) {
    sendJson(res, 403, { error: "Path is outside the project root." });
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  if (!fileStat.isFile()) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  res.writeHead(200, {
    "content-type": MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream",
    "content-length": fileStat.size,
    "cache-control": "no-cache"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function isInsideRoot(filePath, root) {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return filePath === root || filePath.startsWith(normalizedRoot);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT || process.argv[2] || DEFAULT_PORT);
  const server = createDevServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Portfolio Success Lab: http://127.0.0.1:${port}/`);
  });
}
