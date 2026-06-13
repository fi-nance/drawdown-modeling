import { yahooQuoteProxyResponse } from "../../../scripts/yahooQuoteProxy.mjs";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const result = await yahooQuoteProxyResponse({
    symbol: url.searchParams.get("symbol"),
    method: context.request.method,
    fetchImpl: context.env?.fetch ?? fetch
  });
  return new Response(result.body, {
    status: result.status,
    headers: result.headers
  });
}
