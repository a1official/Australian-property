#!/usr/bin/env tsx
/**
 * Diagnoses why one address fails the bounded street search.
 *
 * Read-only Cotality queries: resolves the suggestion, then reports how many
 * street pages exist and where (or whether) the exact property ID appears.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

import { corelogicRequest } from "../lib/corelogic";
import { record } from "../lib/report-html";
import { searchSummaries } from "../lib/search-reference";

for (const candidate of [
  nodePath.resolve(process.cwd(), "..", ".env"),
  nodePath.resolve(process.cwd(), ".env"),
  nodePath.resolve(process.cwd(), ".env.local"),
]) {
  if (!existsSync(candidate)) continue;
  for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

async function run(): Promise<void> {
  const address = process.argv.slice(2).join(" ") || "438/81 Grima Street, Schofields NSW 2762";
  console.log(`address: ${address}\n`);

  const suggestion = await corelogicRequest(`/property/au/v2/suggest.json?q=${encodeURIComponent(address.slice(0, 160))}`);
  console.log(`suggest http: ${suggestion.status}`);
  const items = record(suggestion.data).suggestions;
  const list = Array.isArray(items) ? items.map(record) : [];
  console.log(`suggestions: ${list.length}`);
  for (const item of list.slice(0, 5)) {
    console.log(`  propertyId=${item.propertyId} streetId=${item.streetId} "${item.suggestion}"`);
  }
  if (!list.length) {
    console.log("\nVERDICT: Cotality returns no suggestion for this address at all.");
    return;
  }

  const target = list[0];
  const propertyId = Number(target.propertyId);
  const streetId = Number(target.streetId);
  console.log(`\nusing propertyId=${propertyId} streetId=${streetId}`);

  const first = await corelogicRequest(`/search/au/property/street/${streetId}?page=0`);
  console.log(`street page 0 http: ${first.status}`);
  const page = record(record(first.data).page);
  const totalPages = Number(page.totalPages);
  const totalElements = Number(page.totalElements);
  console.log(`totalPages=${totalPages} totalElements=${totalElements} pageSize=${page.size}`);

  const summaries = searchSummaries(first.data);
  console.log(`page 0 summaries: ${summaries.length}`);
  console.log(`exact on page 0: ${summaries.some((item) => Number(item.id) === propertyId)}`);

  // The worker scans at most 75 pages. Report whether the target is reachable
  // inside that bound, and if not, where it actually sits.
  const bound = Number.isFinite(totalPages) ? Math.min(Math.floor(totalPages), 75) : 25;
  console.log(`worker page bound: ${bound}${totalPages > 75 ? `  (street has ${totalPages}, so pages ${75}-${totalPages} are never scanned)` : ""}`);

  let foundPage = summaries.some((item) => Number(item.id) === propertyId) ? 0 : -1;
  if (foundPage < 0) {
    for (let index = 1; index < Math.min(totalPages, 120); index += 1) {
      const result = await corelogicRequest(`/search/au/property/street/${streetId}?page=${index}`);
      if (!result.ok) {
        console.log(`  page ${index}: http ${result.status} — scan stopped`);
        break;
      }
      if (searchSummaries(result.data).some((item) => Number(item.id) === propertyId)) {
        foundPage = index;
        break;
      }
    }
  }

  console.log(`\nexact property found on page: ${foundPage < 0 ? "NOT FOUND in any scanned page" : foundPage}`);
  if (foundPage < 0) {
    console.log("VERDICT: the suggestion's propertyId does not appear in its own street listing.");
  } else if (foundPage >= bound) {
    console.log(`VERDICT: the property sits on page ${foundPage}, beyond the worker's ${bound}-page bound.`);
  } else {
    console.log("VERDICT: reachable within the bound; the failure is likely transient.");
  }
}

void run().catch((error: unknown) => {
  console.error(`diagnosis failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
