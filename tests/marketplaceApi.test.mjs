import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarketplacePlanSearchRequest,
  marketplaceApiUrl,
  marketplacePlanOopMaximum,
  marketplaceStateCode,
  normalizeMarketplaceCounties,
  normalizeMarketplacePlans,
  secondLowestSilverPremium
} from "../src/data/marketplaceApi.mjs";

test("Marketplace API request builder uses CMS household and place shape", () => {
  const request = buildMarketplacePlanSearchRequest({
    income: 52000,
    ages: [45, "43"],
    state: "North Carolina",
    zipcode: "27360",
    countyfips: "37057",
    year: 2026,
    usesTobacco: true,
    utilizationLevel: "High"
  });

  assert.equal(marketplaceStateCode("Massachusetts"), "MA");
  assert.equal(request.household.income, 52000);
  assert.equal(request.household.people.length, 2);
  assert.equal(request.household.people[0].uses_tobacco, true);
  assert.equal(request.household.people[0].utilization_level, "High");
  assert.deepEqual(request.place, {
    countyfips: "37057",
    state: "NC",
    zipcode: "27360"
  });
  assert.equal(request.year, 2026);
});

test("Marketplace plan normalization extracts premiums, metal level, issuer, and OOP max", () => {
  const plans = normalizeMarketplacePlans({
    plans: [
      {
        id: "silver-1",
        name: "Silver One",
        issuer: { name: "Issuer A" },
        metal_level: "Silver",
        premium: 600,
        premium_w_credit: 200,
        moops: [{ type: "In Network", name: "Family", amount: 18000 }]
      },
      {
        id: "bronze-1",
        name: "Bronze One",
        issuer: { name: "Issuer B" },
        metal_level: "Bronze",
        premium: 450,
        moops: [{ type: "In Network", name: "Family", family_amount: 15000 }]
      },
      {
        id: "silver-2",
        name: "Silver Two",
        metal_level: "Silver",
        premium: 500,
        moops: [{ type: "In Network", name: "Family", amount: 16000 }]
      }
    ]
  }, { marketplaceMembers: 2 });

  assert.equal(plans[0].name, "Bronze One");
  assert.equal(plans[0].issuer, "Issuer B");
  assert.equal(plans[0].oopMaximum, 15000);
  assert.equal(secondLowestSilverPremium(plans), 600);
});

test("Marketplace counties normalize common CMS response shapes", () => {
  assert.deepEqual(normalizeMarketplaceCounties({
    counties: [
      { fips: "25017", name: "Middlesex", state: "MA" },
      { countyfips: "25025", county_name: "Suffolk", state_code: "MA" }
    ]
  }), [
    { fips: "25017", name: "Middlesex", state: "MA" },
    { fips: "25025", name: "Suffolk", state: "MA" }
  ]);
});

test("Marketplace helpers build API-key URLs and prefer in-network MOOP", () => {
  assert.equal(
    marketplaceApiUrl("/counties/by/zip/27360", "abc 123"),
    "https://marketplace.api.healthcare.gov/api/v1/counties/by/zip/27360?apikey=abc%20123"
  );
  assert.equal(marketplacePlanOopMaximum({
    moops: [
      { type: "Out of Network", name: "Individual", amount: 30000 },
      { type: "In Network", name: "Individual", amount: 9200 }
    ]
  }), 9200);
});
