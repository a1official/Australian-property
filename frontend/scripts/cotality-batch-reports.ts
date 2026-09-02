/**
 * Run the existing local Parcel Atlas CSV-to-report workflow from a terminal.
 *
 * This script controls only http://localhost:3004 with Playwright. Cotality
 * credentials stay inside the running Next.js server; no Gmail account,
 * password, cookie, or browser profile is accessed.
 */

import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const ADDRESS_HEADERS = new Set(["address", "property address", "full address"]);
const MAX_BATCH_ROWS = 10;

type Options = {
  baseUrl: string;
  csvPath: string;
  headed: boolean;
  outputDir?: string;
  timeoutMs: number;
};

function usage(): string {
  return [
    "Generate Cotality Parcel Atlas HTML reports from a local CSV.",
    "",
    "pnpm cotality:batch -- --csv <path> [--output-dir <path>] [--headed] [--timeout <seconds>]",
    "",
    "The local app must already be running at http://localhost:3004.",
  ].join("\n");
}

function parseArguments(argumentsList: string[]): Options {
  let csvPath: string | undefined;
  let outputDir: string | undefined;
  let baseUrl = "http://localhost:3004";
  let headed = false;
  let timeoutMs = 300_000;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];
    if (argument === "--csv" && value) {
      csvPath = value;
      index += 1;
    } else if (argument === "--output-dir" && value) {
      outputDir = value;
      index += 1;
    } else if (argument === "--base-url" && value) {
      baseUrl = value;
      index += 1;
    } else if (argument === "--timeout" && value) {
      timeoutMs = Number(value) * 1000;
      index += 1;
    } else if (argument === "--headed") {
      headed = true;
    } else if (argument === "--") {
      // Ignore npm/pnpm argument separator
      continue;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete option: ${argument}`);
    }
  }

  if (!csvPath) {
    throw new Error("--csv is required.\n\n" + usage());
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number of seconds.");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), csvPath, headed, outputDir, timeoutMs };
}

async function validateCsv(csvPath: string): Promise<number> {
  await access(csvPath);
  const [headerLine, ...rows] = (await readFile(csvPath, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/);
  const headers = (headerLine ?? "").split(",").map((header) => header.trim().toLowerCase());
  const addressIndex = headers.findIndex((header) => ADDRESS_HEADERS.has(header));
  if (addressIndex < 0) {
    throw new Error("CSV requires an address, property address, or full address column.");
  }
  const addresses = rows.filter((row) => row.split(",")[addressIndex]?.trim());
  if (!addresses.length) {
    throw new Error("CSV does not contain any property addresses.");
  }
  if (addresses.length > MAX_BATCH_ROWS) {
    throw new Error(`CSV has ${addresses.length} addresses; this command allows at most ${MAX_BATCH_ROWS}.`);
  }
  return addresses.length;
}

async function ensureLocalApp(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`Parcel Atlas is not reachable at ${baseUrl}. Start it with: pnpm dev -- --port 3004`, { cause: error });
  }
}

function defaultOutputDirectory(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
  return path.resolve(process.cwd(), "..", "data", "reports", `cotality-batch-${stamp}`);
}

async function logManualReviewRows(page: import("playwright").Page): Promise<void> {
  const reviewRows = page.locator(
    ".batch-ledger article:has(.batch-status.review), .batch-ledger article:has(.batch-status.unmatched)"
  );
  const count = await reviewRows.count();
  if (!count) return;

  console.warn(`[review] ${count} CSV row${count === 1 ? " requires" : "s require"} manual property selection:`);
  for (let index = 0; index < count; index += 1) {
    const row = reviewRows.nth(index);
    const address = await row.locator(".batch-address strong").innerText().catch(() => "Unknown address");
    const status = await row.locator(".batch-status").innerText().catch(() => "review");
    const note = await row.locator(".batch-match p").innerText().catch(() => "Choose a Cotality suggestion before generating a report.");
    console.warn(`[review] ${address} — ${status}: ${note}`);
  }
}

async function batchStatusSummary(page: import("playwright").Page): Promise<string> {
  const rows = page.locator(".batch-ledger article");
  const count = await rows.count();
  const summary: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const address = await row.locator(".batch-address strong").innerText().catch(() => `row ${index + 1}`);
    const status = await row.locator(".batch-status").innerText().catch(() => "unknown");
    const error = await row.locator(".batch-error").innerText().catch(() => "");
    summary.push(`${address}: ${status.trim()}${error ? ` (${error.trim()})` : ""}`);
  }
  return summary.join("; ") || "No batch rows were rendered.";
}

async function waitForMatchingToSettle(
  page: import("playwright").Page,
  expectedRows: number,
  timeoutMs: number
): Promise<void> {
  const rows = page.locator(".batch-ledger article");
  await rows.first().waitFor({ state: "visible", timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  let lastProgress = "";

  while (Date.now() < deadline) {
    const rowCount = await rows.count();
    const matchingCount = await page.locator(".batch-status.matching").count();
    const progress = `${rowCount}/${expectedRows} rows; ${matchingCount} matching`;
    if (progress !== lastProgress) {
      console.log(`[match] ${progress}`);
      lastProgress = progress;
    }
    if (rowCount === expectedRows && matchingCount === 0) return;
    await page.waitForTimeout(250);
  }

  throw new Error(`Address matching did not finish within ${Math.ceil(timeoutMs / 1000)} seconds. ${await batchStatusSummary(page)}`);
}

async function waitForReports(
  page: import("playwright").Page,
  expectedReports: number,
  timeoutMs: number,
  outputDir: string
): Promise<number> {
  const downloads = page.getByRole("button", { name: "Download HTML", exact: true });
  const deadline = Date.now() + timeoutMs;
  let savedReports = 0;
  while (Date.now() < deadline) {
    const completed = await downloads.count();
    // Persist every completed report while later rows are still running. If
    // this process is interrupted, the Gmail job can resume from these files.
    while (savedReports < completed) {
      const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
      await downloads.nth(savedReports).click();
      const download = await downloadPromise;
      await download.saveAs(path.join(outputDir, download.suggestedFilename()));
      savedReports += 1;
      console.log(`[checkpoint] Saved report ${savedReports} of ${expectedReports}: ${download.suggestedFilename()}`);
    }
    const processing = await page.locator(".batch-status.processing").count();
    const failed = await page.locator(".batch-status.failed").count();
    const ready = await page.locator(".batch-status.ready").count();
    // Every row is processed serially. A failed property must not abort the
    // remaining approved rows; finish the queue and preserve partial success.
    if (completed + failed >= expectedReports && processing === 0 && ready === 0) return savedReports;
    await page.waitForTimeout(500);
  }
  throw new Error(`Only ${await downloads.count()} of ${expectedReports} approved reports completed within ${Math.ceil(timeoutMs / 1000)} seconds. ${await batchStatusSummary(page)}`);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const csvPath = path.resolve(options.csvPath);
  const outputDir = path.resolve(options.outputDir ?? defaultOutputDirectory());
  const expectedRows = await validateCsv(csvPath);
  await ensureLocalApp(options.baseUrl);
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const page = await browser.newPage();
    await page.goto(`${options.baseUrl}/#batch-reports`, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    const fileInput = page.locator('input[type="file"][accept*=".csv"]');
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    // The input is server-rendered before React hydration. Retry the upload if
    // the first change event lands before the client handler is attached.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await fileInput.setInputFiles([]);
      await fileInput.setInputFiles(csvPath);
      const rendered = await page.locator(".batch-ledger article").first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (rendered) break;
      if (attempt === 3) throw new Error("The CSV upload did not reach the hydrated batch interface after three attempts.");
      await page.waitForTimeout(1_000);
    }

    console.log(`[match] Matching ${expectedRows} CSV address${expectedRows === 1 ? "" : "es"}…`);
    await waitForMatchingToSettle(page, expectedRows, Math.min(options.timeoutMs, 90_000));

    // Only exact Cotality matches are eligible for unattended report
    // generation. Ambiguous rows are reported for a human to select.
    await logManualReviewRows(page);

    const generate = page.getByRole("button", { name: /^Generate \d+ reports?$/ });
    const readyCount = await page.locator(".batch-status.ready").count();
    if (!readyCount) {
      throw new Error("No validated properties are ready for report generation.");
    }
    await generate.waitFor({ state: "visible", timeout: 10_000 });
    if (!(await generate.isEnabled())) throw new Error(`Validated properties were found, but generation is disabled. ${await batchStatusSummary(page)}`);

    const label = await generate.innerText();
    const expectedReports = Number(label.match(/Generate\s+(\d+)\s+reports?/i)?.[1]);
    if (!Number.isInteger(expectedReports) || expectedReports < 1) {
      throw new Error(`Could not determine the number of approved reports from: ${label}`);
    }
    console.log(`[reports] Generating ${expectedReports} approved Cotality report${expectedReports === 1 ? "" : "s"}…`);
    await generate.click();
    const count = await waitForReports(page, expectedReports, options.timeoutMs, outputDir);
    if (!count) throw new Error(`No approved reports completed. ${await batchStatusSummary(page)}`);
    if (count < expectedReports) console.warn(`[reports] ${count} of ${expectedReports} approved reports completed. Failed rows: ${await batchStatusSummary(page)}`);
    console.log(`Generated ${count} approved Cotality HTML report(s) in: ${outputDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[cotality:batch] ${message}`);
  process.exitCode = 1;
});
