import { randomBytes } from "node:crypto";

import { UnauthorizedError, assertJobApiRequest, unauthorizedResponse } from "@/lib/api-auth";
import { createJobBlobSecret, uploadCsvBlob } from "@/lib/blob-storage";
import {
  CsvValidationError,
  buildIdempotencyKey,
  isAllowedSender,
  validateCsvAttachment,
} from "@/lib/csv-intake";
import { listRecentJobs, registerJobWithAttachment, seedPropertyRows } from "@/lib/db";

export const runtime = "nodejs";
// Enqueue only. Long Cotality/Playwright work belongs to the Render worker.
export const maxDuration = 30;

function allowedSenders(): string[] {
  return (process.env.GMAIL_ALLOWED_SENDERS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export async function GET(request: Request) {
  try {
    assertJobApiRequest(request);
    const jobs = await listRecentJobs(20);
    return Response.json({ ok: true, jobs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse(error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to fetch jobs." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    assertJobApiRequest(request);

    const body = (await request.json().catch(() => null)) as
      | { filename?: string; csvContent?: string; sender?: string; subject?: string }
      | null;
    if (!body?.csvContent || typeof body.csvContent !== "string") {
      return Response.json({ ok: false, error: "csvContent is required." }, { status: 400 });
    }

    const sender = (body.sender || "").trim().toLowerCase();
    // The reply goes to this address, so it must be on the allow-list.
    if (!isAllowedSender(sender, allowedSenders())) {
      return Response.json(
        { ok: false, error: "sender must be one of the configured GMAIL_ALLOWED_SENDERS." },
        { status: 403 },
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
    if (error instanceof UnauthorizedError) return unauthorizedResponse(error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to enqueue job." },
      { status: 500 },
    );
  }
}
