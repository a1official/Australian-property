/** Runtime bootstrap shared by the AWS Lambda handlers.
 *
 * The CloudFormation template deliberately contains no application secrets.
 * They are fetched once per warm Lambda environment, copied into process.env,
 * and then consumed by the existing database, Gmail and Cotality adapters.
 */
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

let configured: Promise<void> | null = null;

export async function configureAwsRuntime(): Promise<void> {
  if (configured) return configured;
  configured = (async () => {
    const secretArn = process.env.PIPELINE_SECRET_ARN;
    if (!secretArn) throw new Error("PIPELINE_SECRET_ARN is not configured.");
    const response = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) throw new Error("Pipeline secret is empty.");
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(response.SecretString) as Record<string, unknown>;
    } catch {
      throw new Error("Pipeline secret must contain a JSON object.");
    }
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string" && value && !process.env[name]) process.env[name] = value;
    }
    for (const required of ["DATABASE_URL", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_TOKEN_ENCRYPTION_KEY"]) {
      if (!process.env[required]) throw new Error(`Pipeline secret is missing ${required}.`);
    }
  })().catch((error) => {
    configured = null;
    throw error;
  });
  return configured;
}
