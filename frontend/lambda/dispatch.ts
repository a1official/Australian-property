import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { configureAwsRuntime } from "./aws-runtime";
import { discoverMailboxJobsOnce } from "../scripts/render-worker";

type LambdaContext = { awsRequestId?: string };

export async function handler(_event: unknown, context: LambdaContext = {}) {
  await configureAwsRuntime();
  const queueUrl = process.env.REPORT_QUEUE_URL;
  if (!queueUrl) throw new Error("REPORT_QUEUE_URL is not configured.");
  const jobIds = await discoverMailboxJobsOnce();
  const sqs = new SQSClient({});
  await Promise.all(jobIds.map((jobId) => sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ version: 1, jobId }),
    MessageGroupId: undefined,
  }))));
  return { ok: true, discovered: jobIds.length, requestId: context.awsRequestId ?? null };
}
