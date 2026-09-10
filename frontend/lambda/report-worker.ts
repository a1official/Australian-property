import { configureAwsRuntime } from "./aws-runtime";
import { runWorkerOnce } from "../scripts/render-worker";

type SqsRecord = { messageId: string; body: string };
type SqsEvent = { Records?: SqsRecord[] };

/**
 * The durable Neon lease remains the final ownership guard. SQS controls
 * retries and concurrency; runWorkerOnce claims exactly one queued job, so a
 * duplicate SQS delivery cannot create duplicate reports or emails.
 */
export async function handler(event: SqsEvent) {
  await configureAwsRuntime();
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records ?? []) {
    try {
      JSON.parse(record.body) as { jobId?: string }; // Reject malformed queue messages.
      await runWorkerOnce();
    } catch (error) {
      console.error("report_worker_failed", { messageId: record.messageId, error: error instanceof Error ? error.message : String(error) });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
