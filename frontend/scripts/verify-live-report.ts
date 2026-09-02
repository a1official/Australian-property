#!/usr/bin/env tsx
/**
 * Live end-to-end check of the report path against the deployed Vercel API,
 * excluding Gmail: match a real address, generate the report, store it in the
 * private Blob store, record it in Neon, and read it back as the reply would.
 *
 *   pnpm tsx scripts/verify-live-report.ts "1 Address St SUBURB NSW 2000"
 */

import { randomBytes } from "node:crypto";

import { createJobBlobSecret, downloadBlobText, uploadCsvBlob, uploadReportBlob } from "../lib/blob-storage";
import {
  claimNextJob,
  closePool,
  getPool,
  listPropertyRows,
  registerJobWithAttachment,
  seedPropertyRows,
  transitionJob,
  updatePropertyRow,
} from "../lib/db";
import { buildIdempotencyKey, validateCsvAttachment } from "../lib/csv-intake";
import { createLogger } from "../lib/logger";
import { generatePropertyReport, matchAddress } from "../lib/report-pipeline";
import { generatedRows, replyIsDue } from "../lib/worker-core";

const log = createLogger({ script: "verify-live-report" });
const BASE = (process.env.PARCEL_ATLAS_BASE_URL || "https://australian-property.vercel.app").replace(/\/$/, "");
const RUN = randomBytes(4).toString("hex");
const jobId = `job-live-${RUN}`;

const addresses = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!addresses.length) {
  addresses.push("2 Kokoda Avenue WAHROONGA NSW 2076");
}

async function cleanup(secret: string, pathnames: string[]): Promise<void> {
  const { del } = await import("@vercel/blob");
  for (const pathname of pathnames) {
    await del(pathname, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => undefined);
  }
  await getPool().query("DELETE FROM pipeline_jobs WHERE id = $1", [jobId]);
  void secret;
}

async function run(): Promise<void> {
  const csv = `address\n${addresses.join("\n")}\n`;
  const validated = validateCsvAttachment({ fileName: "live-verify.csv", content: csv });
  const secret = createJobBlobSecret();
  const uploaded: string[] = [];

  log.info("live.start", { baseUrl: BASE, addresses: validated.addresses.length });

  const csvBlob = await uploadCsvBlob({ jobId, secret, filename: validated.fileName, content: csv });
  uploaded.push(csvBlob.pathname);
  log.info("live.csv_stored", { pathname: csvBlob.pathname });

  await registerJobWithAttachment({
    jobId,
    idempotencyKey: buildIdempotencyKey({ sender: "live-verify@example.com", threadId: `live-${RUN}`, fileName: validated.fileName, csvContent: csv }),
    sender: "live-verify@example.com",
    subject: "Live verification",
    threadId: `live-${RUN}`,
    attachment: {
      id: `csv-live-${RUN}`,
      filename: validated.fileName,
      fileHash: validated.contentHash,
      rowCount: validated.addresses.length,
      byteSize: validated.byteLength,
      blobPathname: csvBlob.pathname,
      blobUrl: csvBlob.url,
    },
  });
  await seedPropertyRows(
    jobId,
    validated.addresses.map((address) => ({ id: `prop-live-${RUN}-${address.rowNumber}`, rowNumber: address.rowNumber, address: address.address })),
  );

  const claimed = await claimNextJob(`live-verify-${RUN}`, 900);
  log.info("live.claimed", { claimedId: claimed?.id, isOurs: claimed?.id === jobId });

  const options = { baseUrl: BASE, timeoutMs: 120_000 };
  for (const row of await listPropertyRows(jobId)) {
    const outcome = await matchAddress(row.original_address, options);
    log.info("live.match", { address: row.original_address, kind: outcome.kind, propertyId: outcome.kind === "exact" ? outcome.propertyId : null });

    if (outcome.kind !== "exact") {
      await updatePropertyRow({ id: row.id, status: outcome.kind === "needs_review" ? "needs_review" : "unmatched", error: outcome.reason });
      continue;
    }

    const report = await generatePropertyReport({ propertyId: outcome.propertyId, address: outcome.normalizedAddress }, options);
    const stored = await uploadReportBlob({ jobId, secret, filename: report.filename, html: report.html });
    uploaded.push(stored.pathname);
    await updatePropertyRow({
      id: row.id,
      status: "generated",
      propertyId: outcome.propertyId,
      normalizedAddress: outcome.normalizedAddress,
      reportFilename: report.filename,
      blobPathname: stored.pathname,
    });

    const roundTrip = await downloadBlobText(stored.pathname);
    log.info("live.report_stored", {
      pathname: stored.pathname,
      bytes: report.html.length,
      readBackMatches: roundTrip === report.html,
      hasEmbeddedImage: report.html.includes("data:image/"),
      selfContained: !/src='https?:/.test(report.html),
    });
  }

  const rows = await listPropertyRows(jobId);
  log.info("live.summary", {
    total: rows.length,
    generated: generatedRows(rows).length,
    replyWouldBeSent: replyIsDue(rows),
    statuses: rows.map((row) => row.status),
  });

  await transitionJob({ jobId, status: "completed", detail: "live verification", releaseLease: true });
  await cleanup(secret, uploaded);
  log.info("live.cleaned_up", { removedBlobs: uploaded.length });
}

void run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error("live.failed", { error: error instanceof Error ? error.message : String(error) });
    await closePool();
    process.exit(1);
  });
