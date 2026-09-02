#!/usr/bin/env tsx
/**
 * Reports which parts of the pipeline are actually operational.
 *
 * Checks configuration presence and database state only. It performs no OAuth
 * exchange, no inbox scan, no Cotality call, and sends no email. Values are
 * never printed, only whether each name is set.
 */

import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";

import { closePool, getGmailConnectionSummary, getPool } from "../lib/db";
import { resolveEncryptionKey } from "../lib/token-crypto";

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

function present(key: string): boolean {
  return Boolean(process.env[key]?.trim());
}

function line(label: string, ok: boolean, note = ""): string {
  return `  ${ok ? "OK     " : "MISSING"}  ${label.padEnd(32)}${note}`;
}

async function run(): Promise<void> {
  console.log("\nParcel Atlas pipeline readiness (no values printed)\n");

  console.log("Configuration");
  const configChecks = [
    ["DATABASE_URL", present("DATABASE_URL")],
    ["BLOB_READ_WRITE_TOKEN", present("BLOB_READ_WRITE_TOKEN")],
    ["GMAIL_CLIENT_ID", present("GMAIL_CLIENT_ID")],
    ["GMAIL_CLIENT_SECRET", present("GMAIL_CLIENT_SECRET")],
    ["GMAIL_REDIRECT_URI", present("GMAIL_REDIRECT_URI")],
    ["GITHUB_WORKFLOW_DISPATCH_TOKEN", present("GITHUB_WORKFLOW_DISPATCH_TOKEN")],
    ["CORELOGIC_CLIENT_ID", present("CORELOGIC_CLIENT_ID")],
  ] as const;
  for (const [key, ok] of configChecks) console.log(line(key, ok));

  let keyOk = false;
  try {
    resolveEncryptionKey(process.env.GMAIL_TOKEN_ENCRYPTION_KEY);
    keyOk = true;
  } catch {
    keyOk = false;
  }
  console.log(line("GMAIL_TOKEN_ENCRYPTION_KEY", keyOk, keyOk ? "" : "required to store the refresh token"));

  console.log("\nDatabase");
  const { rows: tables } = await getPool().query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('pipeline_jobs','csv_attachments','property_reports','reply_attempts','job_events','gmail_oauth_connections')
      ORDER BY table_name`,
  );
  const names = tables.map((row) => row.table_name);
  for (const expected of [
    "pipeline_jobs",
    "csv_attachments",
    "property_reports",
    "reply_attempts",
    "job_events",
    "gmail_oauth_connections",
  ]) {
    console.log(line(expected, names.includes(expected)));
  }

  console.log("\nGmail connection");
  const summary = await getGmailConnectionSummary();
  if (!summary) {
    console.log(line("Gmail authorized", false, "click Connect Gmail to authorize once"));
  } else {
    const status = String(summary.status ?? "unknown");
    console.log(line("Gmail authorized", status === "connected" && Boolean(summary.has_token), `status=${status}`));
    console.log(`  account: ${summary.email_masked ?? "n/a"}`);
  }

  const { rows: jobs } = await getPool().query<{ status: string; n: string }>(
    "SELECT status, COUNT(*)::text AS n FROM pipeline_jobs GROUP BY status ORDER BY status",
  );
  console.log("\nJobs by status");
  if (!jobs.length) console.log("  (none yet)");
  for (const row of jobs) console.log(`  ${row.status.padEnd(24)} ${row.n}`);

  const blocking: string[] = [];
  if (!keyOk) blocking.push("GMAIL_TOKEN_ENCRYPTION_KEY is not set");
  if (!present("GMAIL_CLIENT_ID") || !present("GMAIL_CLIENT_SECRET")) blocking.push("Gmail OAuth client is not configured");
  if (!present("GITHUB_WORKFLOW_DISPATCH_TOKEN")) blocking.push("Auto-pilot cannot dispatch without GITHUB_WORKFLOW_DISPATCH_TOKEN");
  if (!summary || String(summary.status) !== "connected") blocking.push("Gmail has not been authorized yet");

  console.log("\nVerdict");
  if (!blocking.length) {
    console.log("  Every prerequisite is configured. The pipeline can run end to end.");
  } else {
    console.log("  Not yet operational. Outstanding items:");
    for (const item of blocking) console.log(`    - ${item}`);
  }
  console.log("");
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("status check failed:", error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
