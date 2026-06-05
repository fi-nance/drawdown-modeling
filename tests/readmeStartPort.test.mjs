import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("private Sheets OAuth README origin matches the local start port", async () => {
  const [packageText, readme] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8")
  ]);
  const pkg = JSON.parse(packageText);
  const port = pkg.scripts?.start?.match(/http\.server\s+(\d+)/)?.[1];

  assert.equal(port, "4173");
  assert.ok(readme.includes(`http://127.0.0.1:${port}`));
  assert.doesNotMatch(readme, /127\.0\.0\.1:4175/);
});
