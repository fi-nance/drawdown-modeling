// ─────────────────────────────────────────────────────────────────────────────
// TDZ regression guard for src/app.mjs
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS FILE EXISTS
// --------------------
// src/app.mjs invokes `initialize()` at module top-level (around line 620
// at time of writing). initialize() synchronously runs the dashboard render
// path — renderAssetBreakdown → bindAssetSortHandlers, etc. — which means
// any module-level `const` referenced inside those render functions must
// be *declared* above the call site in source order. Otherwise the const
// is still in the temporal dead zone when initialize() executes, and the
// page errors out at load with:
//
//   Uncaught ReferenceError: Cannot access 'X' before initialization
//
// We hit this once with ASSET_COLUMN_META being declared next to its
// helpers (~line 2274) instead of next to ALWAYS_PINNED_ASSET (~line 445).
// The fix was a one-line move, and a one-line move is exactly the kind of
// thing a later refactor can quietly undo. This test pins the ordering so
// the regression fails CI instead of the browser.
//
// HOW THIS TEST WORKS (and why it's a *static text* check)
// --------------------------------------------------------
// app.mjs is heavily DOM-bound at module load (document.querySelector calls
// in the top-level `els` object, localStorage reads, etc.). Importing it
// from Node would require stubbing a meaningful slice of the browser, plus
// running JSDOM or similar. The whole project currently has zero runtime
// dependencies, so we deliberately avoid that route.
//
// Instead, this file reads src/app.mjs as text and uses three layers of
// progressively-more-general checks:
//
//   1. A sanity check that the `initialize();` call site we pin to is
//      where we expect.
//   2. A specific check that the exact const we tripped on
//      (ASSET_COLUMN_META) is still declared above the call site.
//   3. A generic check that walks a hand-maintained list of init-time
//      render functions, extracts their bodies, and flags any top-level
//      const referenced inside them but declared after `initialize();`.
//
// CHANGES THAT WILL BREAK THESE TESTS — AND WHAT TO DO
// ----------------------------------------------------
// These tests make several assumptions about the *shape* of app.mjs. Most
// of those assumptions hold today; if you change one of them on purpose,
// you need to update the corresponding piece of this test rather than
// just delete the failing assertion. The annotations on each test below
// describe exactly which assumption is in play.
//
// The big ones:
//
//   • `initialize()` is called bare at top level, not wrapped in
//     DOMContentLoaded, an IIFE, or behind a feature flag.
//       → If you intentionally move it inside a listener, update
//         `lineOf(/^initialize\(\)\s*;?\s*$/)` to look for the new call
//         shape, and update the WHY THIS FILE EXISTS comment above to
//         reflect the new init timing. The TDZ risk may genuinely go
//         away (deferred init means consts have already initialized),
//         in which case test 2 and test 3 can be deleted — but write
//         that decision down in the commit message.
//
//   • Functions in INIT_TIME_FUNCTIONS still exist by those names and
//     are still reachable from initialize().
//       → If you rename one, update the list. If you remove the asset
//         sort feature entirely, delete this test file (and reference
//         it in the removal commit so the history is searchable).
//       → If you add a *new* function that runs at init time, add it
//         to the list. The skeleton check (test 1) will keep working,
//         but test 3 will only catch TDZ inside functions named in
//         INIT_TIME_FUNCTIONS.
//
//   • The functions are plain `function NAME(...) { ... }` declarations
//     at top level, not arrow consts or methods.
//       → `extractFunctionBody` only matches `function NAME`. If you
//         convert any of them to `const NAME = (...) => { ... }`, the
//         body lookup returns null and that function silently drops out
//         of the check. Either update the extractor or move to a real
//         JS parser (see "PARSER UPGRADE" below).
//
//   • Top-level consts are declared as `const NAME = ...` at column 0,
//     one per line, no `export`, no destructuring.
//       → If app.mjs becomes a module that exports symbols, or starts
//         using `const { A, B } = ...` at top level, update
//         `moduleLevelConsts` accordingly. Until then, keeping things
//         simple makes the test easy to reason about.
//
// PARSER UPGRADE: WHEN TO REACH FOR ACORN
// ---------------------------------------
// `extractFunctionBody` counts braces naively — it does *not* skip
// braces inside strings, template literals, regex literals, or comments.
// If any of the INIT_TIME_FUNCTIONS grows a body with a `}` inside a
// string or regex before the real closing brace, this extractor will
// return the wrong slice and the test will produce false positives or
// negatives. The right answer at that point is to add a small AST
// parser (acorn is ~150KB, zero-dep) and use it instead. We deliberately
// haven't done that yet because none of the targeted functions today
// have any tricky brace patterns and the project has no runtime deps.
//
// VERIFICATION
// ------------
// When this test landed, the verification recipe was:
//   1. `git show 2d3979c:src/app.mjs > /tmp/broken.mjs`
//   2. `cp src/app.mjs /tmp/fixed.mjs && cp /tmp/broken.mjs src/app.mjs`
//   3. `node --test tests/appModuleInitOrder.test.mjs` → expect failure
//      naming ASSET_COLUMN_META referenced in renderAssetBreakdown,
//      bindAssetSortHandlers, handleAssetSortClick.
//   4. `cp /tmp/fixed.mjs src/app.mjs` → run again, expect green.
// If you significantly change the test logic, re-run that recipe (or a
// modern equivalent) and update the commit referenced in step 1.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC_PATH = path.resolve(__dirname, "../src/app.mjs");
const APP_SRC = readFileSync(APP_SRC_PATH, "utf8");
const APP_LINES = APP_SRC.split("\n");

// Regex shared by every test that needs to find the init() call site.
// Kept as a constant so the four uses don't drift. Matches a line that
// is *exactly* `initialize()` or `initialize();` with optional trailing
// whitespace — i.e. it must be at column 0 with nothing else on the line.
// If init() moves into a wrapper (see header comment) update this and
// the prose above together.
const INITIALIZE_CALL_PATTERN = /^initialize\(\)\s*;?\s*$/;

// Functions that run synchronously off of initialize() and therefore
// must only reference top-level consts that are declared earlier in
// source order. This is a *hand-maintained allow-list*: test 3 only
// inspects functions named here.
//
// HOW TO MAINTAIN:
//   - Add a function name here when you wire a new render path into
//     initialize() (directly or transitively).
//   - Remove a name if the function is deleted or moved into a deferred
//     path (e.g. behind an event listener that fires after module load).
//   - Renames: update both this list and any specific tests below that
//     reference the function name in error messages.
//
// If the list gets long (say, >20 names) consider switching to a derived
// approach — e.g. walk the call graph starting from initialize() — but
// that wants a real AST parser; see PARSER UPGRADE in the header.
const INIT_TIME_FUNCTIONS = [
  "renderAssetBreakdown",
  "bindAssetSortHandlers",
  "handleAssetSortClick",
  "compareSortValues"
];

/**
 * Return the 1-based line number of the first line in app.mjs matching
 * `pattern`, or -1 if no line matches. Used by the call-site lookups
 * and the specific ASSET_COLUMN_META declaration check.
 */
function lineOf(pattern) {
  for (let i = 0; i < APP_LINES.length; i++) {
    if (pattern.test(APP_LINES[i])) return i + 1;
  }
  return -1;
}

/**
 * Extract the body (the text between matching outer braces) of a
 * top-level `function NAME(...) { ... }` declaration. Returns null if
 * the function isn't found.
 *
 * CAVEATS — read before changing:
 *   - Only matches `function NAME` declarations. Arrow consts
 *     (`const NAME = () => { ... }`) and method shorthand are not
 *     matched. If a target function gets converted to an arrow, this
 *     extractor silently returns null and the function drops out of
 *     the TDZ check.
 *   - Brace counting is naive: it does NOT skip braces inside string
 *     literals, template literals, regex literals, or comments. For the
 *     functions in INIT_TIME_FUNCTIONS today, none of those are present
 *     before the real closing brace, so this is fine. If that changes,
 *     replace this with an AST-based extractor (acorn).
 *   - Assumes the first `{` after the `function NAME(` match is the
 *     opening of the body — which fails if there's a default parameter
 *     value like `function f(opts = { a: 1 }) { ... }`. None of the
 *     targeted functions use such defaults today.
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

/**
 * Return a Map of every module-level `const NAME = ...` declaration in
 * app.mjs to the 1-based line where it appears.
 *
 * CAVEATS — read before changing:
 *   - "Module-level" is approximated as "starts at column 0". This works
 *     because app.mjs has no nested top-level scopes today (no IIFE wrap,
 *     no top-level classes, no top-level blocks). Indented `const`
 *     declarations are assumed to be inside a function.
 *   - The regex only matches `const NAME = ...`. It misses:
 *       • `export const NAME = ...`
 *       • `const { A, B } = ...` (destructuring)
 *       • `const NAME =\n  ...` (declaration with the `=` on its own line)
 *     If app.mjs starts using any of those at top level for values that
 *     init-time render functions reference, this test will silently miss
 *     the TDZ risk. Extend the regex or move to an AST parser.
 *   - Only the *last* match per name wins, because Map.set overwrites.
 *     Today there are no top-level rebindings; if that changes, decide
 *     whether the first or last declaration matters for your case.
 */
function moduleLevelConsts() {
  const decls = new Map();
  for (let i = 0; i < APP_LINES.length; i++) {
    const m = APP_LINES[i].match(/^const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
    if (m) decls.set(m[1], i + 1);
  }
  return decls;
}

// ─── Test 1: sanity-check the pin point ──────────────────────────────────────
// All three tests pivot on the line number of the top-level
// `initialize();` call. If we can't find it, the other two tests would
// pass vacuously (both `declLine > callLine` checks would be true because
// callLine would be -1). This guard forces a loud failure with a clear
// pointer to *this* file when the call site moves or is renamed.
//
// If you intentionally moved initialize() into DOMContentLoaded or an
// async bootstrap, the TDZ risk may genuinely disappear — see "CHANGES
// THAT WILL BREAK THESE TESTS" in the header comment for what to do.
test("app.mjs: top-level initialize() call exists where the tests expect it", () => {
  const callLine = lineOf(INITIALIZE_CALL_PATTERN);
  assert.ok(
    callLine > 0,
    "Could not find a bare top-level `initialize();` line in src/app.mjs. " +
    "If you renamed or moved the call site, update INITIALIZE_CALL_PATTERN " +
    "in tests/appModuleInitOrder.test.mjs (and review whether the TDZ risk " +
    "this file guards against still exists at all)."
  );
});

// ─── Test 2: the specific const we tripped on ────────────────────────────────
// This is the narrow regression check. It exists in addition to test 3
// because:
//   (a) Test 3 silently skips functions that have been renamed (it has
//       to, to stay tolerant of refactors), so if every function in
//       INIT_TIME_FUNCTIONS gets renamed in the same commit, test 3
//       passes vacuously while ASSET_COLUMN_META could quietly move
//       back below the call site.
//   (b) The failure message can name ASSET_COLUMN_META and
//       bindAssetSortHandlers explicitly, which is friendlier than a
//       generic "violators" list.
//
// DELETE THIS TEST IF: the asset sort feature is removed entirely (no
// more ASSET_COLUMN_META in the file), or if the const is intentionally
// moved into a function scope (in which case it can no longer TDZ at
// module load).
//
// UPDATE THIS TEST IF: ASSET_COLUMN_META is renamed — change the regex
// and the error message to match. Keep the test; the underlying TDZ
// risk hasn't changed, only the name.
test("app.mjs: ASSET_COLUMN_META is declared before top-level initialize() (TDZ guard)", () => {
  const declLine = lineOf(/^const\s+ASSET_COLUMN_META\b/);
  const callLine = lineOf(INITIALIZE_CALL_PATTERN);

  assert.ok(
    declLine > 0,
    "Module-level `const ASSET_COLUMN_META = ...` declaration not found. " +
    "If the asset sort feature was removed, delete this test. If the const " +
    "was renamed, update the regex on the line above."
  );
  assert.ok(callLine > 0, "Top-level `initialize();` call not found.");
  assert.ok(
    declLine < callLine,
    `ASSET_COLUMN_META is declared at line ${declLine}, but initialize() runs at ` +
    `line ${callLine}. Move the declaration above the initialize() call — ` +
    `bindAssetSortHandlers references it during the initial render and will TDZ otherwise.`
  );
});

// ─── Test 3: the generic guard ───────────────────────────────────────────────
// Catches the same shape of bug for any *other* top-level const that
// happens to be referenced from an init-time render function. This is
// the test that protects against future drift — someone adds a new
// const next to its helpers and forgets that init runs at module load.
//
// LIMITATIONS — important context for anyone changing this:
//   1. The check is scoped to functions named in INIT_TIME_FUNCTIONS.
//      Anything outside that list is invisible. There's no automated way
//      to derive the list short of running the module or AST-walking the
//      call graph.
//   2. `extractFunctionBody` is regex+brace-counting, not a real parser.
//      It will return wrong results if a function body contains `{` or
//      `}` inside a string, regex, template literal, or comment before
//      the actual closing brace. None of the targeted functions today
//      have that pattern; verify before assuming.
//   3. The "is this const referenced" check is a word-boundary regex on
//      the const name. It can false-positive if the same identifier
//      appears as a property key or in a comment inside the function body.
//      For SCREAMING_SNAKE_CASE const names like ASSET_COLUMN_META, the
//      collision rate in practice is ~zero. If you start naming top-level
//      consts with common words (e.g. `const data = ...`), the false
//      positive rate goes up and you should switch to AST-based reference
//      detection.
//
// FALSE POSITIVE — what to do:
//   If this test fails for a const that genuinely isn't read during
//   init (e.g. it's only referenced inside a callback that fires later),
//   first verify by loading the app in a browser. If it really is safe,
//   the cleanest fix is usually still to move the declaration above
//   initialize() — it costs nothing and keeps the test green. Only
//   carve out an exception list as a last resort, and document why.
test("app.mjs: every const referenced by the init-time asset render path is declared before initialize()", () => {
  const callLine = lineOf(INITIALIZE_CALL_PATTERN);
  assert.ok(callLine > 0, "Top-level `initialize();` call not found.");

  const decls = moduleLevelConsts();

  // For each function in INIT_TIME_FUNCTIONS, pull its body and scan for
  // references to any top-level const declared *after* the initialize()
  // call site. Each such reference is a TDZ waiting to happen.
  const violations = [];
  for (const fnName of INIT_TIME_FUNCTIONS) {
    const body = extractFunctionBody(fnName);
    if (body == null) {
      // The function is missing or its name has changed. We deliberately
      // do NOT fail the test here, because we want INIT_TIME_FUNCTIONS
      // to tolerate renames and removals during refactors without
      // immediately blocking CI. The specific test above (for
      // ASSET_COLUMN_META) catches the regression we actually shipped.
      //
      // If you want a stricter posture — fail when a named function
      // disappears — add an assert.ok(body != null, ...) here AND commit
      // to updating INIT_TIME_FUNCTIONS in lockstep with every rename.
      continue;
    }
    for (const [name, declLine] of decls) {
      if (declLine <= callLine) continue; // declared early — safe
      // Word-boundary match: avoids matching ASSET_COLUMN_METADATA when
      // looking for ASSET_COLUMN_META. Does not distinguish identifier
      // use from property key / comment text — see limitation #3.
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
