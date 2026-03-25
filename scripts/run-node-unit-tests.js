#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const unitDir = join(root, "tests", "unit");
const skipNames = new Set([
  "search-event-analyzer.test.js",
  "search-event-recorder.test.js"
]);

const files = readdirSync(unitDir)
  .filter((name) => name.endsWith(".test.js"))
  .filter((name) => !skipNames.has(name))
  .map((name) => join("tests", "unit", name))
  .sort();

if (files.length === 0) {
  console.error("No node:test unit files found.");
  process.exit(1);
}

execFileSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  cwd: root
});
