#!/usr/bin/env tsx
/**
 * Parcel Atlas — production background worker (Render).
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
import { NeedsReauthenticationError, discoverCsvEmails, openGmailSession, sendReportReply } from "../lib/gmail-worker";
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

/** Local .env is a development convenience only; Render injects real secrets. */
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
  pollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS || 60_000),
  leaseSeconds: Number(process.env.WORKER_LEASE_SECONDS || 900),
  maxEmails: Number(process.env.WORKER_MAX_EMAILS || 5),
  gmailUsername: process.env.GMAIL_USERNAME || "",
  gmailPassword: process.env.GMAIL_PASSWORD || "",
  allowedSenders: (process.env.GMAIL_ALLOWED_SENDERS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
  browserless: {
    wsEndpoint: process.env.BROWSERLESS_WS_ENDPOINT,
    apiKey: process.env.BROWSERLESS_API_KEY,
  },
};

const log = createLogger({ workerId: WORKER_ID, service: "parcel-atlas-worker" });

let shuttingDown = false;
let cycles = 0;

// ---------------------------------------------------------------------------
// Stage 1 — inbox discovery
// ---------------------------------------------------------------------------

async function discoverAndRegister(): Promise<number> {
  if (!config.allowedSenders.length) {
    // Fail closed: without an allow-list every sender would be untrusted input.
    log.error("intake.blocked", { reason: "GMAIL_ALLOWED_SENDERS is not configured" });
    return 0;
  }

  const session = await openGmailSession({
    ...config.browserless,
    username: config.gmailUsername,
    password: config.gmailPassword,
    logger: log,
  });

  let registered = 0;
  try {
    const discovered = await discoverCsvEmails(session.context, { maxEmails: config.maxEmails, logger: log });

    for (const item of discovered) {
      const itemLog = log.child({ sender: item.sender, fileName: item.fileName });

      if (!isAllowedSender(item.sender, config.allowedSenders)) {
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
  } finally {
    await session.close();
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
      const session = await openGmailSession({
        ...config.browserless,
        username: config.gmailUsername,
        password: config.gmailPassword,
        logger: jobLog,
      });
      try {
        await sendReportReply(session.context, { ...input, logger: jobLog });
      } finally {
        await session.close();
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

async function runCycle(): Promise<void> {
  cycles += 1;
  await recordHeartbeat({ workerId: WORKER_ID, status: "crawling", cycles, detail: "Checking mailbox" });

  try {
    const registered = await discoverAndRegister();
    if (registered) log.info("cycle.registered", { registered });
  } catch (error) {
    // A mailbox problem must not stop already-queued jobs from draining.
    log.error("cycle.discovery_failed", {
      failure: classifyFailure(error),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Exactly one job per cycle keeps concurrency at one by construction.
  const job = await claimNextJob(WORKER_ID, config.leaseSeconds);
  if (!job) {
    await recordHeartbeat({ workerId: WORKER_ID, status: "idle", cycles, detail: "No claimable jobs" });
    log.info("cycle.idle");
    return;
  }

  await processJob(job);
  await recordHeartbeat({ workerId: WORKER_ID, status: "idle", cycles, detail: `Finished ${job.id}` });
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
    try {
      await runCycle();
    } catch (error) {
      if (error instanceof NeedsReauthenticationError) {
        log.error("worker.paused_needs_reauthentication", { error: error.message });
        // Back off hard: retrying credentials would risk locking the account.
        await new Promise((resolve) => setTimeout(resolve, Math.max(config.pollIntervalMs, 300_000)));
      } else {
        log.error("worker.cycle_error", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (once || shuttingDown) break;
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  } while (!shuttingDown);

  await recordHeartbeat({ workerId: WORKER_ID, status: "stopped", cycles, detail: "Worker exited" });
  await closePool();
  log.info("worker.stopped", { cycles });
}

void main().catch(async (error: unknown) => {
  log.error("worker.fatal", { error: error instanceof Error ? error.message : String(error) });
  await closePool();
  process.exit(1);
});
