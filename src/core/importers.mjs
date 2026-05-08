import { slugify } from "./utils.mjs";

const VALID_ACCOUNT_TYPES = new Set(["taxable", "traditional", "roth", "hsa"]);
export const VALID_ASSET_CLASSES = new Set(["stock", "bond", "cash", "realEstate", "tips", "crypto"]);
const REQUIRED_PORTFOLIO_HEADERS = ["accountType", "units", "price"];

const HEADER_ALIASES = buildAliasMap({
  id: ["id", "asset id", "lot id"],
  name: ["name", "asset name", "holding", "holding name", "ticker"],
  accountType: ["accountType", "account type", "account", "tax account", "tax treatment"],
  assetClass: ["assetClass", "asset class", "class", "asset type", "investment type"],
  units: ["units", "unit", "shares", "share count", "quantity", "qty"],
  price: ["price", "current price", "market price", "share price", "price per unit", "price/unit"],
  costBasisPerUnit: [
    "costBasisPerUnit",
    "cost basis per unit",
    "cost basis/unit",
    "cost basis per share",
    "cost basis/share",
    "basis per unit",
    "basis/share",
    "cost basis",
    "basis"
  ],
  dividendYield: ["dividendYield", "dividend yield", "annual dividend yield", "yield", "income yield"],
  qualifiedDividendShare: [
    "qualifiedDividendShare",
    "qualified dividend share",
    "qualified dividend percent",
    "qualified dividend percentage",
    "qualified dividend %",
    "qualified %",
    "qualified share",
    "qualified"
  ],
  holdingPeriod: ["holdingPeriod", "holding period", "holding term", "term", "long short", "long/short"]
});

const ACCOUNT_TYPE_ALIASES = buildAliasMap({
  taxable: ["taxable", "brokerage", "taxable brokerage", "individual", "joint"],
  traditional: [
    "traditional",
    "ira",
    "traditional ira",
    "traditional 401k",
    "traditional 401(k)",
    "pre tax",
    "pre-tax",
    "pretax",
    "pre tax 401k",
    "pre-tax 401k",
    "pretax 401k",
    "pre tax 401(k)",
    "pre-tax 401(k)",
    "pretax 401(k)",
    "401k",
    "401(k)",
    "403b",
    "403(b)"
  ],
  roth: [
    "roth",
    "roth ira",
    "roth 401k",
    "roth 401(k)",
    "after tax",
    "after-tax",
    "aftertax",
    "after tax 401k",
    "after-tax 401k",
    "aftertax 401k",
    "after tax 401(k)",
    "after-tax 401(k)",
    "aftertax 401(k)"
  ],
  hsa: ["hsa", "health savings account"]
});

const ASSET_CLASS_ALIASES = buildAliasMap({
  stock: ["stock", "stocks", "equity", "equities"],
  bond: ["bond", "bonds", "fixed income", "fixed-income"],
  cash: ["cash", "money market", "money-market", "savings"],
  realEstate: ["realEstate", "real estate", "reit", "reits"],
  tips: ["tips", "tip", "treasury inflation protected securities", "inflation protected"],
  crypto: ["crypto", "cryptocurrency", "digital asset", "bitcoin", "btc"]
});

const HOLDING_PERIOD_ALIASES = buildAliasMap({
  long: ["long", "long term", "long-term", "lt"],
  short: ["short", "short term", "short-term", "st"]
});

export function parsePortfolioJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }

  const assets = Array.isArray(parsed) ? parsed : parsed.assets;
  if (!Array.isArray(assets)) {
    throw new Error("Portfolio JSON must be an array or an object with an assets array.");
  }

  return assets.map((asset, index) => normalizeImportedAsset(asset, index));
}

export function parsePortfolioCsv(text) {
  const assets = rowsToAssets(parseCsvRows(text));
  return normalizeImportedAssets(assets);
}

export function parsePortfolioRows(rows = []) {
  if (!Array.isArray(rows)) {
    throw new Error("Portfolio sheet data must be an array of rows.");
  }
  const assets = rowsToAssets(rows.map((row) => Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []));
  return normalizeImportedAssets(assets);
}

function normalizeImportedAssets(assets) {
  if (!assets.length) {
    throw new Error("Portfolio CSV must include a header row and at least one asset row.");
  }
  const headers = new Set(Object.keys(assets[0] ?? {}));
  if (!REQUIRED_PORTFOLIO_HEADERS.every((header) => headers.has(header))) {
    const found = [...headers].filter(Boolean).join(", ") || "none";
    throw new Error(`Portfolio CSV headers must include accountType, units, and price. Found: ${found}. Headers like Account Type, Shares, and Price are accepted.`);
  }
  return assets.map((asset, index) => normalizeImportedAsset(asset, index));
}

export function googleSpreadsheetIdFromInput(rawInput = "") {
  const trimmed = String(rawInput ?? "").trim();
  if (!trimmed) return "";

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (url.hostname !== "docs.google.com" || !url.pathname.includes("/spreadsheets/")) {
    return trimmed;
  }
  const match = url.pathname.match(/\/spreadsheets\/d\/(?!e\/)([^/]+)/);
  return match?.[1] ?? "";
}

export function toGoogleCsvUrl(rawUrl = "") {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return "";

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (url.hostname !== "docs.google.com" || !url.pathname.includes("/spreadsheets/")) {
    return trimmed;
  }
  if (isGoogleCsvUrl(url)) return trimmed;

  const gid = googleSheetGid(url);
  const publishedMatch = url.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/);
  if (publishedMatch) {
    const csvUrl = new URL(`/spreadsheets/d/e/${publishedMatch[1]}/pub`, url.origin);
    csvUrl.searchParams.set("output", "csv");
    if (gid) csvUrl.searchParams.set("gid", gid);
    if (url.searchParams.has("single")) csvUrl.searchParams.set("single", url.searchParams.get("single"));
    return csvUrl.toString();
  }

  const spreadsheetMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!spreadsheetMatch) return trimmed;

  const csvUrl = new URL(`/spreadsheets/d/${spreadsheetMatch[1]}/export`, url.origin);
  csvUrl.searchParams.set("format", "csv");
  if (gid) csvUrl.searchParams.set("gid", gid);
  return csvUrl.toString();
}

export function normalizeImportedAsset(asset, index = 0) {
  if (!asset || typeof asset !== "object") {
    throw new Error(`Asset ${index + 1} must be an object.`);
  }
  const accountType = canonicalAccountType(asset.accountType);
  if (!VALID_ACCOUNT_TYPES.has(accountType)) {
    throw new Error(`Asset ${index + 1} has an unsupported accountType.`);
  }
  if (!Number.isFinite(numberOrNull(asset.units))) {
    throw new Error(`Asset ${index + 1} is missing a numeric units value.`);
  }
  if (!Number.isFinite(numberOrNull(asset.price))) {
    throw new Error(`Asset ${index + 1} is missing a numeric price value.`);
  }

  const assetClass = canonicalAssetClass(asset.assetClass ?? "stock");
  if (!VALID_ASSET_CLASSES.has(assetClass)) {
    throw new Error(`Asset ${index + 1} has an unsupported assetClass.`);
  }

  const name = asset.name ?? `${accountType} ${assetClass} ${index + 1}`;
  return {
    id: asset.id ?? slugify(name),
    name,
    accountType,
    assetClass,
    units: numberOrNull(asset.units),
    price: numberOrNull(asset.price),
    costBasisPerUnit: firstFiniteNumber(asset.costBasisPerUnit, asset.costBasis, asset.price),
    dividendYield: firstFiniteNumber(asset.dividendYield, 0),
    qualifiedDividendShare: firstFiniteNumber(asset.qualifiedDividendShare, defaultQualifiedDividendShare(assetClass)),
    holdingPeriod: canonicalHoldingPeriod(asset.holdingPeriod ?? "long")
  };
}

function defaultQualifiedDividendShare(assetClass) {
  return assetClass === "stock" ? 1 : 0;
}

function rowsToAssets(rows = []) {
  const nonEmptyRows = rows.filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
  if (nonEmptyRows.length < 2) return [];
  const headerIndex = portfolioHeaderRowIndex(nonEmptyRows);
  const headers = nonEmptyRows[headerIndex].map(canonicalCsvHeader);
  return nonEmptyRows.slice(headerIndex + 1).map((row) => Object.fromEntries(
    headers
      .map((header, index) => [header, coerceCsvValue(row[index])])
      .filter(([header]) => header !== "")
  ));
}

function portfolioHeaderRowIndex(rows) {
  const headerIndex = rows.findIndex((row) => {
    const headers = new Set(row.map(canonicalCsvHeader));
    return REQUIRED_PORTFOLIO_HEADERS.every((header) => headers.has(header));
  });
  return headerIndex >= 0 ? headerIndex : 0;
}

function canonicalCsvHeader(header) {
  const trimmed = String(header ?? "").replace(/^\uFEFF/, "").trim();
  return HEADER_ALIASES.get(normalizedAliasKey(trimmed)) ?? trimmed;
}

function parseCsvRows(text = "") {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"" && inQuotes && next === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (inQuotes) {
    throw new Error("CSV has an unterminated quoted field.");
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function coerceCsvValue(value = "") {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") return "";
  const percentMatch = trimmed.match(/^([-+]?[\d,]+(?:\.\d+)?)%$/);
  if (percentMatch) return Number((Number(percentMatch[1].replaceAll(",", "")) / 100).toFixed(12));
  const accountingMatch = trimmed.match(/^\(([$\s]*[\d,]+(?:\.\d+)?)\)$/);
  const numericText = accountingMatch
    ? `-${accountingMatch[1].replace(/[$,\s]/g, "")}`
    : trimmed.replace(/[$,\s]/g, "");
  if (/^[-+]?\d+(?:\.\d+)?$/.test(numericText)) return Number(numericText);
  return trimmed;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function canonicalAccountType(value) {
  const trimmed = String(value ?? "").trim();
  return ACCOUNT_TYPE_ALIASES.get(normalizedAliasKey(trimmed)) ?? trimmed;
}

function canonicalAssetClass(value) {
  const trimmed = String(value ?? "").trim();
  return ASSET_CLASS_ALIASES.get(normalizedAliasKey(trimmed)) ?? trimmed;
}

function canonicalHoldingPeriod(value) {
  const trimmed = String(value ?? "").trim();
  return HOLDING_PERIOD_ALIASES.get(normalizedAliasKey(trimmed)) ?? trimmed;
}

function buildAliasMap(aliasesByCanonical) {
  const map = new Map();
  for (const [canonical, aliases] of Object.entries(aliasesByCanonical)) {
    for (const alias of [canonical, ...aliases]) {
      map.set(normalizedAliasKey(alias), canonical);
    }
  }
  return map;
}

function normalizedAliasKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

function isGoogleCsvUrl(url) {
  return url.searchParams.get("output") === "csv"
    || url.searchParams.get("format") === "csv"
    || (url.searchParams.get("tqx") ?? "").includes("out:csv");
}

function googleSheetGid(url) {
  const queryGid = url.searchParams.get("gid");
  if (queryGid) return queryGid;
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  return hashParams.get("gid") ?? "";
}
