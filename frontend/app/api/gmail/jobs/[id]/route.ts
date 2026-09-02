import { UnauthorizedError, assertJobApiRequest, unauthorizedResponse } from "@/lib/api-auth";
import { getJobDetails } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Durable job status read straight from Neon. No Playwright, no Cotality. */
export async function GET(request: Request, context: RouteContext<"/api/gmail/jobs/[id]">) {
  try {
    assertJobApiRequest(request);
    const { id } = await context.params;
    if (!/^[\w-]{1,80}$/.test(id)) {
      return Response.json({ ok: false, error: "Invalid job identifier." }, { status: 400 });
    }

    const details = await getJobDetails(id);
    if (!details) return Response.json({ ok: false, error: "Job not found." }, { status: 404 });

    return Response.json(
      {
        ok: true,
        job: details.job,
        csv: details.csv
          ? {
              filename: details.csv.filename,
              rowCount: details.csv.row_count,
              byteSize: details.csv.byte_size,
              // Pathname only: a private Blob URL is not a shareable link.
              blobPathname: details.csv.blob_pathname,
            }
          : null,
        reports: details.reports.map((report) => ({
          rowNumber: report.row_number,
          originalAddress: report.original_address,
          normalizedAddress: report.normalized_address,
          propertyId: report.property_id,
          status: report.status,
          attempts: report.attempts,
          reportFilename: report.report_filename,
          blobPathname: report.blob_pathname,
          error: report.error,
        })),
        replies: details.replies.map((reply) => ({
          recipient: reply.recipient,
          reportCount: reply.report_count,
          status: reply.status,
          sentAt: reply.sent_at,
          error: reply.error,
        })),
        events: details.events,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) return unauthorizedResponse(error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to fetch job details." },
      { status: 500 },
    );
  }
}
