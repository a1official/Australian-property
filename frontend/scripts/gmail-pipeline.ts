#!/usr/bin/env tsx
/**
 * gmail-pipeline.ts
 *
 * Full TypeScript + Playwright Gmail crawl pipeline.
 * Zero Python required.
 *
 * What it does:
 *  1. Connects to real cloud Chrome via Browserless WebSocket (CDP)
 *  2. Injects saved Gmail session — no password prompt
 *  3. Searches inbox for emails with CSV attachments
 *  4. Downloads each new CSV (skips checkpointed ones)
 *  5. Runs `pnpm cotality:batch` against https://australian-property.vercel.app
 *  6. Attaches the generated HTML reports and replies to the original sender
 *  7. Saves checkpoints so the same email is never processed twice
 *
 * Usage:
 *   pnpm gmail:pipeline
 *   pnpm gmail:pipeline -- --force          # re-process already completed
 *   pnpm gmail:pipeline -- --headed         # show the remote browser (debug)
 *   pnpm gmail:pipeline -- --max-emails 3
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import * as nodePath from "node:path";
import * as nodeProcess from "node:process";
import { chromium, type BrowserContext } from "playwright-core";

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

const ROOT_DIR = nodePath.resolve(__dirname, "..", "..");
const LOCAL_DIR = nodePath.resolve(ROOT_DIR, ".local");
const DATA_DIR = nodePath.resolve(ROOT_DIR, "data");
const FRONTEND_DIR = nodePath.resolve(ROOT_DIR, "frontend");

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .flatMap((line) => {
          const match = line.match(/^([^#][^=]*)=(.*)/);
          return match ? [[match[1].trim(), match[2].trim()]] : [];
        })
    );
  } catch {
    return {};
  }
}

const env = {
  ...parseEnvFile(nodePath.resolve(ROOT_DIR, ".env")),
  ...process.env,
};

function getEnv(key: string, fallback = ""): string {
  return env[key] || fallback;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

type PipelineOptions = {
  force: boolean;
  headed: boolean;
  maxEmails: number;
  query: string;
  baseUrl: string;
  timeoutMs: number;
  dryRun: boolean;
};

function parseArgs(args: string[]): PipelineOptions {
  const opts: PipelineOptions = {
    force: false,
    headed: false,
    maxEmails: 10,
    // Gmail marks a thread read when Playwright opens it. Completion is
    // therefore governed by the checkpoint ledger, not the UNREAD label.
    query: "has:attachment filename:csv -from:me",
    baseUrl: getEnv("PARCEL_ATLAS_BASE_URL", "https://australian-property.vercel.app"),
    timeoutMs: 60_000,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--force") opts.force = true;
    else if (arg === "--headed") opts.headed = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--max-emails" && next) { opts.maxEmails = Number(next); i++; }
    else if (arg === "--query" && next) { opts.query = next; i++; }
    else if (arg === "--base-url" && next) { opts.baseUrl = next; i++; }
    else if (arg === "--timeout" && next) { opts.timeoutMs = Number(next) * 1000; i++; }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Checkpoint ledger (pure Node.js — no server-only, no Next.js)
// ---------------------------------------------------------------------------

type CheckpointRecord = {
  key: string;
  sender: string;
  subject: string;
  fileName: string;
  csvHash: string;
  downloadedAt: string;
  reportFiles: string[];
  replySent: boolean;
  replySentAt?: string;
  status?: "processing" | "sent" | "failed";
  processingStartedAt?: string;
  error?: string;
  outputDir?: string;
  properties?: Record<string, PropertyCheckpoint>;
};

type PropertyCheckpoint = {
  propertyId?: number;
  address: string;
  status: "pending" | "completed" | "unmatched";
  reportFile?: string;
  updatedAt: string;
  error?: string;
};

type CheckpointStore = {
  lastUpdated: string;
  records: Record<string, CheckpointRecord>;
};

type StoredCheckpointFile = {
  lastUpdated?: string;
  records?: Record<string, CheckpointRecord>;
  processedMessages?: Record<string, CheckpointRecord>;
};

const CHECKPOINT_PATH = nodePath.resolve(LOCAL_DIR, "gmail-checkpoints.json");

function loadCheckpoints(): CheckpointStore {
  try {
    const stored = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8")) as StoredCheckpointFile;
    return {
      lastUpdated: stored.lastUpdated || new Date().toISOString(),
      // The Next.js helper historically called this processedMessages while
      // the CLI called it records. Read either shape so both entry points share
      // one checkpoint ledger without crashing or losing completed jobs.
      records: stored.records || stored.processedMessages || {},
    };
  } catch {
    return { lastUpdated: new Date().toISOString(), records: {} };
  }
}

function saveCheckpoints(store: CheckpointStore): void {
  mkdirSync(LOCAL_DIR, { recursive: true });
  writeFileSync(CHECKPOINT_PATH, JSON.stringify({
    lastUpdated: new Date().toISOString(),
    totalProcessed: Object.keys(store.records).length,
    processedMessages: store.records,
  }, null, 2));
}

function computeKey(sender: string, subject: string, fileName: string, csvContent: string): string {
  const contentHash = createHash("sha256").update(csvContent.trim()).digest("hex").slice(0, 16);
  const raw = `${sender.toLowerCase().trim()}|${subject.trim()}|${fileName.trim()}|${contentHash}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// Remote Chrome connection + auto-login if session is missing / expired
// ---------------------------------------------------------------------------

async function saveSession(context: BrowserContext): Promise<void> {
  try {
    mkdirSync(LOCAL_DIR, { recursive: true });
    const state = await context.storageState();
    writeFileSync(
      nodePath.resolve(LOCAL_DIR, "gmail-session.json"),
      JSON.stringify(state, null, 2),
      { mode: 0o600 }
    );
    console.log("[session] Session tokens saved to .local/gmail-session.json");
  } catch (err) {
    console.warn("[session] Could not save session:", err instanceof Error ? err.message : String(err));
  }
}

async function performGoogleLogin(page: import("playwright-core").Page, username: string, password: string): Promise<boolean> {
  console.log(`[login] Starting Google login for ${username}…`);
  try {
    await page.goto("https://accounts.google.com/signin/v2/identifier", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(2000);

    // If on account chooser screen, click the account or "Use another account"
    const accountChoice = page.locator(`[data-email="${username}"], div[data-identifier="${username}"]`).first();
    if (await accountChoice.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log(`[login] Selecting existing account ${username} from account chooser…`);
      await accountChoice.click();
      await page.waitForTimeout(2000);
    }

    // Step 1: Enter email (if email input is present)
    const emailInput = page.locator('input[type="email"], input[name="identifier"]').first();
    if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`[login] Entering username ${username}…`);
      await emailInput.fill(username);
      const nextBtn = page.locator('#identifierNext, button:has-text("Next")').first();
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click();
      } else {
        await page.keyboard.press("Enter");
      }
      await page.waitForTimeout(3000);
    }

    // Step 2: Enter password (exclude hidden honeypot password field)
    console.log("[login] Waiting for password input…");
    const passwordInput = page.locator('input[name="Passwd"], input[type="password"]:not([name="hiddenPassword"]):not([aria-hidden="true"])').first();
    await passwordInput.waitFor({ state: "visible", timeout: 20_000 });
    await passwordInput.fill(password);

    const passwordNext = page.locator('#passwordNext, button:has-text("Next")').first();
    if (await passwordNext.isVisible().catch(() => false)) {
      await passwordNext.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(5000);

    // Step 3: Handle post-login prompts (Stay signed in? / 2FA challenge)
    const currentUrl = page.url();

    if (currentUrl.includes("challenge") || currentUrl.includes("signin/v2/challenge")) {
      console.warn(
        "[login] Google is showing a security challenge (2FA / CAPTCHA).\n" +
        "        Please complete the login in a browser or set up an App Password / Session."
      );
      return false;
    }

    // Dismiss "Stay signed in?" or "Turn on sync?" prompts
    for (const buttonText of ["Not now", "No thanks", "Skip", "Continue"]) {
      const btn = page.locator(`button:has-text("${buttonText}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1500);
      }
    }

    // Verify we reached Gmail
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    if (finalUrl.startsWith("https://mail.google.com") && !finalUrl.includes("accounts.google.com")) {
      console.log("[login] ✓ Login successful!");
      return true;
    }

    console.warn(`[login] Login may have failed — ended up at: ${finalUrl}`);
    return false;
  } catch (err) {
    console.error("[login] Login error:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function isSessionValid(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await page.waitForTimeout(2000);
    const url = page.url();
    // Must be on mail.google.com and NOT redirected to accounts.google.com
    return url.startsWith("https://mail.google.com") && !url.includes("accounts.google.com");
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

async function connectBrowser(): Promise<{ context: BrowserContext; browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> }> {
  const apiKey = getEnv("BROWSERLESS_API_KEY");
  const rawWs = getEnv("BROWSERLESS_WS_ENDPOINT");
  let wsEndpoint = rawWs || (apiKey ? `wss://production-sfo.browserless.io?token=${apiKey}` : "");

  if (!wsEndpoint) {
    throw new Error(
      "No Browserless endpoint found.\n" +
      "Set BROWSERLESS_API_KEY or BROWSERLESS_WS_ENDPOINT in your .env file."
    );
  }

  // Append stealth parameters so Google Sign-In on Browserless avoids /v3/signin/rejected bot checks
  if (!wsEndpoint.includes("stealth=true")) {
    const separator = wsEndpoint.includes("?") ? "&" : "?";
    wsEndpoint = `${wsEndpoint}${separator}stealth=true&--disable-blink-features=AutomationControlled`;
  }

  console.log(`[browser] Connecting to ${wsEndpoint.replace(/token=[^&]+/, "token=***")}`);
  const browser = await chromium.connectOverCDP(wsEndpoint);

  // Try loading saved session first
  let storageState: object | undefined;
  const sessionPath = nodePath.resolve(LOCAL_DIR, "gmail-session.json");
  try {
    storageState = JSON.parse(await readFile(sessionPath, "utf8")) as object;
    console.log("[session] Loaded saved session from gmail-session.json");
  } catch {
    console.log("[session] No saved session found — will attempt login.");
  }

  // Create context (with or without saved session)
  const context = await browser.newContext({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(storageState ? { storageState: storageState as any } : {}),
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  // Validate session — if expired or missing, auto-login using .env credentials
  const sessionOk = await isSessionValid(context);

  if (!sessionOk) {
    const username = getEnv("GMAIL_USERNAME");
    const password = getEnv("GMAIL_PASSWORD");

    if (!username || !password) {
      throw new Error(
        "Gmail session is not valid and no credentials are configured.\n" +
        "Either run `pnpm gmail:auth` to create a saved session,\n" +
        "or set GMAIL_USERNAME and GMAIL_PASSWORD in your .env file."
      );
    }

    console.log("[session] Session expired or missing — creating clean context and logging in with .env credentials…");
    await context.close();

    // Create a fresh context without expired cookies for a clean login flow
    const cleanContext = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });

    const loginPage = await cleanContext.newPage();
    const loginOk = await performGoogleLogin(loginPage, username, password);
    await loginPage.close();

    if (!loginOk) {
      throw new Error(
        "Auto-login failed.\n" +
        "Please run `pnpm gmail:auth` manually in your local browser to complete login,\n" +
        "then re-run `pnpm gmail:pipeline`."
      );
    }

    // Save the freshly authenticated session for next time
    await saveSession(cleanContext);
    return { browser, context: cleanContext };
  } else {
    console.log("[session] ✓ Session is valid.");
  }

  return { browser, context };
}

// ---------------------------------------------------------------------------
// Gmail crawl — search inbox and extract CSV attachments
// ---------------------------------------------------------------------------

type CsvAttachment = {
  key: string;
  sender: string;
  subject: string;
  fileName: string;
  csvContent: string;
  csvPath: string;
  skipped: boolean;
};

async function crawlInbox(
  context: BrowserContext,
  opts: PipelineOptions,
  checkpoints: CheckpointStore
): Promise<CsvAttachment[]> {
  const page = await context.newPage();
  const results: CsvAttachment[] = [];
  const keysSeenThisScan = new Set<string>();

  try {
    console.log("[gmail] Navigating to inbox…");
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs,
    });
    await page.waitForTimeout(3000);

    // Type the search query into Gmail
    const searchInput = page.locator('input[name="q"], input[aria-label*="Search"]').first();
    if (await searchInput.isVisible()) {
      console.log(`[gmail] Searching: ${opts.query}`);
      await searchInput.click();
      await searchInput.fill(opts.query);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(4000);
    }

    const rows = await page.locator('div[role="main"] tr.zA').all();
    console.log(`[gmail] Found ${rows.length} matching thread(s).`);

    for (let i = 0; i < Math.min(rows.length, opts.maxEmails); i++) {
      console.log(`\n[gmail] Opening thread ${i + 1} of ${Math.min(rows.length, opts.maxEmails)}…`);
      try {
        await rows[i].click();
        await page.waitForTimeout(3000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1500);

        // Extract subject
        const subjectEl = page.locator("h2.hP").first();
        const subject = (await subjectEl.isVisible()) ? (await subjectEl.innerText()).trim() : "Property Review Request";

        // Extract sender email — try multiple Gmail DOM patterns
        let sender = "";
        for (const sel of [
          "span[email]",
          "span[data-hovercard-id]",
          ".gD[email]",
          ".zF[email]",
          "span.go",
        ]) {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
            sender = (
              (await el.getAttribute("email")) ??
              (await el.getAttribute("data-hovercard-id")) ??
              (await el.innerText().catch(() => ""))
            ).trim().toLowerCase();
            if (sender) break;
          }
        }
        // Last resort: grab from page title or "from" header text
        if (!sender) {
          const fromEl = page.locator('.gE.iv.gt span, .go').first();
          if (await fromEl.isVisible({ timeout: 1000 }).catch(() => false)) {
            const raw = await fromEl.innerText().catch(() => "");
            const match = raw.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
            if (match) sender = match[0].toLowerCase();
          }
        }
        console.log(`[gmail] Thread sender: ${sender || "(unknown)"}`);

        // Find CSV attachment via download_url attribute
        let csvContent = "";
        let fileName = "property-batch.csv";
        let csvPath = "";

        const attachments = await page.locator("[download_url]").all();
        for (const node of attachments) {
          const rawUrl = (await node.getAttribute("download_url")) ?? "";
          if (!rawUrl.toLowerCase().includes(".csv")) continue;

          // download_url format: "text/csv:filename.csv:https://..."
          const parts = rawUrl.split(":");
          if (parts.length >= 3) {
            fileName = parts[1] || fileName;
            const directUrl = parts.slice(2).join(":");
            console.log(`[gmail] Downloading attachment: ${fileName}`);
            const response = await context.request.get(directUrl);
            if (response.ok()) {
              const bytes = await response.body();
              csvContent = bytes.toString("utf8");

              // Save CSV to disk for cotality:batch
              const incomingDir = nodePath.resolve(DATA_DIR, "incoming_csv");
              mkdirSync(incomingDir, { recursive: true });
              const ts = Date.now();
              csvPath = nodePath.resolve(incomingDir, `${ts}-${fileName}`);
              writeFileSync(csvPath, csvContent, "utf8");
              console.log(`[gmail] Saved CSV: ${csvPath} (${csvContent.length} chars)`);
              break;
            }
          }
        }

        if (!csvContent) {
          console.log(`[gmail] No readable CSV in thread ${i + 1}, skipping.`);
          await page.goBack();
          await page.waitForTimeout(2000);
          continue;
        }

        // Checkpoint check
        const key = computeKey(sender, subject, fileName, csvContent);
        const existing = checkpoints.records[key];

        if (keysSeenThisScan.has(key)) {
          console.log(`[checkpoint] Duplicate CSV in this scan: ${fileName} from ${sender || "(unknown)"} — skipping.`);
          results.push({ key, sender, subject, fileName, csvContent, csvPath, skipped: true });
          await page.goBack();
          await page.waitForTimeout(2000);
          continue;
        }
        keysSeenThisScan.add(key);

        if (existing?.replySent && !opts.force) {
          console.log(`[checkpoint] Already completed: ${fileName} from ${sender || "(unknown)"} — skipping.`);
          results.push({ key, sender, subject, fileName, csvContent, csvPath, skipped: true });
          await page.goBack();
          await page.waitForTimeout(2000);
          continue;
        }

        // Register a new job or resume the same unfinished job. Preserve
        // previously saved reports so a retry cannot start the CSV from zero.
        checkpoints.records[key] = {
          ...existing,
          key,
          sender,
          subject,
          fileName,
          csvHash: createHash("sha256").update(csvContent).digest("hex"),
          downloadedAt: existing?.downloadedAt || new Date().toISOString(),
          reportFiles: existing?.reportFiles || [],
          replySent: false,
          status: "processing",
          processingStartedAt: existing?.processingStartedAt || new Date().toISOString(),
        };
        hydrateCompletedProperties(checkpoints.records[key]);
        saveCheckpoints(checkpoints);

        results.push({ key, sender, subject, fileName, csvContent, csvPath, skipped: false });
        console.log(`[gmail] Queued: ${fileName} from ${sender || "(unknown)"} → key ${key}`);

        await page.goBack();
        await page.waitForTimeout(2000);
      } catch (threadErr) {
        console.error(`[gmail] Error in thread ${i + 1}:`, threadErr);
        try { await page.goBack(); } catch { /* ignore */ }
        await page.waitForTimeout(1500);
      }
    }
  } finally {
    await page.close();
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report generation via pnpm cotality:batch
// ---------------------------------------------------------------------------

type ReportResult = {
  reportFiles: string[];
  outputDir: string;
};

async function createPendingCsv(
  item: CsvAttachment,
  record: CheckpointRecord,
  opts: PipelineOptions,
  checkpoints: CheckpointStore
): Promise<{ csvPath: string | null; pendingPropertyIds: number[] }> {
  const rows = parseCsv(item.csvContent.replace(/^\uFEFF/, ""));
  const headers = rows[0] || [];
  const addressColumn = headers.findIndex((header) => ["address", "property address", "full address"].includes(header.trim().toLowerCase()));
  if (addressColumn < 0) throw new Error("CSV requires an address, property address, or full address column.");

  hydrateCompletedProperties(record);
  const pendingRows: string[][] = [headers];
  const pendingPropertyIds: number[] = [];
  for (const row of rows.slice(1)) {
    const address = row[addressColumn]?.trim();
    if (!address) continue;
    let propertyId: number | null = null;
    let matcherResponded = false;
    try {
      const response = await fetch(`${opts.baseUrl}/api/corelogic/match?q=${encodeURIComponent(address)}`, {
        signal: AbortSignal.timeout(60_000),
      });
      const payload = await response.json().catch(() => null) as { matchDetails?: { propertyId?: number; matchType?: string } } | null;
      const candidateId = Number(payload?.matchDetails?.propertyId);
      matcherResponded = response.ok;
      if (response.ok && payload?.matchDetails?.matchType === "E" && Number.isSafeInteger(candidateId) && candidateId > 0) {
        propertyId = candidateId;
      }
    } catch (error) {
      console.warn(`[checkpoint] Could not pre-match ${address}; leaving it for the normal batch matcher. ${error instanceof Error ? error.message : String(error)}`);
    }

    if (propertyId) {
      const propertyKey = String(propertyId);
      const existing = record.properties?.[propertyKey];
      if (existing?.status === "completed" && existing.reportFile && existsSync(existing.reportFile)) {
        console.log(`[checkpoint] Report already saved for ${address} (property ${propertyId}) — skipping generation.`);
        continue;
      }
      record.properties ||= {};
      record.properties[propertyKey] = {
        propertyId,
        address,
        status: "pending",
        updatedAt: new Date().toISOString(),
      };
      pendingPropertyIds.push(propertyId);
    } else if (matcherResponded) {
      // A successful non-exact match requires human review; it must not be
      // retried indefinitely or silently used to generate a report.
      record.properties ||= {};
      const unresolvedKey = `address:${createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 12)}`;
      record.properties[unresolvedKey] = {
        address,
        status: "unmatched",
        updatedAt: new Date().toISOString(),
        error: "No exact Cotality Address Matcher result.",
      };
      saveCheckpoints(checkpoints);
      console.warn(`[checkpoint] ${address} needs manual review — no report will be generated automatically.`);
      continue;
    } else {
      // A temporary matcher failure remains in the pending CSV. The normal
      // batch matcher gets a second chance, and the next job retry will too.
      console.warn(`[checkpoint] Address Matcher did not respond for ${address}; keeping it pending for retry.`);
    }
    pendingRows.push(row);
    saveCheckpoints(checkpoints);
  }

  if (pendingRows.length === 1) return { csvPath: null, pendingPropertyIds };
  const jobDirectory = nodePath.resolve(LOCAL_DIR, "pipeline-jobs");
  mkdirSync(jobDirectory, { recursive: true });
  const pendingPath = nodePath.resolve(jobDirectory, `${item.key}-pending.csv`);
  writeFileSync(pendingPath, pendingRows.map(csvLine).join("\r\n") + "\r\n", "utf8");
  console.log(`[checkpoint] ${pendingRows.length - 1} remaining property row(s) written to ${pendingPath}`);
  return { csvPath: pendingPath, pendingPropertyIds };
}

async function generateReports(csvPath: string, outputDir: string, opts: PipelineOptions): Promise<ReportResult> {
  mkdirSync(outputDir, { recursive: true });

  const batchTimeoutSeconds = 900;
  const args = [
    nodePath.resolve(FRONTEND_DIR, "node_modules", "tsx", "dist", "cli.mjs"),
    nodePath.resolve(FRONTEND_DIR, "scripts", "cotality-batch-reports.ts"),
    "--csv", csvPath,
    "--output-dir", outputDir,
    "--base-url", opts.baseUrl,
    "--timeout", String(batchTimeoutSeconds),
  ];
  if (opts.headed) args.push("--headed");

  console.log(`[reports] Running Cotality batch with a ${batchTimeoutSeconds / 60}-minute limit: ${csvPath}`);
  try {
    const child = spawn(nodeProcess.execPath, args, {
      cwd: FRONTEND_DIR,
      env: nodeProcess.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stream = (chunk: Buffer) => chunk.toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => console.log(`[reports] ${line}`));
    child.stdout.on("data", stream);
    child.stderr.on("data", stream);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Cotality batch exceeded ${batchTimeoutSeconds / 60} minutes.`));
      }, batchTimeoutSeconds * 1_000 + 30_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (exitCode !== 0) console.warn(`[reports] Cotality batch exited with code ${exitCode ?? "unknown"}; successful reports will still be collected.`);
  } catch (err: unknown) {
    console.warn(`[reports] cotality:batch error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Collect generated HTMLs (exclude summary index)
  const reportFiles = existsSync(outputDir)
    ? readdirSync(outputDir)
        .filter((f) => f.endsWith(".html") && !f.startsWith("00-"))
        .map((f) => nodePath.resolve(outputDir, f))
    : [];

  console.log(`[reports] Generated ${reportFiles.length} report(s) in: ${outputDir}`);
  return { reportFiles, outputDir };
}

// ---------------------------------------------------------------------------
// Send Gmail reply with attached reports
// ---------------------------------------------------------------------------

async function sendReply(
  context: BrowserContext,
  opts: PipelineOptions,
  attachment: CsvAttachment,
  reportFiles: string[]
): Promise<boolean> {
  if (!attachment.sender || !reportFiles.length) {
    console.warn("[reply] No sender address or no reports — skipping reply.");
    return false;
  }

  console.log(`\n[reply] Composing reply to ${attachment.sender} with ${reportFiles.length} report(s)…`);
  const page = await context.newPage();
  let usedComposeFallback = false;

  try {
    // Open Gmail compose / new message
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs,
    });
    await page.waitForTimeout(3000);

    // Search for the thread so we can reply directly
    const searchInput = page.locator('input[name="q"]').first();
    if (await searchInput.isVisible()) {
      const searchQuery = `from:${attachment.sender} subject:${attachment.subject.slice(0, 40)}`;
      await searchInput.click();
      await searchInput.fill(searchQuery);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3000);
    }

    // Open the thread
    const firstRow = page.locator('div[role="main"] tr.zA').first();
    if (await firstRow.isVisible()) {
      await firstRow.click();
      await page.waitForTimeout(3000);

      // Click Reply button
      const replyBtn = page.locator('button[data-tooltip*="Reply"], button[aria-label*="Reply"]').first();
      if (await replyBtn.isVisible({ timeout: 5000 })) {
        await replyBtn.click();
      } else {
        // Try the "r" keyboard shortcut
        await page.keyboard.press("r");
      }
      await page.waitForTimeout(2000);
    } else {
      // Fallback: use Compose
      console.log("[reply] Thread not found, using Compose instead.");
      usedComposeFallback = true;
      const composeBtn = page.locator('div[role="button"]:has-text("Compose")').first();
      await composeBtn.click();
      await page.waitForTimeout(2000);

      // Gmail does not send a draft if an address is merely typed; Enter
      // commits it as a recipient chip. Verify that chip before continuing.
      const toField = page.locator(
        'input[aria-label="To recipients"], input[aria-label^="To"], textarea[name="to"], input[name="to"]'
      ).first();
      await toField.waitFor({ state: "visible", timeout: 10_000 });
      await toField.fill(attachment.sender);
      await page.keyboard.press("Enter");
      const recipientChip = page.locator(
        `[email="${attachment.sender}"], [data-hovercard-id="${attachment.sender}"]`
      ).last();
      await recipientChip.waitFor({ state: "visible", timeout: 10_000 });

      // Fill subject
      const subjectField = page.locator('input[name="subjectbox"]').first();
      if (await subjectField.isVisible()) {
        await subjectField.fill(`Re: ${attachment.subject} — Parcel Atlas Reports (${reportFiles.length})`);
      }
    }

    // Fill Gmail's compose/reply editor, then prove the text is present before
    // attempting Send. A body-less draft must remain a failed pipeline item.
    const bodyArea = page.locator(
      'div[contenteditable="true"][aria-label="Message Body"], div[role="textbox"][aria-label*="Message Body"], div[contenteditable="true"][aria-label*="Message Body"]'
    ).first();
    await bodyArea.waitFor({ state: "visible", timeout: 10_000 });
    const messageText = `Hi,\n\nPlease find attached your Parcel Atlas property rent review reports for the ${reportFiles.length} propert${reportFiles.length === 1 ? "y" : "ies"} submitted.\n\nReports are generated by Parcel Atlas using live Cotality/CoreLogic market data.\n\nKind regards,\nParcel Atlas`;
    await bodyArea.fill(messageText);
    const bodyText = await bodyArea.innerText();
    if (!bodyText.includes("Please find attached your Parcel Atlas property rent review reports")) {
      throw new Error("Gmail did not accept the report email body; leaving the message unsent.");
    }
    console.log("[reply] Email body verified.");

    // Attach the HTML report files
    console.log("[reply] Attaching report files…");
    const attachInput = page.locator('input[type="file"]').first();
    await attachInput.setInputFiles(reportFiles);

    // An attachment chip is shown only after Gmail has accepted the upload.
    for (const reportFile of reportFiles) {
      await page.getByText(nodePath.basename(reportFile), { exact: false }).last()
        .waitFor({ state: "visible", timeout: 30_000 });
    }

    // Clicking Send only counts as success once Gmail confirms it. Never use a
    // keyboard fallback here: it can leave a draft while looking successful.
    console.log("[reply] Clicking Send button…");
    const sendBtn = page.locator('div[role="button"][data-tooltip^="Send"], div[role="button"][aria-label^="Send"]').first();
    await sendBtn.waitFor({ state: "visible", timeout: 10_000 });
    if (await sendBtn.getAttribute("aria-disabled") === "true") {
      throw new Error("Gmail Send is disabled; the draft is missing a required recipient or attachment.");
    }
    await sendBtn.click();
    await page.getByText(/Message sent/i).last().waitFor({ state: "visible", timeout: 15_000 });
    if (usedComposeFallback) console.log(`[reply] Recipient verified: ${attachment.sender}`);
    console.log(`[reply] ✓ Email sent to ${attachment.sender}`);
    return true;
  } catch (replyErr) {
    console.error("[reply] Error sending reply:", replyErr);
    return false;
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(nodeProcess.argv.slice(2));
  const checkpoints = loadCheckpoints();

  console.log("=".repeat(60));
  console.log("  Parcel Atlas — Gmail Pipeline (TypeScript + Playwright)");
  console.log("=".repeat(60));
  console.log(`  Base URL:    ${opts.baseUrl}`);
  console.log(`  Max emails:  ${opts.maxEmails}`);
  console.log(`  Force:       ${opts.force}`);
  console.log(`  Dry run:     ${opts.dryRun}`);
  console.log("=".repeat(60) + "\n");

  const { browser, context } = await connectBrowser();
  let inboxBrowserClosed = false;

  const summary = {
    threadsFound: 0,
    processed: 0,
    skipped: 0,
    reportsGenerated: 0,
    repliesSent: 0,
    errors: 0,
  };

  try {
    // Step 1: Crawl inbox
    const attachments = await crawlInbox(context, opts, checkpoints);
    summary.threadsFound = attachments.length;

    // Inbox discovery and outbound delivery are separate browser sessions.
    // Release the crawler before the potentially long Cotality batch, then
    // authenticate a fresh Gmail session only when reports are ready to send.
    await browser.close();
    inboxBrowserClosed = true;
    console.log("[browser] Inbox session closed; the sender and CSV are captured locally.");

    const newItems = attachments.filter((a) => !a.skipped);
    summary.skipped = attachments.length - newItems.length;

    if (!newItems.length) {
      console.log("\n[pipeline] No new CSV emails to process.");
    }

    for (const item of newItems) {
      console.log(`\n${"─".repeat(50)}`);
      console.log(`[pipeline] Processing: ${item.fileName} from ${item.sender || "(unknown)"}`);

      if (opts.dryRun) {
        console.log("[pipeline] Dry run — skipping report generation and reply.");
        summary.processed++;
        continue;
      }

      // Step 2: Generate only properties that are not already saved in this
      // job's checkpoint. The stable output directory lets the next retry
      // discover reports written before an interruption.
      const record = checkpoints.records[item.key];
      record.outputDir ||= nodePath.resolve(DATA_DIR, "reports", `job-${item.key}`);
      hydrateCompletedProperties(record);
      saveCheckpoints(checkpoints);

      let reportFiles = existingReportFiles(record);
      let pendingPropertyIds: number[] = [];
      try {
        const pending = await createPendingCsv(item, record, opts, checkpoints);
        pendingPropertyIds = pending.pendingPropertyIds;
        if (pending.csvPath) {
          const result = await generateReports(pending.csvPath, record.outputDir, opts);
          for (const reportFile of result.reportFiles) {
            const propertyId = reportPropertyId(reportFile);
            if (!propertyId) continue;
            const key = String(propertyId);
            const prior = record.properties?.[key];
            record.properties ||= {};
            record.properties[key] = {
              propertyId,
              address: prior?.address || `Property ${propertyId}`,
              status: "completed",
              reportFile,
              updatedAt: new Date().toISOString(),
            };
          }
          hydrateCompletedProperties(record);
          reportFiles = existingReportFiles(record);
        } else {
          console.log("[checkpoint] All exact-match reports are already saved; skipping Cotality generation.");
        }
      } catch (reportError) {
        record.status = "failed";
        record.error = reportError instanceof Error ? reportError.message : String(reportError);
        saveCheckpoints(checkpoints);
        console.error(`[checkpoint] Report stage failed; it will resume on retry: ${record.error}`);
        summary.errors++;
        summary.processed++;
        continue;
      }

      const incomplete = pendingPropertyIds.filter((propertyId) => {
        const property = record.properties?.[String(propertyId)];
        return property?.status !== "completed" || !property.reportFile || !existsSync(property.reportFile);
      });
      if (incomplete.length) {
        record.status = "failed";
        record.error = `${incomplete.length} property report(s) are still pending: ${incomplete.join(", ")}.`;
        saveCheckpoints(checkpoints);
        console.warn(`[checkpoint] ${record.error} The next run will retry only these properties; reply deferred.`);
        summary.errors++;
        summary.processed++;
        continue;
      }

      record.reportFiles = reportFiles;
      record.status = reportFiles.length ? "processing" : "failed";
      record.error = reportFiles.length ? undefined : "No reports generated";
      saveCheckpoints(checkpoints);
      summary.reportsGenerated += reportFiles.length;

      // Step 3: Send reply
      if (reportFiles.length > 0 && item.sender) {
        console.log(`[reply] Connecting to Browserless for email dispatch to ${item.sender}…`);
        try {
          const replyBrowser = await connectBrowser();
          try {
            const sent = await sendReply(replyBrowser.context, opts, item, reportFiles);
            if (sent) {
              checkpoints.records[item.key].replySent = true;
              checkpoints.records[item.key].replySentAt = new Date().toISOString();
              checkpoints.records[item.key].status = "sent";
              saveCheckpoints(checkpoints);
              summary.repliesSent++;
            } else {
              checkpoints.records[item.key].status = "failed";
              checkpoints.records[item.key].error = "Gmail reply was not confirmed as sent";
              saveCheckpoints(checkpoints);
              summary.errors++;
            }
          } finally {
            await replyBrowser.browser.close();
          }
        } catch (dispatchErr) {
          console.error("[reply] Dispatch error:", dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr));
          summary.errors++;
        }
      } else if (!item.sender) {
        console.warn("[pipeline] No sender address — cannot send reply.");
      } else {
        console.warn("[pipeline] No reports generated — reply skipped.");
        summary.errors++;
        checkpoints.records[item.key].error = "No reports generated";
        checkpoints.records[item.key].status = "failed";
        saveCheckpoints(checkpoints);
      }

      summary.processed++;
    }
  } finally {
    if (!inboxBrowserClosed) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }

  // Print summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("[pipeline] Run complete");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors > 0) nodeProcess.exit(1);
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += character;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function csvLine(values: string[]): string {
  return values.map((value) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join(",");
}

function reportPropertyId(filePath: string): number | null {
  const match = nodePath.basename(filePath).match(/^parcel-atlas-(\d+)\.html$/i);
  const propertyId = Number(match?.[1]);
  return Number.isSafeInteger(propertyId) && propertyId > 0 ? propertyId : null;
}

function existingReportFiles(record: CheckpointRecord): string[] {
  return Array.from(new Set([
    ...(record.reportFiles || []),
    ...Object.values(record.properties || {}).map((property) => property.reportFile || ""),
  ].filter((filePath) => filePath && existsSync(filePath))));
}

function hydrateCompletedProperties(record: CheckpointRecord): void {
  record.properties ||= {};
  for (const reportFile of existingReportFiles(record)) {
    const propertyId = reportPropertyId(reportFile);
    if (!propertyId) continue;
    const key = String(propertyId);
    const prior = record.properties[key];
    record.properties[key] = {
      propertyId,
      address: prior?.address || `Property ${propertyId}`,
      status: "completed",
      reportFile,
      updatedAt: new Date().toISOString(),
    };
  }
  record.reportFiles = existingReportFiles(record);
}

main().catch((err: unknown) => {
  console.error("[pipeline] Fatal error:", err instanceof Error ? err.message : String(err));
  nodeProcess.exit(1);
});
