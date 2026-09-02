#!/usr/bin/env tsx
/**
 * Parcel Atlas — production durable worker.
 *
 * Cycle:
 *   1. Crawl the bot mailbox over Browserless for CSV attachments from
 *      approved senders, validate them, store the CSV in private Blob and
 *      register an idempotent job in Neon.
 *   2. Claim exactly one job with a transactional lease.
 *   3. Match each address; generate and upload a report per exact match.
 *   4. Reply once with every completed report attached.
 *
 * Concurrency is one job per worker by design, to protect the Cotality rate
 * limit and the Gmail mailbox. Local files are never the source of truth.
 */

import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import * as nodePath from "node:path";
import process from "node:process";

import {
  claimNextJob,
  closePool,
  extendLease,
  getCsvAttachment,
  hasSentReply,
  initSchema,
  listPropertyRows,
  markGmailHandled,
  recordHeartbeat,
  recordReplyAttempt,
  registerJobWithAttachment,
  seedPropertyRows,
  transitionJob,
  updatePropertyRow,
  type PipelineJob,
} from "../lib/db";
import {
  createJobBlobSecret,
  downloadBlobText,
  uploadCsvBlob,
  uploadReportBlob,
} from "../lib/blob-storage";
import { CsvValidationError, buildIdempotencyKey, isAllowedSender, validateCsvAttachment } from "../lib/csv-intake";
import { NeedsReauthenticationError, discoverCsvEmails, sendReportReply } from "../lib/gmail-worker";
import { GmailSessionManager } from "../lib/gmail-session-manager";
import { createLogger } from "../lib/logger";
import { generatePropertyReport, matchAddress } from "../lib/report-pipeline";
import { classifyFailure } from "../lib/retry-policy";
import {
  deliverReply,
  handleJobFailure,
  loadJobAddresses,
  pendingRows,
  processRows,
  replyIsDue,
  reviewRows,
  type WorkerDeps,
} from "../lib/worker-core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORKER_ID = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
const ROOT_DIR = nodePath.resolve(process.cwd(), "..");

/** Local .env is a development convenience only; production injects real secrets. */
function loadLocalEnv(): void {
  if (process.env.NODE_ENV === "production") return;
  for (const candidate of [nodePath.resolve(ROOT_DIR, ".env"), nodePath.resolve(process.cwd(), ".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

loadLocalEnv();

const config = {
  baseUrl: (process.env.PARCEL_ATLAS_BASE_URL || "https://australian-property.vercel.app").replace(/\/$/, ""),
  // How often the loop wakes. Cheap: a tick with no queued work and no due
  // mailbox check performs a single indexed Postgres query.
  pollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS || 30_000),
  // How often Gmail may actually be opened, independent of the loop tick.
  mailboxMinIntervalMs: Number(process.env.WORKER_MAILBOX_MIN_INTERVAL_MS || 120_000),
  mailboxMaxIntervalMs: Number(process.env.WORKER_MAILBOX_MAX_INTERVAL_MS || 900_000),
  leaseSeconds: Number(process.env.WORKER_LEASE_SECONDS || 900),
  maxEmails: Number(process.env.WORKER_MAX_EMAILS || 5),
  gmailUsername: process.env.GMAIL_USERNAME || "",
  gmailPassword: process.env.GMAIL_PASSWORD || "",
  allowedSenders: (process.env.GMAIL_ALLOWED_SENDERS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
  // Opt-in public intake: valid CSVs from any real sender are processed and
  // replied to. Keep the default false so a missing environment variable does
  // not accidentally make a private mailbox public.
  allowAnySender: process.env.GMAIL_ALLOW_ANY_SENDER === "true",
  browserless: {
    wsEndpoint: process.env.BROWSERLESS_WS_ENDPOINT,
    apiKey: process.env.BROWSERLESS_API_KEY,
  },
};

const log = createLogger({ workerId: WORKER_ID, service: "parcel-atlas-worker" });

/** One long-lived Browserless session shared by discovery and reply delivery. */
const sessionManager = new GmailSessionManager({
  ...config.browserless,
  username: config.gmailUsername,
  password: config.gmailPassword,
  logger: log,
});

let shuttingDown = false;
let cycles = 0;

// ---------------------------------------------------------------------------
// Adaptive mailbox scheduling
// ---------------------------------------------------------------------------

let nextMailboxCheckAt = 0;
let quietChecks = 0;

/**
 * Backs the mailbox check off when the inbox is quiet.
 *
 * Checking every 60s regardless of activity is wasteful and, from a datacentre
 * IP, is itself a bot signal. An empty inbox is the common case, so the interval
 * grows to the configured ceiling and snaps back the moment mail arrives.
 */
function dueForMailboxCheck(): boolean {
  return Date.now() >= nextMailboxCheckAt;
}

function recordMailboxCheck(foundMail: boolean): void {
  if (foundMail) {
    quietChecks = 0;
    nextMailboxCheckAt = Date.now() + config.mailboxMinIntervalMs;
    return;
  }
  quietChecks += 1;
  const backoff = Math.min(
    config.mailboxMinIntervalMs * 2 ** Math.min(quietChecks, 4),
    config.mailboxMaxIntervalMs,
  );
  nextMailboxCheckAt = Date.now() + backoff;
  log.debug("mailbox.backoff", { quietChecks, nextCheckInMs: backoff });
}

// ---------------------------------------------------------------------------
// Stage 1 — inbox discovery
// ---------------------------------------------------------------------------

async function discoverAndRegister(): Promise<number> {
  if (!config.allowedSenders.length && !config.allowAnySender) {
    log.error("intake.blocked", { reason: "Configure GMAIL_ALLOWED_SENDERS or explicitly set GMAIL_ALLOW_ANY_SENDER=true" });
    return 0;
  }

  // Reuse the long-lived session instead of connecting per cycle.
  const context = await sessionManager.acquire();

  let registered = 0;
  try {
    const discovered = await discoverCsvEmails(context, { maxEmails: config.maxEmails, logger: log });

    for (const item of discovered) {
      const itemLog = log.child({ sender: item.sender, fileName: item.fileName });

      if (!isAllowedSender(item.sender, config.allowedSenders, config.allowAnySender)) {
        itemLog.warn("intake.rejected", { reason: "sender is not on the allow-list" });
        continue;
      }

      let validated;
      try {
        validated = validateCsvAttachment({
          fileName: item.fileName,
          content: item.csvContent,
          mimeType: item.mimeType,
        });
      } catch (error) {
        // Malformed CSVs are rejected at intake and never queued.
        itemLog.warn("intake.invalid_csv", {
          error: error instanceof CsvValidationError ? error.message : String(error),
        });
        continue;
      }

      const idempotencyKey = buildIdempotencyKey({
        sender: item.sender,
        threadId: item.threadId,
        fileName: validated.fileName,
        csvContent: item.csvContent,
      });
      const jobId = `job-${Date.now()}-${randomBytes(4).toString("hex")}`;
      const blobSecret = createJobBlobSecret();

      const csvBlob = await uploadCsvBlob({
        jobId,
        secret: blobSecret,
        filename: validated.fileName,
        content: item.csvContent,
      });

      const { job, created } = await registerJobWithAttachment({
        jobId,
        idempotencyKey,
        sender: item.sender,
        subject: item.subject,
        threadId: item.threadId,
        attachment: {
          id: `csv-${Date.now()}-${randomBytes(4).toString("hex")}`,
          filename: validated.fileName,
          fileHash: validated.contentHash,
          rowCount: validated.addresses.length,
          byteSize: validated.byteLength,
          blobPathname: csvBlob.pathname,
          blobUrl: csvBlob.url,
        },
      });

      if (!created) {
        itemLog.info("intake.duplicate", { jobId: job.id, status: job.status });
        continue;
      }

      await seedPropertyRows(
        job.id,
        validated.addresses.map((address) => ({
          id: `prop-${job.id}-${address.rowNumber}`,
          rowNumber: address.rowNumber,
          address: address.address,
        })),
      );
      itemLog.info("intake.registered", { jobId: job.id, rows: validated.addresses.length });
      registered += 1;
    }
  } catch (error) {
    // Drop the session only when it is the thing that broke, so a parsing or
    // validation fault does not throw away a working browser.
    const message = error instanceof Error ? error.message : String(error);
    if (/target closed|browser has been closed|websocket|disconnected|session/i.test(message)) {
      await sessionManager.invalidate(`discovery transport failure: ${message.slice(0, 120)}`);
    }
    throw error;
  }

  return registered;
}

// ---------------------------------------------------------------------------
// Stage 2 — job processing
// ---------------------------------------------------------------------------

function buildDeps(job: PipelineJob, blobSecret: string, jobLog: ReturnType<typeof createLogger>): WorkerDeps {
  const clientOptions = { baseUrl: config.baseUrl };
  return {
    logger: jobLog,
    readCsv: (pathname) => downloadBlobText(pathname),
    matchAddress: (address) => matchAddress(address, clientOptions),
    generateReport: (input) => generatePropertyReport(input, clientOptions),
    uploadReport: async (input) =>
      uploadReportBlob({ jobId: job.id, secret: blobSecret, filename: input.filename, html: input.html }),
    readReport: (pathname) => downloadBlobText(pathname),
    updateRow: (input) => updatePropertyRow(input),
    sendReply: async (input) => {
      // Reuse the same session the crawl used; a second connection per job was
      // both wasteful and an extra bot signal.
      const context = await sessionManager.acquire();
      try {
        await sendReportReply(context, { ...input, logger: jobLog });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/target closed|browser has been closed|websocket|disconnected/i.test(message)) {
          await sessionManager.invalidate(`reply transport failure: ${message.slice(0, 120)}`);
        }
        throw error;
      }
    },
    hasSentReply: () => hasSentReply(job.id),
    recordReply: (input) =>
      recordReplyAttempt({
        id: `reply-${Date.now()}-${randomBytes(3).toString("hex")}`,
        jobId: job.id,
        recipient: job.sender,
        reportCount: input.reportCount,
        status: input.status,
        error: input.error ?? null,
      }),
    markGmailHandled: () => markGmailHandled(job.id),
    transition: (input) => transitionJob({ jobId: job.id, workerId: WORKER_ID, ...input }),
    heartbeat: async (detail) => {
      await extendLease(job.id, WORKER_ID, config.leaseSeconds);
      await recordHeartbeat({ workerId: WORKER_ID, status: "processing", currentJobId: job.id, cycles, detail });
    },
  };
}

async function processJob(job: PipelineJob): Promise<void> {
  const jobLog = log.child({ jobId: job.id, attempt: job.attempts });
  jobLog.info("job.claimed", { status: job.status, sender: job.sender });

  // The Blob path already encodes this job's random segment; reuse it so a
  // retry writes to the same location instead of orphaning earlier reports.
  const attachment = await getCsvAttachment(job.id);
  if (!attachment) {
    await transitionJob({
      jobId: job.id,
      status: "failed",
      workerId: WORKER_ID,
      error: "Job has no CSV attachment record.",
      releaseLease: true,
    });
    return;
  }
  const blobSecret = attachment.blob_pathname?.split("/")[2]?.replace(`${job.id}-`, "") || createJobBlobSecret();
  const deps = buildDeps(job, blobSecret, jobLog);

  try {
    await transitionJob({ jobId: job.id, status: "running", workerId: WORKER_ID, detail: "Processing started" });

    // Re-seed from the durable CSV so a partially seeded job self-heals.
    const addresses = await loadJobAddresses(attachment, deps);
    await seedPropertyRows(
      job.id,
      addresses.map((address) => ({
        id: `prop-${job.id}-${address.rowNumber}`,
        rowNumber: address.rowNumber,
        address: address.address,
      })),
    );
    await transitionJob({ jobId: job.id, status: "downloaded", workerId: WORKER_ID, detail: `${addresses.length} address row(s)` });

    let rows = await listPropertyRows(job.id);
    const outcome = await processRows(rows, deps);
    jobLog.info("job.rows_processed", outcome);

    rows = await listPropertyRows(job.id);
    await transitionJob({
      jobId: job.id,
      status: "report_generated",
      workerId: WORKER_ID,
      detail: `${rows.filter((row) => row.status === "generated").length} report(s) stored`,
    });

    if (pendingRows(rows).length) {
      // Some rows are still retryable: defer the reply so the eventual email
      // contains every report rather than a partial set.
      await handleJobFailure(
        new Error(`${pendingRows(rows).length} property report(s) still pending; deferring the reply.`),
        job.attempts,
        deps,
      );
      return;
    }

    if (!replyIsDue(rows)) {
      const review = reviewRows(rows).length;
      await transitionJob({
        jobId: job.id,
        status: review ? "needs_review" : "failed",
        workerId: WORKER_ID,
        error: review
          ? `${review} address row(s) need manual property selection; no exact matches to report.`
          : "No reports could be generated for this CSV.",
        detail: "No reply sent",
        releaseLease: true,
      });
      return;
    }

    const reply = await deliverReply(
      { jobId: job.id, sender: job.sender, subject: job.subject, blobSecret },
      rows,
      deps,
    );

    if (reply.sent) {
      const review = reviewRows(rows).length;
      await transitionJob({
        jobId: job.id,
        status: "completed",
        workerId: WORKER_ID,
        detail: review ? `Reply sent; ${review} row(s) still need review.` : "Reply sent with all reports attached.",
        releaseLease: true,
      });
      jobLog.info("job.completed", { reports: rows.filter((row) => row.status === "generated").length });
    } else {
      await transitionJob({
        jobId: job.id,
        status: "completed",
        workerId: WORKER_ID,
        detail: `Reply not resent: ${reply.reason}`,
        releaseLease: true,
      });
    }
  } catch (error) {
    const failure = classifyFailure(error);
    jobLog.error("job.failed", {
      failure,
      error: error instanceof Error ? error.message : String(error),
    });
    await handleJobFailure(error, job.attempts, deps);
    if (error instanceof NeedsReauthenticationError) throw error;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * One cycle. Draining queued work is prioritised over checking the mailbox,
 * because a job already in Neon needs no browser to make progress.
 */
async function runCycle(): Promise<{ didWork: boolean }> {
  cycles += 1;
  let didWork = false;

  // 1. Drain first. Matching, report generation and Blob writes are pure HTTP,
  //    so a backlog clears without ever touching Gmail.
  const queued = await claimNextJob(WORKER_ID, config.leaseSeconds);
  if (queued) {
    await recordHeartbeat({ workerId: WORKER_ID, status: "processing", currentJobId: queued.id, cycles, detail: "Processing queued job" });
    await processJob(queued);
    await recordHeartbeat({ workerId: WORKER_ID, status: "idle", cycles, detail: `Finished ${queued.id}` });
    return { didWork: true };
  }

  // 2. Nothing queued, so check the mailbox. This is the only step that needs a
  //    browser, and it is now the exception rather than every cycle.
  if (!dueForMailboxCheck()) {
    await recordHeartbeat({ workerId: WORKER_ID, status: "idle", cycles, detail: "Mailbox check not due" });
    log.debug("cycle.skipped_mailbox", { nextCheckInMs: Math.max(0, nextMailboxCheckAt - Date.now()) });
    return { didWork: false };
  }

  await recordHeartbeat({ workerId: WORKER_ID, status: "crawling", cycles, detail: "Checking mailbox" });
  try {
    const registered = await discoverAndRegister();
    recordMailboxCheck(registered > 0);
    if (registered) {
      log.info("cycle.registered", { registered });
      didWork = true;
    }
  } catch (error) {
    // A mailbox problem must not stop already-queued jobs from draining.
    const failure = classifyFailure(error);
    recordMailboxCheck(false);
    log.error("cycle.discovery_failed", {
      failure,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof NeedsReauthenticationError) throw error;
  }

  const claimed = await claimNextJob(WORKER_ID, config.leaseSeconds);
  if (!claimed) {
    await recordHeartbeat({ workerId: WORKER_ID, status: "idle", cycles, detail: "No claimable jobs" });
    log.info("cycle.idle", { sessionOpen: sessionManager.isOpen, ...sessionManager.stats });
    return { didWork };
  }

  await processJob(claimed);
  await recordHeartbeat({ workerId: WORKER_ID, status: "idle", cycles, detail: `Finished ${claimed.id}` });
  return { didWork: true };
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  log.info("worker.start", { baseUrl: config.baseUrl, once, pollIntervalMs: config.pollIntervalMs });

  await initSchema();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info("worker.shutdown_requested", { signal });
      shuttingDown = true;
    });
  }

  do {
    let sleepMs = config.pollIntervalMs;
    try {
      const { didWork } = await runCycle();
      // Keep draining without pausing while there is a backlog.
      if (didWork) sleepMs = 1_000;
    } catch (error) {
      if (error instanceof NeedsReauthenticationError) {
        log.error("worker.paused_needs_reauthentication", { error: error.message });
        // Back off hard and drop the session: retrying credentials would risk
        // locking the account, and the held session is already untrusted.
        await sessionManager.invalidate("needs reauthentication");
        sleepMs = Math.max(config.pollIntervalMs, 900_000);
      } else {
        log.error("worker.cycle_error", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (once || shuttingDown) break;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  } while (!shuttingDown);

  await sessionManager.close();
  await recordHeartbeat({ workerId: WORKER_ID, status: "stopped", cycles, detail: "Worker exited" });
  await closePool();
  log.info("worker.stopped", { cycles, sessionStats: sessionManager.stats });
}

void main().catch(async (error: unknown) => {
  log.error("worker.fatal", { error: error instanceof Error ? error.message : String(error) });
  await sessionManager.close().catch(() => undefined);
  await closePool();
  process.exit(1);
});
