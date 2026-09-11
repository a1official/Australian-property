import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { configureAwsRuntime } from "./aws-runtime";
import { discoverMailboxJobsOnce } from "../scripts/render-worker";

type LambdaContext = { awsRequestId?: string };
type DispatchEvent = { source?: unknown; detailType?: unknown };

export async function handler(event: DispatchEvent = {}, context: LambdaContext = {}) {
  await configureAwsRuntime();
  const queueUrl = process.env.REPORT_QUEUE_URL;
  if (!queueUrl) throw new Error("REPORT_QUEUE_URL is not configured.");
  const source = typeof event.source === "string" ? event.source : "direct";
  console.info(JSON.stringify({ level: "info", msg: "dispatch.started", source }));
  const jobIds = await discoverMailboxJobsOnce();
  const sqs = new SQSClient({});
  await Promise.all(jobIds.map((jobId) => sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ version: 1, jobId }),
    MessageGroupId: undefined,
  }))));
  console.info(JSON.stringify({ level: "info", msg: "dispatch.completed", source, discovered: jobIds.length }));
  return { ok: true, discovered: jobIds.length, requestId: context.awsRequestId ?? null };
}
