#!/usr/bin/env tsx
/**
 * Read-only health check for every external API the pipeline depends on.
 *
 * Deliberately non-mutating: no email is sent, no job is created, no queue
 * message is enqueued, no artifact is written. Each probe is the cheapest call
 * that still proves the credential is accepted and the endpoint answers.
 *
 * Cotality probes go through lib/corelogic so the existing serialisation,
 * 500ms floor and circuit breaker apply. The number of Cotality calls is fixed
 * and small; this script cannot contribute meaningful rate-limit pressure.
 *
 * Secret values are never printed. Only presence, length and key names.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

// Env must be loaded before any module that reads configuration at import time.
for (const candidate of [
  nodePath.resolve(process.cwd(), "..", ".env"),
  nodePath.resolve(process.cwd(), ".env"),
  nodePath.resolve(process.cwd(), ".env.local"),
]) {
  if (!existsSync(candidate)) continue;
  for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}
process.env.AWS_REGION ??= "ap-southeast-2";
process.env.AWS_DEFAULT_REGION ??= process.env.AWS_REGION;
// The authorised mailbox is Gmail even though the env files still say outlook.
process.env.MAILBOX_PROVIDER = "gmail";

type Status = "ok" | "warn" | "fail" | "skip";
type Check = { group: string; name: string; status: Status; detail: string };

const checks: Check[] = [];
const record = (group: string, name: string, status: Status, detail: string) => {
  checks.push({ group, name, status, detail });
  const icon = { ok: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" }[status];
  console.log(`  ${icon}  ${name.padEnd(34)} ${detail}`);
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs a probe and records a failure rather than aborting the whole report. */
async function probe(group: string, name: string, run: () => Promise<[Status, string]>): Promise<void> {
  try {
    const [status, detail] = await run();
    record(group, name, status, detail);
  } catch (error) {
    record(group, name, "fail", message(error));
  }
}

// ---------------------------------------------------------------------------
// Cotality
// ---------------------------------------------------------------------------

/** A fixed, well-known Sydney address; the same one the dry run uses. */
const PROBE_ADDRESS = "1 Macquarie Street Sydney NSW 2000";

async function checkCotality(): Promise<void> {
  console.log("\nCotality (Sandbox)");
  const { corelogicPost, corelogicRequest, cotalityCircuitState } = await import("../lib/corelogic");

  const clientId = process.env.CORELOGIC_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.CORELOGIC_CLIENT_SECRET?.trim() ?? "";
  record(
    "cotality",
    "credentials configured",
    clientId && clientSecret ? "ok" : "fail",
    `id length ${clientId.length}, secret length ${clientSecret.length}`,
  );
  if (!clientId || !clientSecret) return;

  // Suggest doubles as the token check: corelogic.ts authenticates lazily, so a
  // 200 here proves the OAuth client-credentials grant succeeded.
  let propertyId: number | null = null;
  let streetId: number | null = null;

  await probe("cotality", "GET /property/au/v2/suggest", async () => {
    const result = await corelogicRequest(`/property/au/v2/suggest.json?q=${encodeURIComponent(PROBE_ADDRESS)}`);
    const suggestions = (result.data as { suggestions?: Array<Record<string, unknown>> } | null)?.suggestions ?? [];
    const first = suggestions[0];
    propertyId = Number(first?.propertyId) || null;
    streetId = Number(first?.streetId) || null;
    return [result.ok ? "ok" : "fail", `HTTP ${result.status}, ${suggestions.length} suggestions, token accepted`];
  });

  await probe("cotality", "GET /search/au/matcher/address", async () => {
    const result = await corelogicRequest(
      `/search/au/matcher/address?q=${encodeURIComponent(PROBE_ADDRESS)}&clientName=Parcel%20Atlas`,
    );
    const details = (result.data as { matchDetails?: { matchType?: string } } | null)?.matchDetails;
    return [result.ok ? "ok" : "fail", `HTTP ${result.status}, matchType ${details?.matchType ?? "none"}`];
  });

  if (!propertyId) {
    record("cotality", "property-dependent probes", "skip", "suggest returned no propertyId");
    return;
  }

  // The primary reference path. One request instead of the ~100-page street
  // scan that previously exhausted the sandbox quota.
  await probe("cotality", "GET /property/au/v1/property/{id}", async () => {
    const result = await corelogicRequest(`/property/au/v1/property/${propertyId}.json`, { ttlSeconds: 900 });
    return [result.ok ? "ok" : "fail", `HTTP ${result.status} for property ${propertyId}`];
  });

  if (streetId) {
    await probe("cotality", "GET /search/au/property/street/{id}", async () => {
      const result = await corelogicRequest(`/search/au/property/street/${streetId}?page=0`);
      return [result.ok ? "ok" : "fail", `HTTP ${result.status} for street ${streetId} page 0 (fallback path)`];
    });
  } else {
    record("cotality", "GET /search/au/property/street/{id}", "skip", "suggest returned no streetId");
  }

  await probe("cotality", "POST /property/.../comparables", async () => {
    const { comparablesRequestBody } = await import("../lib/cotality-comparables");
    const result = await corelogicPost("/property/au/v1/property/comparables.json", comparablesRequestBody(propertyId!), {
      ttlSeconds: 300,
    });
    // The list is nested: comparablesSummaryList[].propertyComparableList[].
    // Counting the outer array only would under-report to zero.
    const summaries =
      (result.data as { comparablesSummaryList?: Array<{ propertyComparableList?: unknown[] }> } | null)
        ?.comparablesSummaryList ?? [];
    const count = summaries.reduce((total, summary) => total + (summary.propertyComparableList?.length ?? 0), 0);
    return [
      result.ok && count > 0 ? "ok" : result.ok ? "warn" : "fail",
      `HTTP ${result.status}, ${count} rental comparable(s) across ${summaries.length} summary group(s)`,
    ];
  });

  const circuit = cotalityCircuitState();
  record(
    "cotality",
    "throttle circuit breaker",
    circuit.open ? "warn" : "ok",
    circuit.open ? `open, resumes in ${Math.ceil(circuit.retryAfterMs / 1000)}s` : "closed, no rate limiting seen",
  );
}

// ---------------------------------------------------------------------------
// Neon
// ---------------------------------------------------------------------------

const REQUIRED_TABLES = [
  "pipeline_jobs",
  "csv_attachments",
  "property_reports",
  "reply_attempts",
  "job_events",
  "worker_heartbeats",
  "gmail_oauth_connections",
];

async function checkNeon(): Promise<void> {
  console.log("\nNeon Postgres");
  const { getPool, closePool } = await import("../lib/db");

  await probe("neon", "connectivity", async () => {
    const { rows } = await getPool().query<{ version: string }>("SELECT version() AS version");
    return ["ok", rows[0]?.version.split(",")[0] ?? "connected"];
  });

  await probe("neon", "schema", async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
      [REQUIRED_TABLES],
    );
    const present = new Set(rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    return missing.length
      ? ["fail", `missing: ${missing.join(", ")} — run pnpm db:migrate`]
      : ["ok", `all ${REQUIRED_TABLES.length} pipeline tables present`];
  });

  await probe("neon", "duplicate-reply guard", async () => {
    const { rows } = await getPool().query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'reply_attempts' AND indexdef ILIKE '%unique%'",
    );
    return rows.length ? ["ok", `${rows.length} unique index(es) on reply_attempts`] : ["fail", "no unique index"];
  });

  await probe("neon", "pending work", async () => {
    const { rows } = await getPool().query<{ status: string; count: string }>(
      "SELECT status, COUNT(*)::text AS count FROM pipeline_jobs GROUP BY status ORDER BY status",
    );
    return ["ok", rows.length ? rows.map((row) => `${row.status}=${row.count}`).join(" ") : "no jobs yet"];
  });

  await closePool();
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

async function checkGmail(): Promise<void> {
  console.log("\nGmail API (OAuth)");
  const { getGmailConnection, closePool } = await import("../lib/db");
  const { readOAuthClientConfig, readOAuthClientCredentials, refreshAccessToken } = await import("../lib/gmail-oauth");
  const { GmailApiClient } = await import("../lib/gmail-api");
  const { decryptSecret } = await import("../lib/token-crypto");
  const { DEFAULT_INBOX_QUERY } = await import("../lib/gmail-mailbox");

  await probe("gmail", "OAuth client configuration", async () => {
    const config = readOAuthClientConfig(process.env);
    return ["ok", `client id length ${config.clientId.length}, redirect ${new URL(config.redirectUri).host}`];
  });

  const key = process.env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  record("gmail", "token encryption key", key ? "ok" : "fail", key ? `present, length ${key.length}` : "MISSING");

  let accessToken: string | null = null;

  await probe("gmail", "stored connection", async () => {
    const connection = await getGmailConnection();
    if (!connection?.refresh_token_encrypted) return ["fail", "no connection row — authorize via Connect Gmail"];
    // Decrypt locally before spending a network call on a token that cannot work.
    decryptSecret(connection.refresh_token_encrypted);
    return [
      connection.status === "connected" ? "ok" : "warn",
      `${connection.email_masked ?? "unknown"}, status ${connection.status}, token decrypts`,
    ];
  });

  await probe("gmail", "refresh token exchange", async () => {
    const connection = await getGmailConnection();
    if (!connection?.refresh_token_encrypted) return ["skip", "no stored connection"];
    const result = await refreshAccessToken({
      refreshToken: decryptSecret(connection.refresh_token_encrypted),
      // Credentials only, matching what the Lambda has available.
      config: readOAuthClientCredentials(process.env),
    });
    accessToken = result.accessToken;
    return ["ok", "Google issued a fresh access token"];
  });

  await probe("gmail", "inbox read (messages.list)", async () => {
    if (!accessToken) return ["skip", "no access token"];
    const messages = await new GmailApiClient(accessToken).listCandidateMessages(DEFAULT_INBOX_QUERY, 5);
    // Read-only. Zero matches is a valid inbox state, not a failure.
    return ["ok", `${messages.length} CSV candidate message(s) matching the worker query`];
  });

  record("gmail", "send scope", "skip", "not exercised: sending a probe email would deliver real mail");
  await closePool();
}

// ---------------------------------------------------------------------------
// Vercel Blob
// ---------------------------------------------------------------------------

async function checkBlob(): Promise<void> {
  console.log("\nVercel Blob");
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
  if (!token) {
    record("blob", "token", "warn", "BLOB_READ_WRITE_TOKEN not set locally (Lambda uses S3 instead)");
    return;
  }
  record("blob", "token", "ok", `present, length ${token.length}`);

  await probe("blob", "list parcel-atlas prefix", async () => {
    const { list } = await import("@vercel/blob");
    const page = await list({ prefix: "parcel-atlas/", limit: 5, token });
    return ["ok", `readable, ${page.blobs.length} object(s) sampled`];
  });
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

const LAMBDA_FUNCTIONS = ["parcel-atlas-dispatch", "parcel-atlas-report-worker", "parcel-atlas-delivery"];

async function checkAws(): Promise<void> {
  console.log("\nAWS (ap-southeast-2)");
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    record("aws", "credentials", "fail", "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set");
    return;
  }
  record("aws", "credentials", "ok", `access key id length ${process.env.AWS_ACCESS_KEY_ID.length}`);

  const { LambdaClient, GetFunctionConfigurationCommand } = await import("@aws-sdk/client-lambda");
  const lambda = new LambdaClient({});
  const environment = new Map<string, string>();
  let secretKeys = new Set<string>();

  for (const name of LAMBDA_FUNCTIONS) {
    await probe("aws", `lambda ${name.replace("parcel-atlas-", "")}`, async () => {
      const result = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
      // Collect the deployed configuration so the queue and bucket probes below
      // check what Lambda actually uses, not a hardcoded guess.
      for (const [key, value] of Object.entries(result.Environment?.Variables ?? {})) {
        if (!environment.has(key)) environment.set(key, value);
      }
      const healthy = result.State === "Active" && result.LastUpdateStatus === "Successful";
      return [
        healthy ? "ok" : "fail",
        `${result.State}/${result.LastUpdateStatus}, ${Math.round((result.CodeSize ?? 0) / 1024)} KB, timeout ${result.Timeout}s`,
      ];
    });
  }

  await probe("aws", "s3 artifact bucket", async () => {
    const bucket = environment.get("ARTIFACT_BUCKET");
    if (!bucket) return ["fail", "ARTIFACT_BUCKET not set on any function"];
    const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const result = await new S3Client({}).send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 5 }));
    return ["ok", `${bucket} readable, ${result.KeyCount ?? 0} object(s) sampled`];
  });

  const { SQSClient, GetQueueAttributesCommand } = await import("@aws-sdk/client-sqs");
  const sqs = new SQSClient({});
  for (const key of ["REPORT_QUEUE_URL", "DELIVERY_QUEUE_URL"]) {
    await probe("aws", `sqs ${key.replace("_QUEUE_URL", "").toLowerCase()} queue`, async () => {
      const url = environment.get(key);
      if (!url) return ["fail", `${key} not set on any function`];
      const result = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "VisibilityTimeout"],
        }),
      );
      const attributes = result.Attributes ?? {};
      return [
        "ok",
        `visible ${attributes.ApproximateNumberOfMessages ?? "?"}, in-flight ${attributes.ApproximateNumberOfMessagesNotVisible ?? "?"}, visibility ${attributes.VisibilityTimeout ?? "?"}s`,
      ];
    });
  }

  await probe("aws", "secrets manager", async () => {
    const arn = environment.get("PIPELINE_SECRET_ARN");
    if (!arn) return ["fail", "PIPELINE_SECRET_ARN not set on any function"];
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const result = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
    const parsed = JSON.parse(result.SecretString ?? "{}") as Record<string, string>;
    // Key names only. Values stay unread.
    const keys = Object.keys(parsed).sort();
    const empty = keys.filter((key) => !parsed[key]);
    secretKeys = new Set(keys);
    return [
      empty.length ? "warn" : "ok",
      `${keys.length} keys: ${keys.join(", ")}${empty.length ? ` — empty: ${empty.join(", ")}` : ""}`,
    ];
  });

  // The delivery Lambda's Gmail path must be satisfiable from the secret alone.
  // Checking it here catches the case where local .env masks a missing key.
  await probe("aws", "lambda gmail config sufficiency", async () => {
    if (!secretKeys.size) return ["skip", "secret could not be read"];
    const { readOAuthClientCredentials } = await import("../lib/gmail-oauth");
    // Simulate the Lambda environment: only secret keys plus function config.
    // NODE_ENV=production blocks runtime-env's local .env fallback, so this
    // reflects Lambda rather than the developer machine.
    const simulated = {
      ...Object.fromEntries([...secretKeys].map((key) => [key, "present"])),
      NODE_ENV: "production",
    } as unknown as NodeJS.ProcessEnv;
    readOAuthClientCredentials(simulated);
    for (const required of ["GMAIL_TOKEN_ENCRYPTION_KEY", "DATABASE_URL"]) {
      if (!secretKeys.has(required)) return ["fail", `secret is missing ${required}`];
    }
    return ["ok", "refresh grant, token decryption and Neon access all satisfiable from the secret"];
  });
}

// ---------------------------------------------------------------------------
// Vercel app
// ---------------------------------------------------------------------------

async function checkVercelApp(): Promise<void> {
  console.log("\nVercel app");
  const base = process.env.PARCEL_ATLAS_BASE_URL?.trim().replace(/\/$/, "");
  if (!base) {
    record("vercel", "base url", "warn", "PARCEL_ATLAS_BASE_URL not set");
    return;
  }
  // Both are GET-only reads. The trigger route is deliberately not called: it
  // would dispatch real work.
  for (const path of ["/api/worker/health", "/api/gmail/oauth/status"]) {
    await probe("vercel", `GET ${path}`, async () => {
      const response = await fetch(`${base}${path}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) return ["fail", `HTTP ${response.status} from ${new URL(base).host}`];
      if (path === "/api/worker/health") {
        // Heartbeats come from the long-running worker. On the Lambda
        // architecture there is no resident worker, so healthy=false is the
        // expected reading and is reported rather than treated as a failure.
        const workers = (payload as { workers?: unknown[] } | null)?.workers ?? [];
        return ["ok", `HTTP 200, ${workers.length} heartbeat row(s), resident worker healthy=${payload?.healthy}`];
      }
      const status = (payload as { connection?: { status?: string } } | null)?.connection?.status ?? payload?.status;
      return [status === "connected" ? "ok" : "warn", `HTTP 200, Gmail connection status ${String(status)}`];
    });
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Parcel Atlas API health check — read-only, no mail sent, no jobs created\n");

  await checkCotality();
  await checkNeon();
  await checkGmail();
  await checkBlob();
  await checkAws();
  await checkVercelApp();

  const tally = (status: Status) => checks.filter((check) => check.status === status).length;
  console.log(
    `\nSummary: ${tally("ok")} pass, ${tally("warn")} warn, ${tally("fail")} fail, ${tally("skip")} skipped`,
  );

  const failures = checks.filter((check) => check.status === "fail");
  if (failures.length) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  - [${failure.group}] ${failure.name}: ${failure.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nVERDICT: every configured API responded.");
}

void main().catch((error: unknown) => {
  console.error(`health check aborted: ${message(error)}`);
  process.exitCode = 1;
});
