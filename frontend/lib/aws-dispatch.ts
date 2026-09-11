import "server-only";

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

export class AwsDispatchConfigurationError extends Error {}

function configuration() {
  const region = process.env.AWS_REGION?.trim();
  const functionName = process.env.AWS_LAMBDA_DISPATCH_FUNCTION?.trim();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!region || !functionName || !accessKeyId || !secretAccessKey) {
    throw new AwsDispatchConfigurationError("AWS dispatch is not fully configured.");
  }
  return { region, functionName, accessKeyId, secretAccessKey };
}

export async function dispatchAwsMailboxRun(reason?: unknown) {
  const config = configuration();
  const client = new LambdaClient({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const response = await client.send(new InvokeCommand({
    FunctionName: config.functionName,
    // Gmail discovery can take longer than Vercel's request budget. The
    // dispatcher is already durable: it registers jobs in Neon and sends them
    // to SQS, so there is no benefit in holding the browser connection open.
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify({ source: "vercel", reason: typeof reason === "string" ? reason.slice(0, 200) : undefined })),
  }));
  // Lambda returns 202 when it has durably accepted an asynchronous event.
  // The function result is intentionally not available in this mode; the UI
  // watches Neon job records for real progress instead of guessing a count.
  if (response.StatusCode !== 202) throw new Error("AWS did not accept the mailbox run.");
  return { accepted: true };
}

export function awsDispatchConfigured(): boolean {
  try { configuration(); return true; } catch { return false; }
}
