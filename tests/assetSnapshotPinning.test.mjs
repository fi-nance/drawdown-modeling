import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("asset snapshot pins one stable row ahead of the active sort", () => {
  assert.match(app, /const PINNED_ASSET_ROW_STORAGE_KEY =/);
  assert.match(app, /rowData\.findIndex\(\(row\) => row\.key === pinnedAssetRowKey\)/);
  assert.match(app, /rowData\.unshift\(rowData\.splice\(pinnedIndex, 1\)\[0\]\)/);
  assert.match(app, /data-pin-asset-row=/);
  assert.match(app, /aria-pressed=/);
  assert.match(app, /savePinnedAssetRowKey\(pinnedAssetRowKey\)/);
});

test("pinned asset remains represented before creation or after depletion", () => {
  assert.match(app, /assetKeyAppearsInYears\(years, pinnedAssetRowKey\)/);
  assert.match(app, /keys\.add\(pinnedAssetRowKey\)/);
  assert.match(app, /year\?\.beginningAssets, year\?\.assets/);
});

test("asset snapshot restores both scroll axes after a year rerender", () => {
  assert.match(app, /top: els\.assetBreakdownTable\.scrollTop/);
  assert.match(app, /left: els\.assetBreakdownTable\.scrollLeft/);
  assert.match(app, /restoreTableScrollPosition\(els\.assetBreakdownTable, scrollPosition\)/);
  assert.match(app, /container\.scrollTop = Math\.min/);
  assert.match(app, /proxy\.scrollLeft = container\.scrollLeft/);
});

test("pinned row is sticky below the measured table header", () => {
  assert.match(app, /--pinned-asset-row-top/);
  assert.match(css, /\.pinned-asset-row > td \{[\s\S]*?position: sticky;[\s\S]*?top: var\(--pinned-asset-row-top/);
  assert.match(css, /\.pinned-asset-row > td\.pinned-col/);
  assert.match(css, /\.asset-row-pin\.is-pinned/);
});

test("deployed shell cache-busts the row pin script and styles", () => {
  assert.match(html, /src\/app\.mjs\?v=[^"]*asset-row-pin/);
  assert.match(html, /src\/styles\.css\?v=[^"]*asset-row-pin/);
});
