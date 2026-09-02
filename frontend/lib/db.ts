/**
 * Durable job store on Neon Postgres.
 *
 * Two drivers are used deliberately:
 *  - `neon()` HTTP driver for short, stateless reads from Vercel functions.
 *  - `Pool` for the worker, because claiming a job needs a real interactive
 *    transaction (`BEGIN … FOR UPDATE SKIP LOCKED … COMMIT`), which the HTTP
 *    driver cannot express.
 */

import { Pool, neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // Local development only. Production always injects the variable.
  if (process.env.NODE_ENV !== "production") {
    for (const envPath of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "..", ".env")]) {
      try {
        const match = readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.+)$/m);
        if (match) return match[1].trim().replace(/^["']|["']$/g, "");
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error("DATABASE_URL is not set in environment.");
}

export function getDb() {
  return neon(getDatabaseUrl());
}

let pool: Pool | null = null;

/** Pooled driver for the worker. Reused across cycles; closed on shutdown. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getDatabaseUrl(), max: 4, idleTimeoutMillis: 30_000 });
    pool.on("error", () => {
      // A broken idle connection must not crash the worker; the next
      // checkout re-establishes it.
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end().catch(() => undefined);
  }
}

async function withTransaction<T>(handler: (client: import("@neondatabase/serverless").PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Job lifecycle. Terminal states: completed, failed, needs_reauthentication. */
export type JobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "downloaded"
  | "matched"
  | "report_generated"
  | "replying"
  | "completed"
  | "retryable_failed"
  | "needs_review"
  | "needs_reauthentication"
  | "failed";

export const TERMINAL_JOB_STATUSES: JobStatus[] = ["completed", "failed", "needs_reauthentication"];

/** Statuses the worker is allowed to pick up. */
export const CLAIMABLE_JOB_STATUSES: JobStatus[] = [
  "queued",
  "downloaded",
  "matched",
  "report_generated",
  "retryable_failed",
  "needs_review",
];

export type PropertyReportStatus = "pending" | "matched" | "needs_review" | "unmatched" | "generated" | "failed";

export interface PipelineJob {
  id: string;
  idempotency_key: string;
  sender: string;
  subject: string;
  thread_id: string | null;
  message_id: string | null;
  status: JobStatus;
  attempts: number;
  leased_by: string | null;
  leased_at: string | null;
  lease_expires_at: string | null;
  next_run_at: string | null;
  gmail_handled_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CsvAttachmentRecord {
  id: string;
  job_id: string;
  filename: string;
  file_hash: string;
  row_count: number;
  byte_size: number;
  blob_pathname: string | null;
  blob_url: string | null;
  created_at: string;
}

export interface PropertyReportRecord {
  id: string;
  job_id: string;
  row_number: number;
  original_address: string;
  normalized_address: string | null;
  property_id: string | null;
  status: PropertyReportStatus;
  attempts: number;
  score: string | null;
  weekly_rent: string | null;
  report_filename: string | null;
  blob_pathname: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReplyAttemptRecord {
  id: string;
  job_id: string;
  recipient: string;
  report_count: number;
  status: "pending" | "sent" | "failed";
  error: string | null;
  sent_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    thread_id TEXT,
    message_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    leased_by TEXT,
    leased_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    gmail_handled_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS csv_attachments (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    row_count INT NOT NULL DEFAULT 0,
    byte_size INT NOT NULL DEFAULT 0,
    blob_pathname TEXT,
    blob_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS property_reports (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
    row_number INT NOT NULL,
    original_address TEXT NOT NULL,
    normalized_address TEXT,
    property_id BIGINT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    score NUMERIC,
    weekly_rent NUMERIC,
    report_filename TEXT,
    blob_pathname TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS reply_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    report_count INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS job_events (
    id BIGSERIAL PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    detail TEXT,
    worker_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle',
    current_job_id TEXT,
    cycles BIGINT NOT NULL DEFAULT 0,
    detail TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS gmail_sessions (
    id TEXT PRIMARY KEY,
    storage_state JSONB NOT NULL,
    valid BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Password-login attempts are rate limited in the database rather than in
  // process memory, so a worker restart cannot reset the counter and hammer
  // Google. Repeated automated login failures are what trigger account locks.
  `CREATE TABLE IF NOT EXISTS gmail_login_attempts (
    id TEXT PRIMARY KEY,
    attempts INT NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    last_outcome TEXT,
    cooldown_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

/**
 * Uniqueness guards. Created after the de-duplication step below, because the
 * pre-existing schema allowed one row per generated report file rather than one
 * row per CSV address, which can leave duplicate (job_id, row_number) pairs.
 */
const INDEX_STATEMENTS = [
  // A single exact-match property must never produce two reports for one job.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_property_reports_job_property
     ON property_reports(job_id, property_id) WHERE property_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_property_reports_job_row
     ON property_reports(job_id, row_number)`,
  // At most one confirmed reply per job: the duplicate-email guard.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_attempts_one_sent
     ON reply_attempts(job_id) WHERE status = 'sent'`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_claimable ON pipeline_jobs(status, next_run_at)`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_property_reports_job ON property_reports(job_id, row_number)`,
];

/**
 * Collapses legacy duplicates so the unique indexes can be created.
 *
 * Keeps the most useful row per (job_id, row_number): a generated report wins
 * over a pending one, then the oldest. Only affects rows that already violate
 * the intended invariant.
 */
const DEDUPE_STATEMENTS = [
  `DELETE FROM property_reports p
     USING property_reports keep
    WHERE p.job_id = keep.job_id
      AND p.row_number = keep.row_number
      AND p.id <> keep.id
      AND (
        (keep.status = 'generated' AND p.status <> 'generated')
        OR (
          (keep.status = 'generated') = (p.status = 'generated')
          AND (keep.created_at, keep.id) < (p.created_at, p.id)
        )
      )`,
  `DELETE FROM property_reports p
     USING property_reports keep
    WHERE p.job_id = keep.job_id
      AND p.property_id IS NOT NULL
      AND keep.property_id = p.property_id
      AND p.id <> keep.id
      AND (keep.created_at, keep.id) < (p.created_at, p.id)`,
  `UPDATE reply_attempts r
      SET status = 'failed',
          error = COALESCE(error, 'Superseded duplicate reply record retained for audit.')
    WHERE r.status = 'sent'
      AND EXISTS (
        SELECT 1 FROM reply_attempts other
         WHERE other.job_id = r.job_id
           AND other.status = 'sent'
           AND (other.sent_at, other.id) < (r.sent_at, r.id)
      )`,
];

/**
 * Backfill columns for databases created by the earlier schema revision, so the
 * migration is safe to run repeatedly against an existing Neon database.
 */
const MIGRATION_STATEMENTS = [
  `ALTER TABLE pipeline_jobs ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0`,
  `ALTER TABLE pipeline_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`,
  `ALTER TABLE pipeline_jobs ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE pipeline_jobs ADD COLUMN IF NOT EXISTS gmail_handled_at TIMESTAMPTZ`,
  `ALTER TABLE csv_attachments ADD COLUMN IF NOT EXISTS blob_pathname TEXT`,
  `ALTER TABLE csv_attachments ADD COLUMN IF NOT EXISTS byte_size INT NOT NULL DEFAULT 0`,
  // Raw CSV content is no longer persisted in Postgres; Blob is the store of record.
  `ALTER TABLE csv_attachments DROP COLUMN IF EXISTS raw_content`,
  `ALTER TABLE property_reports ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0`,
  `ALTER TABLE property_reports ADD COLUMN IF NOT EXISTS report_filename TEXT`,
  `ALTER TABLE property_reports ADD COLUMN IF NOT EXISTS blob_pathname TEXT`,
  `ALTER TABLE property_reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE property_reports DROP COLUMN IF EXISTS html_blob_url`,
  `ALTER TABLE reply_attempts DROP COLUMN IF EXISTS sender`,
  `UPDATE pipeline_jobs SET status = 'queued' WHERE status = 'discovered'`,
  `UPDATE pipeline_jobs SET status = 'running' WHERE status = 'processing'`,
  `UPDATE pipeline_jobs SET status = 'completed' WHERE status = 'reply_sent'`,
];

export async function initSchema(): Promise<void> {
  const pooled = getPool();
  // Order matters: create/alter, then collapse legacy duplicates, then add the
  // uniqueness guards that those duplicates would otherwise block.
  for (const statement of [...SCHEMA_STATEMENTS, ...MIGRATION_STATEMENTS, ...DEDUPE_STATEMENTS, ...INDEX_STATEMENTS]) {
    await pooled.query(statement);
  }
}

// ---------------------------------------------------------------------------
// Job registration and idempotency
// ---------------------------------------------------------------------------

export async function findJobByIdempotencyKey(key: string): Promise<PipelineJob | null> {
  const { rows } = await getPool().query<PipelineJob>(
    "SELECT * FROM pipeline_jobs WHERE idempotency_key = $1 LIMIT 1",
    [key],
  );
  return rows[0] ?? null;
}

/**
 * Registers a job and its CSV attachment atomically. Re-registering the same
 * idempotency key returns the existing job untouched and reports created=false,
 * which is what makes repeated inbox crawls safe.
 */
export async function registerJobWithAttachment(params: {
  jobId: string;
  idempotencyKey: string;
  sender: string;
  subject: string;
  threadId?: string | null;
  messageId?: string | null;
  attachment: {
    id: string;
    filename: string;
    fileHash: string;
    rowCount: number;
    byteSize: number;
    blobPathname: string;
    blobUrl?: string | null;
  };
}): Promise<{ job: PipelineJob; created: boolean }> {
  return withTransaction(async (client) => {
    const inserted = await client.query<PipelineJob>(
      `INSERT INTO pipeline_jobs (id, idempotency_key, sender, subject, thread_id, message_id, status, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', NOW())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [params.jobId, params.idempotencyKey, params.sender, params.subject, params.threadId ?? null, params.messageId ?? null],
    );

    if (!inserted.rows.length) {
      const existing = await client.query<PipelineJob>(
        "SELECT * FROM pipeline_jobs WHERE idempotency_key = $1 LIMIT 1",
        [params.idempotencyKey],
      );
      return { job: existing.rows[0], created: false };
    }

    const job = inserted.rows[0];
    await client.query(
      `INSERT INTO csv_attachments (id, job_id, filename, file_hash, row_count, byte_size, blob_pathname, blob_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.attachment.id,
        job.id,
        params.attachment.filename,
        params.attachment.fileHash,
        params.attachment.rowCount,
        params.attachment.byteSize,
        params.attachment.blobPathname,
        params.attachment.blobUrl ?? null,
      ],
    );
    await client.query(
      `INSERT INTO job_events (job_id, from_status, to_status, detail) VALUES ($1, NULL, 'queued', $2)`,
      [job.id, `Discovered CSV ${params.attachment.filename} (${params.attachment.rowCount} rows)`],
    );
    return { job, created: true };
  });
}

// ---------------------------------------------------------------------------
// Leasing
// ---------------------------------------------------------------------------

/**
 * Claims at most one job for this worker inside a transaction.
 *
 * `FOR UPDATE SKIP LOCKED` guarantees two workers cannot select the same row.
 * An expired lease is reclaimable so a crashed worker cannot strand a job.
 */
export async function claimNextJob(workerId: string, leaseSeconds = 900): Promise<PipelineJob | null> {
  return withTransaction(async (client) => {
    const candidate = await client.query<{ id: string; status: JobStatus }>(
      `SELECT id, status FROM pipeline_jobs
        WHERE (
              (status = ANY($1::text[]) AND (next_run_at IS NULL OR next_run_at <= NOW()))
           OR (status IN ('claimed','running','replying') AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
        )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [CLAIMABLE_JOB_STATUSES],
    );
    if (!candidate.rows.length) return null;

    const { id, status } = candidate.rows[0];
    const claimed = await client.query<PipelineJob>(
      `UPDATE pipeline_jobs
          SET status = 'claimed',
              leased_by = $2,
              leased_at = NOW(),
              lease_expires_at = NOW() + ($3 || ' seconds')::interval,
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, workerId, String(leaseSeconds)],
    );
    await client.query(
      `INSERT INTO job_events (job_id, from_status, to_status, detail, worker_id)
       VALUES ($1, $2, 'claimed', $3, $4)`,
      [id, status, `Lease held for ${leaseSeconds}s`, workerId],
    );
    return claimed.rows[0];
  });
}

export async function extendLease(jobId: string, workerId: string, leaseSeconds = 900): Promise<void> {
  await getPool().query(
    `UPDATE pipeline_jobs
        SET lease_expires_at = NOW() + ($3 || ' seconds')::interval, updated_at = NOW()
      WHERE id = $1 AND leased_by = $2`,
    [jobId, workerId, String(leaseSeconds)],
  );
}

/** Records a state transition and appends an immutable audit event. */
export async function transitionJob(params: {
  jobId: string;
  status: JobStatus;
  workerId?: string | null;
  detail?: string | null;
  error?: string | null;
  nextRunAt?: Date | null;
  releaseLease?: boolean;
}): Promise<void> {
  await withTransaction(async (client) => {
    const current = await client.query<{ status: JobStatus }>(
      "SELECT status FROM pipeline_jobs WHERE id = $1 FOR UPDATE",
      [params.jobId],
    );
    if (!current.rows.length) throw new Error(`Job ${params.jobId} does not exist.`);

    await client.query(
      `UPDATE pipeline_jobs
          SET status = $2,
              error = $3,
              next_run_at = COALESCE($4, next_run_at),
              leased_by = CASE WHEN $5 THEN NULL ELSE leased_by END,
              lease_expires_at = CASE WHEN $5 THEN NULL ELSE lease_expires_at END,
              updated_at = NOW()
        WHERE id = $1`,
      [params.jobId, params.status, params.error ?? null, params.nextRunAt ?? null, params.releaseLease ?? false],
    );
    await client.query(
      `INSERT INTO job_events (job_id, from_status, to_status, detail, worker_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.jobId, current.rows[0].status, params.status, params.detail ?? params.error ?? null, params.workerId ?? null],
    );
  });
}

export async function markGmailHandled(jobId: string): Promise<void> {
  await getPool().query(
    "UPDATE pipeline_jobs SET gmail_handled_at = NOW(), updated_at = NOW() WHERE id = $1 AND gmail_handled_at IS NULL",
    [jobId],
  );
}

// ---------------------------------------------------------------------------
// Attachments and property rows
// ---------------------------------------------------------------------------

export async function getCsvAttachment(jobId: string): Promise<CsvAttachmentRecord | null> {
  const { rows } = await getPool().query<CsvAttachmentRecord>(
    "SELECT * FROM csv_attachments WHERE job_id = $1 ORDER BY created_at ASC LIMIT 1",
    [jobId],
  );
  return rows[0] ?? null;
}

/** Seeds one row per CSV address. Safe to call again after a crash. */
export async function seedPropertyRows(
  jobId: string,
  rows: Array<{ id: string; rowNumber: number; address: string }>,
): Promise<void> {
  if (!rows.length) return;
  await withTransaction(async (client) => {
    for (const row of rows) {
      await client.query(
        `INSERT INTO property_reports (id, job_id, row_number, original_address, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (job_id, row_number) DO NOTHING`,
        [row.id, jobId, row.rowNumber, row.address],
      );
    }
  });
}

export async function listPropertyRows(jobId: string): Promise<PropertyReportRecord[]> {
  const { rows } = await getPool().query<PropertyReportRecord>(
    "SELECT * FROM property_reports WHERE job_id = $1 ORDER BY row_number ASC",
    [jobId],
  );
  return rows;
}

export async function updatePropertyRow(params: {
  id: string;
  status: PropertyReportStatus;
  normalizedAddress?: string | null;
  propertyId?: number | null;
  score?: number | null;
  weeklyRent?: number | null;
  reportFilename?: string | null;
  blobPathname?: string | null;
  error?: string | null;
  incrementAttempts?: boolean;
}): Promise<void> {
  await getPool().query(
    `UPDATE property_reports
        SET status = $2,
            normalized_address = COALESCE($3, normalized_address),
            property_id = COALESCE($4, property_id),
            score = COALESCE($5, score),
            weekly_rent = COALESCE($6, weekly_rent),
            report_filename = COALESCE($7, report_filename),
            blob_pathname = COALESCE($8, blob_pathname),
            error = $9,
            attempts = attempts + CASE WHEN $10 THEN 1 ELSE 0 END,
            updated_at = NOW()
      WHERE id = $1`,
    [
      params.id,
      params.status,
      params.normalizedAddress ?? null,
      params.propertyId ?? null,
      params.score ?? null,
      params.weeklyRent ?? null,
      params.reportFilename ?? null,
      params.blobPathname ?? null,
      params.error ?? null,
      params.incrementAttempts ?? false,
    ],
  );
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

export async function hasSentReply(jobId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM reply_attempts WHERE job_id = $1 AND status = 'sent'",
    [jobId],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/**
 * Records a reply outcome. The partial unique index on (job_id) WHERE
 * status='sent' makes a second successful reply impossible at the database
 * level, so a duplicate email cannot be recorded even under a race.
 */
export async function recordReplyAttempt(params: {
  id: string;
  jobId: string;
  recipient: string;
  reportCount: number;
  status: "sent" | "failed";
  error?: string | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO reply_attempts (id, job_id, recipient, report_count, status, error, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'sent' THEN NOW() ELSE NULL END)`,
    [params.id, params.jobId, params.recipient, params.reportCount, params.status, params.error ?? null],
  );
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export async function recordHeartbeat(params: {
  workerId: string;
  status: string;
  currentJobId?: string | null;
  cycles?: number;
  detail?: string | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO worker_heartbeats (worker_id, status, current_job_id, cycles, detail, last_seen_at, started_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (worker_id) DO UPDATE
       SET status = EXCLUDED.status,
           current_job_id = EXCLUDED.current_job_id,
           cycles = EXCLUDED.cycles,
           detail = EXCLUDED.detail,
           last_seen_at = NOW()`,
    [params.workerId, params.status, params.currentJobId ?? null, params.cycles ?? 0, params.detail ?? null],
  );
}

// ---------------------------------------------------------------------------
// Gmail session persistence (Blob/Neon is the source of truth, not .local)
// ---------------------------------------------------------------------------

export async function loadGmailSession(id = "default"): Promise<object | null> {
  const { rows } = await getPool().query<{ storage_state: object; valid: boolean }>(
    "SELECT storage_state, valid FROM gmail_sessions WHERE id = $1 LIMIT 1",
    [id],
  );
  const record = rows[0];
  return record?.valid ? record.storage_state : null;
}

export async function saveGmailSession(storageState: object, id = "default"): Promise<void> {
  await getPool().query(
    `INSERT INTO gmail_sessions (id, storage_state, valid, updated_at)
     VALUES ($1, $2::jsonb, TRUE, NOW())
     ON CONFLICT (id) DO UPDATE SET storage_state = EXCLUDED.storage_state, valid = TRUE, updated_at = NOW()`,
    [id, JSON.stringify(storageState)],
  );
}

export async function invalidateGmailSession(id = "default"): Promise<void> {
  await getPool().query("UPDATE gmail_sessions SET valid = FALSE, updated_at = NOW() WHERE id = $1", [id]);
}

// ---------------------------------------------------------------------------
// Password-login rate limiting
// ---------------------------------------------------------------------------

export const MAX_LOGIN_ATTEMPTS = 3;

export type LoginGate =
  | { allowed: true; attempts: number }
  | { allowed: false; reason: string; retryAfter: Date | null; attempts: number };

/**
 * Decides whether a password login may be attempted.
 *
 * Automated Google logins must be rare. Consecutive failures escalate a
 * cooldown, and exceeding MAX_LOGIN_ATTEMPTS stops automatic attempts entirely
 * until an operator clears the gate, which protects the account from a lock.
 */
export async function checkLoginGate(id = "default"): Promise<LoginGate> {
  const { rows } = await getPool().query<{ attempts: number; cooldown_until: string | null }>(
    "SELECT attempts, cooldown_until FROM gmail_login_attempts WHERE id = $1 LIMIT 1",
    [id],
  );
  const record = rows[0];
  if (!record) return { allowed: true, attempts: 0 };

  if (record.cooldown_until && new Date(record.cooldown_until) > new Date()) {
    return {
      allowed: false,
      reason: `Login cooldown active until ${record.cooldown_until}.`,
      retryAfter: new Date(record.cooldown_until),
      attempts: record.attempts,
    };
  }
  if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
    return {
      allowed: false,
      reason: `${record.attempts} consecutive failed login attempts. Automatic login is disabled to protect the account from being locked. Clear it with: pnpm tsx scripts/reset-login-gate.ts`,
      retryAfter: null,
      attempts: record.attempts,
    };
  }
  return { allowed: true, attempts: record.attempts };
}

/** Records a failed login and escalates the cooldown (15m, 1h, 4h). */
export async function recordLoginFailure(reason: string, id = "default"): Promise<void> {
  const cooldownMinutes = [15, 60, 240];
  await getPool().query(
    `INSERT INTO gmail_login_attempts (id, attempts, last_attempt_at, last_outcome, cooldown_until, updated_at)
     VALUES ($1, 1, NOW(), $2, NOW() + ($3 || ' minutes')::interval, NOW())
     ON CONFLICT (id) DO UPDATE
       SET attempts = gmail_login_attempts.attempts + 1,
           last_attempt_at = NOW(),
           last_outcome = EXCLUDED.last_outcome,
           cooldown_until = NOW() + (
             (ARRAY[15, 60, 240])[LEAST(gmail_login_attempts.attempts + 1, 3)] || ' minutes'
           )::interval,
           updated_at = NOW()`,
    [id, reason.slice(0, 500), String(cooldownMinutes[0])],
  );
}

/** Clears the counter after a successful login. */
export async function recordLoginSuccess(id = "default"): Promise<void> {
  await getPool().query(
    `INSERT INTO gmail_login_attempts (id, attempts, last_attempt_at, last_outcome, cooldown_until, updated_at)
     VALUES ($1, 0, NOW(), 'success', NULL, NOW())
     ON CONFLICT (id) DO UPDATE
       SET attempts = 0, last_attempt_at = NOW(), last_outcome = 'success', cooldown_until = NULL, updated_at = NOW()`,
    [id],
  );
}

export async function resetLoginGate(id = "default"): Promise<void> {
  await getPool().query("DELETE FROM gmail_login_attempts WHERE id = $1", [id]);
}

// ---------------------------------------------------------------------------
// Read models for the UI
// ---------------------------------------------------------------------------

export async function listRecentJobs(limit = 20) {
  const sql = getDb();
  return (await sql.query(
    `SELECT j.id, j.sender, j.subject, j.status, j.attempts, j.error, j.created_at, j.updated_at,
            COALESCE(c.row_count, 0) AS row_count,
            COALESCE(c.filename, '') AS filename,
            COUNT(p.id) FILTER (WHERE p.status = 'generated')   AS report_count,
            COUNT(p.id) FILTER (WHERE p.status = 'needs_review') AS review_count
       FROM pipeline_jobs j
       LEFT JOIN csv_attachments c ON c.job_id = j.id
       LEFT JOIN property_reports p ON p.job_id = j.id
      GROUP BY j.id, c.row_count, c.filename
      ORDER BY j.created_at DESC
      LIMIT $1`,
    [limit],
  )) as Array<Record<string, unknown>>;
}

export async function getJobDetails(jobId: string) {
  const sql = getDb();
  const [jobRows, csvRows, reportRows, replyRows, eventRows] = await Promise.all([
    sql.query("SELECT * FROM pipeline_jobs WHERE id = $1 LIMIT 1", [jobId]),
    sql.query("SELECT * FROM csv_attachments WHERE job_id = $1", [jobId]),
    sql.query("SELECT * FROM property_reports WHERE job_id = $1 ORDER BY row_number ASC", [jobId]),
    sql.query("SELECT * FROM reply_attempts WHERE job_id = $1 ORDER BY created_at DESC", [jobId]),
    sql.query("SELECT from_status, to_status, detail, created_at FROM job_events WHERE job_id = $1 ORDER BY created_at DESC LIMIT 50", [jobId]),
  ]);
  if (!jobRows.length) return null;
  return {
    job: jobRows[0] as PipelineJob,
    csv: (csvRows[0] as CsvAttachmentRecord) ?? null,
    reports: reportRows as PropertyReportRecord[],
    replies: replyRows as ReplyAttemptRecord[],
    events: eventRows as Array<Record<string, unknown>>,
  };
}

export async function getWorkerHealth() {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT worker_id, status, current_job_id, cycles, detail, last_seen_at,
            EXTRACT(EPOCH FROM (NOW() - last_seen_at))::int AS seconds_since_seen
       FROM worker_heartbeats
      ORDER BY last_seen_at DESC
      LIMIT 5`,
  )) as Array<Record<string, unknown>>;
  return rows;
}
