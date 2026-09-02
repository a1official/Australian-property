/**
 * Guards the migration outcome: the production mailbox path must not reach
 * Browserless or Playwright, and must not use Gmail passwords or cookies.
 *
 * This walks the real import graph from the worker entry point rather than
 * checking one file, because a transitive import would reintroduce the browser
 * dependency invisibly.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const WORKER_ENTRY = resolve(process.cwd(), "scripts", "render-worker.ts");

/** Collects the transitive set of local modules reachable from an entry file. */
function localImportGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];

  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file) || !existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);

    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      let resolved: string | null = null;
      if (specifier.startsWith(".")) resolved = resolve(dirname(file), specifier);
      else if (specifier.startsWith("@/")) resolved = resolve(process.cwd(), specifier.slice(2));
      if (!resolved) continue;

      for (const candidate of [`${resolved}.ts`, `${resolved}.tsx`, resolve(resolved, "index.ts")]) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return seen;
}

const graph = localImportGraph(WORKER_ENTRY);

test("the worker import graph was actually traversed", () => {
  // Without this, an empty graph would make every assertion below vacuous.
  assert.ok(graph.size > 5, `expected several modules, found ${graph.size}`);
  assert.ok([...graph.keys()].some((file) => file.endsWith("gmail-mailbox.ts")), "the Gmail API adapter must be reachable");
});

test("no module reachable from the worker imports playwright", () => {
  for (const [file, source] of graph) {
    assert.ok(
      !/from\s+["']playwright(-core)?["']/.test(source),
      `${file} imports Playwright, which the production mailbox path must not use`,
    );
  }
});

/** Strips comments so prose cannot trigger a false positive. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no module reachable from the worker connects to Browserless", () => {
  for (const [file, source] of graph) {
    const code = codeOnly(source);
    // A comment stating Browserless is unused must not fail this check, so only
    // executable references count.
    assert.ok(!/browserless/i.test(code), `${file} references Browserless in code`);
    assert.ok(!/connectOverCDP/.test(code), `${file} opens a CDP browser connection`);
    assert.ok(!/BROWSERLESS_(WS_ENDPOINT|API_KEY)/.test(code), `${file} reads Browserless configuration`);
  }
});

test("the worker does not use Gmail passwords or cookies", () => {
  for (const [file, source] of graph) {
    const code = codeOnly(source);
    assert.ok(!/GMAIL_PASSWORD/.test(code), `${file} still reads GMAIL_PASSWORD`);
    assert.ok(!/GMAIL_USERNAME/.test(code), `${file} still reads GMAIL_USERNAME`);
    assert.ok(!/gmail-session\.json/.test(code), `${file} still reads a cookie session file`);
    assert.ok(!/loadGmailSession|saveGmailSession/.test(code), `${file} still uses browser session storage`);
  }
});

test("the worker uses the Gmail API over OAuth", () => {
  const combined = [...graph.values()].join("\n");
  assert.match(combined, /gmail\.googleapis\.com/, "the Gmail REST API must be used");
  assert.match(combined, /refreshAccessToken/, "an access token must be obtained from the refresh token");
});

test("the worker never spawns a child process for mailbox work", () => {
  for (const [file, source] of graph) {
    assert.ok(!/child_process/.test(source), `${file} spawns a child process`);
  }
});

test("the dispatch route stays lightweight", () => {
  const route = readFileSync(resolve(process.cwd(), "app", "api", "pipeline", "trigger", "route.ts"), "utf8");
  // Check import specifiers rather than raw text: a substring search matches
  // ordinary prose such as "lightweight" and reports a false positive.
  const imports = [...route.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1].toLowerCase());
  for (const forbidden of ["playwright", "playwright-core", "child_process", "node:child_process"]) {
    assert.ok(!imports.includes(forbidden), `the dispatch route must not import ${forbidden}`);
  }
  for (const forbidden of ["corelogic", "gmail-mailbox", "gmail-api", "report-pipeline"]) {
    assert.ok(
      !imports.some((specifier) => specifier.includes(forbidden)),
      `the dispatch route must not import ${forbidden}`,
    );
  }
});

test("no refresh token or client secret is logged", () => {
  for (const [file, source] of graph) {
    const logCalls = source.match(/logger\.(info|warn|error|debug)\([\s\S]*?\)/g) ?? [];
    for (const call of logCalls) {
      assert.ok(!/refresh_?token/i.test(call), `${file} logs a refresh token`);
      assert.ok(!/clientSecret|client_secret/.test(call), `${file} logs the client secret`);
      assert.ok(!/accessToken(?!s)/.test(call) || /token_refreshed/.test(call), `${file} may log an access token`);
    }
  }
});
