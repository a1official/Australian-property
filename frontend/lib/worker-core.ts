/**
 * Job orchestration, isolated from Browserless/Neon/Blob so it can be tested
 * with in-memory fakes.
 *
 * Resume rules enforced here:
 *  - a report is generated only for a row that is not already `generated`;
 *  - a reply is sent only when every exact match has a stored report;
 *  - a reply is sent at most once per job, checked before and recorded after;
 *  - the Gmail message is marked handled only after the reply is confirmed.
 */

import { validateCsvAttachment } from "./csv-intake";
import type { PropertyReportRecord } from "./db";
import type { Logger } from "./logger";
import { classifyFailure, nextRunAt, shouldRetry } from "./retry-policy";

export type JobArtifacts = {
  jobId: string;
  sender: string;
  subject: string;
  blobSecret: string;
};

export type WorkerDeps = {
  logger: Logger;
  /** Downloads the source CSV text from Blob. */
  readCsv(pathname: string): Promise<string>;
  matchAddress(address: string): Promise<
    | { kind: "exact"; propertyId: number; normalizedAddress: string }
    | { kind: "needs_review"; reason: string }
    | { kind: "unmatched"; reason: string }
  >;
  generateReport(input: { propertyId: number; address: string }): Promise<{ filename: string; html: string }>;
  uploadReport(input: { filename: string; html: string }): Promise<{ pathname: string }>;
  readReport(pathname: string): Promise<string>;
  updateRow(input: Parameters<typeof import("./db").updatePropertyRow>[0]): Promise<void>;
  sendReply(input: { recipient: string; subject: string; attachments: Array<{ name: string; mimeType: string; buffer: Buffer }> }): Promise<void>;
  hasSentReply(): Promise<boolean>;
  recordReply(input: { reportCount: number; status: "sent" | "failed"; error?: string | null }): Promise<void>;
  markGmailHandled(): Promise<void>;
  transition(input: { status: import("./db").JobStatus; detail?: string | null; error?: string | null; nextRunAt?: Date | null; releaseLease?: boolean }): Promise<void>;
  heartbeat(detail: string): Promise<void>;
};

export function pendingRows(rows: PropertyReportRecord[]): PropertyReportRecord[] {
  return rows.filter((row) => row.status !== "generated" && row.status !== "needs_review" && row.status !== "unmatched");
}

export function generatedRows(rows: PropertyReportRecord[]): PropertyReportRecord[] {
  return rows.filter((row) => row.status === "generated" && row.blob_pathname);
}

export function reviewRows(rows: PropertyReportRecord[]): PropertyReportRecord[] {
  return rows.filter((row) => row.status === "needs_review" || row.status === "unmatched");
}

/** A reply is due only when nothing is still processable and something was generated. */
export function replyIsDue(rows: PropertyReportRecord[]): boolean {
  return pendingRows(rows).length === 0 && generatedRows(rows).length > 0;
}

export function buildReplySubject(subject: string, reportCount: number): string {
  const base = subject.replace(/^(re:\s*)+/i, "").trim() || "Property rent review";
  return `Re: ${base} — Parcel Atlas reports (${reportCount})`;
}

/**
 * Matches and generates reports for the rows that are not already complete.
 * Per-row failures are recorded without aborting the remaining rows.
 */
export async function processRows(
  rows: PropertyReportRecord[],
  deps: WorkerDeps,
): Promise<{ generated: number; needsReview: number; failed: number }> {
  let generated = 0;
  let needsReview = 0;
  let failed = 0;

  for (const row of pendingRows(rows)) {
    const rowLogger = deps.logger.child({ rowNumber: row.row_number });
    await deps.heartbeat(`row ${row.row_number}`);

    try {
      let propertyId = row.property_id ? Number(row.property_id) : null;
      let address = row.normalized_address || row.original_address;

      if (!propertyId) {
        const outcome = await deps.matchAddress(row.original_address);
        if (outcome.kind !== "exact") {
          // Never guess: an ambiguous row is parked for a human.
          await deps.updateRow({
            id: row.id,
            status: outcome.kind === "needs_review" ? "needs_review" : "unmatched",
            error: outcome.reason,
            incrementAttempts: true,
          });
          rowLogger.warn("row.needs_review", { reason: outcome.reason });
          needsReview += 1;
          continue;
        }
        propertyId = outcome.propertyId;
        address = outcome.normalizedAddress;
        await deps.updateRow({
          id: row.id,
          status: "matched",
          propertyId,
          normalizedAddress: address,
          error: null,
        });
      }

      const report = await deps.generateReport({ propertyId, address });
      const stored = await deps.uploadReport(report);
      await deps.updateRow({
        id: row.id,
        status: "generated",
        reportFilename: report.filename,
        blobPathname: stored.pathname,
        error: null,
        incrementAttempts: true,
      });
      rowLogger.info("row.report_generated", { propertyId, pathname: stored.pathname });
      generated += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = classifyFailure(error);
      // Permanent row errors stop consuming retry budget; transient ones stay
      // pending so only the remaining rows are retried on the next lease.
      await deps.updateRow({
        id: row.id,
        status: failure === "permanent" ? "failed" : "pending",
        error: message,
        incrementAttempts: true,
      });
      rowLogger.error("row.failed", { failure, error: message });
      failed += 1;
      if (failure === "needs_reauthentication") throw error;
    }
  }

  return { generated, needsReview, failed };
}

/**
 * Sends the single reply for a job, attaching every generated report.
 * Downloads only the completed reports it needs, from Blob.
 */
export async function deliverReply(
  job: JobArtifacts,
  rows: PropertyReportRecord[],
  deps: WorkerDeps,
): Promise<{ sent: boolean; reason?: string }> {
  const completed = generatedRows(rows);
  if (!completed.length) return { sent: false, reason: "no completed reports" };
  if (pendingRows(rows).length) return { sent: false, reason: "reports still pending" };

  // Duplicate-email guard: never send twice for the same job.
  if (await deps.hasSentReply()) {
    deps.logger.info("reply.already_sent");
    return { sent: false, reason: "reply already sent" };
  }

  await deps.transition({ status: "replying", detail: `Attaching ${completed.length} report(s)` });

  const attachments = await Promise.all(
    completed.map(async (row) => ({
      name: row.report_filename || `parcel-atlas-${row.property_id}.html`,
      mimeType: "text/html",
      buffer: Buffer.from(await deps.readReport(row.blob_pathname as string), "utf8"),
    })),
  );

  try {
    await deps.sendReply({
      recipient: job.sender,
      subject: buildReplySubject(job.subject, attachments.length),
      attachments,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.recordReply({ reportCount: attachments.length, status: "failed", error: message });
    throw error;
  }

  await deps.recordReply({ reportCount: attachments.length, status: "sent" });
  // Only now is the source email considered handled.
  await deps.markGmailHandled();
  return { sent: true };
}

/** Maps a job-level failure onto the correct terminal or retry state. */
export async function handleJobFailure(
  error: unknown,
  attempts: number,
  deps: WorkerDeps,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const failure = classifyFailure(error);

  if (failure === "needs_reauthentication") {
    await deps.transition({
      status: "needs_reauthentication",
      error: message,
      detail: "Google requires manual re-authentication; the worker stopped safely.",
      releaseLease: true,
    });
    return;
  }

  if (shouldRetry(failure, attempts)) {
    const retryAt = nextRunAt(attempts);
    await deps.transition({
      status: "retryable_failed",
      error: message,
      detail: `Retry ${attempts + 1} scheduled for ${retryAt.toISOString()}`,
      nextRunAt: retryAt,
      releaseLease: true,
    });
    return;
  }

  await deps.transition({
    status: "failed",
    error: message,
    detail: failure === "permanent" ? "Permanent failure; not retried." : "Retry budget exhausted.",
    releaseLease: true,
  });
}

/** Validates the CSV from Blob and returns its address rows. */
export async function loadJobAddresses(
  attachment: { filename: string; blob_pathname: string | null },
  deps: WorkerDeps,
): Promise<Array<{ rowNumber: number; address: string }>> {
  if (!attachment.blob_pathname) {
    throw Object.assign(new Error("CSV attachment has no Blob pathname; cannot process job."), { permanent: true });
  }
  const content = await deps.readCsv(attachment.blob_pathname);
  return validateCsvAttachment({ fileName: attachment.filename, content }).addresses;
}
