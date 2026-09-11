import { configureAwsRuntime } from "./aws-runtime";
import { runQueuedJobOnce } from "../scripts/render-worker";
import { acquireWorkerLock, closePool, initSchema, releaseWorkerLock } from "../lib/db";
import { randomUUID } from "node:crypto";
import { generatePropertyPdfDirect, matchAddressDirect } from "../lib/aws-report-pipeline";

type SqsRecord = { messageId: string; body: string };
type SqsEvent = { Records?: SqsRecord[] };

/**
 * SQS mappings require a minimum concurrency of two. A durable Neon mutex
 * serialises report generation to one active job, protecting Cotality's rate
 * limit even if AWS starts a second consumer.
 */
export async function handler(event: SqsEvent | { dryRun?: boolean; address?: string }) {
  await configureAwsRuntime();
  if ("dryRun" in event && event.dryRun) {
    const address = event.address?.trim();
    if (!address) throw new Error("A dry-run address is required.");
    const match = await matchAddressDirect(address);
    if (match.kind !== "exact") return { ok: false, match };
    const pdf = await generatePropertyPdfDirect({ propertyId: match.propertyId, address: match.normalizedAddress });
    return { ok: true, propertyId: match.propertyId, address: match.normalizedAddress, filename: pdf.filename, bytes: pdf.content.byteLength, emailData: pdf.emailData };
  }
  const records = (event as SqsEvent).Records ?? [];
  const holder = `report-lambda-${randomUUID()}`;
  await initSchema();
  const hasLock = await acquireWorkerLock("cotality-report-worker", holder);
  if (!hasLock) {
    // Keep the messages rather than dropping a distinct job while another
    // invocation is using Cotality. SQS retries after its visibility timeout.
    await closePool();
    return { batchItemFailures: records.map((record) => ({ itemIdentifier: record.messageId })) };
  }
  const failures: Array<{ itemIdentifier: string }> = [];
  try {
    for (const record of records) {
      try {
        const message = JSON.parse(record.body) as { jobId?: string };
        if (!message.jobId || typeof message.jobId !== "string") throw new Error("Queue message has no jobId.");
        await runQueuedJobOnce(message.jobId);
      } catch (error) {
        console.error("report_worker_failed", { messageId: record.messageId, error: error instanceof Error ? error.message : String(error) });
        failures.push({ itemIdentifier: record.messageId });
      }
    }
  } finally {
    await releaseWorkerLock("cotality-report-worker", holder).catch(() => undefined);
    await closePool();
  }
  return { batchItemFailures: failures };
}
