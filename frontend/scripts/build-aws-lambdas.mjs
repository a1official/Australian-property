#!/usr/bin/env node
/** Build Lambda-ready CommonJS bundles without reading or writing secrets. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  execFileSync(process.execPath, [resolve(root, "node_modules", "esbuild", "bin", "esbuild"), entry, "--bundle", "--platform=node", "--target=node22", "--format=cjs", "--external:pdfkit", `--outfile=${file}`], {
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

  // pdfkit is external because its .afm font metrics and binary assets cannot be
  // inlined, so the package itself must travel in the zip. Without this the
  // function deploys cleanly and then fails at cold start with
  // "Cannot find module 'pdfkit'".
  if (/require\(['"]pdfkit['"]\)/.test(bundle)) {
    for (const [name, from] of collectRuntimeDependencies("pdfkit")) {
      // dereference: pnpm links packages into a virtual store, and Lambda needs
      // real files in the zip rather than symlinks.
      cpSync(from, resolve(dirname(file), "node_modules", name), { recursive: true, dereference: true });
    }
  }
}

/**
 * Resolves a package and its transitive runtime dependencies to real paths.
 *
 * Uses Node's resolver rather than assuming a flat node_modules layout: pnpm
 * links each package into a virtual store, so a dependency of pdfkit does not
 * exist at node_modules/<name>. Reading the manifests also avoids a hardcoded
 * list, which would silently go stale and only fail at Lambda cold start.
 */
function collectRuntimeDependencies(entry) {
  const resolved = new Map();
  const queue = [[entry, root]];

  while (queue.length) {
    const [name, from] = queue.shift();
    if (resolved.has(name)) continue;

    const directory = packageDirectory(name, from);
    if (!directory) continue; // Optional or platform-specific dependency.
    resolved.set(name, directory);

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    } catch {
      continue;
    }
    // Resolve each dependency from this package's own directory: under pnpm a
    // transitive dependency exists only inside the parent's virtual-store link.
    for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push([dependency, directory]);
  }
  return resolved;
}

/**
 * Locates a package's root directory.
 *
 * Resolving `<name>/package.json` directly is unreliable: packages with an
 * `exports` map (pdfkit among them) deliberately do not export their manifest,
 * so that lookup throws ERR_PACKAGE_PATH_NOT_EXPORTED. Instead the entry point
 * is resolved and its directory tree walked upward to the manifest that names
 * the package, which works with or without an exports field.
 */
function packageDirectory(name, from) {
  let entry;
  try {
    entry = createRequire(resolve(from, "package.json")).resolve(name);
  } catch {
    return null;
  }

  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    const manifestPath = resolve(directory, "package.json");
    try {
      if (JSON.parse(readFileSync(manifestPath, "utf8")).name === name) return directory;
    } catch {
      // Not a manifest, or not the one we want; keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
  }
}

console.log(`Built ${handlers.length} Lambda bundles in ${output}`);
