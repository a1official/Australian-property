#!/usr/bin/env tsx
/**
 * Probes whether the street search accepts a larger page size.
 *
 * If it does, a deep property can be reached in a few requests instead of
 * scanning a hundred pages, which removes the need for a large page budget.
 * A handful of requests only; read-only.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

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

import { corelogicRequest } from "../lib/corelogic";
import { record } from "../lib/report-html";
import { searchSummaries } from "../lib/search-reference";

const STREET_ID = process.argv[2] ?? "249524";
const TARGET_ID = Number(process.argv[3] ?? 52479028);

async function main(): Promise<void> {
  for (const query of ["?page=0", "?page=0&size=200", "?page=0&pageSize=200", "?page=0&limit=200"]) {
    const result = await corelogicRequest(`/search/au/property/street/${STREET_ID}${query}`);
    if (!result.ok) {
      console.log(`${query.padEnd(24)} HTTP ${result.status}`);
      continue;
    }
    const page = record(record(result.data).page);
    const rows = searchSummaries(result.data);
    console.log(
      `${query.padEnd(24)} HTTP 200  rows ${String(rows.length).padStart(4)}  ` +
        `size ${page.size ?? "?"}  totalPages ${page.totalPages ?? "?"}  totalElements ${page.totalElements ?? "?"}` +
        (rows.some((row) => Number(row.id) === TARGET_ID) ? "  <= target present" : ""),
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
