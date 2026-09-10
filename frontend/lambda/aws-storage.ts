/** Private S3 artifact adapter used by Lambda. */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

function bucket(): string {
  const value = process.env.ARTIFACT_BUCKET;
  if (!value) throw new Error("ARTIFACT_BUCKET is not configured.");
  return value;
}

export function awsArtifactPath(kind: "csv" | "reports", jobId: string, secret: string, filename: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "file";
  return `${kind}/${safe(jobId)}-${safe(secret)}/${safe(filename)}`;
}

export async function putAwsArtifact(key: string, body: Buffer | string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "AES256" }));
}

export async function getAwsArtifact(key: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!result.Body) throw new Error(`Artifact ${key} returned no content.`);
  return Buffer.from(await result.Body.transformToByteArray());
}
