#!/usr/bin/env tsx
/**
 * Retention cleanup for the private Blob store.
 *
 * Deletes CSV and report blobs older than the retention window, while
 * protecting artifacts belonging to jobs that are not yet in a terminal state.
 *
 *   pnpm blob:cleanup -- --dry-run
 *   pnpm blob:cleanup -- --retention-days 90
 *
 * Intended to be scheduled (for example a Render cron job) once the worker is
 * live. Defaults to a dry run so it can never delete unintentionally.
 */

import { cleanupExpiredBlobs } from "../lib/blob-storage";
import { closePool, getPool } from "../lib/db";
import { createLogger } from "../lib/logger";

const log = createLogger({ script: "blob-cleanup" });

function parseArgs(argv: string[]) {
  let retentionDays = 30;
  // Deleting is opt-in: an unattended schedule must pass --commit explicitly.
  let dryRun = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--retention-days" && argv[index + 1]) {
      retentionDays = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--commit") {
      dryRun = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error("--retention-days must be a positive number.");
  }
  return { retentionDays, dryRun };
}

async function protectedPathnames(): Promise<Set<string>> {
  // Never delete artifacts for jobs that could still be retried or replied to.
  const { rows } = await getPool().query<{ pathname: string }>(
    `SELECT c.blob_pathname AS pathname
       FROM csv_attachments c
       JOIN pipeline_jobs j ON j.id = c.job_id
      WHERE c.blob_pathname IS NOT NULL
        AND j.status NOT IN ('completed','failed')
      UNION
     SELECT p.blob_pathname AS pathname
       FROM property_reports p
       JOIN pipeline_jobs j ON j.id = p.job_id
      WHERE p.blob_pathname IS NOT NULL
        AND j.status NOT IN ('completed','failed')`,
  );
  return new Set(rows.map((row) => row.pathname));
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const protectedSet = await protectedPathnames();
  log.info("cleanup.start", { ...options, protectedCount: protectedSet.size });

  const result = await cleanupExpiredBlobs({
    retentionDays: options.retentionDays,
    dryRun: options.dryRun,
    protectedPathnames: protectedSet,
  });

  log.info("cleanup.complete", {
    scanned: result.scanned,
    retained: result.retained,
    deletedCount: result.deleted.length,
    dryRun: options.dryRun,
  });
  if (options.dryRun && result.deleted.length) {
    log.info("cleanup.dry_run_notice", { message: "Re-run with --commit to delete these blobs." });
  }
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error("cleanup.failed", { error: error instanceof Error ? error.message : String(error) });
    await closePool();
    process.exit(1);
  });
