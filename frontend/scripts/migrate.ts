#!/usr/bin/env tsx
/**
 * Applies the durable pipeline schema to Neon. Idempotent: safe to re-run.
 */

import { closePool, getPool, initSchema } from "../lib/db";
import { createLogger } from "../lib/logger";

const log = createLogger({ script: "migrate" });

async function run(): Promise<void> {
  log.info("migration.start");
  await initSchema();

  const { rows } = await getPool().query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('pipeline_jobs','csv_attachments','property_reports','reply_attempts','job_events','worker_heartbeats','gmail_sessions')
      ORDER BY table_name`,
  );
  log.info("migration.tables", { tables: rows.map((row) => row.table_name) });

  const { rows: indexes } = await getPool().query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN ('idx_reply_attempts_one_sent','idx_property_reports_job_property')
      ORDER BY indexname`,
  );
  log.info("migration.guards", { indexes: indexes.map((row) => row.indexname) });

  log.info("migration.complete");
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error("migration.failed", { error: error instanceof Error ? error.message : String(error) });
    await closePool();
    process.exit(1);
  });
