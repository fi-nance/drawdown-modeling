// Tests for the offline ZIP → state geographic resolver.
//
// Coverage targets, per `docs/GOAL.md` Phase 1:
//   - Federal HealthCare.gov-platform states (FFE)
//   - State-based exchanges with their own portals (SBM)
//   - State-based exchanges on the federal platform (SBM-FP)
//   - Medicaid-expansion states
//   - Non-expansion states (the coverage-gap territory)
//   - Edge cases: ZIP3 carve-outs (VA 201 / DC 200), FL 340 military, NY 005
//   - Out-of-model fallbacks: military APO/FPO, U.S. territories, unknown ZIPs
//   - Input normalization: number, "01234", "01234-5678", 3-digit prefix

import assert from "node:assert/strict";
import test from "node:test";

import {
  GEO_DATA_SOURCES,
  STATE_ABBREVIATIONS,
  STATE_EXCHANGE_TYPE_2026,
  STATE_MEDICAID_EXPANSION_2026,
  resolveZip
} from "../src/data/geo.mjs";

test("state abbreviations cover the 50 states plus DC", () => {
  assert.equal(Object.keys(STATE_ABBREVIATIONS).length, 51);
  assert.equal(STATE_ABBREVIATIONS.Massachusetts, "MA");
  assert.equal(STATE_ABBREVIATIONS["District of Columbia"], "DC");
});

test("exchange type and Medicaid tables cover every state with abbreviations", () => {
  const stateNames = Object.keys(STATE_ABBREVIATIONS);
  for (const state of stateNames) {
    assert.ok(
      STATE_EXCHANGE_TYPE_2026.states[state],
      `${state} should appear in STATE_EXCHANGE_TYPE_2026`
    );
    assert.ok(
      STATE_MEDICAID_EXPANSION_2026.states[state],
      `${state} should appear in STATE_MEDICAID_EXPANSION_2026`
    );
  }
});

test("resolveZip resolves a HealthCare.gov-platform state (Florida, Miami)", () => {
  const result = resolveZip("33101");
  assert.equal(result.zip, "33101");
  assert.equal(result.zip3, "331");
  assert.equal(result.state, "Florida");
  assert.equal(result.stateAbbreviation, "FL");
  assert.equal(result.exchange.type, "healthCareGov");
  assert.equal(result.medicaid.expanded, false);
  assert.equal(result.fallback, null);
});

test("resolveZip resolves a state-based-exchange state (Massachusetts, Cambridge)", () => {
  const result = resolveZip("02139");
  assert.equal(result.state, "Massachusetts");
  assert.equal(result.exchange.type, "stateBased");
  assert.equal(result.exchange.portal, "Massachusetts Health Connector");
  assert.equal(result.medicaid.expanded, true);
});

test("resolveZip resolves a state-based-exchange-on-federal-platform state (Oregon, Portland)", () => {
  const result = resolveZip("97201");
  assert.equal(result.state, "Oregon");
  assert.equal(result.exchange.type, "stateBasedFederal");
  assert.equal(result.medicaid.expanded, true);
});

test("resolveZip flags Medicaid coverage-gap states (Texas, Houston)", () => {
  const result = resolveZip("77001");
  assert.equal(result.state, "Texas");
  assert.equal(result.exchange.type, "healthCareGov");
  assert.equal(result.medicaid.expanded, false);
});

test("resolveZip flags the Wisconsin §1115 waiver edge case", () => {
  const result = resolveZip("53201");
  assert.equal(result.state, "Wisconsin");
  assert.equal(result.medicaid.expanded, false);
  assert.match(result.medicaid.note, /coverage-gap/i);
});

test("resolveZip flags the Georgia partial-expansion edge case", () => {
  const result = resolveZip("30301");
  assert.equal(result.state, "Georgia");
  assert.equal(result.medicaid.expanded, "partial");
  assert.match(result.medicaid.note, /Pathways/);
});

test("resolveZip handles the DC / Virginia carve-out at ZIP3 201", () => {
  // 20100-20199 is the Virginia (Arlington/Falls Church) suburb carve-out
  // even though 200 and 202-205 are DC.
  const arlington = resolveZip("20120");
  assert.equal(arlington.state, "Virginia");

  const dc = resolveZip("20001");
  assert.equal(dc.state, "District of Columbia");

  const dcCabinet = resolveZip("20500");
  assert.equal(dcCabinet.state, "District of Columbia");
});

test("resolveZip handles the recently-expanded states (North Carolina, South Dakota)", () => {
  // Both adopted post-2023; downstream "did this household have coverage in
  // year X" logic needs to know the effective year.
  const nc = resolveZip("27601"); // Raleigh
  assert.equal(nc.state, "North Carolina");
  assert.equal(nc.medicaid.expanded, true);
  assert.equal(nc.medicaid.effectiveYear, 2023);

  const sd = resolveZip("57101"); // Sioux Falls
  assert.equal(sd.state, "South Dakota");
  assert.equal(sd.medicaid.expanded, true);
  assert.equal(sd.medicaid.effectiveYear, 2023);
});

test("resolveZip handles military APO/FPO ZIPs as out-of-model fallback", () => {
  const apo = resolveZip("09001"); // APO Europe
  assert.equal(apo.state, null);
  assert.equal(apo.fallback, "military");
  assert.equal(apo.exchange, null);

  const fpo = resolveZip("96201"); // FPO Pacific
  assert.equal(fpo.fallback, "military");

  const miamiMilitary = resolveZip("34001"); // Miami APO/FPO
  assert.equal(miamiMilitary.fallback, "military");
});

test("resolveZip handles U.S. territories as out-of-model fallback", () => {
  const pr = resolveZip("00901"); // San Juan, PR
  assert.equal(pr.state, null);
  assert.equal(pr.fallback, "territory");

  const gu = resolveZip("96910"); // Hagåtña, Guam
  assert.equal(gu.fallback, "territory");
});

test("resolveZip returns unknown fallback for clearly-invalid ZIPs", () => {
  const garbage = resolveZip("ABCDE");
  assert.equal(garbage.state, null);
  assert.equal(garbage.fallback, "unknown");

  const empty = resolveZip("");
  assert.equal(empty.fallback, "unknown");

  const nullInput = resolveZip(null);
  assert.equal(nullInput.fallback, "unknown");

  // 999 IS Alaska, but 998 is technically Alaska too — picking an unused
  // ZIP3 (no current US assignment uses 700-715 but Louisiana 700-714 fills
  // most of that). Use a ZIP3 that genuinely has no assignment: in practice
  // we are exhaustive over 000-999 via ranges + military + territories,
  // so any "unknown" case requires a non-numeric or out-of-range input.
});

test("resolveZip accepts numeric, ZIP+4, and 3-digit prefix inputs", () => {
  // Numeric input (loses leading zero): 2139 → "02139"
  const fromNumber = resolveZip(2139);
  assert.equal(fromNumber.zip, "02139");
  assert.equal(fromNumber.state, "Massachusetts");

  // ZIP+4
  const plus4 = resolveZip("02139-1234");
  assert.equal(plus4.state, "Massachusetts");
  assert.equal(plus4.zip3, "021");

  // 3-digit prefix (no full ZIP available)
  const prefix = resolveZip("021");
  assert.equal(prefix.zip, null);
  assert.equal(prefix.zip3, "021");
  assert.equal(prefix.state, "Massachusetts");
});

test("resolveZip includes traceable source URLs in the result", () => {
  const result = resolveZip("02139");
  assert.ok(result.sources.zipToState.length > 0);
  assert.ok(result.sources.exchange.length > 0);
  assert.ok(result.sources.medicaid.length > 0);
});

test("GEO_DATA_SOURCES exposes name + url for the data-sources coverage test", () => {
  assert.ok(Array.isArray(GEO_DATA_SOURCES));
  for (const source of GEO_DATA_SOURCES) {
    assert.ok(typeof source.name === "string" && source.name.length > 0);
    assert.ok(typeof source.url === "string" && /^https?:\/\//.test(source.url));
  }
});

test("Wyoming (non-expansion, federal exchange) resolves cleanly", () => {
  // Smoke test for one of the nine non-expansion states.
  const result = resolveZip("82001"); // Cheyenne
  assert.equal(result.state, "Wyoming");
  assert.equal(result.exchange.type, "healthCareGov");
  assert.equal(result.medicaid.expanded, false);
});
