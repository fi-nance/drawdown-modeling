import { yahooQuoteProxyResponse } from "../../scripts/yahooQuoteProxy.mjs";

export default async function handler(req, res) {
  const result = await yahooQuoteProxyResponse({
    symbol: req.query?.symbol,
    method: req.method
  });
  for (const [key, value] of Object.entries(result.headers)) {
    res.setHeader(key, value);
  }
  res.status(result.status).send(result.body);
}
