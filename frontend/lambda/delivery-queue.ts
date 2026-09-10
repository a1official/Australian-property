/**
 * Enqueues one delivery message per completed property report.
 *
 * Kept separate from the delivery handler so the report worker can hand off
 * without importing Gmail code, and so the queue URL is resolved in one place.
 */

import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

let client: SQSClient | null = null;

export type DeliveryMessage = { version: 1; jobId: string; propertyReportId: string };

/**
 * Sends `{ jobId, propertyReportId }` to the delivery queue.
 *
 * Returns false when no queue is configured, which is the case for local runs
 * and the legacy monolithic worker; the caller then keeps its existing
 * behaviour rather than silently dropping the report.
 */
export async function enqueueDelivery(params: { jobId: string; propertyReportId: string }): Promise<boolean> {
  const queueUrl = process.env.DELIVERY_QUEUE_URL?.trim();
  if (!queueUrl) return false;

  client ??= new SQSClient({});
  const message: DeliveryMessage = { version: 1, jobId: params.jobId, propertyReportId: params.propertyReportId };
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      // Group per property so a retry of one report cannot reorder another.
      MessageAttributes: {
        jobId: { DataType: "String", StringValue: params.jobId },
        propertyReportId: { DataType: "String", StringValue: params.propertyReportId },
      },
    }),
  );
  return true;
}
