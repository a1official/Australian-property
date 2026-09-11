/**
 * Delivery Lambda: sends one rent-review email per completed property.
 *
 * Triggered by an SQS message of `{ jobId, propertyReportId }` that the report
 * worker enqueues after writing a PDF to S3. This is the only place mail is
 * sent, which keeps report generation and delivery independently retryable.
 *
 * Idempotency: `reply_attempts` carries a unique index on
 * (job_id, property_report_id) WHERE status = 'sent', and the handler checks for
 * an existing marker first. A duplicate SQS delivery is therefore a no-op rather
 * than a second email.
 *
 * A property that is unresolved or failed never blocks a completed one: each
 * message is independent, so one bad row cannot withhold other reports.
 */

import { randomUUID } from "node:crypto";

import { configureAwsRuntime } from "./aws-runtime";
import { getAwsArtifact } from "./aws-storage";
import {
  getJobDetails,
  hasSentReply,
  recordReplyAttempt,
  touchGmailConnection,
} from "../lib/db";
import { buildMimeReply, replyHtmlBody, replyPlainTextBody } from "../lib/gmail-api";
import { openMailbox } from "../lib/gmail-mailbox";
import { NeedsReauthorizationError } from "../lib/gmail-oauth";
import { createLogger } from "../lib/logger";

type SqsRecord = { messageId: string; body: string };
type SqsEvent = { Records?: SqsRecord[] };
type DeliveryMessage = { jobId?: string; propertyReportId?: string };

const log = createLogger({ service: "parcel-atlas-delivery" });

/** Permanent problems must not be retried; SQS would loop on them forever. */
class PermanentDeliveryError extends Error {
  readonly permanent = true;
}

async function deliverOne(message: DeliveryMessage): Promise<{ sent: boolean; reason?: string }> {
  const jobId = message.jobId?.trim();
  const propertyReportId = message.propertyReportId?.trim();
  if (!jobId || !propertyReportId) {
    throw new PermanentDeliveryError("A delivery message requires both jobId and propertyReportId.");
  }

  const rowLog = log.child({ jobId, propertyReportId });

  // Duplicate-send guard, checked before any work is done.
  if (await hasSentReply(jobId, propertyReportId)) {
    rowLog.info("delivery.already_sent");
    return { sent: false, reason: "already sent" };
  }

  const details = await getJobDetails(jobId);
  if (!details) throw new PermanentDeliveryError(`Job ${jobId} no longer exists.`);

  const report = details.reports.find((item) => item.id === propertyReportId);
  if (!report) throw new PermanentDeliveryError(`Property report ${propertyReportId} is not part of job ${jobId}.`);
  if (report.status !== "generated" || !report.blob_pathname) {
    // Not an error: the report worker has not finished this row yet, or it went
    // to review. Either way there is nothing to email.
    rowLog.info("delivery.not_ready", { status: report.status });
    return { sent: false, reason: `report status is ${report.status}` };
  }

  const recipient = (report.owner_email || details.job.sender || "").trim();
  if (!recipient) throw new PermanentDeliveryError("No recipient address is recorded for this property report.");

  const pdf = await getAwsArtifact(report.blob_pathname);
  if (!pdf.byteLength) throw new Error("The stored report PDF is empty; retrying may recover it.");

  const filename = report.report_filename || `rent-review-${propertyReportId}.pdf`;
  const address = report.normalized_address || report.original_address;
  const context = {
    address,
    currentRent: report.current_rent === null ? null : Number(report.current_rent),
    bedrooms: report.bedrooms === null ? null : Number(report.bedrooms),
    marketRentLow: report.market_rent_low === null ? null : Number(report.market_rent_low),
    marketRentHigh: report.market_rent_high === null ? null : Number(report.market_rent_high),
    marketRentAverage: report.market_rent_average === null ? null : Number(report.market_rent_average),
  };

  const mailbox = await openMailbox({ logger: rowLog });
  const raw = buildMimeReply({
    to: recipient,
    subject: `Rent review — ${address}`,
    plainText: replyPlainTextBody(1, 0, report.owner_name, report.owner_email, context),
    html: replyHtmlBody(1, 0, [filename], report.owner_name, report.owner_email, context),
    attachments: [{ filename, mimeType: "application/pdf", content: pdf }],
  });

  const sent = await mailbox.sendMessage(raw, details.job.thread_id ?? undefined);

  // Record the marker only after Gmail confirms the send, so a failure cannot
  // suppress a later retry.
  await recordReplyAttempt({
    id: `reply-${randomUUID()}`,
    jobId,
    propertyReportId,
    recipient,
    reportCount: 1,
    status: "sent",
  });
  await touchGmailConnection();

  rowLog.info("delivery.sent", { recipient, filename, gmailMessageId: sent.id });
  return { sent: true };
}

/**
 * Opens the mailbox and stops.
 *
 * Proves in the real Lambda environment that the secret, token decryption and
 * Google refresh grant all work, which is otherwise only exercised at the
 * moment an email is about to be sent. Deliberately performs no send.
 */
async function selfCheck(): Promise<{ ok: true; mailbox: "authenticated" }> {
  await openMailbox({ logger: log.child({ mode: "self_check" }) });
  log.info("delivery.self_check.ok");
  return { ok: true, mailbox: "authenticated" };
}

export async function handler(event: SqsEvent & { selfCheck?: boolean }) {
  await configureAwsRuntime();
  if (event.selfCheck) return selfCheck();

  const failures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records ?? []) {
    try {
      await deliverOne(JSON.parse(record.body) as DeliveryMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent =
        error instanceof PermanentDeliveryError ||
        error instanceof NeedsReauthorizationError ||
        (error as { permanent?: boolean }).permanent === true;

      log.error("delivery.failed", { messageId: record.messageId, permanent, error: message });

      if (!permanent) {
        // Only transient failures are returned for redelivery. A permanent one
        // is acknowledged so it lands in review rather than cycling to the DLQ.
        failures.push({ itemIdentifier: record.messageId });
      }
      if (error instanceof NeedsReauthorizationError) {
        // The grant is gone; further messages in this batch cannot succeed.
        break;
      }
    }
  }

  return { batchItemFailures: failures };
}
