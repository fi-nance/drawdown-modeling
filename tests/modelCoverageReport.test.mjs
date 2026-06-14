import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  COVERAGE_STATUSES,
  coverageSummary,
  modelCoverageReport
} from "../src/data/modelCoverageReport.mjs";

test("app topbars link to the model coverage report", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const reportLinks = html.match(/href="\.\/model-coverage\.html"/g) ?? [];

  assert.equal(reportLinks.length, 3, "persona, workspace, and results topbars should expose the report");
  assert.match(html, /Model coverage/);
  assert.match(html, /src\/redesign\.css\?v=20260613-streaming-kpi-refresh-b/);
});

test("standalone model coverage page renders from structured report data", async () => {
  const html = await readFile(new URL("../model-coverage.html", import.meta.url), "utf8");

  assert.match(html, /Model Coverage Report - Portfolio Success Lab/);
  assert.match(html, /id="coverageSections"/);
  assert.match(html, /id="statusSummary"/);
  assert.match(html, /from "\.\/src\/data\/modelCoverageReport\.mjs"/);
  assert.match(html, /coverageSummary\(modelCoverageReport\)/);
});

test("structured model coverage report keeps every section auditable", async () => {
  assert.equal(modelCoverageReport.lawYear, "2026");
  assert.ok(modelCoverageReport.version);
  assert.ok(modelCoverageReport.purpose.includes("sources"));

  const summary = coverageSummary(modelCoverageReport);
  assert.equal(summary.totalSections, modelCoverageReport.sections.length);
  assert.ok(summary.totalSections >= 9);
  assert.ok(summary.counts["cpa-review"] >= 3);
  assert.ok(summary.counts["input-limited"] >= 2);
  assert.ok(summary.counts["assumption-sensitive"] >= 2);

  const ids = new Set();
  for (const section of modelCoverageReport.sections) {
    assert.ok(section.id, "section should have an id");
    assert.ok(!ids.has(section.id), `duplicate section id: ${section.id}`);
    ids.add(section.id);
    assert.ok(section.title, `${section.id} should have a title`);
    assert.ok(COVERAGE_STATUSES.includes(section.status), `${section.id} has unknown status`);
    assert.ok(section.summary, `${section.id} should have a summary`);
    assert.ok(section.lens, `${section.id} should name the review lens`);

    for (const key of ["implemented", "limitations", "sources", "tests", "nextReview"]) {
      assert.ok(Array.isArray(section[key]) && section[key].length > 0, `${section.id}.${key} should be non-empty`);
    }

    for (const source of section.sources) {
      assert.ok(source.label, `${section.id} source should have a label`);
      assert.ok(source.href, `${section.id} source should have an href`);
    }

    for (const testPath of section.tests) {
      if (!testPath.startsWith("tests/")) continue;
      await access(new URL(`../${testPath}`, import.meta.url));
    }
  }

  for (const required of ["federal-tax", "state-tax", "aca-healthcare", "withdrawal-optimization", "legacy"]) {
    assert.ok(ids.has(required), `report should include ${required}`);
  }
});

test("model coverage report documents capital-loss carryover scope and state caveat", () => {
  const federal = modelCoverageReport.sections.find((section) => section.id === "federal-tax");
  const state = modelCoverageReport.sections.find((section) => section.id === "state-tax");

  assert.ok(federal, "federal-tax section should exist");
  assert.ok(state, "state-tax section should exist");
  assert.match(federal.implemented.join("\n"), /Schedule D-style capital-loss netting/);
  assert.match(federal.implemented.join("\n"), /carryover worksheet logic/);
  assert.match(state.implemented.join("\n"), /state capital-loss conformity review/);
  assert.match(state.limitations.join("\n"), /State-specific capital-loss additions/);
  assert.ok(state.tests.includes("tests/resultAuditBundle.test.mjs"));
});
