/**
 * Job orchestration, isolated from Browserless/Neon/Blob so it can be tested
 * with in-memory fakes.
 *
 * Resume rules enforced here:
 *  - a report is generated only for a row that is not already `generated`;
 *  - a reply is sent only when every exact match has a stored report;
 *  - every generated report is emailed independently, with a sent marker per report;
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
  generateReport(input: { propertyId: number; address: string }): Promise<{
    filename: string;
    content: Buffer;
    emailData?: { bedrooms: number | null; marketRentLow: number | null; marketRentHigh: number | null; marketRentAverage: number | null };
  }>;
  uploadReport(input: { filename: string; content: Buffer }): Promise<{ pathname: string }>;
  readReport(pathname: string): Promise<Buffer>;
  updateRow(input: Parameters<typeof import("./db").updatePropertyRow>[0]): Promise<void>;
  sendReply(input: {
    recipient: string;
    subject: string;
    attachments: Array<{ name: string; mimeType: string; buffer: Buffer }>;
    /** Optional name from this report's CSV row, used only for the salutation. */
    ownerName?: string | null;
    address?: string;
    currentRent?: number | null;
    bedrooms?: number | null;
    marketRentLow?: number | null;
    marketRentHigh?: number | null;
    marketRentAverage?: number | null;
    /** Rows left for manual review, so the reply can say so honestly. */
    reviewCount: number;
  }): Promise<void>;
  hasSentReply(propertyReportId: string): Promise<boolean>;
  recordReply(input: { propertyReportId: string; reportCount: number; status: "sent" | "failed"; error?: string | null }): Promise<void>;
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

export function buildReplySubject(subject: string, reportCount: number, propertyAddress?: string | null): string {
  const address = propertyAddress?.replace(/[\r\n\t]+/g, " ").trim();
  if (address) return `Rent review — ${address}`;
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
        bedrooms: report.emailData?.bedrooms ?? null,
        marketRentLow: report.emailData?.marketRentLow ?? null,
        marketRentHigh: report.emailData?.marketRentHigh ?? null,
        marketRentAverage: report.emailData?.marketRentAverage ?? null,
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
 * Sends one email per generated property report. A sent marker is stored for
 * each report, so a retry resumes at the first unsent email.
 */
export async function deliverReply(
  job: JobArtifacts,
  rows: PropertyReportRecord[],
  deps: WorkerDeps,
): Promise<{ sent: boolean; sentCount: number; reason?: string }> {
  const completed = generatedRows(rows);
  if (!completed.length) return { sent: false, sentCount: 0, reason: "no completed reports" };
  if (pendingRows(rows).length) return { sent: false, sentCount: 0, reason: "reports still pending" };
  await deps.transition({ status: "replying", detail: `Emailing ${completed.length} individual report(s)` });

  let sentCount = 0;
  for (const row of completed) {
    if (await deps.hasSentReply(row.id)) {
      deps.logger.info("reply.already_sent", { propertyReportId: row.id });
      continue;
    }
    const attachment = { name: row.report_filename || `property-report.pdf`, mimeType: "application/pdf", buffer: await deps.readReport(row.blob_pathname as string) };
    try {
      await deps.sendReply({
        recipient: job.sender,
        subject: buildReplySubject(job.subject, 1, row.normalized_address || row.original_address),
        attachments: [attachment],
        ownerName: row.owner_name,
        address: row.normalized_address || row.original_address,
        currentRent: row.current_rent === null ? null : Number(row.current_rent),
        bedrooms: row.bedrooms,
        marketRentLow: row.market_rent_low === null ? null : Number(row.market_rent_low),
        marketRentHigh: row.market_rent_high === null ? null : Number(row.market_rent_high),
        marketRentAverage: row.market_rent_average === null ? null : Number(row.market_rent_average),
        reviewCount: reviewRows(rows).length,
      });
      await deps.recordReply({ propertyReportId: row.id, reportCount: 1, status: "sent" });
      sentCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.recordReply({ propertyReportId: row.id, reportCount: 1, status: "failed", error: message });
      throw error;
    }
  }
  await deps.markGmailHandled();
  return { sent: sentCount > 0, sentCount, reason: sentCount ? undefined : "all report emails were already sent" };
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
): Promise<Array<{ rowNumber: number; address: string; ownerName: string | null }>> {
  if (!attachment.blob_pathname) {
    throw Object.assign(new Error("CSV attachment has no Blob pathname; cannot process job."), { permanent: true });
  }
  const content = await deps.readCsv(attachment.blob_pathname);
  return validateCsvAttachment({ fileName: attachment.filename, content }).addresses;
}
