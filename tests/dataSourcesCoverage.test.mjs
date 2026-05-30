import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MASSACHUSETTS_CONNECTORCARE_2026 } from "../src/data/acaPlanPresets.mjs";
import {
  ACA_BY_YEAR,
  FEDERAL_POVERTY_GUIDELINES_BY_YEAR,
  FEDERAL_TAX_BY_YEAR,
  MEDICARE_IRMAA_BY_YEAR,
  TAX_DATA_VERSION
} from "../src/data/taxData.mjs";
import {
  HISTORICAL_RETURN_DATA_VERSION,
  HISTORICAL_RETURN_SOURCES
} from "../src/data/historicalReturns.mjs";
import { GEO_DATA_SOURCES, GEO_DATA_VERSION } from "../src/data/geo.mjs";

const dataSourcesText = await readFile(new URL("../docs/DATA_SOURCES.md", import.meta.url), "utf8");

function assertDocumented(label, value) {
  assert.ok(value, `${label} should have a source value`);
  assert.ok(
    dataSourcesText.includes(String(value)),
    `${label} should be documented in docs/DATA_SOURCES.md: ${value}`
  );
}

test("versioned tax and ACA source labels are documented", () => {
  assertDocumented("tax data version", TAX_DATA_VERSION);

  for (const [year, profile] of Object.entries(FEDERAL_TAX_BY_YEAR)) {
    assertDocumented(`federal tax ${year}`, profile.source);
  }
  for (const [year, fpl] of Object.entries(FEDERAL_POVERTY_GUIDELINES_BY_YEAR)) {
    assertDocumented(`FPL ${year}`, fpl.source);
  }
  for (const [year, aca] of Object.entries(ACA_BY_YEAR)) {
    assertDocumented(`ACA ${year}`, aca.source);
  }
  for (const [year, medicare] of Object.entries(MEDICARE_IRMAA_BY_YEAR)) {
    assertDocumented(`Medicare IRMAA ${year}`, medicare.source);
  }

  assertDocumented("state income tax source", "Tax Foundation 2026 state income tax compilation");
  assertDocumented("Massachusetts ConnectorCare", MASSACHUSETTS_CONNECTORCARE_2026.source);
});

test("historical return source URLs are documented", () => {
  assertDocumented("historical return data version", HISTORICAL_RETURN_DATA_VERSION);
  for (const source of HISTORICAL_RETURN_SOURCES) {
    assertDocumented(source.name, source.url);
  }
});

test("geographic resolver sources are documented", () => {
  assertDocumented("geo data version", GEO_DATA_VERSION);
  for (const source of GEO_DATA_SOURCES) {
    assertDocumented(source.name, source.url);
  }
});
