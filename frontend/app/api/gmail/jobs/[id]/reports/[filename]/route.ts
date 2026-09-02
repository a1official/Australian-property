import { downloadBlobText } from "@/lib/blob-storage";
import { getJobDetails } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Streams one completed report out of the private Blob store.
 *
 * The private store has no public URL, so this server route is how the UI
 * offers a report link. Only a pathname already recorded in Neon for this job is
 * served, which prevents traversal into other jobs' artifacts.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; filename: string }> },
) {
  try {
    const { id, filename } = await context.params;
    if (!/^[\w-]{1,80}$/.test(id) || !/^[\w.-]{1,140}\.html$/i.test(filename)) {
      return Response.json({ ok: false, error: "Invalid report reference." }, { status: 400 });
    }

    const details = await getJobDetails(id);
    if (!details) return Response.json({ ok: false, error: "Job not found." }, { status: 404 });

    const report = details.reports.find(
      (item) => item.report_filename === filename && item.status === "generated" && item.blob_pathname,
    );
    if (!report?.blob_pathname) {
      return Response.json({ ok: false, error: "Report not found for this job." }, { status: 404 });
    }

    const html = await downloadBlobText(report.blob_pathname);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Report could not be retrieved." },
      { status: 500 },
    );
  }
}
