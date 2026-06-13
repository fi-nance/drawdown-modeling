import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PRICE_REFRESH_PROXY_PATH,
  yahooQuoteProxyResponse
} from "./yahooQuoteProxy.mjs";

export const DEFAULT_PORT = 4173;
export { PRICE_REFRESH_PROXY_PATH };

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));
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
  yahooHosts
} = {}) {
  return createServer(createRequestListener({ rootDir, fetchImpl, yahooHosts }));
}

export function createRequestListener({
  rootDir = DEFAULT_ROOT,
  fetchImpl = globalThis.fetch,
  yahooHosts
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
  const result = await yahooQuoteProxyResponse({
    symbol: requestUrl.searchParams.get("symbol"),
    method: req.method,
    fetchImpl,
    yahooHosts
  });
  res.writeHead(result.status, result.headers);
  res.end(result.body);
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
