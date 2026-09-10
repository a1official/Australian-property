#!/usr/bin/env node
/** Build Lambda-ready CommonJS bundles without reading or writing secrets. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "..", ".aws-build");
const handlers = [
  ["dispatch", "lambda/dispatch.ts"],
  ["report", "lambda/report-worker.ts"],
  ["delivery", "lambda/delivery.ts"],
];

for (const [name, entry] of handlers) {
  const file = resolve(output, name, "index.js");
  rmSync(dirname(file), { recursive: true, force: true });
  mkdirSync(dirname(file), { recursive: true });
  execFileSync(process.execPath, [resolve(root, "node_modules", "esbuild", "bin", "esbuild"), entry, "--bundle", "--platform=node", "--target=node22", "--format=cjs", `--outfile=${file}`], {
    cwd: root,
    stdio: "inherit",
  });
  // PDFKit uses import.meta.url for an optional PDF/A colour profile. Esbuild's
  // CommonJS lowering otherwise emits an empty object, which Node rejects.
  const bundle = readFileSync(file, "utf8").replace(
    "var import_meta = {};",
    'var import_meta = { url: require("node:url").pathToFileURL(__filename).href };',
  );
  writeFileSync(file, bundle);
}
console.log(`Built ${handlers.length} Lambda bundles in ${output}`);
