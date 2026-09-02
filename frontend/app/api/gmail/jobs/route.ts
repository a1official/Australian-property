import { randomBytes } from "node:crypto";

import { createJobBlobSecret, uploadCsvBlob } from "@/lib/blob-storage";
import { CsvValidationError, buildIdempotencyKey, validateCsvAttachment } from "@/lib/csv-intake";
import { listRecentJobs, registerJobWithAttachment, seedPropertyRows } from "@/lib/db";

export const runtime = "nodejs";
// Enqueue only. Long Cotality/Playwright work belongs to the scheduled worker.
export const maxDuration = 30;

export async function GET() {
  try {
    const jobs = await listRecentJobs(20);
    return Response.json({ ok: true, jobs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to fetch jobs." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {

    const body = (await request.json().catch(() => null)) as
      | { filename?: string; csvContent?: string; sender?: string; subject?: string }
      | null;
    if (!body?.csvContent || typeof body.csvContent !== "string") {
      return Response.json({ ok: false, error: "csvContent is required." }, { status: 400 });
    }

    const sender = (body.sender || "").trim().toLowerCase();
    // Demo mode has no allow-list, but a reply address is still required.
    if (!sender) {
      return Response.json(
        { ok: false, error: "sender is required so completed reports have a reply address." },
        { status: 400 },
      );
    }

    let validated;
    try {
      validated = validateCsvAttachment({
        fileName: body.filename || "upload.csv",
        content: body.csvContent,
      });
    } catch (error) {
      if (error instanceof CsvValidationError) {
        return Response.json({ ok: false, error: error.message }, { status: 422 });
      }
      throw error;
    }

    const subject = (body.subject || "Manual CSV upload").slice(0, 300);
    const jobId = `job-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const blobSecret = createJobBlobSecret();
    const idempotencyKey = buildIdempotencyKey({
      sender,
      fileName: validated.fileName,
      csvContent: body.csvContent,
    });

    const csvBlob = await uploadCsvBlob({
      jobId,
      secret: blobSecret,
      filename: validated.fileName,
      content: body.csvContent,
    });

    const { job, created } = await registerJobWithAttachment({
      jobId,
      idempotencyKey,
      sender,
      subject,
      attachment: {
        id: `csv-${Date.now()}-${randomBytes(4).toString("hex")}`,
        filename: validated.fileName,
        fileHash: validated.contentHash,
        rowCount: validated.addresses.length,
        byteSize: validated.byteLength,
        blobPathname: csvBlob.pathname,
        blobUrl: csvBlob.url,
      },
    });

    if (created) {
      await seedPropertyRows(
        job.id,
        validated.addresses.map((address) => ({
          id: `prop-${job.id}-${address.rowNumber}`,
          rowNumber: address.rowNumber,
          address: address.address,
        })),
      );
    }

    return Response.json(
      {
        ok: true,
        created,
        job: { id: job.id, status: job.status, sender: job.sender, subject: job.subject },
        rowCount: validated.addresses.length,
      },
      { status: created ? 202 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to enqueue job." },
      { status: 500 },
    );
  }
}
