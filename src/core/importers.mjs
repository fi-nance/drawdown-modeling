import { slugify } from "./utils.mjs";

const VALID_ACCOUNT_TYPES = new Set(["taxable", "traditional", "roth", "hsa"]);
export const VALID_ASSET_CLASSES = new Set(["stock", "bond", "cash", "realEstate", "tips", "crypto"]);

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

export function normalizeImportedAsset(asset, index = 0) {
  if (!asset || typeof asset !== "object") {
    throw new Error(`Asset ${index + 1} must be an object.`);
  }
  if (!VALID_ACCOUNT_TYPES.has(asset.accountType)) {
    throw new Error(`Asset ${index + 1} has an unsupported accountType.`);
  }
  if (!Number.isFinite(Number(asset.units))) {
    throw new Error(`Asset ${index + 1} is missing a numeric units value.`);
  }
  if (!Number.isFinite(Number(asset.price))) {
    throw new Error(`Asset ${index + 1} is missing a numeric price value.`);
  }

  const assetClass = asset.assetClass ?? "stock";
  if (!VALID_ASSET_CLASSES.has(assetClass)) {
    throw new Error(`Asset ${index + 1} has an unsupported assetClass.`);
  }

  const name = asset.name ?? `${asset.accountType} ${assetClass} ${index + 1}`;
  return {
    id: asset.id ?? slugify(name),
    name,
    accountType: asset.accountType,
    assetClass,
    units: Number(asset.units),
    price: Number(asset.price),
    costBasisPerUnit: Number(asset.costBasisPerUnit ?? asset.costBasis ?? asset.price),
    dividendYield: Number(asset.dividendYield ?? 0),
    qualifiedDividendShare: Number(asset.qualifiedDividendShare ?? 1),
    holdingPeriod: asset.holdingPeriod ?? "long"
  };
}
