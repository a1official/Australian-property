/**
 * Private Vercel Blob storage for source CSVs and generated reports.
 *
 * Blob is the store of record: Neon holds only pathnames. Uploads fail loudly
 * rather than silently falling back to a local path, because a "successful" job
 * whose artifacts are missing is worse than a retryable failure.
 */

import { del, get, head, list, put } from "@vercel/blob";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const CSV_PREFIX = "parcel-atlas/csv";
const REPORT_PREFIX = "parcel-atlas/reports";

export class BlobConfigurationError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "BlobConfigurationError";
  }
}

function getBlobToken(): string {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  if (process.env.NODE_ENV !== "production") {
    // Local development only. The Vercel-linked token lives in .env.local, so
    // check that too rather than only the workspace-root .env.
    const candidates = [
      resolve(process.cwd(), ".env.local"),
      resolve(process.cwd(), ".env"),
      resolve(process.cwd(), "..", ".env.local"),
      resolve(process.cwd(), "..", ".env"),
    ];
    for (const envPath of candidates) {
      try {
        if (!existsSync(envPath)) continue;
        const match = readFileSync(envPath, "utf8").match(/^\s*BLOB_READ_WRITE_TOKEN\s*=\s*(.+)$/m);
        if (match) return match[1].trim().replace(/^["']|["']$/g, "");
      } catch {
        // try the next candidate
      }
    }
  }
  throw new BlobConfigurationError(
    "BLOB_READ_WRITE_TOKEN is not configured. The private Blob store is required for durable CSV and report storage.",
  );
}

export function computeFileHash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

/** Random per-job segment so report paths cannot be guessed from a job id. */
export function createJobBlobSecret(): string {
  return randomBytes(12).toString("hex");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
}

export function csvPathname(jobId: string, secret: string, filename: string): string {
  return `${CSV_PREFIX}/${safeSegment(jobId)}-${secret}/${safeSegment(filename)}`;
}

export function reportPathname(jobId: string, secret: string, filename: string): string {
  return `${REPORT_PREFIX}/${safeSegment(jobId)}-${secret}/${safeSegment(filename)}`;
}

export async function uploadCsvBlob(params: {
  jobId: string;
  secret: string;
  filename: string;
  content: string | Buffer;
}): Promise<{ pathname: string; url: string; fileHash: string }> {
  const token = getBlobToken();
  const pathname = csvPathname(params.jobId, params.secret, params.filename);
  const blob = await put(pathname, params.content, {
    access: "private",
    contentType: "text/csv; charset=utf-8",
    addRandomSuffix: false,
    allowOverwrite: true,
    token,
  });
  return { pathname: blob.pathname, url: blob.url, fileHash: computeFileHash(params.content) };
}

export async function uploadReportBlob(params: {
  jobId: string;
  secret: string;
  filename: string;
  html: string | Buffer;
}): Promise<{ pathname: string; url: string }> {
  const token = getBlobToken();
  const pathname = reportPathname(params.jobId, params.secret, params.filename);
  const blob = await put(pathname, params.html, {
    access: "private",
    contentType: "text/html; charset=utf-8",
    addRandomSuffix: false,
    allowOverwrite: true,
    token,
  });
  return { pathname: blob.pathname, url: blob.url };
}

/** Downloads one report at reply time. Only completed reports are fetched. */
export async function downloadBlobText(pathname: string): Promise<string> {
  const token = getBlobToken();
  const result = await get(pathname, { access: "private", token });
  if (!result?.stream) throw new Error(`Blob ${pathname} returned no content.`);
  // Web ReadableStream is not async-iterable in this lib target; read it manually.
  const reader = (result.stream as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function blobExists(pathname: string): Promise<boolean> {
  try {
    await head(pathname, { token: getBlobToken() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Retention cleanup. Deletes CSV and report blobs older than the retention
 * window. Intended to run as a scheduled command (see scripts/blob-cleanup.ts);
 * `dryRun` reports what would be removed without deleting.
 */
export async function cleanupExpiredBlobs(options: {
  retentionDays: number;
  dryRun?: boolean;
  protectedPathnames?: Set<string>;
}): Promise<{ scanned: number; deleted: string[]; retained: number }> {
  const token = getBlobToken();
  const cutoff = Date.now() - options.retentionDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  let scanned = 0;
  let retained = 0;

  for (const prefix of [CSV_PREFIX, REPORT_PREFIX]) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 500, token });
      for (const blob of page.blobs) {
        scanned += 1;
        const uploadedAt = new Date(blob.uploadedAt).getTime();
        if (uploadedAt >= cutoff || options.protectedPathnames?.has(blob.pathname)) {
          retained += 1;
          continue;
        }
        if (!options.dryRun) await del(blob.pathname, { token });
        deleted.push(blob.pathname);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  return { scanned, deleted, retained };
}
