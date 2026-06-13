import { yahooQuoteProxyResponse } from "../../scripts/yahooQuoteProxy.mjs";

export async function handler(event) {
  const result = await yahooQuoteProxyResponse({
    symbol: event.queryStringParameters?.symbol,
    method: event.httpMethod
  });
  return {
    statusCode: result.status,
    headers: result.headers,
    body: result.body
  };
}
