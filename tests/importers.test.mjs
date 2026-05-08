import assert from "node:assert/strict";
import test from "node:test";

import {
  googleSpreadsheetIdFromInput,
  parsePortfolioCsv,
  parsePortfolioJson,
  parsePortfolioRows,
  toGoogleCsvUrl
} from "../src/core/importers.mjs";

test("JSON importer accepts either an array or an object with assets", () => {
  const result = parsePortfolioJson(JSON.stringify({
    assets: [{
      name: "Taxable Total Market",
      accountType: "taxable",
      assetClass: "stock",
      units: 10,
      price: 100,
      costBasisPerUnit: 60
    }]
  }));

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "taxable-total-market");
  assert.equal(result[0].holdingPeriod, "long");
});

test("JSON importer accepts TIPS and crypto asset classes", () => {
  const result = parsePortfolioJson(JSON.stringify([
    { accountType: "taxable", assetClass: "tips", units: 10, price: 100 },
    { accountType: "roth", assetClass: "crypto", units: 1, price: 50000 }
  ]));

  assert.equal(result[0].assetClass, "tips");
  assert.equal(result[1].assetClass, "crypto");
});

test("CSV importer accepts Google Sheets formatted numbers", () => {
  const result = parsePortfolioCsv([
    "name,accountType,assetClass,units,price,costBasisPerUnit,dividendYield,qualifiedDividendShare,holdingPeriod",
    "Taxable Fund,taxable,stock,\"6,300\",$100.50,$62.25,1.8%,95%,long"
  ].join("\n"));

  assert.equal(result.length, 1);
  assert.equal(result[0].units, 6300);
  assert.equal(result[0].price, 100.5);
  assert.equal(result[0].costBasisPerUnit, 62.25);
  assert.equal(result[0].dividendYield, 0.018);
  assert.equal(result[0].qualifiedDividendShare, 0.95);
});

test("CSV importer accepts spreadsheet headers and retirement accounts without basis", () => {
  const result = parsePortfolioCsv([
    "Portfolio export",
    "Name,Account Type,Asset Class,Shares,Current Price,Cost Basis / Share,Dividend Yield,Qualified Dividend %,Term",
    "Traditional Fund,Traditional IRA,Bonds,100,$98.25,N/A,2.5%,0%,Long Term",
    "Roth Growth,Roth IRA,Stocks,25,$220.00,,0.4%,100%,Long"
  ].join("\n"));

  assert.equal(result.length, 2);
  assert.equal(result[0].accountType, "traditional");
  assert.equal(result[0].assetClass, "bond");
  assert.equal(result[0].costBasisPerUnit, 98.25);
  assert.equal(result[0].holdingPeriod, "long");
  assert.equal(result[1].accountType, "roth");
  assert.equal(result[1].assetClass, "stock");
  assert.equal(result[1].costBasisPerUnit, 220);
});

test("CSV importer accepts pre-tax and after-tax 401k account labels", () => {
  const result = parsePortfolioCsv([
    "Name,Account Type,Asset Class,Shares,Current Price",
    "Traditional 401k Fund,Pre-Tax 401k,Bonds,100,$50",
    "Roth 401k Fund,After-Tax 401(k),Stocks,25,$120"
  ].join("\n"));

  assert.equal(result[0].accountType, "traditional");
  assert.equal(result[1].accountType, "roth");
});

test("row importer accepts Sheets API values", () => {
  const result = parsePortfolioRows([
    ["name", "accountType", "assetClass", "units", "price", "costBasisPerUnit", "dividendYield"],
    ["Traditional Fund", "traditional", "bond", "100", "$98.25", "$95.00", "2.5%"]
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].accountType, "traditional");
  assert.equal(result[0].assetClass, "bond");
  assert.equal(result[0].price, 98.25);
  assert.equal(result[0].dividendYield, 0.025);
});

test("row importer accepts traditional and roth 401k account labels", () => {
  const result = parsePortfolioRows([
    ["Name", "Account Type", "Asset Class", "Shares", "Current Price"],
    ["Traditional 401k Fund", "Traditional 401(k)", "Bond", "100", "$50"],
    ["Roth 401k Fund", "After Tax", "Stock", "25", "$120"]
  ]);

  assert.equal(result[0].accountType, "traditional");
  assert.equal(result[1].accountType, "roth");
});

test("CSV importer defaults blank optional numeric fields safely", () => {
  const result = parsePortfolioCsv([
    "name,accountType,assetClass,units,price,costBasisPerUnit,dividendYield,qualifiedDividendShare",
    "Cash,taxable,cash,1000,1,,,"
  ].join("\n"));

  assert.equal(result[0].costBasisPerUnit, 1);
  assert.equal(result[0].dividendYield, 0);
  assert.equal(result[0].qualifiedDividendShare, 0);
});

test("importer defaults missing qualified dividend shares by asset class", () => {
  const result = parsePortfolioCsv([
    "name,accountType,assetClass,units,price,qualifiedDividendShare",
    "Stock,taxable,stock,1,100,",
    "Bond,taxable,bond,1,100,",
    "Cash,taxable,cash,1,1,",
    "TIPS,taxable,tips,1,100,",
    "REIT,taxable,realEstate,1,100,",
    "Crypto,taxable,crypto,1,100,",
    "Explicit Bond,taxable,bond,1,100,25%"
  ].join("\n"));

  assert.equal(result.find((asset) => asset.name === "Stock").qualifiedDividendShare, 1);
  assert.equal(result.find((asset) => asset.name === "Bond").qualifiedDividendShare, 0);
  assert.equal(result.find((asset) => asset.name === "Cash").qualifiedDividendShare, 0);
  assert.equal(result.find((asset) => asset.name === "TIPS").qualifiedDividendShare, 0);
  assert.equal(result.find((asset) => asset.name === "REIT").qualifiedDividendShare, 0);
  assert.equal(result.find((asset) => asset.name === "Crypto").qualifiedDividendShare, 0);
  assert.equal(result.find((asset) => asset.name === "Explicit Bond").qualifiedDividendShare, 0.25);
});

test("CSV importer rejects non-portfolio CSV headers clearly", () => {
  assert.throws(
    () => parsePortfolioCsv("html,error\n<title>Sign in</title>,Login required"),
    /headers/i
  );
});

test("JSON importer rejects invalid lots before simulation", () => {
  assert.throws(() => parsePortfolioJson("[{\"accountType\":\"taxable\"}]"), /units/i);
});

test("JSON importer rejects unsupported asset classes before simulation", () => {
  assert.throws(
    () => parsePortfolioJson(JSON.stringify([{ accountType: "taxable", assetClass: "collectible", units: 1, price: 10 }])),
    /assetClass/i
  );
});

test("Google Sheets share URLs convert to CSV export URLs", () => {
  assert.equal(
    toGoogleCsvUrl("https://docs.google.com/spreadsheets/d/abc123/edit#gid=456"),
    "https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=456"
  );
  assert.equal(
    toGoogleCsvUrl("https://docs.google.com/spreadsheets/d/abc123/edit?gid=789#gid=456"),
    "https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=789"
  );
});

test("published Google Sheets URLs convert from pubhtml to CSV", () => {
  assert.equal(
    toGoogleCsvUrl("https://docs.google.com/spreadsheets/d/e/pub123/pubhtml?gid=0&single=true"),
    "https://docs.google.com/spreadsheets/d/e/pub123/pub?output=csv&gid=0&single=true"
  );
  assert.equal(
    toGoogleCsvUrl("https://docs.google.com/spreadsheets/d/e/pub123/pub?output=csv&gid=0&single=true"),
    "https://docs.google.com/spreadsheets/d/e/pub123/pub?output=csv&gid=0&single=true"
  );
});

test("private Google Sheets import extracts spreadsheet IDs", () => {
  assert.equal(
    googleSpreadsheetIdFromInput("https://docs.google.com/spreadsheets/d/abc123/edit#gid=456"),
    "abc123"
  );
  assert.equal(googleSpreadsheetIdFromInput("abc123"), "abc123");
  assert.equal(
    googleSpreadsheetIdFromInput("https://docs.google.com/spreadsheets/d/e/pub123/pubhtml?gid=0"),
    ""
  );
});
