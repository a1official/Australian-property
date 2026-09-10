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
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify({ source: "vercel", reason: typeof reason === "string" ? reason.slice(0, 200) : undefined })),
  }));
  if (response.FunctionError) throw new Error("AWS dispatch function failed.");
  let payload: { ok?: boolean; discovered?: number; error?: string } | null = null;
  try { payload = JSON.parse(Buffer.from(response.Payload ?? []).toString("utf8")); } catch { /* handled below */ }
  if (!payload?.ok) throw new Error(payload?.error || "AWS dispatch function returned an invalid response.");
  return { discovered: Number(payload.discovered ?? 0) };
}

export function awsDispatchConfigured(): boolean {
  try { configuration(); return true; } catch { return false; }
}
