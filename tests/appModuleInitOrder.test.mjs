// Guards against a TDZ regression in src/app.mjs.
//
// Background: app.mjs invokes `initialize()` at module top-level (around
// line 620). initialize() synchronously runs the dashboard render path
// (renderAssetBreakdown → bindAssetSortHandlers, etc.). Any module-level
// `const` referenced inside those render functions must be *declared*
// before that top-level call site — otherwise the const is still in the
// temporal dead zone when initialize() executes, and the page errors out
// with "Cannot access 'X' before initialization".
//
// We caught this once with ASSET_COLUMN_META being declared near its
// helpers (line ~2274) instead of next to ALWAYS_PINNED_ASSET (line ~445).
// These tests pin the ordering so a similar mistake fails CI instead of
// the browser.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC_PATH = path.resolve(__dirname, "../src/app.mjs");
const APP_SRC = readFileSync(APP_SRC_PATH, "utf8");
const APP_LINES = APP_SRC.split("\n");

// Functions that run synchronously off of initialize() and therefore must
// only reference top-level consts that are declared before initialize().
// Extend this list when new render paths get wired into initialize().
const INIT_TIME_FUNCTIONS = [
  "renderAssetBreakdown",
  "bindAssetSortHandlers",
  "handleAssetSortClick",
  "compareSortValues"
];

function lineOf(pattern) {
  for (let i = 0; i < APP_LINES.length; i++) {
    if (pattern.test(APP_LINES[i])) return i + 1;
  }
  return -1;
}

/**
 * Extract the body (between the matching outer braces) of a top-level
 * `function NAME(...) { ... }` declaration. Returns null if not found.
 * Brace counting is naive — it does not skip braces inside strings,
 * template literals, regexes, or comments. For the targeted functions
 * in app.mjs this is sufficient; if that ever becomes false, swap in a
 * real parser.
 */
function extractFunctionBody(name) {
  const decl = new RegExp(`^function\\s+${name}\\s*\\(`, "m");
  const match = APP_SRC.match(decl);
  if (!match) return null;
  const start = APP_SRC.indexOf("{", match.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < APP_SRC.length; i++) {
    const ch = APP_SRC[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return APP_SRC.slice(start + 1, i);
    }
  }
  return null;
}

/** All module-level `const FOO = ...` declarations and their line numbers. */
function moduleLevelConsts() {
  const decls = new Map();
  for (let i = 0; i < APP_LINES.length; i++) {
    const m = APP_LINES[i].match(/^const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
    if (m) decls.set(m[1], i + 1);
  }
  return decls;
}

test("app.mjs: top-level initialize() call exists where the tests expect it", () => {
  const callLine = lineOf(/^initialize\(\)\s*;?\s*$/);
  assert.ok(
    callLine > 0,
    "Could not find a bare top-level `initialize();` line in src/app.mjs. " +
    "If you renamed or moved the call site, update tests/appModuleInitOrder.test.mjs."
  );
});

test("app.mjs: ASSET_COLUMN_META is declared before top-level initialize() (TDZ guard)", () => {
  const declLine = lineOf(/^const\s+ASSET_COLUMN_META\b/);
  const callLine = lineOf(/^initialize\(\)\s*;?\s*$/);

  assert.ok(declLine > 0, "Module-level `const ASSET_COLUMN_META = ...` declaration not found.");
  assert.ok(callLine > 0, "Top-level `initialize();` call not found.");
  assert.ok(
    declLine < callLine,
    `ASSET_COLUMN_META is declared at line ${declLine}, but initialize() runs at ` +
    `line ${callLine}. Move the declaration above the initialize() call — ` +
    `bindAssetSortHandlers references it during the initial render and will TDZ otherwise.`
  );
});

test("app.mjs: every const referenced by the init-time asset render path is declared before initialize()", () => {
  const callLine = lineOf(/^initialize\(\)\s*;?\s*$/);
  assert.ok(callLine > 0, "Top-level `initialize();` call not found.");

  const decls = moduleLevelConsts();

  // Find every top-level const that's used inside one of the render
  // functions that fire during initialize. If any such const is declared
  // *after* the initialize() call site, that's a TDZ waiting to happen.
  const violations = [];
  for (const fnName of INIT_TIME_FUNCTIONS) {
    const body = extractFunctionBody(fnName);
    if (body == null) {
      // Not fatal — the function may have been renamed or removed. The
      // dedicated existence test (above, for ASSET_COLUMN_META) catches
      // the specific regression we care about.
      continue;
    }
    for (const [name, declLine] of decls) {
      if (declLine <= callLine) continue; // declared early — safe
      const referenced = new RegExp(`\\b${name}\\b`).test(body);
      if (referenced) {
        violations.push({ const: name, declLine, referencedIn: fnName });
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    "Top-level consts referenced by init-time render functions must be declared " +
    "before the top-level `initialize();` call (TDZ). Move each violator " +
    "above line " + callLine + ":\n" +
    violations.map((v) => `  - ${v.const} (declared line ${v.declLine}, used in ${v.referencedIn})`).join("\n")
  );
});
